// /api/dashboards — CRUD for dashboard configs. Reads are open (a config is
// public presentation metadata); writes require the Sluice write token, exactly
// like source registration. This is how an app declares "here's how to present
// feed X"; the SPA at /d/:id then renders it.
import { Router } from 'express';
import { requireRead, requireWrite } from '../auth.js';
import {
  allDashboards, getDashboard, dashboardForHost,
  putDashboard, removeDashboard, normalizeDashboard, summarizeDashboard,
} from '../dashboards.js';

const router = Router();

router.get('/', requireRead, (_req, res) => {
  res.json({ dashboards: allDashboards().map(summarizeDashboard) });
});

// Resolve a hostname → its dashboard config (for per-app subdomain wiring).
router.get('/by-host/:host', requireRead, (req, res) => {
  const c = dashboardForHost(req.params.host);
  if (!c) return res.status(404).json({ error: 'no dashboard bound to that host' });
  res.json(c);
});

router.get('/:id', requireRead, (req, res) => {
  const c = getDashboard(req.params.id);
  if (!c) return res.status(404).json({ error: 'unknown dashboard' });
  res.set('Cache-Control', 'public, max-age=60');
  res.json(c);
});

// Register or replace (idempotent on id). Body is the config object.
router.post('/', requireWrite, async (req, res) => {
  const existing = getDashboard(req.body?.id);
  const norm = normalizeDashboard(req.body, { existing });
  if (!norm.ok) return res.status(400).json({ error: norm.error });
  await putDashboard(norm.config);
  res.status(existing ? 200 : 201).json(norm.config);
});

router.put('/:id', requireWrite, async (req, res) => {
  const existing = getDashboard(req.params.id);
  const norm = normalizeDashboard({ ...req.body, id: req.params.id }, { existing });
  if (!norm.ok) return res.status(400).json({ error: norm.error });
  await putDashboard(norm.config);
  res.json(norm.config);
});

router.delete('/:id', requireWrite, async (req, res) => {
  const ok = await removeDashboard(req.params.id);
  if (!ok) return res.status(404).json({ error: 'unknown dashboard' });
  res.json({ ok: true, removed: req.params.id });
});

export default router;
