import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const require = createRequire(import.meta.url);
const vendorRequire = createRequire(require.resolve("leaflet.vectorgrid/package.json"));
const Pbf = vendorRequire("pbf");
const { VectorTile } = vendorRequire("vector-tile");
const database = new DatabaseSync(process.argv[2], { readOnly: true });
const z = 12,
  features = [];
const xAt = (lng) => Math.floor(((lng + 180) / 360) * 2 ** z);
const yAt = (lat) =>
  Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z);
const query = database.prepare(
  "SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?"
);
for (let x = xAt(121.4); x <= xAt(121.65); x++) {
  for (let y = yAt(31.36); y <= yAt(31.08); y++) {
    const row = query.get(z, x, 2 ** z - 1 - y);
    if (!row) continue;
    const bytes = row.tile_data;
    const tile = new VectorTile(
      new Pbf(bytes[0] === 31 && bytes[1] === 139 ? gunzipSync(bytes) : bytes)
    );
    for (const [layerName, layer] of Object.entries(tile.layers)) {
      if (!["water", "boundary"].includes(layerName)) continue;
      for (let i = 0; i < layer.length; i++) {
        const feature = layer.feature(i).toGeoJSON(x, y, z);
        feature.properties.layer = layerName;
        features.push(feature);
      }
    }
  }
}
database.close();
writeFileSync(process.argv[3], JSON.stringify({ type: "FeatureCollection", features }));
console.log(JSON.stringify({ decodedFeatures: features.length, zoom: z }));
