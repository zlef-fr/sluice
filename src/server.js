// Sluice — a self-registering registry, fetcher and feed gateway for remote
// data sources. Boot sequence: load persisted registry → (re)seed built-ins →
// init transforms → schedule + refresh → serve API + MCP + dashboard.
import express from 'express';
import compression from 'compression';

import { PORT, PUBLIC_DIR } from './config.js';
import { loadRegistry, warmFeeds, getDescriptor, putDescriptor } from './store.js';
import { normalizeDescriptor } from './registry.js';
import { initTransforms } from './transforms/index.js';
import { bootScheduler } from './scheduler.js';
import { SEED_SOURCES } from './seed.js';
import { listSources } from './service.js';

import sourcesRouter from './routes/sources.js';
import feedRouter from './routes/feed.js';
import mcpRouter from './routes/mcp.js';

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

async function main() {
  await loadRegistry();
  await seed();
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
  app.use('/mcp', mcpRouter);

  app.use(express.static(PUBLIC_DIR, { maxAge: '1h', extensions: ['html'] }));

  app.listen(PORT, () => console.log(`[sluice] listening on :${PORT}`));

  await bootScheduler();
}

main().catch((e) => {
  console.error('[sluice] fatal:', e);
  process.exit(1);
});
