// Phase 4 canonical map projection（冻结）+ Phase 8 生成器共用 helper。
//
// 该投影是 `data/gen_graph.cjs` 生成 294 个 station 时使用的**同一公式**（等价于把
// 经纬度线性映射到 1000x800 的 world 空间后取 0.1 精度）：
//
//   mapX = round1(((lng + 180) / 360) * 1000)
//   mapY = round1(((90 - lat) / 180) * 800)
//
// 冻结约束（Phase 8 Gate M5）：
// - **不得修改** 294 个 station 已冻结的 `mapX/mapY` 值；`projectStation` 只用于复算校验。
// - 行政边界几何必须复用同一投影（不引入独立 scale / 视觉对齐 hack）；
//   边界顶点保留全精度（`projectLngLat`），只有 station 锚点使用 `round1`（历史冻结行为）。
"use strict";

/** Phase 4/8 固定 world 空间（与 `@yishu/shared` 的 `MAP_VIEWBOX` 同源）。 */
const WORLD = { width: 1000, height: 800 };

/** 0.1 精度（station 锚点冻结值）。 */
function round1(value) {
  return Math.round(value * 10) / 10;
}

/** `lng` → world X（全精度）。 */
function mapXFromLng(lng) {
  return ((lng + 180) / 360) * WORLD.width;
}

/** `lat` → world Y（全精度）。 */
function mapYFromLat(lat) {
  return ((90 - lat) / 180) * WORLD.height;
}

/** 边界 / 地理几何投影（全精度；`mapX/mapY` 坐标系）。 */
function projectLngLat(lng, lat) {
  return [mapXFromLng(lng), mapYFromLat(lat)];
}

/** station 锚点投影（与 Phase 4 冻结值一致：round1）。 */
function projectStation(lng, lat) {
  return [round1(mapXFromLng(lng)), round1(mapYFromLat(lat))];
}

module.exports = { WORLD, round1, mapXFromLng, mapYFromLat, projectLngLat, projectStation };
