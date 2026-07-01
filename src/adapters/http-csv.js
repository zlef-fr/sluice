// Fetch a CSV/TSV document and parse it into row objects keyed by header.
// A small dependency-free parser that handles quoted fields, embedded quotes
// ("" → ") and newlines inside quotes — enough for the messy real-world CSVs
// French open-data portals serve.
// options: { delimiter (default ,), encoding (default utf8) }
import { USER_AGENT } from '../config.js';

export default async function httpCsv(descriptor) {
  const res = await fetch(descriptor.url, {
    headers: { 'User-Agent': USER_AGENT, ...(descriptor.options.headers || {}) },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${descriptor.url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString(descriptor.options.encoding || 'utf8');
  const delim = descriptor.options.delimiter || ',';
  const rows = parseCsv(text, delim);
  if (!rows.length) return { records: [], bytes: buf.length };
  const header = rows[0];
  const records = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length === 1 && r[0] === '') continue; // trailing blank line
    const obj = {};
    for (let c = 0; c < header.length; c++) obj[header[c]] = r[c] ?? '';
    records.push(obj);
  }
  return { records, bytes: buf.length };
}

function parseCsv(text, delim) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      row.push(field); field = '';
    } else if (ch === '\n') {
      row.push(field); field = ''; rows.push(row); row = [];
    } else if (ch === '\r') {
      /* skip — \r\n handled by the \n branch */
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}
