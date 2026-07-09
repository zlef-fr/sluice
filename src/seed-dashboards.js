// Batteries-included dashboard configs, (re)written every boot the same way
// SEED_SOURCES are — preserving createdAt, never clobbering user-registered ids.
// The essence-fuel config doubles as the reference example for the config schema:
// it exercises term facets (with meta-driven value labels), numeric metrics with
// range filters + sort, a geo map, overview charts, and full en/fr theming.

// Shared dark "maps.zlef.fr" DA (zlef design system — near-black bg, warm-neutral
// ink, per-map accent). Every maps-* dashboard below is the data twin of a live
// map on maps.zlef.fr and links back to it, so it wears the same dark skin.
const mapsTheme = (accent, accentDark) => ({
  palette: {
    bg: '#06060a',
    surface: '#0e0e13',
    ink: '#e9eae2',
    inkSoft: '#b6b7ad',
    inkMute: '#7d7e76',
    border: 'rgba(255,255,255,0.13)',
    accent,
    accentDark,
    accentSoft: 'rgba(255,255,255,0.06)',
    danger: '#d1685c',
    dangerSoft: 'rgba(209,104,92,0.14)',
  },
  font: 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  fontDisplay: 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  radius: '14px',
});

export const SEED_DASHBOARDS = [
  {
    id: 'essence-fuel',
    name: 'Essence — Explorateur des stations',
    feed: 'fr-fuel-prices',
    idField: 'id',
    // Reserved for when essence wires a subdomain at its Cloudflare edge; unused
    // until then (served at /d/essence-fuel meanwhile).
    hosts: ['data.essence.zlef.fr'],
    locales: ['en', 'fr'],
    defaultLocale: 'en',

    // Essence's own game-show DA (cream / deep-purple ink / gold / red, Fredoka +
    // Nunito) — proving the same generic SPA skins completely from config.
    theme: {
      palette: {
        bg: '#fff7ea',
        surface: '#ffffff',
        ink: '#241247',
        inkSoft: '#5c4a78',
        inkMute: '#9184a6',
        border: '#efe3d0',
        accent: '#ffb400',
        accentDark: '#d98e00',
        accentSoft: '#fff2cf',
        danger: '#ef2d56',
        dangerSoft: '#ffe1e8',
      },
      font: '"Nunito", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
      fontDisplay: '"Fredoka", ui-rounded, "Segoe UI", sans-serif',
      fontUrl:
        'https://fonts.googleapis.com/css2?family=Fredoka:wght@500;600;700&family=Nunito:wght@400;600;700;800&display=swap',
      radius: '18px',
    },

    branding: {
      logoText: '⛽ Essence',
      homeUrl: 'https://essence.zlef.fr',
      homeLabel: { en: 'Play the game', fr: 'Jouer' },
      footer: {
        en: 'Live data: French government open data (prix-carburants, data.gouv.fr). Explorer powered by Sluice.',
        fr: 'Données en direct : open data prix-carburants (data.gouv.fr). Explorateur propulsé par Sluice.',
      },
    },

    i18n: {
      en: {
        title: 'Fuel stations of France',
        subtitle:
          'Explore every French service station and its live pump prices — filter by brand, department and fuel.',
        searchPlaceholder: 'Search a town, address or brand…',
      },
      fr: {
        title: 'Les stations-service de France',
        subtitle:
          'Explorez chaque station française et ses prix à la pompe en direct — filtrez par enseigne, département et carburant.',
        searchPlaceholder: 'Rechercher une ville, adresse ou enseigne…',
      },
    },

    // How a record shows up in lists, the map and the detail header.
    record: {
      title: 'v',
      subtitle: 'a',
      badge: 'b',
    },

    search: { fields: ['v', 'a', 'b', 'id'] },

    // Categorical filters. `labelsFromMeta` pulls human labels for coded values
    // from the feed's own meta (dept "13" → "Bouches-du-Rhône").
    facets: [
      { field: 'b', label: { en: 'Brand', fr: 'Enseigne' } },
      { field: 'd', label: { en: 'Department', fr: 'Département' }, labelsFromMeta: 'depts' },
    ],

    // Numeric metrics → range-filterable + sortable + shown in detail. `€` prices
    // rendered to 3 decimals (French pump convention).
    metrics: [
      { field: 'p.gazole', label: { en: 'Diesel', fr: 'Gazole' }, unit: '€', format: 'price' },
      { field: 'p.e10', label: 'E10', unit: '€', format: 'price' },
      { field: 'p.sp95', label: 'SP95', unit: '€', format: 'price' },
      { field: 'p.sp98', label: 'SP98', unit: '€', format: 'price' },
      { field: 'p.e85', label: { en: 'E85 (Superethanol)', fr: 'E85 (Superéthanol)' }, unit: '€', format: 'price' },
      { field: 'p.gplc', label: 'GPLc', unit: '€', format: 'price' },
    ],

    // The collection table.
    columns: [
      { field: 'v', label: { en: 'Town', fr: 'Ville' }, primary: true },
      { field: 'd', label: { en: 'Dept', fr: 'Dép.' }, labelsFromMeta: 'depts' },
      { field: 'b', label: { en: 'Brand', fr: 'Enseigne' } },
      { field: 'p.gazole', label: { en: 'Diesel', fr: 'Gazole' }, format: 'price' },
      { field: 'p.e10', label: 'E10', format: 'price' },
      { field: 'p.sp98', label: 'SP98', format: 'price' },
    ],

    sort: { default: 'v' },

    // Geo view: colour points by diesel price on a France scatter.
    map: { lat: 'la', lon: 'lo', colorBy: 'p.gazole', colorLabel: { en: 'Diesel €', fr: 'Gazole €' } },

    charts: [
      {
        type: 'bar',
        source: 'facet',
        field: 'b',
        limit: 12,
        title: { en: 'Stations by brand', fr: 'Stations par enseigne' },
      },
      {
        type: 'histogram',
        source: 'stat',
        field: 'p.gazole',
        title: { en: 'Diesel price distribution', fr: 'Répartition du prix du gazole' },
      },
    ],
  },

  // ── maps.zlef.fr · ⛽ Fuel stations ────────────────────────────────────
  // Same fr-fuel-prices feed as essence-fuel, but skinned in the dark maps DA
  // and linking back to the map at maps.zlef.fr/carburants (its "explore the
  // data" companion).
  {
    id: 'maps-fuel',
    name: 'Cartes — Stations-service',
    feed: 'fr-fuel-prices',
    idField: 'id',
    hosts: ['data.maps.zlef.fr'],
    locales: ['en', 'fr'],
    defaultLocale: 'en',
    theme: mapsTheme('#9dae50', '#59642a'),
    branding: {
      logoText: '⛽ Cartes',
      homeUrl: 'https://maps.zlef.fr/carburants',
      homeLabel: { en: 'Open the map', fr: 'Ouvrir la carte' },
      footer: {
        en: 'Open data: prix-carburants (data.gouv.fr / Etalab). The map lives at maps.zlef.fr/carburants — explorer powered by Sluice.',
        fr: 'Open data : prix-carburants (data.gouv.fr / Etalab). La carte est sur maps.zlef.fr/carburants — explorateur propulsé par Sluice.',
      },
    },
    i18n: {
      en: {
        title: 'Fuel stations of France',
        subtitle: 'Explore every French filling station and its live pump prices — filter by brand, department and fuel.',
        searchPlaceholder: 'Search a town, address or brand…',
      },
      fr: {
        title: 'Les stations-service de France',
        subtitle: 'Explorez chaque station française et ses prix à la pompe en direct — filtrez par enseigne, département et carburant.',
        searchPlaceholder: 'Rechercher une ville, adresse ou enseigne…',
      },
    },
    record: { title: 'v', subtitle: 'a', badge: 'b' },
    search: { fields: ['v', 'a', 'b', 'id'] },
    facets: [
      { field: 'b', label: { en: 'Brand', fr: 'Enseigne' } },
      { field: 'd', label: { en: 'Department', fr: 'Département' }, labelsFromMeta: 'depts' },
    ],
    metrics: [
      { field: 'p.gazole', label: { en: 'Diesel', fr: 'Gazole' }, unit: '€', format: 'price' },
      { field: 'p.e10', label: 'E10', unit: '€', format: 'price' },
      { field: 'p.sp95', label: 'SP95', unit: '€', format: 'price' },
      { field: 'p.sp98', label: 'SP98', unit: '€', format: 'price' },
      { field: 'p.e85', label: { en: 'E85 (Superethanol)', fr: 'E85 (Superéthanol)' }, unit: '€', format: 'price' },
      { field: 'p.gplc', label: 'GPLc', unit: '€', format: 'price' },
    ],
    columns: [
      { field: 'v', label: { en: 'Town', fr: 'Ville' }, primary: true },
      { field: 'd', label: { en: 'Dept', fr: 'Dép.' }, labelsFromMeta: 'depts' },
      { field: 'b', label: { en: 'Brand', fr: 'Enseigne' } },
      { field: 'p.gazole', label: { en: 'Diesel', fr: 'Gazole' }, format: 'price' },
      { field: 'p.e10', label: 'E10', format: 'price' },
      { field: 'p.sp98', label: 'SP98', format: 'price' },
    ],
    sort: { default: 'v' },
    map: { lat: 'la', lon: 'lo', colorBy: 'p.gazole', colorLabel: { en: 'Diesel €', fr: 'Gazole €' } },
    charts: [
      { type: 'bar', source: 'facet', field: 'b', limit: 12, title: { en: 'Stations by brand', fr: 'Stations par enseigne' } },
      { type: 'histogram', source: 'stat', field: 'p.gazole', title: { en: 'Diesel price distribution', fr: 'Répartition du prix du gazole' } },
    ],
  },

  // ── maps.zlef.fr · ⚡ EV chargers ──────────────────────────────────────
  {
    id: 'maps-ev',
    name: 'Cartes — Bornes de recharge',
    feed: 'fr-ev-chargers',
    idField: 'id',
    hosts: ['data.maps.zlef.fr'],
    locales: ['en', 'fr'],
    defaultLocale: 'en',
    theme: mapsTheme('#b095b3', '#6b5470'),
    branding: {
      logoText: '⚡ Cartes',
      homeUrl: 'https://maps.zlef.fr/recharge',
      homeLabel: { en: 'Open the map', fr: 'Ouvrir la carte' },
      footer: {
        en: 'Open data: consolidated IRVE charge points (data.gouv.fr / ODRE). The map lives at maps.zlef.fr/recharge — explorer powered by Sluice.',
        fr: 'Open data : IRVE consolidé des bornes de recharge (data.gouv.fr / ODRE). La carte est sur maps.zlef.fr/recharge — explorateur propulsé par Sluice.',
      },
    },
    i18n: {
      en: {
        title: 'EV charging stations of France',
        subtitle: 'Explore every public charge point — filter by operator, department and charging power.',
        searchPlaceholder: 'Search a town or operator…',
      },
      fr: {
        title: 'Les bornes de recharge de France',
        subtitle: 'Explorez chaque borne de recharge publique — filtrez par opérateur, département et puissance de charge.',
        searchPlaceholder: 'Rechercher une ville ou un opérateur…',
      },
    },
    record: { title: 'v', subtitle: 'o' },
    search: { fields: ['v', 'o', 'id'] },
    facets: [
      { field: 'o', label: { en: 'Operator', fr: 'Opérateur' } },
      { field: 'd', label: { en: 'Department', fr: 'Département' }, labelsFromMeta: 'depts' },
    ],
    metrics: [
      { field: 'kw', label: { en: 'Peak power', fr: 'Puissance max' }, unit: ' kW' },
    ],
    columns: [
      { field: 'v', label: { en: 'Town', fr: 'Ville' }, primary: true },
      { field: 'd', label: { en: 'Dept', fr: 'Dép.' }, labelsFromMeta: 'depts' },
      { field: 'o', label: { en: 'Operator', fr: 'Opérateur' } },
      { field: 'kw', label: { en: 'Power', fr: 'Puissance' }, unit: ' kW' },
    ],
    sort: { default: '-kw' },
    map: { lat: 'la', lon: 'lo', colorBy: 'kw', colorLabel: { en: 'Power kW', fr: 'Puissance kW' } },
    charts: [
      { type: 'bar', source: 'facet', field: 'o', limit: 12, title: { en: 'Chargers by operator', fr: 'Bornes par opérateur' } },
      { type: 'histogram', source: 'stat', field: 'kw', title: { en: 'Charging-power distribution', fr: 'Répartition de la puissance' } },
    ],
  },

  // ── maps.zlef.fr · 🚉 Train stations ───────────────────────────────────
  // The fr-train-stations feed powers the "gares" layer of the transports map.
  // No unique id in the SNCF list → key rows by libelle.
  {
    id: 'maps-gares',
    name: 'Cartes — Gares de France',
    feed: 'fr-train-stations',
    idField: 'libelle',
    hosts: ['data.maps.zlef.fr'],
    locales: ['en', 'fr'],
    defaultLocale: 'en',
    theme: mapsTheme('#5aa9c2', '#3d7e93'),
    branding: {
      logoText: '🚉 Cartes',
      homeUrl: 'https://maps.zlef.fr/transports',
      homeLabel: { en: 'Open the map', fr: 'Ouvrir la carte' },
      footer: {
        en: 'Open data: liste des gares (SNCF, data.gouv.fr). The gares layer lives on the transport map at maps.zlef.fr/transports — explorer powered by Sluice.',
        fr: 'Open data : liste des gares (SNCF, data.gouv.fr). La couche gares est sur la carte des transports, maps.zlef.fr/transports — explorateur propulsé par Sluice.',
      },
    },
    i18n: {
      en: {
        title: 'Train stations of France',
        subtitle: 'Explore every SNCF station — filter by department and whether it serves passengers.',
        searchPlaceholder: 'Search a station or town…',
      },
      fr: {
        title: 'Les gares de France',
        subtitle: 'Explorez chaque gare SNCF — filtrez par département et selon qu’elle accueille des voyageurs.',
        searchPlaceholder: 'Rechercher une gare ou une ville…',
      },
    },
    record: { title: 'libelle', subtitle: 'commune', badge: 'departemen' },
    search: { fields: ['libelle', 'commune', 'departemen'] },
    facets: [
      { field: 'departemen', label: { en: 'Department', fr: 'Département' } },
      { field: 'voyageurs', label: { en: 'Passenger station', fr: 'Accueil voyageurs' } },
    ],
    metrics: [],
    columns: [
      { field: 'libelle', label: { en: 'Station', fr: 'Gare' }, primary: true },
      { field: 'commune', label: { en: 'Town', fr: 'Commune' } },
      { field: 'departemen', label: { en: 'Department', fr: 'Département' } },
      { field: 'voyageurs', label: { en: 'Passengers', fr: 'Voyageurs' } },
    ],
    sort: { default: 'libelle' },
    map: { lat: 'c_geo.lat', lon: 'c_geo.lon' },
    charts: [
      { type: 'bar', source: 'facet', field: 'departemen', limit: 14, title: { en: 'Stations by department', fr: 'Gares par département' } },
    ],
  },
];
