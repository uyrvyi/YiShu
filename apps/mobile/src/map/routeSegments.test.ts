import { describe, expect, it } from "vitest";
import type { RouteMapViewParsed } from "@yishu/shared";
import { routeSegmentsFor } from "./routeSegments";
const region = { name: "示例", province: "上海市", city: "上海市" };
const origin = { ...region, x: 1, y: 1 },
  station = { ...region, x: 2, y: 2 },
  next = { ...region, x: 3, y: 3 },
  destination = { ...region, x: 4, y: 4 };
const base: RouteMapViewParsed = {
  status: "DISPATCHED",
  origin: null,
  destination: null,
  completedPath: [origin],
  remainingPath: [],
  facts: [],
  lastKnownPosition: origin,
  approximatePosition: null,
};
describe("visible district journey segments", () => {
  it("draws same-city collection and delivery exactly once, without an intercity segment", () => {
    const view = {
      ...base,
      remainingPath: [origin, station, station, destination],
      collection: { from: origin, to: station, state: "IN_PROGRESS" as const },
      delivery: { from: station, to: destination, state: "PLANNED" as const },
    };
    expect(routeSegmentsFor(view)).toEqual([
      { ...view.collection, kind: "collection" },
      { ...view.delivery, kind: "delivery" },
    ]);
  });
  it("includes both district legs and each city-station leg, preserving completed state", () => {
    const view = {
      ...base,
      completedPath: [origin, station],
      remainingPath: [station, next, destination],
      collection: { from: origin, to: station, state: "COMPLETED" as const },
      delivery: { from: next, to: destination, state: "PLANNED" as const },
    };
    const segments = routeSegmentsFor(view);
    expect(segments).toHaveLength(3);
    expect(segments).toEqual(
      expect.arrayContaining([
        { ...view.collection, kind: "collection" },
        { ...view.delivery, kind: "delivery" },
        { from: station, to: next, state: "PLANNED", kind: "transport" },
      ])
    );
  });
  it("never infers hidden recipient connections from region names or markers", () => {
    const view = { ...base, stations: [], collection: null, delivery: null };
    expect(routeSegmentsFor(view)).toEqual([]);
    expect(routeSegmentsFor({ ...view, completedPath: [origin, station] })).toEqual([
      { from: origin, to: station, state: "COMPLETED", kind: "transport" },
    ]);
  });
  it("preserves directed return journeys and never mutates the DTO", () => {
    const view = { ...base, completedPath: [origin, station, origin] };
    const before = JSON.stringify(view);
    expect(routeSegmentsFor(view)).toHaveLength(2);
    expect(JSON.stringify(view)).toBe(before);
  });
});
