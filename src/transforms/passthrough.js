// Identity transform: emit the records as-is, with a minimal count meta.
// Useful when the upstream is already clean and the consumer wants everything.
import { nowIso } from '../util.js';

export default function passthrough(records) {
  const data = Array.isArray(records) ? records : [];
  return { data, meta: { count: data.length, builtAt: nowIso() } };
}
