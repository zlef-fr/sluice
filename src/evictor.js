// Byte eviction sweep for transient artifacts.
//
// A source can declare `options.ttl` ("don't keep these bytes longer than this").
// It is for build inputs: a 300 MB zip that one nightly pipeline unzips once has
// no business occupying disk for the other 23 hours. The version record survives
// the eviction — sha256, size, validators, probe key — so change detection and
// `/versions` keep working, and a request for the current version re-downloads it.
import { allDescriptors } from './store.js';
import { evictExpired } from './artifacts.js';
import { parseDuration } from './util.js';
import { ARTIFACT_TTL, EVICT_INTERVAL_MS } from './config.js';

function ttlFor(descriptor) {
  if (descriptor.adapter !== 'http-artifact') return 0;
  const raw = descriptor.options?.ttl ?? ARTIFACT_TTL;
  if (!raw) return 0;
  return parseDuration(raw) || 0;
}

export async function sweepEvictions() {
  let freed = 0;
  const touched = [];
  for (const d of allDescriptors()) {
    const ttl = ttlFor(d);
    if (!ttl) continue;
    const r = await evictExpired(d.id, ttl);
    if (r.freed) {
      freed += r.freed;
      touched.push(`${d.id} (${r.versions.join(', ')})`);
    }
  }
  if (freed) {
    console.log(`[sluice] evicted ${(freed / 1e6).toFixed(0)} MB of transient artifact bytes: ${touched.join('; ')}`);
  }
  return { freed, touched };
}

export function startEvictor() {
  sweepEvictions().catch((e) => console.error('[sluice] eviction sweep failed:', e.message));
  const t = setInterval(() => {
    sweepEvictions().catch((e) => console.error('[sluice] eviction sweep failed:', e.message));
  }, EVICT_INTERVAL_MS);
  t.unref?.();
  return t;
}
