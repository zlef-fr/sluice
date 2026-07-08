// SNCF « Objets trouvés, restitution » — a very large dataset (>1.5M rows). We
// must NOT export it whole. Like dvf-geo / melodi-ipc, this adapter aggregates
// INLINE via the OpenDataSoft v2.1 Explore API (group_by facets + a small recent
// sample), emitting a compact museum feed instead of millions of raw rows.
//
//   descriptor.source = { base, dataset, sample?: n }
//
// Technical field names of the SNCF dataset (kept overridable via source.fields
// in case SNCF renames a column):
//   date, gc_obo_date_heure_restitution_c, gc_obo_gare_origine_r_name,
//   gc_obo_gare_origine_r_code_uic_c, gc_obo_nature_c, gc_obo_type_c
import { USER_AGENT } from '../config.js';

const DEFAULT_FIELDS = {
  date: 'date',
  restitution: 'gc_obo_date_heure_restitution_c',
  gare: 'gc_obo_gare_origine_r_name',
  uic: 'gc_obo_gare_origine_r_code_uic_c',
  nature: 'gc_obo_nature_c',
  type: 'gc_obo_type_c',
};

export default async function sncfLost(descriptor, ctx = {}) {
  const s = descriptor.source || {};
  if (!s.base || !s.dataset) throw new Error('sncf-lost needs source.base and source.dataset');
  const f = { ...DEFAULT_FIELDS, ...(s.fields || {}) };
  const root = `${s.base.replace(/\/$/, '')}/api/explore/v2.1/catalog/datasets/${encodeURIComponent(s.dataset)}`;

  const call = async (path) => {
    const res = await fetch(`${root}${path}`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${path.slice(0, 60)}`);
    return res.json();
  };
  // a facet/aggregation query — tolerant: a single failing facet returns [] so
  // the rest of the feed still assembles.
  const agg = async (params) => {
    try {
      const j = await call(`/records?${params}&limit=100&timezone=Europe/Paris`);
      return j.results || [];
    } catch (e) {
      console.warn(`[sluice] sncf-lost facet failed: ${e.message}`);
      return [];
    }
  };
  const countWhere = async (where) => {
    try {
      const j = await call(`/records?limit=0${where ? `&where=${encodeURIComponent(where)}` : ''}`);
      return j.total_count ?? 0;
    } catch {
      return 0;
    }
  };

  const restNotNull = `${f.restitution} IS NOT NULL`;

  const [
    objects,
    returned,
    byTypeRaw,
    byTypeRetRaw,
    byNatureRaw,
    byGareRaw,
    byYearRaw,
    coverageRaw,
    sampleRaw,
  ] = await Promise.all([
    countWhere(''),
    countWhere(restNotNull),
    agg(`group_by=${f.type} as type&select=count(*) as n&order_by=n desc`),
    agg(`group_by=${f.type} as type&select=count(*) as n&where=${encodeURIComponent(restNotNull)}&order_by=n desc`),
    agg(`group_by=${f.nature} as nature&select=count(*) as n&order_by=n desc`),
    agg(`group_by=${f.gare} as gare&select=count(*) as n&order_by=n desc`),
    agg(`group_by=year(${f.date}) as year&select=count(*) as n&order_by=year asc`),
    call(`/records?select=min(${f.date}) as mn, max(${f.date}) as mx&limit=0`).then((j) => j.results?.[0] || {}).catch(() => ({})),
    call(
      `/records?select=${[f.date, f.restitution, f.gare, f.uic, f.nature, f.type].join(',')}` +
        `&order_by=${f.date} desc&limit=${Math.min(s.sample || 120, 200)}&timezone=Europe/Paris`,
    ).then((j) => j.results || []).catch(() => []),
  ]);

  const retByType = new Map(byTypeRetRaw.map((r) => [r.type, r.n]));
  const byType = byTypeRaw.map((r) => ({ type: r.type, count: r.n, returned: retByType.get(r.type) || 0 }));
  const byNature = byNatureRaw.slice(0, 40).map((r) => ({ nature: r.nature, count: r.n }));
  const topGares = byGareRaw.slice(0, 15).map((r) => ({ gare: r.gare, count: r.n }));
  const byYear = byYearRaw
    .filter((r) => r.year != null)
    .map((r) => ({ year: String(r.year), count: r.n }));

  // recent sample → exhibit records (the museum's "just arrived" plinth)
  const records = sampleRaw.map((r) => ({
    date: r[f.date] || null,
    returnedDate: r[f.restitution] || null,
    returned: Boolean(r[f.restitution]),
    gare: r[f.gare] || null,
    uic: r[f.uic] != null ? String(r[f.uic]) : null,
    nature: r[f.nature] || null,
    type: r[f.type] || null,
  }));

  const raw = {
    totals: {
      objects,
      returned,
      returnedPct: objects ? Math.round((returned / objects) * 1000) / 10 : 0,
      stations: byGareRaw.length || null,
    },
    coverage: {
      from: (coverageRaw.mn || '').slice(0, 10) || null,
      to: (coverageRaw.mx || '').slice(0, 10) || null,
    },
    byType,
    byNature,
    topGares,
    byYear,
    fetchedAt: new Date().toISOString(),
    source: 'SNCF Open Data — Objets trouvés, restitution',
    license: descriptor.license || 'Licence Ouverte / Etalab',
    page: descriptor.homepage || `${s.base}/explore/dataset/${s.dataset}`,
  };

  return { records, bytes: JSON.stringify(records).length, raw };
}
