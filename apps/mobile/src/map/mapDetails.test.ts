import { describe, expect, it } from "vitest";
import {
  mapDetailScript,
  mapDetailsForViewport,
  parseMapDetailRequest,
  waterVisibleAtZoom,
} from "./mapDetails";

describe("offline geographic detail packs", () => {
  it("validates the bridge and rejects malformed or excessive input", () => {
    const request = { id: 1, zoom: 9, bounds: [121.3, 31, 121.9, 31.5] };
    expect(parseMapDetailRequest("detail-request:" + JSON.stringify(request))).toEqual(request);
    for (const value of [
      "detail-request:{",
      "ready",
      "detail-request:" + " ".repeat(600),
      ...[
        { ...request, zoom: 99 },
        { ...request, id: -1 },
        { ...request, bounds: [1, 2, 0, 3] },
        { ...request, bounds: [1, "2", 3, 4] },
      ].map((v) => "detail-request:" + JSON.stringify(v)),
    ])
      expect(parseMapDetailRequest(value)).toBeNull();
  });
  it("keeps national views light and only loads intersecting offline regions", () => {
    expect(mapDetailsForViewport({ id: 2, zoom: 5, bounds: [73, 18, 136, 54] })).toEqual({
      id: 2,
      cities: [],
      districts: [],
      waters: [],
    });
    const zhejiang = mapDetailsForViewport({ id: 3, zoom: 7, bounds: [119, 29, 121, 30.5] });
    expect(zhejiang.cities.map((f) => f.properties.name)).toEqual(
      expect.arrayContaining(["杭州市", "宁波市", "绍兴市"])
    );
    expect(zhejiang.districts).toEqual([]);
    expect(zhejiang.waters).toEqual([]);
    expect(zhejiang.cities.some((f) => f.properties.name === "成都市")).toBe(false);
    expect(new Set(zhejiang.waters.map((f) => f.properties.code)).size).toBe(
      zhejiang.waters.length
    );
  });
  it("distinguishes all Shanghai districts without obsolete district names", () => {
    const result = mapDetailsForViewport({ id: 4, zoom: 10, bounds: [120.8, 30.6, 122.3, 31.9] });
    const districts = result.districts.filter((f) => f.properties.province === "31");
    expect(districts).toHaveLength(16);
    expect(districts.map((f) => f.properties.name)).toEqual(
      expect.arrayContaining(["黄浦区", "浦东新区", "闵行区", "金山区"])
    );
    expect(districts.map((f) => f.properties.name)).not.toEqual(
      expect.arrayContaining(["卢湾区", "闸北区", "南汇区"])
    );
    const huangpu = districts.find((f) => f.properties.code === "310101")!;
    const pudong = districts.find((f) => f.properties.code === "310115")!;
    expect(huangpu.geometry).not.toEqual(pudong.geometry);
    expect(huangpu.properties.center).not.toEqual(pudong.properties.center);
    expect(districts.every((f) => f.properties.source === "OSM" && f.properties.sourceId)).toBe(
      true
    );
    expect(result.waters.length).toBeGreaterThan(0);
    expect(result.waters.every((f) => f.properties.source === "OSM")).toBe(true);
  });
  it("decodes every province pack with finite geometry and preserved feature bounds", () => {
    const result = mapDetailsForViewport({ id: 8, zoom: 9, bounds: [70, 15, 140, 56] });
    expect(result.cities).toHaveLength(364);
    expect(result.districts).toHaveLength(2839);
    expect(result.waters.length).toBeGreaterThan(0);
    expect(result.waters.every((f) => f.properties.source === "OSM")).toBe(true);
    const validCoordinates = (coordinates: unknown): boolean => {
      if (!Array.isArray(coordinates) || !coordinates.length) return false;
      const values = coordinates as unknown[];
      if (typeof values[0] === "number") {
        return (
          values.length >= 2 &&
          values.every((v) => typeof v === "number" && Number.isFinite(v)) &&
          values[0] >= -180 &&
          values[0] <= 180 &&
          typeof values[1] === "number" &&
          values[1] >= -90 &&
          values[1] <= 90
        );
      }
      return values.every(validCoordinates);
    };
    for (const f of [...result.cities, ...result.districts, ...result.waters]) {
      expect(f.bbox).toHaveLength(4);
      expect(f.bbox.every(Number.isFinite)).toBe(true);
      expect(f.bbox[0]).toBeLessThanOrEqual(f.bbox[2]!);
      expect(f.bbox[1]).toBeLessThanOrEqual(f.bbox[3]!);
      expect(f.geometry.type).not.toBe("GeometryCollection");
      if (f.geometry.type !== "GeometryCollection")
        expect(validCoordinates(f.geometry.coordinates), f.properties.code).toBe(true);
      const polygons =
        f.geometry.type === "MultiPolygon"
          ? f.geometry.coordinates
          : f.geometry.type === "Polygon"
            ? [f.geometry.coordinates]
            : [];
      for (const polygon of polygons)
        for (const ring of polygon) {
          expect(ring.length).toBeGreaterThanOrEqual(4);
          expect(ring[0]).toEqual(ring[ring.length - 1]);
        }
    }
  });
  it("uses only verified Shanghai water polygons with zoom-dependent detail, never legacy centerlines", () => {
    const bounds: [number, number, number, number] = [121.4, 31.1, 121.7, 31.4];
    const coarse = mapDetailsForViewport({ id: 11, zoom: 7, bounds });
    const fine = mapDetailsForViewport({ id: 12, zoom: 13, bounds });
    expect(coarse.waters.length).toBeGreaterThan(0);
    expect(fine.waters.length).toBeGreaterThan(coarse.waters.length);
    // Some river-bank areas are unnamed in OSM; keep their provenance instead of inventing names.
    expect(fine.waters.some((f) => f.properties.sourceId === "w71118319")).toBe(true);
    expect(coarse.waters.every((f) => f.properties.areaM2! >= 250000)).toBe(true);
    const water = fine.waters[0]!;
    expect(waterVisibleAtZoom(water, 5)).toBe(false);
    expect(
      waterVisibleAtZoom(
        { ...water, properties: { ...water.properties, source: "Natural Earth" } },
        13
      )
    ).toBe(false);
    expect(
      waterVisibleAtZoom(
        {
          ...water,
          geometry: {
            type: "LineString",
            coordinates: [
              [121, 31],
              [122, 32],
            ],
          },
        },
        13
      )
    ).toBe(false);
    expect(
      mapDetailsForViewport({ id: 13, zoom: 13, bounds: [119.9, 30, 120.4, 30.4] }).waters
    ).toEqual([]);
  });
  it("escapes labels in injected scripts and contains no transport permissions or routes", () => {
    const result = mapDetailsForViewport({ id: 5, zoom: 10, bounds: [121.4, 31.1, 121.7, 31.4] });
    const script = mapDetailScript({
      ...result,
      cities: [
        {
          ...result.districts[0]!,
          properties: { ...result.districts[0]!.properties, name: "</script>" },
        },
      ],
    });
    expect(script).not.toContain("</script>");
    expect(script).toContain("\\u003c");
    expect(script).not.toContain("remainingPath");
    expect(script).not.toContain("approximatePosition");
    expect(
      mapDetailsForViewport({ id: 6, zoom: 10, bounds: [-90, 20, -80, 30] }).districts
    ).toEqual([]);
    // Cache reuse must not return a previous request ID or mutate geometry.
    expect(
      mapDetailsForViewport({ id: 7, zoom: 10, bounds: [121.4, 31.1, 121.7, 31.4] }).districts
    ).toEqual(result.districts);
  });
});
