import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, requireTestDatabaseUrl } from "@yishu/config";
import { createPrismaClient, type PrismaClient } from "@yishu/db";
import { deterministicDraw, TestSimulationClock } from "@yishu/simulation";
import { DELAY_MAX_SECONDS, type TransportType } from "@yishu/shared";
import { buildApp } from "../app.js";
import type { FastifyInstance } from "fastify";
import { resetStationGraphCache } from "../lib/stationGraph.js";
import { advanceJourneyToNow, setWorldEventPersistFaultForTest } from "../lib/journey-advance.js";
import { isTimelineUniqueConflict } from "../lib/timeline.js";

/**
 * Phase 7 Timeline 集成测试（仅 *_test 库）。
 *
 * 冻结规则（项目负责人 2026-09-08）：
 * - IMMEDIATE：DELAYED / COURIER_MISSING / RECOVERED / TRANSPORT_CHANGED
 * - HIDDEN：ROBBERY / REROUTED / LOST_PATH / LETTER_DROPPED / SERIOUS_ACCIDENT
 * - World Truth 双事件：LOST_PATH transition 同时记录 `WorldEvent.LOST_PATH`（HIDDEN cause）
 *   与唯一 canonical `WorldEvent.COURIER_MISSING`；Timeline 只消费 canonical，不按 cause 猜测
 * - 随机游标与事件编号解耦：记录派生事实（含 canonical）**不得消费 deterministic random draw**
 * - terminal：PERMANENTLY_LOST / DESTROYED 只表达结果，不说明原因
 *
 * 核心不变量：refresh-frequency independence —— late GET 与 many GET 最终 DB/DTO 全等。
 */
describe("timeline integration", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let clock: TestSimulationClock;
  let alice: { account: string; uid: string; accessToken: string };
  let bob: { account: string; uid: string; accessToken: string };
  let carol: { account: string; uid: string; accessToken: string };

  const T0 = new Date("2026-10-01T00:00:00Z").getTime();
  const HOUR_MS = 3600 * 1000;
  const DAY_MS = 24 * HOUR_MS;
  /** 所有 late/many 场景共用的最终模拟时刻。 */
  const FINAL_MS = T0 + DAY_MS * 200;

  const HC = {
    NORMAL: [0, 0.84] as const,
    DELAY: [0.84, 0.89] as const,
    REROUTE: [0.89, 0.93] as const,
    LOST_PATH: [0.93, 0.95] as const,
    ROBBERY: [0.95, 0.97] as const,
    COURIER_MISSING: [0.97, 0.985] as const,
    LETTER_DROPPED: [0.985, 0.995] as const,
  } as const;
  const PG = {
    LOST_PATH: [0.97, 0.985] as const,
    SERIOUS_ACCIDENT: [0.997, 1] as const,
  } as const;
  const ROBBERY_BRANCH = { ESCAPE_DELAY: [0, 0.55] as const } as const;
  const DROP_WINDOW = { WITHIN_24H: [0, 0.5] as const, NEVER: [0.9, 1] as const } as const;

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

  /** drop + 恢复窗口 + 恢复后运输方式变更（draw 顺序：0=primary 1=window 4=transport）。 */
  function findDropRecoverTransportChangeSeed(tag: string): string {
    for (let i = 0; i < 1000000; i += 1) {
      const s = `${tag}-${i}`;
      const d0 = deterministicDraw(s, 0);
      const d1 = deterministicDraw(s, 1);
      const d4 = deterministicDraw(s, 4);
      if (
        d0 >= HC.LETTER_DROPPED[0] &&
        d0 < HC.LETTER_DROPPED[1] &&
        d1 >= DROP_WINDOW.WITHIN_24H[0] &&
        d1 < DROP_WINDOW.WITHIN_24H[1] &&
        d4 >= 0 &&
        d4 < 0.6
      ) {
        return s;
      }
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

  /**
   * 冻结两封信的寄出时刻为同一值：保证 late/many 两封信的 DISPATCHED 事实完全一致
   * （否则 sentAt/createdAt 差异会让 snapshot 不可比）。
   */
  async function freezeSentAt(letterId: bigint): Promise<void> {
    await prisma.letter.update({ where: { id: letterId }, data: { sentAt: new Date(T0) } });
  }

  function getTimeline(trackingNo: string, token: string) {
    return app.inject({
      method: "GET",
      url: `/api/v1/letters/${trackingNo}/timeline`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  async function timelineOf(trackingNo: string, token: string) {
    const res = await getTimeline(trackingNo, token);
    expect(res.statusCode).toBe(200);
    return res.json().timeline as Array<{
      type: string;
      title: string;
      description: string;
      location: { province: string; city: string };
      happenedAt: string;
    }>;
  }

  function typesOf(timeline: Array<{ type: string }>): string[] {
    return timeline.map((e) => e.type);
  }

  async function journeyOf(letterId: bigint) {
    return prisma.journey.findUniqueOrThrow({ where: { letterId } });
  }

  function canonicalizePayload(payload: unknown): unknown {
    if (payload === null || typeof payload !== "object") return payload;
    if (Array.isArray(payload)) return payload.map(canonicalizePayload);
    const obj = payload as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) out[key] = canonicalizePayload(obj[key]);
    return out;
  }

  /**
   * 统一 canonical Timeline DB 快照（Gate：late/many 全等比较的单一事实来源）。
   * 排除 auto id 与 createdAt/updatedAt；数组按 API 相同 comparator 排序。
   */
  async function canonicalTimelineSnapshot(letterId: bigint) {
    const rows = await prisma.timelineEvent.findMany({
      where: { letterId },
      orderBy: [{ happenedAt: "asc" }, { sequence: "asc" }, { sourceKey: "asc" }],
    });
    return rows.map((r) => ({
      sourceKey: r.sourceKey,
      sequence: r.sequence,
      type: r.type,
      title: r.title,
      description: r.description,
      province: r.province,
      city: r.city,
      district: r.district,
      nodeId: r.nodeId,
      happenedAt: r.happenedAt.getTime(),
      visibleAt: r.visibleAt.getTime(),
      importance: r.importance,
      metadata: canonicalizePayload(r.metadata),
    }));
  }

  /** Phase 6 World Truth 快照（验证 materialization 不修改世界真相）。 */
  async function worldSnapshot(letterId: bigint) {
    const letter = await prisma.letter.findUniqueOrThrow({ where: { id: letterId } });
    const journey = await prisma.journey.findUniqueOrThrow({ where: { letterId } });
    const legs = await prisma.transportLeg.findMany({
      where: { journeyId: journey.id },
      orderBy: { sequence: "asc" },
    });
    const events = await prisma.worldEvent.findMany({
      where: { journeyId: journey.id },
      orderBy: { eventIndex: "asc" },
    });
    return {
      letterStatus: letter.status,
      deliveredAt: letter.deliveredAt?.getTime() ?? null,
      sentAt: letter.sentAt?.getTime() ?? null,
      journey: {
        status: journey.status,
        startedAtSim: journey.startedAtSim?.getTime() ?? null,
        lastAdvancedAtSim: journey.lastAdvancedAtSim?.getTime() ?? null,
        nextRandomDrawIndex: journey.nextRandomDrawIndex,
        nextWorldEventIndex: journey.nextWorldEventIndex,
        anomalyType: journey.anomalyType,
      },
      legs: legs.map((l) => ({
        sequence: l.sequence,
        status: l.status,
        fromNodeId: l.fromNodeId,
        toNodeId: l.toNodeId,
        startedAtSim: l.startedAtSim?.getTime() ?? null,
        completedAtSim: l.completedAtSim?.getTime() ?? null,
      })),
      events: events.map((e) => ({
        eventIndex: e.eventIndex,
        eventType: e.eventType,
        occurredAtSim: e.occurredAtSim.getTime(),
        nodeId: e.nodeId,
      })),
    };
  }

  /**
   * 运行一个 late/many 场景：
   * - "late"：运输全过程不请求 timeline，最终 now 只 GET 一次
   * - "many"：多个 progression 点都请求 timeline，最终推进到同一 now 再 GET
   */
  async function runFrequencyScenario(
    seed: string,
    transportType: TransportType,
    tag: string,
    mode: "late" | "many"
  ) {
    const { trackingNo, letterId } = await createDispatchedLetter(bob.uid, transportType, tag);
    await setSeed(letterId, seed);
    await freezeSentAt(letterId);

    clock.advanceTo(T0);
    await advanceJourneyToNow(prisma, letterId, clock);

    if (mode === "many") {
      for (const at of [T0 + HOUR_MS, T0 + DAY_MS, T0 + DAY_MS * 7, T0 + DAY_MS * 30]) {
        clock.advanceTo(at);
        await advanceJourneyToNow(prisma, letterId, clock);
        await getTimeline(trackingNo, alice.accessToken);
      }
    }

    clock.advanceTo(FINAL_MS);
    await advanceJourneyToNow(prisma, letterId, clock);
    const timeline = await timelineOf(trackingNo, alice.accessToken);
    return { letterId, timeline, snapshot: await canonicalTimelineSnapshot(letterId) };
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
      account: `tl_alice_${stamp}`,
      password: "password123",
      nickname: "alice",
      province: "上海市",
      city: "上海市",
      district: "徐汇区",
    });
    bob = await registerUser({
      account: `tl_bob_${stamp}`,
      password: "password123",
      nickname: "bob",
      province: "北京市",
      city: "北京市",
      district: "海淀区",
    });
    carol = await registerUser({
      account: `tl_carol_${stamp}`,
      password: "password123",
      nickname: "carol",
      province: "广东省",
      city: "广州市",
      district: "天河区",
    });
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  // -------------------------------------------------------------------------
  // 1. visibility 冻结表：IMMEDIATE
  // -------------------------------------------------------------------------

  it("IMMEDIATE：WorldEvent.DELAYED → 运输延误", async () => {
    const seed = findSeed0(HC.DELAY, "tl-vis-delay");
    const { trackingNo, letterId } = await createDispatchedLetter(
      bob.uid,
      "HAND_CARRY",
      "tl-vis-delay"
    );
    await setSeed(letterId, seed);
    const journey = await journeyOf(letterId);
    const leg0 = await prisma.transportLeg.findFirstOrThrow({
      where: { journeyId: journey.id, sequence: 0 },
    });
    clock.advanceTo(T0);
    await advanceJourneyToNow(prisma, letterId, clock);
    clock.advanceTo(T0 + (leg0.plannedDurationSeconds + DELAY_MAX_SECONDS) * 1000 + DAY_MS);
    await advanceJourneyToNow(prisma, letterId, clock);

    const events = await prisma.worldEvent.findMany({ where: { journeyId: journey.id } });
    expect(events.some((e) => e.eventType === "DELAYED")).toBe(true);
    const timeline = await timelineOf(trackingNo, alice.accessToken);
    expect(typesOf(timeline)).toContain("TRANSPORT_DELAYED");
  });

  it("IMMEDIATE：WorldEvent.COURIER_MISSING → 信使失联", async () => {
    const seed = findSeed0(HC.COURIER_MISSING, "tl-vis-missing");
    const { trackingNo, letterId } = await createDispatchedLetter(
      bob.uid,
      "HAND_CARRY",
      "tl-vis-missing"
    );
    await setSeed(letterId, seed);
    const journey = await journeyOf(letterId);
    const leg0 = await prisma.transportLeg.findFirstOrThrow({
      where: { journeyId: journey.id, sequence: 0 },
    });
    clock.advanceTo(T0);
    await advanceJourneyToNow(prisma, letterId, clock);
    clock.advanceTo(T0 + (leg0.plannedDurationSeconds + DELAY_MAX_SECONDS) * 1000 + DAY_MS);
    await advanceJourneyToNow(prisma, letterId, clock);

    const events = await prisma.worldEvent.findMany({ where: { journeyId: journey.id } });
    expect(events.some((e) => e.eventType === "COURIER_MISSING")).toBe(true);
    const timeline = await timelineOf(trackingNo, alice.accessToken);
    expect(typesOf(timeline)).toContain("COURIER_MISSING");
  });

  it("IMMEDIATE：RECOVERED / TRANSPORT_CHANGED → 运输已恢复 / 寄送方式已变更", async () => {
    const seed = findDropRecoverTransportChangeSeed("tl-vis-recover");
    const { trackingNo, letterId } = await createDispatchedLetter(
      bob.uid,
      "HAND_CARRY",
      "tl-vis-recover"
    );
    await setSeed(letterId, seed);
    clock.advanceTo(T0);
    await advanceJourneyToNow(prisma, letterId, clock);
    clock.advanceTo(FINAL_MS);
    await advanceJourneyToNow(prisma, letterId, clock);

    const journey = await journeyOf(letterId);
    const events = await prisma.worldEvent.findMany({ where: { journeyId: journey.id } });
    expect(events.some((e) => e.eventType === "RECOVERED")).toBe(true);
    expect(events.some((e) => e.eventType === "TRANSPORT_CHANGED")).toBe(true);

    const timeline = await timelineOf(trackingNo, alice.accessToken);
    const types = typesOf(timeline);
    expect(types).toContain("LETTER_RECOVERED");
    expect(types).toContain("TRANSPORT_CHANGED");
    // RECOVERED 不得反推隐藏原因
    const recovered = timeline.find((e) => e.type === "LETTER_RECOVERED");
    expect(recovered?.description).not.toMatch(/掉落|抢劫|死亡|事故|拾获者|lost|robbery|accident/i);
  });

  // -------------------------------------------------------------------------
  // 2. HIDDEN：ROBBERY / REROUTED / LETTER_DROPPED / SERIOUS_ACCIDENT
  // -------------------------------------------------------------------------

  it("HIDDEN：ROBBERY 不产生任何 TimelineEvent（且不含抢劫/branch 文本）", async () => {
    const seed = findSeed01(HC.ROBBERY, ROBBERY_BRANCH.ESCAPE_DELAY, "tl-hid-rob");
    const { trackingNo, letterId } = await createDispatchedLetter(
      bob.uid,
      "HAND_CARRY",
      "tl-hid-rob"
    );
    await setSeed(letterId, seed);
    clock.advanceTo(T0);
    await advanceJourneyToNow(prisma, letterId, clock);
    clock.advanceTo(FINAL_MS);
    await advanceJourneyToNow(prisma, letterId, clock);

    const journey = await journeyOf(letterId);
    const events = await prisma.worldEvent.findMany({ where: { journeyId: journey.id } });
    expect(events.some((e) => e.eventType === "ROBBERY")).toBe(true);

    const timeline = await timelineOf(trackingNo, alice.accessToken);
    const json = JSON.stringify(timeline).toLowerCase();
    expect(json).not.toMatch(/抢劫|robbery|branch|dead|死亡|事故|accident/);
    // 澄清（2026-09-08）：ROBBERY 不得直接或间接生成 TRANSPORT_DELAYED；
    // 只有独立 WorldEvent.DELAYED 才能生成"运输延误"。
    const types = typesOf(timeline);
    expect(types).not.toContain("TRANSPORT_DELAYED");
    const robberyIdx = events.find((e) => e.eventType === "ROBBERY")?.eventIndex;
    const rows = await prisma.timelineEvent.findMany({ where: { letterId } });
    expect(rows.some((r) => r.sourceKey === `we:${String(robberyIdx)}`)).toBe(false);
  });

  it("仅 WorldEvent.DELAYED 生成 运输延误；ROBBERY（含延误 ESCAPE 分支）不间接产生", async () => {
    // ROBBERY ESCAPE_DELAY：Phase 6 只记录 ROBBERY（无独立 DELAYED 事件）→ 用户不得看到延误
    const robSeed = findSeed01(HC.ROBBERY, ROBBERY_BRANCH.ESCAPE_DELAY, "tl-rob-nodelay");
    const rob = await createDispatchedLetter(bob.uid, "HAND_CARRY", "tl-rob-nodelay");
    await setSeed(rob.letterId, robSeed);
    clock.advanceTo(T0);
    await advanceJourneyToNow(prisma, rob.letterId, clock);
    clock.advanceTo(FINAL_MS);
    await advanceJourneyToNow(prisma, rob.letterId, clock);
    const robJourney = await journeyOf(rob.letterId);
    const robEvents = await prisma.worldEvent.findMany({ where: { journeyId: robJourney.id } });
    expect(robEvents.some((e) => e.eventType === "ROBBERY")).toBe(true);
    // 无独立 DELAYED 事件
    expect(robEvents.some((e) => e.eventType === "DELAYED")).toBe(false);
    expect(typesOf(await timelineOf(rob.trackingNo, alice.accessToken))).not.toContain(
      "TRANSPORT_DELAYED"
    );

    // 对照：独立 WorldEvent.DELAYED → 用户可见 运输延误
    const delaySeed = findSeed0(HC.DELAY, "tl-delay-separate");
    const d = await createDispatchedLetter(bob.uid, "HAND_CARRY", "tl-delay-separate");
    await setSeed(d.letterId, delaySeed);
    clock.advanceTo(T0);
    await advanceJourneyToNow(prisma, d.letterId, clock);
    clock.advanceTo(FINAL_MS);
    await advanceJourneyToNow(prisma, d.letterId, clock);
    const dJourney = await journeyOf(d.letterId);
    const dEvents = await prisma.worldEvent.findMany({ where: { journeyId: dJourney.id } });
    expect(dEvents.some((e) => e.eventType === "DELAYED")).toBe(true);
    expect(typesOf(await timelineOf(d.trackingNo, alice.accessToken))).toContain(
      "TRANSPORT_DELAYED"
    );
  });

  it("HIDDEN：REROUTED 不产生事实，也不产生 placeholder / count leak", async () => {
    const seed = findSeed0(HC.REROUTE, "tl-hid-reroute");
    const { trackingNo, letterId } = await createDispatchedLetter(
      bob.uid,
      "HAND_CARRY",
      "tl-hid-reroute"
    );
    await setSeed(letterId, seed);
    clock.advanceTo(T0);
    await advanceJourneyToNow(prisma, letterId, clock);
    clock.advanceTo(FINAL_MS);
    await advanceJourneyToNow(prisma, letterId, clock);

    const timeline = await timelineOf(trackingNo, alice.accessToken);
    expect(typesOf(timeline)).not.toContain("REROUTED");
    for (const e of timeline) {
      expect(e.title.length).toBeGreaterThan(0);
      expect(e.description).not.toMatch(/未知|后台|隐藏|hidden/i);
    }
  });

  it("HIDDEN：LETTER_DROPPED 不产生事实，DTO 不含「掉落」", async () => {
    const seed = findSeed01(HC.LETTER_DROPPED, DROP_WINDOW.WITHIN_24H, "tl-hid-drop");
    const { trackingNo, letterId } = await createDispatchedLetter(
      bob.uid,
      "HAND_CARRY",
      "tl-hid-drop"
    );
    await setSeed(letterId, seed);
    clock.advanceTo(T0);
    await advanceJourneyToNow(prisma, letterId, clock);
    clock.advanceTo(FINAL_MS);
    await advanceJourneyToNow(prisma, letterId, clock);

    const journey = await journeyOf(letterId);
    const events = await prisma.worldEvent.findMany({ where: { journeyId: journey.id } });
    expect(events.some((e) => e.eventType === "LETTER_DROPPED")).toBe(true);

    const timeline = await timelineOf(trackingNo, alice.accessToken);
    expect(typesOf(timeline)).not.toContain("LETTER_DROPPED");
    expect(JSON.stringify(timeline)).not.toMatch(/掉落|dropped|拾获者/i);
  });

  it("HIDDEN：SERIOUS_ACCIDENT（DESTROYED）只表达结果，不泄漏事故/死亡", async () => {
    const seed = findSeed0(PG.SERIOUS_ACCIDENT, "tl-hid-destroy");
    const { trackingNo, letterId } = await createDispatchedLetter(
      bob.uid,
      "PIGEON",
      "tl-hid-destroy"
    );
    await setSeed(letterId, seed);
    const journey = await journeyOf(letterId);
    const legs = await prisma.transportLeg.findMany({ where: { journeyId: journey.id } });
    const total = legs.reduce((a, l) => a + l.plannedDurationSeconds, 0);
    clock.advanceTo(T0);
    await advanceJourneyToNow(prisma, letterId, clock);
    clock.advanceTo(T0 + (total + 1) * 1000);
    await advanceJourneyToNow(prisma, letterId, clock);

    const letter = await prisma.letter.findUniqueOrThrow({ where: { id: letterId } });
    expect(letter.status).toBe("DESTROYED");

    const timeline = await timelineOf(trackingNo, alice.accessToken);
    const json = JSON.stringify(timeline);
    expect(json).not.toMatch(/死亡|遇难|抢劫|事故|branch|robbery|accident|serious/i);
    const destroyed = timeline.find((e) => e.type === "DESTROYED");
    expect(destroyed?.title).toBe("信件已损毁");

    // 澄清（2026-09-08）：用户可以知道"信件已损毁"及其发生时间 → happenedAt = 实际 destruction occurredAtSim
    const events = await prisma.worldEvent.findMany({ where: { journeyId: journey.id } });
    const accident = events.find((e) => e.eventType === "SERIOUS_ACCIDENT");
    expect(accident).toBeDefined();
    const snapshot = await canonicalTimelineSnapshot(letterId);
    const destroyedRow = snapshot.find((r) => r.type === "DESTROYED");
    expect(destroyedRow?.happenedAt).toBe(accident?.occurredAtSim.getTime());
    expect(destroyedRow?.visibleAt).toBe(accident?.occurredAtSim.getTime());
  });

  // -------------------------------------------------------------------------
  // 3. COURIER_MISSING 多后台路径汇聚
  // -------------------------------------------------------------------------

  it("LOST_PATH：World Truth 保留 HIDDEN cause + 唯一 canonical COURIER_MISSING；Timeline 单条失联不暴露 cause", async () => {
    const seed = findSeed0(HC.LOST_PATH, "tl-agg-lost");
    const { trackingNo, letterId } = await createDispatchedLetter(
      bob.uid,
      "HAND_CARRY",
      "tl-agg-lost"
    );
    await setSeed(letterId, seed);
    // 只推进到首个 leg 完成（触发 LOST_PATH transition），聚焦单次 logical missing
    clock.advanceTo(T0);
    await advanceJourneyToNow(prisma, letterId, clock);
    const journey = await journeyOf(letterId);
    const legs = await prisma.transportLeg.findMany({
      where: { journeyId: journey.id },
      orderBy: { sequence: "asc" },
    });
    const firstLeg = legs[0];
    clock.advanceTo(T0 + (firstLeg?.plannedDurationSeconds ?? 0) * 1000 + HOUR_MS);
    await advanceJourneyToNow(prisma, letterId, clock);

    const events = await prisma.worldEvent.findMany({
      where: { journeyId: journey.id },
      orderBy: { eventIndex: "asc" },
    });
    // World Truth 完整性：LOST_PATH（HIDDEN cause）与 canonical COURIER_MISSING 都必须存在，
    // 每次 logical missing transition 恰好一个 canonical；eventIndex 顺序 = LOST_PATH 先、canonical 后。
    const lost = events.find((e) => e.eventType === "LOST_PATH");
    expect(lost).toBeDefined();
    const canonical = events.find((e) => e.eventType === "COURIER_MISSING");
    expect(canonical).toBeDefined();
    expect(events.filter((e) => e.eventType === "COURIER_MISSING")).toHaveLength(1);
    expect(events.filter((e) => e.eventType === "LOST_PATH")).toHaveLength(1);
    expect(canonical?.eventIndex).toBeGreaterThan(lost?.eventIndex ?? -1);

    const timeline = await timelineOf(trackingNo, alice.accessToken);
    expect(typesOf(timeline)).toContain("COURIER_MISSING");
    const json = JSON.stringify(timeline).toLowerCase();
    expect(json).not.toMatch(/迷路|lost_path|lostpath|原因|cause/);
    // 一个 logical missing transition 只产生一条失联事实（绑定 canonical，而非 LOST_PATH）
    const rows = await prisma.timelineEvent.findMany({
      where: { letterId, type: "COURIER_MISSING" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sourceKey).toBe(`we:${String(canonical?.eventIndex)}`);
  });

  it("LOST_PATH retry/concurrency：并发推进最终只有一套 LOST_PATH + canonical COURIER_MISSING", async () => {
    const seed = findSeed0(HC.LOST_PATH, "tl-agg-conc");
    const { trackingNo, letterId } = await createDispatchedLetter(
      bob.uid,
      "HAND_CARRY",
      "tl-agg-conc"
    );
    await setSeed(letterId, seed);
    const journey = await journeyOf(letterId);
    const legs = await prisma.transportLeg.findMany({
      where: { journeyId: journey.id },
      orderBy: { sequence: "asc" },
    });
    const target = T0 + (legs[0]?.plannedDurationSeconds ?? 0) * 1000 + HOUR_MS;

    const run = async () => {
      const c = new TestSimulationClock(T0);
      c.advanceTo(T0);
      await advanceJourneyToNow(prisma, letterId, c);
      c.advanceTo(target);
      return advanceJourneyToNow(prisma, letterId, c);
    };
    const results = await Promise.all([run(), run(), run()]);
    // 至少一个推进产生变化；无 500（异常会 reject）
    expect(results.some((r) => r.changed)).toBe(true);
    const events = await prisma.worldEvent.findMany({ where: { journeyId: journey.id } });
    expect(events.filter((e) => e.eventType === "LOST_PATH")).toHaveLength(1);
    expect(events.filter((e) => e.eventType === "COURIER_MISSING")).toHaveLength(1);
    // 触发一次 materialize，确认并发后仍只有一条失联事实
    clock.advanceTo(target);
    await timelineOf(trackingNo, alice.accessToken);
    const timelineRows = await prisma.timelineEvent.findMany({
      where: { letterId, type: "COURIER_MISSING" },
    });
    expect(timelineRows).toHaveLength(1);
    // 并发下事件编号仍是连续的两个（新 Journey 无 legacy 预留）：0 = LOST_PATH、1 = canonical
    expect(events.map((e) => e.eventIndex).sort((a, b) => a - b)).toEqual([0, 1]);
    expect((await journeyOf(letterId)).nextWorldEventIndex).toBe(2);
  });

  // -------------------------------------------------------------------------
  // 4. DISPATCHED immutable timestamp
  // -------------------------------------------------------------------------

  it("DISPATCHED：推进前后 sourceKey / happenedAt / 文案 完全一致（不可变来源）", async () => {
    const seed = findSeed0(HC.NORMAL, "tl-dispatch");
    const { letterId } = await createDispatchedLetter(bob.uid, "HAND_CARRY", "tl-dispatch");
    await setSeed(letterId, seed);
    await freezeSentAt(letterId);

    // 推进前投影
    const before = (await canonicalTimelineSnapshot(letterId)).length; // 尚未 GET → 0 行
    expect(before).toBe(0);
    await getTimeline(
      (await prisma.letter.findUniqueOrThrow({ where: { id: letterId } })).trackingNo,
      alice.accessToken
    );
    const beforeRows = await canonicalTimelineSnapshot(letterId);
    const dispatchedBefore = beforeRows.find((r) => r.sourceKey === "journey:dispatched");
    expect(dispatchedBefore).toBeDefined();

    // 推进后再次投影
    clock.advanceTo(T0);
    await advanceJourneyToNow(prisma, letterId, clock);
    clock.advanceTo(T0 + DAY_MS * 60);
    await advanceJourneyToNow(prisma, letterId, clock);
    const afterRows = await canonicalTimelineSnapshot(letterId);
    const dispatchedAfter = afterRows.find((r) => r.sourceKey === "journey:dispatched");

    expect(dispatchedAfter?.happenedAt).toBe(dispatchedBefore?.happenedAt);
    expect(dispatchedAfter?.title).toBe(dispatchedBefore?.title);
    expect(dispatchedAfter?.description).toBe(dispatchedBefore?.description);
    expect(dispatchedAfter?.province).toBe(dispatchedBefore?.province);
    expect(dispatchedAfter?.city).toBe(dispatchedBefore?.city);
  });

  it("district：区域锚点事件有真实区县；途中站为 null；全表无空串；DTO 不暴露 district", async () => {
    // alice = 上海市徐汇区（origin），bob = 北京市海淀区（target）
    const seed = findSeed0(HC.NORMAL, "tl-district");
    const { trackingNo, letterId } = await createDispatchedLetter(
      bob.uid,
      "HAND_CARRY",
      "tl-district"
    );
    await setSeed(letterId, seed);
    clock.advanceTo(T0);
    await advanceJourneyToNow(prisma, letterId, clock);
    clock.advanceTo(FINAL_MS);
    await advanceJourneyToNow(prisma, letterId, clock);

    const timeline = await timelineOf(trackingNo, alice.accessToken);
    expect(typesOf(timeline)).toContain("DELIVERED");
    const snapshot = await canonicalTimelineSnapshot(letterId);

    // 寄出（origin 区域锚点）：驿站城市 = origin 城市 → 写真实 origin district
    const dispatched = snapshot.find((r) => r.type === "DISPATCHED");
    expect(dispatched?.province).toBe("上海市");
    expect(dispatched?.city).toBe("上海市");
    expect(dispatched?.district).toBe("徐汇区");
    // 送达（target 区域锚点）：目的地驿站城市 = target 城市 → 写真实 target district
    const delivered = snapshot.find((r) => r.type === "DELIVERED");
    expect(delivered?.city).toBe("北京市");
    expect(delivered?.district).toBe("海淀区");
    // 途中站只能确定到 city → district = null（不猜测区县）
    const arrived = snapshot.find((r) => r.type === "ARRIVED_STATION");
    if (arrived) expect(arrived.district).toBeNull();
    // 不允许空串伪装
    for (const row of snapshot) expect(row.district).not.toBe("");
    // DTO 安全边界保持：不暴露 district
    expect(JSON.stringify(timeline)).not.toContain("district");
  });

  // -------------------------------------------------------------------------
  // 5. refresh-frequency independence：late GET vs many GET
  // -------------------------------------------------------------------------

  it("late GET vs many GET：NORMAL + DELAY 场景 DB/DTO 完全全等", async () => {
    const delaySeed = findSeed0(HC.DELAY, "tl-freq-delay");
    const late = await runFrequencyScenario(delaySeed, "HAND_CARRY", "tl-freq-delay-late", "late");
    const many = await runFrequencyScenario(delaySeed, "HAND_CARRY", "tl-freq-delay-many", "many");

    expect(late.snapshot.length).toBeGreaterThan(0);
    expect(many.snapshot).toEqual(late.snapshot);
    expect(many.timeline).toEqual(late.timeline);
  });

  it("late GET vs many GET：drop + RECOVERED + TRANSPORT_CHANGED 场景全等", async () => {
    const seed = findDropRecoverTransportChangeSeed("tl-freq-rec");
    const late = await runFrequencyScenario(seed, "HAND_CARRY", "tl-freq-rec-late", "late");
    const many = await runFrequencyScenario(seed, "HAND_CARRY", "tl-freq-rec-many", "many");

    expect(many.snapshot).toEqual(late.snapshot);
    expect(many.timeline).toEqual(late.timeline);
    // 覆盖到了恢复与运输变更
    expect(typesOf(late.timeline)).toContain("LETTER_RECOVERED");
    expect(typesOf(late.timeline)).toContain("TRANSPORT_CHANGED");
  });

  it("late GET vs many GET：PERMANENTLY_LOST 终态场景全等", async () => {
    const seed = findSeed01(HC.LETTER_DROPPED, DROP_WINDOW.NEVER, "tl-freq-lost");
    const late = await runFrequencyScenario(seed, "HAND_CARRY", "tl-freq-lost-late", "late");
    const many = await runFrequencyScenario(seed, "HAND_CARRY", "tl-freq-lost-many", "many");

    expect(many.snapshot).toEqual(late.snapshot);
    expect(many.timeline).toEqual(late.timeline);
    expect(typesOf(late.timeline)).toContain("PERMANENTLY_LOST");
  });

  it("refresh matrix：NORMAL 场景 late vs many GET 全等", async () => {
    const seed = findSeed0(HC.NORMAL, "tl-mx-normal");
    const late = await runFrequencyScenario(seed, "HAND_CARRY", "tl-mx-normal-late", "late");
    const many = await runFrequencyScenario(seed, "HAND_CARRY", "tl-mx-normal-many", "many");
    expect(many.snapshot).toEqual(late.snapshot);
    expect(many.timeline).toEqual(late.timeline);
    expect(typesOf(late.timeline).length).toBeGreaterThan(0);
  });

  it("refresh matrix：direct COURIER_MISSING 场景 late vs many GET 全等", async () => {
    const seed = findSeed0(HC.COURIER_MISSING, "tl-mx-missing");
    const late = await runFrequencyScenario(seed, "HAND_CARRY", "tl-mx-missing-late", "late");
    const many = await runFrequencyScenario(seed, "HAND_CARRY", "tl-mx-missing-many", "many");
    expect(many.snapshot).toEqual(late.snapshot);
    expect(many.timeline).toEqual(late.timeline);
    expect(typesOf(late.timeline)).toContain("COURIER_MISSING");
    // 单条失联（canonical）
    expect(
      (await canonicalTimelineSnapshot(late.letterId)).filter((r) => r.type === "COURIER_MISSING")
    ).toHaveLength(1);
  });

  it("refresh matrix：LOST_PATH → canonical missing 场景 late vs many GET 全等", async () => {
    const seed = findSeed0(HC.LOST_PATH, "tl-mx-lostpath");
    const late = await runFrequencyScenario(seed, "HAND_CARRY", "tl-mx-lostpath-late", "late");
    const many = await runFrequencyScenario(seed, "HAND_CARRY", "tl-mx-lostpath-many", "many");
    expect(many.snapshot).toEqual(late.snapshot);
    expect(many.timeline).toEqual(late.timeline);
    expect(typesOf(late.timeline)).toContain("COURIER_MISSING");
    expect(
      (await canonicalTimelineSnapshot(late.letterId)).filter((r) => r.type === "COURIER_MISSING")
    ).toHaveLength(1);
  });

  it("refresh matrix：DESTROYED 场景 late vs many GET 全等", async () => {
    const seed = findSeed0(PG.SERIOUS_ACCIDENT, "tl-mx-destroy");
    const late = await runFrequencyScenario(seed, "PIGEON", "tl-mx-destroy-late", "late");
    const many = await runFrequencyScenario(seed, "PIGEON", "tl-mx-destroy-many", "many");
    expect(many.snapshot).toEqual(late.snapshot);
    expect(many.timeline).toEqual(late.timeline);
    expect(typesOf(late.timeline)).toContain("DESTROYED");
  });

  it("drop during anomaly GET vs after recovery 第一次 GET：最终完全一致且无掉落事实", async () => {
    const seed = findSeed01(HC.LETTER_DROPPED, DROP_WINDOW.WITHIN_24H, "tl-drop-bypass");

    async function buildLetter(tag: string) {
      const letter = await createDispatchedLetter(bob.uid, "HAND_CARRY", tag);
      await setSeed(letter.letterId, seed);
      await freezeSentAt(letter.letterId);
      return letter;
    }
    async function advanceToDrop(letterId: bigint): Promise<number> {
      clock.advanceTo(T0);
      await advanceJourneyToNow(prisma, letterId, clock);
      const journey = await journeyOf(letterId);
      const legs = await prisma.transportLeg.findMany({
        where: { journeyId: journey.id },
        orderBy: { sequence: "asc" },
      });
      const firstLeg = legs[0];
      const dropAt = T0 + (firstLeg?.plannedDurationSeconds ?? 0) * 1000;
      clock.advanceTo(dropAt + HOUR_MS);
      await advanceJourneyToNow(prisma, letterId, clock);
      return dropAt;
    }

    // A 与 B：完全相同的推进路径（T0 → drop 触发 → FINAL），只差是否在异常期间 GET
    const a = await buildLetter("tl-drop-bypass-a");
    const b = await buildLetter("tl-drop-bypass-b");
    await advanceToDrop(a.letterId);
    await advanceToDrop(b.letterId);

    const aj = await journeyOf(a.letterId);
    const bj = await journeyOf(b.letterId);
    expect(aj.anomalyType).toBe("LETTER_DROPPED"); // 确认处于掉落异常期间
    expect(bj.anomalyType).toBe("LETTER_DROPPED");

    await timelineOf(a.trackingNo, alice.accessToken); // A：异常期间 GET
    // B：异常期间不 GET

    clock.advanceTo(FINAL_MS);
    await advanceJourneyToNow(prisma, a.letterId, clock);
    await advanceJourneyToNow(prisma, b.letterId, clock);
    const aTimeline = await timelineOf(a.trackingNo, alice.accessToken);
    const bTimeline = await timelineOf(b.trackingNo, alice.accessToken);

    expect(await canonicalTimelineSnapshot(a.letterId)).toEqual(
      await canonicalTimelineSnapshot(b.letterId)
    );
    expect(aTimeline).toEqual(bTimeline);
    // 两者都不能出现掉落事实或等价泄漏
    expect(typesOf(aTimeline)).not.toContain("LETTER_DROPPED");
    expect(JSON.stringify(aTimeline)).not.toMatch(/掉落|dropped/i);
  });

  // -------------------------------------------------------------------------
  // 6. idempotency / concurrency
  // -------------------------------------------------------------------------

  it("repeated GET：100 次刷新不新增重复事实、不改顺序、不改 World Truth", async () => {
    const seed = findSeed0(HC.NORMAL, "tl-idem");
    const { trackingNo, letterId } = await createDispatchedLetter(bob.uid, "HAND_CARRY", "tl-idem");
    await setSeed(letterId, seed);
    clock.advanceTo(T0);
    await advanceJourneyToNow(prisma, letterId, clock);
    clock.advanceTo(T0 + DAY_MS * 120);
    await advanceJourneyToNow(prisma, letterId, clock);

    const beforeWorld = await worldSnapshot(letterId);
    const first = await timelineOf(trackingNo, alice.accessToken);
    const firstSnapshot = await canonicalTimelineSnapshot(letterId);
    for (let i = 0; i < 99; i += 1) await getTimeline(trackingNo, alice.accessToken);
    const after = await timelineOf(trackingNo, alice.accessToken);

    expect(after).toEqual(first);
    expect(await canonicalTimelineSnapshot(letterId)).toEqual(firstSnapshot);
    const keys = (await canonicalTimelineSnapshot(letterId)).map((r) => r.sourceKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(await worldSnapshot(letterId)).toEqual(beforeWorld);
  });

  it("concurrent GET：不产生重复、无 500、顺序一致", async () => {
    const seed = findSeed0(HC.NORMAL, "tl-conc");
    const { trackingNo, letterId } = await createDispatchedLetter(bob.uid, "HAND_CARRY", "tl-conc");
    await setSeed(letterId, seed);
    clock.advanceTo(T0);
    await advanceJourneyToNow(prisma, letterId, clock);
    clock.advanceTo(T0 + DAY_MS * 120);
    await advanceJourneyToNow(prisma, letterId, clock);

    const responses = await Promise.all([
      getTimeline(trackingNo, alice.accessToken),
      getTimeline(trackingNo, bob.accessToken),
      getTimeline(trackingNo, alice.accessToken),
      getTimeline(trackingNo, bob.accessToken),
    ]);
    for (const res of responses) expect(res.statusCode).toBe(200);
    const bodies = responses.map((r) => r.json().timeline);
    for (const body of bodies) expect(body).toEqual(bodies[0]);
    const keys = (await canonicalTimelineSnapshot(letterId)).map((r) => r.sourceKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  // -------------------------------------------------------------------------
  // 7. Sender/Recipient parity & third party
  // -------------------------------------------------------------------------

  it("Sender / Recipient timeline 完全一致；第三方 404", async () => {
    const seed = findSeed01(HC.LETTER_DROPPED, DROP_WINDOW.WITHIN_24H, "tl-parity");
    const { trackingNo, letterId } = await createDispatchedLetter(
      bob.uid,
      "HAND_CARRY",
      "tl-parity"
    );
    await setSeed(letterId, seed);
    clock.advanceTo(T0);
    await advanceJourneyToNow(prisma, letterId, clock);
    clock.advanceTo(FINAL_MS);
    await advanceJourneyToNow(prisma, letterId, clock);

    const sender = await timelineOf(trackingNo, alice.accessToken);
    const recipient = await timelineOf(trackingNo, bob.accessToken);
    expect(recipient).toEqual(sender);
    expect(sender.length).toBeGreaterThan(0);
    expect((await getTimeline(trackingNo, carol.accessToken)).statusCode).toBe(404);
  });

  // -------------------------------------------------------------------------
  // 8. content lock & read privacy
  // -------------------------------------------------------------------------

  it("Recipient 送达前 content=null；PERMANENTLY_LOST / DESTROYED 仍锁定", async () => {
    const { trackingNo: transitNo, letterId: transitId } = await createDispatchedLetter(
      bob.uid,
      "HAND_CARRY",
      "tl-content-transit"
    );
    clock.advanceTo(T0);
    await advanceJourneyToNow(prisma, transitId, clock);
    clock.advanceTo(T0 + HOUR_MS);
    await advanceJourneyToNow(prisma, transitId, clock);
    const transit = await app.inject({
      method: "GET",
      url: `/api/v1/letters/${transitNo}`,
      headers: { authorization: `Bearer ${bob.accessToken}` },
    });
    expect(transit.json().letter.content).toBeNull();

    // PERMANENTLY_LOST
    const lostSeed = findSeed01(HC.LETTER_DROPPED, DROP_WINDOW.NEVER, "tl-content-lost");
    const { trackingNo: lostNo, letterId: lostId } = await createDispatchedLetter(
      bob.uid,
      "HAND_CARRY",
      "tl-content-lost"
    );
    await setSeed(lostId, lostSeed);
    clock.advanceTo(T0);
    await advanceJourneyToNow(prisma, lostId, clock);
    clock.advanceTo(FINAL_MS);
    await advanceJourneyToNow(prisma, lostId, clock);
    const lostLetter = await prisma.letter.findUniqueOrThrow({ where: { id: lostId } });
    expect(lostLetter.status).toBe("PERMANENTLY_LOST");
    const lostRes = await app.inject({
      method: "GET",
      url: `/api/v1/letters/${lostNo}`,
      headers: { authorization: `Bearer ${bob.accessToken}` },
    });
    expect(lostRes.json().letter.content).toBeNull();
    expect(typesOf(await timelineOf(lostNo, bob.accessToken))).toContain("PERMANENTLY_LOST");

    // DESTROYED
    const destroySeed = findSeed0(PG.SERIOUS_ACCIDENT, "tl-content-destroy");
    const { trackingNo: deadNo, letterId: deadId } = await createDispatchedLetter(
      bob.uid,
      "PIGEON",
      "tl-content-destroy"
    );
    await setSeed(deadId, destroySeed);
    const dj = await journeyOf(deadId);
    const dLegs = await prisma.transportLeg.findMany({ where: { journeyId: dj.id } });
    clock.advanceTo(T0);
    await advanceJourneyToNow(prisma, deadId, clock);
    clock.advanceTo(T0 + (dLegs.reduce((a, l) => a + l.plannedDurationSeconds, 0) + 1) * 1000);
    await advanceJourneyToNow(prisma, deadId, clock);
    const deadRes = await app.inject({
      method: "GET",
      url: `/api/v1/letters/${deadNo}`,
      headers: { authorization: `Bearer ${bob.accessToken}` },
    });
    expect(deadRes.json().letter.content).toBeNull();
  });

  it("Sender 任何响应都无 readState / openedAt（即使 null 也不出现）", async () => {
    const { trackingNo, letterId } = await createDispatchedLetter(
      bob.uid,
      "HAND_CARRY",
      "tl-readprivacy"
    );
    clock.advanceTo(T0);
    await advanceJourneyToNow(prisma, letterId, clock);
    clock.advanceTo(T0 + DAY_MS * 2);
    await advanceJourneyToNow(prisma, letterId, clock);

    const keys = new Set<string>();
    const collect = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(collect);
        return;
      }
      if (value && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) {
          keys.add(k);
          collect(v);
        }
      }
    };
    collect((await getTimeline(trackingNo, alice.accessToken)).json());
    collect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/letters/${trackingNo}`,
          headers: { authorization: `Bearer ${alice.accessToken}` },
        })
      ).json()
    );
    for (const key of ["readState", "openedAt", "isOpened", "hasRead", "recipientOpened"]) {
      expect(keys.has(key)).toBe(false);
    }
  });

  // -------------------------------------------------------------------------
  // 9. information leak
  // -------------------------------------------------------------------------

  it("泄漏扫描：递归 key 白名单外全禁 + 文本级后台原因全禁 + 无 ETA", async () => {
    const seed = findSeed01(HC.LETTER_DROPPED, DROP_WINDOW.WITHIN_24H, "tl-leak");
    const { trackingNo, letterId } = await createDispatchedLetter(bob.uid, "HAND_CARRY", "tl-leak");
    await setSeed(letterId, seed);
    clock.advanceTo(T0);
    await advanceJourneyToNow(prisma, letterId, clock);
    clock.advanceTo(FINAL_MS);
    await advanceJourneyToNow(prisma, letterId, clock);

    const timeline = await timelineOf(trackingNo, alice.accessToken);
    const keys = new Set<string>();
    const collect = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(collect);
        return;
      }
      if (value && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) {
          keys.add(k);
          collect(v);
        }
      }
    };
    collect(timeline);

    const forbiddenKeys = [
      "id",
      "letterId",
      "journeyId",
      "worldEventId",
      "eventIndex",
      "simulationSeed",
      "rulesVersion",
      "graphVersion",
      "payload",
      "recoveryWindow",
      "draw",
      "random",
      "anomalyStartedAtSim",
      "anomalyResolvedAtSim",
      "readState",
      "openedAt",
      "eta",
      "remainingSeconds",
      "sourceKey",
      "sequence",
      "visibleAt",
      "nodeId",
      "createdAt",
      "importance",
      "mapX",
      "mapY",
      "uncertaintyRadiusKm",
      "metadata",
    ];
    for (const key of forbiddenKeys) expect(keys.has(key)).toBe(false);

    const json = JSON.stringify(timeline).toLowerCase();
    for (const term of [
      "robbery",
      "抢劫",
      "branch",
      "dead",
      "死亡",
      "严重事故",
      "serious accident",
      "lost_path",
      "迷路",
      "letter_dropped",
      "掉落",
      "eta",
      "remaining",
      "countdown",
      "预计",
      "倒计时",
      "剩余",
    ]) {
      expect(json).not.toContain(term);
    }
  });

  // -------------------------------------------------------------------------
  // 10. Phase 6 regression
  // -------------------------------------------------------------------------

  it("Phase 6 regression：materialize 前后 World Truth 快照完全一致", async () => {
    const seed = findSeed01(HC.LETTER_DROPPED, DROP_WINDOW.WITHIN_24H, "tl-regression");
    const { trackingNo, letterId } = await createDispatchedLetter(
      bob.uid,
      "HAND_CARRY",
      "tl-regression"
    );
    await setSeed(letterId, seed);
    clock.advanceTo(T0);
    await advanceJourneyToNow(prisma, letterId, clock);
    clock.advanceTo(FINAL_MS);
    await advanceJourneyToNow(prisma, letterId, clock);

    const before = await worldSnapshot(letterId);
    await timelineOf(trackingNo, alice.accessToken);
    await timelineOf(trackingNo, bob.accessToken);
    expect(await worldSnapshot(letterId)).toEqual(before);
    expect(before.events.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // 11. P2002 精确判断
  // -------------------------------------------------------------------------

  it("P2002 精确判断：只吞 (letterId, sourceKey) 复合唯一，其它一律 rethrow", () => {
    expect(
      isTimelineUniqueConflict({ code: "P2002", meta: { target: ["letterId", "sourceKey"] } })
    ).toBe(true);
    expect(
      isTimelineUniqueConflict({ code: "P2002", meta: { target: ["sourceKey", "letterId"] } })
    ).toBe(true);
    expect(
      isTimelineUniqueConflict({
        code: "P2002",
        meta: {
          driverAdapterError: { cause: { constraint: { fields: ['"letterId"', '"sourceKey"'] } } },
        },
      })
    ).toBe(true);
    // 单字段 / 其它约束 / 非 P2002 → 必须 rethrow（不吞）
    expect(isTimelineUniqueConflict({ code: "P2002", meta: { target: ["letterId"] } })).toBe(false);
    expect(isTimelineUniqueConflict({ code: "P2002", meta: { target: ["sourceKey"] } })).toBe(
      false
    );
    expect(isTimelineUniqueConflict({ code: "P2002", meta: { target: ["trackingNo"] } })).toBe(
      false
    );
    expect(
      isTimelineUniqueConflict({
        code: "P2002",
        meta: { target: ["letterId", "sourceKey", "type"] },
      })
    ).toBe(false);
    expect(isTimelineUniqueConflict({ code: "P2002" })).toBe(false);
    expect(
      isTimelineUniqueConflict({ code: "P2003", meta: { target: ["letterId", "sourceKey"] } })
    ).toBe(false);
    expect(isTimelineUniqueConflict(new Error("boom"))).toBe(false);
    expect(isTimelineUniqueConflict(null)).toBe(false);

    // --- Gate MEDIUM 追加：禁止跨 metadata source 拼接字段 ---
    const KNOWN = "TimelineEvent_letterId_sourceKey_key";
    // target=["letterId"] + driver fields=["sourceKey"]（跨源拼接）→ false
    expect(
      isTimelineUniqueConflict({
        code: "P2002",
        meta: {
          target: ["letterId"],
          driverAdapterError: { cause: { constraint: { fields: ["sourceKey"] } } },
        },
      })
    ).toBe(false);
    // 已知约束名（target 字符串）→ true
    expect(isTimelineUniqueConflict({ code: "P2002", meta: { target: KNOWN } })).toBe(true);
    // driver 单独给出 constraint name → true
    expect(
      isTimelineUniqueConflict({
        code: "P2002",
        meta: { driverAdapterError: { cause: { constraint: { name: KNOWN } } } },
      })
    ).toBe(true);
    // driver 单独给出精确复合字段 → true
    expect(
      isTimelineUniqueConflict({
        code: "P2002",
        meta: {
          driverAdapterError: { cause: { constraint: { fields: ['"letterId"', '"sourceKey"'] } } },
        },
      })
    ).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 12. deterministic ordering / 历史插入
  // -------------------------------------------------------------------------

  it("deterministic ordering：分阶段 materialize 与一次性最终顺序完全一致（按历史时间，非插入顺序）", async () => {
    const seed = findDropRecoverTransportChangeSeed("tl-ordering");
    const late = await runFrequencyScenario(seed, "HAND_CARRY", "tl-ordering-late", "late");
    const many = await runFrequencyScenario(seed, "HAND_CARRY", "tl-ordering-many", "many");

    // DB sequence 与 API 顺序都全等（many 分批插入，late 一次性插入）
    expect(many.snapshot).toEqual(late.snapshot);
    for (let i = 1; i < many.timeline.length; i += 1) {
      const prev = many.timeline[i - 1];
      const cur = many.timeline[i];
      if (!prev || !cur) continue;
      expect(new Date(prev.happenedAt).getTime()).toBeLessThanOrEqual(
        new Date(cur.happenedAt).getTime()
      );
    }
    // sequence 连续且与 canonical 排序一致
    const seqs = many.snapshot.map((r) => r.sequence);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  // -------------------------------------------------------------------------
  // 13. random cursor 与 WorldEvent 编号解耦（Gate HIGH）
  // -------------------------------------------------------------------------

  it("random cursor golden：PIGEON LOST_PATH 双事件不消费随机游标（cursor 恰为真实决策 5 次）", async () => {
    // PIGEON 单 leg：primary(0) + window(1) + range(2) + handling(3) + transport(4)
    const seed = findSeed01(PG.LOST_PATH, DROP_WINDOW.WITHIN_24H, "tl-cursor-golden");
    const { letterId } = await createDispatchedLetter(bob.uid, "PIGEON", "tl-cursor-golden");
    await setSeed(letterId, seed);
    clock.advanceTo(T0);
    await advanceJourneyToNow(prisma, letterId, clock);
    clock.advanceTo(FINAL_MS);
    await advanceJourneyToNow(prisma, letterId, clock);

    const journey = await journeyOf(letterId);
    const events = await prisma.worldEvent.findMany({
      where: { journeyId: journey.id },
      orderBy: { eventIndex: "asc" },
    });
    const lost = events.find((e) => e.eventType === "LOST_PATH");
    const canonical = events.find((e) => e.eventType === "COURIER_MISSING");
    expect(lost).toBeDefined();
    expect(canonical).toBeDefined();
    // 双事件编号独立分配且有序（LOST_PATH 早于 canonical）
    expect(canonical?.eventIndex).toBeGreaterThan(lost?.eventIndex ?? -1);
    expect(journey.nextWorldEventIndex).toBeGreaterThan(canonical?.eventIndex ?? -1);
    // 关键：随机游标只被真实随机决策推进（记录 canonical 不得消费 draw）。
    // 修复前（canonical 使用 draw().index）= 6；修复后 = 5。
    expect(journey.nextRandomDrawIndex).toBe(5);
    // 恢复窗口仍为 WITHIN_24H（未被额外 draw 偏移）
    const lostPayload = lost?.payload as { recoveryWindow?: string } | null;
    expect(lostPayload?.recoveryWindow).toBe("WITHIN_24H");
  });

  it("derived 事件不消费随机游标：TRANSPORT_CHANGED / PERMANENTLY_LOST 均不额外 draw", async () => {
    // (a) PERMANENTLY_LOST：primary(0) + window(1, NEVER 无 range) → cursor = 2（修复前 = 3）
    const lostSeed = findSeed01(HC.LETTER_DROPPED, DROP_WINDOW.NEVER, "tl-cursor-lost");
    const lost = await createDispatchedLetter(bob.uid, "HAND_CARRY", "tl-cursor-lost");
    await setSeed(lost.letterId, lostSeed);
    clock.advanceTo(T0);
    await advanceJourneyToNow(prisma, lost.letterId, clock);
    clock.advanceTo(FINAL_MS);
    await advanceJourneyToNow(prisma, lost.letterId, clock);
    const lostJourney = await journeyOf(lost.letterId);
    const lostEvents = await prisma.worldEvent.findMany({ where: { journeyId: lostJourney.id } });
    expect(lostEvents.some((e) => e.eventType === "PERMANENTLY_LOST")).toBe(true);
    expect(lostJourney.nextRandomDrawIndex).toBe(2);

    // (b) 恢复 + 运输变更：恢复阶段只消费 handling + transport 两次 draw
    const tcSeed = findDropRecoverTransportChangeSeed("tl-cursor-tc");
    const tc = await createDispatchedLetter(bob.uid, "HAND_CARRY", "tl-cursor-tc");
    await setSeed(tc.letterId, tcSeed);
    clock.advanceTo(T0);
    await advanceJourneyToNow(prisma, tc.letterId, clock);
    const tcJourney = await journeyOf(tc.letterId);
    const legs = await prisma.transportLeg.findMany({
      where: { journeyId: tcJourney.id },
      orderBy: { sequence: "asc" },
    });
    const first = legs[0];
    const dropAt = T0 + (first?.plannedDurationSeconds ?? 0) * 1000;
    clock.advanceTo(dropAt + HOUR_MS);
    await advanceJourneyToNow(prisma, tc.letterId, clock);
    const afterDrop = await journeyOf(tc.letterId);
    const resolvedMs = afterDrop.anomalyResolvedAtSim?.getTime();
    expect(resolvedMs).toBeDefined();
    clock.advanceTo((resolvedMs ?? dropAt) + HOUR_MS);
    await advanceJourneyToNow(prisma, tc.letterId, clock);
    const afterRecover = await journeyOf(tc.letterId);
    const tcEvents = await prisma.worldEvent.findMany({ where: { journeyId: tcJourney.id } });
    expect(tcEvents.some((e) => e.eventType === "TRANSPORT_CHANGED")).toBe(true);
    // 恢复阶段随机决策 = handling(1) + transport(1)；若恢复后同一推进内还激活了下一 Leg，
    // 则再加上该 Leg 的 primary 判定(1)。TRANSPORT_CHANGED 记录**不得**额外消费（修复前会多 1）。
    const laterLegs = await prisma.transportLeg.findMany({
      where: { journeyId: tcJourney.id, sequence: { gt: 0 } },
    });
    // 判定标志 = primaryEventOutcome（NORMAL 也非 null；primaryEventIndex 仅在有事件时非 null）
    const nextPrimaryJudged = laterLegs.some((l) => l.primaryEventOutcome !== null);
    const expectedDelta = nextPrimaryJudged ? 3 : 2;
    expect(afterRecover.nextRandomDrawIndex - afterDrop.nextRandomDrawIndex).toBe(expectedDelta);
  });

  it("双事件 fault-injection rollback：LOST_PATH + canonical COURIER_MISSING 全有或全无", async () => {
    const seed = findSeed0(HC.LOST_PATH, "tl-dual-rollback");
    const { letterId } = await createDispatchedLetter(bob.uid, "HAND_CARRY", "tl-dual-rollback");
    await setSeed(letterId, seed);
    clock.advanceTo(T0);
    await advanceJourneyToNow(prisma, letterId, clock);

    const beforeJourney = await journeyOf(letterId);
    const beforeLetter = await prisma.letter.findUniqueOrThrow({ where: { id: letterId } });
    const beforeLegs = await prisma.transportLeg.findMany({
      where: { journeyId: beforeJourney.id },
      orderBy: { sequence: "asc" },
    });
    const legs = beforeLegs;
    const firstLeg = legs[0];

    setWorldEventPersistFaultForTest(() => {
      throw new Error("injected_world_event_persist_fault");
    });
    try {
      clock.advanceTo(T0 + (firstLeg?.plannedDurationSeconds ?? 0) * 1000 + HOUR_MS);
      await expect(advanceJourneyToNow(prisma, letterId, clock)).rejects.toThrow(
        /injected_world_event_persist_fault/
      );
    } finally {
      setWorldEventPersistFaultForTest(null);
    }

    // all-or-nothing：LOST_PATH 与 canonical 都不存在，游标/状态/legs 全部未半写
    const events = await prisma.worldEvent.findMany({ where: { journeyId: beforeJourney.id } });
    expect(events).toHaveLength(0);
    const afterJourney = await journeyOf(letterId);
    expect(afterJourney.nextWorldEventIndex).toBe(beforeJourney.nextWorldEventIndex);
    expect(afterJourney.nextRandomDrawIndex).toBe(beforeJourney.nextRandomDrawIndex);
    expect(afterJourney.lastAdvancedAtSim?.getTime()).toBe(
      beforeJourney.lastAdvancedAtSim?.getTime()
    );
    expect(afterJourney.anomalyType).toBe(beforeJourney.anomalyType);
    expect(afterJourney.currentLegSequence).toBe(beforeJourney.currentLegSequence);
    const afterLetter = await prisma.letter.findUniqueOrThrow({ where: { id: letterId } });
    expect(afterLetter.status).toBe(beforeLetter.status);
    const afterLegs = await prisma.transportLeg.findMany({
      where: { journeyId: beforeJourney.id },
      orderBy: { sequence: "asc" },
    });
    expect(
      afterLegs.map((l) => ({
        sequence: l.sequence,
        status: l.status,
        startedAtSim: l.startedAtSim?.getTime() ?? null,
        completedAtSim: l.completedAtSim?.getTime() ?? null,
        primaryEventIndex: l.primaryEventIndex,
      }))
    ).toEqual(
      beforeLegs.map((l) => ({
        sequence: l.sequence,
        status: l.status,
        startedAtSim: l.startedAtSim?.getTime() ?? null,
        completedAtSim: l.completedAtSim?.getTime() ?? null,
        primaryEventIndex: l.primaryEventIndex,
      }))
    );
  });

  it("district province+city 双校验：同名城市 / 省级 fallback 不得误套 district", async () => {
    const seed = findSeed0(HC.NORMAL, "tl-district-guard");

    async function build(tag: string, mutate: { province?: string; city?: string }) {
      const letter = await createDispatchedLetter(bob.uid, "HAND_CARRY", tag);
      await setSeed(letter.letterId, seed);
      if (mutate.province !== undefined || mutate.city !== undefined) {
        await prisma.letter.update({
          where: { id: letter.letterId },
          data: {
            ...(mutate.province !== undefined ? { originProvince: mutate.province } : {}),
            ...(mutate.city !== undefined ? { originCity: mutate.city } : {}),
          },
        });
      }
      clock.advanceTo(T0);
      await advanceJourneyToNow(prisma, letter.letterId, clock);
      clock.advanceTo(FINAL_MS);
      await advanceJourneyToNow(prisma, letter.letterId, clock);
      // 先触发 materialization（canonicalTimelineSnapshot 只读 DB）
      await timelineOf(letter.trackingNo, alice.accessToken);
      const snapshot = await canonicalTimelineSnapshot(letter.letterId);
      return snapshot.find((r) => r.type === "DISPATCHED");
    }

    // (1) province + city 双匹配 → 真实 district
    const both = await build("tl-district-both", {});
    expect(both?.district).toBe("徐汇区");
    // (2) province 不同 + city 相同 → null（防止同名城市 / 跨省同 city label）
    const provMismatch = await build("tl-district-prov", { province: "假想省" });
    expect(provMismatch?.city).toBe("上海市");
    expect(provMismatch?.district).toBeNull();
    // (3) province 相同 + city 不同 → null
    const cityMismatch = await build("tl-district-city", { city: "假想市" });
    expect(cityMismatch?.province).toBe("上海市");
    expect(cityMismatch?.district).toBeNull();
  });

  it("WorldEvent 编号连续无空洞：NORMAL 不占号，派生事件按序分配", async () => {
    // (1) NORMAL：不产生任何事件 → 事件编号分配器保持 0（此前会因预分配产生空洞）
    const normalSeed = findSeed0(HC.NORMAL, "tl-num-normal");
    const normal = await createDispatchedLetter(bob.uid, "HAND_CARRY", "tl-num-normal");
    await setSeed(normal.letterId, normalSeed);
    clock.advanceTo(T0);
    await advanceJourneyToNow(prisma, normal.letterId, clock);
    clock.advanceTo(FINAL_MS);
    await advanceJourneyToNow(prisma, normal.letterId, clock);
    const normalJourney = await journeyOf(normal.letterId);
    const normalEvents = await prisma.worldEvent.findMany({
      where: { journeyId: normalJourney.id },
    });
    expect(normalEvents).toHaveLength(0);
    expect(normalJourney.nextWorldEventIndex).toBe(0);

    // (2) 多 Leg + 派生事件场景：编号严格连续 0..n-1，且分配器 == 事件数
    const dropSeed = findSeed01(HC.LETTER_DROPPED, DROP_WINDOW.WITHIN_24H, "tl-num-multi");
    const multi = await createDispatchedLetter(bob.uid, "HAND_CARRY", "tl-num-multi");
    await setSeed(multi.letterId, dropSeed);
    clock.advanceTo(T0);
    await advanceJourneyToNow(prisma, multi.letterId, clock);
    clock.advanceTo(FINAL_MS);
    await advanceJourneyToNow(prisma, multi.letterId, clock);
    const multiJourney = await journeyOf(multi.letterId);
    const multiEvents = await prisma.worldEvent.findMany({
      where: { journeyId: multiJourney.id },
      orderBy: { eventIndex: "asc" },
    });
    expect(multiEvents.length).toBeGreaterThan(0);
    expect(multiEvents.map((e) => e.eventIndex)).toEqual(multiEvents.map((_, i) => i));
    expect(multiJourney.nextWorldEventIndex).toBe(multiEvents.length);
    // Leg primary 编号与事件表一一对应（有事件的 Leg 才占号）
    const legs = await prisma.transportLeg.findMany({
      where: { journeyId: multiJourney.id },
      orderBy: { sequence: "asc" },
    });
    const recordedIndexes = new Set(multiEvents.map((e) => e.eventIndex));
    for (const leg of legs) {
      const idx = leg.primaryEventIndex;
      if (idx === null) continue; // NORMAL / 收尾 REROUTE 不分配编号（无空洞来源）
      // 分配了编号的 Leg 必定有对应事件行
      expect(recordedIndexes.has(idx)).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // 14. 旧版本升级兼容（Gate H1 / migration 14→15）
  // -------------------------------------------------------------------------

  it("legacy 预留编号兼容：升级后继续推进复用预留编号，canonical 从其后分配且不碰撞", async () => {
    const seed = findSeed0(HC.LOST_PATH, "tl-legacy-reserved");
    const { letterId } = await createDispatchedLetter(bob.uid, "HAND_CARRY", "tl-legacy-reserved");
    await setSeed(letterId, seed);

    // 1) 新代码判定阶段：outcome 已冻结、编号未占用（M1）
    clock.advanceTo(T0);
    await advanceJourneyToNow(prisma, letterId, clock);
    const journey0 = await journeyOf(letterId);
    const legs0 = await prisma.transportLeg.findMany({
      where: { journeyId: journey0.id },
      orderBy: { sequence: "asc" },
    });
    const leg0 = legs0[0];
    expect(leg0?.primaryEventOutcome).toBe("LOST_PATH");
    expect(leg0?.primaryEventIndex).toBeNull();
    expect(journey0.nextWorldEventIndex).toBe(0);

    // 2) 模拟旧版本（migration 13 及之前）的合法历史状态：
    //    primaryEventIndex 已被预留（0 → 用 5 更能体现"更高编号"），且 migration 15 已把 cursor 校准为下界。
    const legacyReserved = 5;
    await prisma.transportLeg.update({
      where: { id: leg0?.id ?? BigInt(0) },
      data: { primaryEventIndex: legacyReserved },
    });
    await prisma.journey.update({
      where: { id: journey0.id },
      data: { nextWorldEventIndex: legacyReserved + 1 }, // migration 15 等价校准结果
    });

    // 3) 继续推进到事件真正发生
    clock.advanceTo(T0 + (leg0?.plannedDurationSeconds ?? 0) * 1000 + HOUR_MS);
    await advanceJourneyToNow(prisma, letterId, clock);

    const events = await prisma.worldEvent.findMany({
      where: { journeyId: journey0.id },
      orderBy: { eventIndex: "asc" },
    });
    const lost = events.find((e) => e.eventType === "LOST_PATH");
    const canonical = events.find((e) => e.eventType === "COURIER_MISSING");
    // legacy explicit 预留编号被尊重；canonical 严格在其后 → 无 P2002、无碰撞
    expect(lost?.eventIndex).toBe(legacyReserved);
    expect(canonical?.eventIndex).toBe(legacyReserved + 1);
    const journey1 = await journeyOf(letterId);
    expect(journey1.nextWorldEventIndex).toBeGreaterThan(legacyReserved + 1);
    // 冻结的预留字段未被改写；outcome 不重抽
    const legAfter = await prisma.transportLeg.findUniqueOrThrow({
      where: { id: leg0?.id ?? BigInt(0) },
    });
    expect(legAfter.primaryEventIndex).toBe(legacyReserved);
    expect(legAfter.primaryEventOutcome).toBe("LOST_PATH");
    // 用户可见失联事实恰好一条
    await timelineOf(
      (await prisma.letter.findUniqueOrThrow({ where: { id: letterId } })).trackingNo,
      alice.accessToken
    );
    const rows = await prisma.timelineEvent.findMany({
      where: { letterId, type: "COURIER_MISSING" },
    });
    expect(rows).toHaveLength(1);
  });

  it("legacy reservation 在回滚后保留（fault injection 不清除冻结预留编号）", async () => {
    const seed = findSeed0(HC.LOST_PATH, "tl-legacy-rollback");
    const { letterId } = await createDispatchedLetter(bob.uid, "HAND_CARRY", "tl-legacy-rollback");
    await setSeed(letterId, seed);
    clock.advanceTo(T0);
    await advanceJourneyToNow(prisma, letterId, clock);

    const journey = await journeyOf(letterId);
    const legs = await prisma.transportLeg.findMany({
      where: { journeyId: journey.id },
      orderBy: { sequence: "asc" },
    });
    const leg0 = legs[0];
    const legacyReserved = 3;
    await prisma.transportLeg.update({
      where: { id: leg0?.id ?? BigInt(0) },
      data: { primaryEventIndex: legacyReserved },
    });
    await prisma.journey.update({
      where: { id: journey.id },
      data: { nextWorldEventIndex: legacyReserved + 1 },
    });
    const beforeJourney = await journeyOf(letterId);

    setWorldEventPersistFaultForTest(() => {
      throw new Error("injected_legacy_rollback_fault");
    });
    try {
      clock.advanceTo(T0 + (leg0?.plannedDurationSeconds ?? 0) * 1000 + HOUR_MS);
      await expect(advanceJourneyToNow(prisma, letterId, clock)).rejects.toThrow(
        /injected_legacy_rollback_fault/
      );
    } finally {
      setWorldEventPersistFaultForTest(null);
    }

    const afterJourney = await journeyOf(letterId);
    const legAfter = await prisma.transportLeg.findUniqueOrThrow({
      where: { id: leg0?.id ?? BigInt(0) },
    });
    expect(await prisma.worldEvent.count({ where: { journeyId: journey.id } })).toBe(0);
    expect(afterJourney.nextWorldEventIndex).toBe(beforeJourney.nextWorldEventIndex);
    expect(afterJourney.nextRandomDrawIndex).toBe(beforeJourney.nextRandomDrawIndex);
    expect(afterJourney.lastAdvancedAtSim?.getTime()).toBe(
      beforeJourney.lastAdvancedAtSim?.getTime()
    );
    // legacy 预留编号未被清空
    expect(legAfter.primaryEventIndex).toBe(legacyReserved);
  });
});
