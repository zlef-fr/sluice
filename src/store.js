// Persistence layer. The registry (source descriptors) lives in one JSON file;
// each feed's fetched payload lives in its own file under feeds/ (payloads can be
// megabytes, so they're kept out of the registry and loaded lazily/kept warm in
// memory once fetched). Everything is plain JSON on disk — no DB dependency, so
// the whole service is `git clone && npm i && npm start`.
import { readFile, writeFile, mkdir, rename, readdir, rm, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createGzip, createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { DATA_DIR, SOURCES_FILE, FEEDS_DIR, ARCHIVE_DIR, ARCHIVE_KEEP } from './config.js';
import { versionId, removeArtifacts } from './artifacts.js';

// id → descriptor
const sources = new Map();
// id → { fetchedAt, status, error, itemCount, bytes, durationMs }  (status only)
const status = new Map();
// id → { data, meta }  (the warm in-memory payload; may be absent until loaded)
const feeds = new Map();

async function ensureDirs() {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(FEEDS_DIR, { recursive: true });
}

// Unique temp name per write: a shared `<file>.tmp` makes two concurrent writers
// race — both write the same path, the first rename wins and the second fails with
// ENOENT. That surfaced for real when 32 sources registered at once and each
// setStatus persisted the registry.
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

// Serialize registry persists so concurrent refreshes can't interleave writes of
// the same file (each write is atomic, but ordering should still be last-in-wins).
let persistChain = Promise.resolve();
function serialize(fn) {
  persistChain = persistChain.then(fn, fn);
  return persistChain;
}

function feedFile(id) {
  return join(FEEDS_DIR, `${id}.json`);
}

// ── registry ────────────────────────────────────────────────────────────────
export async function loadRegistry() {
  await ensureDirs();
  try {
    const raw = JSON.parse(await readFile(SOURCES_FILE, 'utf8'));
    for (const rec of raw.sources || []) {
      sources.set(rec.id, rec.descriptor);
      if (rec.status) status.set(rec.id, rec.status);
    }
  } catch {
    /* first boot — no registry yet */
  }
}

function persistRegistry() {
  return serialize(() => {
    const out = {
      version: 1,
      sources: [...sources.entries()].map(([id, descriptor]) => ({
        id,
        descriptor,
        status: status.get(id) || null,
      })),
    };
    return atomicWrite(SOURCES_FILE, JSON.stringify(out, null, 2));
  });
}

export function getDescriptor(id) {
  return sources.get(id) || null;
}

export function allDescriptors() {
  return [...sources.values()];
}

export function hasSource(id) {
  return sources.has(id);
}

export async function putDescriptor(descriptor) {
  sources.set(descriptor.id, descriptor);
  await persistRegistry();
}

export async function removeSource(id) {
  sources.delete(id);
  status.delete(id);
  feeds.delete(id);
  await persistRegistry();
  try {
    await atomicWrite(feedFile(id), JSON.stringify({ removed: true }));
  } catch {
    /* ignore */
  }
  // Deleting a source drops its history too — otherwise archives of a long-gone
  // id sit on disk forever with nothing referencing them.
  await rm(join(ARCHIVE_DIR, id), { recursive: true, force: true });
  await removeArtifacts(id);
}

// ── status ──────────────────────────────────────────────────────────────────
export function getStatus(id) {
  return status.get(id) || null;
}

export async function setStatus(id, st) {
  status.set(id, st);
  await persistRegistry();
}

// ── feed payloads ─────────────────────────────────────────────────────────────
// Rotate the snapshot a save is about to overwrite into archive/<id>/, gzipped,
// keeping at most ARCHIVE_KEEP of them (latest + 2 by default). Streamed, so a
// 14 MB feed rotates without being parsed or held in memory.
async function archiveCurrentFeed(id) {
  if (ARCHIVE_KEEP <= 0) return null;
  const src = feedFile(id);
  let stamp = feeds.get(id)?.fetchedAt;
  try {
    if (!stamp) stamp = (await stat(src)).mtime.toISOString();
  } catch {
    return null; // nothing to archive on first fetch
  }
  const dir = join(ARCHIVE_DIR, id);
  await mkdir(dir, { recursive: true });
  const dest = join(dir, `${versionId(stamp)}.json.gz`);
  try {
    await pipeline(createReadStream(src), createGzip({ level: 6 }), createWriteStream(dest));
  } catch {
    return null; // feed file vanished mid-rotation — not worth failing the refresh
  }
  // Filenames are compact ISO, so lexicographic order is chronological.
  const kept = (await readdir(dir)).filter((f) => f.endsWith('.json.gz')).sort().reverse();
  for (const stale of kept.slice(ARCHIVE_KEEP)) {
    await rm(join(dir, stale), { force: true });
  }
  return dest;
}

export async function listFeedArchives(id) {
  try {
    const dir = join(ARCHIVE_DIR, id);
    const files = (await readdir(dir)).filter((f) => f.endsWith('.json.gz')).sort().reverse();
    return Promise.all(
      files.map(async (f) => {
        const version = f.slice(0, -'.json.gz'.length);
        const { size } = await stat(join(dir, f));
        return { version, storedBytes: size, url: `/api/archive/${id}/${version}` };
      }),
    );
  } catch {
    return [];
  }
}

// Readable stream of an archived snapshot's JSON (gunzipped), or null.
export async function readFeedArchive(id, version) {
  const file = join(ARCHIVE_DIR, id, `${version}.json.gz`);
  try {
    await stat(file);
  } catch {
    return null;
  }
  const src = createReadStream(file);
  const gunzip = createGunzip();
  src.on('error', (e) => gunzip.destroy(e));
  return src.pipe(gunzip);
}

export async function saveFeed(id, payload /* {data, meta} */, { archive = true } = {}) {
  if (archive) await archiveCurrentFeed(id);
  feeds.set(id, payload);
  await atomicWrite(feedFile(id), JSON.stringify(payload));
}

// Return the warm copy, loading from disk on demand. null if never fetched.
export async function getFeed(id) {
  if (feeds.has(id)) return feeds.get(id);
  try {
    const p = JSON.parse(await readFile(feedFile(id), 'utf8'));
    if (p && !p.removed) {
      feeds.set(id, p);
      return p;
    }
  } catch {
    /* no cached feed */
  }
  return null;
}

// Warm every known feed into memory at boot (best-effort, so /feed is instant).
export async function warmFeeds() {
  try {
    const files = await readdir(FEEDS_DIR);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const id = f.slice(0, -5);
      if (sources.has(id)) await getFeed(id);
    }
  } catch {
    /* ignore */
  }
}
