// Built-in "batteries-included" sources. These are the shared open-data feeds
// the zlef ecosystem already depends on (essence.zlef.fr today, maps.zlef.fr
// next), registered on boot so a fresh deploy is immediately useful. They are
// ordinary descriptors — a self-registered source is no different.
//
// Seeds are (re)written on every boot so upgrades to the descriptor ship with
// the code; user-registered sources are never touched.
export const SEED_SOURCES = [
  // ── INSEE consumer prices (inflation) ───────────────────────────────────
  // The French CPI (IPC). Not one document: the all-items index plus COICOP
  // division sub-indices and their weights, each a separate melodi query. The
  // `melodi-ipc` adapter assembles them into one flat feed of self-describing
  // series records (2 all-items + 13 divisions). Consumed by inflation.zlef.fr.
  {
    id: 'fr-insee-ipc',
    name: 'Indice des prix à la consommation (IPC, INSEE)',
    description:
      'French Consumer Price Index from INSEE (melodi DS_IPC_PRINC, base 2025=100, France, all '
      + 'households, non seasonally adjusted): all-items index (annual since 1996 + monthly) and the '
      + '13 COICOP-2018 division sub-indices with their latest expenditure weights. One record per '
      + 'series: {kind, freq, code?, weight?, values:{period:index}}. Year-on-year is computed downstream.',
    adapter: 'melodi-ipc',
    source: {
      api: 'https://api.insee.fr/melodi/data',
      dataflow: 'DS_IPC_PRINC',
      geo: '2025-FRANCE-F',
      tph: '_T',
      seasonalAdjust: 'N',
      base: '2025 = 100',
      divisions: ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13'],
    },
    transform: 'ipc',
    refresh: '7d',
    license: 'Licence Ouverte 2.0 (Etalab)',
    homepage: 'https://www.insee.fr/fr/statistiques/serie/000436387',
    attribution: 'Indice des prix à la consommation — INSEE (Licence Ouverte 2.0)',
    tags: ['france', 'economy', 'inflation', 'prices', 'insee'],
    owner: 'sluice',
  },
  {
    id: 'fr-fuel-prices',
    name: 'Prix des carburants (France)',
    description:
      'Every French filling station with live per-fuel prices (gazole, SP95, SP98, E10, E85, GPLc), '
      + 'enriched with department (from postcode) and brand (nearest OpenStreetMap fuel node).',
    adapter: 'http-zip-xml',
    url: 'https://donnees.roulez-eco.fr/opendata/instantane',
    options: { encoding: 'latin1' },
    transform: 'fuel-etalab',
    refresh: '6h',
    geo: { lat: 'la', lon: 'lo' },
    license: 'Licence Ouverte / Etalab',
    homepage: 'https://www.prix-carburants.gouv.fr/',
    attribution: 'Prix des carburants — Ministère de l’Économie (Etalab)',
    tags: ['france', 'energy', 'fuel', 'geo'],
    owner: 'sluice',
  },
  {
    id: 'fr-ev-chargers',
    name: 'Bornes de recharge IRVE (France)',
    description:
      'Public EV charging stations in France (IRVE consolidé), aggregated to one point per station '
      + 'with peak power (kW), operator and connector types (Type 2 / CCS / CHAdeMO).',
    adapter: 'ods-export',
    source: {
      base: 'https://odre.opendatasoft.com',
      dataset: 'bornes-irve',
      select: [
        'id_station_itinerance', 'nom_operateur', 'nom_enseigne',
        'consolidated_longitude', 'consolidated_latitude', 'consolidated_commune',
        'consolidated_code_postal', 'puissance_nominale',
        'prise_type_2', 'prise_type_combo_ccs', 'prise_type_chademo', 'prise_type_ef',
        'implantation_station',
      ],
    },
    transform: 'irve',
    refresh: '24h',
    geo: { lat: 'la', lon: 'lo' },
    license: 'Licence Ouverte / Etalab',
    homepage: 'https://odre.opendatasoft.com/explore/dataset/bornes-irve',
    attribution: 'IRVE consolidé — data.gouv.fr (ODRE)',
    tags: ['france', 'energy', 'ev', 'geo'],
    owner: 'sluice',
  },

  // ── SNCF (train) open data ──────────────────────────────────────────────
  // Shared by maps.zlef.fr (station point map) and retard.zlef.fr (delay odds +
  // arc map). Small OpenDataSoft datasets served raw (passthrough) so each
  // consumer applies its own filtering/aggregation, exactly as before — the only
  // change is who downloads: Sluice, once, for everyone.
  {
    id: 'fr-train-stations',
    name: 'Gares de voyageurs (SNCF)',
    description:
      'Every French railway station (SNCF « liste des gares ») with commune, department, '
      + 'passenger flag and WGS84 coordinates. Raw fields, unfiltered — filter voyageurs="O" downstream.',
    adapter: 'ods-export',
    source: {
      base: 'https://ressources.data.sncf.com',
      dataset: 'liste-des-gares',
      select: ['libelle', 'commune', 'departemen', 'voyageurs', 'c_geo', 'geo_point_2d'],
    },
    transform: 'passthrough',
    refresh: '30d',
    geo: { lat: 'c_geo.lat', lon: 'c_geo.lon' },
    license: 'Licence Ouverte / Etalab',
    homepage: 'https://ressources.data.sncf.com/explore/dataset/liste-des-gares',
    attribution: 'Liste des gares — SNCF (Licence Ouverte)',
    tags: ['france', 'transport', 'train', 'geo'],
    owner: 'sluice',
  },
  {
    id: 'fr-train-regularity-tgv',
    name: 'Régularité mensuelle TGV (SNCF/AQST)',
    description:
      'Monthly TGV punctuality per origin→destination liaison: trains scheduled/cancelled, '
      + 'delay buckets (>15/30/60 min), mean delay and cause breakdown. Raw AQST records.',
    adapter: 'ods-export',
    source: { base: 'https://ressources.data.sncf.com', dataset: 'regularite-mensuelle-tgv-aqst' },
    transform: 'passthrough',
    refresh: '7d',
    license: 'Licence Ouverte / Etalab',
    homepage: 'https://ressources.data.sncf.com/explore/dataset/regularite-mensuelle-tgv-aqst',
    attribution: 'Régularité mensuelle TGV — SNCF / AQST (Licence Ouverte)',
    tags: ['france', 'transport', 'train', 'punctuality'],
    owner: 'sluice',
  },
  {
    id: 'fr-train-regularity-intercites',
    name: 'Régularité mensuelle Intercités (SNCF)',
    description:
      'Monthly Intercités punctuality per liaison: trains scheduled/cancelled and lateness rate. Raw records.',
    adapter: 'ods-export',
    source: { base: 'https://ressources.data.sncf.com', dataset: 'regularite-mensuelle-intercites' },
    transform: 'passthrough',
    refresh: '7d',
    license: 'Licence Ouverte / Etalab',
    homepage: 'https://ressources.data.sncf.com/explore/dataset/regularite-mensuelle-intercites',
    attribution: 'Régularité mensuelle Intercités — SNCF (Licence Ouverte)',
    tags: ['france', 'transport', 'train', 'punctuality'],
    owner: 'sluice',
  },
  {
    id: 'fr-train-punctuality-transilien',
    name: 'Ponctualité mensuelle Transilien (SNCF)',
    description:
      'Monthly Transilien (Paris RER/suburban) punctuality per line. Raw records.',
    adapter: 'ods-export',
    source: { base: 'https://ressources.data.sncf.com', dataset: 'ponctualite-mensuelle-transilien' },
    transform: 'passthrough',
    refresh: '7d',
    license: 'Licence Ouverte / Etalab',
    homepage: 'https://ressources.data.sncf.com/explore/dataset/ponctualite-mensuelle-transilien',
    attribution: 'Ponctualité mensuelle Transilien — SNCF (Licence Ouverte)',
    tags: ['france', 'transport', 'train', 'punctuality'],
    owner: 'sluice',
  },
  {
    id: 'fr-train-regularity-ter',
    name: 'Régularité mensuelle TER (SNCF)',
    description:
      'Monthly TER punctuality per region. Raw records.',
    adapter: 'ods-export',
    source: { base: 'https://ressources.data.sncf.com', dataset: 'regularite-mensuelle-ter' },
    transform: 'passthrough',
    refresh: '7d',
    license: 'Licence Ouverte / Etalab',
    homepage: 'https://ressources.data.sncf.com/explore/dataset/regularite-mensuelle-ter',
    attribution: 'Régularité mensuelle TER — SNCF (Licence Ouverte)',
    tags: ['france', 'transport', 'train', 'punctuality'],
    owner: 'sluice',
  },

  // ── DVF (property prices) ───────────────────────────────────────────────
  // The shared French real-estate price source for foncier.zlef.fr, m2.zlef.fr
  // and heat.zlef.fr. The upstream is ~100 MB/year × 5 years of raw transactions;
  // the `dvf-geo` adapter streams + aggregates it to a compact per-commune × year
  // median €/m² table (≈33k records), computed once here for the whole fleet.
  {
    id: 'fr-dvf-communes',
    name: 'Valeurs foncières par commune (DVF)',
    description:
      'Median residential price €/m² per French commune and year (2021–2025), from Etalab '
      + 'geo-dvf: sales of flats/houses, surface > 9 m², 500–30000 €/m². Per-commune overall / '
      + 'flat (a) / house (m) medians + sale count; department & national medians in meta.',
    adapter: 'dvf-geo',
    source: {
      base: 'https://files.data.gouv.fr/geo-dvf/latest/csv',
      file: 'full.csv.gz',
      years: [2021, 2022, 2023, 2024, 2025],
    },
    transform: 'dvf-communes',
    refresh: '30d',
    geo: { lat: 'lat', lon: 'lon' },
    license: 'Licence Ouverte / Etalab',
    homepage: 'https://files.data.gouv.fr/geo-dvf/latest/csv/',
    attribution: 'Demandes de valeurs foncières (DVF) — Etalab / DGFiP (geo-dvf)',
    tags: ['france', 'realestate', 'dvf', 'geo'],
    owner: 'sluice',
  },
];
