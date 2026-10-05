import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { toMercator } from "@turf/projection";
import {
  CHINA_GEOGRAPHIC_GEOJSON,
  CHINA_GEOGRAPHIC_META,
  CHINA_GEOGRAPHIC_SHAPES,
} from "./chinaGeographicData";
import { geographicMapPayload, toDisplayPoint, toGeographicPoint } from "./displayProjection";
import type { RouteMapViewParsed } from "@yishu/shared";

describe("geographic map display projection", () => {
  it("decodes frozen map points instead of using the 1000x800 business grid as physical geography", () => {
    const point = { x: ((121.4737 + 180) / 360) * 1000, y: ((90 - 31.2304) / 180) * 800 };
    expect(toGeographicPoint(point).lng).toBeCloseTo(121.4737, 10);
    expect(toGeographicPoint(point).lat).toBeCloseTo(31.2304, 10);
    const [x, y] = toMercator([121.4737, 31.2304]);
    const fit = CHINA_GEOGRAPHIC_META.fit;
    expect(toDisplayPoint(point).x).toBeCloseTo(x! * fit.scale + fit.tx, 8);
    expect(toDisplayPoint(point).y).toBeCloseTo(-y! * fit.scale + fit.ty, 8);
  });
  it("keeps every source polygon and ring, including Taiwan and Hainan, unchanged", () => {
    const bytes = readFileSync(
      new URL("../../../../" + CHINA_GEOGRAPHIC_META.source, import.meta.url)
    );
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      CHINA_GEOGRAPHIC_META.sourceSha256
    );
    const source = JSON.parse(bytes.toString());
    expect(CHINA_GEOGRAPHIC_GEOJSON.features).toHaveLength(34);
    for (const feature of CHINA_GEOGRAPHIC_GEOJSON.features) {
      const original = source.features.find(
        (f: { properties: { shapeName: string } }) =>
          f.properties.shapeName === feature.properties?.name
      );
      expect(feature.geometry).toEqual(original.geometry);
    }
    expect(
      CHINA_GEOGRAPHIC_GEOJSON.features.some((f) => f.properties?.name === "Taiwan Province")
    ).toBe(true);
    expect(
      CHINA_GEOGRAPHIC_GEOJSON.features.some((f) => f.properties?.name === "Hainan Province")
    ).toBe(true);
  });
  it("fits the correctly projected outline without independent horizontal or vertical scales", () => {
    const { bounds, fit } = CHINA_GEOGRAPHIC_META;
    const ratio = (bounds.maxX - bounds.minX) / (bounds.maxY - bounds.minY);
    expect(ratio).toBeGreaterThan(1.3);
    expect(ratio).toBeLessThan(1.4);
    for (const shape of CHINA_GEOGRAPHIC_SHAPES) {
      const values = shape.d.replace(/[MLZ]/g, " ").trim().split(/\s+/).map(Number);
      for (let i = 0; i < values.length; i += 2) {
        expect(values[i]).toBeGreaterThanOrEqual(47.99);
        expect(values[i]).toBeLessThanOrEqual(952.01);
        expect(values[i + 1]).toBeGreaterThanOrEqual(47.99);
        expect(values[i + 1]).toBeLessThanOrEqual(752.01);
      }
    }
    expect(fit.scale).toBeGreaterThan(0);
  });
  it("converts every overlay consistently without adding a recipient's future geometry", () => {
    const p = { x: 837.441718, y: 261.251706 };
    const view: RouteMapViewParsed = {
      status: "DISPATCHED",
      origin: { ...p, name: "黄浦区", province: "上海市", city: "上海市", district: "黄浦区" },
      destination: null,
      completedPath: [p],
      remainingPath: [],
      lastKnownPosition: p,
      approximatePosition: null,
      facts: [],
      collection: null,
      delivery: null,
      stations: [],
    };
    const before = JSON.stringify(view);
    const converted = geographicMapPayload(view);
    expect(converted.origin?.lat).toBe(converted.completedPath[0]?.lat);
    expect(converted.destination).toBeNull();
    expect(converted.delivery).toBeNull();
    expect(converted.remainingPath).toEqual([]);
    expect(JSON.stringify(view)).toBe(before);
  });
});
