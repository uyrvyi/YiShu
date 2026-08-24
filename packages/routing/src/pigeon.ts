import { type TransportType } from "@yishu/shared";
import type { Graph, PathResult, EdgeStep, StationNode } from "./types.js";
import { UnknownNodeError } from "./types.js";
import { haversineKm } from "./geo.js";

/**
 * PIGEON 直连路线（对应开发规范 §26，Phase 4 Prompt §15）。
 *
 * 飞鸽不走普通 road graph：
 * - 任意支持区域两点之间点对点
 * - 使用本地 Haversine 大圆直线距离
 * - 不得调用 Dijkstra / 在线地图
 *
 * 返回单个直连 TransportLeg。
 */
export function planPigeonRoute(
  graph: Graph,
  originNodeId: string,
  destinationNodeId: string
): PathResult {
  const origin = graph.nodes.get(originNodeId);
  const destination = graph.nodes.get(destinationNodeId);
  if (!origin) throw new UnknownNodeError(originNodeId);
  if (!destination) throw new UnknownNodeError(destinationNodeId);

  if (originNodeId === destinationNodeId) {
    return { nodes: [originNodeId], edges: [], totalDistanceKm: 0, found: true };
  }

  const distanceKm = haversineKm(origin.lat, origin.lng, destination.lat, destination.lng);
  const edge: EdgeStep = {
    from: originNodeId,
    to: destinationNodeId,
    transportType: "PIGEON" as TransportType,
    distanceKm,
  };
  return {
    nodes: [originNodeId, destinationNodeId],
    edges: [edge],
    totalDistanceKm: distanceKm,
    found: true,
  };
}

/** 取节点（供 service 计算 mapX/mapY 等）。 */
export function getNode(graph: Graph, nodeId: string): StationNode {
  const n = graph.nodes.get(nodeId);
  if (!n) throw new UnknownNodeError(nodeId);
  return n;
}
