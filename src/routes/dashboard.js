// GET /d/:id — serves the themeable exploration SPA for a dashboard config.
// Resolves the viewer's locale, runs the first exploration query server-side
// (honouring any deep-link filters in the URL so a shared link paints the right
// state with no flash), and renders the shell. The client hydrates from there.
import { Router } from 'express';
import { getDashboard, dashboardForHost } from '../dashboards.js';
import { feedPayload, feedMeta } from '../service.js';
import { runQuery, parseQuery } from '../explore.js';
import { renderDashboard } from '../views/dashboard.js';

const router = Router();

function resolveLocale(req, config) {
  const locales = config.locales || ['en', 'fr'];
  const cookie = /(?:^|;\s*)zl-lang=([a-z]{2})/i.exec(req.headers.cookie || '');
  if (cookie && locales.includes(cookie[1].toLowerCase())) return cookie[1].toLowerCase();
  const al = String(req.headers['accept-language'] || '').slice(0, 2).toLowerCase();
  if (locales.includes(al)) return al;
  return config.defaultLocale || locales[0] || 'en';
}

// Merge the config's default view (facets/stats/sort/pageSize) with any explicit
// query params, so deep-link filters flow straight into the SSR'd first page.
function initialQuery(config, reqQuery) {
  const q = parseQuery(reqQuery);
  if (!q.facets.length) q.facets = (config.facets || []).map((f) => f.field);
  if (!q.stats.length) q.stats = (config.metrics || []).map((m) => m.field);
  if (!q.sort && config.sort?.default) {
    const s = String(config.sort.default);
    q.sort = s.startsWith('-') ? { field: s.slice(1), dir: -1 } : { field: s, dir: 1 };
  }
  if (!reqQuery.pageSize) q.pageSize = 50;
  return q;
}

async function serve(config, req, res) {
  const locale = resolveLocale(req, config);
  const payload = await feedPayload(config.feed);

  let initial = null;
  let meta = null;
  if (payload && payload.fetchedAt) {
    initial = runQuery(payload, initialQuery(config, req.query));
    meta = (await feedMeta(config.feed))?.meta || null;
  }

  const siteBase = `https://${req.headers.host || 'sluice.zlef.fr'}`;
  const html = renderDashboard({
    config, locale, meta, initial,
    requestPath: req.originalUrl.split('?')[0],
    siteBase,
  });
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', 'no-cache');
  res.send(html);
}

router.get('/:id', async (req, res) => {
  const config = getDashboard(req.params.id) || dashboardForHost(req.headers.host);
  if (!config) {
    // 200 (not 404) so the no-error-pages middleware doesn't replace the body.
    return res
      .status(200)
      .type('html')
      .send('<!doctype html><meta charset=utf-8><title>Dashboard not found</title><body style="font-family:system-ui;padding:3rem;max-width:32rem;margin:auto"><h1>No such dashboard</h1><p>No dashboard is registered at this address. See <a href="https://sluice.zlef.fr">sluice.zlef.fr</a>.</p>');
  }
  await serve(config, req, res);
});

export default router;
