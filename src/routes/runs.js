// /api/runs — the fleet's refresh activity as ONE timeline, newest first.
//
// Per-source history lives at /api/sources/:id/runs; this is the cross-source
// view, which is the one that shows a pattern: four unrelated feeds that all
// started failing at 04:00 are an upstream outage, not four bugs.
import { Router } from 'express';
import { requireRead } from '../auth.js';
import { fleetHistory } from '../service.js';

const router = Router();

router.get('/', requireRead, (req, res) => {
  const failedOnly = req.query.failed === '1' || req.query.failed === 'true';
  res.json({
    runs: fleetHistory({
      limit: req.query.limit,
      id: req.query.id ? String(req.query.id) : null,
      failedOnly,
    }),
  });
});

export default router;
