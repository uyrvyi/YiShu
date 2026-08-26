import { describe, expect, it } from "vitest";
import {
  API_PREFIX,
  LETTER_STATUSES,
  RECIPIENT_READ_STATES,
  TRANSPORT_TYPES,
  RULES_VERSIONS,
  TRANSPORT_SPEEDS_KM_PER_DAY,
  speedKmPerDay,
  plannedDurationSeconds,
  UnknownRulesVersionError,
  HAND_CARRY_EVENT_TABLE,
  HORSE_RELAY_EVENT_TABLE,
  EXPRESS_RELAY_EVENT_TABLE,
  PIGEON_EVENT_TABLE,
  TRANSPORT_EVENTS_BY_RULES_VERSION,
  transportEventTable,
  ROBBERY_BRANCHES,
  DROP_RECOVERY_WINDOWS,
  RECOVERY_HANDLINGS,
  RECOVERY_TRANSPORT_CHANGE,
  selectWeightedOutcome,
} from "./index.js";

describe("shared", () => {
  it("API 前缀为 /api/v1", () => {
    expect(API_PREFIX).toBe("/api/v1");
    expect(TRANSPORT_TYPES).toEqual(["HAND_CARRY", "HORSE_RELAY", "EXPRESS_RELAY", "PIGEON"]);
    expect(LETTER_STATUSES).toHaveLength(15);
    expect(LETTER_STATUSES).toContain("DELIVERED");
    expect(RECIPIENT_READ_STATES).toEqual(["UNOPENED", "OPENED"]);
  });

  it("规则版本与冻结速度：1.0 默认速度表（Phase 4 Final Gate BLOCKER-1）", () => {
    expect(RULES_VERSIONS).toEqual(["1.0"]);
    expect(TRANSPORT_SPEEDS_KM_PER_DAY).toEqual({
      HAND_CARRY: 35,
      HORSE_RELAY: 120,
      EXPRESS_RELAY: 300,
      PIGEON: 480,
    });
    expect(speedKmPerDay("1.0", "HORSE_RELAY")).toBe(120);
  });

  it("未知规则版本必须明确拒绝（不静默 fallback）", () => {
    expect(() => speedKmPerDay("999.0", "HORSE_RELAY")).toThrow(UnknownRulesVersionError);
    expect(() => plannedDurationSeconds("999.0", "HORSE_RELAY", 100)).toThrow(
      UnknownRulesVersionError
    );
  });

  it("plannedDurationSeconds 按版本计算：distanceKm / speed × 86400（秒）", () => {
    // HORSE_RELAY 120 km/day：120 km → 86400 秒
    expect(plannedDurationSeconds("1.0", "HORSE_RELAY", 120)).toBe(86400);
    // HAND_CARRY 35 km/day：35 km → 86400 秒
    expect(plannedDurationSeconds("1.0", "HAND_CARRY", 35)).toBe(86400);
    // PIGEON 480 km/day：480 km → 86400 秒
    expect(plannedDurationSeconds("1.0", "PIGEON", 480)).toBe(86400);
  });
});

describe("Phase 6 随机事件概率（开发规范 §27–§36，冻结）", () => {
  const sumWeights = <T extends string>(table: readonly { outcome: T; weight: number }[]): number =>
    table.reduce((acc, item) => acc + item.weight, 0);

  it("四种运输方式一级事件概率总和 = 1.0", () => {
    expect(sumWeights(HAND_CARRY_EVENT_TABLE)).toBeCloseTo(1.0, 6);
    expect(sumWeights(HORSE_RELAY_EVENT_TABLE)).toBeCloseTo(1.0, 6);
    expect(sumWeights(EXPRESS_RELAY_EVENT_TABLE)).toBeCloseTo(1.0, 6);
    expect(sumWeights(PIGEON_EVENT_TABLE)).toBeCloseTo(1.0, 6);
  });

  it("概率表按规则版本登记；未知版本明确拒绝（不 fallback latest）", () => {
    expect(TRANSPORT_EVENTS_BY_RULES_VERSION["1.0"]).toBeDefined();
    expect(() => transportEventTable("999.0", "HORSE_RELAY")).toThrow(UnknownRulesVersionError);
  });

  it("robbery 二级分支、恢复窗口、拾获处理、运输变更倾向总和均 = 1.0", () => {
    expect(sumWeights(ROBBERY_BRANCHES)).toBeCloseTo(1.0, 6);
    expect(sumWeights(DROP_RECOVERY_WINDOWS)).toBeCloseTo(1.0, 6);
    expect(sumWeights(RECOVERY_HANDLINGS)).toBeCloseTo(1.0, 6);
    for (const transport of TRANSPORT_TYPES) {
      expect(sumWeights(RECOVERY_TRANSPORT_CHANGE[transport])).toBeCloseTo(1.0, 6);
    }
  });

  it("selectWeightedOutcome 按累计权重确定性分段（区间内代表值，边界由总和测试覆盖）", () => {
    const table = HAND_CARRY_EVENT_TABLE;
    // 区间：NORMAL[0,0.84) DELAY[0.84,0.89) REROUTE[0.89,0.93) LOST_PATH[0.93,0.95)
    //       ROBBERY[0.95,0.97) COURIER_MISSING[0.97,0.985) LETTER_DROPPED[0.985,0.995) SERIOUS_ACCIDENT[0.995,1)
    expect(selectWeightedOutcome(0.0, table)).toBe("NORMAL");
    expect(selectWeightedOutcome(0.83, table)).toBe("NORMAL");
    expect(selectWeightedOutcome(0.87, table)).toBe("DELAY");
    expect(selectWeightedOutcome(0.92, table)).toBe("REROUTE");
    expect(selectWeightedOutcome(0.94, table)).toBe("LOST_PATH");
    expect(selectWeightedOutcome(0.96, table)).toBe("ROBBERY");
    expect(selectWeightedOutcome(0.98, table)).toBe("COURIER_MISSING");
    expect(selectWeightedOutcome(0.99, table)).toBe("LETTER_DROPPED");
    expect(selectWeightedOutcome(0.997, table)).toBe("SERIOUS_ACCIDENT");
  });

  it("robbery 分支（55/25/15/5）区间代表值", () => {
    // ESCAPE[0,0.55) INJURED[0.55,0.80) MISSING_DROPPED[0.80,0.95) DEAD_DROPPED[0.95,1)
    expect(selectWeightedOutcome(0.2, ROBBERY_BRANCHES)).toBe("ESCAPE_DELAY");
    expect(selectWeightedOutcome(0.7, ROBBERY_BRANCHES)).toBe("INJURED_CONTINUE");
    expect(selectWeightedOutcome(0.9, ROBBERY_BRANCHES)).toBe("MISSING_DROPPED");
    expect(selectWeightedOutcome(0.99, ROBBERY_BRANCHES)).toBe("DEAD_DROPPED");
  });

  it("恢复窗口（50/25/15/10）区间代表值", () => {
    expect(selectWeightedOutcome(0.2, DROP_RECOVERY_WINDOWS)).toBe("WITHIN_24H");
    expect(selectWeightedOutcome(0.6, DROP_RECOVERY_WINDOWS)).toBe("ONE_TO_THREE_DAYS");
    expect(selectWeightedOutcome(0.8, DROP_RECOVERY_WINDOWS)).toBe("THREE_TO_SEVEN_DAYS");
    expect(selectWeightedOutcome(0.95, DROP_RECOVERY_WINDOWS)).toBe("NEVER");
  });

  it("拾获后处理（70/20/10）与恢复后运输变更倾向（HAND_CARRY 60/25/15）", () => {
    expect(selectWeightedOutcome(0.1, RECOVERY_HANDLINGS)).toBe("NEAREST_STATION");
    expect(selectWeightedOutcome(0.8, RECOVERY_HANDLINGS)).toBe("FINDER_CARRIES");
    expect(selectWeightedOutcome(0.95, RECOVERY_HANDLINGS)).toBe("SET_ASIDE");
    expect(selectWeightedOutcome(0.1, RECOVERY_TRANSPORT_CHANGE.HAND_CARRY)).toBe("HORSE_RELAY");
    expect(selectWeightedOutcome(0.7, RECOVERY_TRANSPORT_CHANGE.HAND_CARRY)).toBe("PIGEON");
    expect(selectWeightedOutcome(0.9, RECOVERY_TRANSPORT_CHANGE.HAND_CARRY)).toBe("HAND_CARRY");
  });
});
