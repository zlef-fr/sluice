// /api/sources — the registry surface (list, inspect, self-register, delete,
// force-refresh).
import { Router } from 'express';
import { requireWrite, requireRead } from '../auth.js';
import {
  listSources, getSource, registerSource, deleteSource, refreshNow,
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

router.post('/:id/refresh', requireWrite, async (req, res) => {
  const r = await refreshNow(req.params.id);
  if (!r) return res.status(404).json({ error: 'unknown source' });
  res.status(r.ok ? 200 : 502).json(r);
});

export default router;
