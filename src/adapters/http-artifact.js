// Fetch a remote FILE and keep the bytes, versioned — for upstreams that are
// build inputs (zip dumps, 700 MB bulk CSV exports) rather than record streams.
//
// A daily refresh must not mean a daily 700 MB download, so change detection has
// three layers, cheapest first:
//   1. `options.resolve` — if the URL itself carries a version (a GitHub release
//      tag), an unchanged resolution means unchanged content: nothing is fetched.
//   2. `options.probe` — one small request whose answer changes when the data
//      does (OpenDataSoft exports emit no ETag, but their dataset metadata has
//      `data_processed` + `records_count`).
//   3. conditional GET (ETag / Last-Modified) on the file itself.
// If all three miss, the file is downloaded and its sha256 compared with the
// stored one — same bytes, no new version.
//
// descriptor.options:
//   filename   name to store as / hand back (default: URL basename)
//   compress   'auto' (default) | true | false — gzip on disk unless already compressed
//   resolve    { type:'github-latest-release', repo:'owner/name', asset:'x.csv.gz' }
//   probe      { type:'ods-dataset', url } | { type:'http-head', url? }
//   headers    extra request headers, e.g. a User-Agent an origin's bot filter accepts
import { USER_AGENT } from '../config.js';
import { conditionalFetch } from './http.js';
import { latestRecord, streamToStaging } from '../artifacts.js';

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

// ── layer 1: resolve a versioned URL ────────────────────────────────────────
async function resolveUrl(descriptor) {
  const r = descriptor.options?.resolve;
  if (!r) return { url: descriptor.url, probeKey: null };

  if (r.type === 'github-latest-release') {
    if (!r.repo || !r.asset) throw new Error('resolve.github-latest-release needs {repo, asset}');
    const rel = await getJson(`https://api.github.com/repos/${r.repo}/releases/latest`);
    const tag = rel.tag_name;
    if (!tag) throw new Error(`no tag_name in latest release of ${r.repo}`);
    return {
      url: `https://github.com/${r.repo}/releases/download/${tag}/${r.asset}`,
      // The release tag IS the version — same tag, same bytes.
      probeKey: `${r.repo}@${tag}`,
    };
  }
  throw new Error(`unknown resolve.type "${r.type}"`);
}

// Per-source request headers, merged over the defaults. A source only needs this
// when the origin filters on them — the EP's list answers Sluice's own UA with an
// empty 202 and only serves a browser-shaped one.
function extraHeaders(descriptor) {
  return descriptor.options?.headers || {};
}

// ── layer 2: cheap change probe ─────────────────────────────────────────────
async function probeKeyFor(descriptor, url) {
  const p = descriptor.options?.probe;
  if (!p) return null;

  if (p.type === 'ods-dataset') {
    // OpenDataSoft /exports/csv streams have no validators, but the catalog
    // entry does: data_processed moves when the data is rebuilt (`modified`
    // also moves on metadata-only edits, which would trigger pointless
    // multi-hundred-MB downloads, so it is deliberately not used).
    const meta = await getJson(p.url);
    const d = meta?.metas?.default || {};
    const key = [d.data_processed || '', d.records_count ?? ''].join('|');
    return key === '|' ? null : `ods:${key}`;
  }

  if (p.type === 'http-head') {
    const res = await fetch(p.url || url, {
      method: 'HEAD',
      headers: { 'User-Agent': USER_AGENT, ...extraHeaders(descriptor) },
    });
    if (!res.ok) return null;
    const etag = res.headers.get('etag');
    const lastModified = res.headers.get('last-modified');
    // Content-Length alone is NOT a change signal — an edited file of the same
    // size would read as unchanged. Only a strong validator can short-circuit;
    // without one, fall through and let the sha256 comparison decide.
    if (!etag && !lastModified) return null;
    return `head:${[etag || '', lastModified || '', res.headers.get('content-length') || ''].join('|')}`;
  }

  throw new Error(`unknown probe.type "${p.type}"`);
}

export default async function httpArtifact(descriptor, ctx = {}) {
  const opts = descriptor.options || {};
  let contentType = 'application/octet-stream';
  const { url, probeKey: resolvedKey } = await resolveUrl(descriptor);
  if (!url) throw new Error('http-artifact needs a `url` or `options.resolve`');

  const held = await latestRecord(descriptor.id);
  // `force` means "we need the bytes back" (they were evicted to save disk), so
  // every not-modified shortcut is skipped — those would correctly report the
  // content is unchanged and leave us with no file.
  const force = !!ctx.force;

  // Layers 1 + 2 — only trustworthy while we still hold the bytes they describe.
  let probeKey = resolvedKey;
  if (!force || !probeKey) probeKey = probeKey || (await probeKeyFor(descriptor, url));
  if (!force && held && probeKey && held.probeKey === probeKey) {
    return { notModified: true, validators: ctx.validators || held.validators || null };
  }

  // Layer 3 — conditional GET on the file itself.
  const filename = opts.filename || basenameOf(url) || `${descriptor.id}.bin`;
  // Hundred-MB downloads from public open-data hosts do get cut mid-stream
  // ("terminated"). Retry the whole transfer a couple of times with backoff —
  // an unattended daily refresh can't depend on first-try luck.
  const attempts = Math.max(1, Number(opts.retries ?? 3));
  let staged;
  let validators;
  for (let attempt = 1; ; attempt++) {
    try {
      const got = await conditionalFetch(url, {
        validators: force ? null : held ? ctx.validators || held.validators : null,
        // Ask for the bytes exactly as published. Two reasons: (1) undici
        // transparently decompresses a gzipped response, which would make the
        // stored file and its sha256 differ from the upstream artifact; (2) some
        // open-data hosts kill large transfers when a content-encoding is
        // negotiated — data.assemblee-nationale.fr closes the connection a few
        // seconds into the 296 MB amendements zip unless this is set.
        headers: { 'Accept-Encoding': 'identity', ...extraHeaders(descriptor) },
      });
      validators = got.validators;
      if (got.notModified && held) return { notModified: true, validators };
      staged = await streamToStaging(descriptor.id, got.res, {
        filename,
        compress: opts.compress ?? 'auto',
      });
      contentType = (got.res.headers.get('content-type') || 'application/octet-stream').split(';')[0];
      break;
    } catch (e) {
      if (attempt >= attempts) throw new Error(`${e.message} (after ${attempt} attempt(s))`);
      const wait = 5000 * attempt;
      console.warn(`[sluice] ${descriptor.id}: ${e.message} — retrying in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  // Layer 4 — identical bytes: keep the version we already have. If its bytes had
  // been evicted, hand the download back so they're re-attached to that same
  // version instead of minting a new one for identical content.
  if (held && held.sha256 === staged.sha256) {
    if (held.evicted) {
      return {
        restored: { version: held.version, ...staged },
        validators,
        probeKey: probeKey || held.probeKey || null,
        bytes: staged.bytes,
      };
    }
    return {
      notModified: true,
      validators,
      probeKey: probeKey || held.probeKey || null,
      discard: staged.tmpPath,
      bytes: staged.bytes,
    };
  }

  return {
    artifact: {
      ...staged,
      keep: Number.isFinite(opts.keep) ? opts.keep : undefined,
      url,
      contentType,
      probeKey: probeKey || null,
      validators,
    },
    bytes: staged.bytes,
    validators,
  };
}

function basenameOf(url) {
  try {
    const p = new URL(url).pathname;
    const b = p.split('/').filter(Boolean).pop() || '';
    // ODS export paths end in /exports/csv — not a filename.
    return /\./.test(b) ? decodeURIComponent(b) : '';
  } catch {
    return '';
  }
}
