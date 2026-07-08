// Normalizes the sncf-lost adapter output: the recent-sample records pass
// through as feed `data`, and the inline-assembled aggregates (ctx.raw) become
// the feed `meta` the museum reads for its headline figures + galleries.
export default function sncfLost(records, descriptor, ctx = {}) {
  const raw = ctx.raw || {};
  return {
    data: Array.isArray(records) ? records : [],
    meta: {
      count: Array.isArray(records) ? records.length : 0,
      totals: raw.totals || null,
      coverage: raw.coverage || null,
      byType: raw.byType || [],
      byNature: raw.byNature || [],
      topGares: raw.topGares || [],
      byYear: raw.byYear || [],
      source: raw.source,
      license: raw.license,
      page: raw.page,
      fetchedAt: raw.fetchedAt,
    },
  };
}
