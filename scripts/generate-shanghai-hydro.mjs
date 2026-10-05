import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { topology } from "topojson-server";
import { pointOnFeature } from "@turf/point-on-feature";
import { area } from "@turf/area";
import clipping from "polygon-clipping";

const root = new URL("../", import.meta.url);
const input = await readFile(new URL(".local/water-source/shanghai-details.geojson", root));
const digest = createHash("sha256").update(input).digest("hex");
if (digest !== "58eacdd9697a6224bfcdbb2b4e5aae50ed9a2d2c96b74ac1221b6732492370c7")
  throw new Error("shanghai_hydro_source_integrity");
const raw = JSON.parse(input);
const audit = JSON.parse(
  await readFile(new URL(".local/water-source/shanghai-details.audit.json", root))
);
if (audit.errors.length || audit.alignment.boundaryOutsideWaterM !== 0)
  throw new Error("shanghai_hydro_audit_failed");
const province = JSON.parse(
  await readFile(new URL("apps/mobile/src/regions/data/pca-code.json", root))
).find((p) => p.code === "31");
const current = new Map(province.children.flatMap((c) => c.children.map((d) => [d.name, d])));
const scope = raw.features.find(
  (f) => f.properties.kind === "boundary" && f.properties.osmId === "r913067"
);
if (!scope) throw new Error("shanghai_hydro_scope_missing");
const polygons = (f) =>
  f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
const scoped = (f) => {
  const coordinates = clipping.intersection(polygons(f), polygons(scope));
  if (!coordinates.length) return null;
  const points = coordinates.flat(2);
  const bbox = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of points) {
    bbox[0] = Math.min(bbox[0], x);
    bbox[1] = Math.min(bbox[1], y);
    bbox[2] = Math.max(bbox[2], x);
    bbox[3] = Math.max(bbox[3], y);
  }
  return { ...f, bbox, geometry: { type: "MultiPolygon", coordinates } };
};
const regions = [];
const verifiedWaters = [];
for (const f of raw.features) {
  const p = f.properties,
    tags = p.tags;
  if (
    p.kind === "boundary" &&
    tags.admin_level === "6" &&
    current.has(tags["name:zh"] || tags.name)
  ) {
    const district = current.get(tags["name:zh"] || tags.name);
    const sourceCode = tags.division_code || tags["ref:admin:CN"];
    if (sourceCode && sourceCode !== district.code) throw new Error("shanghai_hydro_code_mismatch");
    const displayed = scoped(f);
    if (!displayed) throw new Error("shanghai_hydro_empty_district");
    regions.push({
      ...displayed,
      properties: {
        code: district.code,
        name: district.name,
        level: "district",
        province: "31",
        center: pointOnFeature(displayed).geometry.coordinates,
        source: "OSM",
        sourceId: p.osmId,
      },
    });
  }
  if (p.kind === "water-area") {
    const displayed = scoped(f);
    if (!displayed) continue;
    const areaM2 = area(displayed);
    if (areaM2 < 5000) continue;
    verifiedWaters.push({
      ...displayed,
      properties: {
        code: "osm-water-" + p.osmId,
        name: tags["name:zh"] || tags.name || "",
        level:
          tags.water === "lake" || tags.water === "reservoir" || tags.water === "pond"
            ? "lakes"
            : "rivers",
        source: "OSM",
        sourceId: p.osmId,
        areaM2,
      },
    });
  }
}
regions.sort((a, b) => a.properties.code.localeCompare(b.properties.code));
verifiedWaters.sort((a, b) => a.properties.code.localeCompare(b.properties.code));
if (regions.length !== 16 || new Set(regions.map((f) => f.properties.code)).size !== 16)
  throw new Error("shanghai_hydro_districts_incomplete");
// Preserve source precision: quantization can collapse narrow water polygons and holes.
const pack = topology(
  {
    regions: { type: "FeatureCollection", features: regions },
    verifiedWaters: { type: "FeatureCollection", features: verifiedWaters },
  },
  0
);
pack.metadata = {
  source: "OpenStreetMap contributors",
  snapshot: audit.snapshot,
  license: "ODbL-1.0",
  copyright: "https://www.openstreetmap.org/copyright",
  scope: "Clipped to OSM Shanghai relation r913067; no inland snapping or simplification",
};
await writeFile(
  new URL("apps/mobile/src/map/detailData/31-hydro.json", root),
  JSON.stringify(deflateRawSync(Buffer.from(JSON.stringify(pack)), { level: 9 }).toString("base64"))
);
await writeFile(
  new URL("apps/mobile/src/map/detailData/31-hydro-index.json", root),
  JSON.stringify({ bbox: scope.bbox, snapshot: audit.snapshot })
);
await writeFile(
  new URL("apps/mobile/src/map/detailData/osm-notice.json", root),
  JSON.stringify({
    source: "OpenStreetMap contributors / Geofabrik",
    license: "ODbL-1.0",
    copyright: "https://www.openstreetmap.org/copyright",
    derivativeDatabase: "31-hydro.json",
    licenseText: await readFile(new URL("data/maps/source/ODBL_LICENSE", root), "utf8"),
  })
);
const report = {
  releaseApproval: "pending",
  scope: "Shanghai pilot only",
  source: "OpenStreetMap contributors / Geofabrik",
  sourceUrl: "https://download.geofabrik.de/asia/china/shanghai-261003.osm.pbf",
  supplementUrls: [
    "https://api.openstreetmap.org/api/0.6/relation/398353/full",
    "https://api.openstreetmap.org/api/0.6/relation/398374/full",
  ],
  snapshot: audit.snapshot,
  inputSha256: digest,
  sources: audit.sources,
  license: "ODbL-1.0",
  licenseUrl: "https://www.openstreetmap.org/copyright",
  coordinateSystem: "WGS84",
  quantization: 0,
  displayScope: {
    relation: "r913067",
    bbox: scope.bbox,
    operation:
      "Polygon intersection for both layers; out-of-scope exclaves omitted from this pilot, original sources preserved",
  },
  districts: regions.map((f) => ({
    code: f.properties.code,
    name: f.properties.name,
    sourceId: f.properties.sourceId,
  })),
  waters: verifiedWaters.length,
  alignment: audit.alignment,
  accuracyLimit:
    "Sampled spatial consistency, not official administrative boundary or survey certification. River banks and administrative lines are not interchangeable.",
};
await writeFile(
  new URL("data/maps/shanghai-hydro-report.json", root),
  JSON.stringify(report, null, 2)
);
console.log(
  JSON.stringify({
    districts: regions.length,
    waters: verifiedWaters.length,
    encodedBytes: (deflateRawSync(Buffer.from(JSON.stringify(pack)), { level: 9 }).length * 4) / 3,
  })
);
