// Runtime configuration. Everything is env-driven so the service is portable
// (that's the "open-sourcable" contract — no zlef-specific paths baked in).
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const ROOT = join(__dirname, '..');
export const DATA_DIR = process.env.SLUICE_DATA_DIR || join(ROOT, 'data');
export const SOURCES_FILE = join(DATA_DIR, 'sources.json');
export const FEEDS_DIR = join(DATA_DIR, 'feeds');

// Root path redirects here — Sluice has no landing page; the docs are the repo.
export const REPO_URL = process.env.SLUICE_REPO_URL || 'https://github.com/zlef-fr/sluice';

export const PORT = Number(process.env.PORT || 10099);

// Write token — required for register / update / delete / force-refresh.
// Reads (list, feed, meta, geojson) are open by default because the payloads
// are public open data; set SLUICE_READ_TOKEN to gate them too.
export const WRITE_TOKEN = process.env.SLUICE_TOKEN || '';
export const READ_TOKEN = process.env.SLUICE_READ_TOKEN || '';

// User-Agent used for every upstream fetch (be a good open-data citizen).
export const USER_AGENT =
  process.env.SLUICE_USER_AGENT || 'Sluice/1.0 (+https://sluice.zlef.fr; open-data gateway)';

// Global ceiling on how often a source is allowed to refresh, to protect
// upstream providers even if a descriptor asks for something aggressive.
export const MIN_REFRESH_MS = Number(process.env.SLUICE_MIN_REFRESH_MS || 5 * 60 * 1000);
