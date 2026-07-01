// /api/feed — the consumption surface. This is what other services (essence,
// maps, …) actually pull. Feeds are cached server-side, so these are cheap and
// carry an ETag + short cache headers.
import { Router } from 'express';
import { requireRead } from '../auth.js';
import { feedPayload, feedMeta, feedGeoJson } from '../service.js';

const router = Router();

function etagFor(feed) {
  // fetchedAt + count is a stable, cheap validator for an immutable snapshot.
  return `"${feed.id}:${feed.fetchedAt}:${feed.itemCount}"`;
}

async function sendGeoJson(id, res) {
  const r = await feedGeoJson(id);
  if (r.error) return res.status(r.error === 'unknown source' ? 404 : 409).json(r);
  res.set('Cache-Control', 'public, max-age=300');
  res.set('Content-Type', 'application/geo+json');
  res.json(r.geojson);
}

// GeoJSON projection (maps.zlef.fr consumes this) — clean sub-path form.
router.get('/:id/geojson', requireRead, (req, res) => sendGeoJson(req.params.id, res));

// Just the metadata (small; good for polling "did it change?").
router.get('/:id/meta', requireRead, async (req, res) => {
  const m = await feedMeta(req.params.id);
  if (!m) return res.status(404).json({ error: 'unknown source or not fetched yet' });
  res.set('Cache-Control', 'public, max-age=120');
  res.json(m);
});

// Full feed: { id, fetchedAt, itemCount, meta, data }. Also serves the
// conventional `/:id.geojson` extension form (Express param captures the dot,
// so we branch on the suffix here rather than rely on a dotted route pattern).
router.get('/:id', requireRead, async (req, res) => {
  let id = req.params.id;
  if (id.endsWith('.geojson')) return sendGeoJson(id.slice(0, -'.geojson'.length), res);
  if (id.endsWith('.json')) id = id.slice(0, -'.json'.length);

  const feed = await feedPayload(id);
  if (feed === null) return res.status(404).json({ error: 'unknown source' });
  if (!feed.fetchedAt) return res.status(503).json({ error: 'feed not fetched yet, retry shortly' });
  const etag = etagFor(feed);
  res.set('Cache-Control', 'public, max-age=300');
  res.set('ETag', etag);
  if (req.get('if-none-match') === etag) return res.status(304).end();
  res.json(feed);
});

export default router;
