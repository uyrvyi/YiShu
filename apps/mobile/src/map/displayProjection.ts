import { toMercator } from "@turf/projection";
import type { MapPoint, RouteMapViewParsed } from "@yishu/shared";
import { CHINA_GEOGRAPHIC_META } from "./chinaGeographicData";
import { routeSegmentsFor } from "./routeSegments";

/** Decode the frozen business space, then let standard map engines project it. */
export function toGeographicPoint<T extends MapPoint>(point: T): T & { lat: number; lng: number } {
  return { ...point, lng: (point.x * 360) / 1000 - 180, lat: 90 - (point.y * 180) / 800 };
}

export function toDisplayPoint(point: MapPoint): MapPoint {
  const { lat, lng } = toGeographicPoint(point);
  const [x, y] = toMercator([lng, lat]);
  const { scale, tx, ty } = CHINA_GEOGRAPHIC_META.fit;
  return { x: x! * scale + tx, y: -y! * scale + ty };
}

export function toDisplayPolyline(points: readonly MapPoint[]): string {
  return points
    .map((point) => {
      const p = toDisplayPoint(point);
      return `${p.x.toFixed(4)},${p.y.toFixed(4)}`;
    })
    .join(" ");
}

export function geographicMapPayload(view: RouteMapViewParsed) {
  const point = <T extends MapPoint>(value: T | null) => (value ? toGeographicPoint(value) : null);
  const connection = (value: RouteMapViewParsed["collection"]) =>
    value
      ? { ...value, from: toGeographicPoint(value.from), to: toGeographicPoint(value.to) }
      : value;
  return {
    ...view,
    origin: point(view.origin),
    destination: point(view.destination),
    lastKnownPosition: point(view.lastKnownPosition),
    approximatePosition: point(view.approximatePosition),
    completedPath: view.completedPath.map(toGeographicPoint),
    remainingPath: view.remainingPath.map(toGeographicPoint),
    facts: view.facts.map(toGeographicPoint),
    stations: view.stations?.map(toGeographicPoint),
    collection: connection(view.collection),
    delivery: connection(view.delivery),
    segments: routeSegmentsFor(view).map((segment) => ({
      ...segment,
      from: toGeographicPoint(segment.from),
      to: toGeographicPoint(segment.to),
    })),
  };
}
