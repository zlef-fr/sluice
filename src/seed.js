// Built-in "batteries-included" sources. These are the shared open-data feeds
// the zlef ecosystem already depends on (essence.zlef.fr today, maps.zlef.fr
// next), registered on boot so a fresh deploy is immediately useful. They are
// ordinary descriptors — a self-registered source is no different.
//
// Seeds are (re)written on every boot so upgrades to the descriptor ship with
// the code; user-registered sources are never touched.
export const SEED_SOURCES = [
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
];
