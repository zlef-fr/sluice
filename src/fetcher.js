// The refresh pipeline for one source: adapter (fetch+parse) → transform
// (normalize) → store (persist feed + status). Never throws to the caller;
// records the error in status instead, so one broken upstream can't take down
// the scheduler or the API.
import { rm } from 'node:fs/promises';
import { getAdapter } from './adapters/index.js';
import { runTransform } from './transforms/index.js';
import { saveFeed, setStatus, getStatus, getFeed } from './store.js';
import { saveArtifact, touchArtifact, getIndex, summarizeIndex, restoreArtifact } from './artifacts.js';
import { recordRun } from './runs.js';
import { nowIso } from './util.js';

// in-flight guard so concurrent triggers (scheduler + manual) don't double-fetch
const inFlight = new Map();

export function refreshSource(descriptor, opts = {}) {
  const id = descriptor.id;
  // A forced refetch must not be answered by an in-flight normal refresh — that
  // one may legitimately conclude "unchanged" and leave the bytes missing.
  if (inFlight.has(id) && !opts.force) return inFlight.get(id);
  const startedAt = nowIso();
  // ONE place records history, because doRefresh has five successful exits (a
  // record feed, a new artifact, a 304, a restored eviction, a failure) and a
  // per-exit call is a per-exit chance to forget one. doRefresh never throws.
  const p = doRefresh(descriptor, opts)
    .then((r) => {
      recordRun(id, r, { startedAt, trigger: opts.trigger || 'manual' });
      return r;
    })
    .finally(() => {
      if (inFlight.get(id) === p) inFlight.delete(id);
    });
  inFlight.set(id, p);
  return p;
}

async function doRefresh(descriptor, opts = {}) {
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

    const out = await adapter(descriptor, { validators, force: !!opts.force });

    // Evicted bytes came back and the content is unchanged: re-attach them to the
    // version they belong to rather than minting a duplicate.
    if (out.restored) {
      const { version, ...staged } = out.restored;
      const rec = await restoreArtifact(id, version, staged);
      const idx = await getIndex(id);
      const summary = summarizeIndex(id, idx);
      await saveFeed(
        id,
        {
          id,
          fetchedAt: rec?.fetchedAt || nowIso(),
          itemCount: summary.versions.length,
          meta: { kind: 'artifact', latest: summary.latest, keep: summary.keep, current: rec },
          data: summary.versions,
        },
        { archive: false },
      );
      const status = {
        status: 'ok',
        kind: 'artifact',
        fetchedAt: rec?.fetchedAt || null,
        checkedAt: nowIso(),
        itemCount: summary.versions.length,
        bytes: rec?.bytes ?? null,
        storedBytes: rec?.storedBytes ?? null,
        version,
        sha256: rec?.sha256 || null,
        validators: out.validators || null,
        durationMs: Date.now() - started,
        unchanged: true,
        restored: true,
        error: null,
      };
      await setStatus(id, status);
      console.log(`[sluice] ${id}: re-downloaded evicted bytes of ${version} (unchanged) in ${status.durationMs}ms`);
      return { ok: true, status, unchanged: true };
    }

    // File artifacts are bytes, not records: they bypass the transform and land
    // in the versioned artifact store. The feed payload becomes the version
    // index, so /api/feed/:id still describes the source.
    if (out.artifact) {
      const fetchedAt = nowIso();
      const { record, index, pruned } = await saveArtifact(id, out.artifact, {
        fetchedAt,
        keep: out.artifact.keep,
        contentType: out.artifact.contentType,
        url: out.artifact.url,
        probeKey: out.artifact.probeKey,
        validators: out.artifact.validators,
      });
      const summary = summarizeIndex(id, index);
      await saveFeed(
        id,
        {
          id,
          fetchedAt,
          itemCount: summary.versions.length,
          meta: { kind: 'artifact', latest: summary.latest, keep: summary.keep, current: record },
          data: summary.versions,
        },
        { archive: false }, // the artifact store does its own versioning
      );
      const status = {
        status: 'ok',
        kind: 'artifact',
        fetchedAt,
        checkedAt: fetchedAt,
        itemCount: summary.versions.length,
        bytes: record.bytes,
        storedBytes: record.storedBytes,
        version: record.version,
        sha256: record.sha256,
        validators: out.validators || null,
        durationMs: Date.now() - started,
        unchanged: false,
        error: null,
      };
      await setStatus(id, status);
      console.log(
        `[sluice] ${id}: new artifact ${record.version} — ${fmtBytes(record.bytes)}` +
          `${record.encoding === 'gzip' ? ` (${fmtBytes(record.storedBytes)} stored)` : ''}` +
          ` in ${status.durationMs}ms${pruned.length ? `; pruned ${pruned.join(', ')}` : ''}`,
      );
      return { ok: true, status };
    }

    // Upstream unchanged → keep the cached feed, skip transform + re-download.
    if (out.notModified) {
      // An artifact adapter may have had to download to find out (no validators
      // upstream) — throw the identical copy away and just re-stamp the version.
      if (out.discard) await rm(out.discard, { force: true }).catch(() => {});
      const artifactIdx = await getIndex(id);
      if (artifactIdx.latest) {
        const cur = await touchArtifact(id, {
          checkedAt: nowIso(),
          probeKey: out.probeKey,
          validators: out.validators,
        });
        const status = {
          status: 'ok',
          kind: 'artifact',
          fetchedAt: cur?.fetchedAt || null,
          checkedAt: cur?.checkedAt || nowIso(),
          itemCount: artifactIdx.versions.length,
          bytes: cur?.bytes ?? null,
          storedBytes: cur?.storedBytes ?? null,
          version: artifactIdx.latest,
          sha256: cur?.sha256 || null,
          validators: out.validators || prev.validators || null,
          durationMs: Date.now() - started,
          unchanged: true,
          error: null,
        };
        await setStatus(id, status);
        console.log(
          `[sluice] ${id}: unchanged — kept artifact ${artifactIdx.latest} in ${status.durationMs}ms`,
        );
        return { ok: true, status, unchanged: true };
      }
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

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

// Preserve the last successful fetchedAt on error, if any.
function getExistingFetchedAt(id) {
  const st = getStatus(id);
  return st && st.status === 'ok' ? st.fetchedAt : (st?.fetchedAt || null);
}
