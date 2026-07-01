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

Plain Node + Express, JSON-on-disk (no database). `npm i && npm start`.

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

**Transforms** normalize raw records into the feed:

| transform     | does                                                            |
|---------------|----------------------------------------------------------------|
| `passthrough` | emit records unchanged                                          |
| `map`         | declarative rename / pluck / number-coerce / filter / sample   |
| `fuel-etalab` | parse the French fuel feed, enrich with dept + OSM brand       |
| `irve`        | aggregate French EV charge points → stations                   |

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
