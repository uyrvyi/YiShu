/**
 * Phase 6 核心服务：Journey 推进（正常运输 + 随机事件 + Recovery + World Truth）。
 *
 * 语义契约：
 * - 使用 SimulationClock（禁止业务直接 Date.now()），推进规则按 **Journey 冻结的 rulesVersion**
 *   （未知版本抛 UnknownRulesVersionError，不得 fallback latest）。
 * - 可重复 progression loop：以「理论事件时间」为游标推进，直到 now 不足以完成当前状态或到达终态；
 *   结果与 advance 调用频率无关（一次大跳跃 vs 多次分段推进完全一致）。
 * - 每个 Leg 最多判定一次 primary event：首次激活时确定性抽取并持久化
 *   （primaryEventIndex / primaryEventOutcome / delaySeconds），之后只按冻结结果继续推进；
 *   DELAY 真正延长完成时间（effectiveDuration = plannedDuration + delaySeconds），不会重复抽取。
 * - REROUTE 在事件发生时刻重建 remaining legs，并**继续消费事件时刻 → now 的剩余模拟时间**
 *   （不得因 reroute 提前停止；同一 now 再调用为 no-op）。
 * - completedPath 由 Leg 状态确定性派生（journey.ts toPathViews）；reroute / recovery / transport
 *   change 只重建 remaining，COMPLETED legs / completedPath / 历史 WorldEvent 永不修改。
 * - 自动运输方式变更必须按新 transport 重建剩余路线（PIGEON→direct、ground→Dijkstra、
 *   ground→ground 按 allowedTransport 重规划），不允许仅改字段。
 * - 最后一个 Leg COMPLETED（到达目标站）≠ DELIVERED：OUT_FOR_DELIVERY →
 *   冻结 LAST_MILE_DURATION_SECONDS → DELIVERED（deliveredAt 只设置一次）。
 * - 异常（COURIER_MISSING / LETTER_DROPPED）：运输暂停；恢复窗口后自动恢复（可自动变更运输方式并重建路线），
 *   7 个模拟日未恢复 → PERMANENTLY_LOST。PIGEON 严重事故 → DESTROYED。
 * - 幂等 / 时间倒退：now <= lastAdvancedAtSim 时 no-op；终态后 no-op。
 * - 并发：事务内 `SELECT ... FOR UPDATE` 锁 Journey + 锁后重读，恰一套世界结果，
 *   不重复事件 / 不重复掉信 / 不重复 recovery / 不 500；eventIndex 事务内单调消费，rollback 无半个事件。
 */
import {
  Prisma,
  type Journey,
  type JourneyAnomalyType,
  type JourneyStatus,
  type Letter,
  type PrismaClient,
  type TransportLeg,
  type TransportLegStatus,
  type WorldEventType,
} from "@yishu/db";
import type { SimulationClock } from "@yishu/simulation";
import { deterministicDraw } from "@yishu/simulation";
import {
  DELAY_MAX_SECONDS,
  DROP_RECOVERY_WINDOW_SECONDS,
  DROP_RECOVERY_WINDOWS,
  LAST_MILE_DURATION_SECONDS,
  PERMANENT_LOSS_SECONDS,
  RECOVERY_HANDLINGS,
  RECOVERY_TRANSPORT_CHANGE,
  ROBBERY_BRANCHES,
  SET_ASIDE_DELAY_SECONDS,
  SECONDS_PER_DAY,
  selectWeightedOutcome,
  speedKmPerDay,
  transportEventTable,
  type LetterStatus,
  type TransportType,
} from "@yishu/shared";
import { NoRouteError } from "@yishu/routing";
import { planRouteExcluding } from "./stationGraph.js";

export class LetterNotFoundError extends Error {
  constructor(public readonly letterId: bigint) {
    super("letter_not_found");
    this.name = "LetterNotFoundError";
  }
}

export class JourneyNotFoundError extends Error {
  constructor(public readonly letterId: bigint) {
    super("journey_not_found");
    this.name = "JourneyNotFoundError";
  }
}

export interface AdvanceJourneyResult {
  /** 本次推进是否产生了任何状态变化；false = no-op（终态 / 重复 / 时间倒退 / 异常等待中）。 */
  changed: boolean;
  letterStatus: LetterStatus;
  journeyStatus: JourneyStatus;
  currentLegSequence: number | null;
}

/** Letter 终态：不可再推进（deliveredAt 等不可重写）。 */
const TERMINAL_LETTER_STATUSES: ReadonlySet<LetterStatus> = new Set([
  "DELIVERED",
  "PERMANENTLY_LOST",
  "DESTROYED",
]);

/** Leg 状态机：PLANNED → ACTIVE → COMPLETED（单向，completed 不可回退）。 */
const LEG_ACTIVE: TransportLegStatus = "ACTIVE";
const LEG_COMPLETED: TransportLegStatus = "COMPLETED";

/** 新重建 legs 的占位 id 上限（负 id；persist 时跳过这些 change 的 update，由 createMany 落库）。
 * 负 id 保证每个新 leg 唯一，避免 changes.some(c.id===l.id) 串扰（0 会全部匹配）。 */
const MAX_NEW_LEG_ID = BigInt(0);

interface LegChange {
  id: bigint;
  status?: TransportLegStatus;
  startedAtSim?: Date;
  completedAtSim?: Date;
  primaryEventIndex?: number;
  primaryEventOutcome?: string;
  delaySeconds?: number;
}

interface WorldEventDraft {
  eventIndex: number;
  eventType: WorldEventType;
  occurredAtMs: number;
  nodeId: string;
  transportLegSequence: number | null;
  payload?: Prisma.InputJsonValue;
}

/** 事件处理上下文（推进循环内可变状态）。 */
interface AdvanceState {
  journeyId: bigint;
  letterStatus: LetterStatus;
  journeyStatus: JourneyStatus;
  letterTransport: TransportType;
  journeyStartedAt: Date | null;
  journeyCompletedAt: Date | null;
  currentLegSequence: number | null;
  deliveredAtMs: number | null;
  eventIndex: number;
  anomalyType: JourneyAnomalyType | null;
  anomalyStartedAtMs: number | null;
  anomalyResolvedAtMs: number | null;
  /** 当前稳定节点（最后 COMPLETED leg 的 toNodeId；初始 originNodeId）。 */
  currentNodeId: string;
  /** 恢复后的续运起点（模拟时刻）；null = 无恢复发生（持久化为 Journey.resumeAtSim）。 */
  recoveryResumeMs: number | null;
  /** last-mile 起点（持久化 Journey.lastMileReadyAtSim）：= max(完成时刻, resumeAt)，跨调用稳定。 */
  lastMileReadyAtMs: number | null;
  changes: LegChange[];
  worldEvents: WorldEventDraft[];
  /** 整个事务内最早的重建边界：persist 时从该 sequence 完整替换 remaining（连续 reroute 取 min）。 */
  earliestRebuiltFromSequence: number | null;
  /** 事务内全局唯一的临时负 ID（每次 rebuild 继续递减，不重置）。 */
  nextTempLegId: bigint;
  /** 推进结束后的最终 legs（persist 时用于 totalDistanceKm 重算与新建 legs 落库）。 */
  finalLegs: TransportLeg[];
  anyStateChanged: boolean;
}

type DrawFn = () => { value: number; index: number };
type RecordFn = (
  type: WorldEventType,
  occurredAtMs: number,
  index: number,
  nodeId: string,
  transportLegSequence: number | null,
  payload?: Prisma.InputJsonValue
) => void;

/**
 * 将 Letter 的 Journey 按模拟时钟推进到当前时刻。
 * @param prisma Prisma Client
 * @param letterId Letter 内部 id
 * @param clock 模拟时钟（SystemSimulationClock 生产 / TestSimulationClock 测试）
 * @throws LetterNotFoundError / JourneyNotFoundError / UnknownRulesVersionError
 */
export async function advanceJourneyToNow(
  prisma: PrismaClient,
  letterId: bigint,
  clock: SimulationClock
): Promise<AdvanceJourneyResult> {
  const nowMs = clock.now();

  // 事务外快速路径：只做存在性检查；终态判断必须在锁后（保证 lastAdvancedAtSim 单调，
  // 调用频率无关 replay 在终态后依然成立）
  const letter = await prisma.letter.findUnique({ where: { id: letterId } });
  if (!letter) throw new LetterNotFoundError(letterId);
  const journey = await prisma.journey.findUnique({ where: { letterId } });
  if (!journey) throw new JourneyNotFoundError(letterId);

  return prisma.$transaction(async (tx) => {
    // 行锁 + 锁后重读：并发 advance 串行化；时间倒退 / 重复推进在此判定
    await tx.$queryRaw`SELECT id FROM "Journey" WHERE id = ${journey.id} FOR UPDATE`;
    const lockedJourney = await tx.journey.findUniqueOrThrow({ where: { id: journey.id } });
    const lockedLetter = await tx.letter.findUniqueOrThrow({ where: { id: letterId } });
    const legs = await tx.transportLeg.findMany({
      where: { journeyId: journey.id },
      orderBy: { sequence: "asc" },
    });

    const lastAdvancedMs = lockedJourney.lastAdvancedAtSim?.getTime() ?? null;
    if (lastAdvancedMs !== null && nowMs <= lastAdvancedMs) {
      // 契约：时间倒退 / 同一 now 重复推进 → no-op（不重放、不倒退状态）
      return {
        changed: false,
        letterStatus: lockedLetter.status,
        journeyStatus: lockedJourney.status,
        currentLegSequence: lockedJourney.currentLegSequence,
      };
    }

    if (TERMINAL_LETTER_STATUSES.has(lockedLetter.status)) {
      // 终态 no-op，但模拟时间仍单调前进：只更新 lastAdvancedAtSim = now，
      // 不修改业务终态字段 / deliveredAt / Legs / 不新增 WorldEvent。
      await tx.journey.update({
        where: { id: journey.id },
        data: { lastAdvancedAtSim: new Date(nowMs) },
      });
      return {
        changed: false,
        letterStatus: lockedLetter.status,
        journeyStatus: lockedJourney.status,
        currentLegSequence: lockedJourney.currentLegSequence,
      };
    }

    // 冻结规则权威：Journey.rulesVersion（不是 Letter）。未知版本明确失败（不静默 fallback）。
    // 抛错发生在任何写库之前 → 整个事务回滚，无部分状态 / 无半个事件历史写入。
    const rulesVersion = lockedJourney.rulesVersion;
    for (const leg of legs) {
      speedKmPerDay(rulesVersion, leg.transportType);
      transportEventTable(rulesVersion, leg.transportType);
    }
    if (legs.length === 0) {
      speedKmPerDay(rulesVersion, "PIGEON");
      transportEventTable(rulesVersion, "PIGEON");
    }

    // 当前稳定节点：最后 COMPLETED leg 的 toNodeId；无则 originNodeId
    let currentNodeId = lockedJourney.originNodeId;
    for (let i = legs.length - 1; i >= 0; i -= 1) {
      const l = legs[i];
      if (l && l.status === LEG_COMPLETED) {
        currentNodeId = l.toNodeId;
        break;
      }
    }

    const state: AdvanceState = {
      journeyId: journey.id,
      letterStatus: lockedLetter.status,
      journeyStatus: lockedJourney.status,
      letterTransport: lockedLetter.currentTransport,
      journeyStartedAt: lockedJourney.startedAtSim,
      journeyCompletedAt: lockedJourney.completedAtSim,
      currentLegSequence: lockedJourney.currentLegSequence,
      deliveredAtMs: null,
      eventIndex: lockedJourney.nextEventIndex,
      anomalyType: lockedJourney.anomalyType,
      anomalyStartedAtMs: lockedJourney.anomalyStartedAtSim?.getTime() ?? null,
      anomalyResolvedAtMs: lockedJourney.anomalyResolvedAtSim?.getTime() ?? null,
      currentNodeId,
      recoveryResumeMs: lockedJourney.resumeAtSim?.getTime() ?? null,
      lastMileReadyAtMs: lockedJourney.lastMileReadyAtSim?.getTime() ?? null,
      changes: [],
      worldEvents: [],
      earliestRebuiltFromSequence: null,
      nextTempLegId: BigInt(-1),
      finalLegs: legs,
      anyStateChanged: false,
    };

    // 确定性随机源（eventIndex 单调递增，持久化后 replay 一致；retry/rollback 不重复消费）
    const draw: DrawFn = () => {
      const index = state.eventIndex;
      state.eventIndex += 1;
      return { value: deterministicDraw(lockedJourney.simulationSeed, index), index };
    };
    const record: RecordFn = (type, occurredAtMs, index, nodeId, transportLegSequence, payload) => {
      state.worldEvents.push({
        eventIndex: index,
        eventType: type,
        occurredAtMs,
        nodeId,
        transportLegSequence,
        payload,
      });
      state.anyStateChanged = true;
    };

    // 可重复 progression loop：以理论事件时间为游标，直到 now 不足以推进或到达终态。
    // 一次大跳跃与多次分段推进必须产生完全一致的结果。
    runProgression(state, legs, lockedJourney, rulesVersion, nowMs, draw, record);

    const changed =
      state.anyStateChanged ||
      state.eventIndex !== lockedJourney.nextEventIndex ||
      state.anomalyType !== lockedJourney.anomalyType ||
      (state.anomalyStartedAtMs ?? null) !==
        (lockedJourney.anomalyStartedAtSim?.getTime() ?? null) ||
      (state.anomalyResolvedAtMs ?? null) !==
        (lockedJourney.anomalyResolvedAtSim?.getTime() ?? null) ||
      state.letterTransport !== lockedLetter.currentTransport ||
      state.earliestRebuiltFromSequence !== null;

    // 始终 persist：now > lastAdvanced 已保证（上面 return），任何调用都把模拟时钟
    // 前进到 now（即使状态无变化 / 异常等待中），保证"一次大跳跃 vs 分段推进"的 lastAdvanced 一致。
    await persistAdvance(tx, journey, lockedLetter, state, nowMs);

    return {
      changed,
      letterStatus: state.letterStatus,
      journeyStatus: state.journeyStatus,
      currentLegSequence: state.currentLegSequence,
    };
  });
}

/** 可重复推进主循环。 */
function runProgression(
  state: AdvanceState,
  legs: TransportLeg[],
  journey: Journey,
  rulesVersion: string,
  nowMs: number,
  draw: DrawFn,
  record: RecordFn
): void {
  for (;;) {
    // 1) 终态
    if (TERMINAL_LETTER_STATUSES.has(state.letterStatus)) return;

    // 2) 异常：恢复 / 永久丢失 / 等待
    if (state.anomalyType !== null && state.anomalyStartedAtMs !== null) {
      const resolved = resolveAnomalyIfDue(state, legs, journey, rulesVersion, draw, record, nowMs);
      if (resolved === "noop") return;
      if (resolved === "lost") return;
      // recovered：继续循环（transport change 可能已重建 remaining）
      continue;
    }

    // 2.5) 续运 not-before 边界（SET_ASIDE 等）：now < resumeAt 时保持 PLANNED，不激活、不抽事件
    if (state.recoveryResumeMs !== null && nowMs < state.recoveryResumeMs) {
      return;
    }

    // 3) 零 Leg（同站点 PIGEON）或全部完成 → last-mile
    if (legs.length === 0 || allCompleted(legs, state)) {
      if (legs.length === 0 && state.journeyStartedAt === null) {
        state.journeyStartedAt = new Date(nowMs);
        state.journeyCompletedAt = new Date(nowMs);
        state.journeyStatus = "COMPLETED";
        state.anyStateChanged = true;
      }
      // 先让 last-mile 使用 resumeAt（目的站异常恢复后：送达起点必须 >= 恢复时刻，不得因果倒置），再清空
      finalizeLastMile(state, legs, nowMs);
      state.recoveryResumeMs = null; // 无 leg 可续运：清空 not-before 边界
      return;
    }

    // 4) 定位当前 leg（第一个非 COMPLETED）
    const cursor = firstPendingIndex(legs);
    if (cursor === null) {
      finalizeLastMile(state, legs, nowMs);
      return;
    }
    const leg = legs[cursor];
    if (!leg) return;

    // 5) 首次激活该 Leg：判定 primary event 并持久化（每 Leg 最多一次）
    if (leg.primaryEventIndex === null) {
      const legStartMs = resolveLegStartMs(state, legs, cursor, nowMs);
      judgePrimaryEvent(state, leg, legStartMs, rulesVersion, draw);
      // 已把 startedAtSim 定为 resumeAt：not-before 边界使命完成，清空（持久化 null）
      state.recoveryResumeMs = null;
    }

    // 6) effective 完成时刻 = start + (planned + delay)
    const legStartMs = leg.startedAtSim?.getTime() ?? nowMs;
    const effectiveMs = legStartMs + (leg.plannedDurationSeconds + (leg.delaySeconds ?? 0)) * 1000;
    if (nowMs < effectiveMs) {
      // 尚未完成：激活并等待
      ensureActive(state, leg, legStartMs);
      state.currentLegSequence = leg.sequence;
      return;
    }

    // 7) Leg 完成
    completeLeg(state, leg, legStartMs, effectiveMs);
    state.currentNodeId = leg.toNodeId;
    state.journeyCompletedAt = new Date(effectiveMs);

    // 8) 应用 primary outcome 的完成点效果（事件在效果发生时刻记录，payload 完整、无跨调用 patch）
    const outcome = leg.primaryEventOutcome ?? "NORMAL";
    switch (outcome) {
      case "NORMAL":
        continue;
      case "DELAYED": {
        record("DELAYED", effectiveMs, leg.primaryEventIndex ?? -1, leg.toNodeId, leg.sequence, {
          delaySeconds: leg.delaySeconds ?? 0,
          transportType: leg.transportType,
        });
        continue;
      }
      case "ROBBERY_ESCAPE":
      case "ROBBERY_INJURED": {
        const branch = outcome === "ROBBERY_ESCAPE" ? "ESCAPE_DELAY" : "INJURED_CONTINUE";
        record("ROBBERY", effectiveMs, leg.primaryEventIndex ?? -1, leg.toNodeId, leg.sequence, {
          branch,
          transportType: leg.transportType,
        });
        continue;
      }
      case "REROUTE": {
        const nextLeg = legs[cursor + 1];
        if (nextLeg === undefined) continue; // 已是最后一段：无剩余路线可改
        const excludedEdge = { from: leg.toNodeId, to: nextLeg.toNodeId };
        let route: Awaited<ReturnType<typeof planRouteExcluding>> | undefined;
        try {
          route = planRouteExcluding({
            graphVersion: journey.graphVersion,
            originNodeId: leg.toNodeId,
            destinationNodeId: journey.destinationNodeId,
            transportType: leg.transportType,
            excludedEdge,
          });
        } catch (err) {
          // 只把"真正无替代路线"转换为 COURIER_MISSING 世界事件；
          // UnknownGraphVersionError / 节点错误 / 数据损坏 / 未知异常必须继续抛出 → 事务回滚
          if (!(err instanceof NoRouteError)) throw err;
          record(
            "COURIER_MISSING",
            effectiveMs,
            leg.primaryEventIndex ?? -1,
            leg.toNodeId,
            leg.sequence,
            {
              transportType: leg.transportType,
              excludedEdge,
              reason: "no_alternative_route",
            }
          );
          enterAnomaly(state, "COURIER_MISSING", effectiveMs, leg, draw);
          continue;
        }
        if (!route) continue;
        record("REROUTED", effectiveMs, leg.primaryEventIndex ?? -1, leg.toNodeId, leg.sequence, {
          excludedEdge,
          newLegCount: route.edges.length,
          newTotalDistanceKm: route.totalDistanceKm,
        });
        rebuildRemaining(state, legs, journey, cursor + 1, route, rulesVersion);
        continue; // 重建后继续消费事件时刻 → now 的剩余模拟时间（BLOCKER-2 修复）
      }
      case "LOST_PATH":
        record("LOST_PATH", effectiveMs, leg.primaryEventIndex ?? -1, leg.toNodeId, leg.sequence, {
          transportType: leg.transportType,
          pigeon: leg.transportType === "PIGEON",
        });
        enterAnomaly(state, "COURIER_MISSING", effectiveMs, leg, draw);
        continue;
      case "COURIER_MISSING":
        record(
          "COURIER_MISSING",
          effectiveMs,
          leg.primaryEventIndex ?? -1,
          leg.toNodeId,
          leg.sequence,
          {
            transportType: leg.transportType,
          }
        );
        enterAnomaly(state, "COURIER_MISSING", effectiveMs, leg, draw);
        continue;
      case "LETTER_DROPPED":
        record(
          "LETTER_DROPPED",
          effectiveMs,
          leg.primaryEventIndex ?? -1,
          leg.toNodeId,
          leg.sequence,
          {
            transportType: leg.transportType,
          }
        );
        enterAnomaly(state, "LETTER_DROPPED", effectiveMs, leg, draw);
        continue;
      case "ROBBERY_MISSING":
      case "ROBBERY_DEAD": {
        const branch = outcome === "ROBBERY_MISSING" ? "MISSING_DROPPED" : "DEAD_DROPPED";
        record("ROBBERY", effectiveMs, leg.primaryEventIndex ?? -1, leg.toNodeId, leg.sequence, {
          branch,
          transportType: leg.transportType,
        });
        enterAnomaly(state, "LETTER_DROPPED", effectiveMs, leg, draw);
        continue;
      }
      case "SERIOUS_ACCIDENT":
        if (leg.transportType === "PIGEON") {
          // 飞鸽严重事故 → DESTROYED（唯一允许 DESTROYED 的严重事故分支）
          record(
            "SERIOUS_ACCIDENT",
            effectiveMs,
            leg.primaryEventIndex ?? -1,
            leg.toNodeId,
            leg.sequence,
            {
              transportType: leg.transportType,
            }
          );
          state.letterStatus = "DESTROYED";
          state.anyStateChanged = true;
          return;
        }
        record(
          "SERIOUS_ACCIDENT",
          effectiveMs,
          leg.primaryEventIndex ?? -1,
          leg.toNodeId,
          leg.sequence,
          {
            transportType: leg.transportType,
          }
        );
        enterAnomaly(state, "LETTER_DROPPED", effectiveMs, leg, draw);
        continue;
      default:
        continue;
    }
  }
}

function allCompleted(legs: TransportLeg[], state: AdvanceState): boolean {
  return legs.every(
    (l) =>
      l.status === LEG_COMPLETED ||
      state.changes.some((c) => c.id === l.id && c.status === LEG_COMPLETED)
  );
}

function firstPendingIndex(legs: TransportLeg[]): number | null {
  for (let i = 0; i < legs.length; i += 1) {
    const l = legs[i];
    if (l && l.status !== LEG_COMPLETED) return i;
  }
  return null;
}

/** leg 起点：已持久化 startedAtSim → 恢复时刻 → 前一 leg 完成时刻 → 首次推进 now。 */
function resolveLegStartMs(
  state: AdvanceState,
  legs: TransportLeg[],
  cursor: number,
  nowMs: number
): number {
  const existing = legs[cursor]?.startedAtSim?.getTime();
  if (existing !== undefined && existing !== null) return existing;
  if (state.recoveryResumeMs !== null) return state.recoveryResumeMs;
  if (cursor > 0) {
    const prevEnd = legs[cursor - 1]?.completedAtSim?.getTime();
    if (prevEnd !== undefined && prevEnd !== null) return prevEnd;
  }
  return nowMs;
}

/** 首次激活 Leg：判定并持久化 primary event（细分 outcome / delay；每 Leg 最多一次）。
 * 事件本体在完成点记录（效果发生时刻），避免跨调用 patch 已持久化事件。 */
function judgePrimaryEvent(
  state: AdvanceState,
  leg: TransportLeg,
  legStartMs: number,
  rulesVersion: string,
  draw: DrawFn
): void {
  const primary = draw();
  const outcome = selectWeightedOutcome(
    primary.value,
    transportEventTable(rulesVersion, leg.transportType)
  );
  let frozenOutcome: string = outcome;
  let delay = 0;

  switch (outcome) {
    case "DELAY":
    case "OTHER":
    case "DEVIATION":
    case "TEMPORARY_STOP":
      delay = Math.round(draw().value * DELAY_MAX_SECONDS);
      frozenOutcome = "DELAYED";
      break;
    case "ROBBERY": {
      const branch = selectWeightedOutcome(draw().value, ROBBERY_BRANCHES);
      if (branch === "ESCAPE_DELAY") {
        frozenOutcome = "ROBBERY_ESCAPE";
        delay = Math.round(draw().value * DELAY_MAX_SECONDS);
      } else if (branch === "INJURED_CONTINUE") {
        frozenOutcome = "ROBBERY_INJURED";
        delay = Math.round(draw().value * DELAY_MAX_SECONDS);
      } else if (branch === "MISSING_DROPPED") {
        frozenOutcome = "ROBBERY_MISSING";
      } else {
        frozenOutcome = "ROBBERY_DEAD";
      }
      break;
    }
    case "NORMAL":
    case "REROUTE":
    case "LOST_PATH":
    case "LOST":
    case "COURIER_MISSING":
    case "LETTER_DROPPED":
    case "SERIOUS_ACCIDENT":
      frozenOutcome = outcome === "LOST" ? "LOST_PATH" : outcome;
      break;
  }

  leg.primaryEventIndex = primary.index;
  leg.primaryEventOutcome = frozenOutcome;
  leg.delaySeconds = delay;
  leg.startedAtSim = new Date(legStartMs);
  pushLegChange(
    state,
    leg.id,
    undefined,
    leg.startedAtSim,
    undefined,
    primary.index,
    frozenOutcome,
    delay
  );
}

/** last-mile：全 legs 完成 → OUT_FOR_DELIVERY → 冻结时长后 DELIVERED（deliveredAt 只设置一次）。
 * last-mile 起点 = max(理论完成时刻, 恢复续运时刻 resumeAt, 已持久化 lastMileReadyAt)：
 * - 目的站异常（最后一个 Leg 完成触发 LETTER_DROPPED / COURIER_MISSING / SET_ASIDE）恢复后，
 *   送达必须从恢复时刻重新起算，不得用异常前的完成时刻（否则 deliveredAt 早于 RECOVERED，因果倒置）。
 * - lastMileReadyAtSim 持久化：OUT_FOR_DELIVERY 等待期跨调用推进时基准不退化。 */
function finalizeLastMile(state: AdvanceState, legs: TransportLeg[], nowMs: number): void {
  if (state.anomalyType !== null || TERMINAL_LETTER_STATUSES.has(state.letterStatus)) return;
  const transportComplete =
    legs.length === 0 ||
    legs.every(
      (l) =>
        l.status === LEG_COMPLETED ||
        state.changes.some((c) => c.id === l.id && c.status === LEG_COMPLETED)
    );
  if (!transportComplete || state.journeyCompletedAt === null) return;
  state.journeyStatus = "COMPLETED";
  let lastMileStartMs = state.journeyCompletedAt.getTime();
  if (state.recoveryResumeMs !== null && state.recoveryResumeMs > lastMileStartMs) {
    lastMileStartMs = state.recoveryResumeMs;
  }
  if (state.lastMileReadyAtMs !== null && state.lastMileReadyAtMs > lastMileStartMs) {
    lastMileStartMs = state.lastMileReadyAtMs;
  }
  state.lastMileReadyAtMs = lastMileStartMs; // 持久化（跨调用稳定）
  const deliveredAtMs = lastMileStartMs + LAST_MILE_DURATION_SECONDS * 1000;
  state.letterStatus = nowMs >= deliveredAtMs ? "DELIVERED" : "OUT_FOR_DELIVERY";
  if (state.letterStatus === "DELIVERED") state.deliveredAtMs = deliveredAtMs;
  state.anyStateChanged = true;
}

function ensureActive(state: AdvanceState, leg: TransportLeg, legStartMs: number): void {
  if (state.letterStatus === "DISPATCHED") state.letterStatus = "IN_TRANSIT";
  if (state.journeyStatus === "PLANNED") state.journeyStatus = "IN_PROGRESS";
  if (state.journeyStartedAt === null) state.journeyStartedAt = new Date(legStartMs);
  if (leg.status !== LEG_ACTIVE) {
    leg.status = LEG_ACTIVE;
    pushLegChange(state, leg.id, LEG_ACTIVE, undefined, undefined, undefined, undefined, undefined);
  }
}

function completeLeg(
  state: AdvanceState,
  leg: TransportLeg,
  legStartMs: number,
  effectiveMs: number
): void {
  if (state.letterStatus === "DISPATCHED") state.letterStatus = "IN_TRANSIT";
  if (state.journeyStatus === "PLANNED") state.journeyStatus = "IN_PROGRESS";
  if (state.journeyStartedAt === null) state.journeyStartedAt = new Date(legStartMs);
  leg.status = LEG_COMPLETED;
  leg.startedAtSim = new Date(legStartMs);
  leg.completedAtSim = new Date(effectiveMs);
  state.currentLegSequence = null;
  pushLegChange(
    state,
    leg.id,
    LEG_COMPLETED,
    leg.startedAtSim,
    leg.completedAtSim,
    undefined,
    undefined,
    undefined
  );
}

/** 进入异常状态：抽取恢复窗口并持久化（完成点；replay 一致）。
 * 调用方已记录该 leg 的主事件（COURIER_MISSING / LETTER_DROPPED / ROBBERY / SERIOUS_ACCIDENT），
 * 此处把 recoveryWindow 追加到刚创建的 draft（同一事务内存中，无跨调用 patch 问题）。 */
function enterAnomaly(
  state: AdvanceState,
  anomalyType: JourneyAnomalyType,
  occurredAtMs: number,
  leg: TransportLeg,
  draw: DrawFn
): void {
  const window = selectWeightedOutcome(draw().value, DROP_RECOVERY_WINDOWS);
  const range = DROP_RECOVERY_WINDOW_SECONDS[window];
  let resolvedMs: number | null = null;
  if (range !== null) {
    const unit = draw();
    const seconds = range.min + unit.value * (range.max - range.min);
    resolvedMs = occurredAtMs + Math.round(seconds * 1000);
  }
  state.anomalyType = anomalyType;
  state.anomalyStartedAtMs = occurredAtMs;
  state.anomalyResolvedAtMs = resolvedMs;
  state.currentLegSequence = null;
  state.letterStatus = anomalyType === "COURIER_MISSING" ? "COURIER_MISSING" : "LETTER_DROPPED";
  state.anyStateChanged = true;
  // 把 recoveryWindow 追加到该 leg 的主事件 payload（刚记录的 draft；同一事务内）
  patchEventPayload(state, leg.primaryEventIndex ?? undefined, { recoveryWindow: window });
}

/** 恢复 / 永久丢失判定（异常存在时）。返回 "recovered" | "lost" | "noop"。 */
function resolveAnomalyIfDue(
  state: AdvanceState,
  legs: TransportLeg[],
  journey: Journey,
  rulesVersion: string,
  draw: DrawFn,
  record: RecordFn,
  nowMs: number
): "recovered" | "lost" | "noop" {
  const startedMs = state.anomalyStartedAtMs;
  const resolvedMs = state.anomalyResolvedAtMs;
  if (startedMs === null) return "noop";
  const sevenDaysMs = startedMs + PERMANENT_LOSS_SECONDS * 1000;
  const wasAnomaly = state.anomalyType;
  const currentNodeId = state.currentNodeId;

  if (resolvedMs !== null && nowMs >= resolvedMs) {
    // 恢复
    const handling = selectWeightedOutcome(draw().value, RECOVERY_HANDLINGS);
    const setAsideMs = handling === "SET_ASIDE" ? SET_ASIDE_DELAY_SECONDS * 1000 : 0;
    const transportDraw = draw();
    const newTransport = selectWeightedOutcome(
      transportDraw.value,
      RECOVERY_TRANSPORT_CHANGE[state.letterTransport]
    );
    const oldTransport = state.letterTransport;
    record("RECOVERED", resolvedMs, transportDraw.index, currentNodeId, null, {
      anomalyType: wasAnomaly,
      handling,
      setAsideSeconds: setAsideMs / 1000,
      oldTransport,
      newTransport,
    });
    state.anomalyType = null;
    state.anomalyStartedAtMs = null;
    state.anomalyResolvedAtMs = null;
    // 续运 not-before 边界（SET_ASIDE 加延迟；持久化到 Journey.resumeAtSim，跨调用生效）
    state.recoveryResumeMs = resolvedMs + setAsideMs;
    state.letterStatus = "IN_TRANSIT";
    state.anyStateChanged = true;

    if (newTransport !== oldTransport) {
      state.letterTransport = newTransport;
      record("TRANSPORT_CHANGED", resolvedMs, draw().index, currentNodeId, null, {
        from: oldTransport,
        to: newTransport,
      });
      // 必须按新 transport 重建剩余路线（HIGH：跨 PIGEON/ground 语义）
      rebuildRemainingForTransport(state, legs, journey, currentNodeId, newTransport, rulesVersion);
    }
    return "recovered";
  }

  if (nowMs >= sevenDaysMs) {
    // 7 模拟日未恢复 → PERMANENTLY_LOST（terminal，Recipient 正文仍锁定）
    state.letterStatus = "PERMANENTLY_LOST";
    state.currentLegSequence = null;
    record("PERMANENTLY_LOST", sevenDaysMs, draw().index, currentNodeId, null, {
      anomalyType: wasAnomaly,
    });
    state.anomalyType = null;
    state.anomalyStartedAtMs = null;
    state.anomalyResolvedAtMs = null;
    state.anyStateChanged = true;
    return "lost";
  }

  return "noop";
}

/** 恢复后按新 transport 重建全部 remaining legs（从当前稳定节点 → destination）。
 * PIGEON → direct 单段；ground → Dijkstra；ground→ground 也按 allowedTransport 重规划。 */
function rebuildRemainingForTransport(
  state: AdvanceState,
  legs: TransportLeg[],
  journey: Journey,
  currentNodeId: string,
  newTransport: TransportType,
  rulesVersion: string
): void {
  if (currentNodeId === journey.destinationNodeId) return; // 已到终点
  const route = planRouteExcluding({
    graphVersion: journey.graphVersion,
    originNodeId: currentNodeId,
    destinationNodeId: journey.destinationNodeId,
    transportType: newTransport,
  });
  // 保留 completed legs，删除后续全部 remaining
  const startSequence = completedCount(legs);
  rebuildRemaining(state, legs, journey, startSequence, route, rulesVersion);
}

/** 重建 remaining legs：删除 sequence >= startSequence 的旧 legs，插入新 legs（completed 永久保留）。 */
function rebuildRemaining(
  state: AdvanceState,
  legs: TransportLeg[],
  journey: Journey,
  startSequence: number,
  route: {
    edges: Array<{ from: string; to: string; transportType: TransportType; distanceKm: number }>;
  },
  rulesVersion: string
): void {
  const kept = legs.filter((l) => l.sequence < startSequence);
  const rebuilt = route.edges.map((edge, index) => ({
    sequence: startSequence + index,
    fromNodeId: edge.from,
    toNodeId: edge.to,
    transportType: edge.transportType,
    distanceKm: edge.distanceKm,
    plannedDurationSeconds: Math.round(
      (edge.distanceKm / speedKmPerDay(rulesVersion, edge.transportType)) * SECONDS_PER_DAY
    ),
  }));

  // 整个事务内维护最早重建边界（连续 reroute 取 min，persist 从最早边界完整替换，避免断链）
  state.earliestRebuiltFromSequence =
    state.earliestRebuiltFromSequence === null
      ? startSequence
      : Math.min(state.earliestRebuiltFromSequence, startSequence);
  state.currentLegSequence = null;
  state.anyStateChanged = true;

  // 替换内存 legs（推进循环继续消费剩余模拟时间；新 legs 用事务内全局唯一负 id，persist 跳过其 update）
  const finalLegs: TransportLeg[] = [];
  for (const keptLeg of kept) {
    finalLegs.push(keptLeg);
  }
  for (const r of rebuilt) {
    finalLegs.push({
      id: state.nextTempLegId,
      journeyId: journey.id,
      sequence: r.sequence,
      fromNodeId: r.fromNodeId,
      toNodeId: r.toNodeId,
      transportType: r.transportType,
      distanceKm: r.distanceKm,
      plannedDurationSeconds: r.plannedDurationSeconds,
      status: "PLANNED",
      startedAtSim: null,
      completedAtSim: null,
      primaryEventIndex: null,
      primaryEventOutcome: null,
      delaySeconds: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as TransportLeg);
    state.nextTempLegId -= BigInt(1); // 全局递减，绝不从 -1 重置
  }
  legs.length = 0;
  for (const l of finalLegs) {
    legs.push(l);
  }
}

function completedCount(legs: TransportLeg[]): number {
  let n = 0;
  for (const l of legs) {
    if (l.status === LEG_COMPLETED) n += 1;
  }
  return n;
}

function pushLegChange(
  state: AdvanceState,
  id: bigint,
  status?: TransportLegStatus,
  startedAtSim?: Date,
  completedAtSim?: Date,
  primaryEventIndex?: number,
  primaryEventOutcome?: string,
  delaySeconds?: number
): void {
  state.changes.push({
    id,
    status,
    startedAtSim,
    completedAtSim,
    primaryEventIndex,
    primaryEventOutcome,
    delaySeconds,
  });
  state.anyStateChanged = true;
}

function patchEventPayload(
  state: AdvanceState,
  eventIndex: number | undefined,
  extra: Record<string, unknown>
): void {
  if (eventIndex === undefined) return;
  for (let i = state.worldEvents.length - 1; i >= 0; i -= 1) {
    const event = state.worldEvents[i];
    if (event && event.eventIndex === eventIndex) {
      const base =
        event.payload !== undefined && typeof event.payload === "object"
          ? (event.payload as Record<string, unknown>)
          : {};
      event.payload = { ...base, ...extra } as Prisma.InputJsonValue;
      return;
    }
  }
}

/** 原子写库（事务 commit 一次性生效）。 */
async function persistAdvance(
  tx: Prisma.TransactionClient,
  journey: Journey,
  lockedLetter: Letter,
  state: AdvanceState,
  nowMs: number
): Promise<void> {
  for (const change of state.changes) {
    if (change.id <= MAX_NEW_LEG_ID) continue; // 新重建 legs（负 id）由 createMany 落库
    const data: Prisma.TransportLegUpdateInput = {};
    if (change.status !== undefined) data.status = change.status;
    if (change.startedAtSim !== undefined) data.startedAtSim = change.startedAtSim;
    if (change.completedAtSim !== undefined) data.completedAtSim = change.completedAtSim;
    if (change.primaryEventIndex !== undefined) data.primaryEventIndex = change.primaryEventIndex;
    if (change.primaryEventOutcome !== undefined)
      data.primaryEventOutcome = change.primaryEventOutcome;
    if (change.delaySeconds !== undefined) data.delaySeconds = change.delaySeconds;
    await tx.transportLeg.update({ where: { id: change.id }, data });
  }
  // 重建 remaining legs：从整个事务内**最早**重建边界完整替换（连续 reroute 取 min，
  // 避免只删最后一次边界导致旧路线残留 / 路径断链）；用内存最终状态落库
  if (state.earliestRebuiltFromSequence !== null) {
    await tx.transportLeg.deleteMany({
      where: {
        journeyId: journey.id,
        sequence: { gte: state.earliestRebuiltFromSequence },
      },
    });
    const newLegs = state.finalLegs.filter(
      (l) => l.sequence >= (state.earliestRebuiltFromSequence ?? 0)
    );
    if (newLegs.length > 0) {
      await tx.transportLeg.createMany({
        data: newLegs.map((leg) => ({
          journeyId: journey.id,
          sequence: leg.sequence,
          fromNodeId: leg.fromNodeId,
          toNodeId: leg.toNodeId,
          transportType: leg.transportType,
          distanceKm: leg.distanceKm,
          plannedDurationSeconds: leg.plannedDurationSeconds,
          status: leg.status,
          startedAtSim: leg.startedAtSim,
          completedAtSim: leg.completedAtSim,
          primaryEventIndex: leg.primaryEventIndex,
          primaryEventOutcome: leg.primaryEventOutcome,
          delaySeconds: leg.delaySeconds ?? 0,
        })),
      });
    }
  }
  if (state.worldEvents.length > 0) {
    await tx.worldEvent.createMany({
      data: state.worldEvents.map((event) => ({
        journeyId: journey.id,
        eventIndex: event.eventIndex,
        eventType: event.eventType,
        occurredAtSim: new Date(event.occurredAtMs),
        nodeId: event.nodeId,
        transportLegSequence: event.transportLegSequence,
        payload: event.payload ?? Prisma.JsonNull,
      })),
    });
  }
  const journeyData: Prisma.JourneyUpdateInput = {
    status: state.journeyStatus,
    startedAtSim: state.journeyStartedAt,
    completedAtSim: state.journeyCompletedAt,
    lastAdvancedAtSim: new Date(nowMs),
    currentLegSequence: state.currentLegSequence,
    nextEventIndex: state.eventIndex,
    anomalyType: state.anomalyType,
    anomalyStartedAtSim:
      state.anomalyStartedAtMs !== null ? new Date(state.anomalyStartedAtMs) : null,
    anomalyResolvedAtSim:
      state.anomalyResolvedAtMs !== null ? new Date(state.anomalyResolvedAtMs) : null,
    resumeAtSim: state.recoveryResumeMs !== null ? new Date(state.recoveryResumeMs) : null,
    lastMileReadyAtSim: state.lastMileReadyAtMs !== null ? new Date(state.lastMileReadyAtMs) : null,
  };
  if (state.earliestRebuiltFromSequence !== null) {
    // totalDistanceKm = sum(最终有效 legs)（与持久化后 legs 严格一致）
    journeyData.totalDistanceKm = state.finalLegs.reduce((acc, l) => acc + l.distanceKm, 0);
  }
  await tx.journey.update({ where: { id: journey.id }, data: journeyData });
  const letterData: Prisma.LetterUpdateInput = {
    status: state.letterStatus,
    ...(state.letterTransport !== lockedLetter.currentTransport
      ? { currentTransport: state.letterTransport }
      : {}),
    ...(state.deliveredAtMs !== null ? { deliveredAt: new Date(state.deliveredAtMs) } : {}),
  };
  await tx.letter.update({ where: { id: lockedLetter.id }, data: letterData });
}
