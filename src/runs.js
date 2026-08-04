// Run history — what actually happened, refresh after refresh.
//
// `status` only ever holds the LAST outcome of a source, which answers "is it ok
// right now" and nothing else: a source that fails every other night, one that
// silently returns 0 records since Tuesday, or an upstream that got 40× slower
// all look identical to a green status line. A run log is the difference between
// a state and a history, and it is what an operator watches an ETL through.
//
// Bounded on purpose: N runs per source, one JSON file, written atomically and
// debounced (a fleet of 46 sources refreshing at boot would otherwise persist 46
// times in a second).
import { readFile } from 'node:fs/promises';
import { RUNS_FILE, RUN_KEEP } from './config.js';
import { atomicWrite } from './store.js';

// id → [run] , newest FIRST (the readers all want the recent end)
const runs = new Map();

export async function loadRuns() {
  try {
    const raw = JSON.parse(await readFile(RUNS_FILE, 'utf8'));
    for (const [id, list] of Object.entries(raw.runs || {})) {
      if (Array.isArray(list)) runs.set(id, list.slice(0, RUN_KEEP));
    }
  } catch {
    /* no history yet — first boot, or the file was wiped with the data dir */
  }
}

let pending = null;
function persistSoon() {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    const out = {};
    for (const [id, list] of runs) out[id] = list;
    atomicWrite(RUNS_FILE, JSON.stringify({ runs: out })).catch((e) => {
      console.error(`[sluice] could not persist run history: ${e.message}`);
    });
  }, 2000);
  pending.unref?.();
}

/**
 * Record one refresh. `result` is what the fetcher returned ({ok, status,
 * unchanged}); everything displayable is flattened here so a reader never has to
 * know the difference between a record feed and an artifact.
 */
export function recordRun(id, result, { startedAt, trigger = 'schedule' } = {}) {
  const st = (result && result.status) || {};
  const run = {
    at: startedAt || new Date().toISOString(),
    ok: !!(result && result.ok),
    unchanged: !!st.unchanged,
    trigger,
    durationMs: st.durationMs ?? null,
    itemCount: st.itemCount ?? null,
    bytes: st.bytes ?? null,
    version: st.version || null,
    error: st.error || null,
  };
  const list = runs.get(id) || [];
  list.unshift(run);
  if (list.length > RUN_KEEP) list.length = RUN_KEEP;
  runs.set(id, list);
  persistSoon();
  return run;
}

export function sourceRuns(id, limit = RUN_KEEP) {
  const list = runs.get(id) || [];
  return list.slice(0, Math.max(1, Math.min(RUN_KEEP, Number(limit) || RUN_KEEP)));
}

/**
 * The fleet's activity, newest first — one timeline across every source, which is
 * how you notice that four unrelated feeds all started failing at 04:00.
 */
export function recentRuns({ limit = 50, id = null, failedOnly = false } = {}) {
  const lim = Math.max(1, Math.min(500, Number(limit) || 50));
  const out = [];
  for (const [sourceId, list] of runs) {
    if (id && sourceId !== id) continue;
    for (const r of list) {
      if (failedOnly && r.ok) continue;
      out.push({ id: sourceId, ...r });
    }
  }
  out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return out.slice(0, lim);
}

/** Rolling health of one source: how the last N runs went. */
export function runStats(id) {
  const list = runs.get(id) || [];
  if (!list.length) return { runs: 0, failed: 0, changed: 0, avgMs: null, lastOkAt: null, lastFailAt: null };
  let failed = 0; let changed = 0; let ms = 0; let msN = 0;
  let lastOkAt = null; let lastFailAt = null;
  for (const r of list) {
    if (r.ok) { if (!lastOkAt) lastOkAt = r.at; } else { failed++; if (!lastFailAt) lastFailAt = r.at; }
    if (r.ok && !r.unchanged) changed++;
    if (typeof r.durationMs === 'number') { ms += r.durationMs; msN++; }
  }
  return {
    runs: list.length, failed, changed,
    avgMs: msN ? Math.round(ms / msN) : null,
    lastOkAt, lastFailAt,
  };
}

export function forgetRuns(id) {
  if (!runs.delete(id)) return;
  persistSoon();
}
