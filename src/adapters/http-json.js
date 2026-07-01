// Fetch a JSON document and coerce it to an array of records.
// options: { path } — dotted path to the array inside the document (optional).
import { USER_AGENT } from '../config.js';
import { pluck, toArray } from '../util.js';

export default async function httpJson(descriptor) {
  const res = await fetch(descriptor.url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...(descriptor.options.headers || {}) },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${descriptor.url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const doc = JSON.parse(buf.toString('utf8'));
  const rooted = descriptor.options.path ? pluck(doc, descriptor.options.path) : doc;
  return { records: toArray(rooted), bytes: buf.length };
}
