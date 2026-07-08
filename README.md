# Sluice

**A self-registering registry, fetcher and feed gateway for remote data sources.**

Sluice is the single place that *obtains and manages* remote data (open data, public
APIs, file feeds) for a whole fleet of apps. Instead of every project hand-writing its
own downloader, cache and refresh loop, they **self-register a source** once and **pull a
normalized feed**. Sluice does the fetching, parsing, enrichment, scheduling and caching.

- 🔌 **Self-register endpoint** — declare a source with a JSON descriptor (`POST /api/sources`).
- 🚰 **Feed endpoints** — pull the current cached, normalized data (`GET /api/feed/:id`),
  its metadata (`/meta`), or a **GeoJSON** projection (`/:id.geojson`) for maps.
- ⏱ **Scheduled refresh** — per-source interval, staggered, restart-aware (won't re-hammer
  upstreams), one broken source never breaks the others.
- 🧩 **Adapters + transforms** — pluggable fetch/parse (`http-json`, `http-csv`,
  `http-zip-xml`, `ods-export`) and normalize steps (declarative field-mapping or named code).
- 🤖 **MCP server** — every source is discoverable and pullable as a tool by Claude / agents.
- 📦 **JS SDK** — `@zlef/sluice`, isomorphic, dependency-free.

Plain Node + Express, JSON-on-disk (no database), zero config to boot.

---

## Quick start

**Requirements:** Node.js ≥ 18 (uses the global `fetch` / `Readable.fromWeb`). No database.

### Run locally

```bash
git clone https://github.com/zlef-fr/sluice.git
cd sluice
npm install
npm start                       # listens on :10099
```

That's it — Sluice boots with a set of ready-to-use open-data feeds already
registered (see [Seeded feeds](#seeded-feeds)) and starts serving immediately:

```bash
curl http://localhost:10099/healthz
curl http://localhost:10099/api/sources            # what's registered
curl http://localhost:10099/api/feed/fr-fuel-prices | head -c 400
```

By default **reads are open and writes are disabled** (no token set), so the
instance is safe to run as a read-only mirror out of the box. To allow
registering/updating sources, set a write token (see [below](#enabling-writes)).

### Run with Docker

```bash
docker compose up -d --build     # uses the bundled docker-compose.yml
# or, plain docker:
docker build -t sluice .
docker run -d --name sluice -p 10099:10099 -v "$PWD/data:/app/data" sluice
```

The `data/` volume holds the source registry (`sources.json`) and the cached
feed snapshots — persist it across rebuilds.

### Enabling writes

Register/update/delete/refresh are gated by a token. Set it and pass it back on
write calls:

```bash
SLUICE_TOKEN=$(openssl rand -hex 24) npm start
```

```bash
curl -X POST http://localhost:10099/api/sources \
  -H "x-sluice-token: $SLUICE_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "id": "demo-quakes",
    "name": "USGS earthquakes (M2.5+, last day)",
    "adapter": "http-json",
    "url": "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson",
    "options": { "path": "features" },
    "transform": { "type": "map",
      "fields": { "id": "id", "mag": "properties.mag", "place": "properties.place",
                  "lon": "geometry.coordinates.0", "lat": "geometry.coordinates.1" },
      "number": ["mag", "lat", "lon"], "required": ["lat", "lon"] },
    "geo": { "lat": "lat", "lon": "lon" },
    "refresh": "15m"
  }'

curl http://localhost:10099/api/feed/demo-quakes
curl http://localhost:10099/api/feed/demo-quakes.geojson   # map-ready
```

See [Configuration](#configuration) for every env var. Nothing is hard-coded —
paths, port and tokens are all env-driven, so the service is fully portable.

---

## Concepts

A **source descriptor** is the contract you register:

```jsonc
{
  "id": "fr-fuel-prices",             // kebab-case, unique
  "name": "Prix des carburants (France)",
  "adapter": "http-zip-xml",          // how to fetch + parse
  "url": "https://donnees.roulez-eco.fr/opendata/instantane",
  "options": { "encoding": "latin1" },
  "transform": "fuel-etalab",         // how to normalize (name or inline mapping)
  "refresh": "6h",                    // refresh interval
  "geo": { "lat": "la", "lon": "lo" },// enables the .geojson projection
  "license": "Licence Ouverte / Etalab",
  "tags": ["france", "energy", "fuel"]
}
```

**Adapters** turn a remote resource into raw records:

| adapter         | source                                             |
|-----------------|----------------------------------------------------|
| `http-json`     | JSON document (optionally `options.path` to the array) |
| `http-csv`      | CSV/TSV (`options.delimiter`, `options.encoding`)  |
| `http-zip-xml`  | XML inside a ZIP → raw XML string handed to the transform |
| `ods-export`    | OpenDataSoft Explore export (`source:{base,dataset,select,where}`) |
| `dvf-geo`       | streams the French DVF `full.csv.gz` per year and aggregates inline (a heavy raw source must aggregate in the adapter, not hand millions of rows to a transform) |
| `melodi-ipc`    | INSEE *melodi* SDMX API — assembles a multi-query index (all-items + COICOP sub-indices + weights) into one flat feed, with polite `429`/`503` backoff |
| `sncf-lost`     | SNCF lost-property ODS dataset, aggregated inline (avoids the 1.5M-row raw table) |

Adapters live in `src/adapters/` and return raw records; drop a new file in that
folder and register it in `src/adapters/index.js` to add your own. The
`http-json`/`http-csv`/`http-zip-xml` adapters cover most sources — reach for a
dedicated adapter only when a source is too heavy to normalize downstream (`dvf-geo`)
or needs multi-request assembly (`melodi-ipc`).

**Transforms** normalize raw records into the feed:

| transform     | does                                                            |
|---------------|----------------------------------------------------------------|
| `passthrough` | emit records unchanged                                          |
| `map`         | declarative rename / pluck / number-coerce / filter / sample   |
| `fuel-etalab` | parse the French fuel feed, enrich with dept + OSM brand       |
| `irve`        | aggregate French EV charge points → stations (`options.cap` sampling) |
| `dvf-communes`| lift the `dvf-geo` adapter's per-dept/national extras into feed meta |
| `ipc`         | pass INSEE IPC series through, lift assembled base/geo/ranges meta |
| `sncf-lost`   | shape the aggregated SNCF lost-property records                 |

For a clean source, prefer the inline `map` transform — no code. Write a named
transform (a file in `src/transforms/`, registered in its `index.js`) only when
normalization needs real logic or enrichment.

The `map` transform is inline — no code needed for clean sources:

```jsonc
{
  "id": "demo-quakes",
  "adapter": "http-json",
  "url": "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson",
  "options": { "path": "features" },
  "transform": {
    "type": "map",
    "fields": { "id": "id", "mag": "properties.mag", "place": "properties.place",
                "lon": "geometry.coordinates.0", "lat": "geometry.coordinates.1" },
    "number": ["mag", "lat", "lon"],
    "required": ["lat", "lon"]
  },
  "geo": { "lat": "lat", "lon": "lon" },
  "refresh": "15m"
}
```

## Seeded feeds

A fresh instance ships with these open-data feeds already registered (they're
ordinary descriptors, rewritten on every boot from `src/seed.js`; your own
self-registered sources are never touched). Pull any of them at
`/api/feed/<id>` — no token needed.

| id                              | what                                             | source |
|---------------------------------|--------------------------------------------------|--------|
| `fr-fuel-prices`                | live French fuel prices per station              | Etalab (roulez-éco) |
| `fr-ev-chargers`                | French EV charge points → stations               | IRVE / transport.data.gouv |
| `fr-train-stations`             | French railway station list (+ geo)              | SNCF Open Data |
| `fr-train-regularity-tgv`       | TGV monthly regularity                           | SNCF Open Data |
| `fr-train-regularity-intercites`| Intercités monthly regularity                    | SNCF Open Data |
| `fr-train-regularity-ter`       | TER monthly regularity                           | SNCF Open Data |
| `fr-train-punctuality-transilien`| Transilien punctuality                          | SNCF Open Data |
| `fr-lost-objects`               | SNCF lost-property, aggregated                   | SNCF Open Data |
| `fr-dvf-communes`               | per-commune median €/m² real-estate, by year     | DGFiP DVF (geo) |
| `fr-insee-ipc`                  | French CPI (all-items + COICOP divisions)        | INSEE (melodi) |

All are French open data under *Licence Ouverte / Etalab*. Trim or replace the
`SEED_SOURCES` array in `src/seed.js` for a different fleet — nothing else
depends on them being present.

## HTTP API

| method | path                          | auth   | purpose                          |
|--------|-------------------------------|--------|----------------------------------|
| GET    | `/api/sources`                | read   | list sources + status            |
| GET    | `/api/sources/:id`            | read   | one source                       |
| POST   | `/api/sources`                | write  | self-register (or update)        |
| PUT    | `/api/sources/:id`            | write  | update by id                     |
| DELETE | `/api/sources/:id`            | write  | remove                           |
| POST   | `/api/sources/:id/refresh`    | write  | force re-fetch (awaits)          |
| GET    | `/api/feed/:id`               | read   | full feed `{fetchedAt,meta,data}`|
| GET    | `/api/feed/:id/meta`          | read   | metadata only                    |
| GET    | `/api/feed/:id.geojson`       | read   | GeoJSON projection               |
| GET    | `/api/explore/:id`            | read   | filter/sort/page/facet/search    |
| GET    | `/api/explore/:id/record/:rid`| read   | one record by id field           |
| GET    | `/api/explore/:id/points`     | read   | compact geo points for a map     |
| GET    | `/api/dashboards`             | read   | list dashboard configs           |
| GET    | `/api/dashboards/:id`         | read   | one dashboard config             |
| POST   | `/api/dashboards`             | write  | register/replace a dashboard     |
| PUT    | `/api/dashboards/:id`         | write  | update by id                     |
| DELETE | `/api/dashboards/:id`         | write  | remove                           |
| GET    | `/d/:id`                      | —      | themed exploration dashboard SPA |
| POST   | `/mcp`                        | —      | MCP JSON-RPC (Streamable HTTP)   |
| GET    | `/healthz`                    | —      | health                           |

Auth: writes require `SLUICE_TOKEN` via `x-sluice-token` header (or `?token=`).
Reads are open unless `SLUICE_READ_TOKEN` is set.

## JS SDK

```js
import { SluiceClient } from '@zlef/sluice';
const sluice = new SluiceClient({ baseUrl: 'http://127.0.0.1:10099', token });

const { data, meta } = await sluice.feed('fr-fuel-prices');   // pull
await sluice.register({ id, name, adapter, url, transform, refresh }); // self-register
const stop = sluice.watch('fr-fuel-prices', f => update(f.data)); // poll for changes
```

`ensureAndFeed(descriptor)` is the "register-my-source-if-needed, then pull" one-liner a
consuming app uses at boot.

## MCP

Point any MCP client at `POST http://<host>/mcp`. Tools: `list_sources`, `get_source`,
`get_feed`, `feed_meta`, `search_feed`, `register_source`, `refresh_source`.

## Exploration & dashboards

`/api/feed/:id` dumps a whole snapshot; `/api/explore/:id` lets a client **query** it —
filter, sort, paginate, facet, range-stat and full-text search — over the warm in-memory
records, no database. It's the same engine that powers Sluice's zero-frontend dashboards.

```
GET /api/explore/fr-fuel-prices
      ?q=lyon&qf=v,a               full-text over fields v,a
      &eq.b=TotalEnergies          term filter (repeat / comma = OR within a field)
      &min.p.gazole=1.9            numeric range (dot-paths ok)
      &sort=-p.gazole&page=1&pageSize=50
      &facets=b,d                  → value+count buckets per field
      &stats=p.gazole              → {min,max,avg,count,bins} (histogram-ready)
→ { total, filtered, page, pages, rows, facets, stats }
```

A **dashboard** is a second kind of registered object: a JSON config that says how to
*present* a feed (theme palette, i18n copy, facets, numeric metrics, table columns, a
record-detail layout, a geo map, overview charts). Register one and Sluice serves a fully
themeable, deep-linkable exploration SPA at `/d/:id` — no per-app frontend to write. The
same generic UI skins completely from `theme.palette` (injected as CSS custom properties)
so it wears the consuming app's brand, not Sluice's.

```bash
curl -X POST http://127.0.0.1:10099/api/dashboards \
  -H "x-sluice-token: $SLUICE_TOKEN" -H 'content-type: application/json' \
  -d '{ "id":"my-app", "feed":"fr-fuel-prices",
        "theme":{"palette":{"bg":"#fff7ea","ink":"#241247","accent":"#ffb400"}},
        "facets":[{"field":"b","label":{"en":"Brand","fr":"Enseigne"}}],
        "metrics":[{"field":"p.gazole","label":"Diesel","format":"price"}] }'
# → served at /d/my-app
```

Every dashboard URL is a deep link: `?view=table&eq.b=TotalEnergies&sort=-p.gazole` opens
filtered + sorted, and `?record=<id>` opens straight on that record's detail — so an app can
link a user from whatever they clicked into the matching exploration view. A config may also
declare `"hosts":["data.myapp.example"]`; point that hostname's edge at Sluice and
`/api/dashboards/by-host/:host` resolves it, so the dashboard lives on the app's own domain.
See `src/seed-dashboards.js` for a complete reference config (`essence-fuel`).

## Caching & upstream politeness

Sluice is built to hit upstream providers as little as possible:

- **Served from cache, never live.** Every read (`/api/feed`, `/geojson`, MCP, the SDK) is
  answered from the warm in-memory/on-disk snapshot. A consumer request *never* triggers an
  upstream fetch — no matter how many consumers or how often they poll.
- **One upstream fetch per interval.** A source is re-fetched only on its own `refresh`
  schedule (e.g. `6h`). `SLUICE_MIN_REFRESH_MS` (default 5 min) is a hard floor so a
  descriptor can't ask for a punishing cadence.
- **Restart-aware.** On boot a source is refreshed only if its cached snapshot is older than
  its interval, so restarts/redeploys don't re-pull.
- **In-flight dedupe.** Concurrent triggers (a scheduler tick + a manual `/refresh`) collapse
  into a single upstream request.
- **Conditional GET.** Sluice stores the upstream `ETag`/`Last-Modified` and sends
  `If-None-Match`/`If-Modified-Since` on the next refresh. If the upstream answers **304 Not
  Modified**, the cached feed is kept with no re-download and no re-parse. (Upstreams that
  don't emit validators simply fall back to a full fetch.)
- **Client revalidation.** Feed/meta/geojson responses carry `Cache-Control` max-age plus an
  **ETag**; a consumer revalidating an unchanged feed gets an empty `304`. The SDK's
  `watch()` polls the tiny `/meta` and only pulls the full feed when the snapshot changes.

`status.fetchedAt` is when the data last *changed*; `status.checkedAt` is when the upstream
was last *verified* (updated even on a 304).

## Configuration

| env                    | default                | meaning                              |
|------------------------|------------------------|--------------------------------------|
| `PORT`                 | `10099`                | HTTP port                            |
| `SLUICE_DATA_DIR`      | `./data`               | registry + feed cache location       |
| `SLUICE_TOKEN`         | *(unset → writes off)* | write token                          |
| `SLUICE_READ_TOKEN`    | *(unset → reads open)* | optional read token                  |
| `SLUICE_USER_AGENT`    | `Sluice/1.0 …`         | UA sent to upstreams                 |
| `SLUICE_MIN_REFRESH_MS`| `300000`               | global refresh floor (protect upstreams) |

## License

MIT.
