// Transform for the DVF feed. The `dvf-geo` adapter already did the heavy
// streaming aggregation (it must, to avoid holding millions of raw rows), so
// this just lifts the department + national extras it stashed in ctx.raw into
// the feed meta. `data` is the per-commune array as-is.
import { nowIso } from '../util.js';

export default function dvfCommunes(records, _descriptor, ctx) {
  const raw = (ctx && ctx.raw) || {};
  return {
    data: records,
    meta: {
      years: raw.years || [],
      national: raw.national || {},
      departements: raw.departements || [],
      communes: records.length,
      builtAt: nowIso(),
      source: 'Etalab geo-dvf (data.gouv.fr) — Demandes de valeurs foncières',
      note: 'Alsace-Moselle (57,67,68) et Mayotte (976) absents du DVF (droit local).',
    },
  };
}
