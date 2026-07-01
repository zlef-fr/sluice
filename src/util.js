// Small shared helpers.

// Parse a human duration ("6h", "30m", "24h", "90s", "1d") → milliseconds.
// A bare number is treated as milliseconds. Returns null on garbage.
export function parseDuration(v) {
  if (v == null) return null;
  if (typeof v === 'number' && isFinite(v)) return v;
  const m = String(v).trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = (m[2] || 'ms').toLowerCase();
  const mult = { ms: 1, s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[unit];
  return n * mult;
}

// kebab-case id validation: lowercase letters, digits, hyphens; 2–64 chars.
export function isValidId(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9-]{1,63}$/.test(id);
}

// Read a nested field by dotted path ("a.b.c") from an object.
export function pluck(obj, path) {
  if (!path) return undefined;
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function nowIso() {
  return new Date().toISOString();
}

// Coerce anything the adapters return into a plain array of records.
export function toArray(x) {
  if (Array.isArray(x)) return x;
  if (x && Array.isArray(x.records)) return x.records;   // ODS shape
  if (x && Array.isArray(x.results)) return x.results;
  if (x && Array.isArray(x.data)) return x.data;
  if (x && Array.isArray(x.features)) return x.features;  // geojson
  return x == null ? [] : [x];
}
