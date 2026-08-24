import { type TransportType } from "@yishu/shared";
import type { Graph, PathResult, EdgeStep, AdjacentEdge } from "./types.js";
import { UnknownNodeError, NoRouteError } from "./types.js";

/**
 * Dijkstra 最短路径（对应开发规范 §24，Phase 4 Prompt §10–§14）。
 *
 * 约束：
 * - 唯一权重：distanceKm（禁止天气/拥堵/疲劳/随机等权重）
 * - 遍历前过滤：enabled === true 且 allowedTransport includes transportType
 * - 确定性：相同 (graphVersion, origin, destination, transportType) 必须产生相同路线
 * - 距离相同的多条路径：使用稳定 tie-break（node id 字典序），不依赖 Map 插入顺序
 * - origin === destination：返回空路线、距离 0
 * - 无连通：抛 NoRouteError（不得 fallback 外部 API / 不得自动改 transport）
 */

// 最小二叉堆（按距离 + tie-break 稳定排序），避免依赖外部库。
class MinHeap {
  private heap: Array<{ node: string; dist: number }> = [];

  get size(): number {
    return this.heap.length;
  }

  push(node: string, dist: number): void {
    const h = this.heap;
    h.push({ node, dist });
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      const cur = h[i];
      const par = h[p];
      // 控制流收窄：i>0 时 p>=0 且 p<i，二者必存在
      if (cur === undefined || par === undefined) break;
      if (compare(par, cur) <= 0) break;
      h[i] = par;
      h[p] = cur;
      i = p;
    }
  }

  pop(): { node: string; dist: number } | undefined {
    const h = this.heap;
    if (h.length === 0) return undefined;
    const top = h[0];
    const last = h.pop();
    if (last === undefined) return top; // 仅当堆为空时触发，上面已 guard
    if (h.length > 0) {
      h[0] = last;
      let i = 0;
      const n = h.length;
      for (;;) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let smallest = i;
        // 比较前先收窄，避免越界/undefined 赋值
        const a = h[i];
        if (a === undefined) break;
        if (l < n) {
          const left = h[l];
          if (left !== undefined && compare(left, a) < 0) smallest = l;
        }
        if (r < n) {
          const right = h[r];
          const best = h[smallest];
          if (right !== undefined && best !== undefined && compare(right, best) < 0) {
            smallest = r;
          }
        }
        if (smallest === i) break;
        const x = h[smallest];
        const y = h[i];
        if (x === undefined || y === undefined) break;
        h[smallest] = y;
        h[i] = x;
        i = smallest;
      }
    }
    return top;
  }
}

/** 稳定比较：距离优先；距离相同按 node id 字典序（确定性 tie-break）。undefined 视为最大。 */
function compare(
  a: { node: string; dist: number } | undefined,
  b: { node: string; dist: number } | undefined
): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  if (a.dist !== b.dist) return a.dist - b.dist;
  return a.node < b.node ? -1 : a.node > b.node ? 1 : 0;
}

/** 边是否可用于当前 transportType。 */
function usable(edge: AdjacentEdge, transportType: TransportType): boolean {
  return edge.enabled && edge.allowedTransport.includes(transportType);
}

/**
 * 在本地 road graph 上寻找最短路径。
 * @throws UnknownNodeError 节点不存在
 * @throws NoRouteError 不可达
 */
export function findShortestPath(
  graph: Graph,
  originNodeId: string,
  destinationNodeId: string,
  transportType: TransportType
): PathResult {
  if (!graph.nodes.has(originNodeId)) {
    throw new UnknownNodeError(originNodeId);
  }
  if (!graph.nodes.has(destinationNodeId)) {
    throw new UnknownNodeError(destinationNodeId);
  }

  // origin === destination
  if (originNodeId === destinationNodeId) {
    return { nodes: [originNodeId], edges: [], totalDistanceKm: 0, found: true };
  }

  const dist = new Map<string, number>();
  const prev = new Map<string, { from: string; edge: AdjacentEdge }>();
  const visited = new Set<string>();
  dist.set(originNodeId, 0);

  const heap = new MinHeap();
  heap.push(originNodeId, 0);

  while (heap.size > 0) {
    const cur = heap.pop();
    if (cur === undefined) break;
    if (visited.has(cur.node)) continue;
    visited.add(cur.node);
    if (cur.node === destinationNodeId) break;

    const neighbors = graph.adjacency.get(cur.node) ?? [];
    for (const edge of neighbors) {
      if (visited.has(edge.to)) continue;
      if (!usable(edge, transportType)) continue;
      const nd = cur.dist + edge.distanceKm;
      const existing = dist.get(edge.to);
      if (existing === undefined || nd < existing) {
        // 严格更优：直接更新
        dist.set(edge.to, nd);
        prev.set(edge.to, { from: cur.node, edge });
        heap.push(edge.to, nd);
      } else if (nd === existing) {
        // 距离相同：稳定 tie-break（通过 prev 链字典序比较，避免 Map 顺序依赖）
        if (isBetterPrev(prev.get(edge.to), cur.node, edge, graph)) {
          prev.set(edge.to, { from: cur.node, edge });
          heap.push(edge.to, nd);
        }
      }
    }
  }

  if (!prev.has(destinationNodeId) && originNodeId !== destinationNodeId) {
    throw new NoRouteError(originNodeId, destinationNodeId);
  }

  // 回溯路径
  const nodeSeq: string[] = [];
  const edgeSeq: EdgeStep[] = [];
  let curr = destinationNodeId;
  let total = 0;
  while (curr !== originNodeId) {
    const step = prev.get(curr);
    if (!step) {
      throw new NoRouteError(originNodeId, destinationNodeId);
    }
    nodeSeq.unshift(curr);
    edgeSeq.unshift({
      from: step.from,
      to: step.edge.to,
      transportType,
      distanceKm: step.edge.distanceKm,
    });
    total += step.edge.distanceKm;
    curr = step.from;
  }
  nodeSeq.unshift(originNodeId);

  return { nodes: nodeSeq, edges: edgeSeq, totalDistanceKm: total, found: true };
}

/**
 * 距离相同情况下，判断新路径是否"更优"（用于稳定 tie-break）。
 * 规则：比较从 origin 到 edge.to 的整条 prev 链，字典序更小者胜。
 * 这保证相同 (origin, dest, transport) 一定产生相同路线，不依赖遍历顺序。
 */
function isBetterPrev(
  current: { from: string; edge: AdjacentEdge } | undefined,
  candidateFrom: string,
  candidateEdge: AdjacentEdge,
  _graph: Graph
): boolean {
  if (!current) return true;
  // 比较候选路径与当前路径在 edge.to 处的前驱链字典序
  const candKey = prevChainKey(candidateFrom, candidateEdge);
  const curKey = prevChainKey(current.from, current.edge);
  return candKey < curKey;
}

/** 生成用于稳定比较的键（前驱 node + 边端点）。 */
function prevChainKey(from: string, edge: AdjacentEdge): string {
  return `${from}->${edge.from}:${edge.to}`;
}
