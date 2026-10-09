import { describe, expect, it } from "vitest";
import type { Journey, TransportLeg, WorldEvent } from "@yishu/db";
import { projectTimelineFacts, type TimelineProjectionInput } from "./timeline.js";

const at = new Date("2026-10-05T01:51:32.330Z");
const leg = (sequence = 0): TransportLeg => ({
  sequence, status: "COMPLETED", fromNodeId: "shanghai", toNodeId: "dalian",
  startedAtSim: new Date(at.getTime() - 3600000), completedAtSim: at, transportType: "PIGEON",
} as TransportLeg);
const event = (eventType: WorldEvent["eventType"], overrides: Partial<WorldEvent> = {}): WorldEvent => ({
  eventIndex: 0, eventType, nodeId: "dalian", transportLegSequence: 0, occurredAtSim: at,
  payload: null, ...overrides,
} as WorldEvent);
function input(worldEvents: WorldEvent[], legs = [leg()]): TimelineProjectionInput {
  return {
    graphVersion: "china-v2", letterStatus: "COURIER_MISSING", letterDeliveredAt: null,
    letterSentAt: legs[0]!.startedAtSim, letterCreatedAt: legs[0]!.startedAtSim,
    letterOriginProvince: "上海市", letterOriginCity: "上海市", letterOriginDistrict: "浦东新区",
    letterTargetProvince: "辽宁省", letterTargetCity: "大连市", letterTargetDistrict: "沙河口区",
    journey: { originNodeId: "shanghai", destinationNodeId: "dalian", lastMileReadyAtSim: null } as Journey,
    legs, worldEvents,
  };
}

describe("arrival confirmation at missing-contact boundary", () => {
  it("normal completion still confirms arrival", () => {
    expect(projectTimelineFacts(input([])).map((fact) => fact.type)).toContain("ARRIVED_STATION");
  });
  it("canonical missing suppresses only the contradictory arrival without exposing cause", () => {
    const facts = projectTimelineFacts(input([event("COURIER_MISSING")]));
    expect(facts.filter((fact) => fact.type === "COURIER_MISSING")).toHaveLength(1);
    expect(facts.map((fact) => fact.type)).not.toContain("ARRIVED_STATION");
    expect(JSON.stringify(facts)).not.toMatch(/LOST_PATH|cause|recoveryWindow/);
  });
  it("later recovery does not retroactively claim arrival at the missing time", () => {
    const snapshot = input([event("COURIER_MISSING"), event("RECOVERED", {
      eventIndex: 1, transportLegSequence: null, occurredAtSim: new Date(at.getTime() + 86400000),
    })]);
    snapshot.letterStatus = "IN_TRANSIT";
    const facts = projectTimelineFacts(snapshot);
    expect(facts.map((fact) => fact.type)).toContain("LETTER_RECOVERED");
    expect(facts.map((fact) => fact.type)).not.toContain("ARRIVED_STATION");
  });
  it("retains other visits and arrivals at different times", () => {
    const previous = { ...leg(1), completedAtSim: new Date(at.getTime() - 1) };
    const facts = projectTimelineFacts(input([event("COURIER_MISSING")], [leg(), previous, leg(2)]));
    expect(facts.filter((fact) => fact.type === "ARRIVED_STATION").map((fact) => fact.sourceKey))
      .toEqual(["leg:1:arrived", "leg:2:arrived"]);
  });
  it("hidden causes alone never alter visible arrival facts", () => {
    expect(projectTimelineFacts(input([event("LOST_PATH")]))).toEqual(projectTimelineFacts(input([])));
  });
});
