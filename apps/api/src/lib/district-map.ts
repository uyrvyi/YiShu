import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  LAST_MILE_DURATION_SECONDS,
  type MapStation,
  type RouteMapView,
  type MapConnection,
} from "@yishu/shared";
import type { TimelineEvent } from "@yishu/db";
import { getDataDir } from "./stationGraph.js";

interface Region {
  province: string;
  city: string;
  district: string;
}
const schema = z.object({
  anchors: z.record(
    z.object({
      code: z.string(),
      province: z.string(),
      city: z.string(),
      district: z.string(),
      x: z.number().finite(),
      y: z.number().finite(),
      sourceShapeId: z.string(),
    })
  ),
});
let anchors: z.infer<typeof schema>["anchors"] | undefined;
export function districtPoint(region: Region): MapStation | null {
  anchors ??= schema.parse(
    JSON.parse(readFileSync(path.join(getDataDir(), "maps/district-anchors.json"), "utf8"))
  ).anchors;
  const point = anchors[[region.province, region.city, region.district].join("/")];
  if (
    !point ||
    point.province !== region.province ||
    point.city !== region.city ||
    point.district !== region.district
  )
    return null;
  return { name: region.city + region.district, ...region, x: point.x, y: point.y };
}

/** Adds display-only district connections. Visibility still comes exclusively from confirmed facts. */
export function withDistrictConnections(
  view: RouteMapView,
  input: {
    origin: Region;
    target: Region;
    sender: boolean;
    nowMs: number;
    originStationReadyAtMs: number | null;
    events: readonly TimelineEvent[];
    stations: MapStation[];
  }
): RouteMapView {
  const events = input.events.filter((event) => event.visibleAt.getTime() <= input.nowMs);
  const dispatch = events.find((event) => event.type === "DISPATCHED");
  const arrivedOrigin = events.some((event) => event.sourceKey === "pickup:arrived");
  const delivered = events.find((event) => event.type === "DELIVERED");
  const terminal = ["DELIVERED", "PERMANENTLY_LOST", "DESTROYED"].includes(view.status);
  const origin = dispatch ? districtPoint(input.origin) : null;
  const targetPoint = input.sender || delivered ? districtPoint(input.target) : null;
  const collecting = input.originStationReadyAtMs !== null && !arrivedOrigin;
  const originCity = view.origin;
  const targetCity = view.destination;
  // A saved profile can change before the journey reaches its rerouting boundary.
  const target =
    targetCity &&
    targetCity.province === input.target.province &&
    targetCity.city === input.target.city
      ? targetPoint
      : null;
  const completedPath = collecting
    ? origin
      ? [origin]
      : []
    : [
        ...(origin ? [origin] : []),
        ...view.completedPath,
        ...(delivered && target ? [target] : []),
      ];
  const collection: MapConnection | null =
    origin && originCity
      ? {
          from: origin,
          to: originCity,
          state: collecting ? "IN_PROGRESS" : "COMPLETED",
        }
      : null;
  const delivery: MapConnection | null =
    target && targetCity
      ? {
          from: targetCity,
          to: target,
          state: delivered
            ? "COMPLETED"
            : view.status === "OUT_FOR_DELIVERY"
              ? "IN_PROGRESS"
              : "PLANNED",
        }
      : null;
  const samePoint = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    a.x === b.x && a.y === b.y;
  const stations = input.stations.filter(
    (station, index, all) =>
      all.findIndex((other) => samePoint(station, other)) === index &&
      (input.sender ||
        (!collecting && view.completedPath.some((point) => samePoint(station, point))))
  );
  const unavailable: string[] = [];
  if (dispatch && !origin) unavailable.push(input.origin.city + input.origin.district);
  if ((input.sender || delivered) && !targetPoint)
    unavailable.push(input.target.city + input.target.district);
  const remainingPath =
    input.sender && !terminal
      ? [
          ...(collecting && origin && originCity ? [origin, originCity] : []),
          ...view.remainingPath,
          ...(!delivered && delivery ? [delivery.from, delivery.to] : []),
        ]
      : [];
  let approximatePosition = collecting ? null : view.approximatePosition;
  if (collecting && origin && originCity && dispatch && input.originStationReadyAtMs) {
    const start = dispatch.happenedAt.getTime();
    const ratio = Math.max(
      0,
      Math.min(0.9, (input.nowMs - start) / (input.originStationReadyAtMs - start))
    );
    approximatePosition = {
      x: origin.x + (originCity.x - origin.x) * ratio,
      y: origin.y + (originCity.y - origin.y) * ratio,
    };
  }
  const deliveryStart = events
    .filter(
      (event) =>
        event.type === "OUT_FOR_DELIVERY" &&
        event.province === input.target.province &&
        event.city === input.target.city &&
        event.district === input.target.district
    )
    .at(-1);
  if (view.status === "OUT_FOR_DELIVERY" && delivery?.state === "IN_PROGRESS" && deliveryStart) {
    const ratio = Math.max(
      0,
      Math.min(
        0.9,
        (input.nowMs - deliveryStart.happenedAt.getTime()) / (LAST_MILE_DURATION_SECONDS * 1000)
      )
    );
    approximatePosition = {
      x: delivery.from.x + (delivery.to.x - delivery.from.x) * ratio,
      y: delivery.from.y + (delivery.to.y - delivery.from.y) * ratio,
    };
  }
  return {
    ...view,
    origin: origin ?? (collecting ? null : originCity),
    destination: input.sender ? target : delivered ? target : null,
    completedPath,
    remainingPath,
    approximatePosition: input.sender && !terminal ? approximatePosition : null,
    lastKnownPosition: delivered && target ? target : collecting ? origin : view.lastKnownPosition,
    collection:
      (input.sender && !terminal) || collection?.state === "COMPLETED" ? collection : null,
    delivery: (input.sender && !terminal) || delivered ? delivery : null,
    stations,
    districtLocationsUnavailable: unavailable,
    facts: view.facts
      .filter(
        (fact) =>
          !(fact.type === "DISPATCHED" && !origin) && !(fact.type === "DELIVERED" && !target)
      )
      .map((fact) => {
        const point =
          fact.type === "DISPATCHED" ? origin : fact.type === "DELIVERED" ? target : null;
        return point ? { ...fact, x: point.x, y: point.y } : fact;
      }),
  };
}
