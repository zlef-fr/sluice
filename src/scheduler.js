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

// Node stores a timer delay in a SIGNED 32-BIT int: anything above ~24.8 days
// silently becomes **1 ms**. `refresh: "30d"` (the artifact sources) therefore
// did not fire monthly — it fired continuously, re-probing data.gouv.fr several
// times a second, for as long as the process was up. Long intervals are waited
// out in chunks instead, re-arming until the due date actually arrives.
const MAX_DELAY = 2 ** 31 - 1;

function arm(descriptor, dueAt) {
  const id = descriptor.id;
  const t = setTimeout(() => {
    // Woke up early because the wait was longer than one timer can hold — go
    // back to sleep for the next chunk rather than refreshing now.
    if (Date.now() < dueAt - 50) { arm(descriptor, dueAt); return; }
    const next = Date.now() + descriptor.refreshMs;
    nextAt.set(id, next);
    arm(descriptor, next);
    refreshSource(descriptor, { trigger: 'schedule' });
  }, Math.max(0, Math.min(MAX_DELAY, dueAt - Date.now())));
  t.unref?.();
  timers.set(id, t);
}

export function scheduleSource(descriptor) {
  unschedule(descriptor.id);
  // A frozen data set (refresh: "never") gets no timer at all — a closed budget
  // year does not need to be asked about every month.
  if (descriptor.frozen || !descriptor.refreshMs) return;
  const due = Date.now() + descriptor.refreshMs;
  nextAt.set(descriptor.id, due);
  arm(descriptor, due);
}

export function unschedule(id) {
  const t = timers.get(id);
  if (t) clearTimeout(t);
  timers.delete(id);
  nextAt.delete(id);
}

/** When this source's timer fires next, as an ISO string (null if unscheduled). */
export function nextRunAt(id) {
  const at = nextAt.get(id);
  return at ? new Date(at).toISOString() : null;
}

// Decide whether a source needs an immediate refresh at boot. A frozen one is
// due only while we have never successfully fetched it — after that, never.
async function isStale(descriptor) {
  const st = getStatus(descriptor.id);
  const feed = await getFeed(descriptor.id);
  // A frozen data set we already hold is done, WHATEVER its last check said. It
  // matters for a source frozen by hand after its upstream went away (an archive
  // capture now answering 503): the freeze exists to stop asking, and a boot that
  // re-asked anyway would put the error straight back every restart.
  if (descriptor.frozen) return !feed;
  if (!feed || !st || st.status !== 'ok' || !st.fetchedAt) return true;
  if (!descriptor.refreshMs) return false;
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
