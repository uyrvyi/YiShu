import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { loadConfig, requireTestDatabaseUrl } from "@yishu/config";
import { createPrismaClient, type PrismaClient } from "@yishu/db";
import { deterministicDraw, TestSimulationClock } from "@yishu/simulation";
import { LAST_MILE_DURATION_SECONDS, TRANSPORT_TYPES, plannedDurationSeconds } from "@yishu/shared";
import { buildApp } from "../app.js";
import { planRoute, resolveStationForRegion, getDefaultGraphVersion } from "../lib/stationGraph.js";
import { advanceJourneyToNow } from "../lib/journey-advance.js";

describe("sender advisory estimates", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  const clock = new TestSimulationClock(Date.UTC(2026, 8, 30));
  let sender: { id: bigint; uid: string; token: string };
  let recipient: typeof sender;
  let stranger: typeof sender;
  const ids: bigint[] = [];
  const origin = { province: "上海市", city: "上海市", district: "徐汇区" };
  const target = { province: "北京市", city: "北京市", district: "海淀区" };
  const headers = (token: string) => ({ authorization: `Bearer ${token}` });
  const preview = (
    payload: Record<string, string> = { recipient: recipient.uid },
    token = sender.token
  ) =>
    app.inject({
      method: "POST",
      url: "/api/v1/transport-estimates",
      headers: headers(token),
      payload,
    });

  beforeAll(async () => {
    prisma = createPrismaClient(requireTestDatabaseUrl(process.env));
    app = buildApp(loadConfig({ NODE_ENV: "test" }), { prisma, simulationClock: clock });
    await app.ready();
    const create = async (region: typeof origin) => {
      const user = await prisma.user.create({
        data: {
          ...region,
          uid: String(10000000 + Math.floor(Math.random() * 90000000)),
          account: `eta_${randomUUID().slice(0, 8)}`,
          nickname: "eta-test",
          passwordHash: "not-used",
        },
      });
      ids.push(user.id);
      return { id: user.id, uid: user.uid, token: app.jwt.sign({ sub: user.uid }) };
    };
    sender = await create(origin);
    recipient = await create(target);
    stranger = await create(origin);
  });
  afterAll(async () => {
    await prisma.letter.deleteMany({ where: { senderId: { in: ids } } });
    await prisma.block.deleteMany({ where: { blockerId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await app.close();
    await prisma.$disconnect();
  });

  it("四种时长按现有路网规则加末端派送计算，预览不创建信件或世界事件", async () => {
    const before = [
      await prisma.letter.count(),
      await prisma.journey.count(),
      await prisma.worldEvent.count(),
    ];
    const response = await preview();
    expect(response.statusCode).toBe(200);
    const graphVersion = getDefaultGraphVersion();
    expect(response.json().estimates).toEqual(
      TRANSPORT_TYPES.map((transportType) => {
        const route = planRoute({
          graphVersion,
          transportType,
          originNodeId: resolveStationForRegion(origin, graphVersion),
          destinationNodeId: resolveStationForRegion(target, graphVersion),
        });
        return {
          transportType,
          distanceKm: Math.round(route.totalDistanceKm * 10) / 10,
          durationSeconds: Math.ceil(
            route.edges.reduce(
              (total, edge) =>
                total + plannedDurationSeconds("1.0", edge.transportType, edge.distanceKm),
              LAST_MILE_DURATION_SECONDS
            )
          ),
        };
      })
    );
    expect([
      await prisma.letter.count(),
      await prisma.journey.count(),
      await prisma.worldEvent.count(),
    ]).toEqual(before);
    expect(
      (await preview({ recipient: stranger.uid }))
        .json()
        .estimates.every(
          (item: { durationSeconds: number }) => item.durationSeconds === LAST_MILE_DURATION_SECONDS
        )
    ).toBe(true);
  });

  it("未认证、非法输入、不存在用户、拉黑和未知地区安全失败", async () => {
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/transport-estimates",
          payload: { recipient: recipient.uid },
        })
      ).statusCode
    ).toBe(401);
    expect((await preview({ recipient: "x" })).statusCode).toBe(400);
    expect((await preview({ recipient: "nonexistent_eta_user" })).statusCode).toBe(404);
    const block = await prisma.block.create({
      data: { blockerId: recipient.id, blockedId: sender.id },
    });
    expect((await preview()).statusCode).toBe(403);
    await prisma.block.delete({ where: { id: block.id } });
    await prisma.user.update({
      where: { id: recipient.id },
      data: { province: "未知省", city: "未知市", district: "未知区" },
    });
    expect((await preview()).statusCode).toBe(422);
    await prisma.user.update({ where: { id: recipient.id }, data: target });
  });

  it("下一站预估只允许寄件人，不泄漏隐藏字段或推进世界", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/letters",
      headers: headers(sender.token),
      payload: {
        recipient: recipient.uid,
        content: "test",
        transportType: "PIGEON",
        clientRequestId: randomUUID(),
      },
    });
    expect(created.statusCode).toBe(201);
    const trackingNo = created.json().letter.trackingNo;
    const url = `/api/v1/letters/${trackingNo}/estimate`;
    expect((await app.inject({ url, headers: headers(sender.token) })).json().state).toBe(
      "UNAVAILABLE"
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/letters/${trackingNo}/journey`,
          headers: headers(sender.token),
        })
      ).statusCode
    ).toBe(201);
    const letter = await prisma.letter.findUniqueOrThrow({ where: { trackingNo } });
    await prisma.letter.update({
      where: { id: letter.id },
      data: { sentAt: new Date(clock.now()) },
    });
    let seed = "";
    for (let i = 0; i < 100; i++)
      if (deterministicDraw(`eta-${i}`, 0) < 0.92) {
        seed = `eta-${i}`;
        break;
      }
    await prisma.journey.update({ where: { letterId: letter.id }, data: { simulationSeed: seed } });
    await advanceJourneyToNow(prisma, letter.id, clock);
    clock.advanceTo(clock.now() + 1000);
    const snapshot = async () => ({
      journey: await prisma.journey.findUnique({
        where: { letterId: letter.id },
        include: { legs: true, worldEvents: true },
      }),
      letter: await prisma.letter.findUnique({ where: { id: letter.id } }),
    });
    const before = await snapshot();
    const response = await app.inject({ url, headers: headers(sender.token) });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      state: "ON_THE_WAY",
      remainingSeconds: expect.any(Number),
    });
    expect(Object.keys(response.json()).sort()).toEqual(["asOf", "remainingSeconds", "state"]);
    expect(await snapshot()).toEqual(before);
    for (const token of [recipient.token, stranger.token]) {
      expect((await app.inject({ url, headers: headers(token) })).statusCode).toBe(404);
    }
    expect((await app.inject({ url })).statusCode).toBe(401);
  });
});
