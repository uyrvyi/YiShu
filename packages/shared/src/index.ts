/**
 * 驿书 V1 共享基础设施与业务常量（前后端共用）。
 */

/** API 统一前缀（对应开发规范 §71）。 */
export const API_PREFIX = "/api/v1";

/** 运输方式（对应开发规范 §13）。 */
export const TRANSPORT_TYPES = ["HAND_CARRY", "HORSE_RELAY", "EXPRESS_RELAY", "PIGEON"] as const;
export type TransportType = (typeof TRANSPORT_TYPES)[number];

/** Letter 状态（对应开发规范 §37）。 */
export const LETTER_STATUSES = [
  "CREATED",
  "DISPATCHED",
  "IN_TRANSIT",
  "AT_STATION",
  "TRANSFER",
  "DELAYED",
  "COURIER_MISSING",
  "LETTER_DROPPED",
  "LETTER_MISSING",
  "RECOVERED",
  "TRANSPORT_CHANGED",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "PERMANENTLY_LOST",
  "DESTROYED",
] as const;
export type LetterStatus = (typeof LETTER_STATUSES)[number];

/** 收件人阅读状态（对应开发规范 §42）。 */
export const RECIPIENT_READ_STATES = ["UNOPENED", "OPENED"] as const;
export type RecipientReadState = (typeof RECIPIENT_READ_STATES)[number];

/** Journey 状态（Phase 4 仅规划，最小状态集；后续 Phase 可扩展）。 */
export const JOURNEY_STATUSES = ["PLANNED", "IN_PROGRESS", "COMPLETED", "CANCELLED"] as const;
export type JourneyStatus = (typeof JOURNEY_STATUSES)[number];

/** TransportLeg 状态（Phase 4 仅规划；Phase 5 引入 ACTIVE 正常推进）。 */
export const TRANSPORT_LEG_STATUSES = ["PLANNED", "ACTIVE", "COMPLETED", "CANCELLED"] as const;
export type TransportLegStatus = (typeof TRANSPORT_LEG_STATUSES)[number];

/**
 * 规则版本（对应开发规范 §63：rulesVersion="1.0"）。
 * 速度 / 时长换算必须按 rulesVersion 选择，未知版本明确拒绝（Phase 4 Final Gate BLOCKER）。
 */
export const RULES_VERSIONS = ["1.0"] as const;
export type RulesVersion = (typeof RULES_VERSIONS)[number];

/**
 * 运输速度（km/天，对应开发规范 §13）。
 * 冻结值，禁止业务代码散落魔法数字。
 * PIGEON 按规范 §13.4：60 km/h × 每天最多飞行 8 小时 ≈ 480 km/day。
 */
export const TRANSPORT_SPEEDS_KM_PER_DAY: Record<TransportType, number> = {
  HAND_CARRY: 35,
  HORSE_RELAY: 120,
  EXPRESS_RELAY: 300,
  PIGEON: 480,
};

/** 按规则版本索引的速度表（单一来源；新增版本必须在此显式登记，否则视为未知版本）。 */
export const TRANSPORT_SPEEDS_BY_RULES_VERSION: Record<
  RulesVersion,
  Record<TransportType, number>
> = {
  "1.0": TRANSPORT_SPEEDS_KM_PER_DAY,
};

/** 未知规则版本（冻结版本语义：必须显式拒绝，不得静默 fallback）。 */
export class UnknownRulesVersionError extends Error {
  constructor(public readonly rulesVersion: string) {
    super(`unknown_rules_version: ${rulesVersion}`);
    this.name = "UnknownRulesVersionError";
  }
}

/** 秒 / 天，用于 "运输方式速度 → 天数 → 时长" 的换算。 */
export const SECONDS_PER_DAY = 86400;

/**
 * 最后一段送达时长（秒，Phase 5：最小确定性 last-mile 方案）。
 * 最后一个 TransportLeg COMPLETED（到达目标站）≠ Letter DELIVERED；
 * 必须经过 OUT_FOR_DELIVERY（到达目标站）→ 再过本冻结时长 → DELIVERED。
 * 冻结常量，内部 Simulation 输入，用户 API / Mobile 严禁暴露 ETA / 倒计时（规范 §18/§45）。
 */
export const LAST_MILE_DURATION_SECONDS = 6 * 3600;

/**
 * 按规则版本取运输速度（km/天）。
 * @throws UnknownRulesVersionError 版本未登记
 */
export function speedKmPerDay(rulesVersion: string, transportType: TransportType): number {
  const speeds = TRANSPORT_SPEEDS_BY_RULES_VERSION[rulesVersion as RulesVersion];
  if (!speeds) throw new UnknownRulesVersionError(rulesVersion);
  return speeds[transportType];
}

/**
 * 根据规则版本、运输方式与距离（km）计算内部规划时长（秒，对应开发规范 §18）。
 * 这是 Simulation 内部输入，用户 API / Mobile UI 严禁暴露 ETA / 预计到达。
 * @throws UnknownRulesVersionError 版本未登记
 */
export function plannedDurationSeconds(
  rulesVersion: string,
  transportType: TransportType,
  distanceKm: number
): number {
  const speed = speedKmPerDay(rulesVersion, transportType);
  if (speed <= 0) return 0;
  return Math.round((distanceKm / speed) * SECONDS_PER_DAY);
}

// ============================================================================
// Phase 6：随机事件基础设施（World Truth）
// 概率全部冻结在此（开发规范 §27–§36），禁止业务代码散落魔法数字。
// 事件判定统一：simulationSeed + eventIndex（Phase 5 DeterministicRandom）。
// ============================================================================

/** 一级运输事件类型（按开发规范 §28–§31 概率项；多个近义项可映射同一处理动作）。 */
export const TRANSPORT_EVENT_TYPES = [
  "NORMAL",
  "DELAY", // 延误
  "REROUTE", // 改变路线 / 临时改道
  "LOST_PATH", // 迷路（HAND_CARRY）
  "ROBBERY", // 遭遇抢劫
  "COURIER_MISSING", // 信使失联 / 飞鸽失联
  "LETTER_DROPPED", // 信件掉落
  "SERIOUS_ACCIDENT", // 严重事故
  "OTHER", // 其他普通异常（HORSE/EXPRESS）
  "DEVIATION", // 偏航（PIGEON）
  "TEMPORARY_STOP", // 临时停留（PIGEON）
  "LOST", // 迷路（PIGEON）
] as const;
export type TransportEventType = (typeof TRANSPORT_EVENT_TYPES)[number];

/** 带权结果（用于确定性抽样）。 */
export interface WeightedOutcome<T extends string> {
  outcome: T;
  weight: number;
}

/** 托人捎信事件概率（开发规范 §28）。 */
export const HAND_CARRY_EVENT_TABLE: readonly WeightedOutcome<TransportEventType>[] = [
  { outcome: "NORMAL", weight: 0.84 },
  { outcome: "DELAY", weight: 0.05 },
  { outcome: "REROUTE", weight: 0.04 },
  { outcome: "LOST_PATH", weight: 0.02 },
  { outcome: "ROBBERY", weight: 0.02 },
  { outcome: "COURIER_MISSING", weight: 0.015 },
  { outcome: "LETTER_DROPPED", weight: 0.01 },
  { outcome: "SERIOUS_ACCIDENT", weight: 0.005 },
] as const;

/** 驿马事件概率（开发规范 §29）。 */
export const HORSE_RELAY_EVENT_TABLE: readonly WeightedOutcome<TransportEventType>[] = [
  { outcome: "NORMAL", weight: 0.94 },
  { outcome: "DELAY", weight: 0.02 },
  { outcome: "REROUTE", weight: 0.01 },
  { outcome: "COURIER_MISSING", weight: 0.008 },
  { outcome: "ROBBERY", weight: 0.008 },
  { outcome: "LETTER_DROPPED", weight: 0.003 },
  { outcome: "SERIOUS_ACCIDENT", weight: 0.001 },
  { outcome: "OTHER", weight: 0.01 },
] as const;

/** 加急驿递事件概率（开发规范 §30）。 */
export const EXPRESS_RELAY_EVENT_TABLE: readonly WeightedOutcome<TransportEventType>[] = [
  { outcome: "NORMAL", weight: 0.96 },
  { outcome: "DELAY", weight: 0.015 },
  { outcome: "REROUTE", weight: 0.008 },
  { outcome: "COURIER_MISSING", weight: 0.005 },
  { outcome: "ROBBERY", weight: 0.005 },
  { outcome: "LETTER_DROPPED", weight: 0.002 },
  { outcome: "SERIOUS_ACCIDENT", weight: 0.001 },
  { outcome: "OTHER", weight: 0.004 },
] as const;

/** 飞鸽事件概率（开发规范 §31）。 */
export const PIGEON_EVENT_TABLE: readonly WeightedOutcome<TransportEventType>[] = [
  { outcome: "NORMAL", weight: 0.92 },
  { outcome: "DEVIATION", weight: 0.03 },
  { outcome: "TEMPORARY_STOP", weight: 0.02 },
  { outcome: "LOST", weight: 0.015 },
  { outcome: "LETTER_DROPPED", weight: 0.005 },
  { outcome: "COURIER_MISSING", weight: 0.007 },
  { outcome: "SERIOUS_ACCIDENT", weight: 0.003 },
] as const;

/** 一级事件概率表：按 rulesVersion + transportType（单一来源，新增版本必须显式登记）。 */
export const TRANSPORT_EVENTS_BY_RULES_VERSION: Record<
  RulesVersion,
  Record<TransportType, readonly WeightedOutcome<TransportEventType>[]>
> = {
  "1.0": {
    HAND_CARRY: HAND_CARRY_EVENT_TABLE,
    HORSE_RELAY: HORSE_RELAY_EVENT_TABLE,
    EXPRESS_RELAY: EXPRESS_RELAY_EVENT_TABLE,
    PIGEON: PIGEON_EVENT_TABLE,
  },
};

/** 取一级事件概率表；未知规则版本明确抛错（不 fallback latest）。 */
export function transportEventTable(
  rulesVersion: string,
  transportType: TransportType
): readonly WeightedOutcome<TransportEventType>[] {
  const byRules = TRANSPORT_EVENTS_BY_RULES_VERSION[rulesVersion as RulesVersion];
  if (!byRules) throw new UnknownRulesVersionError(rulesVersion);
  return byRules[transportType];
}

/** 抢劫二级分支（开发规范 §32）。 */
export const ROBBERY_BRANCHES: readonly WeightedOutcome<RobberyBranch>[] = [
  { outcome: "ESCAPE_DELAY", weight: 0.55 },
  { outcome: "INJURED_CONTINUE", weight: 0.25 },
  { outcome: "MISSING_DROPPED", weight: 0.15 },
  { outcome: "DEAD_DROPPED", weight: 0.05 },
] as const;

export const ROBBERY_BRANCH_NAMES = [
  "ESCAPE_DELAY",
  "INJURED_CONTINUE",
  "MISSING_DROPPED",
  "DEAD_DROPPED",
] as const;
export type RobberyBranch = (typeof ROBBERY_BRANCH_NAMES)[number];

/** 掉落 / 失联恢复窗口（开发规范 §33）。 */
export const DROP_RECOVERY_WINDOWS: readonly WeightedOutcome<DropRecoveryWindow>[] = [
  { outcome: "WITHIN_24H", weight: 0.5 },
  { outcome: "ONE_TO_THREE_DAYS", weight: 0.25 },
  { outcome: "THREE_TO_SEVEN_DAYS", weight: 0.15 },
  { outcome: "NEVER", weight: 0.1 },
] as const;

export const DROP_RECOVERY_WINDOW_NAMES = [
  "WITHIN_24H",
  "ONE_TO_THREE_DAYS",
  "THREE_TO_SEVEN_DAYS",
  "NEVER",
] as const;
export type DropRecoveryWindow = (typeof DROP_RECOVERY_WINDOW_NAMES)[number];

/** 各恢复窗口的持续时间范围（秒，min ≤ 实际 < max；NEVER = 7 模拟日未恢复 → PERMANENTLY_LOST）。 */
export const DROP_RECOVERY_WINDOW_SECONDS: Record<
  DropRecoveryWindow,
  { min: number; max: number } | null
> = {
  WITHIN_24H: { min: 6 * 3600, max: 24 * 3600 },
  ONE_TO_THREE_DAYS: { min: 24 * 3600, max: 72 * 3600 },
  THREE_TO_SEVEN_DAYS: { min: 72 * 3600, max: 168 * 3600 },
  NEVER: null,
};

/** 拾获后处理（开发规范 §34）。 */
export const RECOVERY_HANDLINGS: readonly WeightedOutcome<RecoveryHandling>[] = [
  { outcome: "NEAREST_STATION", weight: 0.7 },
  { outcome: "FINDER_CARRIES", weight: 0.2 },
  { outcome: "SET_ASIDE", weight: 0.1 },
] as const;

export const RECOVERY_HANDLING_NAMES = ["NEAREST_STATION", "FINDER_CARRIES", "SET_ASIDE"] as const;
export type RecoveryHandling = (typeof RECOVERY_HANDLING_NAMES)[number];

/** 恢复后自动运输方式变更倾向（Phase 6 Prompt §7；用户不能控制）。 */
export const RECOVERY_TRANSPORT_CHANGE: Record<
  TransportType,
  readonly WeightedOutcome<TransportType>[]
> = {
  HAND_CARRY: [
    { outcome: "HORSE_RELAY", weight: 0.6 },
    { outcome: "PIGEON", weight: 0.25 },
    { outcome: "HAND_CARRY", weight: 0.15 },
  ],
  HORSE_RELAY: [
    { outcome: "HORSE_RELAY", weight: 0.8 },
    { outcome: "HAND_CARRY", weight: 0.15 },
    { outcome: "PIGEON", weight: 0.05 },
  ],
  EXPRESS_RELAY: [
    { outcome: "EXPRESS_RELAY", weight: 0.8 },
    { outcome: "HAND_CARRY", weight: 0.15 },
    { outcome: "PIGEON", weight: 0.05 },
  ],
  PIGEON: [
    { outcome: "HORSE_RELAY", weight: 0.7 },
    { outcome: "HAND_CARRY", weight: 0.3 },
  ],
};

/** 7 个模拟日未恢复 → PERMANENTLY_LOST（开发规范 §20/§33）。 */
export const PERMANENT_LOSS_SECONDS = 7 * SECONDS_PER_DAY;

/** 延误最大时长（秒，冻结常量；DELAY 时长由确定性 draw 在 [0, max] 内插值）。 */
export const DELAY_MAX_SECONDS = 12 * 3600;

/** 拾获后"暂时搁置"额外延迟（秒，冻结常量）。 */
export const SET_ASIDE_DELAY_SECONDS = 24 * 3600;

/**
 * 确定性抽样：按累计权重选择 outcome（与 DeterministicRandom.draw 配合）。
 * @param draw [0,1) 确定性随机数
 * @param table 冻结权重表（总和应为 1）
 */
export function selectWeightedOutcome<T extends string>(
  draw: number,
  table: readonly WeightedOutcome<T>[]
): T {
  let acc = 0;
  for (const item of table) {
    acc += item.weight;
    if (draw < acc) return item.outcome;
  }
  const last = table[table.length - 1];
  if (!last) throw new Error("selectWeightedOutcome: empty table");
  return last.outcome; // 浮点累计误差兜底：取最后一项
}
