// INSEE melodi — Consumer Price Index (IPC) assembler.
// The IPC is not a single upstream document: it's the all-items index plus a set
// of COICOP division sub-indices and their expenditure weights, each a separate
// melodi query. Like `dvf-geo`, this adapter is source-specific and does the
// multi-query assembly INLINE, emitting one self-describing "series" record per
// index so the feed stays a flat array. The consumer reshapes as it likes.
//
// descriptor.source: {
//   api?, dataflow?, geo?, tph?, seasonalAdjust?, divisions?[], base?
// }
const UA = 'sluice/melodi-ipc (zlef.fr open-data gateway)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// melodi rate-limits the free tier; fetch one URL with polite backoff on 429/503,
// honouring Retry-After when present.
async function fetchMelodi(url) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    if (res.status === 429 || res.status === 503) {
      const ra = parseInt(res.headers.get('retry-after') || '', 10);
      const wait = Number.isFinite(ra) ? ra * 1000 : Math.min(30000, 1500 * 2 ** attempt);
      await res.arrayBuffer().catch(() => {});
      await sleep(wait);
      continue;
    }
    throw new Error(`melodi HTTP ${res.status}`);
  }
  throw new Error('melodi HTTP 429 (exhausted retries)');
}

async function melodiSeries(api, dataflow, params) {
  const q = new URLSearchParams({ ...params, maxResult: '2000' });
  let url = `${api}/${dataflow}?${q.toString()}`;
  const values = {};
  let bytes = 0, guard = 0;
  while (url && guard++ < 40) {
    const buf = await fetchMelodi(url);
    bytes += buf.length;
    const doc = JSON.parse(buf.toString('utf8'));
    for (const o of doc.observations || []) {
      const t = o.dimensions.TIME_PERIOD;
      const v = o.measures.OBS_VALUE_INDICE_DE_PRIX && o.measures.OBS_VALUE_INDICE_DE_PRIX.value;
      if (t != null && v != null) values[t] = v;
    }
    url = doc.paging && doc.paging.next ? doc.paging.next : null;
    await sleep(120); // space out sequential queries — be a good citizen
  }
  return { values, bytes };
}

const sortKeys = (obj, re) =>
  Object.fromEntries(Object.keys(obj).filter((k) => re.test(k)).sort().map((k) => [k, obj[k]]));

export default async function melodiIpc(descriptor) {
  const s = descriptor.source || {};
  const api = s.api || 'https://api.insee.fr/melodi/data';
  const dataflow = s.dataflow || 'DS_IPC_PRINC';
  const GEO = s.geo || '2025-FRANCE-F';
  const TPH = s.tph || '_T';
  const SA = s.seasonalAdjust || 'N';
  const divisions = s.divisions || ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13'];
  const common = { GEO, TPH_CPI: TPH, SEASONAL_ADJUST: SA };

  let bytes = 0;
  const records = [];
  const yearRe = /^\d{4}$/, monthRe = /^\d{4}-\d{2}$/;

  // all-items index (COICOP 00): annual + monthly
  const annual = await melodiSeries(api, dataflow, { ...common, COICOP_2018: '00', IND_TYPE: 'IX', FREQ: 'A' });
  const monthly = await melodiSeries(api, dataflow, { ...common, COICOP_2018: '00', IND_TYPE: 'IX', FREQ: 'M' });
  bytes += annual.bytes + monthly.bytes;
  records.push({ kind: 'all-items', freq: 'A', values: sortKeys(annual.values, yearRe) });
  records.push({ kind: 'all-items', freq: 'M', values: sortKeys(monthly.values, monthRe) });

  // COICOP divisions: monthly index + latest annual expenditure weight (per 10000)
  for (const code of divisions) {
    const mon = await melodiSeries(api, dataflow, { ...common, COICOP_2018: code, IND_TYPE: 'IX', FREQ: 'M' });
    const w = await melodiSeries(api, dataflow, { ...common, COICOP_2018: code, IND_TYPE: 'IW', FREQ: 'A' });
    bytes += mon.bytes + w.bytes;
    const wy = Object.keys(w.values).filter((y) => yearRe.test(y)).sort();
    if (!Object.keys(mon.values).length) continue;
    records.push({
      kind: 'division', code, freq: 'M',
      weight: wy.length ? w.values[wy[wy.length - 1]] : null,
      values: sortKeys(mon.values, monthRe),
    });
  }

  const aKeys = Object.keys(records[0].values);
  const mKeys = Object.keys(records[1].values);
  const raw = {
    source: 'INSEE — Indice des prix à la consommation (IPC), Base de données macroéconomiques (BDM)',
    dataflow, api,
    base: s.base || '2025 = 100',
    geo: 'France (métropole + DOM), ensemble des ménages, indice brut',
    license: descriptor.license || 'Licence Ouverte 2.0 (Etalab)',
    page: descriptor.homepage || 'https://www.insee.fr/fr/statistiques/serie/000436387',
    annualRange: [aKeys[0], aKeys[aKeys.length - 1]],
    monthlyRange: [mKeys[0], mKeys[mKeys.length - 1]],
    divisions: records.filter((r) => r.kind === 'division').map((r) => r.code),
  };

  return { records, bytes, raw };
}
