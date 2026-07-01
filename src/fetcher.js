// The refresh pipeline for one source: adapter (fetch+parse) → transform
// (normalize) → store (persist feed + status). Never throws to the caller;
// records the error in status instead, so one broken upstream can't take down
// the scheduler or the API.
import { getAdapter } from './adapters/index.js';
import { runTransform } from './transforms/index.js';
import { saveFeed, setStatus, getStatus } from './store.js';
import { nowIso } from './util.js';

// in-flight guard so concurrent triggers (scheduler + manual) don't double-fetch
const inFlight = new Map();

export function refreshSource(descriptor) {
  const id = descriptor.id;
  if (inFlight.has(id)) return inFlight.get(id);
  const p = doRefresh(descriptor).finally(() => inFlight.delete(id));
  inFlight.set(id, p);
  return p;
}

async function doRefresh(descriptor) {
  const started = Date.now();
  const id = descriptor.id;
  try {
    const adapter = getAdapter(descriptor.adapter);
    if (!adapter) throw new Error(`no adapter "${descriptor.adapter}"`);

    const { records, bytes = 0, raw } = await adapter(descriptor);
    const { data, meta } = await runTransform(descriptor, records, { raw });
    if (!Array.isArray(data)) throw new Error('transform did not return an array `data`');

    const payload = {
      id,
      fetchedAt: nowIso(),
      itemCount: data.length,
      meta: meta || { count: data.length },
      data,
    };
    await saveFeed(id, payload);

    const status = {
      status: 'ok',
      fetchedAt: payload.fetchedAt,
      itemCount: data.length,
      bytes,
      durationMs: Date.now() - started,
      error: null,
    };
    await setStatus(id, status);
    console.log(`[sluice] ${id}: ok — ${data.length} items in ${status.durationMs}ms`);
    return { ok: true, status };
  } catch (e) {
    const status = {
      status: 'error',
      fetchedAt: getExistingFetchedAt(id),
      lastErrorAt: nowIso(),
      error: e.message || String(e),
      durationMs: Date.now() - started,
    };
    await setStatus(id, status);
    console.error(`[sluice] ${id}: FAILED — ${status.error}`);
    return { ok: false, status };
  }
}

// Preserve the last successful fetchedAt on error, if any.
function getExistingFetchedAt(id) {
  const st = getStatus(id);
  return st && st.status === 'ok' ? st.fetchedAt : (st?.fetchedAt || null);
}
