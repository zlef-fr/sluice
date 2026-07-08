// Batteries-included dashboard configs, (re)written every boot the same way
// SEED_SOURCES are — preserving createdAt, never clobbering user-registered ids.
// The essence-fuel config doubles as the reference example for the config schema:
// it exercises term facets (with meta-driven value labels), numeric metrics with
// range filters + sort, a geo map, overview charts, and full en/fr theming.

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
];
