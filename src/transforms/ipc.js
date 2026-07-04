// IPC transform: the melodi-ipc adapter already emits clean, self-describing
// series records — just pass them through and lift the adapter's assembled
// metadata (base, geo, ranges, division list) out of ctx.raw into the feed meta.
import { nowIso } from '../util.js';

export default function ipc(records, descriptor, ctx = {}) {
  const data = Array.isArray(records) ? records : [];
  return { data, meta: { ...(ctx.raw || {}), count: data.length, builtAt: nowIso() } };
}
