/**
 * Phase 7 — Timeline + 用户可见运输事实。
 *
 * 依据（冻结文档 + 项目负责人 2026-09-08 冻结表，不自行发明规则）：
 * - 开发规范 §39 / §40：WorldEvent（服务器世界真相）≠ TimelineEvent（用户可确认事实）。
 * - 开发规范 §57：TimelineEvent 字段；§75：只返回 `visibleAt <= now`。
 * - 开发规范 §66：幂等 = Transaction + Unique Constraint + Idempotency Check。
 * - 阶段规划 Phase 7：visibility = immediate / delayed / hidden；Sender / Recipient 完全一致。
 *
 * **核心不变量：refresh-frequency independence**
 * 同一 World Truth + 同一最终 simulation now 下，无论 GET 1 次 / 10 次 / 100 次，
 * 最终 TimelineEvent DB 与 API DTO 必须完全一致。
 * 因此永久事实**只能**来自不可变历史来源：
 *   - Letter.sentAt / createdAt（冻结）
 *   - TransportLeg.startedAtSim / completedAtSim（一旦设置不回退）
 *   - Journey.lastMileReadyAtSim、Letter.deliveredAt
 *   - immutable WorldEvent（occurredAtSim / nodeId）
 *   - 明确 terminal timestamp
 * **禁止**从会变化/消失的当前状态投影：Journey.anomalyType、Letter 瞬时 status、当前 active Leg、
 * 会在 progression 后改变的 fallback timestamp。
 *
 * 硬约束：
 * - 绝不复制 WorldEvent.payload（payload 含 branch / recoveryWindow / setAside 等后台信息）。
 * - 绝不反向修改 World Truth（不改 WorldEvent / Journey / Leg / Letter）。
 * - HIDDEN 事件（ROBBERY / REROUTED / LOST_PATH / LETTER_DROPPED / SERIOUS_ACCIDENT）绝不直接产生
 *   用户可见事实；Timeline 只认 World Truth 层产生的 **canonical WorldEvent**（例如每次 logical
 *   missing transition 只有一个 canonical COURIER_MISSING，LOST_PATH 作为 cause 不单独成事件）。
 */

import { Prisma } from "@yishu/db";
import type { PrismaClient, Journey, TimelineEvent, TransportLeg, WorldEvent } from "@yishu/db";
import {
  TIMELINE_IMPORTANCE,
  WORLD_EVENT_VISIBILITY,
  type LetterStatus,
  type TimelineEventType,
  type TransportType,
  type WorldEventTypeKey,
} from "@yishu/shared";
import { getStationNode } from "./stationGraph.js";

/** 运输方式用户可见名称（对应开发规范 §13）。 */
const TRANSPORT_LABELS: Record<TransportType, string> = {
  HAND_CARRY: "托人捎信",
  HORSE_RELAY: "驿马",
  EXPRESS_RELAY: "加急驿递",
  PIGEON: "飞鸽传书",
};

/** 候选用户可见事实（projection 输出，尚未持久化）。 */
export interface TimelineFactDraft {
  /** 稳定来源标识（幂等键）。 */
  sourceKey: string;
  /** 确定性排序序号：完整 canonical fact set 排序后的 index（不按本轮 missing 数组编号）。 */
  sequence: number;
  type: TimelineEventType;
  title: string;
  description: string;
  nodeId: string | null;
  province: string;
  city: string;
  /** null = 该事实无法确认到 district（不猜测区县；禁止空串伪装）。 */
  district: string | null;
  mapX: number | null;
  mapY: number | null;
  happenedAtMs: number;
  visibleAtMs: number;
  importance: number;
  /** 严格用户可见安全数据（绝不保存 WorldEvent payload 原文）。 */
  metadata: Record<string, unknown> | null;
}

/** 投影输入（全部为只读快照；本模块不做任何业务写操作）。 */
export interface TimelineProjectionInput {
  graphVersion: string;
  letterStatus: LetterStatus;
  letterDeliveredAt: Date | null;
  /** 冻结寄出时刻（永不变）。 */
  letterSentAt: Date | null;
  /** 冻结创建时刻（sentAt 缺失时唯一回退，同样永不变）。 */
  letterCreatedAt: Date | null;
  /** Letter 冻结区域快照（真实行政区；用于可确认到区的事件，如寄出/送达）。 */
  letterOriginProvince: string;
  letterOriginCity: string;
  letterOriginDistrict: string;
  letterTargetProvince: string;
  letterTargetCity: string;
  letterTargetDistrict: string;
  journey: Journey | null;
  legs: readonly TransportLeg[];
  worldEvents: readonly WorldEvent[];
}

interface StationFact {
  name: string;
  province: string;
  city: string;
  mapX: number;
  mapY: number;
}

/**
 * 取站点用户可见位置事实。
 * StationNode 冻结数据只到 province / city（无 district），故 district 用空串（不捏造区县）。
 */
function stationFact(nodeId: string, graphVersion: string): StationFact | null {
  try {
    const node = getStationNode(nodeId, graphVersion);
    return {
      name: node.name,
      province: node.province,
      city: node.city,
      mapX: node.mapX,
      mapY: node.mapY,
    };
  } catch {
    return null; // 节点缺失：不因位置数据问题让用户事实整体失败
  }
}

/** 安全读取 WorldEvent.payload 为普通对象（payload 绝不整体暴露给用户）。 */
function payloadRecord(payload: unknown): Record<string, unknown> {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  return {};
}

function readTransport(value: unknown): TransportType | null {
  return value === "HAND_CARRY" ||
    value === "HORSE_RELAY" ||
    value === "EXPRESS_RELAY" ||
    value === "PIGEON"
    ? value
    : null;
}

/**
 * 生成用户可见事实（纯函数、deterministic、只依赖不可变历史）。
 *
 * 组成：
 * 1. normal transport facts：寄出 / 从某站发出 / 到达某站 / 派送中 / 已送达 / 终态确认结果。
 * 2. WorldEvent facts：IMMEDIATE（冻结表）→ 直接生成对应 safe fact；
 *    HIDDEN cause 一律跳过（canonical 世界事实由 World Truth 层保证唯一）。
 */
export function projectTimelineFacts(input: TimelineProjectionInput): TimelineFactDraft[] {
  const drafts: Omit<TimelineFactDraft, "sequence">[] = [];
  const { graphVersion, journey, legs, worldEvents } = input;

  if (!journey) return [];

  const sortedLegs = [...legs].sort((a, b) => a.sequence - b.sequence);
  const completedLegs = sortedLegs.filter((leg) => leg.status === "COMPLETED");
  const lastCompleted = completedLegs[completedLegs.length - 1] ?? null;
  const currentNodeId = lastCompleted?.toNodeId ?? journey.originNodeId;

  const push = (
    sourceKey: string,
    type: TimelineEventType,
    title: string,
    description: string,
    nodeId: string | null,
    happenedAtMs: number,
    visibleAtMs: number,
    metadata: Record<string, unknown> | null = null,
    /**
     * 区域锚点：仅当**驿站 province+city 与冻结区域完全一致**时才写真实 district。
     * 双校验用于防止同名城市 / 省级 fallback 站 / 跨省同 city label 误套区县。
     */
    region?: { province: string; city: string; district: string } | null
  ): void => {
    const station = nodeId === null ? null : stationFact(nodeId, graphVersion);
    // district 语义：station 冻结数据无区；只有区域锚点且驿站 province+city 双匹配时才可确认到区，
    // 否则为 null（禁止空串伪装 / 禁止按 city 猜测 / 禁止把目标区套到途中站）。
    const district =
      station !== null &&
      region !== undefined &&
      region !== null &&
      station.province === region.province &&
      station.city === region.city
        ? region.district
        : null;
    drafts.push({
      sourceKey,
      type,
      title,
      description,
      nodeId,
      province: station?.province ?? "",
      city: station?.city ?? "",
      district,
      mapX: station?.mapX ?? null,
      mapY: station?.mapY ?? null,
      happenedAtMs,
      visibleAtMs,
      importance: TIMELINE_IMPORTANCE[type],
      metadata,
    });
  };

  // ---------- 1) normal transport facts（只从不可变来源） ----------

  // 已寄出：永远使用冻结的 Letter 时间戳（sentAt → createdAt）。
  // 禁止使用 Journey.startedAtSim：它会在推进后出现/改变，导致同一 sourceKey 的事实内容变化。
  const dispatchAt = input.letterSentAt ?? input.letterCreatedAt;
  if (dispatchAt !== null) {
    const at = dispatchAt.getTime();
    push(
      "journey:dispatched",
      "DISPATCHED",
      "已寄出",
      `信件已从${stationFact(journey.originNodeId, graphVersion)?.name ?? "起点"}寄出`,
      journey.originNodeId,
      at,
      at,
      null,
      {
        province: input.letterOriginProvince,
        city: input.letterOriginCity,
        district: input.letterOriginDistrict,
      }
    );
  }

  // 已从某站发出（leg.startedAtSim 一旦设置不回退）
  for (const leg of sortedLegs) {
    if (leg.startedAtSim === null) continue;
    const name = stationFact(leg.fromNodeId, graphVersion)?.name ?? "驿站";
    const at = leg.startedAtSim.getTime();
    push(
      `leg:${String(leg.sequence)}:departed`,
      "DEPARTED_STATION",
      "已发出",
      `已从${name}发出`,
      leg.fromNodeId,
      at,
      at,
      { transport: leg.transportType }
    );
  }

  // 已到达某站（COMPLETED leg 永久保留；reroute 不删除已确认事实）
  for (const leg of completedLegs) {
    if (leg.completedAtSim === null) continue;
    const name = stationFact(leg.toNodeId, graphVersion)?.name ?? "驿站";
    const at = leg.completedAtSim.getTime();
    push(
      `leg:${String(leg.sequence)}:arrived`,
      "ARRIVED_STATION",
      "已到达",
      `已到达${name}`,
      leg.toNodeId,
      at,
      at,
      { transport: leg.transportType }
    );
  }

  // 派送中（规范 §43：到达目标驿站 ≠ Delivered）
  if (journey.lastMileReadyAtSim !== null) {
    const at = journey.lastMileReadyAtSim.getTime();
    push(
      "journey:out_for_delivery",
      "OUT_FOR_DELIVERY",
      "派送中",
      "已进入最后投递",
      journey.destinationNodeId,
      at,
      at,
      null,
      {
        province: input.letterTargetProvince,
        city: input.letterTargetCity,
        district: input.letterTargetDistrict,
      }
    );
  }

  // 已送达
  if (input.letterStatus === "DELIVERED" && input.letterDeliveredAt !== null) {
    const at = input.letterDeliveredAt.getTime();
    push(
      "letter:delivered",
      "DELIVERED",
      "已送达",
      "信件已送达",
      journey.destinationNodeId,
      at,
      at,
      null,
      {
        province: input.letterTargetProvince,
        city: input.letterTargetCity,
        district: input.letterTargetDistrict,
      }
    );
  }

  // 终态确认结果（冻结）：只表达结果，绝不说明原因
  if (input.letterStatus === "PERMANENTLY_LOST") {
    const at = terminalAt(worldEvents, completedLegs, dispatchAt);
    push(
      "letter:permanently_lost",
      "PERMANENTLY_LOST",
      "已确认永久遗失",
      "信件已确认永久遗失",
      currentNodeId,
      at,
      at
    );
  }
  if (input.letterStatus === "DESTROYED") {
    const at = terminalAt(worldEvents, completedLegs, dispatchAt);
    push(
      "letter:destroyed",
      "DESTROYED",
      "信件已损毁",
      "信件已损毁，无法送达",
      currentNodeId,
      at,
      at
    );
  }

  // ---------- 2) WorldEvent → user fact ----------

  for (const event of worldEvents) {
    const eventType = event.eventType as WorldEventTypeKey;
    const rule = WORLD_EVENT_VISIBILITY[eventType];
    if (!rule) continue;

    // 冻结表：Timeline 只认 WorldEvent.COURIER_MISSING（canonical，由 World Truth 层在
    // 每次 logical missing transition 原子产生唯一事件）。HIDDEN cause（LOST_PATH 等）
    // 一律不在此层猜测映射 → 直接跳过。
    const safeType = rule.policy === "IMMEDIATE" ? rule.timelineType : null;
    if (safeType === null) continue; // HIDDEN：不产生任何用户可见事实

    const occurredAtMs = event.occurredAtSim.getTime();
    const payload = payloadRecord(event.payload);

    // 冻结表：当前不存在 DELAYED visibility 规则（ROBBERY 已归 HIDDEN），
    // 因此所有可见事实的 visibleAt 等于其发生时刻。
    const visibleAtMs = occurredAtMs;

    switch (safeType) {
      case "TRANSPORT_DELAYED":
        push(
          `we:${String(event.eventIndex)}`,
          "TRANSPORT_DELAYED",
          "运输延误",
          "运输出现延误",
          event.nodeId,
          occurredAtMs,
          visibleAtMs
        );
        break;
      case "COURIER_MISSING":
        // canonical WorldEvent：World Truth 层保证每次 missing transition 唯一，不泄漏 cause
        push(
          `we:${String(event.eventIndex)}`,
          "COURIER_MISSING",
          "信使失联",
          "信使失联，正在确认情况",
          event.nodeId,
          occurredAtMs,
          visibleAtMs
        );
        break;
      case "LETTER_RECOVERED":
        push(
          `we:${String(event.eventIndex)}`,
          "LETTER_RECOVERED",
          "运输已恢复",
          "运输已恢复，信件重新启程",
          event.nodeId,
          occurredAtMs,
          visibleAtMs
        );
        break;
      case "TRANSPORT_CHANGED": {
        const to = readTransport(payload.to);
        const label = to === null ? "新的寄送方式" : TRANSPORT_LABELS[to];
        push(
          `we:${String(event.eventIndex)}`,
          "TRANSPORT_CHANGED",
          "寄送方式已变更",
          `寄送方式已变更为${label}`,
          event.nodeId,
          occurredAtMs,
          visibleAtMs,
          to === null ? null : { transport: to }
        );
        break;
      }
      default:
        break; // 其余用户可见类型由 normal facts 覆盖
    }
  }

  // ---------- 3) deterministic ordering（完整 canonical set） ----------
  // 排序键只使用 (happenedAt, importance, sourceKey)：全部由 projection 确定性产生，
  // 与插入顺序 / createdAt / 自增 id / materialization 批次无关。
  const ordered = [...drafts].sort((a, b) => {
    if (a.happenedAtMs !== b.happenedAtMs) return a.happenedAtMs - b.happenedAtMs;
    if (a.importance !== b.importance) return b.importance - a.importance;
    return a.sourceKey < b.sourceKey ? -1 : a.sourceKey > b.sourceKey ? 1 : 0;
  });
  // sequence = 完整 canonical fact set 中的 index（不是本轮 missing 数组下标）
  return ordered.map((fact, index) => ({ ...fact, sequence: index }));
}

/**
 * 终态事实时刻：只用不可变来源。
 * 优先对应 WorldEvent 的 occurredAtSim（仅取时刻，不泄漏其它），
 * 其次最后一个 COMPLETED Leg 的 completedAtSim，最后退回冻结的寄出时刻。
 */
function terminalAt(
  worldEvents: readonly WorldEvent[],
  completedLegs: readonly TransportLeg[],
  dispatchAt: Date | null
): number {
  const terminal =
    worldEvents.find((e) => e.eventType === "PERMANENTLY_LOST") ??
    worldEvents.find((e) => e.eventType === "DESTROYED") ??
    worldEvents.find((e) => e.eventType === "SERIOUS_ACCIDENT");
  if (terminal) return terminal.occurredAtSim.getTime();

  const last = completedLegs[completedLegs.length - 1];
  if (last?.completedAtSim) return last.completedAtSim.getTime();
  return dispatchAt?.getTime() ?? 0;
}

/**
 * 用户可见 Timeline 视图（严格 safe DTO，对应规范 §57 + Phase 7 Prompt §15）。
 * 不含：internal id / letterId / journeyId / worldEventId / eventIndex / nodeId /
 *       map 坐标 / payload / visibleAt / 任何后台字段。
 */
export interface TimelineEventView {
  type: TimelineEventType;
  title: string;
  description: string;
  location: { province: string; city: string };
  happenedAt: string;
}

export function toTimelineEventView(event: TimelineEvent): TimelineEventView {
  return {
    type: event.type,
    title: event.title,
    description: event.description,
    location: { province: event.province, city: event.city },
    happenedAt: event.happenedAt.toISOString(),
  };
}

/**
 * 物化某封信的用户可见 Timeline（幂等、事务安全、refresh-frequency independent）。
 *
 * - 每次都基于**完整 canonical fact set** 计算，因此分多次 GET 与最终一次 GET 结果一致。
 * - 缺失行用 createMany(skipDuplicates) 插入；已存在行的 sequence 若与 canonical 不一致则同步，
 *   （只同步排序键，不改用户可见内容 type/title/description/happenedAt/visibleAt/location）。
 * - 只返回 `visibleAt <= nowMs` 的事件：未到可见时刻的行服务端不返回。
 *
 * @param nowMs SimulationClock 当前模拟时刻（禁止 Date.now() 直接决定可见性）
 */
export async function materializeVisibleTimeline(
  prisma: PrismaClient,
  letterId: bigint,
  nowMs: number
): Promise<TimelineEvent[]> {
  const facts = await projectFactsForLetter(prisma, letterId);
  if (facts.length === 0) {
    return prisma.timelineEvent.findMany({
      where: { letterId, visibleAt: { lte: new Date(nowMs) } },
      orderBy: [{ happenedAt: "asc" }, { sequence: "asc" }, { sourceKey: "asc" }],
    });
  }

  const existing = await prisma.timelineEvent.findMany({
    where: { letterId },
    select: { id: true, sourceKey: true, sequence: true },
  });
  const existingByKey = new Map(existing.map((row) => [row.sourceKey, row]));

  const missing = facts.filter((fact) => !existingByKey.has(fact.sourceKey));
  const staleSequence = facts.filter((fact) => {
    const row = existingByKey.get(fact.sourceKey);
    return row !== undefined && row.sequence !== fact.sequence;
  });

  if (missing.length > 0 || staleSequence.length > 0) {
    try {
      await prisma.$transaction(async (tx) => {
        if (missing.length > 0) {
          await tx.timelineEvent.createMany({
            data: missing.map((fact) => ({
              letterId,
              sourceKey: fact.sourceKey,
              sequence: fact.sequence,
              type: fact.type,
              title: fact.title,
              description: fact.description,
              province: fact.province,
              city: fact.city,
              district: fact.district,
              nodeId: fact.nodeId,
              mapX: fact.mapX,
              mapY: fact.mapY,
              uncertaintyRadiusKm: null, // Phase 8 掉落范围；本阶段不做地图
              happenedAt: new Date(fact.happenedAtMs),
              visibleAt: new Date(fact.visibleAtMs),
              importance: fact.importance,
              metadata: (fact.metadata ?? Prisma.JsonNull) as Prisma.InputJsonValue,
            })),
            skipDuplicates: true,
          });
        }
        // 同步 canonical sequence（排序键），保证 late GET 与 many GET 最终 DB 一致
        for (const fact of staleSequence) {
          await tx.timelineEvent.updateMany({
            where: { letterId, sourceKey: fact.sourceKey },
            data: { sequence: fact.sequence },
          });
        }
      });
    } catch (err) {
      // 并发下 unique 冲突由 skipDuplicates 吸收；其它错误不吞（数据损坏必须暴露）。
      if (!isTimelineUniqueConflict(err)) throw err;
    }
  }

  return prisma.timelineEvent.findMany({
    where: { letterId, visibleAt: { lte: new Date(nowMs) } },
    orderBy: [{ happenedAt: "asc" }, { sequence: "asc" }, { sourceKey: "asc" }],
  });
}

/** 读取 Letter 快照并投影（供 materialize 与测试复用）。 */
export async function projectFactsForLetter(
  prisma: PrismaClient,
  letterId: bigint
): Promise<TimelineFactDraft[]> {
  const letter = await prisma.letter.findUnique({
    where: { id: letterId },
    include: { journey: { include: { legs: true, worldEvents: true } } },
  });
  if (!letter) return [];

  const journey = letter.journey ?? null;
  return projectTimelineFacts({
    graphVersion: letter.graphVersion,
    letterStatus: letter.status as LetterStatus,
    letterDeliveredAt: letter.deliveredAt,
    letterSentAt: letter.sentAt,
    letterCreatedAt: letter.createdAt,
    letterOriginProvince: letter.originProvince,
    letterOriginCity: letter.originCity,
    letterOriginDistrict: letter.originDistrict,
    letterTargetProvince: letter.targetProvince,
    letterTargetCity: letter.targetCity,
    letterTargetDistrict: letter.targetDistrict,
    journey,
    legs: journey?.legs ?? [],
    worldEvents: journey?.worldEvents ?? [],
  });
}

/**
 * 判断是否为 **(letterId, sourceKey) 复合唯一约束**冲突（Gate MEDIUM）。
 *
 * 每种 Prisma / driver metadata 表达**独立判断**，**禁止跨 metadata source 拼接字段**：
 * - `meta.target` 为数组且规范化去重排序后恰好等于 ["letterId","sourceKey"] → 接受；
 * - `meta.target` 为已知复合约束名（`TimelineEvent_letterId_sourceKey_key`）→ 接受；
 * - driver `constraint.fields` 单独给出精确复合字段对 → 接受；
 * - driver `constraint.name` 为已知约束名 → 接受；
 * - 其它任何组合（如 target=["letterId"] + driver=["sourceKey"]、单字段、无关约束）→ false（rethrow）。
 */
export function isTimelineUniqueConflict(err: unknown): boolean {
  const e = err as {
    code?: string;
    meta?: {
      target?: unknown;
      driverAdapterError?: { cause?: { constraint?: { fields?: string[]; name?: string } } };
    };
  };
  if (e?.code !== "P2002") return false;

  const norm = (value: string): string => value.replace(/"/g, "");
  const KNOWN_CONSTRAINT_SUFFIX = "TimelineEvent_letterId_sourceKey_key";

  /** 精确字段对（单来源）：去引号规范化 + 去重排序后恰好等于 ["letterId","sourceKey"]。 */
  const exactPair = (values: unknown): boolean => {
    if (!Array.isArray(values)) return false;
    const str = values.filter((v): v is string => typeof v === "string").map(norm);
    const sorted = [...new Set(str)].sort();
    return sorted.length === 2 && sorted[0] === "letterId" && sorted[1] === "sourceKey";
  };
  const knownName = (name: unknown): boolean =>
    typeof name === "string" && norm(name).endsWith(KNOWN_CONSTRAINT_SUFFIX);

  // 各权威表达独立判断，不跨源拼接
  const target = e.meta?.target;
  if (exactPair(target)) return true;
  if (knownName(target)) return true;

  const constraint = e.meta?.driverAdapterError?.cause?.constraint;
  if (exactPair(constraint?.fields)) return true;
  if (knownName(constraint?.name)) return true;

  return false;
}
