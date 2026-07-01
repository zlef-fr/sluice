// Fuel-station brand enrichment. The official price feed has NO brand/enseigne
// field, so we match each station to the nearest OpenStreetMap fuel node that
// carries a brand tag (amenity=fuel[brand|operator|name]), within a tight radius.
// osm_brands.json is a baked snapshot ([lon, lat, brand]) — brands change slowly.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CELL = 0.02;                 // ~2.2 km grid cell
const MAX_DEG2 = 0.0027 * 0.0027;  // ~300 m match radius (squared, lat-degrees)

let grid = null;

function cellKey(la, lo) { return Math.round(la / CELL) + ':' + Math.round(lo / CELL); }

export async function loadBrands() {
  if (grid) return grid;
  grid = new Map();
  try {
    const pts = JSON.parse(await readFile(join(__dirname, 'osm_brands.json'), 'utf8'));
    for (const [lo, la, b] of pts) {
      const k = cellKey(la, lo);
      (grid.get(k) || grid.set(k, []).get(k)).push([la, lo, b]);
    }
    console.log(`[brands] loaded ${pts.length} branded OSM stations`);
  } catch (e) {
    console.error('[brands] load failed:', e.message);
  }
  return grid;
}

// Nearest brand within radius, or null. `la`/`lo` are WGS84 degrees.
export function brandFor(la, lo) {
  if (!grid || la == null || lo == null) return null;
  const cla = Math.round(la / CELL), clo = Math.round(lo / CELL);
  const cosLat = Math.cos(la * Math.PI / 180);
  let best = null, bestD = MAX_DEG2;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const bucket = grid.get((cla + dx) + ':' + (clo + dy));
      if (!bucket) continue;
      for (const [bla, blo, b] of bucket) {
        const dLa = bla - la, dLo = (blo - lo) * cosLat;
        const d = dLa * dLa + dLo * dLo;
        if (d < bestD) { bestD = d; best = b; }
      }
    }
  }
  return best;
}
