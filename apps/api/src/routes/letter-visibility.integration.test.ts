import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, requireTestDatabaseUrl } from "@yishu/config";
import { createPrismaClient, type PrismaClient } from "@yishu/db";
import { deterministicDraw, TestSimulationClock } from "@yishu/simulation";
import { toPublicLetterStatus, type TransportType } from "@yishu/shared";
import { buildApp } from "../app.js";
import type { FastifyInstance } from "fastify";
import { resetStationGraphCache } from "../lib/stationGraph.js";
import { advanceJourneyToNow } from "../lib/journey-advance.js";

/**
 * Phase 7 Gate（BLOCKER）全 API visibility 攻击测试。
 *
 * 冻结全局用户可见性规则：
 * - 内部 LETTER_DROPPED 完全 HIDDEN —— Letter API（Sender/Recipient list/detail）与 Timeline
 *   都不得暴露"信件掉落 / LETTER_DROPPED / 掉落"；一律投影为 public IN_TRANSIT。
 * - ROBBERY missing/dead 分支若进入 LETTER_DROPPED，任何出口也不得泄漏掉落/抢劫/死亡。
 * - Recipient 正文在 DELIVERED 前始终 null。
 */
describe("letter visibility attack", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let clock: TestSimulationClock;
  let alice: { account: string; uid: string; accessToken: string };
  let bob: { account: string; uid: string; accessToken: string };

  const T0 = new Date("2026-10-01T00:00:00Z").getTime();
  const HOUR_MS = 3600 * 1000;
  const DAY_MS = 24 * HOUR_MS;
  const FINAL_MS = T0 + DAY_MS * 200;

  const HC = {
    NORMAL: [0, 0.84] as const,
    DELAY: [0.84, 0.89] as const,
    ROBBERY: [0.95, 0.97] as const,
    LETTER_DROPPED: [0.985, 0.995] as const,
  } as const;
  const PG = { SERIOUS_ACCIDENT: [0.997, 1] as const } as const;
  const ROBBERY_BRANCH = {
    MISSING_DROPPED: [0.8, 0.95] as const,
    DEAD_DROPPED: [0.95, 1] as const,
  } as const;
  const DROP_WINDOW = {
    WITHIN_24H: [0, 0.5] as const,
    NEVER: [0.9, 1] as const,
  } as const;

  const FORBIDDEN = [/LETTER_DROPPED/gi, /letter_dropped/gi, /信件掉落/g, /掉落/gi, /遗落/gi];
  const FORBIDDEN_ROBBERY = [/robbery/gi, /抢劫/g, /dead/gi, /死亡/g, /branch/gi];

  function findSeed0(range: readonly [number, number], tag: string): string {
    for (let i = 0; i < 500000; i += 1) {
      const seed = `${tag}-${i}`;
      const d = deterministicDraw(seed, 0);
      if (d >= range[0] && d < range[1]) return seed;
    }
    throw new Error(`no seed found for ${tag}`);
  }

  function findSeed01(
    r0: readonly [number, number],
    r1: readonly [number, number],
    tag: string
  ): string {
    for (let i = 0; i < 500000; i += 1) {
      const seed = `${tag}-${i}`;
      const d0 = deterministicDraw(seed, 0);
      const d1 = deterministicDraw(seed, 1);
      if (d0 >= r0[0] && d0 < r0[1] && d1 >= r1[0] && d1 < r1[1]) return seed;
    }
    throw new Error(`no seed found for ${tag}`);
  }

  async function registerUser(payload: Record<string, string>) {
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload });
    const body = res.json();
    return { account: body.user.account, uid: body.user.uid, accessToken: body.accessToken };
  }

  async function createDispatchedLetter(
    recipient: string,
    transportType: TransportType,
    clientRequestId: string
  ): Promise<{ trackingNo: string; letterId: bigint }> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/letters",
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: { recipient, content: `content ${clientRequestId}`, transportType, clientRequestId },
    });
    const trackingNo = res.json().letter.trackingNo;
    const initRes = await app.inject({
      method: "POST",
      url: `/api/v1/letters/${trackingNo}/journey`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(initRes.statusCode).toBe(201);
    const l = await prisma.letter.findUniqueOrThrow({ where: { trackingNo } });
    return { trackingNo, letterId: l.id };
  }

  async function setSeed(letterId: bigint, seed: string): Promise<void> {
    await prisma.journey.update({ where: { letterId }, data: { simulationSeed: seed } });
  }

  /** 推进到首个 leg 完成点（drop/robbery 触发点）+ 1h，使内部进入 anomaly。 */
  async function advanceToFirstLegDone(letterId: bigint): Promise<void> {
    clock.advanceTo(T0);
    await advanceJourneyToNow(prisma, letterId, clock);
    const journey = await prisma.journey.findUniqueOrThrow({ where: { letterId } });
    const legs = await prisma.transportLeg.findMany({
      where: { journeyId: journey.id },
      orderBy: { sequence: "asc" },
    });
    const first = legs[0];
    clock.advanceTo(T0 + (first?.plannedDurationSeconds ?? 0) * 1000 + HOUR_MS);
    await advanceJourneyToNow(prisma, letterId, clock);
  }

  function getLetterDetail(trackingNo: string, token: string) {
    return app.inject({
      method: "GET",
      url: `/api/v1/letters/${trackingNo}`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  function getLetterList(direction: string, token: string) {
    return app.inject({
      method: "GET",
      url: `/api/v1/letters?direction=${direction}`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  function getTimeline(trackingNo: string, token: string) {
    return app.inject({
      method: "GET",
      url: `/api/v1/letters/${trackingNo}/timeline`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  function assertNoLeak(responses: Array<{ body: string }>): void {
    const all = responses.map((r) => r.body).join("\n");
    for (const pattern of [...FORBIDDEN, ...FORBIDDEN_ROBBERY]) {
      expect(all).not.toMatch(pattern);
    }
  }

  beforeAll(async () => {
    resetStationGraphCache();
    const testDbUrl = requireTestDatabaseUrl(process.env);
    const config = loadConfig({ NODE_ENV: "test" });
    prisma = createPrismaClient(testDbUrl);
    await prisma.timelineEvent.deleteMany();
    await prisma.worldEvent.deleteMany();
    await prisma.transportLeg.deleteMany();
    await prisma.journey.deleteMany();
    await prisma.recipientState.deleteMany();
    await prisma.senderState.deleteMany();
    await prisma.letter.deleteMany();
    await prisma.refreshToken.deleteMany();
    await prisma.block.deleteMany();
    await prisma.user.deleteMany();

    clock = new TestSimulationClock(T0);
    app = buildApp(config, { prisma, simulationClock: clock });
    await app.ready();

    const stamp = Date.now();
    alice = await registerUser({
      account: `lva_${stamp}`,
      password: "password123",
      nickname: "alice",
      province: "上海市",
      city: "上海市",
      district: "徐汇区",
    });
    bob = await registerUser({
      account: `lvb_${stamp}`,
      password: "password123",
      nickname: "bob",
      province: "北京市",
      city: "北京市",
      district: "海淀区",
    });
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it("unit：raw internal LETTER_DROPPED → public IN_TRANSIT（toPublicLetterStatus）", () => {
    expect(toPublicLetterStatus("LETTER_DROPPED")).toBe("IN_TRANSIT");
    expect(toPublicLetterStatus("IN_TRANSIT")).toBe("IN_TRANSIT");
    expect(toPublicLetterStatus("CREATED")).toBe("CREATED");
    expect(toPublicLetterStatus("COURIER_MISSING")).toBe("COURIER_MISSING");
    expect(toPublicLetterStatus("OUT_FOR_DELIVERY")).toBe("OUT_FOR_DELIVERY");
    expect(toPublicLetterStatus("DELIVERED")).toBe("DELIVERED");
    expect(toPublicLetterStatus("PERMANENTLY_LOST")).toBe("PERMANENTLY_LOST");
    expect(toPublicLetterStatus("DESTROYED")).toBe("DESTROYED");
  });

  it("内部 LETTER_DROPPED 期间：Sender/Recipient list+detail、Timeline 全部无泄漏且投影为 IN_TRANSIT", async () => {
    const seed = findSeed01(HC.LETTER_DROPPED, DROP_WINDOW.WITHIN_24H, "lva-drop");
    const { trackingNo, letterId } = await createDispatchedLetter(
      bob.uid,
      "HAND_CARRY",
      "lva-drop"
    );
    await setSeed(letterId, seed);
    await advanceToFirstLegDone(letterId);

    // 确认内部确实处于 LETTER_DROPPED
    const letter = await prisma.letter.findUniqueOrThrow({ where: { id: letterId } });
    const journey = await prisma.journey.findUniqueOrThrow({ where: { letterId } });
    expect(letter.status).toBe("LETTER_DROPPED");
    expect(journey.anomalyType).toBe("LETTER_DROPPED");

    const senderList = await getLetterList("sent", alice.accessToken);
    const senderDetail = await getLetterDetail(trackingNo, alice.accessToken);
    const recipientList = await getLetterList("received", bob.accessToken);
    const recipientDetail = await getLetterDetail(trackingNo, bob.accessToken);
    const timeline = await getTimeline(trackingNo, alice.accessToken);

    expect(senderList.statusCode).toBe(200);
    expect(senderDetail.statusCode).toBe(200);
    expect(recipientList.statusCode).toBe(200);
    expect(recipientDetail.statusCode).toBe(200);
    expect(timeline.statusCode).toBe(200);

    assertNoLeak([senderList, senderDetail, recipientList, recipientDetail, timeline]);

    // 投影后状态为 IN_TRANSIT（用户无新确认事实）
    expect(senderDetail.json().letter.status).toBe("IN_TRANSIT");
    expect(recipientDetail.json().letter.status).toBe("IN_TRANSIT");
    expect(senderList.json().letters[0]?.status).toBe("IN_TRANSIT");
    expect(recipientList.json().letters[0]?.status).toBe("IN_TRANSIT");
    // Recipient 正文仍锁定
    expect(recipientDetail.json().letter.content).toBeNull();
  });

  it("Letter refresh-frequency 双端对照：Sender + Recipient 最终 DTO 完全一致（覆盖 5 场景）", async () => {
    // 仅剔除 fixture identity（trackingNo/content/真实创建时间），**保留 deliveredAt 等运输字段**
    const normalize = (dto: {
      trackingNo: unknown;
      sentAt: unknown;
      createdAt: unknown;
      content: unknown;
    }): Record<string, unknown> => {
      const {
        trackingNo: _trackingNo,
        sentAt: _sentAt,
        createdAt: _createdAt,
        content: _content,
        ...rest
      } = dto;
      return rest;
    };

    const scenarios = [
      { name: "normal", seed: findSeed0(HC.NORMAL, "lva-fq-normal"), transport: "HAND_CARRY" },
      { name: "delay", seed: findSeed0(HC.DELAY, "lva-fq-delay"), transport: "HAND_CARRY" },
      {
        name: "drop-recovered",
        seed: findSeed01(HC.LETTER_DROPPED, DROP_WINDOW.WITHIN_24H, "lva-fq-recover"),
        transport: "HAND_CARRY",
      },
      {
        name: "permanently-lost",
        seed: findSeed01(HC.LETTER_DROPPED, DROP_WINDOW.NEVER, "lva-fq-lost"),
        transport: "HAND_CARRY",
      },
      {
        name: "destroyed",
        seed: findSeed0(PG.SERIOUS_ACCIDENT, "lva-fq-destroy"),
        transport: "PIGEON",
      },
    ] as const;

    for (const scenario of scenarios) {
      const base = `lva-fq-${scenario.name}`;
      // A：中途（首 leg 完成 / 异常期）请求 Sender + Recipient detail；B：全程不请求
      const a = await createDispatchedLetter(bob.uid, scenario.transport, `${base}-a`);
      const b = await createDispatchedLetter(bob.uid, scenario.transport, `${base}-b`);
      await setSeed(a.letterId, scenario.seed);
      await setSeed(b.letterId, scenario.seed);
      await advanceToFirstLegDone(a.letterId);
      await advanceToFirstLegDone(b.letterId);

      const aMidSender = await getLetterDetail(a.trackingNo, alice.accessToken);
      const aMidRecipient = await getLetterDetail(a.trackingNo, bob.accessToken);
      expect(aMidSender.statusCode).toBe(200);
      expect(aMidRecipient.statusCode).toBe(200);
      assertNoLeak([aMidSender, aMidRecipient]);

      clock.advanceTo(FINAL_MS);
      await advanceJourneyToNow(prisma, a.letterId, clock);
      await advanceJourneyToNow(prisma, b.letterId, clock);

      const aFinalSender = await getLetterDetail(a.trackingNo, alice.accessToken);
      const aFinalRecipient = await getLetterDetail(a.trackingNo, bob.accessToken);
      const bFinalSender = await getLetterDetail(b.trackingNo, alice.accessToken);
      const bFinalRecipient = await getLetterDetail(b.trackingNo, bob.accessToken);
      expect(aFinalSender.statusCode).toBe(200);
      expect(bFinalSender.statusCode).toBe(200);

      // Sender 双端一致 + Recipient 双端一致（含 deliveredAt / status / journey 摘要）
      expect(normalize(aFinalSender.json().letter)).toEqual(normalize(bFinalSender.json().letter));
      expect(normalize(aFinalRecipient.json().letter)).toEqual(
        normalize(bFinalRecipient.json().letter)
      );
      assertNoLeak([aFinalSender, aFinalRecipient]);

      // deliveredAt 确实参与比较（送达场景必须非 null 且两端一致）
      const aSender = aFinalSender.json().letter as { status: string; deliveredAt: string | null };
      if (aSender.status === "DELIVERED") {
        expect(aSender.deliveredAt).not.toBeNull();
        expect(aSender.deliveredAt).toBe(
          (bFinalSender.json().letter as { deliveredAt: string | null }).deliveredAt
        );
      }
      // Recipient 正文规则：未 DELIVERED 必须为 null
      const aRecipient = aFinalRecipient.json().letter as { status: string; content: unknown };
      if (aRecipient.status !== "DELIVERED") {
        expect(aRecipient.content).toBeNull();
      }
    }
  });

  it("ROBBERY missing/dead 分支（内部 LETTER_DROPPED）→ 全 API 无掉落/抢劫/死亡泄漏", async () => {
    // tag 不含敏感词（避免 content 反射进断言扫描）
    for (const [range, tag] of [
      [ROBBERY_BRANCH.MISSING_DROPPED, "lva-rob-x1"],
      [ROBBERY_BRANCH.DEAD_DROPPED, "lva-rob-x2"],
    ] as const) {
      const seed = findSeed01(HC.ROBBERY, range, tag);
      const { trackingNo, letterId } = await createDispatchedLetter(bob.uid, "HAND_CARRY", tag);
      await setSeed(letterId, seed);
      await advanceToFirstLegDone(letterId);

      const events = await prisma.worldEvent.findMany({
        where: { journeyId: (await prisma.journey.findUniqueOrThrow({ where: { letterId } })).id },
      });
      const robbery = events.find((e) => e.eventType === "ROBBERY");
      expect(robbery).toBeDefined();
      const letter = await prisma.letter.findUniqueOrThrow({ where: { id: letterId } });
      // Phase 6 语义：ROBBERY missing/dead → LETTER_DROPPED 异常（不是 COURIER_MISSING）
      expect(letter.status).toBe("LETTER_DROPPED");

      const senderList = await getLetterList("sent", alice.accessToken);
      const senderDetail = await getLetterDetail(trackingNo, alice.accessToken);
      const recipientDetail = await getLetterDetail(trackingNo, bob.accessToken);
      const timeline = await getTimeline(trackingNo, alice.accessToken);
      assertNoLeak([senderList, senderDetail, recipientDetail, timeline]);
      expect(senderDetail.json().letter.status).toBe("IN_TRANSIT");
      // Timeline 无 TRANSPORT_DELAYED（ROBBERY 不间接产生延误事实）
      const t = timeline.json().timeline as Array<{ type: string }>;
      expect(t.some((e) => e.type === "TRANSPORT_DELAYED")).toBe(false);
    }
  });

  it("TimelineEventType enum 不存在 LETTER_DROPPED（用户可见结构层无泄漏）", async () => {
    const schema = await prisma.$queryRaw<Array<{ enumlabel: string }>>`
      SELECT enumlabel FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'TimelineEventType'`;
    const labels = schema.map((r) => r.enumlabel);
    expect(labels).not.toContain("LETTER_DROPPED");
  });
});
