import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { topology } from "topojson-server";
import * as shapefile from "shapefile";
import gcoord from "gcoord";
import { simplify } from "@turf/simplify";
import { pointOnFeature } from "@turf/point-on-feature";
import { booleanPointInPolygon } from "@turf/boolean-point-in-polygon";

const root = new URL("../", import.meta.url);
const target = new URL("apps/mobile/src/map/detailData/", root);
const mobileRequire = createRequire(new URL("apps/mobile/package.json", root));
const sources = {
  ".local/map-detail-source/city.shp":
    "36b600a70199f72b27cc613277aa58d955642e347304d57e1458a3d53bd7b63a",
  ".local/map-detail-source/city.dbf":
    "6521c29811c55dac560c1bec3bb006cfa6af0bd9b90af9a268288a8730af482e",
  ".local/map-detail-source/district.shp":
    "237f4900919417e041e081efa2dd8828a0e2ede7ddb1ebb277e34a86919c27d4",
  ".local/map-detail-source/district.dbf":
    "2ec907c0b7774ac3debeb8fa8cbaf20137326d3c2f28c3d8dc6961cfea198f10",
  ".local/china-rivers-source.geojson":
    "bb854a900ecbd3b408df46d5e16e3e0f974ba55993f9d8b5c26e855273c0905a",
  ".local/china-lakes-source.geojson":
    "2d036f53dedec578001c5c30c2959ee7d4eebc1306900fa4367c49929ec8f2d9",
};
for (const [file, expected] of Object.entries(sources)) {
  const actual = createHash("sha256")
    .update(await readFile(new URL(file, root)))
    .digest("hex");
  if (actual !== expected) throw new Error("map_detail_source_integrity:" + file);
}
const regions = JSON.parse(
  await readFile(new URL("apps/mobile/src/regions/data/pca-code.json", root))
);
const stations = JSON.parse(
  await readFile(new URL("data/graphs/china-v1/station_nodes.json", root))
);
const corrections = JSON.parse(
  await readFile(new URL("data/maps/station-display-corrections.json", root))
)["china-v1"];
const regionByCode = new Map();
const packs = new Map();
for (const province of regions) {
  packs.set(province.code, { cities: [], districts: [], waters: [] });
  for (const city of province.children ?? []) {
    regionByCode.set(city.code.padEnd(6, "0"), { name: city.name, province: province.name });
    for (const district of city.children ?? [])
      regionByCode.set(district.code, {
        name: district.name,
        province: province.name,
        cityCode: city.code,
      });
  }
}
const coordinates = (value) =>
  typeof value[0] === "number" ? [value] : value.flatMap(coordinates);
const bounds = (geometry) => {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of coordinates(geometry.coordinates)) {
    b[0] = Math.min(b[0], x);
    b[1] = Math.min(b[1], y);
    b[2] = Math.max(b[2], x);
    b[3] = Math.max(b[3], y);
  }
  return b;
};
const round = (value) =>
  typeof value[0] === "number" ? value.map((v) => Number(v.toFixed(5))) : value.map(round);
const rejected = [];
for (const level of ["city", "district"]) {
  const prefix = level === "city" ? "ct" : "dt";
  const source = await shapefile.open(
    new URL(`.local/map-detail-source/${level}.shp`, root).pathname,
    new URL(`.local/map-detail-source/${level}.dbf`, root).pathname,
    { encoding: "utf-8" }
  );
  for (;;) {
    const { done, value: raw } = await source.read();
    if (done) break;
    const p = raw.properties,
      code = p[prefix + "_adcode"],
      current = regionByCode.get(code);
    if (
      !current ||
      current.name !== p[prefix + "_name"] ||
      current.province !== p.pr_name ||
      (level === "district" && !p.ct_adcode.startsWith(current.cityCode))
    ) {
      rejected.push({
        level,
        code,
        name: p[prefix + "_name"],
        reason: "code_name_or_parent_mismatch",
      });
      continue;
    }
    const feature = simplify(raw, {
      tolerance: level === "city" ? 0.003 : 0.0006,
      highQuality: true,
    });
    gcoord.transform(feature, gcoord.GCJ02, gcoord.WGS84);
    feature.geometry.coordinates = round(feature.geometry.coordinates);
    const station =
      level === "city"
        ? stations.find((s) => s.province === current.province && s.city === current.name)
        : null;
    const display = station ? (corrections[station.id] ?? station) : null;
    const stationCenter = display ? [display.lng, display.lat] : null;
    const center =
      stationCenter && booleanPointInPolygon(stationCenter, feature)
        ? stationCenter
        : pointOnFeature(feature).geometry.coordinates;
    if (!booleanPointInPolygon(center, feature)) throw new Error("detail_label_outside:" + code);
    const properties = {
      code,
      name: current.name,
      level,
      province: code.slice(0, 2),
      center,
      labelSource:
        center === stationCenter
          ? "validated display city point"
          : "interior administrative representative",
    };
    const output = {
      type: "Feature",
      bbox: bounds(feature.geometry),
      properties,
      geometry: feature.geometry,
    };
    packs.get(code.slice(0, 2))[level === "city" ? "cities" : "districts"].push(output);
  }
}
const provinces = JSON.parse(
  await readFile(new URL("data/maps/source/geoBoundaries-CHN-ADM1-2019-simplified.geojson", root))
).features;
const provinceBounds = provinces.map((feature) => ({ feature, bbox: bounds(feature.geometry) }));
const insideChina = (point) =>
  provinceBounds.some(
    ({ feature, bbox: b }) =>
      point[0] >= b[0] &&
      point[0] <= b[2] &&
      point[1] >= b[1] &&
      point[1] <= b[3] &&
      booleanPointInPolygon(point, feature)
  );
const waters = [];
for (const kind of ["rivers", "lakes"]) {
  const data = JSON.parse(await readFile(new URL(`.local/china-${kind}-source.geojson`, root)));
  for (const [i, original] of data.features.entries()) {
    const b = bounds(original.geometry);
    if (b[2] < 73 || b[0] > 136 || b[3] < 18 || b[1] > 54) continue;
    const feature = simplify(original, { tolerance: 0.001, highQuality: true });
    if (kind === "rivers") {
      const lines =
        feature.geometry.type === "LineString"
          ? [feature.geometry.coordinates]
          : feature.geometry.coordinates;
      const parts = [];
      for (const line of lines) {
        let part = [];
        for (const point of line) {
          if (insideChina(point)) part.push(point);
          else {
            if (part.length > 1) parts.push(part);
            part = [];
          }
        }
        if (part.length > 1) parts.push(part);
      }
      if (!parts.length) continue;
      feature.geometry = { type: "MultiLineString", coordinates: parts };
    } else if (!insideChina(pointOnFeature(feature).geometry.coordinates)) continue;
    feature.geometry.coordinates = round(feature.geometry.coordinates);
    waters.push({
      type: "Feature",
      bbox: bounds(feature.geometry),
      properties: {
        code: `${kind}-${i}`,
        level: kind,
        name: original.properties.name_zh || "",
        rank: original.properties.scalerank ?? 8,
      },
      geometry: feature.geometry,
    });
  }
}
const overlaps = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
const index = [];
await mkdir(target, { recursive: true });
for (const province of regions) {
  const pack = packs.get(province.code);
  const all = [...pack.cities, ...pack.districts];
  if (!all.length) continue;
  const b = all.reduce(
    (b, f) => [
      Math.min(b[0], f.bbox[0]),
      Math.min(b[1], f.bbox[1]),
      Math.max(b[2], f.bbox[2]),
      Math.max(b[3], f.bbox[3]),
    ],
    [Infinity, Infinity, -Infinity, -Infinity]
  );
  pack.waters = waters.filter((feature) => overlaps(b, feature.bbox));
  const cityFile = `${province.code}-cities.json`,
    districtFile = `${province.code}-districts.json`;
  const encode = (data) => {
    const objects = Object.fromEntries(
      Object.entries(data).map(([key, features]) => [key, { type: "FeatureCollection", features }])
    );
    return JSON.stringify(
      deflateRawSync(Buffer.from(JSON.stringify(topology(objects, 1e6))), { level: 9 }).toString(
        "base64"
      )
    );
  };
  await writeFile(new URL(cityFile, target), encode({ cities: pack.cities, waters: pack.waters }));
  await writeFile(new URL(districtFile, target), encode({ districts: pack.districts }));
  index.push({
    code: province.code,
    name: province.name,
    bbox: b,
    cities: pack.cities.length,
    districts: pack.districts.length,
  });
}
await writeFile(new URL("index.json", target), JSON.stringify(index));
await writeFile(
  new URL("../detailLoaders.ts", target),
  "// Generated by scripts/generate-map-details.mjs. Lazy offline region packs.\n" +
    "export const CITY_PACK_LOADERS: Record<string, () => unknown> = {\n" +
    index
      .map((p) => `  "${p.code}": () => require("./detailData/${p.code}-cities.json"),`)
      .join("\n") +
    "\n};\n" +
    "export const DISTRICT_PACK_LOADERS: Record<string, () => unknown> = {\n" +
    index
      .map((p) => `  "${p.code}": () => require("./detailData/${p.code}-districts.json"),`)
      .join("\n") +
    "\n};\n"
);
const matchedDistricts = new Set(
  [...packs.values()].flatMap((p) => p.districts.map((f) => f.properties.code))
);
const missingDistricts = [...regionByCode]
  .filter(([code, p]) => p.cityCode && !matchedDistricts.has(code))
  .map(([code, p]) => ({ code, ...p }));
const report = {
  releaseApproval: "pending",
  coordinateSystem: "WGS84",
  sourceCoordinateSystem: "GCJ-02",
  encoding: "TopoJSON (quantization 1e6), deflateRaw, base64; lazy province packs",
  administrativeSource: {
    provider: "GaryBikini/ChinaAdminDivisonSHP",
    revision: "ae72417fee2a63f453e6b2717e40655e87e26887",
    edition: "v24.02.06",
    repositoryLicense: "MIT",
    upstream: "AMap administrative boundaries; redistribution review pending",
  },
  waterSource: {
    provider: "Natural Earth",
    revision: "ca96624a56bd078437bca8184e78163e5039ad19",
    scale: "1:10m",
    license: "public domain",
    purpose: "generalized physical reference, not district-level hydrology",
  },
  sources,
  provinces: index,
  rejected,
  cities: index.reduce((sum, p) => sum + p.cities, 0),
  districts: index.reduce((sum, p) => sum + p.districts, 0),
  missingDistricts,
  waters: waters.length,
};
await writeFile(
  new URL("data/maps/detail-source-report.json", root),
  JSON.stringify(report, null, 2)
);
const notices = {
  administrativeData: await readFile(
    new URL("data/maps/source/ADMIN_DETAIL_LICENSE", root),
    "utf8"
  ),
  naturalEarth:
    "Made with Natural Earth. Public domain data; https://www.naturalearthdata.com/about/terms-of-use/",
  fflate: await readFile(
    new URL("../LICENSE", pathToFileURL(mobileRequire.resolve("fflate"))),
    "utf8"
  ),
  topojson: await readFile(
    new URL("../LICENSE", pathToFileURL(mobileRequire.resolve("topojson-client"))),
    "utf8"
  ),
};
await writeFile(new URL("notices.json", target), JSON.stringify(notices));
console.log(
  JSON.stringify({
    cities: report.cities,
    districts: report.districts,
    waters: report.waters,
    rejected: rejected.length,
    shanghai: index.find((p) => p.code === "31"),
  })
);
