// OpenDataSoft export adapter. Most French open-data portals (data.gouv proxies,
// ODRE, opendatasoft.com, roulez-eco, ...) run OpenDataSoft, whose Explore API
// exposes a clean JSON export of a whole dataset. Instead of hand-writing the
// URL each time, describe it structurally:
//   source: { base, dataset, select?: [..], where?: "...", limit?: n }
// e.g. { base: "https://odre.opendatasoft.com", dataset: "bornes-irve",
//        select: ["nom_operateur","puissance_nominale", ...] }
import { toArray } from '../util.js';
import { conditionalFetch } from './http.js';

export default async function odsExport(descriptor, ctx = {}) {
  const s = descriptor.source || {};
  let url = descriptor.url; // caller may pass a fully-formed export URL
  if (!url) {
    if (!s.base || !s.dataset) throw new Error('ods-export needs source.base and source.dataset');
    const params = new URLSearchParams();
    if (Array.isArray(s.select) && s.select.length) params.set('select', s.select.join(','));
    if (s.where) params.set('where', s.where);
    if (s.limit) params.set('limit', String(s.limit));
    url = `${s.base.replace(/\/$/, '')}/api/explore/v2.1/catalog/datasets/${encodeURIComponent(
      s.dataset,
    )}/exports/json?${params.toString()}`;
  }

  const { res, notModified, validators } = await conditionalFetch(url, {
    headers: { Accept: 'application/json', ...(descriptor.options.headers || {}) },
    validators: ctx.validators,
  });
  if (notModified) return { notModified: true, validators };

  const buf = Buffer.from(await res.arrayBuffer());
  return { records: toArray(JSON.parse(buf.toString('utf8'))), bytes: buf.length, validators };
}
