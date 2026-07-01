// The refresh pipeline for one source: adapter (fetch+parse) → transform
// (normalize) → store (persist feed + status). Never throws to the caller;
// records the error in status instead, so one broken upstream can't take down
// the scheduler or the API.
import { getAdapter } from './adapters/index.js';
import { runTransform } from './transforms/index.js';
import { saveFeed, setStatus, getStatus, getFeed } from './store.js';
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

    // Only send conditional-GET validators if we still hold the feed they refer
    // to — so a 304 always has a cached payload to keep.
    const prev = getStatus(id) || {};
    const cached = await getFeed(id);
    const validators = prev.validators && cached && cached.fetchedAt ? prev.validators : null;

    const out = await adapter(descriptor, { validators });

    // Upstream unchanged → keep the cached feed, skip transform + re-download.
    if (out.notModified) {
      const status = {
        status: 'ok',
        fetchedAt: cached.fetchedAt,
        itemCount: cached.itemCount,
        bytes: prev.bytes || 0,
        validators: out.validators || validators,
        checkedAt: nowIso(),
        durationMs: Date.now() - started,
        unchanged: true,
        error: null,
      };
      await setStatus(id, status);
      console.log(`[sluice] ${id}: unchanged (304) — kept ${cached.itemCount} items in ${status.durationMs}ms`);
      return { ok: true, status, unchanged: true };
    }

    const { records, bytes = 0, raw, validators: newValidators } = out;
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
      validators: newValidators || null,
      checkedAt: payload.fetchedAt,
      durationMs: Date.now() - started,
      unchanged: false,
      error: null,
    };
    await setStatus(id, status);
    console.log(`[sluice] ${id}: ok — ${data.length} items in ${status.durationMs}ms`);
    return { ok: true, status };
  } catch (e) {
    const prev = getStatus(id) || {};
    const status = {
      status: 'error',
      fetchedAt: getExistingFetchedAt(id),
      itemCount: prev.itemCount ?? null,
      validators: prev.validators || null, // keep so we still get 304s next time
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
