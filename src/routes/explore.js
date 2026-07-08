// /api/explore — deep exploration over a cached feed. Where /api/feed dumps the
// whole snapshot, /api/explore lets a client filter, sort, page, facet, range-
// stat and full-text-search it, plus pull a single record by id. This is what
// powers the themeable dashboard SPA (and any app that wants to query a feed).
import { Router } from 'express';
import { requireRead } from '../auth.js';
import { feedPayload } from '../service.js';
import { runQuery, findRecord, parseQuery, geoPoints } from '../explore.js';

const router = Router();

// GET /api/explore/:feedId?…  → { total, filtered, page, pages, rows, facets, stats }
router.get('/:feedId', requireRead, async (req, res) => {
  const feedId = req.params.feedId;
  const payload = await feedPayload(feedId);
  if (payload === null) return res.status(404).json({ error: 'unknown source' });
  if (!payload.fetchedAt) return res.status(503).json({ error: 'feed not fetched yet, retry shortly' });

  const query = parseQuery(req.query);
  const result = runQuery(payload, query);
  // Result depends on the immutable snapshot + the exact query string, so it's
  // safely cacheable at the edge for a short window.
  res.set('Cache-Control', 'public, max-age=120');
  res.json({ feed: feedId, ...result });
});

// GET /api/explore/:feedId/points?lat=&lon=&color=&idField=&cap=&<filters…>
// Compact [id,lat,lon,colorVal] tuples for a map scatter (filtered + sampled).
router.get('/:feedId/points', requireRead, async (req, res) => {
  const payload = await feedPayload(req.params.feedId);
  if (payload === null) return res.status(404).json({ error: 'unknown source' });
  if (!payload.fetchedAt) return res.status(503).json({ error: 'feed not fetched yet, retry shortly' });
  const lat = String(req.query.lat || 'lat');
  const lon = String(req.query.lon || 'lon');
  if (!lat || !lon) return res.status(400).json({ error: 'lat and lon field paths required' });

  const query = parseQuery(req.query);
  const out = geoPoints(payload, query, {
    lat,
    lon,
    color: req.query.color ? String(req.query.color) : null,
    idField: req.query.idField ? String(req.query.idField) : 'id',
    cap: Math.min(Math.max(parseInt(req.query.cap, 10) || 20000, 100), 40000),
  });
  res.set('Cache-Control', 'public, max-age=120');
  res.json({ feed: req.params.feedId, lat, lon, ...out });
});

// GET /api/explore/:feedId/record/:id?idField=  → { record } | 404
router.get('/:feedId/record/:id', requireRead, async (req, res) => {
  const payload = await feedPayload(req.params.feedId);
  if (payload === null) return res.status(404).json({ error: 'unknown source' });
  if (!payload.fetchedAt) return res.status(503).json({ error: 'feed not fetched yet, retry shortly' });

  const idField = req.query.idField ? String(req.query.idField) : 'id';
  const record = findRecord(payload, req.params.id, idField);
  if (!record) return res.status(404).json({ error: 'record not found', id: req.params.id, idField });
  res.set('Cache-Control', 'public, max-age=120');
  res.json({ feed: req.params.feedId, idField, record });
});

export default router;
