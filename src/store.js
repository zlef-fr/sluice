// Persistence layer. The registry (source descriptors) lives in one JSON file;
// each feed's fetched payload lives in its own file under feeds/ (payloads can be
// megabytes, so they're kept out of the registry and loaded lazily/kept warm in
// memory once fetched). Everything is plain JSON on disk — no DB dependency, so
// the whole service is `git clone && npm i && npm start`.
import { readFile, writeFile, mkdir, rename, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR, SOURCES_FILE, FEEDS_DIR } from './config.js';

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

async function atomicWrite(file, str) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, str);
  await rename(tmp, file);
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

async function persistRegistry() {
  const out = {
    version: 1,
    sources: [...sources.entries()].map(([id, descriptor]) => ({
      id,
      descriptor,
      status: status.get(id) || null,
    })),
  };
  await atomicWrite(SOURCES_FILE, JSON.stringify(out, null, 2));
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
export async function saveFeed(id, payload /* {data, meta} */) {
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
