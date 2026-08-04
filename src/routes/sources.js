// /api/sources — the registry surface (list, inspect, self-register, delete,
// force-refresh).
import { Router } from 'express';
import { requireWrite, requireRead } from '../auth.js';
import {
  listSources, getSource, registerSource, deleteSource, refreshNow, sourceHistory,
} from '../service.js';

const router = Router();

router.get('/', requireRead, (_req, res) => {
  res.json({ sources: listSources() });
});

router.get('/:id', requireRead, (req, res) => {
  const s = getSource(req.params.id);
  if (!s) return res.status(404).json({ error: 'unknown source' });
  res.json(s);
});

// Self-register (or update) a source.
router.post('/', requireWrite, async (req, res) => {
  const owner = req.get('x-sluice-owner') || undefined;
  const result = await registerSource(req.body, { owner });
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.status(201).json(result.source);
});

// Idempotent update by id (id in path wins).
router.put('/:id', requireWrite, async (req, res) => {
  const owner = req.get('x-sluice-owner') || undefined;
  const result = await registerSource({ ...req.body, id: req.params.id }, { owner });
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json(result.source);
});

router.delete('/:id', requireWrite, async (req, res) => {
  const ok = await deleteSource(req.params.id);
  if (!ok) return res.status(404).json({ error: 'unknown source' });
  res.json({ ok: true, deleted: req.params.id });
});

// The refresh history of one source, newest first.
router.get('/:id/runs', requireRead, (req, res) => {
  const h = sourceHistory(req.params.id, req.query.limit);
  if (!h) return res.status(404).json({ error: 'unknown source' });
  res.json(h);
});

// `force` additionally skips every not-modified shortcut — the re-download an
// operator wants when the bytes are gone or the upstream lied about its ETag.
router.post('/:id/refresh', requireWrite, async (req, res) => {
  const force = req.query.force === '1' || req.query.force === 'true' || !!(req.body || {}).force;
  const r = await refreshNow(req.params.id, { force });
  if (!r) return res.status(404).json({ error: 'unknown source' });
  res.status(r.ok ? 200 : 502).json(r);
});

export default router;
