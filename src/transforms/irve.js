// Transform for the French EV-charging open dataset (IRVE consolidé, via ODRE
// OpenDataSoft). The adapter (ods-export) hands us charging POINTS; we aggregate
// to one record per STATION (headline = fastest point), keep connector flags,
// derive department from the postcode, and cap the payload with even sampling.
// Ported from essence.zlef.fr / maps.zlef.fr.
import { deptFromCP, DEPARTMENTS } from './departments.js';
import { nowIso } from '../util.js';

const CAP = 20000;
const yes = (v) => v === 'True' || v === true || v === 'true' || v === '1';

const cleanName = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 28);
const cleanOperator = (s) => {
  s = String(s || '').split('|')[0].replace(/\bFR\*\S+/g, '');
  return s.replace(/\s+/g, ' ').trim().slice(0, 26);
};

export default function irve(records) {
  const byStation = new Map();
  for (const r of records) {
    const id = r.id_station_itinerance;
    const kw = Number(r.puissance_nominale);
    const la = Number(r.consolidated_latitude);
    const lo = Number(r.consolidated_longitude);
    if (!id) continue;
    if (!isFinite(kw) || kw < 2 || kw > 400) continue;
    if (!isFinite(la) || !isFinite(lo)) continue;
    if (la < 41 || la > 51.6 || lo < -5.5 || lo > 9.8) continue; // metropolitan bbox
    let s = byStation.get(id);
    if (!s) {
      const cp = String(r.consolidated_code_postal ?? '').padStart(5, '0');
      const commune = cleanName(r.consolidated_commune);
      if (!/^\d{5}$/.test(cp) || cp < '01000') continue;
      const d = deptFromCP(cp);
      if (!d || !DEPARTMENTS[d] || !commune) continue;
      s = {
        id, d, la: +la.toFixed(5), lo: +lo.toFixed(5), v: commune,
        o: cleanOperator(r.nom_operateur) || cleanName(r.nom_enseigne),
        kw: 0, c: new Set(),
      };
      byStation.set(id, s);
    }
    if (kw > s.kw) s.kw = Math.round(kw);
    if (yes(r.prise_type_2)) s.c.add('t2');
    if (yes(r.prise_type_combo_ccs)) s.c.add('ccs');
    if (yes(r.prise_type_chademo)) s.c.add('chademo');
    if (yes(r.prise_type_ef)) s.c.add('ef');
  }

  let stations = [...byStation.values()].map((s) => ({
    id: s.id, v: s.v, d: s.d, la: s.la, lo: s.lo, kw: s.kw,
    o: s.o || null, c: [...s.c],
  }));

  if (stations.length > CAP) {
    const step = stations.length / CAP;
    const out = [];
    for (let i = 0; i < stations.length; i += step) out.push(stations[Math.floor(i)]);
    stations = out;
  }

  return { data: stations, meta: buildMeta(stations) };
}

function buildMeta(stations) {
  const sorted = stations.map((s) => s.kw).sort((a, b) => a - b);
  const n = sorted.length;
  const pct = (q) => sorted[Math.min(n - 1, Math.floor(q * n))] || 0;
  const avg = n ? Math.round(sorted.reduce((a, b) => a + b, 0) / n) : 0;
  // The distinct real power ratings present — the only values a "guess the power"
  // consumer (essence.zlef.fr) may offer, so a player can't pick an impossible one.
  const powers = [...new Set(sorted)].sort((a, b) => a - b);
  return {
    count: n, avg, min: sorted[0] || 0, max: sorted[n - 1] || 0,
    p10: pct(0.1), p50: pct(0.5), p90: pct(0.9),
    powers, depts: DEPARTMENTS, builtAt: nowIso(),
  };
}
