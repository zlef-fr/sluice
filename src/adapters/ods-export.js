// OpenDataSoft export adapter. Most French open-data portals (data.gouv proxies,
// ODRE, opendatasoft.com, roulez-eco, ...) run OpenDataSoft, whose Explore API
// exposes a clean JSON export of a whole dataset. Instead of hand-writing the
// URL each time, describe it structurally:
//   source: { base, dataset, select?: [..], where?: "...", limit?: n }
// e.g. { base: "https://odre.opendatasoft.com", dataset: "bornes-irve",
//        select: ["nom_operateur","puissance_nominale", ...] }
import { USER_AGENT } from '../config.js';
import { toArray } from '../util.js';

export default async function odsExport(descriptor) {
  const s = descriptor.source || {};
  if (descriptor.url) {
    // Caller gave a fully-formed export URL — just fetch it.
    return fetchJson(descriptor.url, descriptor);
  }
  if (!s.base || !s.dataset) throw new Error('ods-export needs source.base and source.dataset');
  const params = new URLSearchParams();
  if (Array.isArray(s.select) && s.select.length) params.set('select', s.select.join(','));
  if (s.where) params.set('where', s.where);
  if (s.limit) params.set('limit', String(s.limit));
  const url = `${s.base.replace(/\/$/, '')}/api/explore/v2.1/catalog/datasets/${encodeURIComponent(
    s.dataset,
  )}/exports/json?${params.toString()}`;
  return fetchJson(url, descriptor);
}

async function fetchJson(url, descriptor) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...(descriptor.options.headers || {}) },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { records: toArray(JSON.parse(buf.toString('utf8'))), bytes: buf.length };
}
