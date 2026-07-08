// Turns dashboard state into Sluice /api/explore query strings and fetches.
// Same-origin (the SPA is served by Sluice), so plain relative URLs.

// Build the shared filter params from state (search + term facets + ranges).
function filterParams(state, config) {
  const p = new URLSearchParams();
  if (state.q) {
    p.set('q', state.q);
    const sf = config.search?.fields || [];
    if (sf.length) p.set('qf', sf.join(','));
  }
  for (const field in state.eq) {
    const vals = [...state.eq[field]];
    if (vals.length) p.set('eq.' + field, vals.join(','));
  }
  for (const field in state.min) if (state.min[field] !== '' && state.min[field] != null) p.set('min.' + field, state.min[field]);
  for (const field in state.max) if (state.max[field] !== '' && state.max[field] != null) p.set('max.' + field, state.max[field]);
  return p;
}

export function exploreParams(state, config) {
  const p = filterParams(state, config);
  const facets = (config.facets || []).map((f) => f.field);
  const stats = (config.metrics || []).map((m) => m.field);
  if (facets.length) p.set('facets', facets.join(','));
  if (stats.length) p.set('stats', stats.join(','));
  if (state.sort?.field) p.set('sort', (state.sort.dir < 0 ? '-' : '') + state.sort.field);
  p.set('page', state.page || 1);
  p.set('pageSize', state.pageSize || 50);
  return p;
}

export async function fetchExplore(state, config, signal) {
  const r = await fetch(`/api/explore/${encodeURIComponent(config.feed)}?${exploreParams(state, config)}`, { signal });
  if (!r.ok) throw new Error('explore ' + r.status);
  return r.json();
}

export async function fetchPoints(state, config, signal) {
  if (!config.map) return null;
  const p = filterParams(state, config);
  p.set('lat', config.map.lat);
  p.set('lon', config.map.lon);
  if (config.map.colorBy) p.set('color', config.map.colorBy);
  p.set('idField', config.idField || 'id');
  const r = await fetch(`/api/explore/${encodeURIComponent(config.feed)}/points?${p}`, { signal });
  if (!r.ok) throw new Error('points ' + r.status);
  return r.json();
}

export async function fetchRecord(feed, id, idField) {
  const r = await fetch(`/api/explore/${encodeURIComponent(feed)}/record/${encodeURIComponent(id)}?idField=${encodeURIComponent(idField || 'id')}`);
  if (!r.ok) return null;
  return (await r.json()).record;
}
