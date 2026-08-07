// Shared conditional-GET helper for the HTTP adapters. Sends the validators
// (ETag / Last-Modified) captured on the previous successful fetch so an
// unchanged upstream answers 304 Not Modified — no re-download, no re-parse.
// Returns the fresh validators on a 200 so the caller can persist them.
//
// Every upstream request Sluice makes goes out through `politeFetch`, so the
// per-host pacing in ../hostgate.js is a property of the gateway rather than
// something each adapter has to remember. See that file for why.
import { USER_AGENT } from '../config.js';
import { waitTurn, noteResponse, gapFor } from '../hostgate.js';

// How many times a single request rides out a "come back later" before it is
// reported as a failure. The waiting itself is the lane's job. Six because the
// lane widens its gap on every refusal: the run that gets refused most is the
// last one of a cluster, and it needs enough tries to outlive the whole storm
// ahead of it settling down.
const RATE_LIMIT_ATTEMPTS = Number(process.env.SLUICE_RATE_LIMIT_ATTEMPTS || 6);

/**
 * `fetch`, paced per upstream host, retrying a 429/503 after the cooldown that
 * response earns. Everything else — including a 404 or a 500 — is handed back
 * untouched: only the answers that mean "you, later" are worth waiting out.
 */
export async function politeFetch(url, init = {}, { descriptor = null, gapMs } = {}) {
  const gap = gapMs ?? gapFor(descriptor);
  for (let attempt = 1; ; attempt++) {
    const host = await waitTurn(url, { gapMs: gap });
    const res = await fetch(url, init);
    noteResponse(host, res, { gapMs: gap });
    if (res.status !== 429 && res.status !== 503) return res;
    if (attempt >= RATE_LIMIT_ATTEMPTS) return res;
    // Drop the body before going round again — an unread response body holds
    // its socket open, and this loop can run four times per source.
    await res.body?.cancel().catch(() => {});
  }
}

export async function conditionalFetch(url, { headers = {}, validators = null, descriptor = null, gapMs } = {}) {
  const h = { 'User-Agent': USER_AGENT, ...headers };
  if (validators?.etag) h['If-None-Match'] = validators.etag;
  if (validators?.lastModified) h['If-Modified-Since'] = validators.lastModified;

  const res = await politeFetch(url, { headers: h }, { descriptor, gapMs });
  if (res.status === 304) return { res, notModified: true, validators };
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  // 2xx is not enough: bot-protected origins answer an unwelcome client with a
  // bodyless 202/204 (europarl.europa.eu does, for any UA it doesn't recognise).
  // That used to be stored as a perfectly healthy 0-byte artifact.
  if (res.status !== 200 && res.status !== 206) {
    throw new Error(`HTTP ${res.status} from ${url} — no payload (upstream accepted but did not answer)`);
  }

  const etag = res.headers.get('etag');
  const lastModified = res.headers.get('last-modified');
  const fresh = etag || lastModified ? { etag: etag || null, lastModified: lastModified || null } : null;
  return { res, notModified: false, validators: fresh };
}
