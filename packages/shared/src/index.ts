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
