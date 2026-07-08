// Adapters know how to FETCH + PARSE a remote source into raw records
// (an array of plain objects). They do not normalize — that's the transform's
// job. Adding a new upstream shape = one file here + one line in the map.
import httpJson from './http-json.js';
import httpCsv from './http-csv.js';
import httpZipXml from './http-zip-xml.js';
import odsExport from './ods-export.js';
import dvfGeo from './dvf-geo.js';
import melodiIpc from './melodi-ipc.js';
import sncfLost from './sncf-lost.js';

const ADAPTERS = {
  'http-json': httpJson,
  'http-csv': httpCsv,
  'http-zip-xml': httpZipXml,
  'ods-export': odsExport,
  'dvf-geo': dvfGeo,
  'melodi-ipc': melodiIpc,
  'sncf-lost': sncfLost,
};

export function hasAdapter(name) {
  return Object.prototype.hasOwnProperty.call(ADAPTERS, name);
}

export function getAdapter(name) {
  return ADAPTERS[name] || null;
}

export function adapterNames() {
  return Object.keys(ADAPTERS);
}

// Each adapter is: async (descriptor) => { records: [...], bytes: number }
