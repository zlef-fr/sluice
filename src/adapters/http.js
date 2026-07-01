// Shared conditional-GET helper for the HTTP adapters. Sends the validators
// (ETag / Last-Modified) captured on the previous successful fetch so an
// unchanged upstream answers 304 Not Modified — no re-download, no re-parse.
// Returns the fresh validators on a 200 so the caller can persist them.
import { USER_AGENT } from '../config.js';

export async function conditionalFetch(url, { headers = {}, validators = null } = {}) {
  const h = { 'User-Agent': USER_AGENT, ...headers };
  if (validators?.etag) h['If-None-Match'] = validators.etag;
  if (validators?.lastModified) h['If-Modified-Since'] = validators.lastModified;

  const res = await fetch(url, { headers: h });
  if (res.status === 304) return { res, notModified: true, validators };
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);

  const etag = res.headers.get('etag');
  const lastModified = res.headers.get('last-modified');
  const fresh = etag || lastModified ? { etag: etag || null, lastModified: lastModified || null } : null;
  return { res, notModified: false, validators: fresh };
}
