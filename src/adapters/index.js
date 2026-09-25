// Adapters know how to FETCH + PARSE a remote source into raw records
// (an array of plain objects). They do not normalize — that's the transform's
// job. Adding a new upstream shape = one file here + one line in the map.
import httpJson from './http-json.js';
import httpCsv from './http-csv.js';
import httpZipXml from './http-zip-xml.js';
import httpArtifact from './http-artifact.js';
import odsExport from './ods-export.js';
import dvfGeo from './dvf-geo.js';
import melodiIpc from './melodi-ipc.js';
import sncfLost from './sncf-lost.js';
import hubeauPaginated from './hubeau-paginated.js';
import tpdbPerformers from './tpdb-performers.js';

const ADAPTERS = {
  'http-json': httpJson,
  'http-csv': httpCsv,
  'http-zip-xml': httpZipXml,
  'http-artifact': httpArtifact,
  'ods-export': odsExport,
  'dvf-geo': dvfGeo,
  'melodi-ipc': melodiIpc,
  'sncf-lost': sncfLost,
  'hubeau-paginated': hubeauPaginated,
  'tpdb-performers': tpdbPerformers,
};

export function hasAdapter(name) {
  return Object.prototype.hasOwnProperty.call(ADAPTERS, name);
}

export function getAdapter(name) {
  return ADAPTERS[name] || null;
}

// Adapters whose output is a FILE (served from /api/artifact) rather than records.
const ARTIFACT_ADAPTERS = new Set(['http-artifact', 'hubeau-paginated', 'tpdb-performers']);

export function isArtifactAdapter(name) {
  return ARTIFACT_ADAPTERS.has(name);
}

export function adapterNames() {
  return Object.keys(ADAPTERS);
}

// Each adapter is: async (descriptor) => { records: [...], bytes: number }
