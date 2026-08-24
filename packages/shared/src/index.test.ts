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
