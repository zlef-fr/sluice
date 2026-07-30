// /api/artifact — the consumption surface for FILE sources, and /api/archive for
// superseded record-feed snapshots. Both are "give me this data set as it was at
// version X"; a build pipeline pulls from here instead of hammering upstream.
import { Router } from 'express';
import { requireRead } from '../auth.js';
import { hasSource } from '../store.js';
import { listFeedArchives, readFeedArchive } from '../store.js';
import { getIndex, resolveVersion, readArtifact, summarizeIndex, isVersionId, hasBytes } from '../artifacts.js';
import { refreshNow } from '../service.js';

const artifactRouter = Router();

async function sendArtifact(req, res, id, wanted) {
  if (!hasSource(id)) return res.status(404).json({ error: 'unknown source' });
  // resolveVersion only ever returns records from our own index, but reject a
  // malformed version here too so nothing downstream sees a path-ish string.
  if (wanted && wanted !== 'latest' && !isVersionId(wanted)) {
    return res.status(400).json({ error: 'malformed version (expected e.g. 20260730T041500Z)' });
  }
  let rec = await resolveVersion(id, wanted);
  if (!rec) {
    return res.status(wanted && wanted !== 'latest' ? 404 : 503).json({
      error: wanted && wanted !== 'latest' ? 'unknown version' : 'artifact not fetched yet, retry shortly',
    });
  }

  // Bytes evicted to keep the disk small (options.ttl). For the current version we
  // fetch them again now — the caller is a build pipeline, it can wait — and the
  // download re-attaches to this same version if the content is still identical.
  if (!hasBytes(rec)) {
    const isCurrent = rec.version === (await getIndex(id)).latest;
    if (!isCurrent) {
      return res.status(410).json({
        error: 'this version\'s bytes were evicted to save disk; only its metadata is kept',
        version: rec.version,
        sha256: rec.sha256,
      });
    }
    await refreshNow(id, { force: true });
    rec = await resolveVersion(id, 'latest');
    if (!rec || !hasBytes(rec)) {
      return res.status(502).json({ error: 'could not re-download the evicted artifact from upstream' });
    }
  }

  // ?raw=1 hands back exactly what is on disk (gzipped if stored gzipped), for a
  // byte-for-byte mirror; the default decompresses so `curl -o file` just works.
  const raw = req.query.raw === '1' || req.query.raw === 'true';
  const etag = `"${rec.sha256}${raw ? '-raw' : ''}"`;
  res.set('ETag', etag);
  res.set('X-Sluice-Version', rec.version);
  res.set('X-Sluice-Sha256', rec.sha256);
  res.set('X-Sluice-Fetched-At', rec.fetchedAt);
  // An explicit version is immutable; "latest" must be revalidated.
  res.set('Cache-Control', wanted && wanted !== 'latest' ? 'public, max-age=31536000, immutable' : 'no-cache');
  if (req.get('if-none-match') === etag) return res.status(304).end();

  const name = raw ? rec.stored : rec.filename;
  res.set('Content-Type', raw && rec.encoding === 'gzip' ? 'application/gzip' : rec.contentType);
  res.set('Content-Disposition', `attachment; filename="${name.replace(/"/g, '')}"`);
  // Only the untouched form has a length we know up front.
  if (raw || rec.encoding !== 'gzip') res.set('Content-Length', String(raw ? rec.storedBytes : rec.bytes));
  if (req.method === 'HEAD') return res.end();

  const stream = readArtifact(id, rec, { raw });
  stream.on('error', (e) => {
    if (!res.headersSent) res.status(500).json({ error: `artifact read failed: ${e.message}` });
    else res.destroy(e);
  });
  stream.pipe(res);
}

// Version list first — otherwise "versions" is captured as a version id.
artifactRouter.get('/:id/versions', requireRead, async (req, res) => {
  const { id } = req.params;
  if (!hasSource(id)) return res.status(404).json({ error: 'unknown source' });
  const idx = await getIndex(id);
  res.set('Cache-Control', 'public, max-age=60');
  res.json(summarizeIndex(id, idx));
});

artifactRouter.get('/:id/:version', requireRead, (req, res) =>
  sendArtifact(req, res, req.params.id, req.params.version),
);

artifactRouter.get('/:id', requireRead, (req, res) =>
  sendArtifact(req, res, req.params.id, req.query.version || 'latest'),
);

// ── /api/archive — previous snapshots of a RECORD feed ──────────────────────
const archiveRouter = Router();

archiveRouter.get('/:id/versions', requireRead, async (req, res) => {
  const { id } = req.params;
  if (!hasSource(id)) return res.status(404).json({ error: 'unknown source' });
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ id, kind: 'records', archives: await listFeedArchives(id) });
});

archiveRouter.get('/:id/:version', requireRead, async (req, res) => {
  const { id, version } = req.params;
  if (!hasSource(id)) return res.status(404).json({ error: 'unknown source' });
  const wanted = version.replace(/\.json$/, '');
  if (!isVersionId(wanted)) {
    return res.status(400).json({ error: 'malformed version (expected e.g. 20260730T041500Z)' });
  }
  const stream = await readFeedArchive(id, wanted);
  if (!stream) return res.status(404).json({ error: 'unknown archive version' });
  res.set('Content-Type', 'application/json; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  stream.on('error', (e) => {
    if (!res.headersSent) res.status(500).json({ error: `archive read failed: ${e.message}` });
    else res.destroy(e);
  });
  stream.pipe(res);
});

archiveRouter.get('/:id', requireRead, async (req, res) => {
  const { id } = req.params;
  if (!hasSource(id)) return res.status(404).json({ error: 'unknown source' });
  res.json({ id, kind: 'records', archives: await listFeedArchives(id) });
});

export { artifactRouter, archiveRouter };
