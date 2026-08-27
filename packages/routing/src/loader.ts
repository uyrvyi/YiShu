import { TRANSPORT_TYPES, type TransportType } from "@yishu/shared";
import type { GraphData, Graph, StationNode, RouteEdge, AdjacentEdge } from "./types.js";

/**
 * 静态路网加载与校验（对应 Phase 4 Prompt §9）。
 *
 * 职责：
 * - 读取 station_nodes.json / route_edges.json（由调用方提供）
 * - schema 校验 / 数据完整性校验
 * - 建立 node map 与 adjacency list（无向边双向展开）
 *
 * 不依赖运行时 HTTP；校验失败立即抛出，避免运行时才发现静态数据错误。
 */

/** 图加载与校验结果，含统计信息（对应 Phase 4 Prompt §33）。 */
export interface GraphValidationResult {
  nodeCount: number;
  edgeCount: number;
  /** 连通分量数量（仅统计有边的连通块）。 */
  connectedComponentCount: number;
  /** 孤立节点数（无任何边连接的节点）。 */
  isolatedNodeCount: number;
  /** 非法边数量（端点不存在 / 自环 / distance<=0 / allowedTransport 空或不合法）。 */
  invalidEdgeCount: number;
  /** 重复边数量（同一无向端点对出现多次）。 */
  duplicateEdgeCount: number;
}

function isValidTransport(t: unknown): t is TransportType {
  return typeof t === "string" && (TRANSPORT_TYPES as readonly string[]).includes(t);
}

/** 校验单个节点字段。 */
function assertNode(n: unknown, index: number): StationNode {
  if (typeof n !== "object" || n === null) {
    throw new Error(`station_nodes[${index}] 不是对象`);
  }
  const node = n as Record<string, unknown>;
  const id = node.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`station_nodes[${index}].id 非法`);
  }
  const lat = node.lat;
  const lng = node.lng;
  if (typeof lat !== "number" || lat < -90 || lat > 90) {
    throw new Error(`station_nodes[${index}](${String(id)}).lat 非法`);
  }
  if (typeof lng !== "number" || lng < -180 || lng > 180) {
    throw new Error(`station_nodes[${index}](${String(id)}).lng 非法`);
  }
  const mapX = node.mapX;
  const mapY = node.mapY;
  if (typeof mapX !== "number" || !Number.isFinite(mapX)) {
    throw new Error(`station_nodes[${index}](${String(id)}).mapX 非法`);
  }
  if (typeof mapY !== "number" || !Number.isFinite(mapY)) {
    throw new Error(`station_nodes[${index}](${String(id)}).mapY 非法`);
  }
  for (const key of ["name", "province", "city"] as const) {
    if (typeof node[key] !== "string" || node[key].length === 0) {
      throw new Error(`station_nodes[${index}](${String(id)}).${key} 非法`);
    }
  }
  return {
    id,
    name: node.name as string,
    province: node.province as string,
    city: node.city as string,
    lat,
    lng,
    mapX,
    mapY,
  };
}

/** 校验单条边字段（不检查端点存在性，由调用方决定）。 */
function edgeFieldErrors(e: RouteEdge): string[] {
  const errors: string[] = [];
  if (typeof e.from !== "string" || e.from.length === 0) errors.push("from");
  if (typeof e.to !== "string" || e.to.length === 0) errors.push("to");
  if (e.from === e.to) errors.push("self-loop");
  if (typeof e.distanceKm !== "number" || !(e.distanceKm > 0)) errors.push("distanceKm");
  if (typeof e.enabled !== "boolean") errors.push("enabled");
  if (!Array.isArray(e.allowedTransport) || e.allowedTransport.length === 0) {
    errors.push("allowedTransport");
  } else if (!e.allowedTransport.every(isValidTransport)) {
    errors.push("allowedTransport:invalid");
  }
  return errors;
}

/**
 * 构建图（含完整校验）。
 * @param data 原始节点与边数据
 * @param graphVersion 可选图版本（冻结语义：写入 Graph.graphVersion）
 * @returns 校验后的 Graph
 * @throws 任何数据不一致
 */
export function buildGraph(data: GraphData, graphVersion?: string): Graph {
  const nodes = new Map<string, StationNode>();
  for (let i = 0; i < data.nodes.length; i++) {
    const node = assertNode(data.nodes[i], i);
    if (nodes.has(node.id)) {
      throw new Error(`station_nodes 存在重复 id: ${node.id}`);
    }
    nodes.set(node.id, node);
  }

  const adjacency = new Map<string, AdjacentEdge[]>();
  const ensure = (id: string): AdjacentEdge[] => {
    let list = adjacency.get(id);
    if (!list) {
      list = [];
      adjacency.set(id, list);
    }
    return list;
  };

  for (const e of data.edges) {
    // 端点存在性 + 字段校验
    if (!nodes.has(e.from) || !nodes.has(e.to)) {
      throw new Error(`route_edge 端点不存在: ${e.from} -> ${e.to}`);
    }
    const fieldErrors = edgeFieldErrors(e);
    if (fieldErrors.length > 0) {
      throw new Error(`route_edge 非法字段 ${fieldErrors.join(",")}: ${e.from} -> ${e.to}`);
    }
    const adj: AdjacentEdge = {
      from: e.from,
      to: e.to,
      distanceKm: e.distanceKm,
      enabled: e.enabled,
      allowedTransport: e.allowedTransport,
    };
    ensure(e.from).push(adj);
    if (e.from !== e.to) {
      ensure(e.to).push({ ...adj, from: e.to, to: e.from });
    }
  }

  return { nodes, adjacency, graphVersion: graphVersion ?? data.graphVersion };
}

/**
 * 校验图并产出统计报告（对应 Phase 4 Prompt §33）。
 * 不抛错（除 JSON 解析/字段严重错误外），便于独立测试报告。
 */
export function validateGraph(data: GraphData): GraphValidationResult {
  const nodeIds = new Set<string>();
  let nodeCount = 0;
  for (let i = 0; i < data.nodes.length; i++) {
    const node = assertNode(data.nodes[i], i);
    if (nodeIds.has(node.id)) {
      throw new Error(`station_nodes 存在重复 id: ${node.id}`);
    }
    nodeIds.add(node.id);
    nodeCount++;
  }

  let edgeCount = 0;
  let invalidEdgeCount = 0;
  const undirectedSeen = new Set<string>();
  const duplicateKeys = new Set<string>();
  const connectedSet = new Set<string>();

  for (const e of data.edges) {
    edgeCount++;
    const fromOk = nodeIds.has(e.from);
    const toOk = nodeIds.has(e.to);
    const fieldErrors = edgeFieldErrors(e);
    if (!fromOk || !toOk || fieldErrors.length > 0) {
      invalidEdgeCount++;
      continue;
    }
    const a = String(e.from);
    const b = String(e.to);
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (undirectedSeen.has(key)) {
      duplicateKeys.add(key);
    } else {
      undirectedSeen.add(key);
    }
    connectedSet.add(a);
    connectedSet.add(b);
  }

  // 连通分量（仅遍历有效边的连通块）
  const adj = new Map<string, string[]>();
  const link = (x: string, y: string) => {
    const list = adj.get(x);
    if (list) {
      list.push(y);
    } else {
      adj.set(x, [y]);
    }
  };
  for (const e of data.edges) {
    if (invalidEdgeCount > 0 && (!nodeIds.has(e.from) || !nodeIds.has(e.to))) continue;
    if (edgeFieldErrors(e).length > 0) continue;
    link(e.from, e.to);
    link(e.to, e.from);
  }
  const visited = new Set<string>();
  let connectedComponentCount = 0;
  for (const id of connectedSet) {
    if (visited.has(id)) continue;
    connectedComponentCount++;
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop();
      if (cur === undefined) continue;
      if (visited.has(cur)) continue;
      visited.add(cur);
      for (const nxt of adj.get(cur) ?? []) {
        if (!visited.has(nxt)) stack.push(nxt);
      }
    }
  }

  const isolatedNodeCount = nodeCount - connectedSet.size;

  return {
    nodeCount,
    edgeCount,
    connectedComponentCount,
    isolatedNodeCount,
    invalidEdgeCount,
    duplicateEdgeCount: duplicateKeys.size,
  };
}
