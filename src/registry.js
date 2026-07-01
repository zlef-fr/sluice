// Descriptor validation + normalization. A "source descriptor" is the contract
// a consumer self-registers. We keep it permissive but sane: unknown fields are
// preserved (forward-compat), required ones are checked, and refresh is clamped
// to the global floor so a descriptor can't hammer an upstream provider.
import { isValidId, parseDuration } from './util.js';
import { hasAdapter, adapterNames } from './adapters/index.js';
import { hasTransform, transformNames } from './transforms/index.js';
import { MIN_REFRESH_MS } from './config.js';

const DEFAULT_REFRESH_MS = 6 * 60 * 60 * 1000; // 6h

// Returns { ok, error } or { ok:true, descriptor } with a normalized descriptor.
export function normalizeDescriptor(input, { owner } = {}) {
  if (!input || typeof input !== 'object') return err('body must be a JSON object');

  const id = input.id;
  if (!isValidId(id)) {
    return err('`id` must be kebab-case (lowercase letters, digits, hyphens; 2–64 chars)');
  }

  const adapter = input.adapter;
  if (!adapter || !hasAdapter(adapter)) {
    return err(`unknown \`adapter\` "${adapter}". Known: ${adapterNames().join(', ')}`);
  }

  // transform may be a named string or an inline declarative object ({type,...}).
  const transform = input.transform ?? 'passthrough';
  if (typeof transform === 'string') {
    if (!hasTransform(transform)) {
      return err(`unknown \`transform\` "${transform}". Known: ${transformNames().join(', ')}`);
    }
  } else if (typeof transform !== 'object') {
    return err('`transform` must be a name (string) or an inline mapping object');
  }

  // The adapter needs *either* a url or an inline `source` object (ods-export).
  if (!input.url && !input.source) {
    return err('a `url` (or an adapter-specific `source` object) is required');
  }

  const refreshMs = parseDuration(input.refresh) ?? DEFAULT_REFRESH_MS;
  if (refreshMs == null || refreshMs <= 0) return err('`refresh` is not a valid duration');
  const clamped = Math.max(refreshMs, MIN_REFRESH_MS);

  const descriptor = {
    ...input,
    id,
    name: input.name || id,
    description: input.description || '',
    adapter,
    transform,
    url: input.url || null,
    source: input.source || null,
    options: input.options || {},
    refresh: input.refresh || '6h',
    refreshMs: clamped,
    geo: input.geo || null, // {lat, lon} field paths for geojson projection
    license: input.license || '',
    homepage: input.homepage || '',
    attribution: input.attribution || '',
    tags: Array.isArray(input.tags) ? input.tags.slice(0, 12) : [],
    owner: input.owner || owner || 'anonymous',
    createdAt: input.createdAt || new Date().toISOString(),
  };

  return { ok: true, descriptor };
}

function err(error) {
  return { ok: false, error };
}
