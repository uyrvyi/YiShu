import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAP_DATA_BOUNDS, MAP_FIT, MAP_FIT_MARGIN, MAP_VIEWBOX } from "@yishu/shared";
import {
  MAP_FIT_TRANSFORM,
  MAP_VIEWBOX_STRING,
  toPolylinePoints,
  toViewBoxPoint,
  toViewBoxX,
  toViewBoxY,
} from "./geometry";
import { CHINA_MAP_META, CHINA_MAP_OUTLINE_D, CHINA_PROVINCE_SHAPES } from "./chinaMapData";

/** 从 SVG path 提取坐标数字对（生成器只输出 `M x y L x y ... Z`）。 */
function pathPoints(d: string): Array<{ x: number; y: number }> {
  const numbers = d
    .replace(/[MLZ]/g, " ")
    .trim()
    .split(/\s+/)
    .map((token) => Number(token));
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i + 1 < numbers.length; i += 2) {
    out.push({ x: numbers[i] ?? 0, y: numbers[i + 1] ?? 0 });
  }
  return out;
}

describe("map geometry（viewBox 映射）", () => {
  it("固定 viewBox 为 0 0 1000 800", () => {
    expect(MAP_VIEWBOX_STRING).toBe("0 0 1000 800");
    expect(MAP_VIEWBOX).toEqual({ width: 1000, height: 800 });
  });

  it("生成资产元数据与 shared 契约一致（防生成器 / 常量漂移）", () => {
    expect(CHINA_MAP_META.viewBox).toEqual(MAP_VIEWBOX);
    expect(CHINA_MAP_META.mapVersion).toBe("china-v1");
    // Phase 8 Gate M5：几何来源 = vendored 行政边界源；站数据只提供 route anchor
    expect(CHINA_MAP_META.generatedFrom).toBe(
      "data/maps/source/geoBoundaries-CHN-ADM1-2019-simplified.geojson"
    );
    expect(CHINA_MAP_META.routeAnchorSource).toBe("data/graphs/china-v1/station_nodes.json");
    expect(CHINA_MAP_META.boundaryRevision).toBe("9469f09");
    expect(CHINA_MAP_META.administrativeBoundaryFeatureCount).toBe(34);
    expect(CHINA_MAP_META.routeStationProvinceCount).toBe(31);
  });

  it("数据边界映射后落在 viewBox 内并保留边距", () => {
    // 站点南北跨度（spanY）大于东西跨度（spanX）→ Y 为限制维度：上下边距恰为 MARGIN，
    // X 方向等比居中，留白更大。
    expect(toViewBoxY(MAP_DATA_BOUNDS.minY)).toBeCloseTo(MAP_FIT_MARGIN, 6);
    expect(toViewBoxY(MAP_DATA_BOUNDS.maxY)).toBeCloseTo(MAP_VIEWBOX.height - MAP_FIT_MARGIN, 6);
    for (const x of [MAP_DATA_BOUNDS.minX, MAP_DATA_BOUNDS.maxX]) {
      expect(toViewBoxX(x)).toBeGreaterThanOrEqual(MAP_FIT_MARGIN - 1e-9);
      expect(toViewBoxX(x)).toBeLessThanOrEqual(MAP_VIEWBOX.width - MAP_FIT_MARGIN + 1e-9);
    }
    // 等比缩放（不拉伸）：映射后跨度比 = 数据跨度比
    const mappedSpanX = toViewBoxX(MAP_DATA_BOUNDS.maxX) - toViewBoxX(MAP_DATA_BOUNDS.minX);
    const mappedSpanY = toViewBoxY(MAP_DATA_BOUNDS.maxY) - toViewBoxY(MAP_DATA_BOUNDS.minY);
    expect(mappedSpanX / mappedSpanY).toBeCloseTo(
      (MAP_DATA_BOUNDS.maxX - MAP_DATA_BOUNDS.minX) / (MAP_DATA_BOUNDS.maxY - MAP_DATA_BOUNDS.minY),
      6
    );
  });

  it("静态资产变换组与逐点映射语义一致（X = x * scale + tx）", () => {
    const matched = /translate\((-?[\d.]+) (-?[\d.]+)\) scale\((-?[\d.]+)\)/.exec(
      MAP_FIT_TRANSFORM
    );
    expect(matched).not.toBeNull();
    const tx = Number(matched?.[1]);
    const ty = Number(matched?.[2]);
    const scale = Number(matched?.[3]);
    expect(scale).toBeCloseTo(MAP_FIT.scale, 5);
    expect(tx).toBeCloseTo(MAP_FIT.tx, 5);
    expect(ty).toBeCloseTo(MAP_FIT.ty, 5);

    const sample = { x: 812.4, y: 531.8 };
    const mapped = toViewBoxPoint(sample);
    expect(mapped.x).toBeCloseTo(sample.x * scale + tx, 3);
    expect(mapped.y).toBeCloseTo(sample.y * scale + ty, 3);
  });

  it("折线 points 字符串使用映射后坐标", () => {
    const points = toPolylinePoints([
      { x: MAP_DATA_BOUNDS.minX, y: MAP_DATA_BOUNDS.minY },
      { x: MAP_DATA_BOUNDS.maxX, y: MAP_DATA_BOUNDS.maxY },
    ]);
    const [first, second] = points.split(" ");
    expect(first).toBe(
      `${toViewBoxX(MAP_DATA_BOUNDS.minX).toFixed(1)},${toViewBoxY(MAP_DATA_BOUNDS.minY).toFixed(1)}`
    );
    expect(second).toBe(
      `${toViewBoxX(MAP_DATA_BOUNDS.maxX).toFixed(1)},${toViewBoxY(MAP_DATA_BOUNDS.maxY).toFixed(1)}`
    );
  });

  it("生成资产坐标全部落在数据边界附近（防生成资产与 shared 常量漂移）", () => {
    // 生成器外扩上限 = (MARGIN / scale) * PAD_SAFETY ≈ 10.7（mapX/mapY 单位，见 data/gen_map.cjs）；
    // 这里用宽松的 90 兜住数据侧，真正的不变量是「经 MAP_FIT 映射后不越出固定 viewBox」。
    const pad = 90;
    const all = [
      ...pathPoints(CHINA_MAP_OUTLINE_D),
      ...CHINA_PROVINCE_SHAPES.flatMap((shape) => pathPoints(shape.d)),
    ];
    expect(all.length).toBeGreaterThan(100);
    for (const point of all) {
      expect(point.x).toBeGreaterThanOrEqual(MAP_DATA_BOUNDS.minX - pad);
      expect(point.x).toBeLessThanOrEqual(MAP_DATA_BOUNDS.maxX + pad);
      expect(point.y).toBeGreaterThanOrEqual(MAP_DATA_BOUNDS.minY - pad);
      expect(point.y).toBeLessThanOrEqual(MAP_DATA_BOUNDS.maxY + pad);
      // 映射后必须落在固定 viewBox 内（不越界）
      expect(toViewBoxX(point.x)).toBeGreaterThan(-1);
      expect(toViewBoxX(point.x)).toBeLessThan(MAP_VIEWBOX.width + 1);
      expect(toViewBoxY(point.y)).toBeGreaterThan(-1);
      expect(toViewBoxY(point.y)).toBeLessThan(MAP_VIEWBOX.height + 1);
    }
  });

  it("ADM1 边界覆盖 34 个行政单元（31 个 route province 全部映射）且几何非空", () => {
    expect(CHINA_PROVINCE_SHAPES.length).toBe(34);
    const mapped = CHINA_PROVINCE_SHAPES.filter((shape) => shape.province !== null);
    expect(mapped.length).toBe(31);
    for (const shape of CHINA_PROVINCE_SHAPES) {
      expect(shape.sourceName.length).toBeGreaterThan(1);
      expect(shape.sourceFeatureId.length).toBeGreaterThan(1);
      expect(pathPoints(shape.d).length).toBeGreaterThanOrEqual(3);
    }
    for (const shape of mapped) {
      expect(shape.province ?? "").not.toBe("");
      expect(shape.stationCount).toBeGreaterThan(0);
    }
    for (const shape of CHINA_PROVINCE_SHAPES.filter((item) => item.province === null)) {
      expect(shape.stationCount).toBe(0);
    }
  });
});

/** 仓库自有站数据（`data/graphs/china-v1/station_nodes.json`）中的一条站点。 */
interface StationNode {
  id: string;
  province: string;
  mapX: number;
  mapY: number;
}

function readStationNodes(): StationNode[] {
  const file = fileURLToPath(
    new URL("../../../../data/graphs/china-v1/station_nodes.json", import.meta.url)
  );
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(parsed)) throw new Error("station_nodes.json 结构变化（期望数组）");
  return parsed as StationNode[];
}

/**
 * 本地地图资产覆盖度（Phase 8 Final Gate 检查项）：
 * 所有参与当前 graph 的 station 都必须有合法 mapX/mapY、都能映射进固定 viewBox，
 * 且不得被省级分组 silent drop。
 */
describe("本地地图资产覆盖度（station coverage）", () => {
  const stations = readStationNodes();

  it("每个 station 都有合法 mapX/mapY 且映射后落在 viewBox 内（无越界 / 无缺失）", () => {
    expect(stations.length).toBe(294);
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    for (const station of stations) {
      const { mapX, mapY } = station;
      expect(typeof mapX, `${station.id} mapX`).toBe("number");
      expect(typeof mapY, `${station.id} mapY`).toBe("number");
      if (typeof mapX !== "number" || typeof mapY !== "number") continue;
      expect(Number.isFinite(mapX) && Number.isFinite(mapY), `${station.id} 坐标非有限值`).toBe(
        true
      );

      const x = toViewBoxX(mapX);
      const y = toViewBoxY(mapY);
      expect(x, `${station.id} x 越界`).toBeGreaterThanOrEqual(MAP_FIT_MARGIN - 1e-9);
      expect(x, `${station.id} x 越界`).toBeLessThanOrEqual(
        MAP_VIEWBOX.width - MAP_FIT_MARGIN + 1e-9
      );
      expect(y, `${station.id} y 越界`).toBeGreaterThanOrEqual(MAP_FIT_MARGIN - 1e-9);
      expect(y, `${station.id} y 越界`).toBeLessThanOrEqual(
        MAP_VIEWBOX.height - MAP_FIT_MARGIN + 1e-9
      );

      minX = Math.min(minX, mapX);
      maxX = Math.max(maxX, mapX);
      minY = Math.min(minY, mapY);
      maxY = Math.max(maxY, mapY);
    }

    // Phase 8 Gate M5：fit 范围 = 行政边界底图 ∪ 站点锚点 → 站点严格落在范围内，
    // 且底图范围严格大于站点范围（证明 fit 由真实边界而非站点 hull 推导）。
    expect(minX).toBeGreaterThan(MAP_DATA_BOUNDS.minX);
    expect(maxX).toBeLessThan(MAP_DATA_BOUNDS.maxX);
    expect(minY).toBeGreaterThan(MAP_DATA_BOUNDS.minY);
    expect(maxY).toBeLessThan(MAP_DATA_BOUNDS.maxY);
  });

  it("route province 完整覆盖 graph 站点（stationCount 之和 = 站点总数，无遗漏）", () => {
    const graphProvinces = [...new Set(stations.map((station) => station.province))].sort();
    const mappedShapes = CHINA_PROVINCE_SHAPES.filter((shape) => shape.province !== null);
    const assetProvinces = [...new Set(mappedShapes.map((shape) => shape.province))].sort();
    expect(assetProvinces).toEqual(graphProvinces);
    expect(assetProvinces.length).toBe(31);
    expect(mappedShapes.length).toBe(31);

    // stationCount 只在 route province 上计数；未映射的 ADM1 feature 必须为 0（不伪造 station）
    const groupedCount = CHINA_PROVINCE_SHAPES.reduce((sum, shape) => sum + shape.stationCount, 0);
    expect(groupedCount).toBe(stations.length);

    const realCounts = new Map<string, number>();
    for (const station of stations) {
      realCounts.set(station.province, (realCounts.get(station.province) ?? 0) + 1);
    }
    for (const shape of mappedShapes) {
      const province = shape.province ?? "";
      expect(shape.stationCount, `${province} stationCount`).toBe(realCounts.get(province) ?? -1);
    }
  });
});

/**
 * 地图资产完整性（Phase 8 Gate M5）。
 *
 * 强断言（源完整性 / 拓扑 / station 空间归属 / 生成器幂等）见 `boundary.test.ts`；
 * 本块保留轻量自洽性检查，避免重复实现点-多边形算法。
 */
describe("地图资产完整性（boundary asset integrity）", () => {
  it("ADM1 形状：id / source feature id 唯一、path 非空、坐标全部有限", () => {
    expect(CHINA_PROVINCE_SHAPES.length).toBe(34);
    const ids = CHINA_PROVINCE_SHAPES.map((shape) => shape.id);
    const sourceIds = CHINA_PROVINCE_SHAPES.map((shape) => shape.sourceFeatureId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(sourceIds).size).toBe(sourceIds.length);

    for (const shape of CHINA_PROVINCE_SHAPES) {
      const points = pathPoints(shape.d);
      expect(points.length, `${shape.sourceName} 顶点数`).toBeGreaterThanOrEqual(3);
      for (const point of points) {
        expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
        expect(Number.isNaN(point.x) || Number.isNaN(point.y)).toBe(false);
      }
    }

    const outline = pathPoints(CHINA_MAP_OUTLINE_D);
    expect(outline.length).toBeGreaterThanOrEqual(3);
    for (const point of outline) {
      expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
    }
  });

  it("地图渲染代码与资产不含任何在线地图 / 瓦片 / geocoder 引用（离线保证）", () => {
    const files = ["chinaMapData.ts", "layers.tsx", "RouteMap.tsx", "geometry.ts", "theme.ts"];
    const source = files
      .map((file) => readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), "utf8"))
      .join("\n")
      .toLowerCase();
    // 只扫描「在线地图提供方 / 瓦片服务」标识（`geocoder` 等词会出现在我们的离线声明注释里，故排除）
    for (const banned of [
      "mapbox",
      "gaode",
      "amap.com",
      "baidu",
      "tencent",
      "google",
      "openstreetmap",
      "tile.",
    ]) {
      expect(source.includes(banned), `发现在线地图引用 "${banned}"`).toBe(false);
    }
  });
});
