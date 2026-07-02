// DVF (Demandes de valeurs foncières) adapter — the shared French property-price
// source for foncier.zlef.fr, m2.zlef.fr and heat.zlef.fr. The upstream is huge
// (Etalab geo-dvf national `full.csv.gz`, ~100 MB compressed / millions of rows
// per year), so this adapter STREAMS gunzip → CSV and aggregates on the fly to a
// compact per-commune × year median €/m² table — the only DVF grain the fleet
// consumes. It replicates foncier's pipeline/build.py exactly so consumers get
// the same numbers, computed once, centrally.
//
// Returns { records: communes[], bytes, raw: { departements, national, years } }.
// The `dvf-communes` transform lifts the raw extras into the feed meta.
import zlib from 'node:zlib';
import readline from 'node:readline';
import { Readable, Transform } from 'node:stream';

const DEFAULT_BASE = 'https://files.data.gouv.fr/geo-dvf/latest/csv';
const DEFAULT_FILE = 'full.csv.gz';
const DEFAULT_YEARS = [2021, 2022, 2023, 2024, 2025];
const MIN_SURF = 9.0;
const MIN_PPM = 500.0;
const MAX_PPM = 30000.0;

// Quote-aware single-line CSV splitter (geo-dvf has no embedded newlines).
function splitCsvLine(line) {
  const out = [];
  let f = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') { if (line[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(f); f = ''; }
    else f += ch;
  }
  out.push(f);
  return out;
}

function median(arr) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const n = s.length;
  const mid = n >> 1;
  return n % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
// Python round() semantics (round-half-to-even) so medians match foncier's
// pipeline (build.py) to the euro — a plain Math.round would differ on exact .5.
function roundHalfEven(x) {
  const fl = Math.floor(x);
  const frac = x - fl;
  if (frac < 0.5) return fl;
  if (frac > 0.5) return fl + 1;
  return fl % 2 === 0 ? fl : fl + 1; // exactly .5 → nearest even
}
const med = (arr) => { const m = median(arr); return m == null ? null : roundHalfEven(m); };

// Stream one national file for `year`, folding priced sales into the shared
// `communes` / `depts` accumulators. Mirrors build.py:process_year.
async function processYear(url, year, communes, depts) {
  const res = await fetch(url, { headers: { 'User-Agent': 'sluice.zlef.fr (open-data gateway)' }, redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);

  let bytes = 0;
  const counter = new Transform({ transform(chunk, _e, cb) { bytes += chunk.length; cb(null, chunk); } });
  const gunzip = zlib.createGunzip();
  Readable.fromWeb(res.body).pipe(counter).pipe(gunzip);
  const rl = readline.createInterface({ input: gunzip, crlfDelay: Infinity });

  // per-commune / per-dept value lists for THIS year only (released after)
  const cAll = new Map(); const cAppt = new Map(); const cMais = new Map();
  const cLon = new Map(); const cLat = new Map(); const cGeoN = new Map();
  const cNom = new Map(); const cDep = new Map(); const dAll = new Map();
  const seen = new Set(); // (id_mutation|type_local) dedupe
  let idx = null;
  let nRows = 0;

  const push = (map, key, val) => { const a = map.get(key); if (a) a.push(val); else map.set(key, [val]); };

  for await (const line of rl) {
    if (idx == null) {
      const h = splitCsvLine(line);
      idx = {};
      h.forEach((name, i) => { idx[name] = i; });
      continue;
    }
    if (!line) continue;
    const c = splitCsvLine(line);
    nRows++;
    if (c[idx.nature_mutation] !== 'Vente') continue;
    const tl = c[idx.type_local];
    if (tl !== 'Appartement' && tl !== 'Maison') continue;
    const cc = c[idx.code_commune];
    if (!cc) continue;
    const v = parseFloat(c[idx.valeur_fonciere]);
    const s = parseFloat(c[idx.surface_reelle_bati]);
    if (!isFinite(v) || !isFinite(s)) continue;
    if (s <= MIN_SURF || v <= 0) continue;
    const ppm = v / s;
    if (ppm < MIN_PPM || ppm > MAX_PPM) continue;
    const key = c[idx.id_mutation] + '|' + tl;
    if (seen.has(key)) continue;
    seen.add(key);

    push(cAll, cc, ppm);
    push(tl === 'Appartement' ? cAppt : cMais, cc, ppm);
    push(dAll, c[idx.code_departement], ppm);
    if (!cNom.has(cc)) cNom.set(cc, c[idx.nom_commune]);
    if (!cDep.has(cc)) cDep.set(cc, c[idx.code_departement]);
    const lon = parseFloat(c[idx.longitude]);
    const lat = parseFloat(c[idx.latitude]);
    if (isFinite(lon) && isFinite(lat)) {
      cLon.set(cc, (cLon.get(cc) || 0) + lon);
      cLat.set(cc, (cLat.get(cc) || 0) + lat);
      cGeoN.set(cc, (cGeoN.get(cc) || 0) + 1);
    }
  }

  const ys = String(year);
  for (const [cc, vals] of cAll) {
    let com = communes.get(cc);
    if (!com) {
      com = { code: cc, nom: cNom.get(cc) || cc, dep: cDep.get(cc) || cc.slice(0, 2), lon: null, lat: null, y: {} };
      communes.set(cc, com);
    }
    // centroid = mean of geocoded points of the latest year that has them
    // (round-half-even at 5 dp to match foncier's Python round(x, 5))
    if (cGeoN.get(cc)) {
      com.lon = roundHalfEven((cLon.get(cc) / cGeoN.get(cc)) * 1e5) / 1e5;
      com.lat = roundHalfEven((cLat.get(cc) / cGeoN.get(cc)) * 1e5) / 1e5;
    }
    com.y[ys] = { p: med(vals), n: vals.length, a: med(cAppt.get(cc) || []), m: med(cMais.get(cc) || []) };
  }
  for (const [dc, vals] of dAll) {
    let d = depts.get(dc);
    if (!d) { d = { code: dc, y: {} }; depts.set(dc, d); }
    d.y[ys] = { p: med(vals), n: vals.length };
  }
  return { nRows, communes: cAll.size, bytes };
}

// Weighted median of dept medians (build.py national approximation).
function weightedMedian(vals, weights) {
  const order = vals.map((_, i) => i).sort((a, b) => vals[a] - vals[b]);
  const tot = weights.reduce((s, w) => s + w, 0);
  let acc = 0;
  let m = vals[order[order.length - 1]];
  for (const i of order) { acc += weights[i]; if (acc >= tot / 2) { m = vals[i]; break; } }
  return m;
}

export default async function dvfGeo(descriptor) {
  const src = descriptor.source || {};
  const base = (src.base || DEFAULT_BASE).replace(/\/$/, '');
  const file = src.file || DEFAULT_FILE;
  const years = src.years || (descriptor.options && descriptor.options.years) || DEFAULT_YEARS;
  const communes = new Map();
  const depts = new Map();
  let bytes = 0;

  for (const y of years) {
    const url = `${base}/${y}/${file}`;
    try {
      const r = await processYear(url, y, communes, depts);
      bytes += r.bytes;
      console.log(`[sluice] dvf ${y}: ${r.nRows} rows → ${r.communes} communes (${(r.bytes / 1048576).toFixed(0)} MB)`);
    } catch (e) {
      console.warn(`[sluice] dvf ${y}: skipped — ${e.message}`);
    }
  }

  // national weighted median per year, from dept medians + counts
  const national = {};
  for (const y of years) {
    const ys = String(y);
    const vals = []; const weights = [];
    for (const d of depts.values()) {
      const cell = d.y[ys];
      if (cell && cell.p) { vals.push(cell.p); weights.push(cell.n); }
    }
    if (vals.length) national[ys] = { p: weightedMedian(vals, weights), n: weights.reduce((s, w) => s + w, 0) };
  }

  // keep communes with a centroid and at least one priced year; sort by code
  const records = [...communes.values()]
    .filter((c) => c.lon != null && Object.values(c.y).some((v) => v.p))
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

  const departements = [...depts.values()].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

  return { records, bytes, raw: { departements, national, years } };
}
