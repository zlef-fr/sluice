// ThePornDB (api.theporndb.net) — who performed for which studio, served as ONE
// versioned NDJSON artifact.
//
// The question a consumer asks is "which performers have worked with studio X, and
// how much". ThePornDB answers it in two places, and only one of them is reliable:
//
//   - `/performer-sites?site_id=` lists the studio's own model pages. It is sparse
//     in a way that looks like data: Blacked, Deeper and Tushy Raw report ZERO
//     performers there, while their scenes credit hundreds.
//   - `/scenes?site_id=` lists what was actually shot, and every scene carries its
//     credited performers WITH their canonical ("parent") profile inlined: gender,
//     birthday, images, links. So one walk over a studio's scenes gives membership,
//     a per-studio scene count and the profile, with no per-performer request.
//
// This adapter walks the scenes. Two traps shape the walk:
//
//   1. The search index caps `meta.total` at 10 000 and stops paginating there, in
//      silence (page 101 still answers 200). Any collection that reports the cap is
//      re-walked one release YEAR at a time, and a year that still hits the cap
//      raises rather than ship a truncated roster.
//   2. Pages are ordered `former_created` (oldest record first), so a scene added
//      upstream mid-walk lands after the last page instead of shifting every page by
//      one. Ties are not sorted deterministically, though, so a slice can come back
//      with one scene twice and another missing; a short slice is re-walked in other
//      orders and unioned. Only a slice still short of the declared total after every
//      order raises.
//
// Scenes the index holds without a release date cannot be reached by a year slice;
// for a capped collection their number is unknowable, and the log says so.
//
// descriptor:
//   url        API base, e.g. "https://api.theporndb.net"
//   options:
//     collections  [{ key, siteId, op? }]  op = TPDB `site_operation`
//                  ('Site' default | 'Site/Parent' | 'Network' | ...)
//     genders      performer genders to keep (default ['Female'])
//     tokenEnv     env var holding the API token (default 'TPDB_TOKEN'). The token
//                  never sits in the descriptor: descriptors are served publicly.
//                  Only names matching TPDB_* are accepted, and the url must be
//                  https://api.theporndb.net: the adapter attaches a bearer token to
//                  every request it makes, so letting a descriptor choose either the
//                  destination or the variable would let anyone holding the write
//                  token mail Sluice's secrets to a server of their choosing.
//     fromYear     first year of a year split (default 1970)
//     filename     default 'tpdb-performers.ndjson'
//     timeoutMs    per request (default 60000)
//     hostGapMs    pacing between requests to the API host (see ../hostgate.js)
//
// Output, one JSON object per line, sorted so an unchanged upstream hashes the same:
//   {"type":"collection", key, siteId, op, name, url, network, logo, favicon,
//    poster, scenes, performers}
//   {"type":"performer", id, tpdbId, slug, name, ..., collections:{<key>:{scenes,
//    first, last}}, scenes, first, last}
import { USER_AGENT } from '../config.js';
import { latestRecord, streamToStaging } from '../artifacts.js';
import { politeFetch } from './http.js';

const API_HOST = 'api.theporndb.net';
const INDEX_CAP = 10000;
// Walk orders, tried in turn when a slice comes back short (see walk()). The first
// is oldest-first so a scene added mid-walk lands after the last page.
// Share of a slice that may be declared but never served before the walk is
// considered broken rather than the upstream hiding a few rows.
const MAX_HIDDEN_SHARE = 0.02;
const ORDERS = ['former_created', 'recently_created', 'former_released', 'recently_released'];
const PER_PAGE = 100;

function yearOf(date) {
  const y = Number(String(date || '').slice(0, 4));
  return Number.isInteger(y) && y > 1900 ? y : null;
}

async function getJson(url, { token, timeoutMs, descriptor }, attempt = 0) {
  try {
    const res = await politeFetch(
      url,
      {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', Authorization: `Bearer ${token}` },
      },
      { descriptor, timeoutMs },
    );
    // 401/403 will not heal by waiting: a revoked or missing token is an operator
    // problem and must surface as such, not as five retries of the same refusal.
    if (res.status === 401 || res.status === 403) {
      throw Object.assign(new Error(`tpdb-performers: HTTP ${res.status} (token rejected) from ${url}`), { fatal: true });
    }
    if (res.status >= 500 || res.status === 429) throw new Error(`HTTP ${res.status} from ${url}`);
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} from ${url}`), { fatal: true });
    return await res.json();
  } catch (err) {
    if (err.fatal || attempt >= 4) throw err;
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    return getJson(url, { token, timeoutMs, descriptor }, attempt + 1);
  }
}

function pick(links, name) {
  const v = links && links[name];
  return typeof v === 'string' && v ? v : null;
}

// The parent profile, trimmed to what a consumer can use without redistributing
// the long-form marketing copy (bios are studio promo text, not facts).
function profile(parent) {
  const x = parent.extras || {};
  return {
    type: 'performer',
    id: parent.id,
    tpdbId: parent._id,
    slug: parent.slug,
    name: parent.name,
    disambiguation: parent.disambiguation || null,
    gender: x.gender || null,
    birthday: x.birthday || null,
    deathday: x.deathday || null,
    birthplaceCode: x.birthplace_code || null,
    nationality: x.nationality || null,
    hair: x.hair_colour || null,
    careerStart: x.career_start_year || null,
    careerEnd: x.career_end_year || null,
    image: parent.image || null,
    thumbnail: parent.thumbnail || null,
    face: parent.face || null,
    links: {
      wikidata: pick(x.links, 'Wikidata'),
      wikipedia: pick(x.links, 'Wikipedia'),
      iafd: pick(x.links, 'IAFD'),
      official: pick(x.links, 'Official Website'),
    },
    collections: {},
    scenes: 0,
    first: null,
    last: null,
  };
}

export default async function tpdbPerformers(descriptor) {
  const opts = descriptor.options || {};
  const given = String(descriptor.url || '').replace(/\/+$/, '');
  if (!given) throw new Error('tpdb-performers needs a url (the API base)');
  let parsed;
  try {
    parsed = new URL(given);
  } catch {
    throw new Error(`tpdb-performers: url is not a URL (${given})`);
  }
  if (
    parsed.protocol !== 'https:' || parsed.host !== API_HOST || parsed.username || parsed.password ||
    (parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash
  ) {
    throw new Error(`tpdb-performers: url must be https://${API_HOST} (the token is sent to it)`);
  }
  // Every request is built from the constant, never from the descriptor's string.
  const base = `https://${API_HOST}`;
  const collections = Array.isArray(opts.collections) ? opts.collections : [];
  if (!collections.length) throw new Error('tpdb-performers: options.collections is empty');
  const keys = new Set();
  for (const c of collections) {
    if (!c || !c.key || !Number.isInteger(c.siteId)) {
      throw new Error(`tpdb-performers: a collection needs { key, siteId:int } (got ${JSON.stringify(c)})`);
    }
    if (keys.has(c.key)) throw new Error(`tpdb-performers: duplicate collection key "${c.key}"`);
    keys.add(c.key);
  }
  const tokenEnv = opts.tokenEnv || 'TPDB_TOKEN';
  if (!/^TPDB_[A-Z0-9_]+$/.test(tokenEnv)) {
    throw new Error(`tpdb-performers: tokenEnv must name a TPDB_* variable (got ${JSON.stringify(tokenEnv)})`);
  }
  const token = process.env[tokenEnv];
  if (!token) throw new Error(`tpdb-performers: env ${tokenEnv} is not set`);
  const genders = new Set(Array.isArray(opts.genders) && opts.genders.length ? opts.genders : ['Female']);
  const fromYear = Number.isInteger(opts.fromYear) ? opts.fromYear : 1970;
  const ctx = { token, timeoutMs: Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 60000, descriptor };
  const filename = opts.filename || 'tpdb-performers.ndjson';

  const performers = new Map(); // parent uuid → profile
  let hidden = 0; // declared by the API, served in no order
  const collectionRows = [];
  let requests = 0;
  const get = (url) => {
    requests += 1;
    return getJson(url, ctx);
  };

  for (const c of collections) {
    const op = c.op || 'Site';
    const site = (await get(`${base}/sites/${c.siteId}`)).data || {};
    const sceneIds = new Set();
    const members = new Set();

    const sliceUrl = (year, page, order = ORDERS[0]) =>
      `${base}/scenes?site_id=${c.siteId}&site_operation=${encodeURIComponent(op)}` +
      `&orderBy=${order}&per_page=${PER_PAGE}&page=${page}` + (year ? `&year=${year}` : '');

    // Walk one slice to the end and prove it came back whole.
    // `meta.total` is not a promise of rows. Two ways the rows fall short of it:
    //   - ties are not sorted deterministically, so two scenes created in the same
    //     second can swap between two page requests: one is served twice, the other
    //     never. Walking again in another order finds it.
    //   - the total counts scenes the API then does not serve at all (Reality Kings
    //     2025: 299 declared, the same 295 in every order). No order finds those.
    // So a short slice is re-walked in other orders and unioned until an order adds
    // nothing new. What is still missing then is reported, and it raises if it is
    // more than a sliver of the slice: that would be a broken walk, not hidden rows.
    const walk = async (year, first) => {
      const declared = first.meta?.total ?? 0;
      const pages = Math.ceil(declared / PER_PAGE);
      const seen = new Set();
      const label = `${c.key}${year ? ` ${year}` : ''}`;
      let stable = false;
      for (const order of ORDERS) {
        const before = seen.size;
        for (let page = 1; page <= pages; page++) {
          const body = page === 1 && order === ORDERS[0] ? first : await get(sliceUrl(year, page, order));
          absorb(body, seen);
        }
        if (seen.size >= declared) break;
        if (order !== ORDERS[0] && seen.size === before) {
          stable = true;
          break;
        }
        console.log(`[sluice] tpdb-performers: ${label}: ${seen.size}/${declared} after ${order}, re-walking`);
      }
      const missing = declared - seen.size;
      if (missing > 0) {
        if (!stable || missing > Math.max(2, declared * MAX_HIDDEN_SHARE)) {
          throw new Error(
            `tpdb-performers: ${label}: API declared ${declared} scenes, ${seen.size} distinct came back ` +
              `(${stable ? 'stable across orders' : 'still changing after every order'})`,
          );
        }
        console.log(`[sluice] tpdb-performers: ${label}: ${missing} declared scene(s) are not served by the API in any order`);
        hidden += missing;
      }
      return seen.size;
    };

    const absorb = (body, seen) => {
      for (const scene of body.data || []) {
        seen.add(scene.id);
        if (sceneIds.has(scene.id)) continue;
        sceneIds.add(scene.id);
        const y = yearOf(scene.date);
        const credited = new Set();
        for (const p of scene.performers || []) {
          const parent = p.parent;
          // A credit with no canonical profile has no gender to check and no
          // identity to merge on; it cannot be attributed, so it is skipped.
          if (!parent || !parent.id || credited.has(parent.id)) continue;
          credited.add(parent.id);
          if (!genders.has(parent.extras?.gender)) continue;
          let rec = performers.get(parent.id);
          if (!rec) {
            rec = profile(parent);
            performers.set(parent.id, rec);
          }
          const stat = (rec.collections[c.key] ||= { scenes: 0, first: null, last: null });
          stat.scenes += 1;
          if (y) {
            stat.first = stat.first ? Math.min(stat.first, y) : y;
            stat.last = stat.last ? Math.max(stat.last, y) : y;
          }
          members.add(parent.id);
        }
      }
    };

    const whole = await get(sliceUrl(null, 1));
    if ((whole.meta?.total ?? 0) < INDEX_CAP) {
      await walk(null, whole);
    } else {
      // Capped: the index will not page past 10 000. Re-walk it a year at a time.
      const thisYear = new Date().getUTCFullYear();
      let total = 0;
      for (let year = fromYear; year <= thisYear + 1; year++) {
        const first = await get(sliceUrl(year, 1));
        const n = first.meta?.total ?? 0;
        if (!n) continue;
        if (n >= INDEX_CAP) {
          throw new Error(`tpdb-performers: ${c.key} ${year} alone reaches the ${INDEX_CAP} index cap`);
        }
        total += await walk(year, first);
      }
      console.log(
        `[sluice] tpdb-performers: ${c.key} capped at ${INDEX_CAP}, walked by year: ${total} dated scene(s); ` +
          'undated scenes are unreachable this way',
      );
    }

    collectionRows.push({
      type: 'collection',
      key: c.key,
      siteId: c.siteId,
      op,
      name: site.name || c.key,
      url: site.url || null,
      network: site.network?.name || null,
      logo: site.logo || null,
      favicon: site.favicon || null,
      poster: site.poster || null,
      scenes: sceneIds.size,
      performers: members.size,
    });
    console.log(
      `[sluice] tpdb-performers: ${c.key}: ${sceneIds.size} scene(s), ${members.size} performer(s) kept, ` +
        `${requests} request(s) so far`,
    );
  }

  // Totals across collections. A scene is counted once per collection it belongs
  // to, so when two collections overlap (a studio and the network that owns it) the
  // same scene is counted in both: `scenes` is an activity score over the chosen
  // collections, not a filmography length.
  const rows = [...performers.values()].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  for (const r of rows) {
    let first = null;
    let last = null;
    let scenes = 0;
    for (const s of Object.values(r.collections)) {
      scenes += s.scenes;
      if (s.first) first = first ? Math.min(first, s.first) : s.first;
      if (s.last) last = last ? Math.max(last, s.last) : s.last;
    }
    r.scenes = scenes;
    r.first = first;
    r.last = last;
  }

  const lines = [...collectionRows, ...rows].map((r) => JSON.stringify(r)).join('\n') + '\n';
  const staged = await streamToStaging(descriptor.id || 'tpdb', new Response(lines), {
    filename,
    compress: opts.compress ?? 'auto',
  });
  console.log(
    `[sluice] tpdb-performers: ${collectionRows.length} collection(s), ${rows.length} performer(s), ` +
      `${requests} request(s), ${hidden} declared scene(s) never served`,
  );

  const held = await latestRecord(descriptor.id).catch(() => null);
  if (held && held.sha256 === staged.sha256) {
    if (held.evicted) return { restored: { version: held.version, ...staged }, bytes: staged.bytes };
    return { notModified: true, discard: staged.tmpPath, bytes: staged.bytes };
  }
  return {
    artifact: {
      ...staged,
      keep: Number.isFinite(opts.keep) ? opts.keep : undefined,
      url: base,
      contentType: 'application/x-ndjson',
      rows: collectionRows.length + rows.length,
    },
    bytes: staged.bytes,
  };
}
