/**
 * 驿书 V1 共享基础设施与业务常量（前后端共用）。
 */

import { z } from "zod";

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

/**
 * 用户可见 Letter 状态（内部状态投影，Phase 7 Gate BLOCKER）。
 *
 * 冻结可见性规则：内部 `LETTER_DROPPED` 完全 HIDDEN——不得经 Letter API / Mobile / Timeline
 * 向用户暴露"信件掉落"。掉落期间用户没有新的可确认运输事实 → 投影为 `IN_TRANSIT`。
 * 其它内部状态（含推进实际不产生的规范状态）按现有冻结用户可见语义 1:1 保留，
 * 禁止使用 `return letter.status` 作为 fallback。
 */
export type PublicLetterStatus = Exclude<LetterStatus, "LETTER_DROPPED">;

/** 统一用户可见状态投影（全局用户可见性规则，不止 Timeline）。 */
export function toPublicLetterStatus(status: LetterStatus): PublicLetterStatus {
  switch (status) {
    case "CREATED":
    case "DISPATCHED":
    case "IN_TRANSIT":
    case "AT_STATION":
    case "TRANSFER":
    case "DELAYED":
    case "COURIER_MISSING":
    case "LETTER_MISSING":
    case "RECOVERED":
    case "TRANSPORT_CHANGED":
    case "OUT_FOR_DELIVERY":
    case "DELIVERED":
    case "PERMANENTLY_LOST":
    case "DESTROYED":
      return status;
    case "LETTER_DROPPED":
      // 掉落完全 HIDDEN：无独立可确认事实 → 保持在途（不映射为 DELAYED/COURIER_MISSING，避免创造用户知识）
      return "IN_TRANSIT";
  }
}

/**
 * 用户可见状态全集（Phase 8：地图 / API 输出契约的运行时来源）。
 *
 * `satisfies` 保证不混入内部 HIDDEN 状态（如 `LETTER_DROPPED`）；
 * 覆盖完整性（无遗漏）由 API 测试比对 `PublicLetterStatus` 校验。
 */
export const PUBLIC_LETTER_STATUSES = [
  "CREATED",
  "DISPATCHED",
  "IN_TRANSIT",
  "AT_STATION",
  "TRANSFER",
  "DELAYED",
  "COURIER_MISSING",
  "LETTER_MISSING",
  "RECOVERED",
  "TRANSPORT_CHANGED",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "PERMANENTLY_LOST",
  "DESTROYED",
] as const satisfies readonly PublicLetterStatus[];

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

// ---------------------------------------------------------------------------
// Phase 7 — Timeline + 用户可见运输事实（开发规范 §39 / §40 / §57 / §75）
// ---------------------------------------------------------------------------

/**
 * TimelineEvent 用户可见事件类型（对应开发规范 §57）。
 *
 * 命名一律表达"用户已确认的事实"（已寄出 / 到达 / 延误 / 失联 / 拾获 / 改方式 / 派送中 / 送达 / 遗失 / 损毁），
 * **不存在** ROBBERY / SERIOUS_ACCIDENT 等上帝视角类型（规范 §39/§40）。
 */
export const TIMELINE_EVENT_TYPES = [
  "DISPATCHED",
  "DEPARTED_STATION",
  "ARRIVED_STATION",
  "TRANSPORT_DELAYED",
  "COURIER_MISSING",
  "LETTER_RECOVERED",
  "TRANSPORT_CHANGED",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "PERMANENTLY_LOST",
  "DESTROYED",
] as const;
export type TimelineEventType = (typeof TIMELINE_EVENT_TYPES)[number];

/**
 * visibility 策略（阶段规划 Phase 7：immediate / delayed / hidden）。
 *
 * - IMMEDIATE：事件发生后即成为用户可确认事实。
 * - DELAYED：WorldEvent 已真实发生，但用户直到 visibleAt 才可确认（禁止提前下发再靠前端隐藏）。
 * - HIDDEN：只存在于 World Truth，永不产生任何用户可见 Timeline 信息（也不得用 placeholder/count 暗示其存在）。
 */
export const TIMELINE_VISIBILITY_POLICIES = ["IMMEDIATE", "DELAYED", "HIDDEN"] as const;
export type TimelineVisibilityPolicy = (typeof TIMELINE_VISIBILITY_POLICIES)[number];

/**
 * 用户可见事实重要度（对应开发规范 §21 既定事实节点优先级，数值越大越重要）：
 * 1. 运输方式改变 2. 信件被找回 3. 信使失联 4. 重要驿站 5. 普通驿站。
 *
 * Phase 8 冻结（项目负责人 2026-09-13）：`LETTER_DROPPED` 完全 HIDDEN，
 * 「信件掉落」不再是用户可见事实类型，也不参与本优先级表。
 * 规范未列出优先级的类型（寄出 / 派送 / 延误 / 终态）取工程中性值：终态 3，其余 2。
 */
export const TIMELINE_IMPORTANCE: Record<TimelineEventType, number> = {
  TRANSPORT_CHANGED: 6,
  LETTER_RECOVERED: 4,
  COURIER_MISSING: 3,
  DELIVERED: 3,
  PERMANENTLY_LOST: 3,
  DESTROYED: 3,
  DISPATCHED: 2,
  OUT_FOR_DELIVERY: 2,
  TRANSPORT_DELAYED: 2,
  DEPARTED_STATION: 1,
  ARRIVED_STATION: 1,
};

/**
 * WorldEvent 类型键（与 Prisma `WorldEventType` 枚举保持一致；本包不依赖 Prisma）。
 * 仅用于声明 World Truth → User Fact 的冻结映射，不作为用户可见类型。
 */
export type WorldEventTypeKey =
  | "DELAYED"
  | "REROUTED"
  | "ROBBERY"
  | "COURIER_MISSING"
  | "LOST_PATH"
  | "LETTER_DROPPED"
  | "SERIOUS_ACCIDENT"
  | "RECOVERED"
  | "TRANSPORT_CHANGED"
  | "PERMANENTLY_LOST"
  | "DESTROYED";

export interface WorldEventVisibilityRule {
  policy: TimelineVisibilityPolicy;
  /** 该 WorldEvent 对应的用户可见事实类型；HIDDEN 策略下为 null（永不产生 TimelineEvent）。 */
  timelineType: TimelineEventType | null;
}

/**
 * World Truth → User Fact **冻结映射**（项目负责人 2026-09-08 明确冻结，禁止再自行推导）。
 *
 * 直接可见事实（IMMEDIATE）：
 * - DELAYED → TRANSPORT_DELAYED
 * - COURIER_MISSING → COURIER_MISSING
 * - RECOVERED → LETTER_RECOVERED
 * - TRANSPORT_CHANGED → TRANSPORT_CHANGED
 *
 * 后台原因（HIDDEN，不得直接生成 TimelineEvent）：
 * - ROBBERY / REROUTED / LOST_PATH / LETTER_DROPPED / SERIOUS_ACCIDENT
 *
 * 终态（WorldEvent 本身不泄漏 cause chain，但 Letter/Journey 进入明确 terminal 时
 * 可产生用户确认结果）：
 * - PERMANENTLY_LOST → "已确认永久遗失"
 * - DESTROYED → "信件已损毁"
 * 二者不得说明 robbery / serious accident / courier death / branch / recovery roll。
 */
export const WORLD_EVENT_VISIBILITY: Record<WorldEventTypeKey, WorldEventVisibilityRule> = {
  DELAYED: { policy: "IMMEDIATE", timelineType: "TRANSPORT_DELAYED" },
  COURIER_MISSING: { policy: "IMMEDIATE", timelineType: "COURIER_MISSING" },
  RECOVERED: { policy: "IMMEDIATE", timelineType: "LETTER_RECOVERED" },
  TRANSPORT_CHANGED: { policy: "IMMEDIATE", timelineType: "TRANSPORT_CHANGED" },
  ROBBERY: { policy: "HIDDEN", timelineType: null },
  REROUTED: { policy: "HIDDEN", timelineType: null },
  LOST_PATH: { policy: "HIDDEN", timelineType: null },
  LETTER_DROPPED: { policy: "HIDDEN", timelineType: null },
  SERIOUS_ACCIDENT: { policy: "HIDDEN", timelineType: null },
  PERMANENTLY_LOST: { policy: "HIDDEN", timelineType: null },
  DESTROYED: { policy: "HIDDEN", timelineType: null },
};

// ---------------------------------------------------------------------------
// Phase 8 — Local Map + Journey Visualization（开发规范 §14–§19 / §74）
// ---------------------------------------------------------------------------

/**
 * 地图固定 viewBox（开发规范 §17：`viewBox="0 0 1000 800"`，不随设备变化）。
 *
 * 站点 `mapX/mapY` 位于自身坐标系（见 `MAP_FIT`），渲染时统一经 `MAP_FIT` 映射到本 viewBox。
 */
export const MAP_VIEWBOX = { width: 1000, height: 800 } as const;

/** 地图边距（viewBox 单位），供 `computeMapFit` 使用。 */
export const MAP_FIT_MARGIN = 60;

/** `mapX/mapY` 坐标系中的边界（导出给测试校验与 generator 复算）。 */
export interface MapDataBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** `mapX/mapY` → 固定 viewBox 的确定性仿射映射：`X = x * scale + tx`，`Y = y * scale + ty`。 */
export interface MapFit {
  scale: number;
  tx: number;
  ty: number;
}

/**
 * 地图数据边界（**fit 范围**）：行政边界底图 ∪ 站点锚点在 `mapX/mapY` 坐标系中的范围。
 *
 * Phase 8 Gate M5 起，地图几何包含**真实行政边界**（vendored geoBoundaries CHN ADM1），
 * 其范围严格大于站点锚点范围（中国西/北边缘没有 station）。为保证底图与路线处于同一
 * 坐标系且全部落在固定 viewBox 内，fit 以「边界 ∪ 站点」范围推导（向外取整到 0.1）。
 *
 * 数据即契约：`data/maps/china-districts.json` 记录同一 `bounds`，生成器与本常量逐字段断言
 * （数据变更必须同步此处）；测试另行断言全部 294 个 station 锚点落在本范围内。
 */
export const MAP_DATA_BOUNDS: MapDataBounds = {
  minX: 704.4,
  maxX: 874.3,
  minY: 161.9,
  maxY: 319.3,
};

/**
 * 由数据边界推导 `mapX/mapY` → viewBox 的等比居中映射（唯一公式来源）。
 *
 * ```text
 * scale = min((1000 - 2*margin) / (maxX - minX), (800 - 2*margin) / (maxY - minY))
 * tx    = margin + (1000 - 2*margin - (maxX - minX) * scale) / 2 - minX * scale
 * ty    = margin + (800  - 2*margin - (maxY - minY) * scale) / 2 - minY * scale
 * ```
 * `data/gen_map.cjs`（生成静态资产）与 Mobile 渲染共用同一公式，避免常量漂移。
 */
export function computeMapFit(bounds: MapDataBounds, margin: number = MAP_FIT_MARGIN): MapFit {
  const spanX = bounds.maxX - bounds.minX;
  const spanY = bounds.maxY - bounds.minY;
  if (!(spanX > 0) || !(spanY > 0)) {
    throw new Error("computeMapFit: invalid bounds (span must be > 0)");
  }
  const scale = Math.min(
    (MAP_VIEWBOX.width - 2 * margin) / spanX,
    (MAP_VIEWBOX.height - 2 * margin) / spanY
  );
  const tx = margin + (MAP_VIEWBOX.width - 2 * margin - spanX * scale) / 2 - bounds.minX * scale;
  const ty = margin + (MAP_VIEWBOX.height - 2 * margin - spanY * scale) / 2 - bounds.minY * scale;
  return { scale, tx, ty };
}

/** 冻结的地图映射（由 `MAP_DATA_BOUNDS` 导出；Mobile 渲染 DTO 坐标时使用）。 */
export const MAP_FIT: MapFit = computeMapFit(MAP_DATA_BOUNDS, MAP_FIT_MARGIN);

/**
 * 经纬度 → 地图坐标系（`mapX/mapY`）的 canonical 投影（Phase 4 冻结公式）。
 *
 * ```text
 * mapX = round1(((lng + 180) / 360) * 1000)
 * mapY = round1(((90 - lat) / 180) * 800)
 * ```
 *
 * 与生成期 helper `data/map_projection.cjs`（被 `gen_graph.cjs` 与 `gen_map.cjs` 共用）是**同一公式**；
 * 该 CJS 模块无法被打包进 API，故这里提供运行时镜像，并由测试逐 station 断言两者一致。
 *
 * ⚠️ 用途仅限「显示修正」（`data/maps/station-display-corrections.json`）的坐标投影：
 * **不得**用它改写冻结的 `station_nodes.json`，也不得影响路由、距离与任何世界真相（World Truth）。
 */
export function projectLngLatToMapPoint(lng: number, lat: number): MapPoint {
  const round1 = (value: number): number => Math.round(value * 10) / 10;
  return {
    x: round1(((lng + 180) / 360) * MAP_VIEWBOX.width),
    y: round1(((90 - lat) / 180) * MAP_VIEWBOX.height),
  };
}

/**
 * 地图事实节点上限（阶段规划 Phase 8：最多展示最新 5 个高优先事实）。
 *
 * 优先级直接复用 `TIMELINE_IMPORTANCE`（§21 冻结优先级：运输方式改变 > 找回 > 失联 > 重要驿站 > 普通驿站）。
 */
export const MAP_FACT_LIMIT = 5;

/**
 * 「当前大概位置」最大推进比例（工程取值，防越界/防"已到达"错觉）。
 *
 * 只用于把已确认出发时刻到 now 的经过时间映射到区间内部；**不对外输出 ETA / 剩余时间**。
 * 上限 < 1：位置永远停在区间内侧，不到达下一站（到达必须由用户可见 ARRIVED_STATION 事实确认）。
 */
export const MAP_APPROXIMATE_MAX_RATIO = 0.9;

/** 地图渲染坐标（viewBox 内；来自 `StationNode.mapX/mapY`，**不是 GPS 经纬度**）。 */
export interface MapPoint {
  x: number;
  y: number;
}

/** 地图站点（起点 / 终点；用户可见字段，不含内部 node id）。 */
export interface MapStation extends MapPoint {
  name: string;
  province: string;
  city: string;
}

/** 地图事实节点（严格来自用户可见 Timeline；无 sourceKey / nodeId / importance / metadata）。 */
export interface MapFactView extends MapPoint {
  type: TimelineEventType;
  title: string;
  description: string;
  location: { province: string; city: string };
  /** 事实发生时刻（模拟时间，ISO 字符串）。 */
  happenedAt: string;
}

/**
 * `GET /letters/:trackingNo/map` 响应（开发规范 §74）。
 *
 * Phase 8 冻结：不含 `dropArea` / 掉落范围 / 掉落原因；不含 lat/lng（无精确 GPS）；
 * 不含 ETA / 剩余时间 / 预测事件；不含任何 internal id。
 */
export interface RouteMapView {
  /** 用户可见状态（内部 `LETTER_DROPPED` 已由 `toPublicLetterStatus` 投影）。 */
  status: PublicLetterStatus;
  origin: MapStation | null;
  destination: MapStation | null;
  /** 已确认走过的路线（实线；只由用户可见事实确认的节点组成）。 */
  completedPath: MapPoint[];
  /** 尚未走过的计划路线（虚线；来自冻结的路线规划，不含内部状态）。 */
  remainingPath: MapPoint[];
  /** 当前大概位置（近似；失联 / 终态 / 无时间锚点时为 null）。 */
  approximatePosition: MapPoint | null;
  /** 最后确报位置（失联 / 终态时保持不变）。 */
  lastKnownPosition: MapPoint | null;
  /** 最新高优先事实（最多 `MAP_FACT_LIMIT` 个，按时间升序）。 */
  facts: MapFactView[];
}

const mapPointSchema = z.object({ x: z.number(), y: z.number() });

const mapStationSchema = mapPointSchema.extend({
  name: z.string(),
  province: z.string(),
  city: z.string(),
});

const mapFactSchema = z.object({
  type: z.enum(TIMELINE_EVENT_TYPES),
  title: z.string(),
  description: z.string(),
  location: z.object({ province: z.string(), city: z.string() }),
  happenedAt: z.string(),
  x: z.number(),
  y: z.number(),
});

/**
 * 地图响应 Zod 安全契约（Phase 8 输出净化）。
 *
 * 约定：**不使用 `.strict()`**——Zod 默认剥离未知字段，因此该 schema 同时是
 * 服务端输出净化器（任何意外多出的内部字段在序列化前被剥离）与客户端解析器。
 * 严禁改成 `.passthrough()`（会让内部字段透传到用户可见 DTO）。
 */
export const routeMapViewSchema = z.object({
  status: z.enum(PUBLIC_LETTER_STATUSES),
  origin: mapStationSchema.nullable(),
  destination: mapStationSchema.nullable(),
  completedPath: z.array(mapPointSchema),
  remainingPath: z.array(mapPointSchema),
  approximatePosition: mapPointSchema.nullable(),
  lastKnownPosition: mapPointSchema.nullable(),
  facts: z.array(mapFactSchema),
});

/** 地图响应契约类型（与 `RouteMapView` 同一结构；用于解析结果类型收窄）。 */
export type RouteMapViewParsed = z.infer<typeof routeMapViewSchema>;
