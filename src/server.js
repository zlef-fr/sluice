// Sluice — a self-registering registry, fetcher and feed gateway for remote
// data sources. Boot sequence: load persisted registry → (re)seed built-ins →
// init transforms → schedule + refresh → serve API + MCP + dashboard.
import express from 'express';
import compression from 'compression';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { PORT, REPO_URL } from './config.js';
import { loadRegistry, warmFeeds, getDescriptor, putDescriptor } from './store.js';
import { normalizeDescriptor } from './registry.js';
import { initTransforms } from './transforms/index.js';
import { bootScheduler } from './scheduler.js';
import { SEED_SOURCES } from './seed.js';
import { SEED_DASHBOARDS } from './seed-dashboards.js';
import { loadDashboards, getDashboard, putDashboard, normalizeDashboard } from './dashboards.js';
import { listSources } from './service.js';

import sourcesRouter from './routes/sources.js';
import feedRouter from './routes/feed.js';
import exploreRouter from './routes/explore.js';
import dashboardsRouter from './routes/dashboards.js';
import dashboardRouter from './routes/dashboard.js';
import mcpRouter from './routes/mcp.js';
import { getBundle } from './dashboard-bundle.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// (Re)write the batteries-included sources every boot, preserving createdAt and
// never touching user-registered ids.
async function seed() {
  for (const s of SEED_SOURCES) {
    const existing = getDescriptor(s.id);
    const norm = normalizeDescriptor({ ...s, createdAt: existing?.createdAt });
    if (!norm.ok) {
      console.error(`[sluice] seed "${s.id}" invalid: ${norm.error}`);
      continue;
    }
    await putDescriptor(norm.descriptor);
  }
}

// (Re)write the built-in dashboard configs each boot, preserving createdAt and
// never touching user-registered ids.
async function seedDashboards() {
  for (const c of SEED_DASHBOARDS) {
    const existing = getDashboard(c.id);
    const norm = normalizeDashboard({ ...c, createdAt: existing?.createdAt }, { existing });
    if (!norm.ok) {
      console.error(`[sluice] dashboard "${c.id}" invalid: ${norm.error}`);
      continue;
    }
    await putDashboard(norm.config);
  }
}

async function main() {
  await loadRegistry();
  await seed();
  await loadDashboards();
  await seedDashboards();
  await warmFeeds();
  await initTransforms();

  const app = express();
  app.disable('x-powered-by');
  app.use(compression());
  app.use(express.json({ limit: '1mb' }));

  // CORS: feeds are open data meant to be pulled cross-origin by other apps.
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'content-type, x-sluice-token, x-sluice-owner, mcp-session-id');
    res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  app.get('/healthz', (_req, res) => {
    const sources = listSources();
    res.json({
      ok: true,
      service: 'sluice',
      sources: sources.length,
      feeds: sources.filter((s) => s.status.state === 'ok').map((s) => s.id),
    });
  });

  app.use('/api/sources', sourcesRouter);
  app.use('/api/feed', feedRouter);
  app.use('/api/explore', exploreRouter);
  app.use('/api/dashboards', dashboardsRouter);
  app.use('/mcp', mcpRouter);

  // Themeable exploration dashboards. The client ships as ONE content-hash-
  // versioned bundle (built from the ES-module sources at boot, served from
  // memory) so a deploy auto-busts CF + the browser — the SSR references it as
  // /d/_assets/dashboard.bundle.js?v=<hash>. Registered before the static mount.
  getBundle(); // prime the cache so the first request is instant
  app.get('/d/_assets/dashboard.bundle.js', (_req, res) => {
    res.set('Content-Type', 'application/javascript; charset=utf-8');
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'public, max-age=31536000, immutable'); // URL is versioned
    res.send(getBundle().code);
  });

  // Static mount (app.css + the module sources the bundle is built from). Registered
  // before /d/:id so `_assets` isn't captured as an id.
  app.use('/d/_assets', express.static(join(__dirname, 'public', 'dashboard'), {
    // Revalidate every load: ES-module imports (app.js → ./views.js …) can't be
    // cache-busted with a ?v= query, so a deploy would otherwise stay shadowed by
    // a stale CF/browser copy. ETag makes revalidation a cheap 304.
    etag: true,
    setHeaders: (res) => {
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Cache-Control', 'no-cache');
    },
  }));
  app.use('/d', dashboardRouter);

  // Sluice is an API/MCP service, not a website — no landing page. The root
  // just points a human at the docs (the repo README).
  app.get('/', (_req, res) => res.redirect(302, REPO_URL));

  app.listen(PORT, () => console.log(`[sluice] listening on :${PORT}`));

  await bootScheduler();
}

main().catch((e) => {
  console.error('[sluice] fatal:', e);
  process.exit(1);
});
