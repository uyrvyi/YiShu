import { describe, expect, it } from "vitest";
import {
  MAP_APPROXIMATE_MAX_RATIO,
  TIMELINE_IMPORTANCE,
  projectLngLatToMapPoint,
  type MapPoint,
  type PublicLetterStatus,
  type TimelineEventType,
} from "@yishu/shared";
import type { TimelineEvent } from "@yishu/db";
import { getStationNode } from "./stationGraph.js";
import { resolveDisplayStationPoint } from "./map-station-point.js";
import { projectRouteMap, type PlannedLegSegment } from "./map-view.js";

/**
 * Map 投影纯函数回归（Phase 8 Gate Repair）。
 *
 * 覆盖 Reviewer 复现的两个真实缺陷（都不依赖数据库，几何取自仓库内真实路网数据）：
 * - **H1**：`remainingPath` / `approximatePosition` 必须按**有序 Leg progression**定位，
 *   禁止 `find(fromNodeId === currentNode)` 式 nodeId 反查，禁止找不到就回退整条路线；
 *   终态必须 `remainingPath = []`；重复经过同一节点（A→B→C→B→D）不得把已走往返段当成未走。
 * - **M1**：位置时间锚点必须是 active segment **最新可见 `DEPARTED_STATION`**（恢复 / 长期停留后
 *   重新出发用新出发时刻），不得沿用旧的到站 / 初始出发时刻。
 */

const GRAPH_VERSION = "china-v1";
const T0 = Date.UTC(2026, 10, 1, 0, 0, 0);
const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** 单元测试使用真实图节点 id（几何直接来自本地路网数据，投影结果可复算）。 */
const A = "beijing";
const B = "tianjin";
const C = "shijiazhuang";
const D = "baoding";
const E = "handan";
const F = "langfang";

/** 地图上该站点的**显示坐标**（冻结图坐标 + 版本化显示修正；与 API 输出同一来源）。 */
function pointOf(nodeId: string, graphVersion: string = GRAPH_VERSION): MapPoint {
  return resolveDisplayStationPoint(nodeId, graphVersion);
}

function leg(
  sequence: number,
  fromNodeId: string,
  toNodeId: string,
  plannedDurationSeconds = 3600
): PlannedLegSegment {
  return { sequence, fromNodeId, toNodeId, plannedDurationSeconds };
}

function event(
  type: TimelineEventType,
  nodeId: string,
  happenedAtMs: number,
  sequence = 0,
  graphVersion: string = GRAPH_VERSION
): TimelineEvent {
  // 事实行携带**物化时**的图坐标（legacy 信件 = 冻结 china-v1 坐标，可能含历史近似值）
  const node = getStationNode(nodeId, graphVersion);
  return {
    id: BigInt(0),
    letterId: BigInt(0),
    sourceKey: `test:${type}:${String(happenedAtMs)}`,
    sequence,
    type,
    title: type,
    description: `${type} @ ${nodeId}`,
    province: node.province,
    city: node.city,
    district: null,
    nodeId,
    mapX: node.mapX,
    mapY: node.mapY,
    uncertaintyRadiusKm: null,
    happenedAt: new Date(happenedAtMs),
    visibleAt: new Date(happenedAtMs),
    importance: TIMELINE_IMPORTANCE[type],
    metadata: null,
    createdAt: new Date(happenedAtMs),
  };
}

function project(options: {
  status: PublicLetterStatus;
  nowMs: number;
  events: readonly TimelineEvent[];
  legs: readonly PlannedLegSegment[];
  origin?: string;
  destination?: string;
  graphVersion?: string;
}) {
  return projectRouteMap({
    graphVersion: options.graphVersion ?? GRAPH_VERSION,
    publicStatus: options.status,
    nowMs: options.nowMs,
    visibleEvents: options.events,
    originNodeId: options.origin ?? A,
    destinationNodeId: options.destination ?? D,
    plannedLegs: options.legs,
  });
}

/** 真实世界可见事实序列：寄出 → 依次到达（时间与 leg 完成点一致）。 */
function factsAlong(chain: readonly string[]): TimelineEvent[] {
  const events: TimelineEvent[] = [event("DISPATCHED", chain[0] ?? A, T0)];
  chain.slice(1).forEach((nodeId, index) => {
    events.push(event("ARRIVED_STATION", nodeId, T0 + (index + 1) * HOUR_MS));
  });
  return events;
}

/** 点到线段的最近距离（0.2 以内视为点落在线段上；坐标已 round1）。 */
function distanceToSegment(point: MapPoint, from: MapPoint, to: MapPoint): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(point.x - from.x, point.y - from.y);
  const t = Math.max(
    0,
    Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSq)
  );
  return Math.hypot(point.x - (from.x + t * dx), point.y - (from.y + t * dy));
}

describe("map-view 投影（Phase 8 Gate H1 / M1 回归）", () => {
  it("H1 · DELIVERED：remainingPath = []、completedPath 完整到终点（不再回退整条路线）", () => {
    const legs = [leg(0, A, B), leg(1, B, C), leg(2, C, D)];
    const events = [
      ...factsAlong([A, B, C, D]),
      event("OUT_FOR_DELIVERY", D, T0 + 3 * HOUR_MS),
      event("DELIVERED", D, T0 + 3 * HOUR_MS + 6 * HOUR_MS),
    ];

    const view = project({
      status: "DELIVERED",
      nowMs: T0 + DAY_MS,
      events,
      legs,
    });

    expect(view.status).toBe("DELIVERED");
    expect(view.remainingPath).toEqual([]);
    expect(view.completedPath).toEqual([pointOf(A), pointOf(B), pointOf(C), pointOf(D)]);
    expect(view.lastKnownPosition).toEqual(pointOf(D));
    expect(view.approximatePosition).toBeNull();
  });

  it("H1 · 重复经过同一节点（A→B→C→B→D）：第二次到达 B 时 remaining 必须是 B→D", () => {
    const legs = [leg(0, A, B), leg(1, B, C), leg(2, C, B), leg(3, B, D)];
    const b2Ms = T0 + 3 * HOUR_MS;
    const events = factsAlong([A, B, C, B]);
    const nowMs = b2Ms + HOUR_MS / 2;

    const view = project({ status: "IN_TRANSIT", nowMs, events, legs });

    expect(view.completedPath).toEqual([pointOf(A), pointOf(B), pointOf(C), pointOf(B)]);
    expect(view.remainingPath).toEqual([pointOf(B), pointOf(D)]);
    // 旧 bug：第二次到达 B 时按 nodeId 反查命中第一次「B 出发」的 leg → B→C→B→D
    expect(view.remainingPath).not.toContainEqual(pointOf(C));

    // 位置必须沿当前 active leg（B→D）插值（B→D 中点），而不是沿旧段落 B→C
    const approx = view.approximatePosition;
    if (approx === null) throw new Error("approximatePosition null");
    expect(distanceToSegment(approx, pointOf(B), pointOf(D))).toBeLessThan(0.2);
    const expectedMid = {
      x: (pointOf(B).x + pointOf(D).x) / 2,
      y: (pointOf(B).y + pointOf(D).y) / 2,
    };
    expect(Math.abs(approx.x - expectedMid.x)).toBeLessThan(0.11);
    expect(Math.abs(approx.y - expectedMid.y)).toBeLessThan(0.11);
  });

  it("H1 · reroute：completed 永不重写，remaining 采用重建路线（B→X→Y→D）", () => {
    const beforeReroute = [leg(0, A, B), leg(1, B, C), leg(2, C, D)];
    const afterReroute = [leg(0, A, B), leg(1, B, E), leg(2, E, F), leg(3, F, D)];
    const events = factsAlong([A, B]);
    const nowMs = T0 + 1.5 * HOUR_MS;

    const before = project({ status: "IN_TRANSIT", nowMs, events, legs: beforeReroute });
    expect(before.completedPath).toEqual([pointOf(A), pointOf(B)]);
    expect(before.remainingPath).toEqual([pointOf(B), pointOf(C), pointOf(D)]);

    const after = project({ status: "IN_TRANSIT", nowMs, events, legs: afterReroute });
    expect(after.completedPath).toEqual(before.completedPath);
    expect(after.remainingPath).toEqual([pointOf(B), pointOf(E), pointOf(F), pointOf(D)]);
    const approx = after.approximatePosition;
    if (approx === null) throw new Error("approximatePosition null");
    expect(distanceToSegment(approx, pointOf(B), pointOf(E))).toBeLessThan(0.2);
  });

  it("H1 · 多次（连续）reroute：completed 只增不减，remaining 从当前确认点继续", () => {
    const firstPlan = [leg(0, A, B), leg(1, B, C), leg(2, C, D)];
    const secondPlan = [leg(0, A, B), leg(1, B, C), leg(2, C, E), leg(3, E, D)];
    const thirdPlan = [leg(0, A, B), leg(1, B, C), leg(2, C, E), leg(3, E, F), leg(4, F, D)];

    const stage1 = project({
      status: "IN_TRANSIT",
      nowMs: T0 + 1.5 * HOUR_MS,
      events: factsAlong([A, B]),
      legs: firstPlan,
    });
    expect(stage1.completedPath).toEqual([pointOf(A), pointOf(B)]);
    expect(stage1.remainingPath).toEqual([pointOf(B), pointOf(C), pointOf(D)]);

    const stage2 = project({
      status: "IN_TRANSIT",
      nowMs: T0 + 2.5 * HOUR_MS,
      events: factsAlong([A, B, C]),
      legs: secondPlan,
    });
    expect(stage2.completedPath).toEqual([pointOf(A), pointOf(B), pointOf(C)]);
    expect(stage2.remainingPath).toEqual([pointOf(C), pointOf(E), pointOf(D)]);
    // 已确认前缀永不因改道被重写 / 丢失
    expect(stage2.completedPath.slice(0, stage1.completedPath.length)).toEqual(
      stage1.completedPath
    );

    const stage3 = project({
      status: "IN_TRANSIT",
      nowMs: T0 + 3.5 * HOUR_MS,
      events: factsAlong([A, B, C, E]),
      legs: thirdPlan,
    });
    expect(stage3.completedPath).toEqual([pointOf(A), pointOf(B), pointOf(C), pointOf(E)]);
    expect(stage3.remainingPath).toEqual([pointOf(E), pointOf(F), pointOf(D)]);
    expect(stage3.completedPath.slice(0, stage2.completedPath.length)).toEqual(
      stage2.completedPath
    );
  });

  it("M1 · 恢复后重新出发：位置从最新可见出发事实起算（1 分钟 ≈ 1.7%，不是 ≈90%）", () => {
    const legs = [leg(0, A, B, 3600)];
    const missingAt = T0 + HOUR_MS;
    const recoveredAt = T0 + DAY_MS; // 停留 24h 后恢复
    const departedAt = recoveredAt; // 同刻重新出发（可见事实）
    const events = [
      event("DISPATCHED", A, T0),
      event("DEPARTED_STATION", A, T0),
      event("COURIER_MISSING", A, missingAt),
      event("LETTER_RECOVERED", A, recoveredAt),
      event("DEPARTED_STATION", A, departedAt, 1),
    ];

    const view = project({
      status: "RECOVERED",
      nowMs: departedAt + 60 * 1000,
      events,
      legs,
    });

    const from = pointOf(A);
    const to = pointOf(B);
    const approx = view.approximatePosition;
    if (approx === null) throw new Error("approximatePosition null");
    // 新锚点：出发 1 分钟 / 计划 60 分钟 ≈ 1.7%（round1 误差 ≤ 0.05）
    expect(Math.abs(approx.x - (from.x + (to.x - from.x) * (60 / 3600)))).toBeLessThan(0.11);
    expect(Math.abs(approx.y - (from.y + (to.y - from.y) * (60 / 3600)))).toBeLessThan(0.11);
    // 旧行为（锚点 = T0 + 初次出发）会接近走完；这里必须仍在起点附近
    expect(Math.hypot(approx.x - from.x, approx.y - from.y)).toBeLessThan(
      Math.hypot(to.x - from.x, to.y - from.y) * 0.1
    );

    // 30 分钟后 ≈ 中点
    const mid = project({
      status: "RECOVERED",
      nowMs: departedAt + 30 * 60 * 1000,
      events,
      legs,
    });
    const midPosition = mid.approximatePosition;
    if (midPosition === null) throw new Error("mid position null");
    expect(distanceToSegment(midPosition, from, to)).toBeLessThan(0.2);
    expect(Math.abs(midPosition.x - (from.x + to.x) / 2)).toBeLessThan(
      Math.abs(to.x - from.x) * 0.05 + 1
    );

    // 60 分钟后：按 MAP_APPROXIMATE_MAX_RATIO clamp（不越过下一站）
    const end = project({
      status: "RECOVERED",
      nowMs: departedAt + 60 * 60 * 1000,
      events,
      legs,
    });
    const endPosition = end.approximatePosition;
    if (endPosition === null) throw new Error("end position null");
    expect(
      Math.abs(endPosition.x - (from.x + (to.x - from.x) * MAP_APPROXIMATE_MAX_RATIO))
    ).toBeLessThan(0.11);
    expect(
      Math.abs(endPosition.y - (from.y + (to.y - from.y) * MAP_APPROXIMATE_MAX_RATIO))
    ).toBeLessThan(0.11);
    expect(endPosition).not.toEqual(to);
  });

  it("M1 · 无出发事实时退回到达时刻（安全不可变锚点）", () => {
    const legs = [leg(0, A, B, 3600), leg(1, B, D, 3600)];
    const arrivedAt = T0 + HOUR_MS;
    const events = [...factsAlong([A, B])];

    const view = project({
      status: "AT_STATION",
      nowMs: arrivedAt + 30 * 60 * 1000,
      events,
      legs,
    });
    const from = pointOf(B);
    const to = pointOf(D);
    const approx = view.approximatePosition;
    if (approx === null) throw new Error("approximatePosition null");
    expect(Math.abs(approx.x - (from.x + (to.x - from.x) * 0.5))).toBeLessThan(0.11);
    expect(Math.abs(approx.y - (from.y + (to.y - from.y) * 0.5))).toBeLessThan(0.11);
  });

  it("失联中：approximatePosition = null，remainingPath 仍从最后确认点起算", () => {
    const legs = [leg(0, A, B), leg(1, B, C), leg(2, C, D)];
    const events = [...factsAlong([A, B]), event("COURIER_MISSING", B, T0 + 2 * HOUR_MS)];

    const view = project({ status: "COURIER_MISSING", nowMs: T0 + 3 * HOUR_MS, events, legs });

    expect(view.approximatePosition).toBeNull();
    expect(view.lastKnownPosition).toEqual(pointOf(B));
    expect(view.remainingPath).toEqual([pointOf(B), pointOf(C), pointOf(D)]);
  });

  it("零 Leg（同站 PIGEON）：remainingPath = []，位置停在最后确认点（不产生伪路线）", () => {
    const view = project({
      status: "IN_TRANSIT",
      nowMs: T0 + HOUR_MS,
      events: [event("DISPATCHED", A, T0)],
      legs: [],
      origin: A,
      destination: A,
    });

    expect(view.completedPath).toEqual([pointOf(A)]);
    expect(view.remainingPath).toEqual([]);
    expect(view.approximatePosition).toEqual(pointOf(A));
    expect(view.lastKnownPosition).toEqual(pointOf(A));
  });

  it("链起点对不上时保守处理：不回退整条路线、不猜测进度（只停在最后确认点）", () => {
    const legs = [leg(0, B, C), leg(1, C, D)];
    const view = project({
      status: "IN_TRANSIT",
      nowMs: T0 + HOUR_MS,
      events: [event("DISPATCHED", A, T0)],
      legs,
      origin: A,
    });

    expect(view.completedPath).toEqual([pointOf(A)]);
    expect(view.remainingPath).toEqual([pointOf(B), pointOf(C), pointOf(D)]);
    expect(view.approximatePosition).toEqual(pointOf(A));
  });

  it("终态（PERMANENTLY_LOST / DESTROYED）：remainingPath = []，只保留最后确报", () => {
    const legs = [leg(0, A, B), leg(1, B, C), leg(2, C, D)];
    const events = factsAlong([A, B]);

    for (const status of ["PERMANENTLY_LOST", "DESTROYED"] as const) {
      const view = project({ status, nowMs: T0 + 3 * HOUR_MS, events, legs });
      expect(view.remainingPath, status).toEqual([]);
      expect(view.completedPath, status).toEqual([pointOf(A), pointOf(B)]);
      expect(view.lastKnownPosition, status).toEqual(pointOf(B));
      expect(view.approximatePosition, status).toBeNull();
    }
  });

  it("纯函数：乱序 leg 输入内部按 sequence 排序，且不就地修改入参", () => {
    const legs = [leg(2, C, D), leg(0, A, B), leg(1, B, C)];
    const events = factsAlong([A, B, C, D]);

    const view = project({ status: "IN_TRANSIT", nowMs: T0 + 4 * HOUR_MS, events, legs });
    expect(view.completedPath).toEqual([pointOf(A), pointOf(B), pointOf(C), pointOf(D)]);
    // 全部 leg 已完成且非终态 → 无剩余 leg（不是单点数组）
    expect(view.remainingPath).toEqual([]);
    // 输入顺序未被就地改写
    expect(legs.map((item) => item.sequence)).toEqual([2, 0, 1]);

    const again = project({ status: "IN_TRANSIT", nowMs: T0 + 4 * HOUR_MS, events, legs });
    expect(again).toEqual(view);
  });
});

/**
 * Phase 8 Gate「Yangquan 修复」：显示坐标修正层（display-only）。
 *
 * `china-v1` 是字节冻结基线，其中 `yangquan` 为历史近似坐标（落河南一侧，偏差 ≈295 km）。
 * legacy 信件物化的事实行携带该冻结坐标，但**用户可见地图**必须显示真实位置，且与
 * `china-v2`（数据侧已修正）在同一可见事实下完全一致；冻结资产与库内数据一律不改。
 */
describe("显示坐标修正（legacy china-v1 信件）", () => {
  const LEGS = [leg(1, "yangquan", "taiyuan", 3600)];
  /** active leg 中途（ratio = 0.5）。 */
  const NOW = T0 + 1800 * 1000;

  function viewOf(graphVersion: string) {
    return project({
      status: "IN_TRANSIT",
      nowMs: NOW,
      events: [event("DISPATCHED", "yangquan", T0, 0, graphVersion)],
      legs: LEGS,
      origin: "yangquan",
      destination: "taiyuan",
      graphVersion,
    });
  }

  it("修正只作用于显示层：china-v1 图数据仍是历史近似坐标，显示坐标 = china-v2 图坐标", () => {
    const raw = getStationNode("yangquan", "china-v1");
    expect({ x: raw.mapX, y: raw.mapY }).not.toEqual(pointOf("yangquan", "china-v1"));
    expect(pointOf("yangquan", "china-v1")).toEqual(projectLngLatToMapPoint(113.563333, 37.8575));
    expect(pointOf("yangquan", "china-v1")).toEqual(pointOf("yangquan", "china-v2"));
  });

  it("legacy 信件的 origin / 事实节点 / 路径统一使用修正后的显示坐标", () => {
    const view = viewOf("china-v1");
    const target = pointOf("yangquan", "china-v1");

    expect(view.origin).toEqual({
      name: "阳泉",
      province: "山西省",
      city: "阳泉市",
      x: target.x,
      y: target.y,
    });
    expect(view.completedPath).toEqual([target]);
    expect(view.remainingPath).toEqual([target, pointOf("taiyuan", "china-v1")]);

    // 事实节点不沿用事件行里的冻结坐标，必须与 origin / 路径同源
    const fact = view.facts[0];
    expect(fact?.title).toBe("DISPATCHED");
    expect({ x: fact?.x ?? -1, y: fact?.y ?? -1 }).toEqual(target);

    // 当前位置仍落在（显示后的）active segment 上
    const approximate = view.approximatePosition;
    expect(approximate).not.toBeNull();
    expect(
      distanceToSegment(approximate ?? { x: -1, y: -1 }, target, pointOf("taiyuan", "china-v1"))
    ).toBeLessThan(0.2);
  });

  it("同一可见事实下 china-v1 与 china-v2 输出同一张图（legacy 与新信件显示一致）", () => {
    expect(viewOf("china-v1")).toEqual(viewOf("china-v2"));
  });
});
