import { describe, expect, it } from "vitest";
import {
  buildGraph,
  validateGraph,
  findShortestPath,
  planPigeonRoute,
  haversineKm,
  NoRouteError,
  UnknownNodeError,
  type GraphData,
} from "./index.js";
import type { RouteEdge } from "./types.js";

/** 最小 fixture（Phase 4 Prompt §14）：
 *  A --10-- B --10-- D
 *  A -------50------- D
 *  期望 A → B → D, distance = 20
 */
const nodes = [
  { id: "A", name: "A站", province: "P", city: "A", lat: 31.0, lng: 121.0, mapX: 100, mapY: 100 },
  { id: "B", name: "B站", province: "P", city: "B", lat: 31.1, lng: 121.1, mapX: 200, mapY: 100 },
  { id: "D", name: "D站", province: "P", city: "D", lat: 31.2, lng: 121.2, mapX: 300, mapY: 100 },
  { id: "C", name: "C站", province: "P", city: "C", lat: 31.3, lng: 121.3, mapX: 400, mapY: 100 },
];

function edge(from: string, to: string, distanceKm: number, opts?: Partial<RouteEdge>): RouteEdge {
  return {
    from,
    to,
    distanceKm,
    enabled: opts?.enabled ?? true,
    allowedTransport: opts?.allowedTransport ?? ["HAND_CARRY", "HORSE_RELAY", "EXPRESS_RELAY"],
  };
}

const baseEdges: RouteEdge[] = [edge("A", "B", 10), edge("B", "D", 10), edge("A", "D", 50)];

function data(edges: RouteEdge[] = baseEdges): GraphData {
  return { nodes: nodes as GraphData["nodes"], edges };
}

describe("graph loader + validation", () => {
  it("JSON 可解析 + node id 唯一 + 建立图", () => {
    const g = buildGraph(data());
    expect(g.nodes.size).toBe(4);
    expect(g.adjacency.get("A")?.length).toBe(2); // A-B, A-D
  });

  it("buildGraph 记录 graphVersion（冻结版本语义）", () => {
    const g = buildGraph(data(), "china-v1");
    expect(g.graphVersion).toBe("china-v1");
    // GraphData.graphVersion 同样生效
    const g2 = buildGraph({ ...data(), graphVersion: "china-v2" });
    expect(g2.graphVersion).toBe("china-v2");
  });

  it("edge endpoint 不存在抛错", () => {
    expect(() => buildGraph(data([edge("A", "Z", 10)]))).toThrow(/端点不存在/);
  });

  it("self edge 抛错", () => {
    expect(() => buildGraph(data([edge("A", "A", 10)]))).toThrow(/self-loop|非法/);
  });

  it("distance <= 0 抛错", () => {
    expect(() => buildGraph(data([edge("A", "B", 0)]))).toThrow(/distanceKm|非法/);
  });

  it("allowedTransport 空 / 非法 抛错", () => {
    expect(() => buildGraph(data([edge("A", "B", 10, { allowedTransport: [] })]))).toThrow(
      /allowedTransport/
    );
    expect(() =>
      buildGraph(data([edge("A", "B", 10, { allowedTransport: ["FLY" as never] })]))
    ).toThrow(/allowedTransport/);
  });

  it("duplicate edge 可检测（validateGraph）", () => {
    const dup = data([edge("A", "B", 10), edge("B", "A", 10), edge("A", "D", 50)]);
    const report = validateGraph(dup);
    expect(report.duplicateEdgeCount).toBe(1);
    // buildGraph 容忍重复（双向展开会重复 push，但不抛错）
    expect(() => buildGraph(dup)).not.toThrow();
    expect(buildGraph(dup).adjacency.get("A")?.length).toBeGreaterThanOrEqual(2);
  });

  it("validateGraph 统计报告正确", () => {
    const report = validateGraph(data());
    expect(report.nodeCount).toBe(4);
    expect(report.edgeCount).toBe(3);
    expect(report.connectedComponentCount).toBe(1);
    expect(report.isolatedNodeCount).toBe(1); // C 孤立
    expect(report.invalidEdgeCount).toBe(0);
  });
});

describe("Dijkstra", () => {
  const g = buildGraph(data());

  it("shortest path A->D = A->B->D, distance 20", () => {
    const r = findShortestPath(g, "A", "D", "HORSE_RELAY");
    expect(r.found).toBe(true);
    expect(r.nodes).toEqual(["A", "B", "D"]);
    expect(r.totalDistanceKm).toBe(20);
    expect(r.edges).toHaveLength(2);
  });

  it("disabled B-D → 改走 A-D", () => {
    const edges: RouteEdge[] = [
      edge("A", "B", 10),
      edge("B", "D", 10, { enabled: false }),
      edge("A", "D", 50),
    ];
    const r = findShortestPath(buildGraph(data(edges)), "A", "D", "HORSE_RELAY");
    expect(r.nodes).toEqual(["A", "D"]);
    expect(r.totalDistanceKm).toBe(50);
  });

  it("transport 不允许 B-D → 改走 A-D", () => {
    const edges: RouteEdge[] = [
      edge("A", "B", 10),
      edge("B", "D", 10, { allowedTransport: ["HAND_CARRY"] }),
      edge("A", "D", 50),
    ];
    const r = findShortestPath(buildGraph(data(edges)), "A", "D", "HORSE_RELAY");
    expect(r.nodes).toEqual(["A", "D"]);
  });

  it("disconnected → NoRouteError", () => {
    expect(() => findShortestPath(g, "A", "C", "HORSE_RELAY")).toThrow(NoRouteError);
  });

  it("origin == destination → 空路线 distance 0", () => {
    const r = findShortestPath(g, "A", "A", "HORSE_RELAY");
    expect(r.nodes).toEqual(["A"]);
    expect(r.edges).toEqual([]);
    expect(r.totalDistanceKm).toBe(0);
  });

  it("invalid node → UnknownNodeError", () => {
    expect(() => findShortestPath(g, "A", "Z", "HORSE_RELAY")).toThrow(UnknownNodeError);
  });

  it("edge distance accumulation 正确（A->B->D 累加 20）", () => {
    const r = findShortestPath(g, "A", "D", "HORSE_RELAY");
    const sum = r.edges.reduce((acc, e) => acc + e.distanceKm, 0);
    expect(sum).toBe(r.totalDistanceKm);
    expect(sum).toBe(20);
  });

  it("deterministic tie-break：相同输入多次结果一致", () => {
    // 构造两条等距路径：A-B-D 与 A-E-D 均为 20
    const tieNodes = [
      ...nodes,
      {
        id: "E",
        name: "E站",
        province: "P",
        city: "E",
        lat: 31.15,
        lng: 121.15,
        mapX: 250,
        mapY: 50,
      },
    ] as GraphData["nodes"];
    const tieEdges: RouteEdge[] = [
      edge("A", "B", 10),
      edge("B", "D", 10),
      edge("A", "E", 10),
      edge("E", "D", 10),
    ];
    const g2 = buildGraph({ nodes: tieNodes, edges: tieEdges });
    const r1 = findShortestPath(g2, "A", "D", "HORSE_RELAY");
    for (let i = 0; i < 5; i++) {
      const r = findShortestPath(g2, "A", "D", "HORSE_RELAY");
      expect(r.nodes).toEqual(r1.nodes);
    }
    expect(r1.nodes).toEqual(["A", "B", "D"]); // B < E 字典序优先
  });
});

describe("PIGEON direct route", () => {
  const g = buildGraph(data());

  it("不走 road graph，单直连 leg + Haversine 距离", () => {
    const r = planPigeonRoute(g, "A", "D");
    expect(r.found).toBe(true);
    expect(r.edges).toHaveLength(1);
    expect(r.edges.at(0)?.transportType).toBe("PIGEON");
    expect(r.nodes).toEqual(["A", "D"]);
    // Haversine 与 geo 直接计算一致
    expect(r.totalDistanceKm).toBeCloseTo(haversineKm(31.0, 121.0, 31.2, 121.2), 6);
  });

  it("origin == destination → 空路线", () => {
    const r = planPigeonRoute(g, "A", "A");
    expect(r.edges).toEqual([]);
    expect(r.totalDistanceKm).toBe(0);
  });

  it("unknown node → UnknownNodeError", () => {
    expect(() => planPigeonRoute(g, "A", "Z")).toThrow(UnknownNodeError);
  });
});
