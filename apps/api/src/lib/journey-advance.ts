/**
 * Phase 5 核心服务：Journey 正常运输推进（Simulation Core + Transport Progression）。
 *
 * 语义契约：
 * - 使用 SimulationClock（禁止业务直接 Date.now()），推进规则按 **Journey 冻结的 rulesVersion**
 *   （Phase 4 不变量：Journey 创建时继承 Letter 冻结值；推进阶段以 Journey 为权威，
 *   不再依赖 Letter 当前字段；未知版本抛 UnknownRulesVersionError，不得 fallback latest）。
 * - 一次 advance 可跨多个 Leg：模拟时间结余必须传递（Leg 的 completedAtSim 是理论完成时刻，
 *   不是 now；剩余时间继续推进后续 Leg）。
 * - completedPath 由 Leg 状态确定性派生（journey.ts toPathViews），Leg 只能
 *   PLANNED → ACTIVE → COMPLETED 单向推进，故 completedPath 只增、remainingPath 只减。
 * - 最后一个 Leg COMPLETED（到达目标站）≠ DELIVERED：必须经过 OUT_FOR_DELIVERY →
 *   再经过冻结的 LAST_MILE_DURATION_SECONDS → DELIVERED。
 * - 幂等 / 时间倒退：now <= lastAdvancedAtSim 时 no-op（不重放、不倒退）。
 * - 并发：事务内 `SELECT ... FOR UPDATE` 锁 Journey 行 + 锁后重读，两个并发 advance
 *   最终至多一个 changed，不会重复完成 Leg / 双 ACTIVE / 500。
 */
import type { JourneyStatus, PrismaClient, TransportLegStatus } from "@yishu/db";
import type { SimulationClock } from "@yishu/simulation";
import { LAST_MILE_DURATION_SECONDS, speedKmPerDay, type LetterStatus } from "@yishu/shared";

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
  /** 本次推进是否产生了任何状态变化；false = no-op（终态 / 重复 / 时间倒退）。 */
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

/** Leg 状态机允许的推进顺序：PLANNED → ACTIVE → COMPLETED。 */
const LEG_ACTIVE: TransportLegStatus = "ACTIVE";
const LEG_COMPLETED: TransportLegStatus = "COMPLETED";

interface LegChange {
  id: bigint;
  status: TransportLegStatus;
  startedAtSim?: Date;
  completedAtSim?: Date;
}

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

  // 事务外快速路径（终态 no-op 避免无谓事务；权威判断在锁后重读）
  const letter = await prisma.letter.findUnique({ where: { id: letterId } });
  if (!letter) throw new LetterNotFoundError(letterId);
  if (TERMINAL_LETTER_STATUSES.has(letter.status)) {
    const j = await prisma.journey.findUnique({ where: { letterId } });
    return {
      changed: false,
      letterStatus: letter.status,
      journeyStatus: j?.status ?? "PLANNED",
      currentLegSequence: j?.currentLegSequence ?? null,
    };
  }
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

    if (TERMINAL_LETTER_STATUSES.has(lockedLetter.status)) {
      return {
        changed: false,
        letterStatus: lockedLetter.status,
        journeyStatus: lockedJourney.status,
        currentLegSequence: lockedJourney.currentLegSequence,
      };
    }

    // 冻结规则权威：Journey.rulesVersion（不是 Letter）。未知版本明确失败（不静默 fallback
    // latest / CURRENT_RULES_VERSION）。抛错发生在任何写库之前 → 整个事务回滚，无部分状态写入。
    const rulesVersion = lockedJourney.rulesVersion;
    for (const leg of legs) {
      speedKmPerDay(rulesVersion, leg.transportType);
    }
    // 零 Leg（同站点 PIGEON，仅 PIGEON 可达零 Leg）：仍须校验 Journey 冻结版本已知。
    if (legs.length === 0) {
      speedKmPerDay(rulesVersion, "PIGEON");
    }

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

    let letterStatus: LetterStatus = lockedLetter.status;
    let journeyStatus: JourneyStatus = lockedJourney.status;
    let journeyStartedAt: Date | null = lockedJourney.startedAtSim;
    let journeyCompletedAt: Date | null = lockedJourney.completedAtSim;
    let currentLegSequence: number | null = lockedJourney.currentLegSequence;
    let deliveredAtSim: Date | null = null;
    const changes: LegChange[] = [];
    let anyLegChanged = false;

    // 找到第一个未完成 Leg（cursor）；其前为已 COMPLETED 的历史 Leg
    let cursor = 0;
    while (cursor < legs.length && legs[cursor]?.status === LEG_COMPLETED) cursor += 1;

    if (legs.length === 0) {
      // 零 Leg（同站点 PIGEON，Phase 4 已支持）：起点即终点，视为立即到达目标站
      journeyStatus = "COMPLETED";
      journeyStartedAt ??= new Date(nowMs);
      journeyCompletedAt ??= new Date(nowMs);
      anyLegChanged = true;
    } else if (cursor < legs.length) {
      // 起点时刻：优先沿用当前 ACTIVE Leg 的 startedAtSim；否则接续前一 Leg 的完成时刻
      //（首次推进 lastAdvancedAtSim 为 null 时以本次 now 为运输起始基准）。
      const firstPending = legs[cursor];
      const firstPendingStartedMs = firstPending?.startedAtSim?.getTime() ?? null;
      let segmentStartMs: number;
      if (firstPendingStartedMs !== null) {
        segmentStartMs = firstPendingStartedMs;
      } else {
        const prevEndMs = cursor > 0 ? (legs[cursor - 1]?.completedAtSim?.getTime() ?? null) : null;
        segmentStartMs = prevEndMs ?? lastAdvancedMs ?? nowMs;
      }

      for (let i = cursor; i < legs.length; i += 1) {
        const leg = legs[i];
        if (!leg || leg.status === LEG_COMPLETED) continue;
        const legStartMs = leg.startedAtSim?.getTime() ?? segmentStartMs;
        const legEndMs = legStartMs + leg.plannedDurationSeconds * 1000;
        const completed = nowMs >= legEndMs;
        const nextStatus = completed ? LEG_COMPLETED : LEG_ACTIVE;
        const nextStartedAt = leg.startedAtSim === null ? new Date(legStartMs) : undefined;
        const nextCompletedAt = completed ? new Date(legEndMs) : undefined;

        if (
          nextStatus !== leg.status ||
          nextStartedAt !== undefined ||
          nextCompletedAt !== undefined
        ) {
          changes.push({
            id: leg.id,
            status: nextStatus,
            startedAtSim: nextStartedAt,
            completedAtSim: nextCompletedAt,
          });
          anyLegChanged = true;
        }

        // 状态提升：激活第一个 Leg → Letter DISPATCHED → IN_TRANSIT，Journey PLANNED → IN_PROGRESS
        if (letterStatus === "DISPATCHED") letterStatus = "IN_TRANSIT";
        if (journeyStatus === "PLANNED") journeyStatus = "IN_PROGRESS";
        if (journeyStartedAt === null) journeyStartedAt = new Date(legStartMs);

        if (completed) {
          journeyCompletedAt = new Date(legEndMs);
          currentLegSequence = i + 1 < legs.length ? (legs[i + 1]?.sequence ?? null) : null;
          segmentStartMs = legEndMs; // 模拟时间结余传递到后续 Leg
        } else {
          currentLegSequence = leg.sequence; // 停留在当前 ACTIVE Leg
          break;
        }
      }
    }

    // last-mile（独立于 cursor，即使前次推进已把全部 Leg 完成仍须执行）：
    // 到达目标站 → OUT_FOR_DELIVERY；再经过冻结 last-mile 时长 → DELIVERED（deliveredAt 只设置一次）
    const transportComplete =
      legs.length === 0 ||
      legs.every(
        (l) =>
          l.status === LEG_COMPLETED ||
          changes.some((c) => c.id === l.id && c.status === LEG_COMPLETED)
      );
    if (transportComplete && journeyCompletedAt !== null && letterStatus !== "DELIVERED") {
      journeyStatus = "COMPLETED";
      const deliveredAtMs = journeyCompletedAt.getTime() + LAST_MILE_DURATION_SECONDS * 1000;
      letterStatus = nowMs >= deliveredAtMs ? "DELIVERED" : "OUT_FOR_DELIVERY";
      if (letterStatus === "DELIVERED") deliveredAtSim = new Date(deliveredAtMs);
    }

    const changed =
      anyLegChanged ||
      journeyStartedAt !== lockedJourney.startedAtSim ||
      journeyCompletedAt !== lockedJourney.completedAtSim ||
      journeyStatus !== lockedJourney.status ||
      letterStatus !== lockedLetter.status;

    // 原子写库（事务 commit 一次性生效）
    for (const change of changes) {
      await tx.transportLeg.update({
        where: { id: change.id },
        data: {
          status: change.status,
          startedAtSim: change.startedAtSim,
          completedAtSim: change.completedAtSim,
        },
      });
    }
    await tx.journey.update({
      where: { id: journey.id },
      data: {
        status: journeyStatus,
        startedAtSim: journeyStartedAt,
        completedAtSim: journeyCompletedAt,
        lastAdvancedAtSim: new Date(nowMs),
        currentLegSequence,
      },
    });
    await tx.letter.update({
      where: { id: letterId },
      data: {
        status: letterStatus,
        ...(deliveredAtSim !== null ? { deliveredAt: deliveredAtSim } : {}),
      },
    });

    return {
      changed,
      letterStatus,
      journeyStatus,
      currentLegSequence,
    };
  });
}
