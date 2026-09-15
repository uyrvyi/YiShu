/**
 * Phase 8 — Local Map + Journey Visualization 用户可见安全投影（开发规范 §14–§19 / §74）。
 *
 * 依据（冻结文档 + 项目负责人 2026-09-13 地图可见性冻结，不自行发明规则）：
 * - §14 完全本地地图；禁止任何在线地图 / 瓦片 / geocoder；无精确 GPS。
 * - §17 固定 viewBox；§18 已走实线 / 未走虚线 / 当前大概位置 / 无 ETA。
 * - §19 `LETTER_DROPPED` 完全 HIDDEN（全局）：不显示掉落范围（V1 无 `dropArea`）、
 *   不返回精确或近似掉落坐标、隐藏掉落期间不产生新的用户可确认事实、用户可见状态保持 `IN_TRANSIT`。
 * - §74 `GET /letters/:trackingNo/map` 响应字段。
 *
 * **核心不变量**
 * 1. **单一事实来源**：`facts` 与 `completedPath` 只来自「已物化且 `visibleAt <= now` 的用户可见
 *    Timeline 事实」。地图不读 WorldEvent.payload、不读 Journey.anomalyType / Journey.status、
 *    不读 internal `Letter.status`（调用方已用 `toPublicLetterStatus` 投影）。
 * 2. **隐藏等价（hidden equivalence）**：internal `LETTER_DROPPED` 与普通在途在**同一可见事实集合**
 *    下必须产出**完全相同的 DTO**——投影函数没有任何参数能区分二者（无内部状态入参）。
 * 3. **refresh-frequency independence**：纯函数 + 只依赖 (可见事实, now, 冻结规划)，同一输入必得同一输出。
 * 4. **不泄漏**：绝不输出 lat/lng（无 GPS）、ETA / 剩余时间 / 预测事件、`dropArea` / 掉落范围 /
 *    掉落原因、任何 internal id（letterId / journeyId / nodeId / worldEventId / sourceKey）。
 * 5. **路线进度只按有序 Leg progression**（Phase 8 Gate H1 修复）：`completedPath` 由「已确认完成
 *    的 ordered legs」拼出、`remainingPath` 由「尚未完成的 ordered legs」拼出，active leg 恰好位于
 *    两者边界。**禁止**用 `nodeId` 反查定位（`find(fromNodeId === currentNode)` / `indexOf(node)` /
 *    找不到就回退整条路线）：同一 Journey 可以重复经过同一节点（A→B→C→B→D），节点名不是 path cursor。
 *    终态（DELIVERED / PERMANENTLY_LOST / DESTROYED）或已无剩余 leg 时 `remainingPath = []`。
 * 6. **位置时间锚点固定为最新可见出发事实**（Phase 8 Gate M1 修复）：active segment 的锚点 =
 *    该段起点站**最新**的用户可见 `DEPARTED_STATION`（恢复 / 长期停留后重新出发必须使用新出发时刻）；
 *    没有出发事实时才退回已确认到达时刻。绝不读 hidden cause / anomaly 来修正锚点。
 * 7. **显示坐标与图数据分离**（Phase 8 Gate「Yangquan 修复」）：所有对用户暴露的 station 坐标
 *    统一经 `map-station-point.ts` 解析（冻结图坐标 + 版本化显示修正）。修正只影响**渲染位置**，
 *    不写库、不改冻结图数据 / 路由 / 距离 / World Truth，也不改变任何可见性判定。
 */

import {
  MAP_APPROXIMATE_MAX_RATIO,
  MAP_FACT_LIMIT,
  TIMELINE_IMPORTANCE,
  type MapFactView,
  type MapPoint,
  type MapStation,
  type PublicLetterStatus,
  type RouteMapView,
  type TimelineEventType,
} from "@yishu/shared";
import type { TimelineEvent } from "@yishu/db";
import { resolveMapStationPoint } from "./map-station-point.js";

/** 计划路线片段（只暴露几何与时长；**不使用 status / anomaly / 事件字段**）。 */
export interface PlannedLegSegment {
  sequence: number;
  fromNodeId: string;
  toNodeId: string;
  /** 计划时长（秒）；仅用于把「已确认出发时刻 → now」映射为区间内位置，不输出为 ETA。 */
  plannedDurationSeconds: number;
}

/** 投影输入（全部只读快照；本模块不做任何写操作）。 */
export interface MapProjectionInput {
  graphVersion: string;
  /** 用户可见状态（调用方必须已 `toPublicLetterStatus`；本模块不接受内部 LetterStatus）。 */
  publicStatus: PublicLetterStatus;
  /** SimulationClock 当前模拟时刻（禁止 Date.now() 直接决定位置）。 */
  nowMs: number;
  /** 已物化且可见的用户事实，按 (happenedAt asc, sequence asc, sourceKey asc) 升序。 */
  visibleEvents: readonly TimelineEvent[];
  /** 起点 / 终点节点（无 Journey 时均为 null）。 */
  originNodeId: string | null;
  destinationNodeId: string | null;
  /** 冻结的路线规划（Journey.legs 的几何视图）。 */
  plannedLegs: readonly PlannedLegSegment[];
}

/**
 * 终态用户可见状态（SPEC §18：只表达终态确认结果，保持最后可确认位置）。
 *
 * - `PERMANENTLY_LOST` / `DESTROYED`：位置永久停止更新（只保留最后确报）。
 * - `DELIVERED`：位置已确定（= 目的站），不存在「大概位置」，避免 UI 继续显示
 *   「位置更新中」（`ApproximatePositionLayer` 语义为近似移动位置）。
 */
const TERMINAL_PUBLIC_STATUSES: ReadonlySet<PublicLetterStatus> = new Set([
  "DELIVERED",
  "PERMANENTLY_LOST",
  "DESTROYED",
]);

/**
 * 「位置类」事实：决定地图上已确认位置与其确认时刻。
 * 只包含用户可见事实类型（`LETTER_DROPPED` 不是 Timeline 类型，天然不存在）。
 */
const STOP_FACT_TYPES: ReadonlySet<TimelineEventType> = new Set([
  "ARRIVED_STATION",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
]);

/** 用于判定「失联中」的位置类事实（canonical，不暴露 cause）。 */
const POSITION_FACT_TYPES: ReadonlySet<TimelineEventType> = new Set([
  "DISPATCHED",
  "DEPARTED_STATION",
  "ARRIVED_STATION",
  "OUT_FOR_DELIVERY",
  "COURIER_MISSING",
  "LETTER_RECOVERED",
  "DELIVERED",
  "PERMANENTLY_LOST",
  "DESTROYED",
]);

interface ConfirmedStop {
  nodeId: string;
  /** 该节点的用户可见确认时刻（ms）；null = 无时间锚点（不推测位置）。 */
  confirmedAtMs: number | null;
}

/**
 * 站点视图：图数据坐标 + 版本化**显示修正**（`map-station-point.ts`）。
 *
 * 显示修正只影响地图渲染位置，不触及冻结图数据 / 路由 / 距离 / World Truth；legacy
 * `china-v1` 信件因此能在不改库、不改资产的前提下显示正确位置。
 * 未知节点不使整个投影失败（与 Timeline 一致：位置数据问题不阻断用户事实）。
 */
function stationOf(nodeId: string | null, graphVersion: string): MapStation | null {
  if (nodeId === null) return null;
  return resolveMapStationPoint({ graphVersion, nodeId });
}

/**
 * 事实节点坐标：优先按 `nodeId` 解析显示坐标（与 origin / destination / 路径同一来源），
 * 事件未带 `nodeId` 时退回事实自身冻结坐标；两者皆无 → 该事实不落图。
 */
function factPointOf(event: TimelineEvent, graphVersion: string): MapPoint | null {
  if (event.nodeId !== null && event.nodeId !== undefined) {
    const station = resolveMapStationPoint({ graphVersion, nodeId: event.nodeId });
    if (station !== null) return { x: station.x, y: station.y };
  }
  const { mapX, mapY } = event;
  return mapX === null || mapY === null ? null : { x: mapX, y: mapY };
}

function toPoint(station: MapStation | null): MapPoint | null {
  return station === null ? null : { x: station.x, y: station.y };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/**
 * 已确认站点序列（严格来自用户可见事实）。
 * - 起点：`Letter.sentAt/createdAt` 产生的 DISPATCHED 事实（用户已确认寄出）。
 * - 途中：ARRIVED_STATION / OUT_FOR_DELIVERY / DELIVERED（后者表示已到目的站区域）。
 * - 同一节点连续重复时只保留一条（时间取最新，用于位置锚点）。
 */
function confirmedStops(
  events: readonly TimelineEvent[],
  originNodeId: string | null
): ConfirmedStop[] {
  const stops: ConfirmedStop[] = [];
  if (originNodeId !== null) {
    const dispatched = events.find((e) => e.type === "DISPATCHED");
    stops.push({
      nodeId: originNodeId,
      confirmedAtMs: dispatched ? dispatched.happenedAt.getTime() : null,
    });
  }
  for (const event of events) {
    if (!STOP_FACT_TYPES.has(event.type)) continue;
    const nodeId = event.nodeId;
    if (nodeId === null || nodeId === undefined) continue;
    const at = event.happenedAt.getTime();
    const last = stops[stops.length - 1];
    if (last !== undefined && last.nodeId === nodeId) {
      last.confirmedAtMs = at;
      continue;
    }
    stops.push({ nodeId, confirmedAtMs: at });
  }
  return stops;
}

/**
 * 已确认完成的 ordered Leg 数（Phase 8 Gate H1：路线进度只能来自有序 progression）。
 *
 * 把「有序 Leg 链」与「已确认站点序列」按顺序做前缀匹配：第 k 条 leg 完成当且仅当
 * `legs[k].toNodeId === stops[k + 1].nodeId`。只依赖顺序，不做 nodeId 反查、不读
 * `leg.status` / anomaly / WorldEvent，因此 `A→B→C→B→D` 这类重复经过同一节点的路线也能精确定位。
 *
 * 链起点对不上（行程起点 ≠ 已确认的第一个站点）时保守返回 0（不声称任何 leg 已完成）。
 */
function countCompletedLegs(
  orderedLegs: readonly PlannedLegSegment[],
  stops: readonly ConfirmedStop[]
): number {
  const firstLeg = orderedLegs[0];
  const firstStop = stops[0];
  if (
    firstLeg === undefined ||
    firstStop === undefined ||
    firstLeg.fromNodeId !== firstStop.nodeId
  ) {
    return 0;
  }
  let completed = 0;
  while (completed < orderedLegs.length) {
    const leg = orderedLegs[completed];
    const nextStop = stops[completed + 1];
    if (leg === undefined || nextStop === undefined) break;
    if (leg.toNodeId !== nextStop.nodeId) break;
    completed += 1;
  }
  return completed;
}

/**
 * active segment 的时间锚点（Phase 8 Gate M1）：
 * 该段起点站**最新**的用户可见 `DEPARTED_STATION` 出发事实（不早于 `notBeforeMs`）。
 *
 * 恢复 / 长时间停留后重新出发会产生新的出发事实，位置必须从**新**出发时刻起算，
 * 否则「停留 24h 后重新出发 1 分钟」会被算成接近走完（旧 bug）。
 * 没有出发事实时返回 `null`，调用方退回已确认到达时刻（安全不可变锚点）。
 * 只读用户可见事实——绝不读 hidden cause / WorldEvent payload / Journey anomaly。
 */
function departureAnchorMs(
  events: readonly TimelineEvent[],
  fromNodeId: string,
  notBeforeMs: number
): number | null {
  let latest: number | null = null;
  for (const event of events) {
    if (event.type !== "DEPARTED_STATION" || event.nodeId !== fromNodeId) continue;
    const at = event.happenedAt.getTime();
    if (at < notBeforeMs) continue;
    if (latest === null || at > latest) latest = at;
  }
  return latest;
}

/** 失联「结束」事实（同刻即生效）：恢复 / 已到最后一公里 / 终态确认。 */
const MISSING_RESOLVED_TYPES: ReadonlySet<TimelineEventType> = new Set([
  "LETTER_RECOVERED",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "PERMANENTLY_LOST",
  "DESTROYED",
]);

/**
 * 失联中：存在 canonical `COURIER_MISSING` 事实，且其后未被恢复 / 交付 / 终态事实（同刻生效）
 * 或更晚的出发事实消除（§18：失联后不再生成新的推测位置）。
 *
 * ⚠️ 到达该站即失联时，`COURIER_MISSING` 与 `ARRIVED_STATION` **同刻**存在；同刻到达不得
 * 消除失联状态（否则会从该站继续推断位置，违反 §18）。
 */
function isMissingActive(events: readonly TimelineEvent[]): boolean {
  let missingAtMs: number | null = null;
  for (const event of events) {
    const at = event.happenedAt.getTime();
    if (event.type === "COURIER_MISSING") {
      missingAtMs = at;
      continue;
    }
    if (missingAtMs === null || !POSITION_FACT_TYPES.has(event.type)) continue;
    if (MISSING_RESOLVED_TYPES.has(event.type) && at >= missingAtMs) {
      missingAtMs = null;
      continue;
    }
    if (event.type === "DEPARTED_STATION" && at > missingAtMs) {
      missingAtMs = null;
    }
  }
  return missingAtMs !== null;
}

/** 连续重复坐标去重（保持首尾顺序）。 */
function dedupeConsecutive(points: readonly MapPoint[]): MapPoint[] {
  const out: MapPoint[] = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (last !== undefined && last.x === point.x && last.y === point.y) continue;
    out.push(point);
  }
  return out;
}

/**
 * 生成用户可见地图视图（纯函数、deterministic）。
 *
 * @see 文件头「核心不变量」——本函数**没有**可区分隐藏掉落与正常在途的入参或分支。
 */
export function projectRouteMap(input: MapProjectionInput): RouteMapView {
  const { graphVersion, nowMs, visibleEvents, plannedLegs } = input;
  const origin = stationOf(input.originNodeId, graphVersion);
  const destination = stationOf(input.destinationNodeId, graphVersion);

  // ---- 1) 已确认路线（实线）：只由用户可见事实确认的节点组成 ----
  const stops = confirmedStops(visibleEvents, input.originNodeId);
  const stopPoints: MapPoint[] = [];
  for (const stop of stops) {
    const point = toPoint(stationOf(stop.nodeId, graphVersion));
    if (point !== null) stopPoints.push(point);
  }
  const completedPath = dedupeConsecutive(stopPoints);
  const lastStop = stops[stops.length - 1] ?? null;
  const lastKnownPosition = completedPath[completedPath.length - 1] ?? null;

  // ---- 2) 路线进度：有序 Leg 链 × 已确认站点序列（前缀匹配；禁止 nodeId 反查） ----
  const orderedLegs = [...plannedLegs].sort((a, b) => a.sequence - b.sequence);
  const completedLegCount = countCompletedLegs(orderedLegs, stops);
  const remainingLegs = orderedLegs.slice(completedLegCount);
  const activeLeg = remainingLegs[0] ?? null;
  const terminal = TERMINAL_PUBLIC_STATUSES.has(input.publicStatus);

  // ---- 3) 剩余路线（虚线）：尚未完成的 ordered legs（终态 / 无剩余 leg → 空） ----
  const remainingPoints: MapPoint[] = [];
  if (!terminal && activeLeg !== null) {
    const head = toPoint(stationOf(activeLeg.fromNodeId, graphVersion));
    if (head !== null) remainingPoints.push(head);
    for (const leg of remainingLegs) {
      const to = toPoint(stationOf(leg.toNodeId, graphVersion));
      if (to !== null) remainingPoints.push(to);
    }
  }
  const remainingPath = dedupeConsecutive(remainingPoints);

  // ---- 4) 当前位置：只由 (safe facts, 有序 leg 几何, now) 决定 ----
  const missingActive = isMissingActive(visibleEvents);
  let approximatePosition: MapPoint | null = null;
  if (!terminal && !missingActive && lastStop !== null) {
    const from = activeLeg === null ? null : toPoint(stationOf(activeLeg.fromNodeId, graphVersion));
    const to = activeLeg === null ? null : toPoint(stationOf(activeLeg.toNodeId, graphVersion));
    // active leg 必须与「已确认到的站点」接得上（进度一致）；否则停在最后确认点（不推测）
    if (
      activeLeg === null ||
      lastStop.confirmedAtMs === null ||
      lastStop.nodeId !== activeLeg.fromNodeId ||
      from === null ||
      to === null
    ) {
      approximatePosition = lastKnownPosition;
    } else {
      // 时间锚点 = 该段起点站最新可见出发事实（恢复后重新出发 → 新锚点）；无出发事实退回到达时刻
      const anchorMs =
        departureAnchorMs(visibleEvents, activeLeg.fromNodeId, lastStop.confirmedAtMs) ??
        lastStop.confirmedAtMs;
      const durationMs = activeLeg.plannedDurationSeconds * 1000;
      const ratio =
        durationMs > 0 ? clamp((nowMs - anchorMs) / durationMs, 0, MAP_APPROXIMATE_MAX_RATIO) : 0;
      approximatePosition = {
        x: round1(from.x + (to.x - from.x) * ratio),
        y: round1(from.y + (to.y - from.y) * ratio),
      };
    }
  }

  // ---- 5) 事实节点：最新 MAP_FACT_LIMIT 个高优先事实（优先级复用 §21 TIMELINE_IMPORTANCE） ----
  // 坐标经 factPointOf（nodeId → 显示坐标），与 origin / destination / 路径同源，保证同图一致。
  const candidates = visibleEvents
    .map((event) => ({ event, point: factPointOf(event, graphVersion) }))
    .filter((c): c is { event: TimelineEvent; point: MapPoint } => c.point !== null)
    .map(({ event, point }) => ({
      event,
      point,
      priority: TIMELINE_IMPORTANCE[event.type],
    }));
  candidates.sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    const at = a.event.happenedAt.getTime();
    const bt = b.event.happenedAt.getTime();
    if (at !== bt) return bt - at;
    return factTieKey(a.event) < factTieKey(b.event) ? -1 : 1;
  });
  const selected = candidates.slice(0, MAP_FACT_LIMIT);
  selected.sort((a, b) => {
    const at = a.event.happenedAt.getTime();
    const bt = b.event.happenedAt.getTime();
    if (at !== bt) return at - bt;
    return factTieKey(a.event) < factTieKey(b.event) ? -1 : 1;
  });
  const facts: MapFactView[] = selected.map(({ event, point }) => ({
    type: event.type,
    title: event.title,
    description: event.description,
    location: { province: event.province, city: event.city },
    happenedAt: event.happenedAt.toISOString(),
    x: point.x,
    y: point.y,
  }));

  return {
    status: input.publicStatus,
    origin,
    destination,
    completedPath,
    remainingPath,
    approximatePosition,
    lastKnownPosition,
    facts,
  };
}

/** 事实排序的确定性 tie-break（不含内部 id；同一事实集合内稳定）。 */
function factTieKey(event: TimelineEvent): string {
  return [
    event.type,
    String(event.happenedAt.getTime()),
    event.province,
    event.city,
    event.title,
    event.description,
  ].join("\u0000");
}
