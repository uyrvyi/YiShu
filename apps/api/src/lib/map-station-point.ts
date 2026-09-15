/**
 * Phase 8 —— 站点**显示坐标**解析（display-only correction layer）。
 *
 * 背景（Phase 8 Gate「Yangquan 修复」）：`china-v1` 是字节冻结的 Phase 4 基线，其中 `yangquan`
 * 的近似坐标（lat 35.1975 / lng 113.5841）落在河南省一侧，与真实位置偏差约 295 km，导致
 * legacy 信件的地图跨省。冻结基线**不可改写**，因此修正只作用于**渲染坐标**：
 *
 * - 图数据（`station_nodes.json`）与路由 / 距离 / World Truth **完全不变**；
 * - `china-v2` 已在数据侧使用正确坐标（`VERSION_OVERRIDES.yangquan`），无需显示修正；
 * - legacy（`china-v1`）信件通过本模块在**读取时**映射到正确显示位置，不改库、不改已冻结资产。
 *
 * 数据来源：`data/maps/station-display-corrections.json`（版本化、人工批准，附 source / reason）。
 * 该文件缺失或内容非法时**明确抛错**（fail fast，绝不静默降级成错误地图）。加载时强制以下校验
 * （Phase 8 Gate 复核 MEDIUM-1：任何一项不满足都必须抛错，而不是静默使用冻结坐标）：
 *
 * 1. **对象结构**：顶层必须是 `{ [graphVersion]: { [nodeId]: entry } }` 形式的普通对象
 *    （数组 / `null` / 字符串 / 数字一律拒绝）；每个版本的值必须是普通对象；版本对象至少含一条
 *    修正（空对象 = 无效声明）。
 * 2. **版本存在性**：每个版本 key 必须是 `data/graphs/registry.json` 已登记的图版本。
 * 3. **站点存在性**：每个 nodeId 必须存在于该版本的 `station_nodes.json`（拼写错误即失败）。
 * 4. **来源字段**：每条修正必须带非空字符串 `source` 与 `reason`，且**只允许**这四个字段
 *    （`lat` / `lng` / `source` / `reason`，未知字段即失败）。
 * 5. **坐标边界**：`lat` / `lng` 必须是有限数且在合法经纬度范围内，投影到 `mapX/mapY` 后必须
 *    落在冻结的 `MAP_DATA_BOUNDS` 内（否则抛出，避免渲染到固定 viewBox 之外）。
 *
 * 单一事实来源：所有对用户暴露 station 坐标的路径（Map DTO / Journey 路线节点）都必须经本模块，
 * 保证同一封信在 Timeline / Journey / Map 上的经纬位置一致。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  MAP_DATA_BOUNDS,
  projectLngLatToMapPoint,
  type MapPoint,
  type MapStation,
} from "@yishu/shared";
import type { StationNode } from "@yishu/routing";
import { getDataDir, getGraphVersions, getStationNode } from "./stationGraph.js";

/** 单条显示修正（人工批准的可追溯记录）。 */
interface DisplayCorrection {
  lat: number;
  lng: number;
  /** 坐标来源（可追溯）。 */
  source: string;
  /** 修正原因（为何冻结数据不可改）。 */
  reason: string;
}

/** `{ [graphVersion]: { [nodeId]: correction } }`。 */
type DisplayCorrections = Record<string, Record<string, DisplayCorrection>>;

const CORRECTIONS_SUBDIR = "maps";
const CORRECTIONS_FILE = "station-display-corrections.json";
/** 允许的字段（精确 schema；未知字段视为配置错误）。 */
const ALLOWED_FIELDS: readonly string[] = ["lat", "lng", "reason", "source"];

/** 「未注入」哨兵：与注入内容 `null`（非法配置）区分开。 */
const NO_OVERRIDE = Symbol("station-display-corrections-no-override");

let correctionsCache: DisplayCorrections | null = null;
/** 测试专用：覆盖磁盘读取的原始内容（故障注入）；`NO_OVERRIDE` = 从磁盘读取。 */
let correctionsOverride: unknown = NO_OVERRIDE;

/** 重置显示修正缓存与故障注入（测试用；恢复为从磁盘读取）。 */
export function resetStationDisplayCorrections(): void {
  correctionsCache = null;
  correctionsOverride = NO_OVERRIDE;
}

/**
 * 测试专用：注入显示修正表**原始内容**（模拟损坏 / 误配置，仅内存、不写文件）。
 * 每次调用都会清空缓存，保证下一次解析走注入内容；用 `resetStationDisplayCorrections()`
 * 恢复为从磁盘读取。
 */
export function setStationDisplayCorrectionsForTest(raw: unknown): void {
  correctionsOverride = raw;
  correctionsCache = null;
}

/** 显示修正文件的绝对路径（与 `data/graphs` 同数据根）。 */
function correctionsPath(): string {
  return path.join(getDataDir(), CORRECTIONS_SUBDIR, CORRECTIONS_FILE);
}

/** 配置错误统一出口（fail fast；绝不静默降级成冻结坐标）。 */
function invalidCorrections(detail: string, cause?: unknown): never {
  throw new Error(
    `station_display_corrections_invalid: ${detail}`,
    cause === undefined ? undefined : { cause }
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireFiniteNumber(value: unknown, detail: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalidCorrections(`${detail} must be a finite number`);
  }
  return value;
}

function requireNonEmptyString(value: unknown, detail: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    invalidCorrections(`${detail} must be a non-empty string`);
  }
  return value;
}

/** 投影到 `mapX/mapY` 并断言落在冻结 `MAP_DATA_BOUNDS` 内。 */
function projectCorrectionPoint(
  graphVersion: string,
  nodeId: string,
  correction: DisplayCorrection
): MapPoint {
  const point = projectLngLatToMapPoint(correction.lng, correction.lat);
  if (
    point.x < MAP_DATA_BOUNDS.minX ||
    point.x > MAP_DATA_BOUNDS.maxX ||
    point.y < MAP_DATA_BOUNDS.minY ||
    point.y > MAP_DATA_BOUNDS.maxY
  ) {
    invalidCorrections(
      `${graphVersion}/${nodeId} projects outside MAP_DATA_BOUNDS -> ${point.x},${point.y}`
    );
  }
  return point;
}

/** 站点存在性：nodeId 必须属于该图版本（否则拼写错误会静默丢修正）。 */
function assertStationExists(graphVersion: string, nodeId: string): void {
  try {
    getStationNode(nodeId, graphVersion);
  } catch (error) {
    invalidCorrections(`${graphVersion}/${nodeId} is not a station of that graph version`, error);
  }
}

/** 单条修正的完整校验（结构 + 字段 + 经纬度范围 + 投影边界）。 */
function parseCorrection(graphVersion: string, nodeId: string, raw: unknown): DisplayCorrection {
  const where = `${graphVersion}/${nodeId}`;
  if (!isPlainObject(raw)) invalidCorrections(`${where} must be an object`);
  for (const field of Object.keys(raw)) {
    if (!ALLOWED_FIELDS.includes(field))
      invalidCorrections(`${where} has unknown field "${field}"`);
  }
  const lat = requireFiniteNumber(raw["lat"], `${where}.lat`);
  const lng = requireFiniteNumber(raw["lng"], `${where}.lng`);
  if (lat < -90 || lat > 90) invalidCorrections(`${where}.lat out of range: ${lat}`);
  if (lng < -180 || lng > 180) invalidCorrections(`${where}.lng out of range: ${lng}`);
  const correction: DisplayCorrection = {
    lat,
    lng,
    source: requireNonEmptyString(raw["source"], `${where}.source`),
    reason: requireNonEmptyString(raw["reason"], `${where}.reason`),
  };
  projectCorrectionPoint(graphVersion, nodeId, correction);
  return correction;
}

/** 读取并完整校验显示修正表（进程级缓存；任何非法内容立即抛错，不静默降级）。 */
function loadCorrections(): DisplayCorrections {
  if (correctionsCache !== null) return correctionsCache;
  const file = correctionsPath();
  let raw: unknown = correctionsOverride;
  if (raw === NO_OVERRIDE) {
    try {
      raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    } catch (error) {
      throw new Error(`station_display_corrections_unreadable: ${file}`, { cause: error });
    }
  }
  correctionsCache = parseCorrections(raw);
  return correctionsCache;
}

/** 严格解析 + 校验（顶层为空对象 = 明确「当前无需显示修正」；版本对象不得为空）。 */
function parseCorrections(raw: unknown): DisplayCorrections {
  if (!isPlainObject(raw)) {
    invalidCorrections("top-level must be an object keyed by graphVersion");
  }
  const knownVersions = new Set(getGraphVersions());
  const result: DisplayCorrections = {};
  for (const [graphVersion, nodes] of Object.entries(raw)) {
    if (!knownVersions.has(graphVersion)) {
      invalidCorrections(
        `unknown graphVersion "${graphVersion}" (known: ${[...knownVersions].join(", ")})`
      );
    }
    if (!isPlainObject(nodes)) {
      invalidCorrections(`${graphVersion} must be an object keyed by nodeId`);
    }
    const nodeIds = Object.keys(nodes);
    if (nodeIds.length === 0) {
      invalidCorrections(`${graphVersion} declares no correction (empty object is not allowed)`);
    }
    const byNode: Record<string, DisplayCorrection> = {};
    for (const nodeId of nodeIds) {
      assertStationExists(graphVersion, nodeId);
      byNode[nodeId] = parseCorrection(graphVersion, nodeId, nodes[nodeId]);
    }
    result[graphVersion] = byNode;
  }
  return result;
}

/** 该 (graphVersion, nodeId) 的显示修正（无则 null）。 */
function displayCorrection(graphVersion: string, nodeId: string): DisplayCorrection | null {
  const byVersion = loadCorrections()[graphVersion];
  if (byVersion === undefined) return null;
  return byVersion[nodeId] ?? null;
}

/** 站点在用户可见地图上的坐标：冻结图坐标，或该版本的显示修正（canonical 投影 + 边界校验）。 */
function displayPointOf(node: StationNode, graphVersion: string): MapPoint {
  const correction = displayCorrection(graphVersion, node.id);
  if (correction === null) return { x: node.mapX, y: node.mapY };
  return projectCorrectionPoint(graphVersion, node.id, correction);
}

/** 未知节点返回 null（位置数据问题不阻断用户事实，与 Timeline 语义一致）。 */
function tryGetStationNode(nodeId: string, graphVersion: string): StationNode | null {
  try {
    return getStationNode(nodeId, graphVersion);
  } catch {
    return null;
  }
}

/** 显示坐标（Map DTO / Journey 路线节点共用；未知节点抛错，调用方决定降级策略）。 */
export function resolveDisplayStationPoint(nodeId: string, graphVersion: string): MapPoint {
  return displayPointOf(getStationNode(nodeId, graphVersion), graphVersion);
}

/** Map DTO 用站点视图（name / province / city + 显示坐标）；未知节点返回 null。 */
export function resolveMapStationPoint(params: {
  graphVersion: string;
  nodeId: string;
}): MapStation | null {
  const node = tryGetStationNode(params.nodeId, params.graphVersion);
  if (node === null) return null;
  const point = displayPointOf(node, params.graphVersion);
  return { name: node.name, province: node.province, city: node.city, x: point.x, y: point.y };
}
