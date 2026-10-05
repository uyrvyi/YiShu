import type { MapPoint, RouteMapViewParsed } from "@yishu/shared";

export interface RouteSegment {
  from: MapPoint;
  to: MapPoint;
  state: "COMPLETED" | "IN_PROGRESS" | "PLANNED";
  kind: "collection" | "transport" | "delivery";
}

/** Connections may also appear in legacy paths. Draw each directed leg only once. */
export function routeSegmentsFor(view: RouteMapViewParsed): RouteSegment[] {
  const segments = new Map<string, RouteSegment>();
  const add = (segment: RouteSegment) => {
    const { from, to } = segment;
    if (from.x === to.x && from.y === to.y) return;
    segments.set(`${from.x},${from.y}:${to.x},${to.y}`, segment);
  };
  const path = (points: readonly MapPoint[], state: RouteSegment["state"]) => {
    for (let i = 1; i < points.length; i++)
      add({ from: points[i - 1]!, to: points[i]!, state, kind: "transport" });
  };
  path(view.remainingPath, "PLANNED");
  path(view.completedPath, "COMPLETED");
  if (view.collection) add({ ...view.collection, kind: "collection" });
  if (view.delivery) add({ ...view.delivery, kind: "delivery" });
  return [...segments.values()];
}
