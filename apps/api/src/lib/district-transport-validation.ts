import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { districtPoint } from "./district-map.js";
import {
  getDataDir,
  getStationNode,
  resolveStationForRegion,
  NoStationMappingError,
} from "./stationGraph.js";

type Region = { province: string; city: string; district: string };
type Endpoint = "origin" | "destination";
const catalogSchema = z.object({
  revision: z.string().min(1),
  selectionSha256: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(["candidate", "released"]),
  regions: z
    .array(
      z.object({
        code: z.string().regex(/^\d{6}$/),
        province: z.string().min(1),
        city: z.string().min(1),
        district: z.string().min(1),
        kind: z.enum(["county", "city"]),
      })
    )
    .nonempty(),
});
let regionKeys: Set<string> | undefined;
const keyOf = (region: Region) => [region.province, region.city, region.district].join("/");

export class InvalidTransportRegionError extends Error {
  readonly statusCode = 422;
  readonly code: "origin_region_unavailable" | "destination_region_unavailable";
  constructor(endpoint: Endpoint) {
    super(`${endpoint}_region_unavailable`);
    this.name = "InvalidTransportRegionError";
    this.code = `${endpoint}_region_unavailable`;
  }
}

export function assertDistrictTransportRegion(
  region: Region,
  graphVersion: string,
  endpoint: Endpoint
): void {
  if (!regionKeys) {
    const catalog = catalogSchema.parse(
      JSON.parse(readFileSync(path.join(getDataDir(), "regions/canonical-candidate.json"), "utf8"))
    );
    const keys = new Set(catalog.regions.map(keyOf));
    if (
      keys.size !== catalog.regions.length ||
      new Set(catalog.regions.map((r) => r.code)).size !== catalog.regions.length
    )
      throw new Error("invalid_transport_region_catalog");
    regionKeys = keys;
  }
  if (!regionKeys.has(keyOf(region)) || !districtPoint(region))
    throw new InvalidTransportRegionError(endpoint);
  try {
    const station = getStationNode(resolveStationForRegion(region, graphVersion), graphVersion);
    if (station.province !== region.province || station.city !== region.city)
      throw new InvalidTransportRegionError(endpoint);
  } catch (error) {
    if (error instanceof NoStationMappingError) throw new InvalidTransportRegionError(endpoint);
    throw error;
  }
}
