/**
 * 驿书 V1 Routing 包（Phase 4：本地 Graph + Dijkstra + PIGEON 直连）。
 *
 * - 不依赖外部地图服务（开发规范 §14/§15）。
 * - 权重仅 distanceKm（开发规范 §24）。
 * - PIGEON 走 Haversine 直线，绕过 road graph（开发规范 §26）。
 */

export * from "./types.js";
export { buildGraph, validateGraph, type GraphValidationResult } from "./loader.js";
export { findShortestPath } from "./dijkstra.js";
export { planPigeonRoute, getNode } from "./pigeon.js";
export { haversineKm } from "./geo.js";
