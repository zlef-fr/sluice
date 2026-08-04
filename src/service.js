// Business logic shared by the HTTP API and the MCP server, so both surfaces
// behave identically. Thin wrappers over store + registry + fetcher + scheduler.
import {
  allDescriptors, getDescriptor, getStatus, hasSource,
  putDescriptor, removeSource, getFeed,
} from './store.js';
import { normalizeDescriptor } from './registry.js';
import { refreshSource } from './fetcher.js';
import { scheduleSource, unschedule, nextRunAt } from './scheduler.js';
import { sourceRuns, recentRuns, runStats, forgetRuns } from './runs.js';
import { toGeoJson } from './geojson.js';

// A compact, wire-safe view of a source (descriptor sans internals + status).
export function summarize(descriptor) {
  const st = getStatus(descriptor.id);
  // A file source ("artifact") is consumed as bytes from /api/artifact; a record
  // source is consumed as JSON from /api/feed. Both keep version history.
  const isArtifact = descriptor.adapter === 'http-artifact';
  return {
    id: descriptor.id,
    kind: isArtifact ? 'artifact' : 'records',
    name: descriptor.name,
    description: descriptor.description,
    adapter: descriptor.adapter,
    transform: typeof descriptor.transform === 'string' ? descriptor.transform : 'map',
    refresh: descriptor.refresh,
    refreshMs: descriptor.refreshMs,
    // When the timer fires next, and whether the data we hold has already
    // outlived the interval it promised (an upstream that 502s all night leaves
    // a green "ok" status pointing at yesterday's bytes).
    nextRunAt: nextRunAt(descriptor.id),
    stale: isStale(descriptor, st),
    geo: !!(descriptor.geo && descriptor.geo.lat && descriptor.geo.lon),
    tags: descriptor.tags,
    license: descriptor.license,
    homepage: descriptor.homepage,
    attribution: descriptor.attribution,
    owner: descriptor.owner,
    createdAt: descriptor.createdAt,
    feedUrl: `/api/feed/${descriptor.id}`,
    artifactUrl: isArtifact ? `/api/artifact/${descriptor.id}` : null,
    versionsUrl: isArtifact
      ? `/api/artifact/${descriptor.id}/versions`
      : `/api/archive/${descriptor.id}/versions`,
    status: st
      ? {
          state: st.status,
          fetchedAt: st.fetchedAt || null,
          checkedAt: st.checkedAt || st.fetchedAt || null,
          itemCount: st.itemCount ?? null,
          version: st.version || null,
          bytes: st.bytes ?? null,
          storedBytes: st.storedBytes ?? null,
          durationMs: st.durationMs ?? null,
          lastErrorAt: st.lastErrorAt || null,
          unchanged: st.unchanged ?? null,
          error: st.error || null,
        }
      : {
          state: 'pending', fetchedAt: null, checkedAt: null, itemCount: null,
          version: null, bytes: null, storedBytes: null, durationMs: null,
          lastErrorAt: null, unchanged: null, error: null,
        },
    // Rolling health over the kept run history — one green fetch says nothing
    // about a source that fails half the time.
    history: runStats(descriptor.id),
  };
}

/**
 * True when we have not managed to VERIFY this source against upstream for
 * longer than its own interval (with a grace period, so a slow fetch isn't
 * reported as late).
 *
 * Measured on `checkedAt`, not `fetchedAt`: an artifact keeps the fetchedAt of
 * the version it holds, so a monthly bulk that legitimately hasn't changed
 * since March would read as stale forever. What matters is whether the last
 * CHECK succeeded — a failing source stops advancing checkedAt, which is
 * exactly when "still serving old bytes" becomes true.
 */
function isStale(descriptor, st) {
  if (!st) return true;
  const last = st.checkedAt || st.fetchedAt;
  if (!last) return true;
  const age = Date.now() - new Date(last).getTime();
  return age > descriptor.refreshMs * 1.5;
}

export function listSources() {
  return allDescriptors().map(summarize);
}

export function getSource(id) {
  const d = getDescriptor(id);
  return d ? summarize(d) : null;
}

// True when re-registering would change nothing about how the source is fetched.
// (createdAt/owner are bookkeeping, not fetch inputs.)
function sameFetchContract(a, b) {
  if (!a || !b) return false;
  const strip = ({ createdAt, owner, ...rest }) => JSON.stringify(rest);
  return strip(a) === strip(b);
}

// Register or update a source. Returns {ok, source} or {ok:false, error}.
export async function registerSource(input, { owner } = {}) {
  const norm = normalizeDescriptor(input, { owner });
  if (!norm.ok) return norm;
  const existing = getDescriptor(norm.descriptor.id);
  const st = getStatus(norm.descriptor.id);
  // Re-registering an identical descriptor is a no-op, not a reason to poke the
  // upstream: consumers call register-then-pull on every build, so triggering a
  // fetch here would probe every source on every pipeline run. Only fetch when
  // something about the contract changed, or the current data is older than its
  // own interval.
  const fresh =
    st?.status === 'ok' &&
    st.checkedAt &&
    Date.now() - new Date(st.checkedAt).getTime() < norm.descriptor.refreshMs;
  const skipFetch = sameFetchContract(existing, norm.descriptor) && fresh;

  await putDescriptor(norm.descriptor);
  scheduleSource(norm.descriptor);
  // Kick off the first fetch in the background; caller doesn't wait on upstream.
  if (!skipFetch) refreshSource(norm.descriptor, { trigger: 'register' });
  return { ok: true, source: summarize(norm.descriptor) };
}

export async function deleteSource(id) {
  if (!hasSource(id)) return false;
  unschedule(id);
  forgetRuns(id);
  await removeSource(id);
  return true;
}

// Force a refresh and wait for it. Returns {ok, status} or null if unknown id.
// `force` additionally skips every not-modified shortcut — used when the bytes of
// an artifact were evicted and a consumer needs them back.
export async function refreshNow(id, { force = false, trigger = 'manual' } = {}) {
  const d = getDescriptor(id);
  if (!d) return null;
  const r = await refreshSource(d, { force, trigger });
  return { ...r, source: summarize(d) };
}

// ── run history ─────────────────────────────────────────────────────────────
export function sourceHistory(id, limit) {
  if (!hasSource(id)) return null;
  return { id, runs: sourceRuns(id, limit), stats: runStats(id) };
}

export function fleetHistory(opts) {
  return recentRuns(opts);
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
