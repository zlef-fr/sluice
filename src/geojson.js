// Project a feed into a GeoJSON FeatureCollection when the descriptor declares
// a `geo: { lat, lon }` field mapping. This is what maps.zlef.fr consumes so it
// never has to know a source's internal shape — it just asks for /feed/:id.geojson.
import { pluck } from './util.js';

export function toGeoJson(descriptor, feed) {
  const geo = descriptor.geo;
  if (!geo || !geo.lat || !geo.lon) return null;
  const features = [];
  for (const rec of feed.data || []) {
    const lat = Number(pluck(rec, geo.lat));
    const lon = Number(pluck(rec, geo.lon));
    if (!isFinite(lat) || !isFinite(lon)) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: rec,
    });
  }
  return {
    type: 'FeatureCollection',
    features,
    metadata: {
      source: descriptor.id,
      name: descriptor.name,
      attribution: descriptor.attribution || descriptor.license || '',
      fetchedAt: feed.fetchedAt,
      count: features.length,
    },
  };
}
