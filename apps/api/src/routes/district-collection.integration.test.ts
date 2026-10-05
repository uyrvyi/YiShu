import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, requireTestDatabaseUrl } from "@yishu/config";
import { createPrismaClient, type PrismaClient } from "@yishu/db";
import { advanceJourneyToNow } from "@yishu/domain";
import { TestSimulationClock, deterministicDraw } from "@yishu/simulation";
import { selectWeightedOutcome, transportEventTable } from "@yishu/shared";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { districtPoint } from "../lib/district-map.js";

const T0 = Date.UTC(2026, 9, 4, 8);
const HOUR = 3600000;
const origin = { province: "上海市", city: "上海市", district: "黄浦区" };
const target = { province: "上海市", city: "上海市", district: "浦东新区" };
const beijing = { province: "北京市", city: "北京市", district: "海淀区" };
describe("district collection rule 1.1 and fact-only maps", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let clock: TestSimulationClock;
  let sender: { uid: string; id: bigint; token: string };
  let recipient: typeof sender;
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const map = async (trackingNo: string, token = sender.token) => {
    const response = await app.inject({
      url: `/api/v1/letters/${trackingNo}/map`,
      headers: auth(token),
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  };
  async function fixture(api = app, initialize = true) {
    const response = await api.inject({
      method: "POST",
      url: "/api/v1/letters",
      headers: auth(sender.token),
      payload: {
        recipient: recipient.uid,
        content: "private district letter",
        transportType: "PIGEON",
        clientRequestId: `dc-${Math.random()}`,
      },
    });
    expect(response.statusCode).toBe(201);
    const trackingNo = response.json().letter.trackingNo;
    if (initialize)
      expect(
        (
          await api.inject({
            method: "POST",
            url: `/api/v1/letters/${trackingNo}/journey`,
            headers: auth(sender.token),
          })
        ).statusCode
      ).toBe(201);
    return prisma.letter.findUniqueOrThrow({ where: { trackingNo } });
  }
  beforeAll(async () => {
    prisma = createPrismaClient(requireTestDatabaseUrl(process.env));
    clock = new TestSimulationClock(T0);
    app = buildApp(loadConfig({ NODE_ENV: "test", NEW_LETTER_RULES_VERSION: "1.1" }), {
      prisma,
      simulationClock: clock,
    });
    const suffix = Math.random().toString(36).slice(2, 8);
    const register = async (name: string, region: typeof origin) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/register",
        payload: {
          account: name + suffix,
          password: "district-test-password",
          nickname: name,
          ...region,
        },
      });
      expect(response.statusCode).toBe(201);
      const uid = response.json().user.uid;
      const user = await prisma.user.findUniqueOrThrow({ where: { uid } });
      return { uid, id: user.id, token: response.json().accessToken as string };
    };
    sender = await register("ds", origin);
    recipient = await register("dr", target);
  });
  beforeEach(async () => {
    clock.advanceTo(T0);
    await prisma.letter.deleteMany({ where: { senderId: sender.id } });
    await prisma.user.update({ where: { id: recipient.id }, data: target });
  });
  afterAll(async () => {
    await app.close();
    await prisma.letter.deleteMany({ where: { senderId: sender.id } });
    await prisma.refreshToken.deleteMany({ where: { userId: { in: [sender.id, recipient.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: [sender.id, recipient.id] } } });
    await prisma.$disconnect();
  });
  it("distinguishes districts without inventing coordinates for unknown districts", () => {
    const a = districtPoint(origin);
    const b = districtPoint(target);
    expect(a?.district).toBe("黄浦区");
    expect(b?.district).toBe("浦东新区");
    expect(a && b && (a.x !== b.x || a.y !== b.y)).toBe(true);
    expect(districtPoint({ ...origin, district: "不存在的区" })).toBeNull();
  });
  it("collects for exactly three hours, then delivers six hours later; recipients see only reached endpoints", async () => {
    const preview = await app.inject({
      method: "POST",
      url: "/api/v1/transport-estimates",
      headers: auth(sender.token),
      payload: { recipient: recipient.uid },
    });
    expect(preview.statusCode).toBe(200);
    expect(
      preview
        .json()
        .estimates.every(
          (estimate: { durationSeconds: number }) => estimate.durationSeconds === 9 * 3600
        )
    ).toBe(true);
    const letter = await fixture();
    expect(letter.rulesVersion).toBe("1.1");
    clock.advanceTo(T0 + 2 * HOUR);
    await advanceJourneyToNow(prisma, letter.id, clock);
    const journey = await prisma.journey.findUniqueOrThrow({ where: { letterId: letter.id } });
    expect(journey.originStationReadyAtSim).toEqual(new Date(T0 + 3 * HOUR));
    expect(journey.startedAtSim).toBeNull();
    expect(journey.nextRandomDrawIndex).toBe(0);
    const eta = await app.inject({
      url: `/api/v1/letters/${letter.trackingNo}/estimate`,
      headers: auth(sender.token),
    });
    expect(eta.json()).toMatchObject({ state: "ON_THE_WAY", remainingSeconds: 3600 });
    expect(
      (
        await app.inject({
          url: `/api/v1/letters/${letter.trackingNo}/estimate`,
          headers: auth(recipient.token),
        })
      ).statusCode
    ).toBe(404);
    const sent = await map(letter.trackingNo);
    expect(sent.origin.district).toBe("黄浦区");
    expect(sent.destination.district).toBe("浦东新区");
    expect(sent.collection.state).toBe("IN_PROGRESS");
    expect(sent.delivery.state).toBe("PLANNED");
    const received = await map(letter.trackingNo, recipient.token);
    expect(received.destination).toBeNull();
    expect(received.remainingPath).toEqual([]);
    expect(received.completedPath).toHaveLength(1);
    expect(received.stations).toEqual([]);
    expect(received.collection).toBeNull();
    expect(received.delivery).toBeNull();
    expect(JSON.stringify(received)).not.toContain("浦东新区");
    expect(received.facts.map((f: { type: string }) => f.type)).toEqual(["DISPATCHED"]);
    clock.advanceTo(T0 + 3 * HOUR);
    await advanceJourneyToNow(prisma, letter.id, clock);
    expect((await prisma.letter.findUniqueOrThrow({ where: { id: letter.id } })).status).toBe(
      "OUT_FOR_DELIVERY"
    );
    expect((await map(letter.trackingNo, recipient.token)).collection.state).toBe("COMPLETED");
    clock.advanceTo(T0 + 9 * HOUR - 1);
    await advanceJourneyToNow(prisma, letter.id, clock);
    expect((await prisma.letter.findUniqueOrThrow({ where: { id: letter.id } })).status).toBe(
      "OUT_FOR_DELIVERY"
    );
    const hidden = (
      await app.inject({
        url: `/api/v1/letters/${letter.trackingNo}`,
        headers: auth(recipient.token),
      })
    ).json().letter;
    expect(hidden.content).toBeNull();
    expect(hidden.writtenAt).toBeNull();
    expect(hidden.images).toEqual([]);
    clock.advanceTo(T0 + 9 * HOUR);
    await advanceJourneyToNow(prisma, letter.id, clock);
    const done = await map(letter.trackingNo, recipient.token);
    expect(done.destination.district).toBe("浦东新区");
    expect(done.delivery.state).toBe("COMPLETED");
    expect(
      (await prisma.letter.findUniqueOrThrow({ where: { id: letter.id } })).deliveredAt
    ).toEqual(new Date(T0 + 9 * HOUR));
    const visible = (
      await app.inject({
        url: `/api/v1/letters/${letter.trackingNo}`,
        headers: auth(recipient.token),
      })
    ).json().letter;
    expect(visible.content).toBe("private district letter");
    expect(visible.writtenAt).toBeTruthy();
  });
  it("late initialization and a large clock jump retain the immutable pickup anchor", async () => {
    const letter = await fixture(app, false);
    clock.advanceTo(T0 + 20 * HOUR);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/letters/${letter.trackingNo}/journey`,
          headers: auth(sender.token),
        })
      ).statusCode
    ).toBe(201);
    await advanceJourneyToNow(prisma, letter.id, clock);
    const updated = await prisma.letter.findUniqueOrThrow({
      where: { id: letter.id },
      include: { journey: true },
    });
    expect(updated.deliveredAt).toEqual(new Date(T0 + 9 * HOUR));
    expect(updated.journey?.startedAtSim).toEqual(new Date(T0 + 3 * HOUR));
    const first = await map(letter.trackingNo);
    const second = await map(letter.trackingNo);
    expect(second).toEqual(first);
  });
  it("holds a changed destination during pickup, applying at the origin-city boundary", async () => {
    const letter = await fixture();
    clock.advanceTo(T0 + HOUR);
    const changed = await app.inject({
      method: "PATCH",
      url: "/api/v1/users/me",
      headers: auth(recipient.token),
      payload: { nickname: "dr", region: beijing },
    });
    expect(changed.statusCode).toBe(200);
    const before = await prisma.journey.findUniqueOrThrow({
      where: { letterId: letter.id },
      include: { destinationChanges: true, legs: true },
    });
    expect(before.destinationChanges[0]?.status).toBe("PENDING");
    expect(before.legs).toHaveLength(0);
    expect((await map(letter.trackingNo)).delivery).toBeNull();
    clock.advanceTo(T0 + 3 * HOUR);
    await advanceJourneyToNow(prisma, letter.id, clock);
    const after = await prisma.journey.findUniqueOrThrow({
      where: { letterId: letter.id },
      include: { destinationChanges: true, legs: true },
    });
    expect(after.destinationChanges[0]).toMatchObject({
      status: "APPLIED",
      appliedAtSim: new Date(T0 + 3 * HOUR),
    });
    expect(after.legs[0]?.startedAtSim).toEqual(new Date(T0 + 3 * HOUR));
    const received = await map(letter.trackingNo, recipient.token);
    expect(JSON.stringify(received)).not.toContain("海淀区");
    expect(JSON.stringify(received)).not.toContain("北京市");
  });
  it("keeps legacy timing and map shape unchanged", async () => {
    const legacy = buildApp(loadConfig({ NODE_ENV: "test" }), { prisma, simulationClock: clock });
    try {
      const letter = await fixture(legacy);
      expect(letter.rulesVersion).toBe("1.0");
      await advanceJourneyToNow(prisma, letter.id, clock);
      expect(
        (await prisma.journey.findUniqueOrThrow({ where: { letterId: letter.id } }))
          .originStationReadyAtSim
      ).toBeNull();
      clock.advanceTo(T0 + 6 * HOUR);
      await advanceJourneyToNow(prisma, letter.id, clock);
      expect((await prisma.letter.findUniqueOrThrow({ where: { id: letter.id } })).status).toBe(
        "DELIVERED"
      );
      expect(await map(letter.trackingNo)).not.toHaveProperty("collection");
    } finally {
      await legacy.close();
    }
  });
  it("intercity jumps equal stepped progression and concurrent pickup checks do not draw events", async () => {
    await prisma.user.update({ where: { id: recipient.id }, data: beijing });
    const jump = await fixture();
    const step = await fixture();
    let seed = "";
    for (let index = 0; index < 1000; index++) {
      const candidate = `district-normal-${index}`;
      if (
        selectWeightedOutcome(
          deterministicDraw(candidate, 0),
          transportEventTable("1.1", "PIGEON")
        ) === "NORMAL"
      ) {
        seed = candidate;
        break;
      }
    }
    expect(seed).toBeTruthy();
    for (const letter of [jump, step])
      await prisma.journey.update({
        where: { letterId: letter.id },
        data: { simulationSeed: seed },
      });
    const leg = await prisma.transportLeg.findFirstOrThrow({
      where: { journey: { letterId: jump.id } },
    });
    const arrival = T0 + 3 * HOUR + leg.plannedDurationSeconds * 1000;
    clock.advanceTo(arrival + 6 * HOUR);
    await advanceJourneyToNow(prisma, jump.id, clock);
    clock.advanceTo(T0 + 2 * HOUR);
    await Promise.all([
      advanceJourneyToNow(prisma, step.id, clock),
      advanceJourneyToNow(prisma, step.id, clock),
    ]);
    expect(
      (await prisma.journey.findUniqueOrThrow({ where: { letterId: step.id } })).nextRandomDrawIndex
    ).toBe(0);
    for (const at of [T0 + 3 * HOUR, arrival, arrival + 6 * HOUR]) {
      clock.advanceTo(at);
      await advanceJourneyToNow(prisma, step.id, clock);
    }
    const snapshot = async (id: bigint) => {
      const letter = await prisma.letter.findUniqueOrThrow({
        where: { id },
        include: { journey: { include: { legs: { orderBy: { sequence: "asc" } } } } },
      });
      const journey = letter.journey!;
      return {
        status: letter.status,
        deliveredAt: letter.deliveredAt,
        startedAt: journey.startedAtSim,
        completedAt: journey.completedAtSim,
        ready: journey.lastMileReadyAtSim,
        pickup: journey.originStationReadyAtSim,
        cursor: journey.nextRandomDrawIndex,
        legs: journey.legs.map((l) => ({
          status: l.status,
          start: l.startedAtSim,
          end: l.completedAtSim,
          duration: l.plannedDurationSeconds,
        })),
      };
    };
    expect(await snapshot(step.id)).toEqual(await snapshot(jump.id));
    expect((await snapshot(step.id)).deliveredAt).toEqual(new Date(arrival + 6 * HOUR));
  });
});
