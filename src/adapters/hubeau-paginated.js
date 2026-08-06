// Hub'Eau (hubeau.eaufrance.fr) — the French water-data API — served as a single
// versioned ARTIFACT, by walking its cursor pagination to the end.
//
// Why this adapter exists. Hub'Eau caps one response at `size` rows (20 000 on the
// v2 hydrometry endpoints) and then TRUNCATES IN SILENCE: the payload still carries
// a `count` of the full result set, but `data` holds only the first page, and
// nothing in the HTTP status or the body says so. A consumer that asks for a whole
// dataset in one call gets a well-formed, plausible, WRONG file. That has already
// cost this fleet one bad dataset.
//
// So the contract here is not "fetch a URL" but "fetch a result set, entirely, and
// prove it": every page is followed via the API's own `next` cursor, and the adapter
// REFUSES to emit an artifact whose row count does not match the `count` the API
// declared on the first page. A short read raises instead of quietly shipping.
//
// descriptor:
//   url        first page. Include the query that defines the result set; `size` is
//              honoured as the page size (the adapter does not override it).
//   options:
//     filename    name to store as (default: derived from the endpoint)
//     format      'csv' (default) | 'ndjson'
//     columns     [..] CSV columns, in order. Required for csv.
//     where       optional [{ field, notNull: true }] — rows failing it are dropped
//                 and the count is REPORTED, never silent. See the note below.
//     maxPages    safety stop (default 5000)
//     timeoutMs   per-request timeout (default 120000)
//     logEvery    log progress every N pages (default 25) — a 144-page walk that
//                 says nothing for 20 minutes is indistinguishable from a hung one
//     headers     extra request headers
//
// Note on `where`. Several Hub'Eau endpoints return the same measurement twice: once
// against the SITE and once against the STATION that sits on it. On obs_elab that is
// ~47 % of rows, and they arrive with `code_station: null`. A pipeline that joins on
// the station referential drops them anyway; declaring
// `where: [{ field: 'code_station', notNull: true }]` makes that intent explicit and
// halves the artifact instead of leaving a million rows keyed on the string "null".
import { rm } from 'node:fs/promises';
import { USER_AGENT } from '../config.js';
import { latestRecord, streamToStaging } from '../artifacts.js';

const DEFAULT_MAX_PAGES = 5000;

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function getJson(url, headers, timeoutMs, attempt = 0) {
  try {
    // A timeout is not optional here. Without one, a single hung connection parks
    // the whole refresh forever: the run never completes, so it never fails, so it
    // never retries — and because the fetcher keeps it in flight, every later
    // refresh of the source is silently skipped too. Observed in the wild: a
    // 144-page walk that stopped writing after page 40 and simply sat there.
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, accept: 'application/json', ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Hub'Eau is a shared public service: 429 and 5xx are "come back later",
    // not "the data is gone".
    if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.json();
  } catch (err) {
    if (attempt >= 4) throw err;
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    return getJson(url, headers, timeoutMs, attempt + 1);
  }
}

function endpointName(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] || 'hubeau';
  } catch {
    return 'hubeau';
  }
}

export default async function hubeauPaginated(descriptor, ctx = {}) {
  const opts = descriptor.options || {};
  const format = opts.format === 'ndjson' ? 'ndjson' : 'csv';
  const columns = opts.columns;
  if (format === 'csv' && (!Array.isArray(columns) || !columns.length)) {
    throw new Error('hubeau-paginated: options.columns is required for csv');
  }
  if (!descriptor.url) throw new Error('hubeau-paginated needs a url');

  const filename = opts.filename || `${endpointName(descriptor.url)}.${format === 'csv' ? 'csv' : 'ndjson'}`;
  const maxPages = Number.isFinite(opts.maxPages) ? opts.maxPages : DEFAULT_MAX_PAGES;
  const headers = opts.headers || {};
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 120000;
  const logEvery = Number.isFinite(opts.logEvery) ? opts.logEvery : 25;
  const where = Array.isArray(opts.where) ? opts.where : [];
  const keeps = (row) => where.every((w) => !w.notNull || (row[w.field] !== null && row[w.field] !== undefined));

  // Counters the stream fills in and the tail of this function asserts on.
  const stats = { declared: null, seen: 0, kept: 0, pages: 0 };

  const body = new ReadableStream({
    async start(controller) {
      try {
        if (format === 'csv') controller.enqueue(new TextEncoder().encode(columns.join(';') + '\n'));
        let url = descriptor.url;
        while (url && stats.pages < maxPages) {
          const page = await getJson(url, headers, timeoutMs);
          if (stats.declared === null) stats.declared = page.count ?? null;
          const rows = page.data || [];
          stats.pages += 1;
          stats.seen += rows.length;
          let chunk = '';
          for (const row of rows) {
            if (!keeps(row)) continue;
            stats.kept += 1;
            chunk +=
              format === 'csv'
                ? columns.map((c) => csvCell(row[c])).join(';') + '\n'
                : JSON.stringify(row) + '\n';
          }
          if (chunk) controller.enqueue(new TextEncoder().encode(chunk));
          if (logEvery > 0 && stats.pages % logEvery === 0) {
            console.log(
              `[sluice] ${descriptor.id}: page ${stats.pages}, ${stats.seen}/${stats.declared ?? '?'} row(s)`,
            );
          }
          // `next` is absent (or equal to the current url) on the last page.
          const next = page.next && page.next !== url ? page.next : null;
          url = next;
        }
        if (url) {
          throw new Error(
            `hubeau-paginated: still paginating after ${maxPages} pages — raise options.maxPages`,
          );
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });

  const staged = await streamToStaging(descriptor.id || 'hubeau', new Response(body), {
    filename,
    compress: opts.compress ?? 'auto',
  });

  // The whole point of the adapter. A short read here means the API stopped early
  // or a cursor was dropped; emitting the artifact anyway would republish exactly
  // the silent truncation this exists to prevent.
  if (stats.declared !== null && stats.seen !== stats.declared) {
    // streamToStaging cleans up only when the stream itself fails; this check runs
    // after a successful write, so the partial file is ours to remove.
    await rm(staged.tmpPath, { force: true });
    throw new Error(
      `hubeau-paginated: incomplete result set — API declared ${stats.declared} rows, ` +
        `${stats.seen} came back over ${stats.pages} page(s)`,
    );
  }

  const dropped = stats.seen - stats.kept;
  console.log(
    `[sluice] hubeau-paginated: ${stats.pages} page(s), ${stats.seen} row(s)` +
      (dropped ? `, ${dropped} dropped by options.where` : '') +
      ` → ${stats.kept} written`,
  );

  // Same bytes as the version we already hold? Keep that version rather than mint a
  // new one. There is no cheap probe for these endpoints — no ETag, and `count`
  // alone would miss a corrected value — so the download always happens and the
  // sha256 decides. One download per refresh interval, for the whole fleet.
  const held = await latestRecord(descriptor.id).catch(() => null);
  if (held && held.sha256 === staged.sha256) {
    if (held.evicted) {
      return { restored: { version: held.version, ...staged }, bytes: staged.bytes };
    }
    return { notModified: true, discard: staged.tmpPath, bytes: staged.bytes };
  }

  return {
    artifact: {
      ...staged,
      keep: Number.isFinite(opts.keep) ? opts.keep : undefined,
      url: descriptor.url,
      contentType: format === 'csv' ? 'text/csv' : 'application/x-ndjson',
      rows: stats.kept,
    },
    bytes: staged.bytes,
  };
}
