import path from "node:path";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, requireTestDatabaseUrl, resolveRepoRoot } from "@yishu/config";
import { createPrismaClient, type PrismaClient } from "@yishu/db";
import { advanceJourneyToNow, materializeVisibleTimeline } from "@yishu/domain";
import { resetStationGraphCache } from "../lib/stationGraph.js";
import { deterministicDraw, TestSimulationClock } from "@yishu/simulation";
import { TRANSPORT_TYPES, type TransportType } from "@yishu/shared";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";

// The real assets stay frozen; only this isolated test process selects the candidate bundle.
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      const result = fs.readFileSync(...args);
      if (String(args[0]).endsWith(path.join("graphs", "registry.json"))) {
        const registry = JSON.parse(String(result));
        return JSON.stringify({
          versions: [...registry.versions, "china-v3"],
          defaultVersion: "china-v3",
        });
      }
      return result;
    },
  };
});

const T0 = Date.UTC(2026, 9, 6, 0);
const HOUR = 3600000;
const origin = { province: "安徽省", city: "滁州市", district: "琅琊区" };
const localTarget = { ...origin, district: "南谯区" };
const distantTarget = { province: "上海市", city: "上海市", district: "浦东新区" };
const candidateRegions = JSON.parse(
  readFileSync(path.join(resolveRepoRoot(), "data/regions/canonical-candidate.json"), "utf8")
) as { regions: Array<typeof origin & { code: string }> };
function candidateRegion(code: string): typeof origin {
  const region = candidateRegions.regions.find((row) => row.code === code);
  if (!region) throw new Error(`missing_candidate_region:${code}`);
  return { province: region.province, city: region.city, district: region.district };
}

describe("candidate graph with district collection rule 1.1", () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let clock: TestSimulationClock;
  let sender: { id: bigint; uid: string; token: string };
  let recipient: typeof sender;
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    resetStationGraphCache();
    prisma = createPrismaClient(requireTestDatabaseUrl(process.env));
    clock = new TestSimulationClock(T0);
    app = buildApp(loadConfig({ NODE_ENV: "test", NEW_LETTER_RULES_VERSION: "1.1" }), {
      prisma,
      simulationClock: clock,
    });
    const suffix = Math.random().toString(36).slice(2, 8);
    async function register(prefix: string, region: typeof origin) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/register",
        payload: {
          account: prefix + suffix,
          nickname: prefix,
          password: "candidate-graph-test-password",
          ...region,
        },
      });
      expect(response.statusCode).toBe(201);
      const uid = response.json().user.uid;
      const user = await prisma.user.findUniqueOrThrow({ where: { uid } });
      return { id: user.id, uid, token: response.json().accessToken as string };
    }
    sender = await register("cgs", origin);
    recipient = await register("cgr", localTarget);
  });

  beforeEach(async () => {
    clock.advanceTo(T0);
    await prisma.letter.deleteMany({ where: { senderId: sender.id } });
    await prisma.user.update({ where: { id: sender.id }, data: origin });
    await prisma.user.update({ where: { id: recipient.id }, data: localTarget });
  });

  afterAll(async () => {
    if (app) await app.close();
    const ids = [sender?.id, recipient?.id].filter((id): id is bigint => id !== undefined);
    if (prisma) {
      await prisma.letter.deleteMany({ where: { senderId: { in: ids } } });
      await prisma.refreshToken.deleteMany({ where: { userId: { in: ids } } });
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
      await prisma.$disconnect();
    }
    resetStationGraphCache();
  });

  async function send(
    clientRequestId = `cg-${Math.random()}`,
    initializeNow = true,
    transportType: TransportType = "PIGEON",
    simulationSeed?: string
  ) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/letters",
      headers: auth(sender.token),
      payload: {
        recipient: recipient.uid,
        content: "candidate private body",
        transportType,
        clientRequestId,
      },
    });
    expect(response.statusCode).toBe(201);
    const trackingNo = response.json().letter.trackingNo;
    if (simulationSeed)
      await prisma.letter.update({ where: { trackingNo }, data: { simulationSeed } });
    if (initializeNow) {
      const initialize = await app.inject({
        method: "POST",
        url: `/api/v1/letters/${trackingNo}/journey`,
        headers: auth(sender.token),
      });
      expect(initialize.statusCode).toBe(201);
    }
    return prisma.letter.findUniqueOrThrow({ where: { trackingNo }, include: { journey: true } });
  }

  async function map(trackingNo: string, token = sender.token) {
    const response = await app.inject({
      url: `/api/v1/letters/${trackingNo}/map`,
      headers: auth(token),
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  }

  it("routes same-city mail through the new local hub, then delivers at exactly nine hours", async () => {
    const letter = await send();
    expect(letter).toMatchObject({ graphVersion: "china-v3", rulesVersion: "1.1" });
    expect(letter.journey).toMatchObject({
      originNodeId: "city-341100",
      destinationNodeId: "city-341100",
      originStationReadyAtSim: new Date(T0 + 3 * HOUR),
    });
    const sent = await map(letter.trackingNo);
    expect(sent.collection.from.district).toBe("琅琊区");
    expect(sent.collection.to.city).toBe("滁州市");
    expect(sent.delivery.from.city).toBe("滁州市");
    expect(sent.delivery.to.district).toBe("南谯区");
    expect(JSON.stringify(sent.stations)).not.toContain("合肥");
    const before = await map(letter.trackingNo, recipient.token);
    expect(before.collection).toBeNull();
    expect(before.delivery).toBeNull();
    clock.advanceTo(T0 + 3 * HOUR);
    await advanceJourneyToNow(prisma, letter.id, clock);
    expect((await prisma.letter.findUniqueOrThrow({ where: { id: letter.id } })).status).toBe(
      "OUT_FOR_DELIVERY"
    );
    clock.advanceTo(T0 + 9 * HOUR - 1);
    await advanceJourneyToNow(prisma, letter.id, clock);
    expect(
      (await prisma.letter.findUniqueOrThrow({ where: { id: letter.id } })).deliveredAt
    ).toBeNull();
    clock.advanceTo(T0 + 9 * HOUR);
    await advanceJourneyToNow(prisma, letter.id, clock);
    expect(
      (await prisma.letter.findUniqueOrThrow({ where: { id: letter.id } })).deliveredAt
    ).toEqual(new Date(T0 + 9 * HOUR));
    expect((await map(letter.trackingNo, recipient.token)).delivery.state).toBe("COMPLETED");
  });

  it.each([
    { name: "Shanghai Huangpu to Pudong", from: "310101", to: "310115" },
    { name: "Hangzhou Shangcheng to Yuhang", from: "330102", to: "330110" },
    { name: "Chongqing Liangjiang to Yongchuan", from: "500157", to: "500118" },
    { name: "direct-admin Caohu local mail", from: "659013", to: "659013" },
  ])(
    "$name: candidate endpoints retain both timed segments and content gates",
    async ({ from, to }) => {
      const originRegion = candidateRegion(from);
      const targetRegion = candidateRegion(to);
      for (const [owner, region] of [
        [sender, originRegion],
        [recipient, targetRegion],
      ] as const) {
        const profile = await app.inject({
          method: "PATCH",
          url: "/api/v1/users/me",
          headers: auth(owner.token),
          payload: { region },
        });
        expect(profile.statusCode).toBe(200);
      }
      const letter = await send();
      expect(letter).toMatchObject({ graphVersion: "china-v3", rulesVersion: "1.1" });
      expect(letter.journey!.originNodeId).toBe(letter.journey!.destinationNodeId);
      expect(letter.journey!.originStationReadyAtSim).toEqual(new Date(T0 + 3 * HOUR));
      const sent = await map(letter.trackingNo);
      expect(sent.districtLocationsUnavailable).toEqual([]);
      expect(sent.collection).toMatchObject({
        from: originRegion,
        to: { city: originRegion.city },
        state: "IN_PROGRESS",
      });
      expect(sent.delivery).toMatchObject({
        from: { city: targetRegion.city },
        to: targetRegion,
        state: "PLANNED",
      });
      for (const connection of [sent.collection, sent.delivery]) {
        expect(
          Math.max(
            Math.abs(connection.from.x - connection.to.x),
            Math.abs(connection.from.y - connection.to.y)
          )
        ).toBeGreaterThanOrEqual(0.000002);
      }
      const before = await map(letter.trackingNo, recipient.token);
      expect(before.collection).toBeNull();
      expect(before.delivery).toBeNull();
      expect(before.remainingPath).toEqual([]);
      const detail = async () =>
        app.inject({
          url: `/api/v1/letters/${letter.trackingNo}`,
          headers: auth(recipient.token),
        });
      expect((await detail()).json().letter.content).toBeNull();
      clock.advanceTo(T0 + 3 * HOUR);
      await advanceJourneyToNow(prisma, letter.id, clock);
      const dispatching = await map(letter.trackingNo);
      expect(dispatching.collection.state).toBe("COMPLETED");
      expect(dispatching.delivery.state).toBe("IN_PROGRESS");
      expect((await detail()).json().letter.content).toBeNull();
      clock.advanceTo(T0 + 9 * HOUR);
      await advanceJourneyToNow(prisma, letter.id, clock);
      expect(
        (await prisma.letter.findUniqueOrThrow({ where: { id: letter.id } })).deliveredAt
      ).toEqual(new Date(T0 + 9 * HOUR));
      const received = await map(letter.trackingNo, recipient.token);
      expect(received.delivery).toMatchObject({ to: targetRegion, state: "COMPLETED" });
      expect(received.remainingPath).toEqual([]);
      expect((await detail()).json().letter.content).toBe("candidate private body");
    }
  );

  it("starts intercity mail at the local hub after collection, not at the province capital", async () => {
    await prisma.user.update({ where: { id: recipient.id }, data: distantTarget });
    const letter = await send();
    expect(letter.journey).toMatchObject({
      originNodeId: "city-341100",
      destinationNodeId: "shanghai",
    });
    const legs = await prisma.transportLeg.findMany({ where: { journeyId: letter.journey!.id } });
    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({
      fromNodeId: "city-341100",
      toNodeId: "shanghai",
      status: "PLANNED",
    });
    clock.advanceTo(T0 + 3 * HOUR - 1);
    await advanceJourneyToNow(prisma, letter.id, clock);
    expect(
      (await prisma.transportLeg.findUniqueOrThrow({ where: { id: legs[0]!.id } })).startedAtSim
    ).toBeNull();
    clock.advanceTo(T0 + 3 * HOUR);
    await advanceJourneyToNow(prisma, letter.id, clock);
    expect(
      (await prisma.transportLeg.findUniqueOrThrow({ where: { id: legs[0]!.id } })).startedAtSim
    ).toEqual(new Date(T0 + 3 * HOUR));
    const sent = await map(letter.trackingNo);
    expect(sent.collection.state).toBe("COMPLETED");
    expect(sent.delivery).toMatchObject({
      state: "PLANNED",
      from: { city: "上海市" },
      to: { district: "浦东新区" },
    });
    const received = await map(letter.trackingNo, recipient.token);
    expect(received.remainingPath).toEqual([]);
    expect(received.destination).toBeNull();
    expect(JSON.stringify(received)).not.toContain("浦东新区");
  });

  it.each([1, 4, 20])(
    "preserves causal history when the recipient edits an uninitialized letter at hour %s",
    async (editHour) => {
      const letter = await send(`delayed-${Math.random()}`, false);
      expect(letter.journey).toBeNull();
      clock.advanceTo(T0 + editHour * HOUR);
      const response = await app.inject({
        method: "PATCH",
        url: "/api/v1/users/me",
        headers: auth(recipient.token),
        payload: { region: distantTarget },
      });
      expect(response.statusCode).toBe(200);
      const updated = await prisma.letter.findUniqueOrThrow({
        where: { id: letter.id },
        include: { journey: { include: { destinationChanges: true } } },
      });
      expect(updated.journey).not.toBeNull();
      if (editHour === 20) {
        expect(updated).toMatchObject({
          status: "DELIVERED",
          targetCity: "滁州市",
          targetDistrict: "南谯区",
          deliveredAt: new Date(T0 + 9 * HOUR),
        });
        expect(updated.journey!.destinationChanges).toEqual([]);
      } else {
        expect(updated.deliveredAt).toBeNull();
        expect(updated.journey!.destinationChanges).toHaveLength(1);
        expect(updated.journey!.destinationChanges[0]).toMatchObject({
          requestedAtSim: new Date(T0 + editHour * HOUR),
          previousTargetCity: "滁州市",
          previousTargetDistrict: "南谯区",
          targetCity: "上海市",
          targetDistrict: "浦东新区",
        });
        const detail = await app.inject({
          url: `/api/v1/letters/${letter.trackingNo}`,
          headers: auth(recipient.token),
        });
        expect(detail.json().letter.content).toBeNull();
      }
      const retry = await app.inject({
        method: "POST",
        url: `/api/v1/letters/${letter.trackingNo}/journey`,
        headers: auth(sender.token),
      });
      expect(retry.statusCode).toBe(200);
      expect(await prisma.journey.count({ where: { letterId: letter.id } })).toBe(1);
    }
  );

  it.each(
    TRANSPORT_TYPES.flatMap((transportType) =>
      [0, 1, 2].map((sample) => ({ transportType, sample }))
    )
  )(
    "$transportType seed $sample: new-graph 1.1 replay preserves collection, facts and retry determinism",
    async ({ transportType, sample }) => {
      await prisma.user.update({ where: { id: recipient.id }, data: distantTarget });
      const seed = `city-graph-1.1-${transportType}-${sample}`;
      const jumped = await send(`jump-${Math.random()}`, true, transportType, seed);
      const stepped = await send(`step-${Math.random()}`, true, transportType, seed);
      await advanceJourneyToNow(prisma, stepped.id, new TestSimulationClock(T0 + 3 * HOUR - 1));
      const beforeCollection = await prisma.journey.findUniqueOrThrow({
        where: { letterId: stepped.id },
        include: { legs: true },
      });
      expect(beforeCollection.legs.every((leg) => leg.startedAtSim === null)).toBe(true);
      const YEAR = 365 * 24 * HOUR;
      await advanceJourneyToNow(prisma, jumped.id, new TestSimulationClock(T0 + YEAR));
      const offsets = [
        3 * HOUR,
        ...Array.from({ length: 24 }, (_, index) =>
          Math.floor(deterministicDraw(`${seed}-schedule`, index) * YEAR)
        ).filter((offset) => offset >= 3 * HOUR),
        YEAR,
      ].sort((a, b) => a - b);
      for (const offset of offsets) {
        await advanceJourneyToNow(prisma, stepped.id, new TestSimulationClock(T0 + offset));
        expect(
          (await advanceJourneyToNow(prisma, stepped.id, new TestSimulationClock(T0 + offset)))
            .changed
        ).toBe(false);
        expect(
          (await advanceJourneyToNow(prisma, stepped.id, new TestSimulationClock(T0 + offset - 1)))
            .changed
        ).toBe(false);
      }
      const omit = (row: object, keys: string[]) =>
        Object.fromEntries(Object.entries(row).filter(([key]) => !keys.includes(key)));
      const snapshot = async (id: bigint) => {
        const letter = await prisma.letter.findUniqueOrThrow({ where: { id } });
        const journey = await prisma.journey.findUniqueOrThrow({
          where: { letterId: id },
          include: {
            legs: { orderBy: { sequence: "asc" } },
            worldEvents: { orderBy: { eventIndex: "asc" } },
          },
        });
        return {
          letter: {
            status: letter.status,
            deliveredAt: letter.deliveredAt,
            currentTransport: letter.currentTransport,
            targetProvince: letter.targetProvince,
            targetCity: letter.targetCity,
            targetDistrict: letter.targetDistrict,
          },
          journey: omit(journey, [
            "id",
            "letterId",
            "createdAt",
            "updatedAt",
            "legs",
            "worldEvents",
          ]),
          legs: journey.legs.map((row) => omit(row, ["id", "journeyId", "createdAt", "updatedAt"])),
          events: journey.worldEvents.map((row) => omit(row, ["id", "journeyId", "createdAt"])),
          timeline: (await materializeVisibleTimeline(prisma, id, T0 + YEAR)).map((row) =>
            omit(row, ["id", "letterId", "createdAt"])
          ),
        };
      };
      expect(await snapshot(stepped.id)).toEqual(await snapshot(jumped.id));
      const finished = await prisma.journey.findUniqueOrThrow({
        where: { letterId: stepped.id },
        include: { legs: true },
      });
      expect(finished).toMatchObject({ graphVersion: "china-v3", rulesVersion: "1.1" });
      expect(finished.legs.filter((leg) => leg.status === "ACTIVE").length).toBeLessThanOrEqual(1);
      expect(
        finished.legs.every(
          (leg) => !leg.startedAtSim || leg.startedAtSim.getTime() >= T0 + 3 * HOUR
        )
      ).toBe(true);
      clock.advanceTo(T0 + YEAR);
      const received = await map(stepped.trackingNo, recipient.token);
      expect(received.remainingPath).toEqual([]);
      expect(JSON.stringify(received)).not.toMatch(/simulationSeed|nextRandomDrawIndex|etaSeconds/);
    }
  );

  it("handles sixty uninitialized letters and a concurrent initializer without rewriting delivered targets", async () => {
    const old = [];
    const recent = [];
    for (let index = 0; index < 30; index++) old.push(await send(`old-${Math.random()}`, false));
    clock.advanceTo(T0 + 18 * HOUR);
    for (let index = 0; index < 30; index++)
      recent.push(await send(`recent-${Math.random()}`, false));
    clock.advanceTo(T0 + 20 * HOUR);
    const startedAt = performance.now();
    const [patch, initialize] = await Promise.all([
      app.inject({
        method: "PATCH",
        url: "/api/v1/users/me",
        headers: auth(recipient.token),
        payload: { region: distantTarget },
      }),
      app.inject({
        method: "POST",
        url: `/api/v1/letters/${recent[0]!.trackingNo}/journey`,
        headers: auth(sender.token),
      }),
    ]);
    const elapsedMs = Math.round(performance.now() - startedAt);
    expect(patch.statusCode).toBe(200);
    expect([200, 201]).toContain(initialize.statusCode);
    expect(elapsedMs).toBeLessThan(25000);
    const letters = await prisma.letter.findMany({
      where: { senderId: sender.id },
      include: { journey: { include: { destinationChanges: true } } },
    });
    expect(letters).toHaveLength(60);
    const oldIds = new Set(old.map((letter) => letter.id));
    for (const letter of letters) {
      expect(letter.journey).not.toBeNull();
      if (oldIds.has(letter.id)) {
        expect(letter).toMatchObject({
          status: "DELIVERED",
          targetCity: localTarget.city,
          targetDistrict: localTarget.district,
          deliveredAt: new Date(T0 + 9 * HOUR),
        });
        expect(letter.journey!.destinationChanges).toEqual([]);
      } else {
        expect(letter.deliveredAt).toBeNull();
        expect(letter.targetCity).toBe(distantTarget.city);
        expect(letter.journey!.originStationReadyAtSim).toEqual(new Date(T0 + 21 * HOUR));
        expect(letter.journey!.destinationChanges).toHaveLength(1);
        expect(letter.journey!.destinationChanges[0]!.requestedAtSim).toEqual(
          new Date(T0 + 20 * HOUR)
        );
      }
    }
    expect(
      await prisma.journey.count({
        where: { letterId: { in: letters.map((letter) => letter.id) } },
      })
    ).toBe(60);
    console.info(JSON.stringify({ check: "profile_backlog_1_1", letters: 60, elapsedMs }));
  });

  it.each([
    ["origin", { ...origin, district: "开发区" }],
    ["destination", { ...localTarget, district: "不存在区" }],
    ["destination", { province: "重庆市", city: "重庆市", district: "江北区" }],
    ["destination", { province: "福建省", city: "泉州市", district: "金门县" }],
    ["destination", { province: "海南省", city: "三沙市", district: "南沙区" }],
  ] as const)(
    "rejects an unavailable %s endpoint before creating mail or estimates",
    async (endpoint, region) => {
      const owner = endpoint === "origin" ? sender : recipient;
      await prisma.user.update({ where: { id: owner.id }, data: region });
      const expectedError = {
        error:
          region.district === "金门县" || region.city === "三沙市"
            ? "region_service_unavailable"
            : `${endpoint}_region_unavailable`,
      };
      const estimate = await app.inject({
        method: "POST",
        url: "/api/v1/transport-estimates",
        headers: auth(sender.token),
        payload: { recipient: recipient.uid },
      });
      expect(estimate.statusCode).toBe(422);
      expect(estimate.json()).toEqual(expectedError);
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/letters",
        headers: auth(sender.token),
        payload: {
          recipient: recipient.uid,
          content: "unavailable endpoint",
          transportType: "PIGEON",
          clientRequestId: `invalid-${Math.random()}`,
        },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toEqual(expectedError);
      expect(await prisma.letter.count({ where: { senderId: sender.id } })).toBe(0);
      expect(await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).toMatchObject(
        region
      );
    }
  );

  it("preserves a previously created letter and its idempotent retry after a profile becomes unsupported", async () => {
    const clientRequestId = `retry-${Math.random()}`;
    const letter = await send(clientRequestId);
    await prisma.user.update({ where: { id: sender.id }, data: { district: "开发区" } });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/letters",
      headers: auth(sender.token),
      payload: {
        recipient: recipient.uid,
        content: "candidate private body",
        transportType: "PIGEON",
        clientRequestId,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().letter.trackingNo).toBe(letter.trackingNo);
    const unchanged = await prisma.letter.findUniqueOrThrow({ where: { id: letter.id } });
    expect(unchanged.originDistrict).toBe("琅琊区");
    expect(unchanged.rulesVersion).toBe("1.1");
    expect(await prisma.letter.count({ where: { senderId: sender.id } })).toBe(1);
  });

  it("rejects an unsupported destination change for 1.1 mail without changing the profile or history", async () => {
    const letter = await send();
    const before = await prisma.letter.findUniqueOrThrow({
      where: { id: letter.id },
      include: { journey: true },
    });
    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/users/me",
      headers: auth(recipient.token),
      payload: {
        region: { ...localTarget, district: "开发区" },
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: "destination_region_unavailable" });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: recipient.id } })).toMatchObject(
      localTarget
    );
    expect(
      await prisma.letter.findUniqueOrThrow({
        where: { id: letter.id },
        include: { journey: true },
      })
    ).toEqual(before);
    expect(await prisma.destinationChange.count({ where: { journeyId: letter.journey!.id } })).toBe(
      0
    );
  });
});
