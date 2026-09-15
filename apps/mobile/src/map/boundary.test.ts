import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAP_DATA_BOUNDS, MAP_FIT, MAP_VIEWBOX, computeMapFit } from "@yishu/shared";
import { CHINA_MAP_META, CHINA_MAP_OUTLINE_D } from "./chinaMapData";

/**
 * Phase 8 Gate M5 行政边界数据源 / 拓扑 / 空间归属测试（依赖零第三方库）。
 *
 * 冻结数据源：geoBoundaries `gbOpen / CHN / ADM1`，pinned revision `9469f09`，
 * vendored 于 `data/maps/source/`（禁止运行时下载）。station graph 只提供 route anchor /
 * 站点位置，**不再**是行政边界来源。
 *
 * 策略：station 只做「不跨省」与「距离容差」断言，并显式列出容差用例（冻结坐标是近似值）。
 */

const ROOT = new URL("../../../../", import.meta.url);
const SOURCE_PATH = fileURLToPath(
  new URL("data/maps/source/geoBoundaries-CHN-ADM1-2019-simplified.geojson", ROOT)
);
const DISTRICTS_PATH = fileURLToPath(new URL("data/maps/china-districts.json", ROOT));
const NODES_PATH = fileURLToPath(new URL("data/graphs/china-v1/station_nodes.json", ROOT));
const NODES_V2_PATH = fileURLToPath(new URL("data/graphs/china-v2/station_nodes.json", ROOT));
const CORRECTIONS_PATH = fileURLToPath(new URL("data/maps/station-display-corrections.json", ROOT));
const GENERATOR_PATH = fileURLToPath(new URL("data/gen_map.cjs", ROOT));

/** 冻结源完整性（与 generator 中的常量一致）。 */
const SOURCE_SHA256 = "bc4afc7eacf4351ae5b3ae7a612327987ce1123cb5deb8574fb49107091c6623";
const ADM1_FEATURE_COUNT = 34;
const ROUTE_PROVINCE_COUNT = 31;
const PINNED_REVISION = "9469f09";
const PINNED_BOUNDARY_ID = "CHN-ADM1-43563684";

/** station 锚点坐标容差（mapX/mapY 单位；0.3 ≈ 10~16 km，边界简化误差量级）。 */
const STATION_DISTANCE_TOLERANCE = 0.3;

interface StationNode {
  id: string;
  name: string;
  province: string;
  city: string;
  lat: number;
  lng: number;
  mapX: number;
  mapY: number;
}

interface Adm1Shape {
  id: string;
  province: string | null;
  sourceName: string;
  sourceFeatureId: string;
  stationCount: number;
  d: string;
}

interface DistrictsJson {
  generatedFrom: string;
  routeAnchorSource: string;
  sourceSha256: string;
  source: Record<string, unknown>;
  viewBox: { width: number; height: number };
  margin: number;
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  fit: { scale: number; tx: number; ty: number };
  counts: Record<string, number>;
  outline: { d: string; ringCount: number };
  provinces: Adm1Shape[];
}

type Point = [number, number];

const districts = JSON.parse(readFileSync(DISTRICTS_PATH, "utf8")) as DistrictsJson;
const stations = JSON.parse(readFileSync(NODES_PATH, "utf8")) as StationNode[];
const stationsV2 = JSON.parse(readFileSync(NODES_V2_PATH, "utf8")) as StationNode[];
const sourceText = readFileSync(SOURCE_PATH, "utf8");
const source = JSON.parse(sourceText) as {
  features: Array<{
    properties: { shapeName: string; shapeID: string };
    geometry: { type: string; coordinates: unknown };
  }>;
};

/** 单条显示修正（人工批准、可追溯；与 API `DisplayCorrection` 同结构）。 */
interface DisplayCorrection {
  lat: number;
  lng: number;
  source: string;
  reason: string;
}

/** `{ [graphVersion]: { [nodeId]: correction } }`（Phase 8 Gate「Yangquan 修复」）。 */
const displayCorrections = JSON.parse(readFileSync(CORRECTIONS_PATH, "utf8")) as Record<
  string,
  Record<string, DisplayCorrection>
>;

function correctionsFor(graphVersion: string): Record<string, DisplayCorrection> {
  return displayCorrections[graphVersion] ?? {};
}

/** 解析生成的 path（仅 `M x y L x y ... Z` 子路径）→ 环数组。 */
function parseRings(d: string): Point[][] {
  const rings: Point[][] = [];
  for (const chunk of d.split("Z")) {
    const text = chunk.trim();
    if (text.length === 0) continue;
    const numbers = text.replace(/M|L/g, " ").trim().split(/\s+/).map(Number);
    const ring: Point[] = [];
    for (let i = 0; i + 1 < numbers.length; i += 2) {
      ring.push([numbers[i] ?? 0, numbers[i + 1] ?? 0]);
    }
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
}

function pointInRing(point: Point, ring: Point[]): boolean {
  let inside = false;
  let previous = ring.length - 1;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[previous];
    previous = i;
    if (a === undefined || b === undefined) continue;
    if (a[1] > point[1] !== b[1] > point[1]) {
      const x = ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0];
      if (point[0] < x) inside = !inside;
    }
  }
  return inside;
}

function distanceToRing(point: Point, ring: Point[]): number {
  let best = Number.POSITIVE_INFINITY;
  let previous = ring.length - 1;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[previous];
    const b = ring[i];
    previous = i;
    if (a === undefined || b === undefined) continue;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq === 0 ? 0 : ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSq;
    const clamped = Math.max(0, Math.min(1, t));
    const distance = Math.hypot(point[0] - (a[0] + clamped * dx), point[1] - (a[1] + clamped * dy));
    if (distance < best) best = distance;
  }
  return best;
}

const ringsByShapeId = new Map<string, Point[][]>();
for (const shape of districts.provinces) ringsByShapeId.set(shape.id, parseRings(shape.d));

const shapeByRouteProvince = new Map<string, Adm1Shape>();
for (const shape of districts.provinces) {
  if (shape.province !== null) shapeByRouteProvince.set(shape.province, shape);
}

/** Phase 4 canonical projection（必须与 generator 同一公式，禁止第二套投影）。 */
function canonicalMapX(lng: number): number {
  return ((lng + 180) / 360) * 1000;
}
function canonicalMapY(lat: number): number {
  return ((90 - lat) / 180) * 800;
}

/** 与 `@yishu/shared` `projectLngLatToMapPoint` 同一取整（0.1 mapX/mapY）。 */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * 站点在**用户可见地图**上的坐标（= API `map-station-point.ts` 的 display 语义）：
 * 冻结图坐标，或该 graphVersion 的显示修正（canonical 投影 + 0.1 取整）。
 *
 * `china-v1` 中 `yangquan` 的冻结坐标落在河南一侧（Phase 4 数据冻结，禁止改写），
 * 显示修正层把渲染坐标对齐到真实位置 / `china-v2` 数据；本测试据此断言空间归属。
 */
function displayPoint(station: StationNode, graphVersion = "china-v1"): Point {
  const correction = correctionsFor(graphVersion)[station.id];
  if (correction === undefined) return [station.mapX, station.mapY];
  return [round1(canonicalMapX(correction.lng)), round1(canonicalMapY(correction.lat))];
}

function sourceRingCount(): number {
  let total = 0;
  for (const feature of source.features) {
    const polygons =
      feature.geometry.type === "MultiPolygon"
        ? (feature.geometry.coordinates as unknown[][][])
        : [feature.geometry.coordinates as unknown[][]];
    for (const polygon of polygons) total += polygon.length;
  }
  return total;
}

describe("行政边界数据源（geoBoundaries CHN ADM1，pinned）", () => {
  it("vendored 源文件字节级冻结（SHA-256 / feature 数 / ID 唯一）", () => {
    expect(createHash("sha256").update(sourceText).digest("hex")).toBe(SOURCE_SHA256);
    expect(source.features.length).toBe(ADM1_FEATURE_COUNT);
    const ids = source.features.map((f) => f.properties.shapeID);
    expect(new Set(ids).size).toBe(ids.length);
    for (const feature of source.features) {
      expect(["Polygon", "MultiPolygon"]).toContain(feature.geometry.type);
      expect(feature.properties.shapeName.length).toBeGreaterThan(0);
    }
  });

  it("districts.json 记录的来源元数据与冻结裁定一致", () => {
    expect(districts.sourceSha256).toBe(SOURCE_SHA256);
    expect(districts.generatedFrom).toBe(
      "data/maps/source/geoBoundaries-CHN-ADM1-2019-simplified.geojson"
    );
    expect(districts.routeAnchorSource).toBe("data/graphs/china-v1/station_nodes.json");
    const meta = districts.source;
    expect(meta.provider).toBe("geoBoundaries");
    expect(meta.dataset).toBe("gbOpen");
    expect(meta.iso).toBe("CHN");
    expect(meta.boundaryType).toBe("ADM1");
    expect(meta.boundaryID).toBe(PINNED_BOUNDARY_ID);
    expect(meta.boundaryYearRepresented).toBe(2019);
    expect(meta.upstreamRevision).toBe(PINNED_REVISION);
    expect(meta.admUnitCount).toBe(ADM1_FEATURE_COUNT);
    expect(meta.runtimeNetworkAccess).toBe("none");
  });

  it("source 文件不进入 Mobile bundle（只有生成资产被 bundle）", () => {
    // Mobile 侧只 import 生成的 chinaMapData.ts；source GeoJSON 不在 mobile 目录内
    expect(SOURCE_PATH.replace(/\\/g, "/")).toContain("data/maps/source");
    expect(CHINA_MAP_META.generatedFrom).toBe(
      "data/maps/source/geoBoundaries-CHN-ADM1-2019-simplified.geojson"
    );
    expect(JSON.stringify(CHINA_MAP_META).includes("coordinates")).toBe(false);
  });
});

describe("边界几何与拓扑（Gate M5）", () => {
  it("34 个 ADM1 feature 全部保留；31 个 route province 31/31 映射且不重复", () => {
    expect(districts.provinces.length).toBe(ADM1_FEATURE_COUNT);
    expect(districts.counts.administrativeBoundaryFeatureCount).toBe(ADM1_FEATURE_COUNT);
    expect(districts.counts.routeStationProvinceCount).toBe(ROUTE_PROVINCE_COUNT);

    const routeProvinces = [...new Set(stations.map((s) => s.province))].sort();
    expect(routeProvinces.length).toBe(ROUTE_PROVINCE_COUNT);
    expect([...shapeByRouteProvince.keys()].sort()).toEqual(routeProvinces);

    const mappedIds = districts.provinces
      .filter((s) => s.province !== null)
      .map((s) => s.sourceFeatureId);
    expect(new Set(mappedIds).size).toBe(ROUTE_PROVINCE_COUNT);
    expect(districts.provinces.filter((s) => s.province === null).length).toBe(
      ADM1_FEATURE_COUNT - ROUTE_PROVINCE_COUNT
    );
    // 未映射 feature 不得伪造 station 计数
    for (const shape of districts.provinces) {
      if (shape.province === null) expect(shape.stationCount).toBe(0);
    }
  });

  it("MultiPolygon / 岛屿不丢失：资产环数 = 源环数，且含 6 个 MultiPolygon feature", () => {
    const assetRings = districts.provinces.reduce(
      (sum, shape) => sum + (ringsByShapeId.get(shape.id)?.length ?? 0),
      0
    );
    expect(assetRings).toBe(sourceRingCount());
    expect(districts.counts.multiPolygonFeatureCount).toBe(6);
    const multiRingShapes = districts.provinces.filter(
      (shape) => (ringsByShapeId.get(shape.id)?.length ?? 0) > 1
    );
    expect(multiRingShapes.length).toBeGreaterThanOrEqual(6);
    for (const shape of multiRingShapes) {
      expect(shape.sourceName.length).toBeGreaterThan(0);
    }
  });

  it("几何有限 / 非空 / 无 NaN，且经 MAP_FIT 后全部落在固定 viewBox 内", () => {
    const toBox = (point: Point): Point => [
      point[0] * MAP_FIT.scale + MAP_FIT.tx,
      point[1] * MAP_FIT.scale + MAP_FIT.ty,
    ];
    const checkPoint = (point: Point, label: string): void => {
      expect(Number.isFinite(point[0]) && Number.isFinite(point[1]), `${label} 非有限`).toBe(true);
      const mapped = toBox(point);
      expect(mapped[0], `${label} x 越界`).toBeGreaterThanOrEqual(0);
      expect(mapped[0], `${label} x 越界`).toBeLessThanOrEqual(MAP_VIEWBOX.width);
      expect(mapped[1], `${label} y 越界`).toBeGreaterThanOrEqual(0);
      expect(mapped[1], `${label} y 越界`).toBeLessThanOrEqual(MAP_VIEWBOX.height);
    };

    for (const shape of districts.provinces) {
      const rings = ringsByShapeId.get(shape.id) ?? [];
      expect(rings.length, `${shape.sourceName} 无几何`).toBeGreaterThan(0);
      for (const ring of rings) {
        expect(ring.length).toBeGreaterThanOrEqual(3);
        for (const point of ring) checkPoint(point, `${shape.id}`);
      }
    }
    for (const ring of parseRings(CHINA_MAP_OUTLINE_D)) {
      for (const point of ring) checkPoint(point, "outline");
    }
    for (const station of stations) checkPoint([station.mapX, station.mapY], station.id);
  });

  it("中国外轮廓为 ADM1 union（非凸包）：多个环 / 保留岛屿 / 包含全部省级几何", () => {
    const outlineRings = parseRings(CHINA_MAP_OUTLINE_D);
    expect(outlineRings.length).toBeGreaterThanOrEqual(2);
    expect(outlineRings.length).toBe(districts.outline.ringCount);

    let violations = 0;
    for (const shape of districts.provinces) {
      for (const ring of ringsByShapeId.get(shape.id) ?? []) {
        for (const point of ring) {
          if (outlineRings.some((outlineRing) => pointInRing(point, outlineRing))) continue;
          const distance = Math.min(
            ...outlineRings.map((outlineRing) => distanceToRing(point, outlineRing))
          );
          if (distance > 1e-3) violations += 1;
        }
      }
    }
    expect(violations).toBe(0);
  });

  it("fit / bounds 与 @yishu/shared 契约一致（单一公式来源）", () => {
    expect(districts.bounds).toEqual(MAP_DATA_BOUNDS);
    expect(districts.viewBox).toEqual(MAP_VIEWBOX);
    expect(districts.margin).toBe(60);
    expect(districts.fit).toEqual(computeMapFit(MAP_DATA_BOUNDS));
    expect(districts.fit).toEqual(MAP_FIT);
    // bounds 必须包含全部 station 锚点（fit 由「边界 ∪ 站点」范围推导）
    for (const station of stations) {
      expect(station.mapX).toBeGreaterThanOrEqual(MAP_DATA_BOUNDS.minX);
      expect(station.mapX).toBeLessThanOrEqual(MAP_DATA_BOUNDS.maxX);
      expect(station.mapY).toBeGreaterThanOrEqual(MAP_DATA_BOUNDS.minY);
      expect(station.mapY).toBeLessThanOrEqual(MAP_DATA_BOUNDS.maxY);
    }
  });

  it("生成器不再使用 station 点云构造行政边界（无 hull / inflate / hexagon / buffer）", () => {
    const generator = readFileSync(GENERATOR_PATH, "utf8");
    for (const banned of [
      "convexHull",
      "inflate(",
      "regularPolygon",
      "PAD_SAFETY",
      "MIN_SHAPE_RADIUS",
      "station hull",
    ]) {
      expect(generator.includes(banned), `gen_map.cjs 仍含旧 hull 逻辑：${banned}`).toBe(false);
    }
    expect(generator).toContain("polygon-clipping");
    expect(generator).toContain("geoBoundaries-CHN-ADM1-2019-simplified.geojson");
    // 无任何网络访问（`xmlns="http://www.w3.org/2000/svg"` 是 SVG 命名空间，不算网络访问）
    for (const bannedNetwork of ["fetch(", "http.get", "https.get", "node:https", "node:http"]) {
      expect(generator.includes(bannedNetwork), `gen_map.cjs 含网络访问：${bannedNetwork}`).toBe(
        false
      );
    }
  });

  it("生成器幂等：重跑产出字节一致（source 不变 → outputs 不变）", () => {
    const files = [
      "data/maps/china-districts.json",
      "data/maps/china-map.svg",
      "apps/mobile/src/map/chinaMapData.ts",
    ];
    const hashOf = (relativePath: string): string =>
      createHash("sha256")
        .update(readFileSync(fileURLToPath(new URL(relativePath, ROOT))))
        .digest("hex");
    const before = files.map((file) => hashOf(file));
    const result = spawnSync("node", ["data/gen_map.cjs"], {
      cwd: fileURLToPath(ROOT),
      encoding: "utf8",
      timeout: 120000,
      env: process.env,
    });
    expect(result.status, `generator exit=${String(result.status)}`).toBe(0);
    expect(files.map((file) => hashOf(file))).toEqual(before);
  });
});

describe("station 空间归属（Gate M5 / Phase 8「Yangquan 修复」）", () => {
  /** 某点是否落在该省 ADM1 feature 内。 */
  function insideProvince(point: Point, province: string): boolean {
    const shape = shapeByRouteProvince.get(province);
    if (shape === undefined) return false;
    return (ringsByShapeId.get(shape.id) ?? []).some((ring) => pointInRing(point, ring));
  }

  it("投影一致性：china-v1 / china-v2 全部 station 的 mapX/mapY 均可由自身 lat/lng 精确复算", () => {
    for (const [version, nodes] of [
      ["china-v1", stations],
      ["china-v2", stationsV2],
    ] as const) {
      let mismatches = 0;
      for (const station of nodes) {
        const deltaX = Math.abs(round1(canonicalMapX(station.lng)) - station.mapX);
        const deltaY = Math.abs(round1(canonicalMapY(station.lat)) - station.mapY);
        if (deltaX > 1e-6 || deltaY > 1e-6) mismatches += 1;
      }
      expect(mismatches, `${version} 存在非 canonical 坐标`).toBe(0);
    }
    expect(stationsV2.length).toBe(stations.length);
  });

  it("station 归属：显示坐标不跨省（0 个同时落入多个 ADM1）+ 距离容差，容差用例显式列出", () => {
    const insideOwnByVersion = new Map<string, number>();
    let multiShape = 0;
    const toleranceCases: Array<{ id: string; graphVersion: string; distance: number }> = [];
    const violations: string[] = [];

    for (const [version, nodes] of [
      ["china-v1", stations],
      ["china-v2", stationsV2],
    ] as const) {
      insideOwnByVersion.set(version, 0);
      for (const station of nodes) {
        const point = displayPoint(station, version);
        const ownShape = shapeByRouteProvince.get(station.province);
        expect(ownShape, `${station.id} 无映射 feature`).toBeDefined();
        if (ownShape === undefined) continue;

        let containedCount = 0;
        for (const rings of ringsByShapeId.values()) {
          if (rings.some((ring) => pointInRing(point, ring))) containedCount += 1;
        }
        if (containedCount > 1) multiShape += 1;

        const ownRings = ringsByShapeId.get(ownShape.id) ?? [];
        if (ownRings.some((ring) => pointInRing(point, ring))) {
          insideOwnByVersion.set(version, (insideOwnByVersion.get(version) ?? 0) + 1);
          continue;
        }
        const distance = Math.min(...ownRings.map((ring) => distanceToRing(point, ring)));
        toleranceCases.push({ id: station.id, graphVersion: version, distance });
        if (distance > STATION_DISTANCE_TOLERANCE) {
          violations.push(`${station.id}(${station.province}) d=${distance.toFixed(3)}`);
        }
      }
    }

    // 旧方案问题（249/294 同时属于多个省形）必须为 0
    expect(multiShape).toBe(0);
    // 「显示坐标明显跨省」必须为 0（yangquan 修复后不再有任何按 id 的豁免）
    expect(violations).toEqual([]);
    // 每个版本内：绝大多数显示坐标严格落在本省 ADM1 feature 内（其余落在简化边界容差带内）
    for (const version of ["china-v1", "china-v2"]) {
      expect(
        insideOwnByVersion.get(version) ?? -1,
        `${version} 严格归属数偏低`
      ).toBeGreaterThanOrEqual(stations.length - 12);
    }
    for (const item of toleranceCases) {
      expect(
        item.distance,
        `${item.id} 超出容差 d=${item.distance.toFixed(3)}`
      ).toBeLessThanOrEqual(STATION_DISTANCE_TOLERANCE);
    }
    console.log(
      `[M5] stations=${stations.length}×2 insideOwn=${[...insideOwnByVersion.entries()]
        .map(([version, count]) => `${version}:${count}`)
        .join("/")} tolerance=${toleranceCases.length} multiShape=${multiShape} | toleranceCases=` +
        `${toleranceCases
          .map((item) => `${item.graphVersion}/${item.id}:${item.distance.toFixed(3)}`)
          .join(",")}`
    );
  });

  it("yangquan 显示坐标修正生效：离开河南一侧、不再落入任何他省境内", () => {
    const rawV1 = stations.find((s) => s.id === "yangquan");
    const rawV2 = stationsV2.find((s) => s.id === "yangquan");
    if (rawV1 === undefined || rawV2 === undefined) throw new Error("yangquan 节点缺失");

    const frozenPoint: Point = [rawV1.mapX, rawV1.mapY];
    const display = displayPoint(rawV1);

    // 冻结基线（禁止改写）仍是历史近似坐标，且**确实**落在河南一侧（历史缺陷证据）
    expect(rawV1.lat).toBeCloseTo(35.1975, 6);
    expect(rawV1.lng).toBeCloseTo(113.5841, 6);
    expect(insideProvince(frozenPoint, "河南省")).toBe(true);
    // 冻结坐标与真实位置偏差 ≈295 km：显示坐标必须离开河南、不再落在他省
    expect(display).not.toEqual(frozenPoint);
    for (const foreign of ["河南省", "河北省", "内蒙古自治区"]) {
      expect(insideProvince(display, foreign), `yangquan 显示坐标落入${foreign}`).toBe(false);
    }
    // 显示坐标 = china-v2 数据坐标（数据侧 vs 显示侧一致）
    expect(rawV2.lat).toBeCloseTo(37.8575, 6);
    expect(rawV2.lng).toBeCloseTo(113.563333, 6);
    expect([rawV2.mapX, rawV2.mapY]).toEqual(display);

    console.log(
      `[M5] yangquan frozen=${frozenPoint.join(",")} display=${display.join(",")} ` +
        `inShanxi=${String(insideProvince(display, "山西省"))}`
    );
  });

  it("显示修正表：来源可追溯、仅登记 china-v1、条目必须指向真实节点", () => {
    expect(Object.keys(displayCorrections).sort()).toEqual(["china-v1"]);
    const entries = Object.entries(correctionsFor("china-v1"));
    expect(entries.length).toBeGreaterThan(0);

    const knownIds = new Set(stations.map((s) => s.id));
    for (const [nodeId, correction] of entries) {
      expect(knownIds.has(nodeId), `修正条目指向未知节点 ${nodeId}`).toBe(true);
      expect(Number.isFinite(correction.lat) && Number.isFinite(correction.lng)).toBe(true);
      expect(correction.source.length).toBeGreaterThan(0);
      expect(correction.reason.length).toBeGreaterThan(0);
      // 修正坐标必须落在冻结 bounds 内（否则渲染越出固定 viewBox）
      const [x, y] = [round1(canonicalMapX(correction.lng)), round1(canonicalMapY(correction.lat))];
      expect(x).toBeGreaterThanOrEqual(MAP_DATA_BOUNDS.minX);
      expect(x).toBeLessThanOrEqual(MAP_DATA_BOUNDS.maxX);
      expect(y).toBeGreaterThanOrEqual(MAP_DATA_BOUNDS.minY);
      expect(y).toBeLessThanOrEqual(MAP_DATA_BOUNDS.maxY);
    }
    // 修正条目只应覆盖「冻结近似坐标」个案，不得演变为批量改写冻结基线
    expect(entries.length).toBeLessThanOrEqual(3);
  });

  it("china-v2 只在 yangquan 坐标上偏离冻结基线（无拓扑 / 省份漂移）", () => {
    const v1ById = new Map(stations.map((station) => [station.id, station]));
    const changed: string[] = [];
    for (const station of stationsV2) {
      const base = v1ById.get(station.id);
      expect(base, `china-v2 出现 china-v1 不存在的节点 ${station.id}`).toBeDefined();
      if (base === undefined) continue;
      expect(station.province).toBe(base.province);
      expect(station.name).toBe(base.name);
      if (station.lat !== base.lat || station.lng !== base.lng) changed.push(station.id);
    }
    expect(changed).toEqual(["yangquan"]);
  });
});
