import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createPrismaClient, type PrismaClient } from "@yishu/db";
import { loadConfig, requireTestDatabaseUrl } from "@yishu/config";
import { advanceJourneyToNow, materializeVisibleTimeline } from "@yishu/domain";
import { getGraphVersions } from "@yishu/domain/stationGraph";
import { deterministicDraw, TestSimulationClock } from "@yishu/simulation";
import { TRANSPORT_TYPES, type TransportType } from "@yishu/shared";
import { buildApp } from "../app.js";
import { initializeJourney } from "../lib/journey.js";

const BASE = Date.UTC(2026, 8, 30);
const YEAR = 365 * 86400000;
const cases = getGraphVersions().flatMap((graphVersion) =>
  TRANSPORT_TYPES.flatMap((transport) =>
    [0, 1].map((sample) => ({ graphVersion, transport, sample }))
  )
);

function deterministicFields(row: object, omitted: readonly string[]) {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !omitted.includes(key)));
}

function auditPublicFields(value: unknown): void {
  const forbidden = new Set([
    "id",
    "letterId",
    "journeyId",
    "senderId",
    "recipientId",
    "passwordHash",
    "encryptedContent",
    "contentIv",
    "contentAuthTag",
    "simulationSeed",
    "requestFingerprint",
    "worldEventId",
    "worldEvents",
    "eventIndex",
    "nodeId",
    "payload",
    "visibleAt",
    "plannedDurationSeconds",
    "nextRandomDrawIndex",
    "nextWorldEventIndex",
    "anomalyType",
    "primaryEventOutcome",
    "accessToken",
    "refreshToken",
  ]);
  if (Array.isArray(value)) value.forEach(auditPublicFields);
  else if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      expect(forbidden.has(key), `unexpected public field: ${key}`).toBe(false);
      auditPublicFields(nested);
    }
  }
}

describe("Phase 11 seeded one-year replay", () => {
  let db: PrismaClient;
  let app: FastifyInstance;
  let sender: { id: bigint; uid: string; token: string };
  let recipient: { id: bigint; uid: string; token: string };
  let outsider: { id: bigint; uid: string; token: string };
  const accounts = [0, 1, 2].map((i) => `p11replay${i}${randomUUID().slice(0, 7)}`);
  const apiClock = new TestSimulationClock(BASE + YEAR);

  beforeAll(async () => {
    db = createPrismaClient(requireTestDatabaseUrl(process.env));
    app = buildApp(loadConfig({ NODE_ENV: "test" }), { prisma: db, simulationClock: apiClock });
    const registered = [];
    for (const [index, account] of accounts.entries()) {
      const city = index === 0 ? "上海市" : "北京市";
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/register",
        payload: {
          account,
          password: "phase11-replay-pass",
          nickname: "Replay",
          province: city,
          city,
          district: "测试区",
        },
      });
      expect(response.statusCode).toBe(201);
      const row = await db.user.findUniqueOrThrow({ where: { account } });
      registered.push({ id: row.id, uid: row.uid, token: response.json().accessToken as string });
    }
    const [first, second, third] = registered;
    if (!first || !second || !third) throw new Error("missing_replay_users");
    sender = first;
    recipient = second;
    outsider = third;
  });

  afterAll(async () => {
    if (app) await app.close();
    if (db) {
      await db.letter.deleteMany({ where: { sender: { account: { in: accounts } } } });
      await db.refreshToken.deleteMany({ where: { user: { account: { in: accounts } } } });
      await db.block.deleteMany({
        where: {
          OR: [
            { blocker: { account: { in: accounts } } },
            { blocked: { account: { in: accounts } } },
          ],
        },
      });
      await db.user.deleteMany({ where: { account: { in: accounts } } });
      await db.$disconnect();
    }
  });

  async function create(transport: TransportType, graphVersion: string, seed: string) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/letters",
      headers: { authorization: `Bearer ${sender.token}` },
      payload: {
        recipient: recipient.uid,
        content: "phase11-replay-body",
        transportType: transport,
        clientRequestId: randomUUID(),
      },
    });
    expect(response.statusCode).toBe(201);
    const trackingNo: string = response.json().letter.trackingNo;
    const row = await db.letter.update({
      where: { trackingNo },
      data: {
        simulationSeed: seed,
        graphVersion,
        createdAt: new Date(BASE),
        sentAt: new Date(BASE),
      },
    });
    await initializeJourney(db, row.id);
    await advanceJourneyToNow(db, row.id, new TestSimulationClock(BASE));
    return row;
  }

  async function snapshot(letterId: bigint) {
    const letter = await db.letter.findUniqueOrThrow({ where: { id: letterId } });
    const journey = await db.journey.findUniqueOrThrow({
      where: { letterId },
      include: {
        legs: { orderBy: { sequence: "asc" } },
        worldEvents: { orderBy: { eventIndex: "asc" } },
      },
    });
    const timeline = await materializeVisibleTimeline(db, letterId, BASE + YEAR);
    return {
      letter: {
        status: letter.status,
        currentTransport: letter.currentTransport,
        deliveredAt: letter.deliveredAt,
        rulesVersion: letter.rulesVersion,
        graphVersion: letter.graphVersion,
        simulationSeed: letter.simulationSeed,
      },
      journey: deterministicFields(journey, [
        "id",
        "letterId",
        "createdAt",
        "updatedAt",
        "legs",
        "worldEvents",
      ]),
      legs: journey.legs.map((leg) =>
        deterministicFields(leg, ["id", "journeyId", "createdAt", "updatedAt"])
      ),
      events: journey.worldEvents.map((event) =>
        deterministicFields(event, ["id", "journeyId", "createdAt"])
      ),
      timeline: timeline.map((event) =>
        deterministicFields(event, ["id", "letterId", "createdAt"])
      ),
    };
  }

  it.each(cases)(
    "$graphVersion / $transport / sample $sample: jumps equal randomized steps, retries and rewinds",
    async ({ graphVersion, transport, sample }) => {
      const scenario = `phase11-${graphVersion}-${transport}-${sample}`;
      const seed = createHash("sha256").update(scenario).digest("hex");
      const jumped = await create(transport, graphVersion, seed);
      const stepped = await create(transport, graphVersion, seed);
      await advanceJourneyToNow(db, jumped.id, new TestSimulationClock(BASE + YEAR));
      const offsets = [
        ...Array.from({ length: 24 }, (_, index) =>
          Math.floor(deterministicDraw(`${seed}-schedule`, index) * YEAR)
        ),
        YEAR,
      ].sort((a, b) => a - b);
      for (const [index, offset] of offsets.entries()) {
        const now = BASE + offset;
        await advanceJourneyToNow(db, stepped.id, new TestSimulationClock(now));
        if (index % 6 === 0) {
          expect(
            (await advanceJourneyToNow(db, stepped.id, new TestSimulationClock(now))).changed
          ).toBe(false);
          expect(
            (await advanceJourneyToNow(db, stepped.id, new TestSimulationClock(now - 1000))).changed
          ).toBe(false);
        }
      }
      expect(await snapshot(stepped.id)).toEqual(await snapshot(jumped.id));
      const state = await db.journey.findUniqueOrThrow({
        where: { letterId: stepped.id },
        include: { legs: true, worldEvents: true },
      });
      expect(state.simulationSeed).toBe(seed);
      expect(state.graphVersion).toBe(graphVersion);
      expect(state.rulesVersion).toBe(stepped.rulesVersion);
      expect(state.legs.filter((leg) => leg.status === "ACTIVE").length).toBeLessThanOrEqual(1);
      expect(new Set(state.worldEvents.map((event) => event.eventIndex)).size).toBe(
        state.worldEvents.length
      );
      const headers = { authorization: `Bearer ${recipient.token}` };
      const path = `/api/v1/letters/${stepped.trackingNo}`;
      const detail = await app.inject({ url: path, headers });
      expect(detail.statusCode).toBe(200);
      expect(detail.json().letter.journey).toBeNull();
      expect((await app.inject({ url: `${path}/journey`, headers })).statusCode).toBe(404);
      const map = await app.inject({ url: `${path}/map`, headers });
      expect(map.statusCode).toBe(200);
      expect(map.json().remainingPath).toEqual([]);
      expect(JSON.stringify({ detail: detail.json(), map: map.json() })).not.toMatch(
        /simulationSeed|encryptedContent|plannedDurationSeconds|worldEvents|LETTER_DROPPED|etaSeconds/
      );
    }
  );

  it("audits successful public DTOs and sender/recipient/outsider access across all resource routes", async () => {
    const letter = await db.letter.findFirstOrThrow({
      where: { senderId: sender.id },
      orderBy: { id: "asc" },
    });
    const path = `/api/v1/letters/${letter.trackingNo}`;
    const senderHeaders = { authorization: `Bearer ${sender.token}` };
    for (const url of [
      "/api/v1/users/me",
      `/api/v1/users/search?q=${recipient.uid}`,
      "/api/v1/letters?direction=sent",
      "/api/v1/letters?direction=received",
      "/api/v1/letters",
    ]) {
      const response = await app.inject({ url, headers: senderHeaders });
      expect(response.statusCode).toBe(200);
      auditPublicFields(response.json());
    }
    for (const suffix of ["", "/journey", "/timeline", "/map"]) {
      for (const user of [sender, recipient, outsider]) {
        const response = await app.inject({
          url: `${path}${suffix}`,
          headers: { authorization: `Bearer ${user.token}` },
        });
        const allowed = user !== outsider && (suffix !== "/journey" || user === sender);
        expect(response.statusCode).toBe(allowed ? 200 : 404);
        auditPublicFields(response.json());
        expect(response.body).not.toMatch(
          /ROBBERY|REROUTED|LOST_PATH|LETTER_DROPPED|SERIOUS_ACCIDENT/
        );
      }
      expect((await app.inject({ url: `${path}${suffix}` })).statusCode).toBe(401);
    }
    const token = `ExpoPushToken[${randomUUID().replaceAll("-", "")}]`;
    for (const method of ["POST", "DELETE"] as const) {
      const response = await app.inject({
        method,
        url: `/api/v1/push/${method === "POST" ? "register" : "unregister"}`,
        headers: senderHeaders,
        payload: method === "POST" ? { token, platform: "ios" } : { token },
      });
      expect(response.statusCode).toBe(200);
      auditPublicFields(response.json());
    }
    const block = await app.inject({
      method: "POST",
      url: `/api/v1/users/${sender.uid}/block`,
      headers: { authorization: `Bearer ${outsider.token}` },
    });
    expect(block.statusCode).toBe(200);
    auditPublicFields(block.json());
  });
});
