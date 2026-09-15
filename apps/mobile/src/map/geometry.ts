/**
 * 地图几何转换（Phase 8 §17）。
 *
 * 坐标系：
 * - 服务端 DTO 坐标为站点 `mapX/mapY`（**不是 GPS 经纬度**，无 exact GPS）。
 * - 渲染统一经 `@yishu/shared` 的 `MAP_FIT` 映射到固定 viewBox `0 0 1000 800`，
 *   与 `data/gen_map.cjs` 生成静态资产时使用同一公式，避免常量漂移。
 *
 * 纯函数、无 IO、无平台依赖 → 可被单元测试直接覆盖。
 */

import { MAP_FIT, MAP_VIEWBOX, type MapPoint } from "@yishu/shared";

/** 固定 viewBox 字符串（不随设备 / 屏幕比例变化）。 */
export const MAP_VIEWBOX_STRING = `0 0 ${String(MAP_VIEWBOX.width)} ${String(MAP_VIEWBOX.height)}`;

/** `mapX` → viewBox X。 */
export function toViewBoxX(mapX: number): number {
  return mapX * MAP_FIT.scale + MAP_FIT.tx;
}

/** `mapY` → viewBox Y。 */
export function toViewBoxY(mapY: number): number {
  return mapY * MAP_FIT.scale + MAP_FIT.ty;
}

/** 单点映射（返回新对象，不改动 DTO 数据）。 */
export function toViewBoxPoint(point: MapPoint): MapPoint {
  return { x: toViewBoxX(point.x), y: toViewBoxY(point.y) };
}

/**
 * 静态资产（`china-districts.json` / `chinaMapData.ts` / `china-map.svg`）的 `path d`
 * 与站点坐标同属 `mapX/mapY` 坐标系，因此静态注册图层直接用同一 fit 变换组装。
 * 语义与逐点调用 `toViewBoxPoint` 完全一致：`X = x * scale + tx`。
 */
export const MAP_FIT_TRANSFORM = `translate(${MAP_FIT.tx.toFixed(6)} ${MAP_FIT.ty.toFixed(
  6
)}) scale(${MAP_FIT.scale.toFixed(6)})`;

/**
 * 静态资产图层（`ChinaOutlineLayer` / `ProvinceBoundaryLayer`）的**描边宽度补偿**（Gate L1）。
 *
 * 这两个图层与资产 `path d` 同处 `mapX/mapY` 坐标系，必须放进 `MAP_FIT_TRANSFORM`
 * （含 `scale`）的 `<G>` 中；此时声明的 `strokeWidth` 会被一并放大（2 → 2 × scale ≈ 9.56），
 * 与 theme 中「viewBox 单位」的语义不符。因此在缩放组内声明宽度时必须先除以 scale：
 *
 * ```text
 * 实际渲染宽度 = viewBoxStrokeWidth(w) × scale = w
 * ```
 */
export function viewBoxStrokeWidth(width: number): number {
  return width / MAP_FIT.scale;
}

/** 折线 `points` 属性（`x1,y1 x2,y2 ...`）。 */
export function toPolylinePoints(points: readonly MapPoint[]): string {
  return points
    .map((point) => {
      const mapped = toViewBoxPoint(point);
      return `${mapped.x.toFixed(1)},${mapped.y.toFixed(1)}`;
    })
    .join(" ");
}
