import { describe, expect, it } from "vitest";
import type { TimelineEvent } from "@yishu/db";
import type { MapStation, RouteMapView } from "@yishu/shared";
import { districtPoint, withDistrictConnections } from "./district-map.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { getDataDir } from "./stationGraph.js";
const origin = { province: "上海市", city: "上海市", district: "黄浦区" };
const target = { ...origin, district: "浦东新区" };
const station: MapStation = {
  name: "上海",
  province: origin.province,
  city: origin.city,
  x: 837.4,
  y: 261.2,
};
const base: RouteMapView = {
  status: "DISPATCHED",
  origin: station,
  destination: station,
  completedPath: [station],
  remainingPath: [],
  lastKnownPosition: station,
  approximatePosition: null,
  facts: [],
};
function event(
  type: TimelineEvent["type"],
  at: number,
  district: string | null = null
): TimelineEvent {
  return {
    id: 0n,
    letterId: 0n,
    sourceKey: type === "ARRIVED_STATION" ? "pickup:arrived" : type,
    sequence: 0,
    type,
    title: type,
    description: type,
    ...origin,
    district,
    nodeId: "shanghai",
    mapX: station.x,
    mapY: station.y,
    happenedAt: new Date(at),
    visibleAt: new Date(at),
    createdAt: new Date(at),
    uncertaintyRadiusKm: null,
    importance: 0,
    metadata: null,
  };
}
const input = {
  origin,
  target,
  sender: true,
  nowMs: 3600000,
  originStationReadyAtMs: 10800000,
  events: [event("DISPATCHED", 0)],
  stations: [station],
};
describe("district display projection", () => {
  it("keeps old graph coordinates frozen while new mail uses the new endpoint library", () => {
    for (const graphVersion of ["china-v1", "china-v2", "china-v3"]) {
      const filename =
        graphVersion === "china-v3"
          ? "district-anchors-1.1-candidate.json"
          : "district-anchors.json";
      const library = JSON.parse(readFileSync(path.join(getDataDir(), "maps", filename), "utf8"));
      const expected = library.anchors[`${origin.province}/${origin.city}/${origin.district}`];
      expect(districtPoint(origin, graphVersion)).toMatchObject({ x: expected.x, y: expected.y });
    }
  });
  it("does not reveal a future pickup fact or recipient target", () => {
    const view = withDistrictConnections(base, {
      ...input,
      sender: false,
      events: [...input.events, event("ARRIVED_STATION", 10800000)],
    });
    expect(view.collection).toBeNull();
    expect(view.stations).toEqual([]);
    expect(view.delivery).toBeNull();
    expect(view.completedPath).toHaveLength(1);
    expect(JSON.stringify(view)).not.toContain("浦东新区");
  });
  it("never substitutes a city coordinate for a missing district or collection position", () => {
    const unknown = { ...origin, district: "未匹配区" };
    const view = withDistrictConnections(
      {
        ...base,
        approximatePosition: station,
        facts: [
          {
            type: "DISPATCHED",
            title: "已寄出",
            description: "已寄出",
            location: origin,
            happenedAt: new Date(0).toISOString(),
            ...station,
          },
        ],
      },
      { ...input, origin: unknown }
    );
    expect(view.origin).toBeNull();
    expect(view.lastKnownPosition).toBeNull();
    expect(view.approximatePosition).toBeNull();
    expect(view.facts).toEqual([]);
    expect(view.districtLocationsUnavailable).toContain("上海市未匹配区");
  });
  it("moves last-mile estimates along the city-to-district segment only for the sender", () => {
    const options = {
      ...input,
      nowMs: 21600000,
      events: [
        ...input.events,
        event("ARRIVED_STATION", 10800000),
        event("OUT_FOR_DELIVERY", 10800000, target.district),
      ],
    };
    const view = withDistrictConnections({ ...base, status: "OUT_FOR_DELIVERY" }, options);
    expect(view.delivery?.state).toBe("IN_PROGRESS");
    expect(view.approximatePosition?.x).toBeCloseTo(
      (view.delivery!.from.x + view.delivery!.to.x) / 2,
      5
    );
    const recipient = withDistrictConnections(
      { ...base, status: "OUT_FOR_DELIVERY" },
      { ...options, sender: false }
    );
    expect(recipient.approximatePosition).toBeNull();
    expect(recipient.delivery).toBeNull();
    expect(recipient.destination).toBeNull();
  });
  it("does not continue predictions or planned paths after a terminal outcome", () => {
    const view = withDistrictConnections(
      {
        ...base,
        status: "PERMANENTLY_LOST",
        remainingPath: [station],
        approximatePosition: station,
      },
      input
    );
    expect(view.remainingPath).toEqual([]);
    expect(view.approximatePosition).toBeNull();
    expect(view.delivery).toBeNull();
    expect(view.collection).toBeNull();
  });
});
