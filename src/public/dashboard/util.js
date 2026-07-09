// Small dependency-free helpers shared across the dashboard client.

// Resolve a label that may be a string or an {en,fr,…} map.
export function pick(val, locale, fallback = 'en') {
  if (val == null) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'object') return val[locale] ?? val[fallback] ?? Object.values(val)[0] ?? '';
  return String(val);
}

// Dot-path getter (records are often nested, e.g. p.gazole).
export function getPath(obj, path) {
  if (obj == null) return undefined;
  if (path.indexOf('.') === -1) return obj[path];
  let cur = obj;
  for (const seg of path.split('.')) { if (cur == null) return undefined; cur = cur[seg]; }
  return cur;
}

export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Format a value for display given an optional column/metric spec + feed meta.
export function fmtValue(value, spec, meta, locale) {
  if (value == null || value === '') return '—';
  // Coded value → human label from feed meta (dept "13" → "Bouches-du-Rhône").
  if (spec?.labelsFromMeta && meta && meta[spec.labelsFromMeta]) {
    const lbl = meta[spec.labelsFromMeta][value];
    if (lbl) return lbl;
  }
  const fmt = spec?.format;
  if (fmt === 'price') {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    return `${n.toFixed(3)} ${spec?.unit || '€'}`;
  }
  if (fmt === 'number' || typeof value === 'number') {
    const n = Number(value);
    if (Number.isFinite(n)) {
      // At most 1 decimal — 3 decimals with a locale comma (e.g. fr "59,418")
      // reads like thousands and misleads on averages.
      const s = n.toLocaleString(locale, { maximumFractionDigits: 1 });
      return spec?.unit ? `${s} ${spec.unit}` : s;
    }
  }
  return String(value);
}

export function isNumericSpec(spec) {
  return spec?.format === 'price' || spec?.format === 'number';
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// Read a CSS custom property off :root (theme colours for the map ramp).
export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Parse "#rrggbb" → [r,g,b].
function hex2rgb(h) {
  const m = /^#?([0-9a-f]{6})$/i.exec(h.trim());
  if (!m) return [140, 179, 57];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// A perceptually-fine two-stop ramp accent → danger for the map colouring.
export function makeRamp(fromVar, toVar) {
  const a = hex2rgb(cssVar(fromVar) || '#8fb339');
  const b = hex2rgb(cssVar(toVar) || '#d9455f');
  return (t) => {
    const k = Math.max(0, Math.min(1, t));
    const c = a.map((av, i) => Math.round(av + (b[i] - av) * k));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  };
}
