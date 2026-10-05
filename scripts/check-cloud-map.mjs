import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const gridRequire = createRequire(require.resolve("leaflet.vectorgrid"));
const Pbf = gridRequire("pbf");
const { VectorTile } = gridRequire("vector-tile");
const base = "https://8.136.121.71/maps/national-20261003-v2";
const get = (url, headers) => fetch(url, { headers, signal: AbortSignal.timeout(30000) });
const response = await get(base + "/labels.json");
assert.equal(response.status, 200);
assert.equal(response.headers.get("access-control-allow-origin"), "*");
assert.match(response.headers.get("cache-control"), /immutable/);
const bytes = Buffer.from(await response.arrayBuffer());
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
assert.equal(sha256(bytes), sha256(readFileSync(".local/maps/labels.json")));
assert.equal((await get(base + "/labels.json", { "if-none-match": response.headers.get("etag") })).status, 304);
const checks = [];
for (const [name, lon, lat] of [
  ["Shanghai", 121.48, 31.23], ["Beijing", 116.40, 39.91], ["Wuhan", 114.30, 30.59],
  ["Chengdu", 104.06, 30.67], ["Guangzhou", 113.27, 23.13], ["Urumqi", 87.62, 43.83],
  ["Lhasa", 91.13, 29.65], ["Haikou", 110.35, 20.02], ["HongKong", 114.17, 22.32],
  ["Macau", 113.55, 22.20], ["Taipei", 121.56, 25.04],
]) {
  const z = 12, n = 2 ** z;
  const x = Math.floor((lon + 180) / 360 * n);
  const y = Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * n);
  const tileResponse = await get(`${base}/${z}/${x}/${y}.pbf`);
  assert.equal(tileResponse.status, 200);
  assert.equal(tileResponse.headers.get("content-encoding"), "gzip");
  assert.match(tileResponse.headers.get("content-type"), /vector-tile/);
  const tile = new VectorTile(new Pbf(await tileResponse.arrayBuffer()));
  const layers = Object.fromEntries(Object.entries(tile.layers).map(([key, layer]) => [key, layer.length]));
  assert.ok(layers.road > 0, `roads missing at ${name}`);
  if (name === "Shanghai") assert.ok(layers.water > 0 && layers.boundary > 0);
  checks.push({ name, z, x, y, layers });
}
for (const name of ["NOTICE.txt", "ODBL_LICENSE", "source-report.json"])
  assert.equal((await get(base + "/" + name)).status, 200);
const archive = await get(base + "/national-20261003-v2.mbtiles");
assert.equal(archive.status, 200);
assert.equal(archive.headers.get("content-length"), "620691456");
const reader = archive.body.getReader();
const first = await reader.read();
assert.equal(Buffer.from(first.value).subarray(0, 16).toString(), "SQLite format 3\0");
await reader.cancel();
assert.equal((await get("https://8.136.121.71/api/v1/health")).status, 200);
assert.equal((await get("https://8.136.121.71/api/v1/ready")).status, 404);
assert.equal((await get(base + "/.env")).status, 404);
console.log(JSON.stringify({ status: "CLOUD_MAP_HTTP_PASS", labelsSha256: sha256(bytes), checks,
  immutableCache: true, cors: true, publicLicenseAndDatabase: true, apiHealthy: true }));
