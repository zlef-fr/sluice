// Declarative mapping transform — covers the "clean JSON/CSV, just rename &
// filter" case without writing code. Spec (descriptor.transform when it's an
// object, or transform:"map" with the spec spread onto the descriptor):
//
//   {
//     type: 'map',
//     fields:   { out: 'in.path', ... },   // rename/pluck (dotted paths)
//     number:   ['la','lo','kw'],          // coerce these OUTPUT keys to Number
//     bool:     ['open'],                   // coerce truthy strings to boolean
//     required: ['la','lo'],               // drop records missing any of these
//     limit:    20000,                      // cap output length (even sampling)
//   }
import { pluck, nowIso } from '../util.js';

const truthy = (v) => v === true || v === 1 || /^(true|1|yes|oui|y|o)$/i.test(String(v ?? ''));

export default function declarativeMap(records, descriptor, _ctx, spec) {
  spec = spec || {};
  const fields = spec.fields || null;
  const numberKeys = new Set(spec.number || []);
  const boolKeys = new Set(spec.bool || []);
  const required = spec.required || [];

  let data = (Array.isArray(records) ? records : []).map((rec) => {
    const out = fields ? {} : { ...rec };
    if (fields) for (const [k, path] of Object.entries(fields)) out[k] = pluck(rec, path);
    for (const k of numberKeys) {
      const n = Number(out[k]);
      out[k] = Number.isFinite(n) ? n : null;
    }
    for (const k of boolKeys) out[k] = truthy(out[k]);
    return out;
  });

  if (required.length) {
    data = data.filter((r) => required.every((k) => r[k] != null && r[k] !== ''));
  }

  if (spec.limit && data.length > spec.limit) {
    const step = data.length / spec.limit;
    const sampled = [];
    for (let i = 0; i < data.length; i += step) sampled.push(data[Math.floor(i)]);
    data = sampled;
  }

  return { data, meta: { count: data.length, builtAt: nowIso() } };
}
