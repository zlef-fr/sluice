// Transform for the French fuel-price feed (Prix des carburants, Etalab).
// The adapter (http-zip-xml) hands us the raw ISO-8859-1 XML via ctx.raw; here
// we SAX-parse it into one record per station, enrich with department (from the
// postcode) and brand (nearest OpenStreetMap fuel node), and compute price meta.
// Ported from essence.zlef.fr / maps.zlef.fr so both consume an identical feed.
import sax from 'sax';
import { deptFromCP, DEPARTMENTS } from './departments.js';
import { loadBrands, brandFor } from './brands.js';
import { nowIso } from '../util.js';

const FUEL_KEY = {
  Gazole: 'gazole', SP95: 'sp95', SP98: 'sp98',
  E10: 'e10', E85: 'e85', GPLc: 'gplc',
};

function fuelEtalab(_records, _descriptor, ctx) {
  const xml = ctx && ctx.raw;
  if (!xml) throw new Error('fuel-etalab expects raw XML (use adapter http-zip-xml)');
  const stations = parseXml(xml);
  return { data: stations, meta: buildMeta(stations) };
}

// Load the OSM brand snapshot once, before the first refresh.
fuelEtalab.init = async () => { await loadBrands(); };

function parseXml(xml) {
  const parser = sax.parser(true, { trim: true });
  const stations = [];
  let cur = null;

  parser.onopentag = (node) => {
    const n = node.name;
    const at = node.attributes;
    if (n === 'pdv') {
      const la = parseFloat(at.latitude);
      const lo = parseFloat(at.longitude);
      cur = {
        id: at.id, cp: at.cp,
        r: at.pop === 'A' ? 1 : 0,
        la: isFinite(la) ? +(la / 100000).toFixed(5) : null, // feed units → WGS84°
        lo: isFinite(lo) ? +(lo / 100000).toFixed(5) : null,
        v: '', a: '', p: {},
      };
    } else if (n === 'prix' && cur) {
      const key = FUEL_KEY[at.nom];
      const val = parseFloat(at.valeur);
      if (key && isFinite(val) && val > 0.2 && val < 4) cur.p[key] = +val.toFixed(3);
    } else if (cur && (n === 'ville' || n === 'adresse')) {
      cur._t = n === 'ville' ? 'v' : 'a';
    }
  };
  parser.ontext = (t) => { if (cur && cur._t && t) cur[cur._t] = (cur[cur._t] || '') + t; };
  parser.onclosetag = (name) => {
    if (name === 'ville' || name === 'adresse') { if (cur) cur._t = null; }
    if (name === 'pdv' && cur) {
      const c = cur; cur = null;
      if (c.la == null || c.lo == null) return;
      if (Math.abs(c.la) < 1 || Math.abs(c.lo) < 0.1) return; // drop 0/0 & bogus
      if (!Object.keys(c.p).length) return;
      const d = deptFromCP(c.cp);
      if (!d) return;
      const b = brandFor(c.la, c.lo); // nearest OSM brand within ~300 m, or null
      stations.push({
        id: c.id, v: clean(c.v), a: clean(c.a), d, r: c.r,
        la: c.la, lo: c.lo, p: c.p, ...(b ? { b } : {}),
      });
    }
  };
  parser.write(xml).close();
  return stations;
}

function clean(s) { return s ? s.replace(/\s+/g, ' ').trim().slice(0, 60) : ''; }

function buildMeta(stations) {
  const fuels = {};
  for (const st of stations) {
    for (const [k, v] of Object.entries(st.p)) {
      const f = (fuels[k] = fuels[k] || { sum: 0, n: 0, min: 99, max: 0, vals: [] });
      f.sum += v; f.n++; if (v < f.min) f.min = v; if (v > f.max) f.max = v; f.vals.push(v);
    }
  }
  const out = {};
  for (const [k, f] of Object.entries(fuels)) {
    const s = f.vals.sort((a, b) => a - b);
    const pct = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
    out[k] = {
      avg: +(f.sum / f.n).toFixed(3), min: f.min, max: f.max, n: f.n,
      p10: pct(0.1), p50: pct(0.5), p90: pct(0.9),
    };
  }
  return { fuels: out, depts: DEPARTMENTS, count: stations.length, builtAt: nowIso() };
}

export default fuelEtalab;
