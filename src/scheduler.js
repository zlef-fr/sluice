// Per-source refresh scheduler. Each source gets its own timer at its declared
// interval. On boot, a source is refreshed immediately only if its cached feed
// is missing or older than its interval (so restarts don't re-hammer upstreams).
import { allDescriptors, getStatus, getFeed } from './store.js';
import { refreshSource } from './fetcher.js';

const timers = new Map();

export function scheduleSource(descriptor) {
  unschedule(descriptor.id);
  const t = setInterval(() => {
    refreshSource(descriptor);
  }, descriptor.refreshMs);
  t.unref?.();
  timers.set(descriptor.id, t);
}

export function unschedule(id) {
  const t = timers.get(id);
  if (t) clearInterval(t);
  timers.delete(id);
}

// Decide whether a source needs an immediate refresh at boot.
async function isStale(descriptor) {
  const st = getStatus(descriptor.id);
  const feed = await getFeed(descriptor.id);
  if (!feed || !st || st.status !== 'ok' || !st.fetchedAt) return true;
  const age = Date.now() - new Date(st.fetchedAt).getTime();
  return age > descriptor.refreshMs;
}

// Boot: schedule everything, refresh the stale ones (staggered to be polite).
export async function bootScheduler() {
  const list = allDescriptors();
  let delay = 0;
  for (const d of list) {
    scheduleSource(d);
    if (await isStale(d)) {
      setTimeout(() => refreshSource(d), delay);
      delay += 1500; // stagger upstream hits by 1.5s
    }
  }
  console.log(`[sluice] scheduled ${list.length} source(s); ${delay / 1500} due for refresh`);
}
