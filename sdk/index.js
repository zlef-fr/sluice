// @zlef/sluice — tiny isomorphic client for a Sluice server.
// Works in Node 18+ and the browser (uses global fetch). No dependencies.
//
//   import { SluiceClient } from '@zlef/sluice';
//   const sluice = new SluiceClient({ baseUrl: 'http://127.0.0.1:10099', token });
//   const { data, meta } = await sluice.feed('fr-fuel-prices');
//   await sluice.register({ id, name, adapter, url, transform, refresh });

export class SluiceError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'SluiceError';
    this.status = status;
    this.body = body;
  }
}

export class SluiceClient {
  constructor({ baseUrl = 'http://127.0.0.1:10099', token = '', fetch: f } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/$/, '');
    this.token = token;
    this._fetch = f || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
    if (!this._fetch) throw new Error('no fetch available; pass { fetch } (e.g. node-fetch)');
  }

  async _req(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
    const h = { ...headers };
    if (this.token) h['x-sluice-token'] = this.token;
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await this._fetch(this.baseUrl + path, {
      method,
      headers: h,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (raw) return res;
    const text = await res.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    if (!res.ok) {
      const msg = (parsed && parsed.error) || `HTTP ${res.status}`;
      throw new SluiceError(msg, res.status, parsed);
    }
    return parsed;
  }

  // ── registry ──
  /** List all sources with status. */
  sources() { return this._req('/api/sources').then((r) => r.sources); }

  /** One source's descriptor + status. */
  source(id) { return this._req(`/api/sources/${encodeURIComponent(id)}`); }

  /** Self-register (or, with an existing id, replace) a source. Needs the write token. */
  register(descriptor) { return this._req('/api/sources', { method: 'POST', body: descriptor }); }

  /** Idempotent update by id. Needs the write token. */
  update(id, descriptor) {
    return this._req(`/api/sources/${encodeURIComponent(id)}`, { method: 'PUT', body: descriptor });
  }

  /** Delete a source. Needs the write token. */
  remove(id) {
    return this._req(`/api/sources/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  /** Force an immediate re-fetch and wait for it. Needs the write token. */
  refresh(id) {
    return this._req(`/api/sources/${encodeURIComponent(id)}/refresh`, { method: 'POST' });
  }

  // ── feeds ──
  /** Full feed: { id, fetchedAt, itemCount, meta, data }. */
  feed(id) { return this._req(`/api/feed/${encodeURIComponent(id)}`); }

  /** Just meta: { id, fetchedAt, itemCount, meta }. */
  meta(id) { return this._req(`/api/feed/${encodeURIComponent(id)}/meta`); }

  /** GeoJSON FeatureCollection (source must declare geo:{lat,lon}). */
  geojson(id) { return this._req(`/api/feed/${encodeURIComponent(id)}.geojson`); }

  /**
   * Ensure a source exists then return its feed — the common "register-or-reuse
   * and pull" pattern for a consumer that owns a source. If registration fails
   * because writes are disabled or unauthorized, falls back to reading the feed
   * (assumes another owner already registered it).
   */
  async ensureAndFeed(descriptor) {
    try { await this.register(descriptor); } catch (e) {
      if (!(e instanceof SluiceError) || (e.status !== 401 && e.status !== 503)) throw e;
    }
    return this.feed(descriptor.id);
  }

  /**
   * Poll a feed and invoke onData whenever the snapshot changes (by fetchedAt).
   * Returns a stop() function. Cheap: polls /meta, only pulls full data on change.
   */
  watch(id, onData, { intervalMs = 5 * 60 * 1000, immediate = true } = {}) {
    let last = null;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      try {
        const m = await this.meta(id);
        if (m && m.fetchedAt !== last) {
          last = m.fetchedAt;
          const feed = await this.feed(id);
          if (!stopped) onData(feed);
        }
      } catch { /* transient — try again next tick */ }
    };
    if (immediate) tick();
    const timer = setInterval(tick, intervalMs);
    timer.unref?.();
    return () => { stopped = true; clearInterval(timer); };
  }
}

export default SluiceClient;
