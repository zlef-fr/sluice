// Per-source refresh scheduler. Each source gets its own timer at its declared
// interval. On boot, a source is refreshed immediately only if its cached feed
// is missing or older than its interval (so restarts don't re-hammer upstreams).
import { allDescriptors, getStatus, getFeed } from './store.js';
import { refreshSource } from './fetcher.js';

const timers = new Map();
// id → epoch ms of the next scheduled tick. Kept alongside the timer because a
// Node timer will not tell you when it fires, and "when does this run again" is
// the first thing anyone watching an ETL asks. A manual refresh deliberately
// does NOT move it — the interval keeps its own rhythm.
const nextAt = new Map();

export function scheduleSource(descriptor) {
  unschedule(descriptor.id);
  const t = setInterval(() => {
    nextAt.set(descriptor.id, Date.now() + descriptor.refreshMs);
    refreshSource(descriptor, { trigger: 'schedule' });
  }, descriptor.refreshMs);
  t.unref?.();
  timers.set(descriptor.id, t);
  nextAt.set(descriptor.id, Date.now() + descriptor.refreshMs);
}

export function unschedule(id) {
  const t = timers.get(id);
  if (t) clearInterval(t);
  timers.delete(id);
  nextAt.delete(id);
}

/** When this source's timer fires next, as an ISO string (null if unscheduled). */
export function nextRunAt(id) {
  const at = nextAt.get(id);
  return at ? new Date(at).toISOString() : null;
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
      setTimeout(() => refreshSource(d, { trigger: 'boot' }), delay);
      delay += 1500; // stagger upstream hits by 1.5s
    }
  }
  console.log(`[sluice] scheduled ${list.length} source(s); ${delay / 1500} due for refresh`);
}
