// Business logic shared by the HTTP API and the MCP server, so both surfaces
// behave identically. Thin wrappers over store + registry + fetcher + scheduler.
import {
  allDescriptors, getDescriptor, getStatus, hasSource,
  putDescriptor, removeSource, getFeed,
} from './store.js';
import { normalizeDescriptor } from './registry.js';
import { refreshSource } from './fetcher.js';
import { scheduleSource, unschedule } from './scheduler.js';
import { toGeoJson } from './geojson.js';

// A compact, wire-safe view of a source (descriptor sans internals + status).
export function summarize(descriptor) {
  const st = getStatus(descriptor.id);
  return {
    id: descriptor.id,
    name: descriptor.name,
    description: descriptor.description,
    adapter: descriptor.adapter,
    transform: typeof descriptor.transform === 'string' ? descriptor.transform : 'map',
    refresh: descriptor.refresh,
    geo: !!(descriptor.geo && descriptor.geo.lat && descriptor.geo.lon),
    tags: descriptor.tags,
    license: descriptor.license,
    homepage: descriptor.homepage,
    attribution: descriptor.attribution,
    owner: descriptor.owner,
    createdAt: descriptor.createdAt,
    feedUrl: `/api/feed/${descriptor.id}`,
    status: st
      ? {
          state: st.status,
          fetchedAt: st.fetchedAt || null,
          checkedAt: st.checkedAt || st.fetchedAt || null,
          itemCount: st.itemCount ?? null,
          error: st.error || null,
        }
      : { state: 'pending', fetchedAt: null, checkedAt: null, itemCount: null, error: null },
  };
}

export function listSources() {
  return allDescriptors().map(summarize);
}

export function getSource(id) {
  const d = getDescriptor(id);
  return d ? summarize(d) : null;
}

// Register or update a source. Returns {ok, source} or {ok:false, error}.
export async function registerSource(input, { owner } = {}) {
  const norm = normalizeDescriptor(input, { owner });
  if (!norm.ok) return norm;
  await putDescriptor(norm.descriptor);
  scheduleSource(norm.descriptor);
  // Kick off the first fetch in the background; caller doesn't wait on upstream.
  refreshSource(norm.descriptor);
  return { ok: true, source: summarize(norm.descriptor) };
}

export async function deleteSource(id) {
  if (!hasSource(id)) return false;
  unschedule(id);
  await removeSource(id);
  return true;
}

// Force a refresh and wait for it. Returns {ok, status} or null if unknown id.
export async function refreshNow(id) {
  const d = getDescriptor(id);
  if (!d) return null;
  const r = await refreshSource(d);
  return { ...r, source: summarize(d) };
}

export async function feedPayload(id) {
  if (!hasSource(id)) return null;
  return getFeed(id); // {id, fetchedAt, itemCount, meta, data} or null
}

export async function feedMeta(id) {
  const f = await feedPayload(id);
  if (!f) return null;
  return { id, fetchedAt: f.fetchedAt, itemCount: f.itemCount, meta: f.meta };
}

export async function feedGeoJson(id) {
  const d = getDescriptor(id);
  if (!d) return { error: 'unknown source' };
  const f = await getFeed(id);
  if (!f) return { error: 'feed not fetched yet' };
  const gj = toGeoJson(d, f);
  if (!gj) return { error: 'source has no geo mapping (descriptor.geo)' };
  return { geojson: gj };
}
