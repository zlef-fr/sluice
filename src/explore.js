// The exploration query engine. Sluice already keeps every feed's records warm
// in memory ({data:[...records]}), so deep exploration — filter, sort, paginate,
// facet, range-stat, full-text search, single-record lookup — is a cheap in-RAM
// pass. This module is pure (no I/O): the HTTP layer hands it a feed payload +
// parsed query and gets back a wire-ready result. Keeping it side-effect-free
// makes it trivially testable and reusable by the MCP surface later.

// ── field access ──────────────────────────────────────────────────────────────
// Records are arbitrary JSON and often nested (fr-fuel-prices puts prices under
// `p.gazole`), so every field reference is a dot-path.
export function getPath(obj, path) {
  if (obj == null) return undefined;
  if (path.indexOf('.') === -1) return obj[path];
  let cur = obj;
  for (const seg of path.split('.')) {
    if (cur == null) return undefined;
    cur = cur[seg];
  }
  return cur;
}

// Diacritic- and case-insensitive folding for text search / eq matching.
export function fold(v) {
  return String(v).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 50;
const MAX_FACET_FIELDS = 16;
const MAX_FACET_BUCKETS = 60;

// A parsed query is a plain object; parseQuery() below turns Express req.query
// into it. Kept separate so tests can construct queries directly.
//
// query = {
//   q, qFields:[...],                        // full-text
//   eq:{field:[values]}, in:{field:[values]},// categorical filters (AND across
//   min:{field:n}, max:{field:n},            //   fields, OR within a field)
//   has:[field], missing:[field],            // presence filters
//   sort:{field, dir:1|-1},                  // ordering (nulls always last)
//   page, pageSize, select:[fields],         // paging + projection
//   facets:[fields], stats:[fields],         // aggregations for the UI
// }

// Does one record pass every filter clause? (facets/sort/paging happen after.)
function matches(rec, query) {
  const { q, qFields, eq, in: inn, min, max, has, missing } = query;

  if (q) {
    const needle = fold(q);
    const fields = qFields && qFields.length ? qFields : null;
    let hit = false;
    if (fields) {
      for (const f of fields) {
        const v = getPath(rec, f);
        if (v != null && fold(v).includes(needle)) { hit = true; break; }
      }
    } else {
      // No configured search fields → scan every string/number leaf value.
      hit = anyLeafIncludes(rec, needle);
    }
    if (!hit) return false;
  }

  for (const f in eq) {
    const v = getPath(rec, f);
    if (v == null) return false;
    const folded = fold(v);
    if (!eq[f].some((want) => fold(want) === folded)) return false;
  }
  for (const f in inn) {
    const v = getPath(rec, f);
    if (v == null) return false;
    const folded = fold(v);
    if (!inn[f].some((want) => fold(want) === folded)) return false;
  }
  for (const f in min) {
    const v = Number(getPath(rec, f));
    if (!Number.isFinite(v) || v < min[f]) return false;
  }
  for (const f in max) {
    const v = Number(getPath(rec, f));
    if (!Number.isFinite(v) || v > max[f]) return false;
  }
  for (const f of has || []) {
    const v = getPath(rec, f);
    if (v == null || v === '') return false;
  }
  for (const f of missing || []) {
    const v = getPath(rec, f);
    if (!(v == null || v === '')) return false;
  }
  return true;
}

function anyLeafIncludes(v, needle, depth = 0) {
  if (v == null || depth > 4) return false;
  const t = typeof v;
  if (t === 'string' || t === 'number') return fold(v).includes(needle);
  if (Array.isArray(v)) return v.some((x) => anyLeafIncludes(x, needle, depth + 1));
  if (t === 'object') {
    for (const k in v) if (anyLeafIncludes(v[k], needle, depth + 1)) return true;
  }
  return false;
}

// Sort comparator: numbers numerically, everything else by folded string; null/
// undefined always sink to the bottom regardless of direction.
function comparator(field, dir) {
  return (a, b) => {
    const va = getPath(a, field);
    const vb = getPath(b, field);
    const na = va == null || va === '';
    const nb = vb == null || vb === '';
    if (na && nb) return 0;
    if (na) return 1;
    if (nb) return -1;
    const numA = Number(va);
    const numB = Number(vb);
    if (Number.isFinite(numA) && Number.isFinite(numB)) return (numA - numB) * dir;
    return fold(va) < fold(vb) ? -dir : fold(va) > fold(vb) ? dir : 0;
  };
}

// Value-count buckets for a field over the given rows (top MAX_FACET_BUCKETS).
function facetOf(rows, field) {
  const counts = new Map();
  for (const r of rows) {
    const v = getPath(r, field);
    if (v == null || v === '') continue;
    const key = String(v);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const buckets = [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : 1));
  return { buckets: buckets.slice(0, MAX_FACET_BUCKETS), cardinality: counts.size };
}

// min/max/avg/count + a coarse histogram for a numeric field — feeds range
// sliders, KPI tiles and the distribution chart in one pass-friendly shape.
const HIST_BINS = 24;
function statOf(rows, field) {
  let n = 0, sum = 0, min = Infinity, max = -Infinity;
  const vals = [];
  for (const r of rows) {
    const v = Number(getPath(r, field));
    if (!Number.isFinite(v)) continue;
    n++; sum += v; vals.push(v);
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!n) return { count: 0, min: null, max: null, avg: null, bins: null };
  const span = (max - min) || 1;
  const binW = span / HIST_BINS;
  const bins = new Array(HIST_BINS).fill(0);
  for (const v of vals) {
    let i = Math.floor((v - min) / binW);
    if (i >= HIST_BINS) i = HIST_BINS - 1;
    if (i < 0) i = 0;
    bins[i]++;
  }
  return { count: n, min, max, avg: sum / n, bins, binMin: min, binW };
}

function project(rec, select) {
  if (!select || !select.length) return rec;
  const out = {};
  for (const f of select) {
    const v = getPath(rec, f);
    if (v !== undefined) out[f] = v; // flat keyed by path — table-friendly
  }
  return out;
}

// The heart of the exploration API. `payload` = {data, meta, fetchedAt}.
export function runQuery(payload, query) {
  const data = Array.isArray(payload?.data) ? payload.data : [];
  const total = data.length;

  const filtered = query.__noFilters ? data : data.filter((r) => matches(r, query));

  // Facets & stats are computed over the filtered set (what the user is looking
  // at right now), capped so a pathological config can't blow up the response.
  const facets = {};
  for (const f of (query.facets || []).slice(0, MAX_FACET_FIELDS)) facets[f] = facetOf(filtered, f);
  const stats = {};
  for (const f of (query.stats || []).slice(0, MAX_FACET_FIELDS)) stats[f] = statOf(filtered, f);

  let rows = filtered;
  if (query.sort && query.sort.field) {
    rows = [...filtered].sort(comparator(query.sort.field, query.sort.dir < 0 ? -1 : 1));
  }

  const pageSize = clamp(query.pageSize ?? DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const page = clamp(query.page ?? 1, 1, pages);
  const start = (page - 1) * pageSize;
  const pageRows = rows.slice(start, start + pageSize).map((r) => project(r, query.select));

  return {
    total,
    filtered: filtered.length,
    page,
    pageSize,
    pages,
    rows: pageRows,
    facets,
    stats,
    fetchedAt: payload?.fetchedAt ?? null,
  };
}

// Single-record lookup by an id field (default "id"), folded-equality so URLs
// survive case differences. Returns the raw record or null.
export function findRecord(payload, id, idField = 'id') {
  const data = Array.isArray(payload?.data) ? payload.data : [];
  const want = fold(id);
  for (const r of data) {
    const v = getPath(r, idField);
    if (v != null && fold(v) === want) return r;
  }
  return null;
}

// Compact geo points for a map scatter: the filtered records reduced to
// [id, lat, lon, colorValue] tuples so the client can plot tens of thousands
// cheaply. Honours the same filters as runQuery; even-samples down to `cap` so
// a huge feed stays a small payload. Returns { points, cap, count, color:{min,max} }.
export function geoPoints(payload, query, { lat, lon, color, idField = 'id', cap = 20000 }) {
  const data = Array.isArray(payload?.data) ? payload.data : [];
  const src = query.__noFilters ? data : data.filter((r) => matches(r, query));

  const withGeo = [];
  for (const r of src) {
    const la = Number(getPath(r, lat));
    const lo = Number(getPath(r, lon));
    if (!Number.isFinite(la) || !Number.isFinite(lo)) continue;
    const c = color ? Number(getPath(r, color)) : NaN;
    withGeo.push([getPath(r, idField), la, lo, Number.isFinite(c) ? c : null]);
  }

  // Even-sample (deterministic stride) if we're over the cap.
  let points = withGeo;
  if (withGeo.length > cap) {
    const stride = withGeo.length / cap;
    points = [];
    for (let i = 0; i < withGeo.length; i += stride) points.push(withGeo[Math.floor(i)]);
  }

  let min = Infinity, max = -Infinity;
  for (const p of points) {
    if (p[3] == null) continue;
    if (p[3] < min) min = p[3];
    if (p[3] > max) max = p[3];
  }
  return {
    points,
    cap,
    count: withGeo.length,
    color: Number.isFinite(min) ? { min, max } : null,
  };
}

// ── query parsing ─────────────────────────────────────────────────────────────
// Turns flat req.query into the structured query above. Scheme:
//   q=..&qf=v,a,b            full-text + which fields
//   eq.<field>=x  (repeat)   equality (repeat or comma → OR within field)
//   in.<field>=x,y           membership
//   min.<field>=n max.<field>=n
//   has=<field>,..  missing=<field>,..
//   sort=field  |  sort=-field
//   page=1 pageSize=50 select=f1,f2 facets=f1,f2 stats=f1,f2
export function parseQuery(raw) {
  const q = {};
  const eq = {}, inn = {}, min = {}, max = {};
  for (const key in raw) {
    const val = raw[key];
    if (key.startsWith('eq.')) addValues(eq, key.slice(3), val);
    else if (key.startsWith('in.')) addValues(inn, key.slice(3), val);
    else if (key.startsWith('min.')) min[key.slice(4)] = Number(firstVal(val));
    else if (key.startsWith('max.')) max[key.slice(4)] = Number(firstVal(val));
  }
  // Drop NaN numeric bounds (a bad ?min.x=abc shouldn't filter everything out).
  for (const f in min) if (!Number.isFinite(min[f])) delete min[f];
  for (const f in max) if (!Number.isFinite(max[f])) delete max[f];

  q.q = raw.q ? String(firstVal(raw.q)).trim() : '';
  q.qFields = splitList(raw.qf);
  q.eq = eq;
  q.in = inn;
  q.min = min;
  q.max = max;
  q.has = splitList(raw.has);
  q.missing = splitList(raw.missing);

  if (raw.sort) {
    const s = String(firstVal(raw.sort));
    q.sort = s.startsWith('-') ? { field: s.slice(1), dir: -1 } : { field: s, dir: 1 };
  }
  q.page = toInt(raw.page, 1);
  q.pageSize = toInt(raw.pageSize, DEFAULT_PAGE_SIZE);
  q.select = splitList(raw.select);
  q.facets = splitList(raw.facets);
  q.stats = splitList(raw.stats);

  q.__noFilters =
    !q.q &&
    !Object.keys(eq).length && !Object.keys(inn).length &&
    !Object.keys(min).length && !Object.keys(max).length &&
    !q.has.length && !q.missing.length;

  return q;
}

// ── small helpers ─────────────────────────────────────────────────────────────
function firstVal(v) { return Array.isArray(v) ? v[0] : v; }
function splitList(v) {
  if (v == null) return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr.flatMap((s) => String(s).split(',')).map((s) => s.trim()).filter(Boolean);
}
function addValues(bag, field, v) {
  const vals = splitList(v);
  if (!vals.length) return;
  bag[field] = (bag[field] || []).concat(vals);
}
function toInt(v, dflt) {
  const n = parseInt(firstVal(v), 10);
  return Number.isFinite(n) ? n : dflt;
}
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

export const LIMITS = { MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE, MAX_FACET_FIELDS, MAX_FACET_BUCKETS };
