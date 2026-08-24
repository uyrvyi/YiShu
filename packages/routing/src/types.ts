import type { TransportType } from "@yishu/shared";

/**
 * 驿书 V1 Routing 包类型定义（Phase 4：本地 Graph + Dijkstra）。
 *
 * 所有 graph 身份使用稳定字符串 node id（来自静态数据文件），
 * 绝不使用数据库自增 id 作为 graph identity。
 */

/** 驿站节点（对应开发规范 §16）。 */
export interface StationNode {
  /** 稳定 id（如 "shanghai"），全局唯一。 */
  id: string;
  name: string;
  province: string;
  city: string;
  /** 纬度 ∈ [-90, 90]。 */
  lat: number;
  /** 经度 ∈ [-180, 180]。 */
  lng: number;
  /** 地图坐标（svg viewBox 内），数字合法。 */
  mapX: number;
  mapY: number;
}

/** 路线边（对应开发规范 §23）。数据中每条 edge 表示双向连接。 */
export interface RouteEdge {
  from: string;
  to: string;
  distanceKm: number;
  enabled: boolean;
  allowedTransport: TransportType[];
}

/** 图加载原始数据。 */
export interface GraphData {
  nodes: StationNode[];
  edges: RouteEdge[];
  /** 可选：图版本（构建后写入 Graph.graphVersion，用于冻结版本可复现性）。 */
  graphVersion?: string;
}

/** 已构建的、可查询的图。 */
export interface Graph {
  /** nodeId → StationNode。 */
  nodes: ReadonlyMap<string, StationNode>;
  /**
   * 邻接表：nodeId → 出边列表（无向图已双向展开）。
   * 每条 AdjacentEdge 已包含端点与允许运输方式。
   */
  adjacency: ReadonlyMap<string, AdjacentEdge[]>;
  /** 图版本（来自静态数据 meta，可选）。 */
  graphVersion?: string;
}

/** 邻接表中的一条边（已展开方向）。 */
export interface AdjacentEdge {
  from: string;
  to: string;
  distanceKm: number;
  enabled: boolean;
  allowedTransport: TransportType[];
}

/** 寻路结果（对应 Phase 4 Prompt §10）。 */
export interface PathResult {
  /** 节点 id 序列（含起点与终点）。 */
  nodes: string[];
  /** 边序列（相邻节点对）。 */
  edges: EdgeStep[];
  totalDistanceKm: number;
  /** 找到路线时为 true；无路线为 false。 */
  found: boolean;
}

/** 路线中的一段（对应一条 RouteEdge 或一个 pigeon 直连）。 */
export interface EdgeStep {
  from: string;
  to: string;
  transportType: TransportType;
  distanceKm: number;
}

/** 寻路未找到路线时的 typed 错误。 */
export class NoRouteError extends Error {
  constructor(
    public readonly originNodeId: string,
    public readonly destinationNodeId: string
  ) {
    super(`no_route: ${originNodeId} -> ${destinationNodeId}`);
    this.name = "NoRouteError";
  }
}

/** 节点不存在的 typed 错误。 */
export class UnknownNodeError extends Error {
  constructor(public readonly nodeId: string) {
    super(`unknown_node: ${nodeId}`);
    this.name = "UnknownNodeError";
  }
}
