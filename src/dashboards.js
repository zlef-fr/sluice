// Dashboard configs — the second kind of thing Sluice hosts. A *source* says how
// to fetch & normalize data; a *dashboard* says how to PRESENT a feed: a themeable,
// deep-linkable exploration UI declared entirely as data. A consuming app registers
// one config (theme tokens, i18n copy, facets, metrics, columns, detail layout, map,
// charts) and Sluice serves a fully-skinned SPA for it at /d/:id — no per-app frontend
// to write. Stored as plain JSON on disk, same as the registry.
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR } from './config.js';
import { isValidId } from './util.js';

const DASHBOARDS_FILE = join(DATA_DIR, 'dashboards.json');

// id → config  (kept warm in memory; the file is the source of truth on disk)
const dashboards = new Map();

async function ensureDir() {
  await mkdir(DATA_DIR, { recursive: true });
}
async function atomicWrite(file, str) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, str);
  await rename(tmp, file);
}

export async function loadDashboards() {
  await ensureDir();
  try {
    const raw = JSON.parse(await readFile(DASHBOARDS_FILE, 'utf8'));
    for (const c of raw.dashboards || []) dashboards.set(c.id, c);
  } catch {
    /* first boot — none yet */
  }
}

async function persist() {
  const out = { version: 1, dashboards: [...dashboards.values()] };
  await atomicWrite(DASHBOARDS_FILE, JSON.stringify(out, null, 2));
}

export function getDashboard(id) {
  return dashboards.get(id) || null;
}
export function allDashboards() {
  return [...dashboards.values()];
}
// Resolve a request Host header to a dashboard (for future per-app subdomain
// wiring — an app points data.foo.zlef.fr at Sluice, we serve its config).
export function dashboardForHost(host) {
  if (!host) return null;
  const h = String(host).toLowerCase().split(':')[0];
  for (const c of dashboards.values()) {
    if (Array.isArray(c.hosts) && c.hosts.some((x) => String(x).toLowerCase() === h)) return c;
  }
  return null;
}

export async function putDashboard(config) {
  dashboards.set(config.id, config);
  await persist();
}
export async function removeDashboard(id) {
  if (!dashboards.has(id)) return false;
  dashboards.delete(id);
  await persist();
  return true;
}

// A compact public listing (no need to ship every column/chart for an index).
export function summarizeDashboard(c) {
  return {
    id: c.id,
    name: c.name,
    feed: c.feed,
    hosts: c.hosts || [],
    locales: c.locales || ['en', 'fr'],
    url: `/d/${c.id}`,
    logoText: c.branding?.logoText || c.name,
    updatedAt: c.updatedAt || c.createdAt || null,
  };
}

// ── validation / normalization ────────────────────────────────────────────────
// Permissive like the source registry: require the two load-bearing fields (id +
// feed), default the rest, preserve unknown keys for forward-compat. A label may
// be a bare string or an {en,fr,…} map — we never force one shape here; the SPA
// resolves per-locale with an English fallback.
export function normalizeDashboard(input, { existing } = {}) {
  if (!input || typeof input !== 'object') return err('body must be a JSON object');
  if (!isValidId(input.id)) {
    return err('`id` must be kebab-case (lowercase letters, digits, hyphens; 2–64 chars)');
  }
  if (!input.feed || typeof input.feed !== 'string') {
    return err('`feed` (a Sluice feed id) is required');
  }
  if (input.hosts != null && !Array.isArray(input.hosts)) {
    return err('`hosts` must be an array of hostnames');
  }

  const now = new Date().toISOString();
  const theme = input.theme || {};
  const config = {
    ...input,
    id: input.id,
    name: input.name || input.id,
    feed: input.feed,
    idField: input.idField || 'id',
    hosts: Array.isArray(input.hosts) ? input.hosts.map(String).slice(0, 8) : [],
    locales: Array.isArray(input.locales) && input.locales.length ? input.locales : ['en', 'fr'],
    defaultLocale: input.defaultLocale || 'en',
    theme: {
      palette: theme.palette || {},
      font: theme.font || 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
      fontDisplay: theme.fontDisplay || theme.font || 'system-ui, sans-serif',
      fontUrl: theme.fontUrl || '',
      radius: theme.radius || '14px',
      ...theme,
    },
    branding: input.branding || {},
    i18n: input.i18n || {},
    record: input.record || { title: input.idField || 'id' },
    search: input.search || { fields: [] },
    facets: Array.isArray(input.facets) ? input.facets : [],
    metrics: Array.isArray(input.metrics) ? input.metrics : [],
    columns: Array.isArray(input.columns) ? input.columns : [],
    sort: input.sort || {},
    map: input.map || null,
    charts: Array.isArray(input.charts) ? input.charts : [],
    createdAt: existing?.createdAt || input.createdAt || now,
    updatedAt: now,
  };
  return { ok: true, config };
}

function err(error) {
  return { ok: false, error };
}
