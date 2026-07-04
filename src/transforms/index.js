// Transforms turn raw adapter records into a NORMALIZED feed:
//   (records, descriptor, ctx) => { data: [...], meta: {...} }
// ctx carries adapter extras (e.g. ctx.raw for the zip-xml adapter).
//
// A descriptor.transform is either:
//   • a string  → a named built-in transform below, or
//   • an object → an inline declarative mapping handled by ./map.js
import passthrough from './passthrough.js';
import declarativeMap from './map.js';
import fuelEtalab from './fuel-etalab.js';
import irve from './irve.js';
import dvfCommunes from './dvf-communes.js';
import ipc from './ipc.js';

const TRANSFORMS = {
  passthrough,
  map: (records, descriptor, ctx) => declarativeMap(records, descriptor, ctx, descriptor.transform),
  'fuel-etalab': fuelEtalab,
  irve,
  'dvf-communes': dvfCommunes,
  ipc,
};

export function hasTransform(name) {
  return Object.prototype.hasOwnProperty.call(TRANSFORMS, name);
}

export function transformNames() {
  return Object.keys(TRANSFORMS);
}

// Resolve + run the transform for a descriptor.
export async function runTransform(descriptor, records, ctx) {
  const t = descriptor.transform;
  if (t && typeof t === 'object') {
    // inline declarative mapping
    return declarativeMap(records, descriptor, ctx, t);
  }
  const fn = TRANSFORMS[t] || passthrough;
  return fn(records, descriptor, ctx);
}

// One-time init hook (transforms that need to load data, e.g. brand snapshot).
export async function initTransforms() {
  await fuelEtalab.init?.();
}
