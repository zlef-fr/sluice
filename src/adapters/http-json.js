// Fetch a JSON document and coerce it to an array of records.
// options: { path } — dotted path to the array inside the document (optional).
import { pluck, toArray } from '../util.js';
import { conditionalFetch } from './http.js';

export default async function httpJson(descriptor, ctx = {}) {
  const { res, notModified, validators } = await conditionalFetch(descriptor.url, {
    headers: { Accept: 'application/json', ...(descriptor.options.headers || {}) },
    validators: ctx.validators,
  });
  if (notModified) return { notModified: true, validators };

  const buf = Buffer.from(await res.arrayBuffer());
  const doc = JSON.parse(buf.toString('utf8'));
  const rooted = descriptor.options.path ? pluck(doc, descriptor.options.path) : doc;
  return { records: toArray(rooted), bytes: buf.length, validators };
}
