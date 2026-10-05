import { inflateSync, strFromU8 } from "fflate";
import type { Feature, Geometry } from "geojson";
import { feature } from "topojson-client";
import index from "./detailData/index.json";
import { CITY_PACK_LOADERS, DISTRICT_PACK_LOADERS } from "./detailLoaders";
import shanghaiScope from "./detailData/31-hydro-index.json";

export type MapBounds = [number, number, number, number];
export type DetailFeature = Feature<
  Geometry,
  {
    code: string;
    name: string;
    level: "city" | "district" | "rivers" | "lakes";
    province?: string;
    center?: number[];
    rank?: number;
    source?: string;
    sourceId?: string;
    areaM2?: number;
  }
> & { bbox: number[] };
export interface MapDetailRequest {
  id: number;
  zoom: number;
  bounds: MapBounds;
}
export interface MapDetailPayload {
  id: number;
  cities: DetailFeature[];
  districts: DetailFeature[];
  waters: DetailFeature[];
}
const cache = new Map<string, unknown>();
const overlaps = (a: number[], b: number[]) =>
  a[0]! <= b[2]! && a[2]! >= b[0]! && a[1]! <= b[3]! && a[3]! >= b[1]!;
function load<T>(key: string, loader: () => unknown): T {
  if (cache.has(key)) {
    const value = cache.get(key);
    cache.delete(key);
    cache.set(key, value);
    return value as T;
  }
  const encoded = loader();
  if (typeof encoded !== "string") throw new Error("invalid_map_detail_pack");
  const binary = atob(encoded);
  const topology: Parameters<typeof feature>[0] = JSON.parse(
    strFromU8(inflateSync(Uint8Array.from(binary, (v) => v.charCodeAt(0))))
  );
  if (topology.type !== "Topology") throw new Error("invalid_map_detail_topology");
  const decoded: Record<string, DetailFeature[]> = {};
  for (const [name, object] of Object.entries(topology.objects)) {
    // Natural Earth's 1:10m hydrology cannot substantiate district-level alignment.
    if (name === "waters") continue;
    const collection = feature(topology, object);
    if (collection.type !== "FeatureCollection") throw new Error("invalid_map_detail_collection");
    decoded[name] = collection.features as DetailFeature[];
  }
  const data = decoded.districts ?? decoded;
  // Keep decoded geometry bounded; modules retain only the compressed strings.
  cache.set(key, data);
  if (cache.size > 8) cache.delete(cache.keys().next().value!);
  return data as T;
}
export function parseMapDetailRequest(message: string): MapDetailRequest | null {
  if (!message.startsWith("detail-request:") || message.length > 512) return null;
  try {
    const v = JSON.parse(message.slice(15));
    if (
      !Number.isSafeInteger(v.id) ||
      v.id < 1 ||
      !Number.isFinite(v.zoom) ||
      v.zoom < 2 ||
      v.zoom > 19 ||
      !Array.isArray(v.bounds) ||
      v.bounds.length !== 4 ||
      !v.bounds.every(Number.isFinite) ||
      v.bounds[0] >= v.bounds[2] ||
      v.bounds[1] >= v.bounds[3] ||
      v.bounds[1] < -90 ||
      v.bounds[3] > 90
    )
      return null;
    return v;
  } catch {
    return null;
  }
}
export function mapDetailsForViewport(request: MapDetailRequest): MapDetailPayload {
  const payload: MapDetailPayload = { id: request.id, cities: [], districts: [], waters: [] };
  if (request.zoom < 6) return payload;
  for (const province of index) {
    if (!overlaps(province.code === "31" ? shanghaiScope.bbox : province.bbox, request.bounds))
      continue;
    if (province.code === "31") {
      const pack = load<{ regions: DetailFeature[]; verifiedWaters: DetailFeature[] }>(
        "31-hydro",
        () => require("./detailData/31-hydro.json")
      );
      if (request.zoom >= 9)
        payload.districts.push(...pack.regions.filter((f) => overlaps(f.bbox, request.bounds)));
      payload.waters.push(
        ...pack.verifiedWaters.filter(
          (f) => waterVisibleAtZoom(f, request.zoom) && overlaps(f.bbox, request.bounds)
        )
      );
      continue;
    }
    const pack = load<{ cities: DetailFeature[] }>(
      province.code + "-cities",
      CITY_PACK_LOADERS[province.code]!
    );
    payload.cities.push(...pack.cities.filter((f) => overlaps(f.bbox, request.bounds)));
    if (request.zoom >= 9) {
      const districts = load<DetailFeature[]>(
        province.code + "-districts",
        DISTRICT_PACK_LOADERS[province.code]!
      );
      payload.districts.push(...districts.filter((f) => overlaps(f.bbox, request.bounds)));
    }
  }
  return payload;
}
export function waterVisibleAtZoom(feature: DetailFeature, zoom: number): boolean {
  const minimum = zoom < 6 ? Infinity : zoom < 9 ? 250000 : zoom < 11 ? 20000 : 5000;
  return (
    feature.properties.source === "OSM" &&
    (feature.geometry.type === "Polygon" || feature.geometry.type === "MultiPolygon") &&
    (feature.properties.areaM2 ?? 0) >= minimum
  );
}
export function mapDetailScript(payload: MapDetailPayload): string {
  return `window.yishuMapDetails(${JSON.stringify(payload).replace(/</g, "\\u003c")});true;`;
}
