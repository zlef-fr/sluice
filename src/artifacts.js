// Versioned store for FILE artifacts — the raw bytes of an upstream download
// (a zip, a 700 MB bulk CSV export) rather than a parsed record set.
//
// Why this exists next to feeds/: some upstreams are not row streams a transform
// can normalize, they are build inputs. A pipeline wants the file, byte for byte,
// and wants yesterday's copy still around when today's upstream publishes garbage.
//
// Layout (one directory per source, one subdirectory per version):
//   artifacts/<id>/index.json                    { latest, versions:[record…] }
//   artifacts/<id>/<version>/<filename>[.gz]     the bytes
//
// A version is created ONLY when the content hash changes, so a daily refresh of
// a quarterly dataset does not rotate anything. Retention keeps the current
// version plus ARCHIVE_KEEP superseded ones and deletes the rest.
import { mkdir, readFile, writeFile, rename, rm, readdir, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createGzip, createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { Readable } from 'node:stream';
import { join, basename } from 'node:path';
import { ARTIFACTS_DIR, ARCHIVE_KEEP, LARGE_ARTIFACT_BYTES } from './config.js';

// Extensions whose bytes are already compressed — gzipping them again costs CPU
// and gains nothing (a .zip typically grows).
const PRECOMPRESSED = new Set([
  'gz', 'gzip', 'zip', 'bz2', 'xz', 'zst', '7z', 'rar',
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'mp3', 'mp4', 'webm', 'ogg', 'pdf',
]);

export function shouldCompress(filename, mode = 'auto') {
  if (mode === true || mode === 'always') return true;
  if (mode === false || mode === 'never') return false;
  const ext = String(filename || '').split('.').pop().toLowerCase();
  return !PRECOMPRESSED.has(ext);
}

// Sortable, filename-safe version id: 20260730T124500Z
export function versionId(iso = new Date().toISOString()) {
  return iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

// Exactly what versionId() emits. Version ids arrive as URL path segments and are
// used to build file paths, so anything else must be rejected rather than joined.
export function isVersionId(v) {
  return typeof v === 'string' && /^\d{8}T\d{6}Z$/.test(v);
}

function dirFor(id) {
  return join(ARTIFACTS_DIR, id);
}

function indexFile(id) {
  return join(dirFor(id), 'index.json');
}

// Unique temp name per write — see the same note in store.js: a shared
// `<file>.tmp` loses a race between two concurrent writers.
let writeSeq = 0;
async function atomicWrite(file, str) {
  const tmp = `${file}.${process.pid}.${++writeSeq}.tmp`;
  try {
    await writeFile(tmp, str);
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

// ── index ───────────────────────────────────────────────────────────────────
const EMPTY = { version: 1, latest: null, versions: [] };

export async function getIndex(id) {
  try {
    const idx = JSON.parse(await readFile(indexFile(id), 'utf8'));
    return { ...EMPTY, ...idx, versions: idx.versions || [] };
  } catch {
    return { ...EMPTY };
  }
}

// The record for one version: 'latest' (default) or an explicit version id.
export async function resolveVersion(id, wanted = 'latest') {
  const idx = await getIndex(id);
  if (!idx.versions.length) return null;
  if (!wanted || wanted === 'latest') {
    return idx.versions.find((v) => v.version === idx.latest) || idx.versions[0];
  }
  return idx.versions.find((v) => v.version === wanted) || null;
}

export async function latestRecord(id) {
  return resolveVersion(id, 'latest');
}

// Absolute path of the stored bytes for a version record.
export function pathFor(id, rec) {
  return join(dirFor(id), rec.version, rec.stored);
}

// ── download ────────────────────────────────────────────────────────────────
// Stream a fetch Response body to a temp file while hashing the ORIGINAL bytes,
// optionally gzipping on the way to disk. Returns what saveArtifact needs.
export async function streamToStaging(id, res, { filename, compress = 'auto' } = {}) {
  const stagingDir = join(dirFor(id), '.staging');
  await mkdir(stagingDir, { recursive: true });

  const gz = shouldCompress(filename, compress);
  const stored = gz ? `${filename}.gz` : filename;
  const tmpPath = join(stagingDir, `${versionId()}-${stored}`);

  const hash = createHash('sha256');
  let bytes = 0;
  const meter = new Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length;
      hash.update(chunk);
      cb(null, chunk);
    },
  });

  const steps = [Readable.fromWeb(res.body), meter];
  if (gz) steps.push(createGzip({ level: 6 }));
  steps.push(createWriteStream(tmpPath));
  try {
    await pipeline(...steps);
  } catch (e) {
    await rm(tmpPath, { force: true });
    throw e;
  }

  const { size: storedBytes } = await stat(tmpPath);
  return {
    tmpPath,
    stored,
    filename,
    bytes,
    storedBytes,
    encoding: gz ? 'gzip' : 'identity',
    sha256: hash.digest('hex'),
  };
}

// Promote a staged download to a real version, then apply retention.
// Returns { record, index, pruned:[versionId…] }.
export async function saveArtifact(id, staged, extra = {}) {
  const version = versionId(extra.fetchedAt);
  const dir = join(dirFor(id), version);
  await mkdir(dir, { recursive: true });
  await rename(staged.tmpPath, join(dir, staged.stored));

  const record = {
    version,
    fetchedAt: extra.fetchedAt || new Date().toISOString(),
    filename: staged.filename,
    stored: staged.stored,
    encoding: staged.encoding,
    bytes: staged.bytes,
    storedBytes: staged.storedBytes,
    sha256: staged.sha256,
    contentType: extra.contentType || 'application/octet-stream',
    url: extra.url || null,
    probeKey: extra.probeKey ?? null,
    validators: extra.validators || null,
  };

  const idx = await getIndex(id);
  // Newest first — the list order IS the retention order. An explicit
  // `options.keep` wins; otherwise a big artifact keeps no history (see
  // LARGE_ARTIFACT_BYTES) while a small one gets the standard latest + N.
  const limit = Number.isFinite(extra.keep)
    ? Math.max(0, extra.keep)
    : (staged.storedBytes > LARGE_ARTIFACT_BYTES ? 0 : ARCHIVE_KEEP);
  const versions = [record, ...idx.versions.filter((v) => v.version !== version)];
  const keep = versions.slice(0, limit + 1);
  const drop = versions.slice(limit + 1);

  const next = { ...EMPTY, latest: version, keep: limit, versions: keep };
  await atomicWrite(indexFile(id), JSON.stringify(next, null, 2));

  for (const v of drop) {
    await rm(join(dirFor(id), v.version), { recursive: true, force: true });
  }
  await rm(join(dirFor(id), '.staging'), { recursive: true, force: true });

  return { record, index: next, pruned: drop.map((v) => v.version) };
}

// Re-affirm the latest version without storing new bytes (upstream unchanged).
export async function touchArtifact(id, { checkedAt, probeKey, validators } = {}) {
  const idx = await getIndex(id);
  const cur = idx.versions.find((v) => v.version === idx.latest);
  if (!cur) return null;
  cur.checkedAt = checkedAt || new Date().toISOString();
  if (probeKey !== undefined) cur.probeKey = probeKey;
  if (validators) cur.validators = validators;
  await atomicWrite(indexFile(id), JSON.stringify(idx, null, 2));
  return cur;
}

export async function removeArtifacts(id) {
  await rm(dirFor(id), { recursive: true, force: true });
}

// ── byte eviction (transient artifacts) ─────────────────────────────────────
// A build input worth hundreds of MB doesn't need to sit on disk between nightly
// builds. With `options.ttl`, the BYTES are deleted once they're older than the
// TTL while the version record — id, sha256, size, validators, probe key — stays.
// So change detection keeps working, `/versions` still tells the whole history,
// and a consumer asking for evicted bytes triggers one fresh download.
export async function evictExpired(id, ttlMs, { now = Date.now() } = {}) {
  if (!ttlMs) return { freed: 0, versions: [] };
  const idx = await getIndex(id);
  let freed = 0;
  const hit = [];
  for (const v of idx.versions) {
    if (v.evicted) continue;
    if (now - new Date(v.fetchedAt).getTime() < ttlMs) continue;
    await rm(join(dirFor(id), v.version), { recursive: true, force: true });
    v.evicted = true;
    v.evictedAt = new Date(now).toISOString();
    freed += v.storedBytes || 0;
    hit.push(v.version);
  }
  if (hit.length) await atomicWrite(indexFile(id), JSON.stringify(idx, null, 2));
  return { freed, versions: hit };
}

// Re-attach freshly downloaded bytes to an existing version whose bytes were
// evicted — same content (sha matches), so it must NOT become a new version.
export async function restoreArtifact(id, version, staged) {
  const idx = await getIndex(id);
  const rec = idx.versions.find((v) => v.version === version);
  if (!rec) return null;
  const dir = join(dirFor(id), version);
  await mkdir(dir, { recursive: true });
  await rename(staged.tmpPath, join(dir, staged.stored));
  rec.stored = staged.stored;
  rec.encoding = staged.encoding;
  rec.storedBytes = staged.storedBytes;
  delete rec.evicted;
  delete rec.evictedAt;
  rec.restoredAt = new Date().toISOString();
  await atomicWrite(indexFile(id), JSON.stringify(idx, null, 2));
  await rm(join(dirFor(id), '.staging'), { recursive: true, force: true });
  return rec;
}

// Do we currently hold the bytes of this version?
export function hasBytes(rec) {
  return !!rec && !rec.evicted;
}

// Bytes on disk for one source, all versions (for the /api/sources report).
export async function diskUsage(id) {
  const idx = await getIndex(id);
  return idx.versions.reduce((n, v) => n + (v.storedBytes || 0), 0);
}

// A readable stream of the ORIGINAL bytes (transparently gunzipping storage).
// `raw:true` hands back stored bytes untouched, for a byte-for-byte mirror.
export function readArtifact(id, rec, { raw = false } = {}) {
  const src = createReadStream(pathFor(id, rec));
  if (raw || rec.encoding !== 'gzip') return src;
  const gunzip = createGunzip();
  // Surface a read error on the stream the caller is piping.
  src.on('error', (e) => gunzip.destroy(e));
  return src.pipe(gunzip);
}

// Public-facing view of the index (drops absolute paths, adds URLs).
export function summarizeIndex(id, idx) {
  return {
    id,
    kind: 'artifact',
    latest: idx.latest,
    keep: Number.isFinite(idx.keep) ? idx.keep : ARCHIVE_KEEP,
    versions: idx.versions.map((v) => ({
      version: v.version,
      fetchedAt: v.fetchedAt,
      checkedAt: v.checkedAt || v.fetchedAt,
      filename: v.filename,
      bytes: v.bytes,
      storedBytes: v.evicted ? 0 : v.storedBytes,
      encoding: v.encoding,
      sha256: v.sha256,
      contentType: v.contentType,
      current: v.version === idx.latest,
      // Bytes evicted to keep the disk small; identity kept. A request for the
      // current version re-downloads it, an older one is upstream-only.
      evicted: !!v.evicted,
      url: `/api/artifact/${id}/${v.version}`,
    })),
  };
}

// Drop version directories the index no longer references (crash cleanup).
export async function reconcile(id) {
  const idx = await getIndex(id);
  const known = new Set(idx.versions.map((v) => v.version));
  let removed = 0;
  try {
    for (const entry of await readdir(dirFor(id), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === '.staging' || !known.has(entry.name)) {
        await rm(join(dirFor(id), entry.name), { recursive: true, force: true });
        removed++;
      }
    }
  } catch {
    /* no artifact dir yet */
  }
  return removed;
}

export { basename };
