// Fetch a ZIP archive, pull out the first (or named) XML entry, and hand its
// raw text to the transform. XML shapes are too varied to auto-flatten into
// records generically, so this adapter exposes the raw string via ctx.raw and
// lets the (usually source-specific) transform do the parse.
// options: { entry (substring/suffix to select the XML file), encoding (default latin1) }
import AdmZip from 'adm-zip';
import { USER_AGENT } from '../config.js';

export default async function httpZipXml(descriptor) {
  const res = await fetch(descriptor.url, {
    headers: { 'User-Agent': USER_AGENT, ...(descriptor.options.headers || {}) },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${descriptor.url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const zip = new AdmZip(buf);
  const want = descriptor.options.entry;
  const entries = zip.getEntries();
  const entry = want
    ? entries.find((e) => e.entryName.includes(want))
    : entries.find((e) => e.entryName.endsWith('.xml')) || entries[0];
  if (!entry) throw new Error('no matching entry inside ZIP');
  const raw = entry.getData().toString(descriptor.options.encoding || 'latin1');
  return { records: [], raw, entryName: entry.entryName, bytes: buf.length };
}
