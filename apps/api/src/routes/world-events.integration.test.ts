import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, requireTestDatabaseUrl } from "@yishu/config";
import { createPrismaClient, type PrismaClient } from "@yishu/db";
import { deterministicDraw, TestSimulationClock } from "@yishu/simulation";
import {
  LAST_MILE_DURATION_SECONDS,
  PERMANENT_LOSS_SECONDS,
  SET_ASIDE_DELAY_SECONDS,
  UnknownRulesVersionError,
  type TransportType,
} from "@yishu/shared";
import { buildApp } from "../app.js";
import type { FastifyInstance } from "fastify";
import { resetStationGraphCache, UnknownGraphVersionError } from "../lib/stationGraph.js";
import { advanceJourneyToNow } from "../lib/journey-advance.js";

/**
 * Phase 6 Random Events + Recovery + World Truth 集成测试。
 * 仅 *_test 库。所有随机源固定 seed（确定性，不允许 flaky）；时间用 TestSimulationClock 推进。
 */
describe("world events integration", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let alice: { account: string; uid: string; accessToken: string };
  let bob: { account: string; uid: string; accessToken: string };

  const T0 = new Date("2026-10-01T00:00:00Z").getTime();
  const HOUR_MS = 3600 * 1000;
  const DAY_MS = 24 * HOUR_MS;

  /** HAND_CARRY 一级事件区间（shared 冻结表；测试搜索确定性 seed 用）。 */
  const HC = {
    NORMAL: [0, 0.84] as const,
    DELAY: [0.84, 0.89] as const,
    REROUTE: [0.89, 0.93] as const,
    LOST_PATH: [0.93, 0.95] as const,
    ROBBERY: [0.95, 0.97] as const,
    COURIER_MISSING: [0.97, 0.985] as const,
    LETTER_DROPPED: [0.985, 0.995] as const,
    SERIOUS_ACCIDENT: [0.995, 1] as const,
  } as const;
  /** PIGEON 一级事件区间。 */
  const PG = {
    NORMAL: [0, 0.92] as const,
    DEVIATION: [0.92, 0.95] as const,
    TEMPORARY_STOP: [0.95, 0.97] as const,
    LOST: [0.97, 0.985] as const,
    LETTER_DROPPED: [0.985, 0.99] as const,
    COURIER_MISSING: [0.99, 0.997] as const,
    SERIOUS_ACCIDENT: [0.997, 1] as const,
  } as const;
  const ROBBERY_BRANCH = {
    ESCAPE_DELAY: [0, 0.55] as const,
    INJURED_CONTINUE: [0.55, 0.8] as const,
    MISSING_DROPPED: [0.8, 0.95] as const,
    DEAD_DROPPED: [0.95, 1] as const,
  } as const;
  const DROP_WINDOW = {
    WITHIN_24H: [0, 0.5] as const,
    ONE_TO_THREE_DAYS: [0.5, 0.75] as const,
    THREE_TO_SEVEN_DAYS: [0.75, 0.9] as const,
    NEVER: [0.9, 1] as const,
  } as const;

  /** 搜索 seed：draw(seed,0) ∈ [start,end)。 */
  function findSeed0(start: number, end: number, tag: string): string {
    for (let i = 0; i < 300000; i += 1) {
      const seed = `${tag}-${i}`;
      const d = deterministicDraw(seed, 0);
      if (d >= start && d < end) return seed;
    }
    throw new Error(`no seed found for ${tag}`);
  }

  /** 搜索 seed：draw(seed,0) ∈ r0 且 draw(seed,1) ∈ r1。 */
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

  function createLetter(
    recipient: string,
    content: string,
    transportType = "HAND_CARRY",
    clientRequestId = `cr-${Math.random()}`,
    token = alice.accessToken
  ) {
    return app.inject({
      method: "POST",
      url: "/api/v1/letters",
      headers: { authorization: `Bearer ${token}` },
      payload: { recipient, content, transportType, clientRequestId },
    });
  }

  function initJourney(trackingNo: string, token = alice.accessToken) {
    return app.inject({
      method: "POST",
      url: `/api/v1/letters/${trackingNo}/journey`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  function getLetterDetail(trackingNo: string, token: string) {
    return app.inject({
      method: "GET",
      url: `/api/v1/letters/${trackingNo}`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  async function letterIdOf(trackingNo: string): Promise<bigint> {
    const l = await prisma.letter.findUniqueOrThrow({ where: { trackingNo } });
    return l.id;
  }

  /** 建信 + 初始化 Journey（固定 clientRequestId，测试隔离）。 */
  async function createDispatchedLetter(
    recipient: string,
    transportType: TransportType,
    clientRequestId: string
  ): Promise<{ trackingNo: string; letterId: bigint }> {
    const letterRes = await createLetter(
      recipient,
      `content ${clientRequestId}`,
      transportType,
      clientRequestId
    );
    const trackingNo = letterRes.json().letter.trackingNo;
    const initRes = await initJourney(trackingNo);
    expect(initRes.statusCode).toBe(201);
    return { trackingNo, letterId: await letterIdOf(trackingNo) };
  }

  async function setSeed(letterId: bigint, seed: string): Promise<void> {
    await prisma.journey.update({ where: { letterId }, data: { simulationSeed: seed } });
  }

  async function journeyOf(letterId: bigint) {
    return prisma.journey.findUniqueOrThrow({ where: { letterId } });
  }

  async function worldEventsOf(journeyId: bigint) {
    return prisma.worldEvent.findMany({
      where: { journeyId },
      orderBy: { eventIndex: "asc" },
    });
  }

  /**
   * 统一 canonical world snapshot（Gate：A/B replay 全等比较的单一事实来源）。
   * 完整读取并规范化 Letter / Journey / TransportLeg[] / WorldEvent[] 的全部 deterministic 字段；
   * 排除 DB internal auto id、createdAt/updatedAt 等真实审计时间（与 replay 无关）。
   * 数组按稳定 key 排序：legs 按 sequence asc，events 按 eventIndex asc。
   * payload 递归按 key 排序规范化（Postgres jsonb 不保证 key 顺序）。
   */
  interface CanonicalWorldSnapshot {
    letter: {
      status: string;
      currentTransport: string;
      deliveredAt: number | null;
    };
    journey: {
      status: string;
      startedAtSim: number | null;
      completedAtSim: number | null;
      lastAdvancedAtSim: number | null;
      resumeAtSim: number | null;
      lastMileReadyAtSim: number | null;
      currentLegSequence: number | null;
      nextEventIndex: number;
      totalDistanceKm: number;
      rulesVersion: string;
      graphVersion: string;
      anomalyType: string | null;
      anomalyStartedAtSim: number | null;
      anomalyResolvedAtSim: number | null;
    };
    legs: Array<{
      sequence: number;
      fromNodeId: string;
      toNodeId: string;
      transportType: string;
      distanceKm: number;
      plannedDurationSeconds: number;
      status: string;
      startedAtSim: number | null;
      completedAtSim: number | null;
      primaryEventIndex: number | null;
      primaryEventOutcome: string | null;
      delaySeconds: number;
    }>;
    events: Array<{
      eventIndex: number;
      eventType: string;
      occurredAtSim: number;
      nodeId: string;
      transportLegSequence: number | null;
      payload: unknown;
    }>;
  }

  function canonicalizePayload(payload: unknown): unknown {
    if (payload === null || typeof payload !== "object") return payload;
    if (Array.isArray(payload)) return payload.map(canonicalizePayload);
    const obj = payload as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = canonicalizePayload(obj[key]);
    }
    return out;
  }

  async function canonicalWorldSnapshot(letterId: bigint): Promise<CanonicalWorldSnapshot> {
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
      letter: {
        status: letter.status,
        currentTransport: letter.currentTransport,
        deliveredAt: letter.deliveredAt?.getTime() ?? null,
      },
      journey: {
        status: journey.status,
        startedAtSim: journey.startedAtSim?.getTime() ?? null,
        completedAtSim: journey.completedAtSim?.getTime() ?? null,
        lastAdvancedAtSim: journey.lastAdvancedAtSim?.getTime() ?? null,
        resumeAtSim: journey.resumeAtSim?.getTime() ?? null,
        lastMileReadyAtSim: journey.lastMileReadyAtSim?.getTime() ?? null,
        currentLegSequence: journey.currentLegSequence,
        nextEventIndex: journey.nextEventIndex,
        totalDistanceKm: Math.round(journey.totalDistanceKm * 100) / 100,
        rulesVersion: journey.rulesVersion,
        graphVersion: journey.graphVersion,
        anomalyType: journey.anomalyType,
        anomalyStartedAtSim: journey.anomalyStartedAtSim?.getTime() ?? null,
        anomalyResolvedAtSim: journey.anomalyResolvedAtSim?.getTime() ?? null,
      },
      legs: legs.map((l) => ({
        sequence: l.sequence,
        fromNodeId: l.fromNodeId,
        toNodeId: l.toNodeId,
        transportType: l.transportType,
        distanceKm: Math.round(l.distanceKm * 100) / 100,
        plannedDurationSeconds: l.plannedDurationSeconds,
        status: l.status,
        startedAtSim: l.startedAtSim?.getTime() ?? null,
        completedAtSim: l.completedAtSim?.getTime() ?? null,
        primaryEventIndex: l.primaryEventIndex,
        primaryEventOutcome: l.primaryEventOutcome,
        delaySeconds: l.delaySeconds,
      })),
      events: events.map((e) => ({
        eventIndex: e.eventIndex,
        eventType: e.eventType,
        occurredAtSim: e.occurredAtSim.getTime(),
        nodeId: e.nodeId,
        transportLegSequence: e.transportLegSequence,
        payload: canonicalizePayload(e.payload),
      })),
    };
  }

  /** 激活（advance T0）并推进到目标时刻，返回结果。 */
  async function advanceTo(letterId: bigint, clock: TestSimulationClock, targetMs: number) {
    clock.advanceTo(T0);
    await advanceJourneyToNow(prisma, letterId, clock); // 激活第一个 leg（建立运输基准 T0）
    clock.advanceTo(targetMs);
    return advanceJourneyToNow(prisma, letterId, clock);
  }

  beforeAll(async () => {
    resetStationGraphCache();
    const testDbUrl = requireTestDatabaseUrl(process.env);
    const config = loadConfig({ NODE_ENV: "test" });
    prisma = createPrismaClient(testDbUrl);
    await prisma.worldEvent.deleteMany();
    await prisma.transportLeg.deleteMany();
    await prisma.journey.deleteMany();
    await prisma.recipientState.deleteMany();
    await prisma.senderState.deleteMany();
    await prisma.letter.deleteMany();
    await prisma.refreshToken.deleteMany();
    await prisma.block.deleteMany();
    await prisma.user.deleteMany();
    app = buildApp(config, { prisma });
    alice = await registerUser({
      account: "alice6",
      password: "alice6-pass",
      nickname: "A6",
      province: "上海市",
      city: "上海市",
      district: "徐汇区",
    });
    bob = await registerUser({
      account: "bob6",
      password: "bob6-pass",
      nickname: "B6",
      province: "北京市",
      city: "北京市",
      district: "海淀区",
    });
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  /** 终态后 replay 全等（BLOCKER）：分段推进已 DELIVERED 后再推进到同一最终 now。 */
  it("terminal 后调用频率无关：一次大跳跃 vs 分段（途中 DELIVERED）→ 快照全等", async () => {
    // PIGEON 单 leg：NORMAL seed（无事件，快速送达）
    let seed = "";
    for (let i = 0; i < 200000; i += 1) {
      const s = `ev-term-${i}`;
      let ok = true;
      for (let k = 0; k < 8; k += 1) {
        if (deterministicDraw(s, k) >= PG.NORMAL[1]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        seed = s;
        break;
      }
    }
    expect(seed).not.toBe("");
    const big = await createDispatchedLetter("bob6", "PIGEON", "ev-term-big");
    const steps = await createDispatchedLetter("bob6", "PIGEON", "ev-term-steps");
    await setSeed(big.letterId, seed);
    await setSeed(steps.letterId, seed);

    const journeyBig = await journeyOf(big.letterId);
    const leg = await prisma.transportLeg.findFirstOrThrow({
      where: { journeyId: journeyBig.id, sequence: 0 },
    });
    const deliveredMs = T0 + leg.plannedDurationSeconds * 1000 + LAST_MILE_DURATION_SECONDS * 1000;
    const finalMs = deliveredMs + DAY_MS * 10; // 送达后继续推进 10 天

    // A：一次大跳跃到最终时间
    const bigClock = new TestSimulationClock(T0);
    await advanceTo(big.letterId, bigClock, finalMs);

    // B：分段推进（途中已 DELIVERED），再推进到同一最终时间
    const stepsClock = new TestSimulationClock(T0);
    await advanceJourneyToNow(prisma, steps.letterId, stepsClock);
    for (let ms = DAY_MS; ms < finalMs - T0; ms += DAY_MS) {
      stepsClock.advanceTo(T0 + ms);
      await advanceJourneyToNow(prisma, steps.letterId, stepsClock);
    }
    stepsClock.advanceTo(finalMs); // 兜底精确到最终时刻
    await advanceJourneyToNow(prisma, steps.letterId, stepsClock);

    // 完整 canonical 全等（Letter.status/deliveredAt、Journey 全字段含 lastMileReadyAtSim、
    // Legs 完整状态、WorldEvent 完整序列 nodeId/transportLegSequence/payload）
    const bigSnap = await canonicalWorldSnapshot(big.letterId);
    const stepsSnap = await canonicalWorldSnapshot(steps.letterId);
    expect(bigSnap.letter.status).toBe("DELIVERED");
    expect(stepsSnap.letter.status).toBe("DELIVERED");
    expect(stepsSnap).toEqual(bigSnap);

    // lastMileReadyAtSim 生命周期（正常 last-mile）：= journeyCompletedAt（无恢复），已持久化
    expect(bigSnap.journey.lastMileReadyAtSim).toBe(
      deliveredMs - LAST_MILE_DURATION_SECONDS * 1000
    );
    expect(bigSnap.letter.deliveredAt).toBe(deliveredMs);

    // deliveredAt / lastMileReadyAtSim 不被重写：terminal 后再推进两者都不变
    const before = bigSnap.letter.deliveredAt;
    bigClock.advanceTo(finalMs + DAY_MS);
    const again = await advanceJourneyToNow(prisma, big.letterId, bigClock);
    expect(again.changed).toBe(false);
    const afterSnap = await canonicalWorldSnapshot(big.letterId);
    expect(afterSnap.letter.deliveredAt).toBe(before);
    // lastMileReadyAtSim 在 terminal 后保持历史值（不被更晚值覆盖、不退化）
    expect(afterSnap.journey.lastMileReadyAtSim).toBe(bigSnap.journey.lastMileReadyAtSim);
  });

  /** 连续两次 reroute：大跳跃 vs 分段全等 + 路线无断链 + totalDistance 一致（BLOCKER-2）。 */
  it("连续两次 reroute：一次大跳跃 vs 分段推进 → 路线连续、距离一致、全等", async () => {
    // 找 seed：draw0 ∈ REROUTE 且 draw1 ∈ REROUTE（前两个 leg 都 reroute）
    let seed = "";
    for (let i = 0; i < 1000000; i += 1) {
      const s = `ev-2rr-${i}`;
      const d0 = deterministicDraw(s, 0);
      const d1 = deterministicDraw(s, 1);
      if (d0 >= HC.REROUTE[0] && d0 < HC.REROUTE[1] && d1 >= HC.REROUTE[0] && d1 < HC.REROUTE[1]) {
        seed = s;
        break;
      }
    }
    expect(seed).not.toBe("");
    const big = await createDispatchedLetter("bob6", "HAND_CARRY", "ev-2rr-big");
    const steps = await createDispatchedLetter("bob6", "HAND_CARRY", "ev-2rr-steps");
    await setSeed(big.letterId, seed);
    await setSeed(steps.letterId, seed);

    const jb = await journeyOf(big.letterId);
    const legs0 = await prisma.transportLeg.findMany({
      where: { journeyId: jb.id },
      orderBy: { sequence: "asc" },
    });
    const leg0 = legs0[0];
    const leg1 = legs0[1];
    const firstEnd = T0 + (leg0?.plannedDurationSeconds ?? 0) * 1000;
    const secondEnd = firstEnd + (leg1?.plannedDurationSeconds ?? 0) * 1000;
    const finalMs = secondEnd + DAY_MS * 10;

    // A：一次大跳跃
    const bigClock = new TestSimulationClock(T0);
    await advanceTo(big.letterId, bigClock, finalMs);

    // B：分段推进
    const stepsClock = new TestSimulationClock(T0);
    await advanceJourneyToNow(prisma, steps.letterId, stepsClock);
    for (let ms = 3 * HOUR_MS; ms < finalMs - T0; ms += 3 * HOUR_MS) {
      stepsClock.advanceTo(T0 + ms);
      await advanceJourneyToNow(prisma, steps.letterId, stepsClock);
    }
    stepsClock.advanceTo(finalMs); // 兜底精确到最终时刻
    await advanceJourneyToNow(prisma, steps.letterId, stepsClock);

    // 完整 canonical 全等（两条执行路径的完整 Leg 快照 / WorldEvent / Journey / Letter）
    const bigSnap = await canonicalWorldSnapshot(big.letterId);
    const stepsSnap = await canonicalWorldSnapshot(steps.letterId);
    expect(stepsSnap).toEqual(bigSnap);

    const bigLegs = bigSnap.legs;
    const stepsLegs = stepsSnap.legs;
    expect(stepsLegs.length).toBe(bigLegs.length);
    expect(bigLegs.length).toBeGreaterThan(2); // 两次 reroute 重建后仍有剩余路线

    // sequence = 0,1,2,... 连续；leg[i].toNodeId === leg[i+1].fromNodeId（无断链）
    const checkContinuity = (arr: CanonicalWorldSnapshot["legs"]) => {
      for (let i = 0; i < arr.length; i += 1) {
        expect(arr[i]?.sequence).toBe(i);
        if (i > 0) expect(arr[i]?.fromNodeId).toBe(arr[i - 1]?.toNodeId);
      }
    };
    checkContinuity(bigLegs);
    checkContinuity(stepsLegs);

    // 旧 remaining Legs 完全不存在：原计划 leg0.to → leg1.to 边（被排除）不在任何 final legs 中
    for (const l of [...bigLegs, ...stepsLegs]) {
      expect(l.fromNodeId === leg0?.toNodeId && l.toNodeId === leg1?.toNodeId).toBe(false);
    }

    // completed history 不变：leg0 仍 COMPLETED
    expect(bigLegs[0]?.status).toBe("COMPLETED");
    expect(stepsLegs[0]?.status).toBe("COMPLETED");

    // totalDistanceKm === sum(legs)（两条路径都成立）
    const sumBig = bigLegs.reduce((a, l) => a + l.distanceKm, 0);
    expect(Math.abs(bigSnap.journey.totalDistanceKm - sumBig)).toBeLessThan(0.01);
    const sumSteps = stepsLegs.reduce((a, l) => a + l.distanceKm, 0);
    expect(Math.abs(stepsSnap.journey.totalDistanceKm - sumSteps)).toBeLessThan(0.01);

    // WorldEvent eventIndex 一致且单调
    for (let i = 1; i < bigSnap.events.length; i += 1) {
      expect(bigSnap.events[i]?.eventIndex).toBeGreaterThan(
        bigSnap.events[i - 1]?.eventIndex ?? -1
      );
    }
    // 至少 2 次 REROUTED
    expect(bigSnap.events.filter((e) => e.eventType === "REROUTED").length).toBeGreaterThanOrEqual(
      2
    );
  });

  /** SET_ASIDE（HIGH）：真正 A/B 两条相同 deterministic fixture —— 一次跳跃 vs 分段 → canonical 全等。
   * resume 前：next Leg 保持 PLANNED / startedAtSim null / 无 primary event；
   * 跨 resume 后：startedAtSim = resumeAtSim，正确消费剩余模拟时间。 */
  it("SET_ASIDE：一次跳跃 vs 分段（resume 前/后分段 advance）→ canonical 全等", async () => {
    // 需要 drop + WITHIN_24H + handling=SET_ASIDE(draw3∈[0.9,1))
    // draw: 0=primary(drop) 1=window 2=range 3=handling
    let seed = "";
    for (let i = 0; i < 1000000; i += 1) {
      const s = `ev-setaside-${i}`;
      const d0 = deterministicDraw(s, 0);
      const d1 = deterministicDraw(s, 1);
      const d3 = deterministicDraw(s, 3);
      if (
        d0 >= HC.LETTER_DROPPED[0] &&
        d0 < HC.LETTER_DROPPED[1] &&
        d1 >= DROP_WINDOW.WITHIN_24H[0] &&
        d1 < DROP_WINDOW.WITHIN_24H[1] &&
        d3 >= 0.9
      ) {
        seed = s;
        break;
      }
    }
    expect(seed).not.toBe("");
    const big = await createDispatchedLetter("bob6", "HAND_CARRY", "ev-setaside-big");
    const steps = await createDispatchedLetter("bob6", "HAND_CARRY", "ev-setaside-steps");
    await setSeed(big.letterId, seed);
    await setSeed(steps.letterId, seed);
    const journeySteps = await journeyOf(steps.letterId);
    const leg0 = await prisma.transportLeg.findFirstOrThrow({
      where: { journeyId: journeySteps.id, sequence: 0 },
    });
    const legEnd = T0 + leg0.plannedDurationSeconds * 1000;
    // finalMs 足够远：覆盖 drop → recovery(SET_ASIDE +24h) → resume 续运 → 多段 remaining → last-mile → DELIVERED
    const finalMs = legEnd + DAY_MS * 40;

    // A：一次大跳跃到最终 now
    const bigClock = new TestSimulationClock(T0);
    await advanceTo(big.letterId, bigClock, finalMs);

    // B：resume 前 / resume 后分段 advance
    const stepsClock = new TestSimulationClock(T0);
    await advanceJourneyToNow(prisma, steps.letterId, stepsClock); // 激活
    stepsClock.advanceTo(legEnd);
    await advanceJourneyToNow(prisma, steps.letterId, stepsClock); // drop 发生
    const dropped = await journeyOf(steps.letterId);
    const resolvedMs = dropped.anomalyResolvedAtSim?.getTime() ?? legEnd;
    const resumeAtMs = resolvedMs + SET_ASIDE_DELAY_SECONDS * 1000; // 24h 搁置
    // 推进到恢复点 → RECOVERED + SET_ASIDE（resumeAtSim 持久化）
    stepsClock.advanceTo(resolvedMs);
    await advanceJourneyToNow(prisma, steps.letterId, stepsClock);

    // resume 前 12h：恢复已发生，next Leg 保持 PLANNED、startedAtSim null、无 primary event
    stepsClock.advanceTo(resumeAtMs - 12 * HOUR_MS);
    await advanceJourneyToNow(prisma, steps.letterId, stepsClock);
    const jMid = await journeyOf(steps.letterId);
    expect(jMid.resumeAtSim?.getTime()).toBe(resumeAtMs);
    expect(jMid.lastMileReadyAtSim).toBeNull(); // 非目的站异常：last-mile 尚未进入
    const pendingMid = (
      await prisma.transportLeg.findMany({
        where: { journeyId: journeySteps.id, sequence: { gte: 1 } },
      })
    ).sort((a, b) => a.sequence - b.sequence);
    expect(pendingMid.length).toBeGreaterThan(0);
    const nextMid = pendingMid.find((l) => l.status !== "COMPLETED");
    expect(nextMid?.status).toBe("PLANNED");
    expect(nextMid?.primaryEventIndex).toBeNull();
    expect(nextMid?.startedAtSim).toBeNull();

    // 跨 resume 后（resumeAtMs 时刻）第一次推进：续运起点 = resumeAtMs
    stepsClock.advanceTo(resumeAtMs);
    const crossed = await advanceJourneyToNow(prisma, steps.letterId, stepsClock);
    expect(crossed.changed).toBe(true);
    const jAfter = await journeyOf(steps.letterId);
    expect(jAfter.resumeAtSim).toBeNull(); // 已消费清空
    const pendingAfter = (
      await prisma.transportLeg.findMany({
        where: { journeyId: journeySteps.id, sequence: { gte: 1 } },
      })
    ).sort((a, b) => a.sequence - b.sequence);
    const first = pendingAfter.find((l) => l.status !== "COMPLETED");
    expect(first?.startedAtSim?.getTime()).toBe(resumeAtMs); // 续运起点 = resumeAt
    expect(first?.status).toBe("ACTIVE");

    // 继续分段推进到 finalMs：从 resumeAtMs 起每 6h 推进到 finalMs
    for (let ms = 6 * HOUR_MS; resumeAtMs + ms <= finalMs; ms += 6 * HOUR_MS) {
      stepsClock.advanceTo(resumeAtMs + ms);
      await advanceJourneyToNow(prisma, steps.letterId, stepsClock);
    }
    stepsClock.advanceTo(finalMs); // 兜底精确到最终时刻
    await advanceJourneyToNow(prisma, steps.letterId, stepsClock);

    // 最终 canonical 全等
    const bigSnap = await canonicalWorldSnapshot(big.letterId);
    const stepsSnap = await canonicalWorldSnapshot(steps.letterId);
    expect(stepsSnap).toEqual(bigSnap);
    expect(bigSnap.letter.status).toBe("DELIVERED");
    expect(bigSnap.journey.resumeAtSim ?? null).toBeNull(); // 已消费清空
  });

  /** 未知 graphVersion reroute rollback（HIGH）：只捕获 NoRouteError。 */
  it("unknown graphVersion reroute：抛 UnknownGraphVersionError，无 WorldEvent / 无状态写入 / 事务回滚", async () => {
    const seed = findSeed0(HC.REROUTE[0], HC.REROUTE[1], "ev-badgraph");
    const { letterId } = await createDispatchedLetter("bob6", "HAND_CARRY", "ev-badgraph");
    await setSeed(letterId, seed);
    const journey = await journeyOf(letterId);
    const leg0 = await prisma.transportLeg.findFirstOrThrow({
      where: { journeyId: journey.id, sequence: 0 },
    });
    const legEnd = T0 + leg0.plannedDurationSeconds * 1000;

    // 未知 graphVersion（合法 Letter，非法推进配置）
    await prisma.journey.update({ where: { letterId }, data: { graphVersion: "china-v999" } });

    const clock = new TestSimulationClock(T0);
    clock.advanceTo(T0);
    await advanceJourneyToNow(prisma, letterId, clock); // 激活（不触发 reroute）
    clock.advanceTo(legEnd);
    await expect(advanceJourneyToNow(prisma, letterId, clock)).rejects.toThrow(
      UnknownGraphVersionError
    );

    // 回滚：本次推进未写 WorldEvent / 未消费 eventIndex / 未改变 leg 状态
    // （首次"激活"在独立事务已提交：leg0 ACTIVE、nextEventIndex=1、lastAdvanced=T0）
    const events = await worldEventsOf(journey.id);
    expect(events).toHaveLength(0);
    const legAfter = await prisma.transportLeg.findFirstOrThrow({
      where: { journeyId: journey.id, sequence: 0 },
    });
    expect(legAfter.status).toBe("ACTIVE"); // 首次激活的结果，未被本次回滚改变
    const j = await journeyOf(letterId);
    expect(j.nextEventIndex).toBe(1); // 本次推进未再消费
    expect(j.lastAdvancedAtSim?.getTime()).toBe(T0); // 本次推进未前进（回滚）
  });

  /** 目的站异常恢复（HIGH）：PIGEON 最终 Leg LETTER_DROPPED 后送达从恢复时刻起算，不得因果倒置。 */
  it("目的站 drop 恢复：deliveredAt = max(legEnd, resumeAt) + 6h，不早于 RECOVERED", async () => {
    // PIGEON: d0 ∈ LETTER_DROPPED[0.985,0.99) + d1 ∈ WITHIN_24H[0,0.5) + d3 ∈ [0,0.9)（普通恢复非 SET_ASIDE）
    let seed = "";
    for (let i = 0; i < 1000000; i += 1) {
      const s = `ev-finaldrop-${i}`;
      const d0 = deterministicDraw(s, 0);
      const d1 = deterministicDraw(s, 1);
      const d3 = deterministicDraw(s, 3);
      if (
        d0 >= PG.LETTER_DROPPED[0] &&
        d0 < PG.LETTER_DROPPED[1] &&
        d1 >= DROP_WINDOW.WITHIN_24H[0] &&
        d1 < DROP_WINDOW.WITHIN_24H[1] &&
        d3 < 0.9
      ) {
        seed = s;
        break;
      }
    }
    expect(seed).not.toBe("");
    const { letterId } = await createDispatchedLetter("bob6", "PIGEON", "ev-finaldrop");
    await setSeed(letterId, seed);
    const journey = await journeyOf(letterId);
    const leg0 = await prisma.transportLeg.findFirstOrThrow({
      where: { journeyId: journey.id, sequence: 0 },
    });
    const legEnd = T0 + leg0.plannedDurationSeconds * 1000;

    const clock = new TestSimulationClock(T0);
    await advanceTo(letterId, clock, legEnd); // 到达目标站触发 drop
    const dropped = await journeyOf(letterId);
    expect(dropped.anomalyType).toBe("LETTER_DROPPED");
    const resolvedMs = dropped.anomalyResolvedAtSim?.getTime() ?? legEnd;
    const resumeAtMs = resolvedMs; // 普通恢复无 setAside
    const deliveredMs = resumeAtMs + LAST_MILE_DURATION_SECONDS * 1000;

    clock.advanceTo(deliveredMs + HOUR_MS);
    const done = await advanceJourneyToNow(prisma, letterId, clock);
    expect(done.letterStatus).toBe("DELIVERED");
    const letter = await prisma.letter.findUniqueOrThrow({ where: { id: letterId } });
    expect(letter.deliveredAt?.getTime()).toBe(deliveredMs);
    const events = await worldEventsOf(journey.id);
    const recovered = events.find((e) => e.eventType === "RECOVERED");
    expect(recovered).toBeDefined();
    // 因果不倒置：送达时刻 >= 找回时刻；deliveredAt = resumeAt + 6h（非 legEnd + 6h）
    expect(deliveredMs).toBeGreaterThanOrEqual(recovered?.occurredAtSim.getTime() ?? 0);
    expect(deliveredMs).toBeGreaterThan(legEnd + LAST_MILE_DURATION_SECONDS * 1000);
  });

  /** 目的站异常 + SET_ASIDE（HIGH）：deliveredAt = (resolved + 24h) + 6h。 */
  it("目的站 drop + SET_ASIDE：送达从 resumeAt（含搁置 24h）起算", async () => {
    let seed = "";
    for (let i = 0; i < 1000000; i += 1) {
      const s = `ev-final-sa-${i}`;
      const d0 = deterministicDraw(s, 0);
      const d1 = deterministicDraw(s, 1);
      const d3 = deterministicDraw(s, 3);
      if (
        d0 >= PG.LETTER_DROPPED[0] &&
        d0 < PG.LETTER_DROPPED[1] &&
        d1 >= DROP_WINDOW.WITHIN_24H[0] &&
        d1 < DROP_WINDOW.WITHIN_24H[1] &&
        d3 >= 0.9
      ) {
        seed = s;
        break;
      }
    }
    expect(seed).not.toBe("");
    const { letterId } = await createDispatchedLetter("bob6", "PIGEON", "ev-final-sa");
    await setSeed(letterId, seed);
    const journey = await journeyOf(letterId);
    const leg0 = await prisma.transportLeg.findFirstOrThrow({
      where: { journeyId: journey.id, sequence: 0 },
    });
    const legEnd = T0 + leg0.plannedDurationSeconds * 1000;

    const clock = new TestSimulationClock(T0);
    await advanceTo(letterId, clock, legEnd); // drop
    const dropped = await journeyOf(letterId);
    const resolvedMs = dropped.anomalyResolvedAtSim?.getTime() ?? legEnd;
    const resumeAtMs = resolvedMs + SET_ASIDE_DELAY_SECONDS * 1000;
    const deliveredMs = resumeAtMs + LAST_MILE_DURATION_SECONDS * 1000;

    clock.advanceTo(deliveredMs + HOUR_MS);
    const done = await advanceJourneyToNow(prisma, letterId, clock);
    expect(done.letterStatus).toBe("DELIVERED");
    const letter = await prisma.letter.findUniqueOrThrow({ where: { id: letterId } });
    expect(letter.deliveredAt?.getTime()).toBe(deliveredMs);
    const events = await worldEventsOf(journey.id);
    const recovered = events.find((e) => e.eventType === "RECOVERED");
    expect(recovered).toBeDefined();
    expect((recovered?.payload as { setAsideSeconds?: number } | null)?.setAsideSeconds).toBe(
      SET_ASIDE_DELAY_SECONDS
    );
  });

  /** 目的站异常恢复 replay：一次大跳跃 vs 分段推进全等。 */
  it("目的站 drop 恢复 replay：一次大跳跃 vs 分段推进 → 快照全等", async () => {
    let seed = "";
    for (let i = 0; i < 1000000; i += 1) {
      const s = `ev-final-replay-${i}`;
      const d0 = deterministicDraw(s, 0);
      const d1 = deterministicDraw(s, 1);
      if (
        d0 >= PG.LETTER_DROPPED[0] &&
        d0 < PG.LETTER_DROPPED[1] &&
        d1 >= DROP_WINDOW.WITHIN_24H[0] &&
        d1 < DROP_WINDOW.WITHIN_24H[1]
      ) {
        seed = s;
        break;
      }
    }
    expect(seed).not.toBe("");
    const big = await createDispatchedLetter("bob6", "PIGEON", "ev-final-rp-b");
    const steps = await createDispatchedLetter("bob6", "PIGEON", "ev-final-rp-s");
    await setSeed(big.letterId, seed);
    await setSeed(steps.letterId, seed);

    const jb = await journeyOf(big.letterId);
    const leg0 = await prisma.transportLeg.findFirstOrThrow({
      where: { journeyId: jb.id, sequence: 0 },
    });
    const legEnd = T0 + leg0.plannedDurationSeconds * 1000;
    const finalMs = legEnd + DAY_MS * 20; // 越过恢复 + last-mile

    // A：一次大跳跃
    const bigClock = new TestSimulationClock(T0);
    await advanceTo(big.letterId, bigClock, finalMs);

    // B：分段推进（legEnd 前每 6h，之后每 6h）
    const stepsClock = new TestSimulationClock(T0);
    await advanceJourneyToNow(prisma, steps.letterId, stepsClock);
    for (let ms = 6 * HOUR_MS; ms < finalMs - T0; ms += 6 * HOUR_MS) {
      stepsClock.advanceTo(T0 + ms);
      await advanceJourneyToNow(prisma, steps.letterId, stepsClock);
    }
    stepsClock.advanceTo(finalMs);
    await advanceJourneyToNow(prisma, steps.letterId, stepsClock);

    // 完整 canonical 全等：Letter(status/deliveredAt/currentTransport)、Journey 全字段
    // （status/lastMileReadyAtSim/resumeAtSim/lastAdvancedAtSim/nextEventIndex/anomaly*）、
    // Legs 完整状态、WorldEvent 完整序列（nodeId/transportLegSequence/payload）
    const bigSnap = await canonicalWorldSnapshot(big.letterId);
    const stepsSnap = await canonicalWorldSnapshot(steps.letterId);
    expect(stepsSnap.letter.status).toBe("DELIVERED");
    expect(stepsSnap.letter.deliveredAt).toBe(bigSnap.letter.deliveredAt);
    expect(stepsSnap).toEqual(bigSnap);

    // 目的站 drop 恢复：lastMileReadyAtSim = max(journeyCompletedAt, resumeAt)（resumeAt 更晚），
    // deliveredAt = lastMileReadyAtSim + 6h；不得早于 RECOVERED（因果不倒置）
    const events = bigSnap.events;
    const recovered = events.find((e) => e.eventType === "RECOVERED");
    expect(recovered).toBeDefined();
    expect(bigSnap.journey.lastMileReadyAtSim).not.toBeNull();
    expect(bigSnap.letter.deliveredAt).toBe(
      (bigSnap.journey.lastMileReadyAtSim ?? 0) + LAST_MILE_DURATION_SECONDS * 1000
    );
    expect(bigSnap.letter.deliveredAt ?? 0).toBeGreaterThanOrEqual(recovered?.occurredAtSim ?? 0);
    // 目的站异常恢复：last-mile 基准 >= 恢复时刻（不早于 legEnd+6h 因果倒置基线）
    expect(bigSnap.journey.lastMileReadyAtSim ?? 0).toBeGreaterThanOrEqual(
      recovered?.occurredAtSim ?? 0
    );
    // lastAdvancedAtSim 同一最终 now
    expect(stepsSnap.journey.lastAdvancedAtSim).toBe(bigSnap.journey.lastAdvancedAtSim);
    expect(stepsSnap.journey.nextEventIndex).toBe(bigSnap.journey.nextEventIndex);
  });

  /** DELAY replay（HIGH）：一次大跳跃 vs 分段 → canonical 全等；同一 Leg 至多一个 primary event；
   * frozen delay 相同；effective completion 相同；事件时间不倒序。 */
  it("DELAY replay：一次大跳跃 vs 分段 → canonical 全等 + delay 冻结一致 + 事件不倒序", async () => {
    const seed = findSeed0(HC.DELAY[0], HC.DELAY[1], "ev-delay-rp");
    const big = await createDispatchedLetter("bob6", "HAND_CARRY", "ev-delay-rp-b");
    const steps = await createDispatchedLetter("bob6", "HAND_CARRY", "ev-delay-rp-s");
    await setSeed(big.letterId, seed);
    await setSeed(steps.letterId, seed);
    const jb = await journeyOf(big.letterId);
    const leg0 = await prisma.transportLeg.findFirstOrThrow({
      where: { journeyId: jb.id, sequence: 0 },
    });
    const legEnd = T0 + leg0.plannedDurationSeconds * 1000;
    // DELAY_MAX 12h：finalMs 越过 legEnd + delay + 后续推进
    const finalMs = legEnd + DAY_MS * 2;

    // A：一次大跳跃
    const bigClock = new TestSimulationClock(T0);
    await advanceTo(big.letterId, bigClock, finalMs);

    // B：分段推进（每 3h）
    const stepsClock = new TestSimulationClock(T0);
    await advanceJourneyToNow(prisma, steps.letterId, stepsClock);
    for (let ms = 3 * HOUR_MS; ms < finalMs - T0; ms += 3 * HOUR_MS) {
      stepsClock.advanceTo(T0 + ms);
      await advanceJourneyToNow(prisma, steps.letterId, stepsClock);
    }
    stepsClock.advanceTo(finalMs);
    await advanceJourneyToNow(prisma, steps.letterId, stepsClock);

    const bigSnap = await canonicalWorldSnapshot(big.letterId);
    const stepsSnap = await canonicalWorldSnapshot(steps.letterId);
    expect(stepsSnap).toEqual(bigSnap);

    // 同一 Leg 至多一个 primary event：leg0 恰好判定一次（DELAYED）
    const leg0Snap = bigSnap.legs[0];
    expect(leg0Snap?.primaryEventIndex).not.toBeNull();
    expect(leg0Snap?.primaryEventOutcome).toBe("DELAYED");
    // frozen delay 相同（A/B 一致且 > 0）
    expect(leg0Snap?.delaySeconds).toBeGreaterThan(0);
    expect(bigSnap.legs[0]?.delaySeconds).toBe(stepsSnap.legs[0]?.delaySeconds);
    // effective completion 相同 = start + (planned + delay)
    expect(leg0Snap?.completedAtSim).toBe(
      (leg0Snap?.startedAtSim ?? 0) +
        ((leg0Snap?.plannedDurationSeconds ?? 0) + (leg0Snap?.delaySeconds ?? 0)) * 1000
    );
    // DELAYED 事件与 leg0.completedAtSim 同一时刻；payload.delaySeconds 与冻结一致
    const delayed = bigSnap.events.find((e) => e.eventType === "DELAYED");
    expect(delayed).toBeDefined();
    expect(delayed?.occurredAtSim).toBe(leg0Snap?.completedAtSim);
    expect((delayed?.payload as { delaySeconds?: number } | null)?.delaySeconds).toBe(
      leg0Snap?.delaySeconds
    );
    // WorldEvent 时间不倒序
    for (let i = 1; i < bigSnap.events.length; i += 1) {
      expect(bigSnap.events[i]?.occurredAtSim ?? 0).toBeGreaterThanOrEqual(
        bigSnap.events[i - 1]?.occurredAtSim ?? 0
      );
    }
  });

  /** PERMANENTLY_LOST terminal replay（HIGH）：分段推进后提前进入 terminal，再推进到同一最终 now。 */
  it("PERMANENTLY_LOST terminal replay：一次大跳跃 vs 分段（提前进入 terminal）→ canonical 全等", async () => {
    const seed = findSeed01(HC.LETTER_DROPPED, DROP_WINDOW.NEVER, "ev-loss-rp");
    const big = await createDispatchedLetter("bob6", "HAND_CARRY", "ev-loss-rp-b");
    const steps = await createDispatchedLetter("bob6", "HAND_CARRY", "ev-loss-rp-s");
    await setSeed(big.letterId, seed);
    await setSeed(steps.letterId, seed);
    const jb = await journeyOf(big.letterId);
    const leg0 = await prisma.transportLeg.findFirstOrThrow({
      where: { journeyId: jb.id, sequence: 0 },
    });
    const legEnd = T0 + leg0.plannedDurationSeconds * 1000;
    const finalMs = legEnd + DAY_MS * 20; // 越过 7 日丢失点 + 数天

    // A：一次大跳跃
    const bigClock = new TestSimulationClock(T0);
    await advanceTo(big.letterId, bigClock, finalMs);

    // B：分段推进（每 6h），中途已进入 terminal，再推进到同一最终 now
    const stepsClock = new TestSimulationClock(T0);
    await advanceJourneyToNow(prisma, steps.letterId, stepsClock);
    for (let ms = 6 * HOUR_MS; ms < finalMs - T0; ms += 6 * HOUR_MS) {
      stepsClock.advanceTo(T0 + ms);
      await advanceJourneyToNow(prisma, steps.letterId, stepsClock);
    }
    stepsClock.advanceTo(finalMs);
    await advanceJourneyToNow(prisma, steps.letterId, stepsClock);

    const bigSnap = await canonicalWorldSnapshot(big.letterId);
    const stepsSnap = await canonicalWorldSnapshot(steps.letterId);
    expect(bigSnap.letter.status).toBe("PERMANENTLY_LOST");
    expect(stepsSnap).toEqual(bigSnap);
    expect(bigSnap.events.some((e) => e.eventType === "PERMANENTLY_LOST")).toBe(true);
    // 从未进入 last-mile：lastMileReadyAtSim 保持 null
    expect(bigSnap.journey.lastMileReadyAtSim).toBeNull();
    // terminal 后再推进：no-op，lastMileReadyAtSim 不变
    bigClock.advanceTo(finalMs + DAY_MS * 5);
    const again = await advanceJourneyToNow(prisma, big.letterId, bigClock);
    expect(again.changed).toBe(false);
    expect((await canonicalWorldSnapshot(big.letterId)).journey.lastMileReadyAtSim).toBeNull();
  });

  /** DESTROYED terminal replay（HIGH）：PIGEON 严重事故 → 提前进入 terminal，再推进到同一最终 now。 */
  it("DESTROYED terminal replay：一次大跳跃 vs 分段（提前进入 terminal）→ canonical 全等", async () => {
    const seed = findSeed0(PG.SERIOUS_ACCIDENT[0], PG.SERIOUS_ACCIDENT[1], "ev-destroyed-rp");
    const big = await createDispatchedLetter("bob6", "PIGEON", "ev-destroyed-rp-b");
    const steps = await createDispatchedLetter("bob6", "PIGEON", "ev-destroyed-rp-s");
    await setSeed(big.letterId, seed);
    await setSeed(steps.letterId, seed);
    const jb = await journeyOf(big.letterId);
    const leg0 = await prisma.transportLeg.findFirstOrThrow({
      where: { journeyId: jb.id, sequence: 0 },
    });
    const legEnd = T0 + leg0.plannedDurationSeconds * 1000;
    const finalMs = legEnd + DAY_MS * 10;

    // A：一次大跳跃
    const bigClock = new TestSimulationClock(T0);
    await advanceTo(big.letterId, bigClock, finalMs);

    // B：分段推进（每 6h），中途已 DESTROYED，再推进到同一最终 now
    const stepsClock = new TestSimulationClock(T0);
    await advanceJourneyToNow(prisma, steps.letterId, stepsClock);
    for (let ms = 6 * HOUR_MS; ms < finalMs - T0; ms += 6 * HOUR_MS) {
      stepsClock.advanceTo(T0 + ms);
      await advanceJourneyToNow(prisma, steps.letterId, stepsClock);
    }
    stepsClock.advanceTo(finalMs);
    await advanceJourneyToNow(prisma, steps.letterId, stepsClock);

    const bigSnap = await canonicalWorldSnapshot(big.letterId);
    const stepsSnap = await canonicalWorldSnapshot(steps.letterId);
    expect(bigSnap.letter.status).toBe("DESTROYED");
    expect(stepsSnap).toEqual(bigSnap);
    expect(bigSnap.events.some((e) => e.eventType === "SERIOUS_ACCIDENT")).toBe(true);
    expect(bigSnap.journey.lastMileReadyAtSim).toBeNull();
    // terminal 后再推进：no-op，lastMileReadyAtSim 不变
    bigClock.advanceTo(finalMs + DAY_MS * 3);
    const again = await advanceJourneyToNow(prisma, big.letterId, bigClock);
    expect(again.changed).toBe(false);
    const afterSnap = await canonicalWorldSnapshot(big.letterId);
    expect(afterSnap.journey.lastMileReadyAtSim).toBeNull();
    expect(afterSnap.letter.status).toBe("DESTROYED");
  });

  /** lastMileReadyAtSim 生命周期（HIGH）：正常 last-mile 持久化、retry/时间倒退不退化、terminal 后不变。 */
  it("lastMileReadyAtSim：正常 last-mile 持久化 + 同 now 重复/时间倒退不退化 + terminal 后不变", async () => {
    // PIGEON NORMAL seed（无事件，快速送达）
    let seed = "";
    for (let i = 0; i < 200000; i += 1) {
      const s = `ev-lmr-${i}`;
      let ok = true;
      for (let k = 0; k < 8; k += 1) {
        if (deterministicDraw(s, k) >= PG.NORMAL[1]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        seed = s;
        break;
      }
    }
    expect(seed).not.toBe("");
    const { letterId } = await createDispatchedLetter("bob6", "PIGEON", "ev-lmr");
    await setSeed(letterId, seed);
    const journey = await journeyOf(letterId);
    const leg0 = await prisma.transportLeg.findFirstOrThrow({
      where: { journeyId: journey.id, sequence: 0 },
    });
    const legEnd = T0 + leg0.plannedDurationSeconds * 1000;
    const deliveredMs = legEnd + LAST_MILE_DURATION_SECONDS * 1000;

    const clock = new TestSimulationClock(T0);
    await advanceJourneyToNow(prisma, letterId, clock); // 激活
    clock.advanceTo(legEnd);
    const mid = await advanceJourneyToNow(prisma, letterId, clock); // leg 完成 → OUT_FOR_DELIVERY
    expect(mid.letterStatus).toBe("OUT_FOR_DELIVERY");
    let j = await journeyOf(letterId);
    expect(j.lastMileReadyAtSim?.getTime()).toBe(legEnd); // last-mile 起点 = 完成时刻

    // 同 now 重复推进（retry/idempotent）：lastMileReadyAtSim 不退化
    const again1 = await advanceJourneyToNow(prisma, letterId, clock);
    expect(again1.changed).toBe(false);
    j = await journeyOf(letterId);
    expect(j.lastMileReadyAtSim?.getTime()).toBe(legEnd);

    // 时间倒退：lastMileReadyAtSim 不退化
    clock.advanceTo(legEnd - HOUR_MS);
    const back = await advanceJourneyToNow(prisma, letterId, clock);
    expect(back.changed).toBe(false);
    j = await journeyOf(letterId);
    expect(j.lastMileReadyAtSim?.getTime()).toBe(legEnd);

    // 越过送达点 → DELIVERED；lastMileReadyAtSim 保持 legEnd（不被更晚值覆盖）
    clock.advanceTo(deliveredMs + HOUR_MS);
    const done = await advanceJourneyToNow(prisma, letterId, clock);
    expect(done.letterStatus).toBe("DELIVERED");
    j = await journeyOf(letterId);
    expect(j.lastMileReadyAtSim?.getTime()).toBe(legEnd);
    const letter = await prisma.letter.findUniqueOrThrow({ where: { id: letterId } });
    expect(letter.deliveredAt?.getTime()).toBe(deliveredMs);

    // terminal 后再推进：lastMileReadyAtSim 不变
    clock.advanceTo(deliveredMs + DAY_MS * 5);
    const after = await advanceJourneyToNow(prisma, letterId, clock);
    expect(after.changed).toBe(false);
    j = await journeyOf(letterId);
    expect(j.lastMileReadyAtSim?.getTime()).toBe(legEnd);
  });

  /** lastMileReadyAtSim 生命周期（HIGH）：目的站 drop 恢复 / SET_ASIDE 基准 = max(完成, resumeAt)。 */
  it("lastMileReadyAtSim：目的站 drop+recovery / drop+SET_ASIDE 基准 = resumeAt（含搁置），因果不倒置", async () => {
    // 目的站 drop + WITHIN_24H + 普通恢复（d3<0.9）
    let seed = "";
    for (let i = 0; i < 1000000; i += 1) {
      const s = `ev-lmr-rec-${i}`;
      const d0 = deterministicDraw(s, 0);
      const d1 = deterministicDraw(s, 1);
      const d3 = deterministicDraw(s, 3);
      if (
        d0 >= PG.LETTER_DROPPED[0] &&
        d0 < PG.LETTER_DROPPED[1] &&
        d1 >= DROP_WINDOW.WITHIN_24H[0] &&
        d1 < DROP_WINDOW.WITHIN_24H[1] &&
        d3 < 0.9
      ) {
        seed = s;
        break;
      }
    }
    expect(seed).not.toBe("");
    const { letterId } = await createDispatchedLetter("bob6", "PIGEON", "ev-lmr-rec");
    await setSeed(letterId, seed);
    const journey = await journeyOf(letterId);
    const leg0 = await prisma.transportLeg.findFirstOrThrow({
      where: { journeyId: journey.id, sequence: 0 },
    });
    const legEnd = T0 + leg0.plannedDurationSeconds * 1000;

    const clock = new TestSimulationClock(T0);
    await advanceTo(letterId, clock, legEnd); // drop 发生（到达目标站）
    const dropped = await journeyOf(letterId);
    expect(dropped.anomalyType).toBe("LETTER_DROPPED");
    const resolvedMs = dropped.anomalyResolvedAtSim?.getTime() ?? legEnd;
    // 恢复：普通恢复无 setAside，resumeAt = resolvedMs
    clock.advanceTo(resolvedMs);
    const rec = await advanceJourneyToNow(prisma, letterId, clock);
    expect(rec.changed).toBe(true);
    const afterRec = await journeyOf(letterId);
    // 目的站异常：last-mile 基准 = max(legEnd, resumeAt) = resumeAt
    expect(afterRec.lastMileReadyAtSim?.getTime()).toBe(resolvedMs);
    // deliveredAt = resumeAt + 6h（不早于 RECOVERED，因果不倒置）
    const deliveredMs = resolvedMs + LAST_MILE_DURATION_SECONDS * 1000;
    clock.advanceTo(deliveredMs + HOUR_MS);
    const done = await advanceJourneyToNow(prisma, letterId, clock);
    expect(done.letterStatus).toBe("DELIVERED");
    const letter = await prisma.letter.findUniqueOrThrow({ where: { id: letterId } });
    expect(letter.deliveredAt?.getTime()).toBe(deliveredMs);
    const j = await journeyOf(letterId);
    expect(j.lastMileReadyAtSim?.getTime()).toBe(resolvedMs);

    // SET_ASIDE 版本（d3>=0.9）：resumeAt = resolvedMs + 24h
    let seedSA = "";
    for (let i = 0; i < 1000000; i += 1) {
      const s = `ev-lmr-sa-${i}`;
      const d0 = deterministicDraw(s, 0);
      const d1 = deterministicDraw(s, 1);
      const d3 = deterministicDraw(s, 3);
      if (
        d0 >= PG.LETTER_DROPPED[0] &&
        d0 < PG.LETTER_DROPPED[1] &&
        d1 >= DROP_WINDOW.WITHIN_24H[0] &&
        d1 < DROP_WINDOW.WITHIN_24H[1] &&
        d3 >= 0.9
      ) {
        seedSA = s;
        break;
      }
    }
    expect(seedSA).not.toBe("");
    const { letterId: saId } = await createDispatchedLetter("bob6", "PIGEON", "ev-lmr-sa");
    await setSeed(saId, seedSA);
    const saJourney = await journeyOf(saId);
    const saLeg0 = await prisma.transportLeg.findFirstOrThrow({
      where: { journeyId: saJourney.id, sequence: 0 },
    });
    const saLegEnd = T0 + saLeg0.plannedDurationSeconds * 1000;

    const saClock = new TestSimulationClock(T0);
    await advanceTo(saId, saClock, saLegEnd);
    const saDropped = await journeyOf(saId);
    expect(saDropped.anomalyType).toBe("LETTER_DROPPED");
    const saResolvedMs = saDropped.anomalyResolvedAtSim?.getTime() ?? saLegEnd;
    const saResumeAtMs = saResolvedMs + SET_ASIDE_DELAY_SECONDS * 1000;
    // 恢复（SET_ASIDE）：resumeAt 已持久化，但 now < resumeAt → last-mile 尚未进入
    saClock.advanceTo(saResolvedMs);
    await advanceJourneyToNow(prisma, saId, saClock);
    let saRec = await journeyOf(saId);
    expect(saRec.resumeAtSim?.getTime()).toBe(saResumeAtMs);
    expect(saRec.lastMileReadyAtSim).toBeNull();
    // 推进到 resumeAt → 进入 last-mile：基准 = resumeAt（含 24h 搁置），不早于 RECOVERED
    saClock.advanceTo(saResumeAtMs);
    await advanceJourneyToNow(prisma, saId, saClock);
    saRec = await journeyOf(saId);
    expect(saRec.lastMileReadyAtSim?.getTime()).toBe(saResumeAtMs);
    const saDeliveredMs = saResumeAtMs + LAST_MILE_DURATION_SECONDS * 1000;
    saClock.advanceTo(saDeliveredMs + HOUR_MS);
    const saDone = await advanceJourneyToNow(prisma, saId, saClock);
    expect(saDone.letterStatus).toBe("DELIVERED");
    const saLetter = await prisma.letter.findUniqueOrThrow({ where: { id: saId } });
    expect(saLetter.deliveredAt?.getTime()).toBe(saDeliveredMs);
    const saJ = await journeyOf(saId);
    expect(saJ.lastMileReadyAtSim?.getTime()).toBe(saResumeAtMs);
  });

  /** WorldEvent.nodeId 全部非空（LOW）。 */
  it("所有 WorldEvent 均含 nodeId（NOT NULL 语义）", async () => {
    const seeds = [
      findSeed0(HC.DELAY[0], HC.DELAY[1], "ev-node-delay"),
      findSeed0(HC.REROUTE[0], HC.REROUTE[1], "ev-node-reroute"),
      findSeed0(HC.ROBBERY[0], HC.ROBBERY[1], "ev-node-rob"),
      findSeed0(HC.COURIER_MISSING[0], HC.COURIER_MISSING[1], "ev-node-miss"),
      findSeed0(HC.LETTER_DROPPED[0], HC.LETTER_DROPPED[1], "ev-node-drop"),
    ];
    for (let i = 0; i < seeds.length; i += 1) {
      const { letterId } = await createDispatchedLetter("bob6", "HAND_CARRY", `ev-node-all-${i}`);
      await setSeed(letterId, seeds[i] ?? "ev-node-fallback");
      const journey = await journeyOf(letterId);
      const leg = await prisma.transportLeg.findFirstOrThrow({
        where: { journeyId: journey.id, sequence: 0 },
      });
      const clock = new TestSimulationClock(T0);
      await advanceTo(letterId, clock, T0 + leg.plannedDurationSeconds * 1000 + DAY_MS * 2);
      const events = await worldEventsOf(journey.id);
      expect(events.length).toBeGreaterThan(0);
      for (const e of events) {
        expect(e.nodeId).toBeTruthy();
        expect(e.nodeId.length).toBeGreaterThan(0);
      }
    }
  });

  /** 调用频率无关 replay（BLOCKER 核心）：一次大跳跃 vs 多次分段推进必须完全一致。 */
  it("调用频率无关：一次大跳跃 vs 分段推进 → Letter/Journey/Legs/WorldEvent 完全一致", async () => {
    // REROUTE seed：第一段完成触发重建，重建后继续消费剩余时间（同时覆盖 BLOCKER-1/2）
    const seed = findSeed0(HC.REROUTE[0], HC.REROUTE[1], "ev-freq");
    const big = await createDispatchedLetter("bob6", "HAND_CARRY", "ev-freq-big");
    const steps = await createDispatchedLetter("bob6", "HAND_CARRY", "ev-freq-steps");
    await setSeed(big.letterId, seed);
    await setSeed(steps.letterId, seed);

    const finalMs = T0 + DAY_MS * 25; // 中途（未送达），跨越 reroute 与多段推进

    // A：一次大跳跃
    const bigClock = new TestSimulationClock(T0);
    await advanceTo(big.letterId, bigClock, finalMs);

    // B：多次分段推进（每 3 小时一次）
    const stepsClock = new TestSimulationClock(T0);
    await advanceJourneyToNow(prisma, steps.letterId, stepsClock);
    for (let ms = 3 * HOUR_MS; ms <= finalMs - T0; ms += 3 * HOUR_MS) {
      stepsClock.advanceTo(T0 + ms);
      await advanceJourneyToNow(prisma, steps.letterId, stepsClock);
    }

    const bigLetter = await prisma.letter.findUniqueOrThrow({ where: { id: big.letterId } });
    const stepsLetter = await prisma.letter.findUniqueOrThrow({ where: { id: steps.letterId } });
    expect(stepsLetter.status).toBe(bigLetter.status);
    expect(stepsLetter.currentTransport).toBe(bigLetter.currentTransport);
    expect(stepsLetter.deliveredAt?.getTime() ?? null).toBe(
      bigLetter.deliveredAt?.getTime() ?? null
    );

    const bigJourney = await journeyOf(big.letterId);
    const stepsJourney = await journeyOf(steps.letterId);
    expect(stepsJourney.status).toBe(bigJourney.status);
    expect(stepsJourney.nextEventIndex).toBe(bigJourney.nextEventIndex);
    expect(stepsJourney.currentLegSequence ?? null).toBe(bigJourney.currentLegSequence ?? null);
    expect(stepsJourney.lastAdvancedAtSim?.getTime()).toBe(bigJourney.lastAdvancedAtSim?.getTime());
    expect(stepsJourney.anomalyType ?? null).toBe(bigJourney.anomalyType ?? null);
    expect(stepsJourney.anomalyStartedAtSim?.getTime() ?? null).toBe(
      bigJourney.anomalyStartedAtSim?.getTime() ?? null
    );
    expect(stepsJourney.anomalyResolvedAtSim?.getTime() ?? null).toBe(
      bigJourney.anomalyResolvedAtSim?.getTime() ?? null
    );
    expect(stepsJourney.completedAtSim?.getTime() ?? null).toBe(
      bigJourney.completedAtSim?.getTime() ?? null
    );

    const bigLegs = await prisma.transportLeg.findMany({
      where: { journeyId: bigJourney.id },
      orderBy: { sequence: "asc" },
    });
    const stepsLegs = await prisma.transportLeg.findMany({
      where: { journeyId: stepsJourney.id },
      orderBy: { sequence: "asc" },
    });
    expect(stepsLegs.length).toBe(bigLegs.length);
    const legKey = (l: {
      sequence: number;
      fromNodeId: string;
      toNodeId: string;
      transportType: string;
      distanceKm: number;
      plannedDurationSeconds: number;
      status: string;
      startedAtSim: Date | null;
      completedAtSim: Date | null;
      primaryEventIndex: number | null;
      primaryEventOutcome: string | null;
      delaySeconds: number;
    }) => [
      l.sequence,
      l.fromNodeId,
      l.toNodeId,
      l.transportType,
      Math.round(l.distanceKm * 100),
      l.plannedDurationSeconds,
      l.status,
      l.startedAtSim?.getTime() ?? null,
      l.completedAtSim?.getTime() ?? null,
      l.primaryEventIndex,
      l.primaryEventOutcome,
      l.delaySeconds,
    ];
    expect(stepsLegs.map(legKey)).toEqual(bigLegs.map(legKey));

    const bigEvents = await worldEventsOf(bigJourney.id);
    const stepsEvents = await worldEventsOf(stepsJourney.id);
    expect(stepsEvents.length).toBe(bigEvents.length);
    expect(
      stepsEvents.map((e) => [
        e.eventIndex,
        e.eventType,
        e.occurredAtSim.getTime(),
        e.nodeId,
        e.transportLegSequence,
        e.payload,
      ])
    ).toEqual(
      bigEvents.map((e) => [
        e.eventIndex,
        e.eventType,
        e.occurredAtSim.getTime(),
        e.nodeId,
        e.transportLegSequence,
        e.payload,
      ])
    );
  });

  it("reroute 后继续消费剩余模拟时间：同 now 再调用是 no-op（BLOCKER-2）", async () => {
    const seed = findSeed0(HC.REROUTE[0], HC.REROUTE[1], "ev-reroute-cont");
    const { letterId } = await createDispatchedLetter("bob6", "HAND_CARRY", "ev-reroute-cont");
    await setSeed(letterId, seed);
    const journey = await journeyOf(letterId);
    const leg0 = await prisma.transportLeg.findFirstOrThrow({
      where: { journeyId: journey.id, sequence: 0 },
    });
    const farMs = T0 + leg0.plannedDurationSeconds * 1000 + DAY_MS * 6; // reroute 后 +6 天

    const clock = new TestSimulationClock(T0);
    const res = await advanceTo(letterId, clock, farMs);
    expect(res.changed).toBe(true);

    const j = await journeyOf(letterId);
    const legs = await prisma.transportLeg.findMany({
      where: { journeyId: journey.id },
      orderBy: { sequence: "asc" },
    });
    // reroute 已重建 remaining；重建后的 leg 已消费事件时刻 → now 的剩余时间（存在 ACTIVE/COMPLETED）
    const pending = legs.filter((l) => l.status !== "COMPLETED");
    expect(pending.length).toBeGreaterThan(0);
    expect(pending[0]?.status).toBe("ACTIVE");
    expect(pending[0]?.startedAtSim?.getTime()).toBeGreaterThan(
      leg0.completedAtSim?.getTime() ?? 0
    );
    // 同 now 再调用 → no-op（不得"补推进"）
    const again = await advanceJourneyToNow(prisma, letterId, clock);
    expect(again.changed).toBe(false);
    void j;
  });

  it("WorldEvent.nodeId / transportLegSequence：事件定位到稳定节点与 Leg（HIGH）", async () => {
    const seed = findSeed0(HC.COURIER_MISSING[0], HC.COURIER_MISSING[1], "ev-node");
    const { letterId } = await createDispatchedLetter("bob6", "HAND_CARRY", "ev-node");
    await setSeed(letterId, seed);
    const journey = await journeyOf(letterId);
    const leg0 = await prisma.transportLeg.findFirstOrThrow({
      where: { journeyId: journey.id, sequence: 0 },
    });
    const legEnd = T0 + leg0.plannedDurationSeconds * 1000;
    const clock = new TestSimulationClock(T0);
    await advanceTo(letterId, clock, legEnd);

    const events = await worldEventsOf(journey.id);
    const ev = events.find((e) => e.eventType === "COURIER_MISSING");
    expect(ev).toBeDefined();
    // 事件发生在 leg0 完成（到达站）
    expect(ev?.nodeId).toBe(leg0.toNodeId);
    expect(ev?.transportLegSequence).toBe(0);
  });

  it("reroute 后 totalDistanceKm === sum(有效 legs)（HIGH）", async () => {
    const seed = findSeed0(HC.REROUTE[0], HC.REROUTE[1], "ev-dist");
    const { letterId } = await createDispatchedLetter("bob6", "HAND_CARRY", "ev-dist");
    await setSeed(letterId, seed);
    const journey = await journeyOf(letterId);
    const leg0 = await prisma.transportLeg.findFirstOrThrow({
      where: { journeyId: journey.id, sequence: 0 },
    });
    // reroute 前：totalDistanceKm === sum(legs)
    let legs = await prisma.transportLeg.findMany({ where: { journeyId: journey.id } });
    const before = legs.reduce((a, l) => a + l.distanceKm, 0);
    expect(Math.abs(journey.totalDistanceKm - before)).toBeLessThan(0.5);

    const clock = new TestSimulationClock(T0);
    await advanceTo(letterId, clock, T0 + leg0.plannedDurationSeconds * 1000 + DAY_MS);
    const j = await journeyOf(letterId);
    legs = await prisma.transportLeg.findMany({ where: { journeyId: journey.id } });
    const after = legs.reduce((a, l) => a + l.distanceKm, 0);
    expect(Math.abs(j.totalDistanceKm - after)).toBeLessThan(0.5);
  });

  it("transport change 重建：HAND_CARRY → PIGEON 变成单段 direct leg（HIGH）", async () => {
    // drop + WITHIN_24H + transport ∈ [0.6,0.85)（PIGEON，HAND_CARRY 变更表 25%）
    let chosen = "";
    for (let i = 0; i < 1000000; i += 1) {
      const s = `ev-tc-pigeon-${i}`;
      const d0 = deterministicDraw(s, 0);
      const d1 = deterministicDraw(s, 1);
      const d4 = deterministicDraw(s, 4);
      if (
        d0 >= HC.LETTER_DROPPED[0] &&
        d0 < HC.LETTER_DROPPED[1] &&
        d1 >= DROP_WINDOW.WITHIN_24H[0] &&
        d1 < DROP_WINDOW.WITHIN_24H[1] &&
        d4 >= 0.6 &&
        d4 < 0.85
      ) {
        chosen = s;
        break;
      }
    }
    expect(chosen).not.toBe("");
    const { letterId } = await createDispatchedLetter("bob6", "HAND_CARRY", "ev-tc-pigeon");
    await setSeed(letterId, chosen);
    const journey = await journeyOf(letterId);
    const leg0 = await prisma.transportLeg.findFirstOrThrow({
      where: { journeyId: journey.id, sequence: 0 },
    });
    const legEnd = T0 + leg0.plannedDurationSeconds * 1000;

    const clock = new TestSimulationClock(T0);
    await advanceTo(letterId, clock, legEnd); // drop 发生
    const dropped = await journeyOf(letterId);
    const resolvedMs = dropped.anomalyResolvedAtSim?.getTime() ?? legEnd;
    clock.advanceTo(resolvedMs);
    await advanceJourneyToNow(prisma, letterId, clock);

    const letter = await prisma.letter.findUniqueOrThrow({ where: { id: letterId } });
    expect(letter.currentTransport).toBe("PIGEON");
    // 剩余 remaining 重建为单段 direct PIGEON leg
    const remaining = await prisma.transportLeg.findMany({
      where: { journeyId: journey.id, sequence: { gte: 1 } },
    });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.transportType).toBe("PIGEON");
    expect(remaining[0]?.fromNodeId).toBe(leg0.toNodeId);
    expect(remaining[0]?.toNodeId).toBe(journey.destinationNodeId);
  });

  it("transport change 重建：PIGEON → HORSE_RELAY 重新 Dijkstra 生成 ground legs（HIGH）", async () => {
    // PIGEON 掉落后恢复 transport ∈ [0,0.7)（HORSE_RELAY）
    let chosen = "";
    for (let i = 0; i < 1000000; i += 1) {
      const s = `ev-tc-ground-${i}`;
      const d0 = deterministicDraw(s, 0);
      const d1 = deterministicDraw(s, 1);
      const d4 = deterministicDraw(s, 4);
      if (
        d0 >= PG.LETTER_DROPPED[0] &&
        d0 < PG.LETTER_DROPPED[1] &&
        d1 >= DROP_WINDOW.WITHIN_24H[0] &&
        d1 < DROP_WINDOW.WITHIN_24H[1] &&
        d4 >= 0 &&
        d4 < 0.7
      ) {
        chosen = s;
        break;
      }
    }
    expect(chosen).not.toBe("");
    const { letterId } = await createDispatchedLetter("bob6", "PIGEON", "ev-tc-ground");
    await setSeed(letterId, chosen);
    const journey = await journeyOf(letterId);
    const leg0 = await prisma.transportLeg.findFirstOrThrow({
      where: { journeyId: journey.id, sequence: 0 },
    });
    const legEnd = T0 + leg0.plannedDurationSeconds * 1000;

    const clock = new TestSimulationClock(T0);
    await advanceTo(letterId, clock, legEnd); // drop
    const dropped = await journeyOf(letterId);
    const resolvedMs = dropped.anomalyResolvedAtSim?.getTime() ?? legEnd;
    clock.advanceTo(resolvedMs);
    await advanceJourneyToNow(prisma, letterId, clock);

    const letter = await prisma.letter.findUniqueOrThrow({ where: { id: letterId } });
    expect(letter.currentTransport).toBe("HORSE_RELAY");
    // PIGEON 单 leg 直达终点：drop 发生时已到达目标站，无 remaining 可重建；
    // 恢复后按新 transport 语义直接进入 last-mile（不产生非法 ground 路线）
    const remaining = await prisma.transportLeg.findMany({
      where: { journeyId: journey.id, sequence: { gte: 1 } },
    });
    expect(remaining).toHaveLength(0);
    const events = await worldEventsOf(journey.id);
    expect(events.some((e) => e.eventType === "TRANSPORT_CHANGED")).toBe(true);
    // 恢复后继续 last-mile → DELIVERED
    clock.advanceTo((resolvedMs ?? legEnd) + LAST_MILE_DURATION_SECONDS * 1000 + HOUR_MS);
    const done = await advanceJourneyToNow(prisma, letterId, clock);
    expect(done.letterStatus).toBe("DELIVERED");
    void leg0;
  });

  it("replay：同一 seed 两次独立运行产生完全相同的 WorldEvent 序列", async () => {
    const seed = findSeed0(HC.ROBBERY[0], HC.ROBBERY[1], "ev-replay");
    const a = await createDispatchedLetter("bob6", "HAND_CARRY", "ev-replay-a");
    const b = await createDispatchedLetter("bob6", "HAND_CARRY", "ev-replay-b");
    await setSeed(a.letterId, seed);
    await setSeed(b.letterId, seed);
    const journeyA = await journeyOf(a.letterId);
    const firstLegEnd =
      T0 +
      ((
        await prisma.transportLeg.findFirstOrThrow({
          where: { journeyId: journeyA.id, sequence: 0 },
        })
      ).plannedDurationSeconds ?? 0) *
        1000;

    const clockA = new TestSimulationClock(T0);
    const clockB = new TestSimulationClock(T0);
    // 推进越过理论完成点 + 2 模拟日（覆盖 DELAY_MAX 12h），确保 leg 完成触发事件
    await advanceTo(a.letterId, clockA, firstLegEnd + DAY_MS * 2);
    await advanceTo(b.letterId, clockB, firstLegEnd + DAY_MS * 2);

    const eventsA = await worldEventsOf(journeyA.id);
    const journeyB = await journeyOf(b.letterId);
    const eventsB = await worldEventsOf(journeyB.id);
    expect(eventsA.length).toBeGreaterThan(0);
    expect(
      eventsA.map((e) => [e.eventIndex, e.eventType, e.occurredAtSim.getTime(), e.payload])
    ).toEqual(
      eventsB.map((e) => [e.eventIndex, e.eventType, e.occurredAtSim.getTime(), e.payload])
    );
  });

  it("eventIndex 单调递增；(journeyId,eventIndex) 唯一", async () => {
    // 推进多步触发多个事件：DELAY（完成前消耗）、再推进完成
    const seed = findSeed0(HC.DELAY[0], HC.DELAY[1], "ev-index");
    const { letterId } = await createDispatchedLetter("bob6", "HAND_CARRY", "ev-index");
    await setSeed(letterId, seed);
    const journey = await journeyOf(letterId);
    const firstLegEnd =
      T0 +
      ((
        await prisma.transportLeg.findFirstOrThrow({
          where: { journeyId: journey.id, sequence: 0 },
        })
      ).plannedDurationSeconds ?? 0) *
        1000;

    const clock = new TestSimulationClock(T0);
    await advanceTo(letterId, clock, firstLegEnd + DAY_MS * 3); // 越过 delay 后完成

    const events = await worldEventsOf(journey.id);
    expect(events.length).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < events.length; i += 1) {
      expect(events[i]?.eventIndex).toBeGreaterThan((events[i - 1]?.eventIndex ?? -1) + 0);
      expect(events[i]?.eventIndex).not.toBe(events[i - 1]?.eventIndex);
    }
    const unique = new Set(events.map((e) => e.eventIndex));
    expect(unique.size).toBe(events.length);
  });

  it("delay：Leg 完成时刻延后 + WorldEvent DELAYED，随后完成", async () => {
    const seed = findSeed0(HC.DELAY[0], HC.DELAY[1], "ev-delay");
    const { letterId } = await createDispatchedLetter("bob6", "HAND_CARRY", "ev-delay");
    await setSeed(letterId, seed);
    const journey = await journeyOf(letterId);
    const leg0 = await prisma.transportLeg.findFirstOrThrow({
      where: { journeyId: journey.id, sequence: 0 },
    });
    const legEndMs = T0 + leg0.plannedDurationSeconds * 1000;

    const clock = new TestSimulationClock(T0);
    const first = await advanceTo(letterId, clock, legEndMs);
    // 延误已冻结：理论完成时刻已到但 leg 未完成（ACTIVE），delaySeconds 已持久化（不重复判定）
    const legAfter = await prisma.transportLeg.findFirstOrThrow({
      where: { journeyId: journey.id, sequence: 0 },
    });
    expect(legAfter.status).toBe("ACTIVE");
    expect(legAfter.primaryEventIndex).not.toBeNull();
    expect(legAfter.delaySeconds).toBeGreaterThan(0);
    // 未完成前无 DELAYED 事件（事件在完成点记录）；primary event 只判定一次
    expect(legAfter.primaryEventOutcome).toBe("DELAYED");
    let events = await worldEventsOf(journey.id);
    expect(events.some((e) => e.eventType === "DELAYED")).toBe(false);

    // 继续推进 → 完成，DELAYED 事件在完成点记录
    clock.advanceTo(legEndMs + DAY_MS * 2);
    const second = await advanceJourneyToNow(prisma, letterId, clock);
    expect(second.changed).toBe(true);
    const legDone = await prisma.transportLeg.findFirstOrThrow({
      where: { journeyId: journey.id, sequence: 0 },
    });
    expect(legDone.status).toBe("COMPLETED");
    // effective 完成时刻 = start + planned + delay（DELAY 真正延长完成时间）
    const legStartMs = legDone.startedAtSim?.getTime() ?? T0;
    expect(legDone.completedAtSim?.getTime()).toBe(
      legStartMs + (legDone.plannedDurationSeconds + legDone.delaySeconds) * 1000
    );
    events = await worldEventsOf(journey.id);
    const delayed = events.find((e) => e.eventType === "DELAYED");
    expect(delayed).toBeDefined();
    expect((delayed?.payload as { delaySeconds?: number } | null)?.delaySeconds ?? 0).toBe(
      legDone.delaySeconds
    );
    // 事件时间不倒序：DELAYED.occurredAt === leg.completedAt
    expect(delayed?.occurredAtSim.getTime()).toBe(legDone.completedAtSim?.getTime());
    void first;
  });

  it("reroute：completedPath 不变，remaining 重建（排除原计划下一条边）", async () => {
    const seed = findSeed0(HC.REROUTE[0], HC.REROUTE[1], "ev-reroute");
    const { trackingNo, letterId } = await createDispatchedLetter(
      "bob6",
      "HAND_CARRY",
      "ev-reroute"
    );
    await setSeed(letterId, seed);
    const journey = await journeyOf(letterId);
    const leg0 = await prisma.transportLeg.findFirstOrThrow({
      where: { journeyId: journey.id, sequence: 0 },
    });
    const leg1 = await prisma.transportLeg.findFirstOrThrow({
      where: { journeyId: journey.id, sequence: 1 },
    });
    const legEndMs = T0 + leg0.plannedDurationSeconds * 1000;

    const clock = new TestSimulationClock(T0);
    await advanceTo(letterId, clock, legEndMs);

    const events = await worldEventsOf(journey.id);
    const rerouted = events.find((e) => e.eventType === "REROUTED");
    expect(rerouted).toBeDefined();
    const payload = rerouted?.payload as { excludedEdge?: { from: string; to: string } } | null;
    // 被排除的边 = 原计划下一条（leg0.to → leg1.to）
    expect(payload?.excludedEdge).toEqual({ from: leg0.toNodeId, to: leg1.toNodeId });

    // completedPath 不变（leg0 仍 COMPLETED）；remaining 从 leg0.to 重新开始
    const legsAfter = await prisma.transportLeg.findMany({
      where: { journeyId: journey.id },
      orderBy: { sequence: "asc" },
    });
    expect(legsAfter[0]?.status).toBe("COMPLETED");
    expect(legsAfter[0]?.toNodeId).toBe(leg0.toNodeId);
    // 原计划 leg1（含被排除边）已被替换
    const replaced = legsAfter.find(
      (l) => l.sequence === 1 && l.fromNodeId === leg0.toNodeId && l.toNodeId === leg1.toNodeId
    );
    expect(replaced).toBeUndefined();
    // remaining 第一条 from = 当前节点
    const firstRemaining = legsAfter.find((l) => l.sequence === 1);
    expect(firstRemaining?.fromNodeId).toBe(leg0.toNodeId);
    // completedPath（GET）不因 reroute 改变：leg0 完成节点序列前段一致
    const detail = await getLetterDetail(trackingNo, bob.accessToken);
    const journeySummary = detail.json().letter.journey;
    expect(journeySummary.legs[0]?.status).toBe("COMPLETED");
  });

  it("robbery 分支：ESCAPE → 延误；DEAD_DROPPED → LETTER_DROPPED 异常", async () => {
    // ESCAPE_DELAY：draw0 ∈ ROBBERY, draw1 ∈ ESCAPE
    const escapeSeed = findSeed01(HC.ROBBERY, ROBBERY_BRANCH.ESCAPE_DELAY, "ev-rob-esc");
    const { letterId: eid } = await createDispatchedLetter("bob6", "HAND_CARRY", "ev-rob-esc");
    await setSeed(eid, escapeSeed);
    const eJourney = await journeyOf(eid);
    const eLegEnd =
      T0 +
      ((
        await prisma.transportLeg.findFirstOrThrow({
          where: { journeyId: eJourney.id, sequence: 0 },
        })
      ).plannedDurationSeconds ?? 0) *
        1000;
    const eClock = new TestSimulationClock(T0);
    // ESCAPE 有延误（DELAY_MAX 12h）：推进越过完成点 + 2 日确保完成
    await advanceTo(eid, eClock, eLegEnd + DAY_MS * 2);
    const eEvents = await worldEventsOf(eJourney.id);
    const eRob = eEvents.find((e) => e.eventType === "ROBBERY");
    expect((eRob?.payload as { branch?: string } | null)?.branch).toBe("ESCAPE_DELAY");
    // 逃脱：未进入异常，仍 IN_TRANSIT
    const eLetter = await prisma.letter.findUniqueOrThrow({ where: { id: eid } });
    expect(eLetter.status).toBe("IN_TRANSIT");

    // DEAD_DROPPED：draw0 ∈ ROBBERY, draw1 ∈ DEAD_DROPPED
    const deadSeed = findSeed01(HC.ROBBERY, ROBBERY_BRANCH.DEAD_DROPPED, "ev-rob-dead");
    const { letterId: did } = await createDispatchedLetter("bob6", "HAND_CARRY", "ev-rob-dead");
    await setSeed(did, deadSeed);
    const dJourney = await journeyOf(did);
    const dLegEnd =
      T0 +
      ((
        await prisma.transportLeg.findFirstOrThrow({
          where: { journeyId: dJourney.id, sequence: 0 },
        })
      ).plannedDurationSeconds ?? 0) *
        1000;
    const dClock = new TestSimulationClock(T0);
    await advanceTo(did, dClock, dLegEnd);
    const dEvents = await worldEventsOf(dJourney.id);
    const dRob = dEvents.find((e) => e.eventType === "ROBBERY");
    expect((dRob?.payload as { branch?: string } | null)?.branch).toBe("DEAD_DROPPED");
    // 信使死亡 + 掉落 → LETTER_DROPPED 异常
    const dLetter = await prisma.letter.findUniqueOrThrow({ where: { id: did } });
    expect(dLetter.status).toBe("LETTER_DROPPED");
    const dJourneyAfter = await journeyOf(did);
    expect(dJourneyAfter.anomalyType).toBe("LETTER_DROPPED");
    expect(dJourneyAfter.anomalyResolvedAtSim).not.toBeNull();
  });

  it("courier missing：COURIER_MISSING 异常 + recoveryWindow", async () => {
    const seed = findSeed0(HC.COURIER_MISSING[0], HC.COURIER_MISSING[1], "ev-missing");
    const { letterId } = await createDispatchedLetter("bob6", "HAND_CARRY", "ev-missing");
    await setSeed(letterId, seed);
    const journey = await journeyOf(letterId);
    const legEnd =
      T0 +
      ((
        await prisma.transportLeg.findFirstOrThrow({
          where: { journeyId: journey.id, sequence: 0 },
        })
      ).plannedDurationSeconds ?? 0) *
        1000;

    const clock = new TestSimulationClock(T0);
    await advanceTo(letterId, clock, legEnd);
    const letter = await prisma.letter.findUniqueOrThrow({ where: { id: letterId } });
    expect(letter.status).toBe("COURIER_MISSING");
    const j = await journeyOf(letterId);
    expect(j.anomalyType).toBe("COURIER_MISSING");
    const events = await worldEventsOf(journey.id);
    const ev = events.find((e) => e.eventType === "COURIER_MISSING");
    expect(ev).toBeDefined();
    expect((ev?.payload as { recoveryWindow?: string } | null)?.recoveryWindow).toBeDefined();
  });

  it("recovery：掉落后恢复 → RECOVERED + 继续运输 → DELIVERED", async () => {
    // drop + WITHIN_24H 恢复窗口
    const seed = findSeed01(HC.LETTER_DROPPED, DROP_WINDOW.WITHIN_24H, "ev-recover");
    const { letterId } = await createDispatchedLetter("bob6", "HAND_CARRY", "ev-recover");
    await setSeed(letterId, seed);
    const journey = await journeyOf(letterId);
    const leg0 = await prisma.transportLeg.findFirstOrThrow({
      where: { journeyId: journey.id, sequence: 0 },
    });
    const legEnd = T0 + leg0.plannedDurationSeconds * 1000;

    const clock = new TestSimulationClock(T0);
    await advanceTo(letterId, clock, legEnd);
    const dropped = await journeyOf(letterId);
    expect(dropped.anomalyType).toBe("LETTER_DROPPED");
    const resolvedMs = dropped.anomalyResolvedAtSim?.getTime();
    expect(resolvedMs).toBeDefined();
    expect(resolvedMs ?? 0).toBeGreaterThan(legEnd);

    // 推进到恢复点 → 恢复
    clock.advanceTo(resolvedMs ?? legEnd);
    const rec = await advanceJourneyToNow(prisma, letterId, clock);
    expect(rec.changed).toBe(true);
    const recoveredJourney = await journeyOf(letterId);
    expect(recoveredJourney.anomalyType).toBeNull();
    const events = await worldEventsOf(journey.id);
    expect(events.some((e) => e.eventType === "RECOVERED")).toBe(true);

    // 继续推进足够时间 → DELIVERED
    clock.advanceTo((resolvedMs ?? legEnd) + DAY_MS * 60);
    const done = await advanceJourneyToNow(prisma, letterId, clock);
    expect(done.letterStatus).toBe("DELIVERED");
  });

  it("recovery transport change：恢复后自动变更运输方式（HAND_CARRY → HORSE_RELAY）", async () => {
    // draw 顺序：0=primary(drop) 1=window 2=range；恢复时 3=handling 4=transport。
    // 要求 drop + WITHIN_24H + transport ∈ [0,0.6)（HORSE_RELAY）。
    let chosen = "";
    for (let i = 0; i < 1000000; i += 1) {
      const s = `ev-rtc-${i}`;
      const d0 = deterministicDraw(s, 0);
      const d1 = deterministicDraw(s, 1);
      const d4 = deterministicDraw(s, 4);
      if (
        d0 >= HC.LETTER_DROPPED[0] &&
        d0 < HC.LETTER_DROPPED[1] &&
        d1 >= DROP_WINDOW.WITHIN_24H[0] &&
        d1 < DROP_WINDOW.WITHIN_24H[1] &&
        d4 < 0.6
      ) {
        chosen = s;
        break;
      }
    }
    expect(chosen).not.toBe("");
    const { letterId } = await createDispatchedLetter("bob6", "HAND_CARRY", "ev-rtc");
    await setSeed(letterId, chosen);
    const journey = await journeyOf(letterId);
    const leg0 = await prisma.transportLeg.findFirstOrThrow({
      where: { journeyId: journey.id, sequence: 0 },
    });
    const legEnd = T0 + leg0.plannedDurationSeconds * 1000;

    const clock = new TestSimulationClock(T0);
    await advanceTo(letterId, clock, legEnd);
    const dropped = await journeyOf(letterId);
    const resolvedMs = dropped.anomalyResolvedAtSim?.getTime() ?? legEnd;
    clock.advanceTo(resolvedMs);
    await advanceJourneyToNow(prisma, letterId, clock);

    const letter = await prisma.letter.findUniqueOrThrow({ where: { id: letterId } });
    expect(letter.currentTransport).toBe("HORSE_RELAY");
    const events = await worldEventsOf(journey.id);
    const changed = events.find((e) => e.eventType === "TRANSPORT_CHANGED");
    expect(changed).toBeDefined();
    expect((changed?.payload as { from?: string; to?: string } | null)?.to).toBe("HORSE_RELAY");
    // 剩余 legs 切换为新运输方式
    const remainingLegs = await prisma.transportLeg.findMany({
      where: { journeyId: journey.id, sequence: { gte: 1 } },
    });
    expect(remainingLegs.length).toBeGreaterThan(0);
    for (const l of remainingLegs) expect(l.transportType).toBe("HORSE_RELAY");
  });

  it("permanent loss：7 模拟日未恢复 → PERMANENTLY_LOST，terminal no-op，正文锁定", async () => {
    const seed = findSeed01(HC.LETTER_DROPPED, DROP_WINDOW.NEVER, "ev-loss");
    const { trackingNo, letterId } = await createDispatchedLetter("bob6", "HAND_CARRY", "ev-loss");
    await setSeed(letterId, seed);
    const journey = await journeyOf(letterId);
    const leg0 = await prisma.transportLeg.findFirstOrThrow({
      where: { journeyId: journey.id, sequence: 0 },
    });
    const legEnd = T0 + leg0.plannedDurationSeconds * 1000;

    const clock = new TestSimulationClock(T0);
    await advanceTo(letterId, clock, legEnd);
    const dropped = await journeyOf(letterId);
    expect(dropped.anomalyType).toBe("LETTER_DROPPED");
    expect(dropped.anomalyResolvedAtSim).toBeNull(); // NEVER 窗口

    // 推进超过 7 模拟日
    const startedMs = dropped.anomalyStartedAtSim?.getTime() ?? legEnd;
    clock.advanceTo(startedMs + PERMANENT_LOSS_SECONDS * 1000 + HOUR_MS);
    const lost = await advanceJourneyToNow(prisma, letterId, clock);
    expect(lost.changed).toBe(true);
    expect(lost.letterStatus).toBe("PERMANENTLY_LOST");
    const letter = await prisma.letter.findUniqueOrThrow({ where: { id: letterId } });
    expect(letter.status).toBe("PERMANENTLY_LOST");
    const events = await worldEventsOf(journey.id);
    expect(events.some((e) => e.eventType === "PERMANENTLY_LOST")).toBe(true);

    // terminal no-op：再推进 deliveredAt 不变
    clock.advanceTo(startedMs + PERMANENT_LOSS_SECONDS * 1000 + DAY_MS * 5);
    const again = await advanceJourneyToNow(prisma, letterId, clock);
    expect(again.changed).toBe(false);
    // Recipient 正文仍锁定（PERMANENTLY_LOST ≠ DELIVERED）
    const recipientView = await getLetterDetail(trackingNo, bob.accessToken);
    expect(recipientView.json().letter.content).toBeNull();
  });

  it("destroyed：PIGEON 严重事故 → DESTROYED terminal", async () => {
    const seed = findSeed0(PG.SERIOUS_ACCIDENT[0], PG.SERIOUS_ACCIDENT[1], "ev-destroyed");
    const { trackingNo, letterId } = await createDispatchedLetter("bob6", "PIGEON", "ev-destroyed");
    await setSeed(letterId, seed);
    const journey = await journeyOf(letterId);
    const leg0 = await prisma.transportLeg.findFirstOrThrow({
      where: { journeyId: journey.id, sequence: 0 },
    });
    const legEnd = T0 + leg0.plannedDurationSeconds * 1000;

    const clock = new TestSimulationClock(T0);
    const res = await advanceTo(letterId, clock, legEnd);
    expect(res.letterStatus).toBe("DESTROYED");
    const letter = await prisma.letter.findUniqueOrThrow({ where: { id: letterId } });
    expect(letter.status).toBe("DESTROYED");
    const events = await worldEventsOf(journey.id);
    expect(events.some((e) => e.eventType === "SERIOUS_ACCIDENT")).toBe(true);

    // terminal no-op
    clock.advanceTo(legEnd + DAY_MS * 3);
    const again = await advanceJourneyToNow(prisma, letterId, clock);
    expect(again.changed).toBe(false);
    // 正文锁定（DESTROYED ≠ DELIVERED）
    const recipientView = await getLetterDetail(trackingNo, bob.accessToken);
    expect(recipientView.json().letter.content).toBeNull();
  });

  it("并发 advance：恰一套 WorldEvent，无重复事件 / 状态覆盖 / 500", async () => {
    const seed = findSeed0(HC.ROBBERY[0], HC.ROBBERY[1], "ev-concurrent");
    const { letterId } = await createDispatchedLetter("bob6", "HAND_CARRY", "ev-concurrent");
    await setSeed(letterId, seed);
    const journey = await journeyOf(letterId);
    const leg0 = await prisma.transportLeg.findFirstOrThrow({
      where: { journeyId: journey.id, sequence: 0 },
    });
    const legEnd = T0 + leg0.plannedDurationSeconds * 1000;

    const clock = new TestSimulationClock(T0);
    await advanceJourneyToNow(prisma, letterId, clock); // 激活
    // 越过完成点 + 2 日（ROBBERY 若 ESCAPE/INJURED 有延误；确保完成触发事件）
    clock.advanceTo(legEnd + DAY_MS * 2);

    const results = await Promise.all([
      advanceJourneyToNow(prisma, letterId, clock),
      advanceJourneyToNow(prisma, letterId, clock),
    ]);
    expect(results.filter((r) => r.changed)).toHaveLength(1);

    const events = await worldEventsOf(journey.id);
    // 事件判定在完成 leg0 时一次 → 恰 1 个 ROBBERY（无重复）
    expect(events.filter((e) => e.eventType === "ROBBERY")).toHaveLength(1);
    const unique = new Set(events.map((e) => e.eventIndex));
    expect(unique.size).toBe(events.length);
    // 无两个 ACTIVE / 无重复完成
    const legs = await prisma.transportLeg.findMany({ where: { journeyId: journey.id } });
    expect(legs.filter((l) => l.status === "ACTIVE").length).toBeLessThanOrEqual(1);
  });

  it("rollback：unknown Journey.rulesVersion 时无部分状态、无半个 WorldEvent", async () => {
    const { letterId } = await createDispatchedLetter("bob6", "HAND_CARRY", "ev-rollback");
    const journey = await journeyOf(letterId);
    await prisma.journey.update({ where: { letterId }, data: { rulesVersion: "999.0" } });
    const before = await worldEventsOf(journey.id);
    expect(before).toHaveLength(0);
    const clock = new TestSimulationClock(T0 + DAY_MS);
    await expect(advanceJourneyToNow(prisma, letterId, clock)).rejects.toThrow(
      UnknownRulesVersionError
    );
    const after = await worldEventsOf(journey.id);
    expect(after).toHaveLength(0); // 无半个事件历史
    const j = await journeyOf(letterId);
    expect(j.nextEventIndex).toBe(0);
    expect(j.anomalyType).toBeNull();
  });

  it("no leak：API 不暴露 WorldEvent / payload / eventIndex / recoveryWindow / seed / anomaly", async () => {
    const seed = findSeed0(HC.LETTER_DROPPED[0], HC.LETTER_DROPPED[1], "ev-noleak");
    const { trackingNo, letterId } = await createDispatchedLetter(
      "bob6",
      "HAND_CARRY",
      "ev-noleak"
    );
    await setSeed(letterId, seed);
    const journey = await journeyOf(letterId);
    const leg0 = await prisma.transportLeg.findFirstOrThrow({
      where: { journeyId: journey.id, sequence: 0 },
    });
    const legEnd = T0 + leg0.plannedDurationSeconds * 1000;
    const clock = new TestSimulationClock(T0);
    await advanceTo(letterId, clock, legEnd); // 触发 LETTER_DROPPED
    const events = await worldEventsOf(journey.id);
    expect(events.length).toBeGreaterThan(0);

    const detail = await getLetterDetail(trackingNo, bob.accessToken);
    const serialized = JSON.stringify(detail.json());
    expect(serialized).not.toMatch(/worldEvent/i);
    expect(serialized).not.toMatch(/eventIndex/);
    expect(serialized).not.toMatch(/recoveryWindow/);
    expect(serialized).not.toMatch(/anomaly/i);
    expect(serialized).not.toMatch(/simulationSeed/);
    expect(serialized).not.toMatch(/payload/);
    expect(serialized).not.toMatch(/"id":/); // internal id
  });

  it("NORMAL seed：纯正常推进无任何 WorldEvent（Phase 5 行为保持）", async () => {
    const { letterId } = await createDispatchedLetter("bob6", "HAND_CARRY", "ev-normal");
    // 找 NORMAL seed（draw0..39 全 < 0.84）
    let seed = "";
    for (let i = 0; i < 200000; i += 1) {
      const s = `ev-normal-${i}`;
      let ok = true;
      for (let k = 0; k < 40; k += 1) {
        if (deterministicDraw(s, k) >= 0.84) {
          ok = false;
          break;
        }
      }
      if (ok) {
        seed = s;
        break;
      }
    }
    expect(seed).not.toBe("");
    await setSeed(letterId, seed);
    const journey = await journeyOf(letterId);
    const clock = new TestSimulationClock(T0);
    await advanceTo(letterId, clock, T0 + DAY_MS * 60);
    const events = await worldEventsOf(journey.id);
    expect(events).toHaveLength(0);
    const letter = await prisma.letter.findUniqueOrThrow({ where: { id: letterId } });
    expect(letter.status).toBe("DELIVERED");
  });
});
