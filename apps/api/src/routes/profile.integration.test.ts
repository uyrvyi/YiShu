import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, requireTestDatabaseUrl } from "@yishu/config";
import { createPrismaClient, type PrismaClient } from "@yishu/db";
import {
  advanceJourneyToNow,
  materializeVisibleTimeline,
  projectFactsForLetter,
} from "@yishu/domain";
import { TestSimulationClock, deterministicDraw } from "@yishu/simulation";
import { selectWeightedOutcome, transportEventTable } from "@yishu/shared";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { resolveStationForRegion } from "../lib/stationGraph.js";

const T0 = Date.UTC(2026, 9, 3, 8);
const beijing = { province: "北京市", city: "北京市", district: "海淀区" };
const guangzhou = { province: "广东省", city: "广州市", district: "天河区" };
const hangzhou = { province: "浙江省", city: "杭州市", district: "西湖区" };

describe("recipient profile and station-boundary destination changes", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let clock: TestSimulationClock;
  let sender: { uid: string; id: bigint; token: string };
  let recipient: { uid: string; id: bigint; token: string };
  let normalSeed: string;
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  async function fixture() {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/letters",
      headers: auth(sender.token),
      payload: {
        recipient: recipient.uid,
        content: "unchanged private body",
        transportType: "HORSE_RELAY",
        clientRequestId: `pr-${Math.random()}`,
      },
    });
    expect(response.statusCode).toBe(201);
    const trackingNo = response.json().letter.trackingNo;
    const letter = await prisma.letter.findUniqueOrThrow({ where: { trackingNo } });
    const initialized = await app.inject({
      method: "POST",
      url: `/api/v1/letters/${trackingNo}/journey`,
      headers: auth(sender.token),
    });
    expect(initialized.statusCode).toBe(201);
    await prisma.journey.update({
      where: { letterId: letter.id },
      data: { simulationSeed: normalSeed },
    });
    await advanceJourneyToNow(prisma, letter.id, clock);
    return {
      ...letter,
      journey: await prisma.journey.findUniqueOrThrow({
        where: { letterId: letter.id },
        include: { legs: { orderBy: { sequence: "asc" } } },
      }),
    };
  }
  const patch = (region = guangzhou, nickname = "New name") =>
    app.inject({
      method: "PATCH",
      url: "/api/v1/users/me",
      headers: auth(recipient.token),
      payload: { nickname, region },
    });

  beforeAll(async () => {
    prisma = createPrismaClient(requireTestDatabaseUrl(process.env));
    clock = new TestSimulationClock(T0);
    app = buildApp(loadConfig({ NODE_ENV: "test" }), { prisma, simulationClock: clock });
    const suffix = Math.random().toString(36).slice(2, 9);
    const register = async (name: string, region: typeof beijing) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/register",
        payload: {
          account: `${name}${suffix}`,
          password: "profile-test-password",
          nickname: name,
          ...region,
        },
      });
      expect(response.statusCode).toBe(201);
      const user = await prisma.user.findUniqueOrThrow({
        where: { uid: response.json().user.uid },
      });
      return { uid: user.uid, id: user.id, token: response.json().accessToken as string };
    };
    sender = await register("ps", { province: "上海市", city: "上海市", district: "徐汇区" });
    recipient = await register("pr", beijing);
    const table = transportEventTable("1.0", "HORSE_RELAY");
    for (let index = 0; index < 10000; index++) {
      const seed = `profile-normal-${index}`;
      if (
        Array.from({ length: 20 }, (_, draw) =>
          selectWeightedOutcome(deterministicDraw(seed, draw), table)
        ).every((outcome) => outcome === "NORMAL")
      ) {
        normalSeed = seed;
        break;
      }
    }
    expect(normalSeed).toBeTruthy();
  });
  beforeEach(async () => {
    clock.advanceTo(T0);
    await prisma.letter.deleteMany({ where: { senderId: sender.id } });
    await prisma.user.update({ where: { id: recipient.id }, data: { ...beijing, nickname: "pr" } });
  });
  afterAll(async () => {
    await app.close();
    await prisma.letter.deleteMany({ where: { senderId: sender.id } });
    await prisma.refreshToken.deleteMany({ where: { userId: { in: [sender.id, recipient.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: [sender.id, recipient.id] } } });
    await prisma.$disconnect();
  });

  it("finishes the original active leg, then recomputes immediately from its original next station", async () => {
    const letter = await fixture();
    const first = letter.journey.legs[0];
    if (!first) throw new Error("missing_first_leg");
    clock.advanceTo(T0 + 1000);
    const before = await prisma.transportLeg.findUniqueOrThrow({ where: { id: first.id } });
    expect((await patch()).statusCode).toBe(200);
    expect(await prisma.transportLeg.findUniqueOrThrow({ where: { id: first.id } })).toEqual(
      before
    );
    expect(
      (await prisma.journey.findUniqueOrThrow({ where: { letterId: letter.id } })).destinationNodeId
    ).toBe(letter.journey.destinationNodeId);
    const arrival = T0 + first.plannedDurationSeconds * 1000;
    clock.advanceTo(arrival);
    await advanceJourneyToNow(prisma, letter.id, clock);
    const updated = await prisma.journey.findUniqueOrThrow({
      where: { letterId: letter.id },
      include: { legs: { orderBy: { sequence: "asc" } }, destinationChanges: true },
    });
    expect(updated.destinationNodeId).toBe(resolveStationForRegion(guangzhou, letter.graphVersion));
    expect(updated.legs[0]).toMatchObject({
      id: first.id,
      fromNodeId: first.fromNodeId,
      toNodeId: first.toNodeId,
      status: "COMPLETED",
      completedAtSim: new Date(arrival),
    });
    expect(updated.legs[1]).toMatchObject({
      fromNodeId: first.toNodeId,
      status: "ACTIVE",
      startedAtSim: new Date(arrival),
    });
    expect(updated.destinationChanges[0]).toMatchObject({
      status: "APPLIED",
      appliedAtSim: new Date(arrival),
    });
    expect(
      (await prisma.letter.findUniqueOrThrow({ where: { id: letter.id } })).encryptedContent
    ).toBe(letter.encryptedContent);
    const recipientView = (
      await app.inject({
        url: `/api/v1/letters/${letter.trackingNo}`,
        headers: auth(recipient.token),
      })
    ).json().letter;
    expect(recipientView).toMatchObject({
      content: null,
      writtenAt: null,
      images: [],
      journey: null,
    });
  });

  it("retains delivered letters byte-for-byte while updating profile and new letters", async () => {
    const letter = await fixture();
    await prisma.letter.update({
      where: { id: letter.id },
      data: { status: "DELIVERED", deliveredAt: new Date(T0) },
    });
    const before = await prisma.letter.findUniqueOrThrow({ where: { id: letter.id } });
    const journeyBefore = await prisma.journey.findUniqueOrThrow({
      where: { letterId: letter.id },
    });
    expect((await patch()).statusCode).toBe(200);
    expect(await prisma.letter.findUniqueOrThrow({ where: { id: letter.id } })).toEqual(before);
    expect(await prisma.journey.findUniqueOrThrow({ where: { letterId: letter.id } })).toEqual(
      journeyBefore
    );
    const newLetter = await fixture();
    expect(newLetter.targetCity).toBe(guangzhou.city);
    expect(newLetter.recipientNicknameSnapshot).toBe("New name");
    expect(before.recipientNicknameSnapshot).toBe("pr");
  });

  it("uses the last saved destination when two edits occur before the next station", async () => {
    const letter = await fixture();
    clock.advanceTo(T0 + 1000);
    expect((await patch(guangzhou)).statusCode).toBe(200);
    clock.advanceTo(T0 + 2000);
    expect((await patch(hangzhou)).statusCode).toBe(200);
    const first = letter.journey.legs[0];
    if (!first) throw new Error("missing_first_leg");
    clock.advanceTo(T0 + first.plannedDurationSeconds * 1000);
    await advanceJourneyToNow(prisma, letter.id, clock);
    const changes = await prisma.destinationChange.findMany({
      where: { journeyId: letter.journey.id },
      orderBy: { id: "asc" },
    });
    expect(changes.map((change) => change.status)).toEqual(["SUPERSEDED", "APPLIED"]);
    expect(
      (await prisma.journey.findUniqueOrThrow({ where: { letterId: letter.id } })).destinationNodeId
    ).toBe(resolveStationForRegion(hangzhou, letter.graphVersion));
  });

  it("reroutes last-mile delivery immediately and preserves the old dispatch fact without relying on prior GETs", async () => {
    const letter = await fixture();
    const lastArrival =
      T0 + letter.journey.legs.reduce((sum, leg) => sum + leg.plannedDurationSeconds * 1000, 0);
    clock.advanceTo(lastArrival);
    await advanceJourneyToNow(prisma, letter.id, clock);
    expect((await prisma.letter.findUniqueOrThrow({ where: { id: letter.id } })).status).toBe(
      "OUT_FOR_DELIVERY"
    );
    const oldLegs = await prisma.transportLeg.findMany({
      where: { journeyId: letter.journey.id },
      orderBy: { sequence: "asc" },
    });
    clock.advanceTo(lastArrival + 1000);
    expect((await patch()).statusCode).toBe(200);
    const route = await prisma.journey.findUniqueOrThrow({
      where: { letterId: letter.id },
      include: { legs: { orderBy: { sequence: "asc" } } },
    });
    expect(route.legs.slice(0, oldLegs.length)).toEqual(oldLegs);
    expect(route.legs[oldLegs.length]).toMatchObject({
      fromNodeId: letter.journey.destinationNodeId,
      status: "ACTIVE",
      startedAtSim: new Date(lastArrival + 1000),
    });
    const projected = await projectFactsForLetter(prisma, letter.id);
    const oldDelivery = projected.find((fact) => fact.sourceKey === "journey:out_for_delivery");
    expect(oldDelivery).toMatchObject({
      happenedAtMs: lastArrival,
      district: "海淀区",
      city: "北京市",
    });
    await materializeVisibleTimeline(prisma, letter.id, clock.now());
    const history = await prisma.timelineEvent.findMany({
      where: { letterId: letter.id },
      orderBy: { sourceKey: "asc" },
    });
    const nextArrival =
      lastArrival +
      1000 +
      route.legs
        .slice(oldLegs.length)
        .reduce((sum, leg) => sum + leg.plannedDurationSeconds * 1000, 0);
    clock.advanceTo(nextArrival);
    await advanceJourneyToNow(prisma, letter.id, clock);
    expect((await prisma.letter.findUniqueOrThrow({ where: { id: letter.id } })).status).toBe(
      "OUT_FOR_DELIVERY"
    );
    await materializeVisibleTimeline(prisma, letter.id, clock.now());
    const final = await prisma.timelineEvent.findMany({
      where: { letterId: letter.id },
      orderBy: { sourceKey: "asc" },
    });
    for (const fact of history) {
      const saved = final.find((item) => item.sourceKey === fact.sourceKey);
      expect(saved).toMatchObject({
        title: fact.title,
        description: fact.description,
        happenedAt: fact.happenedAt,
        district: fact.district,
        city: fact.city,
      });
    }
    expect(final.filter((fact) => fact.type === "OUT_FOR_DELIVERY")).toHaveLength(2);
  });

  it("does not reroute on name-only edits or unauthorized requests", async () => {
    const letter = await fixture();
    const before = await prisma.journey.findUniqueOrThrow({
      where: { letterId: letter.id },
      include: { legs: true },
    });
    expect(
      (await app.inject({ method: "PATCH", url: "/api/v1/users/me", payload: { nickname: "N" } }))
        .statusCode
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/v1/users/me",
          headers: auth(recipient.token),
          payload: { nickname: "N" },
        })
      ).statusCode
    ).toBe(200);
    expect(
      await prisma.journey.findUniqueOrThrow({
        where: { letterId: letter.id },
        include: { legs: true },
      })
    ).toEqual(before);
  });

  it("serializes concurrent profile edits and worker advancement without changing the active leg", async () => {
    const letter = await fixture();
    const first = letter.journey.legs[0];
    if (!first) throw new Error("missing_first_leg");
    clock.advanceTo(T0 + 1000);
    const results = await Promise.all([
      patch(guangzhou),
      patch(hangzhou),
      advanceJourneyToNow(prisma, letter.id, clock),
    ]);
    expect((results[0] as { statusCode: number }).statusCode).toBe(200);
    expect((results[1] as { statusCode: number }).statusCode).toBe(200);
    const profile = await prisma.user.findUniqueOrThrow({ where: { id: recipient.id } });
    const target = await prisma.letter.findUniqueOrThrow({ where: { id: letter.id } });
    expect(target.targetCity).toBe(profile.city);
    expect(await prisma.transportLeg.findUniqueOrThrow({ where: { id: first.id } })).toEqual(first);
    const pending = await prisma.destinationChange.findMany({
      where: { journeyId: letter.journey.id, status: "PENDING" },
    });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.targetCity).toBe(profile.city);
    clock.advanceTo(T0 + first.plannedDurationSeconds * 1000);
    await advanceJourneyToNow(prisma, letter.id, clock);
    expect(
      (await prisma.journey.findUniqueOrThrow({ where: { letterId: letter.id } })).destinationNodeId
    ).toBe(resolveStationForRegion(profile, letter.graphVersion));
  });

  it("starts a new last-mile attempt for a changed district at the same final station", async () => {
    const letter = await fixture();
    const arrival =
      T0 + letter.journey.legs.reduce((sum, leg) => sum + leg.plannedDurationSeconds * 1000, 0);
    clock.advanceTo(arrival);
    await advanceJourneyToNow(prisma, letter.id, clock);
    clock.advanceTo(arrival + 1000);
    expect((await patch({ ...beijing, district: "朝阳区" })).statusCode).toBe(200);
    const journey = await prisma.journey.findUniqueOrThrow({ where: { letterId: letter.id } });
    expect(journey.destinationNodeId).toBe(letter.journey.destinationNodeId);
    expect(journey.lastMileReadyAtSim).toEqual(new Date(arrival + 1000));
    const facts = await projectFactsForLetter(prisma, letter.id);
    expect(
      facts
        .filter((fact) => fact.type === "OUT_FOR_DELIVERY")
        .map((fact) => fact.district)
        .sort()
    ).toEqual(["朝阳区", "海淀区"].sort());
  });

  it("catches up a delivery before editing and leaves that letter at its delivered destination", async () => {
    const letter = await fixture();
    clock.advanceTo(T0 + 100 * 86400000);
    expect((await patch()).statusCode).toBe(200);
    const result = await prisma.letter.findUniqueOrThrow({ where: { id: letter.id } });
    expect(result.status).toBe("DELIVERED");
    expect(result.targetCity).toBe(beijing.city);
    expect(await prisma.destinationChange.count({ where: { journeyId: letter.journey.id } })).toBe(
      0
    );
  });

  it("rolls back profile, catch-up and destination changes together when station resolution fails", async () => {
    const letter = await fixture();
    const before = await prisma.journey.findUniqueOrThrow({
      where: { letterId: letter.id },
      include: { legs: true },
    });
    const profile = await prisma.user.findUniqueOrThrow({ where: { id: recipient.id } });
    clock.advanceTo(T0 + 1000);
    expect(
      (await patch({ province: "未知地区", city: "未知城市", district: "未知区" })).statusCode
    ).toBe(400);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: recipient.id } })).toEqual(profile);
    expect(
      await prisma.journey.findUniqueOrThrow({
        where: { letterId: letter.id },
        include: { legs: true },
      })
    ).toEqual(before);
    expect(await prisma.destinationChange.count({ where: { journeyId: letter.journey.id } })).toBe(
      0
    );
  });

  it("remains replay-equivalent after a destination change with large jumps versus frequent advancement", async () => {
    const direct = await fixture();
    const stepped = await fixture();
    clock.advanceTo(T0 + 1000);
    expect((await patch(hangzhou)).statusCode).toBe(200);
    const end = T0 + 100 * 86400000;
    await advanceJourneyToNow(prisma, direct.id, new TestSimulationClock(end));
    for (let part = 1; part <= 20; part++) {
      await advanceJourneyToNow(
        prisma,
        stepped.id,
        new TestSimulationClock(T0 + part * 5 * 86400000)
      );
    }
    const snapshot = async (id: bigint) => {
      const value = await prisma.journey.findUniqueOrThrow({
        where: { letterId: id },
        include: { legs: { orderBy: { sequence: "asc" } } },
      });
      const letter = await prisma.letter.findUniqueOrThrow({ where: { id } });
      return {
        status: letter.status,
        deliveredAt: letter.deliveredAt,
        destination: value.destinationNodeId,
        revision: value.destinationRevision,
        draw: value.nextRandomDrawIndex,
        advanced: value.lastAdvancedAtSim,
        legs: value.legs.map((leg) => ({
          sequence: leg.sequence,
          from: leg.fromNodeId,
          to: leg.toNodeId,
          status: leg.status,
          started: leg.startedAtSim,
          completed: leg.completedAtSim,
          duration: leg.plannedDurationSeconds,
          outcome: leg.primaryEventOutcome,
        })),
      };
    };
    expect(await snapshot(direct.id)).toEqual(await snapshot(stepped.id));
    expect((await snapshot(direct.id)).status).toBe("DELIVERED");
  });

  it("coordinates journey initialization with concurrent profile changes without losing the requested destination", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/letters",
      headers: auth(sender.token),
      payload: {
        recipient: recipient.uid,
        content: "init race",
        transportType: "HORSE_RELAY",
        clientRequestId: `init-${Math.random()}`,
      },
    });
    const trackingNo = created.json().letter.trackingNo;
    const [initialized, edited] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/v1/letters/${trackingNo}/journey`,
        headers: auth(sender.token),
      }),
      patch(),
    ]);
    expect(initialized.statusCode).toBe(201);
    expect(edited.statusCode).toBe(200);
    const letter = await prisma.letter.findUniqueOrThrow({
      where: { trackingNo },
      include: { journey: { include: { destinationChanges: true } } },
    });
    expect(letter.targetCity).toBe(guangzhou.city);
    if (!letter.journey) throw new Error("missing_journey");
    const destination = resolveStationForRegion(guangzhou, letter.graphVersion);
    expect(
      letter.journey.destinationNodeId === destination ||
        letter.journey.destinationChanges.some(
          (change) => change.status === "PENDING" && change.destinationNodeId === destination
        )
    ).toBe(true);
  });
});
