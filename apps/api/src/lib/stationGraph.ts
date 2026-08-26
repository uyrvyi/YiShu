import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRepoRoot } from "@yishu/config";
import {
  buildGraph,
  findShortestPath,
  planPigeonRoute,
  type Graph,
  type PathResult,
} from "@yishu/routing";
import type { RouteEdge, StationNode } from "@yishu/routing";
import type { TransportType } from "@yishu/shared";

/**
 * 本地静态路网访问层（Phase 4）。
 *
 * - 按 graphVersion 从 data/graphs/<version>/ 读取 station_nodes / route_edges / region_station_map
 * - 注册表 data/graphs/registry.json 登记已知版本；未知版本明确抛 UnknownGraphVersionError（不静默 fallback）
 * - 图与区域映射按版本缓存（进程级单例）
 * - 提供 region → station 映射（完全本地、确定性、无 GPS、无外部 geocoder）
 * - 提供寻路封装（PIGEON 直连 / ground Dijkstra）
 *
 * 不依赖任何外部地图服务。
 */

export class UnknownGraphVersionError extends Error {
  constructor(public readonly graphVersion: string) {
    super(`unknown_graph_version: ${graphVersion}`);
    this.name = "UnknownGraphVersionError";
  }
}

export class NoStationMappingError extends Error {
  constructor(public readonly detail: string) {
    super("no_station_mapping");
    this.name = "NoStationMappingError";
  }
}

interface RegionStationMap {
  cities: Record<string, string>;
  provinces: Record<string, string>;
}

interface GraphRegistry {
  versions: string[];
  defaultVersion: string;
}

const graphCache = new Map<string, Graph>();
const regionMapCache = new Map<string, RegionStationMap>();
let registryCache: GraphRegistry | null = null;

/** 解析 data 目录（兼容源码与编译产物路径）。 */
function dataDir(): string {
  // stationGraph.ts 位于 apps/api/src/lib/，向上找仓库根下的 data
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  // 先尝试从仓库根 data 加载（最稳）
  const repoRoot = resolveRepoRoot();
  const candidate = path.join(repoRoot, "data");
  if (readFileSyncSafe(path.join(candidate, "graphs", "registry.json")) !== null) {
    return candidate;
  }
  // 兜底：从模块目录向上找 data
  let dir = moduleDir;
  for (let i = 0; i < 8; i += 1) {
    const d = path.join(dir, "data");
    if (readFileSyncSafe(path.join(d, "graphs", "registry.json")) !== null) return d;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return candidate;
}

function readFileSyncSafe(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function loadRegistry(): GraphRegistry {
  if (registryCache) return registryCache;
  const dir = dataDir();
  registryCache = JSON.parse(
    readFileSync(path.join(dir, "graphs", "registry.json"), "utf8")
  ) as GraphRegistry;
  return registryCache;
}

/** 版本必须已登记，否则抛 UnknownGraphVersionError（冻结语义）。 */
function assertKnownGraphVersion(graphVersion: string): void {
  const registry = loadRegistry();
  if (!registry.versions.includes(graphVersion)) {
    throw new UnknownGraphVersionError(graphVersion);
  }
}

function graphDir(graphVersion: string): string {
  return path.join(dataDir(), "graphs", graphVersion);
}

function loadGraph(graphVersion: string): Graph {
  assertKnownGraphVersion(graphVersion);
  const cached = graphCache.get(graphVersion);
  if (cached) return cached;
  const dir = graphDir(graphVersion);
  const nodes = JSON.parse(
    readFileSync(path.join(dir, "station_nodes.json"), "utf8")
  ) as StationNode[];
  const edges = JSON.parse(readFileSync(path.join(dir, "route_edges.json"), "utf8")) as RouteEdge[];
  const graph = buildGraph({ nodes, edges }, graphVersion);
  graphCache.set(graphVersion, graph);
  return graph;
}

function loadRegionMap(graphVersion: string): RegionStationMap {
  assertKnownGraphVersion(graphVersion);
  const cached = regionMapCache.get(graphVersion);
  if (cached) return cached;
  const dir = graphDir(graphVersion);
  const regionMap = JSON.parse(
    readFileSync(path.join(dir, "region_station_map.json"), "utf8")
  ) as RegionStationMap;
  regionMapCache.set(graphVersion, regionMap);
  return regionMap;
}

/** 重置缓存（测试用）。 */
export function resetStationGraphCache(): void {
  graphCache.clear();
  regionMapCache.clear();
  registryCache = null;
}

/** 解析 region（省/市/区县）→ 最近 station node id（按指定图版本）。
 * 策略（Phase 4 Prompt §19）：
 *  1. exact city station
 *  2. province major/capital station fallback
 *  找不到明确抛 NoStationMappingError（不 fallback 外部 geocoder）。
 */
export function resolveStationForRegion(
  region: {
    province: string;
    city: string;
    district: string;
  },
  graphVersion: string
): string {
  const map = loadRegionMap(graphVersion);
  const cityStation = map.cities[region.city];
  if (cityStation) return cityStation;
  const provinceStation = map.provinces[region.province];
  if (provinceStation) return provinceStation;
  throw new NoStationMappingError(
    `province=${region.province} city=${region.city} graphVersion=${graphVersion}`
  );
}

/**
 * 规划路线（Phase 4 Prompt §16/§20）。
 * - PIGEON：不走 road graph，Haversine 直连
 * - ground（HAND_CARRY/HORSE_RELAY/EXPRESS_RELAY）：本地 Dijkstra（按指定图版本）
 * @throws UnknownGraphVersionError / UnknownNodeError / NoRouteError
 */
export function planRoute(params: {
  graphVersion: string;
  originNodeId: string;
  destinationNodeId: string;
  transportType: TransportType;
}): PathResult {
  const graph = loadGraph(params.graphVersion);
  if (params.transportType === "PIGEON") {
    return planPigeonRoute(graph, params.originNodeId, params.destinationNodeId);
  }
  return findShortestPath(
    graph,
    params.originNodeId,
    params.destinationNodeId,
    params.transportType
  );
}

/** 取节点（供 service 读取名称/坐标；按指定图版本）。 */
export function getStationNode(nodeId: string, graphVersion: string): StationNode {
  const node = loadGraph(graphVersion).nodes.get(nodeId);
  if (!node) {
    throw new Error(`unknown_node: ${nodeId} (graphVersion=${graphVersion})`);
  }
  return node;
}

/** 读取原始图数据（nodes/edges 数组，用于排除边重建图）。 */
function loadRawGraph(graphVersion: string): { nodes: StationNode[]; edges: RouteEdge[] } {
  assertKnownGraphVersion(graphVersion);
  const dir = graphDir(graphVersion);
  const nodes = JSON.parse(
    readFileSync(path.join(dir, "station_nodes.json"), "utf8")
  ) as StationNode[];
  const edges = JSON.parse(readFileSync(path.join(dir, "route_edges.json"), "utf8")) as RouteEdge[];
  return { nodes, edges };
}

/**
 * 规划路线并排除指定边（Phase 6 reroute）。
 * 事件导致当前 Edge 不可用时，从当前节点重新 Dijkstra；排除边在重建图中置 enabled=false，
 * 保持与 Phase 4 相同权重（distanceKm）与确定性 tie-break。
 * PIGEON 不走 road graph，忽略 excludedEdge（不按 road graph reroute）。
 * @throws UnknownGraphVersionError / UnknownNodeError / NoRouteError
 */
export function planRouteExcluding(params: {
  graphVersion: string;
  originNodeId: string;
  destinationNodeId: string;
  transportType: TransportType;
  /** 需排除的无向边（from/to 两端任一匹配即排除）。 */
  excludedEdge?: { from: string; to: string };
}): PathResult {
  const graph = loadGraph(params.graphVersion);
  if (params.transportType === "PIGEON") {
    return planPigeonRoute(graph, params.originNodeId, params.destinationNodeId);
  }
  if (!params.excludedEdge) {
    return findShortestPath(
      graph,
      params.originNodeId,
      params.destinationNodeId,
      params.transportType
    );
  }
  const { from, to } = params.excludedEdge;
  const raw = loadRawGraph(params.graphVersion);
  const filteredEdges = raw.edges.map((edge) => {
    const blocked =
      (edge.from === from && edge.to === to) || (edge.from === to && edge.to === from);
    return blocked ? { ...edge, enabled: false } : edge;
  });
  const rebuilt = buildGraph({ nodes: raw.nodes, edges: filteredEdges }, params.graphVersion);
  return findShortestPath(
    rebuilt,
    params.originNodeId,
    params.destinationNodeId,
    params.transportType
  );
}
