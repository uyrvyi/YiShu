import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, requireTestDatabaseUrl } from "@yishu/config";
import { createPrismaClient, type PrismaClient } from "@yishu/db";
import { deterministicDraw, TestSimulationClock } from "@yishu/simulation";
import {
  LAST_MILE_DURATION_SECONDS,
  UnknownRulesVersionError,
  type TransportType,
} from "@yishu/shared";
import { buildApp } from "../app.js";
import type { FastifyInstance } from "fastify";
import { resetStationGraphCache } from "../lib/stationGraph.js";
import {
  advanceJourneyToNow,
  JourneyNotFoundError,
  LetterNotFoundError,
} from "../lib/journey-advance.js";

/** 一级事件 NORMAL 区间上界（Phase 6 概率表；用于构造纯正常推进的确定性 seed）。 */
const NORMAL_THRESHOLDS: Record<TransportType, number> = {
  HAND_CARRY: 0.84,
  HORSE_RELAY: 0.94,
  EXPRESS_RELAY: 0.96,
  PIGEON: 0.92,
};

/** 搜索一个 seed：其前 draws 个事件判定全部为 NORMAL（确定性，Phase 6 事件不干扰 Phase 5 断言）。 */
function findNormalSeed(transportType: TransportType, tag: string, draws = 40): string {
  const threshold = NORMAL_THRESHOLDS[transportType];
  for (let i = 0; i < 20000; i += 1) {
    const seed = `${tag}-${i}`;
    let ok = true;
    for (let k = 0; k < draws; k += 1) {
      if (deterministicDraw(seed, k) >= threshold) {
        ok = false;
        break;
      }
    }
    if (ok) return seed;
  }
  throw new Error(`no normal seed found for ${transportType}`);
}

/**
 * Phase 5 Simulation Core + Transport Progression 集成测试。
 * 仅 *_test 库。测试通过 TestSimulationClock advanceBy/advanceTo 推时间，不允许真实 sleep。
 * 推进型测试固定 NORMAL seed（Phase 6 随机事件不参与，保持 Phase 5 纯确定性断言）。
 */
describe("journey advance integration", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let alice: { account: string; uid: string; accessToken: string };
  let bob: { account: string; uid: string; accessToken: string };

  /** 测试模拟纪元 T0（固定，确定性）。 */
  const T0 = new Date("2026-09-01T00:00:00Z").getTime();
  const HOUR_MS = 3600 * 1000;

  async function registerUser(payload: Record<string, string>) {
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload });
    const body = res.json();
    return { account: body.user.account, uid: body.user.uid, accessToken: body.accessToken };
  }

  function createLetter(
    recipient: string,
    content: string,
    transportType = "HORSE_RELAY",
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

  function getJourney(trackingNo: string, token: string) {
    return app.inject({
      method: "GET",
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

  // Letter 对外视图不暴露 internal id（安全设计），测试通过 trackingNo 反查 id。
  async function letterIdOf(trackingNo: string): Promise<bigint> {
    const l = await prisma.letter.findUniqueOrThrow({ where: { trackingNo } });
    return l.id;
  }

  /** 建信 + 初始化 Journey，返回 trackingNo 与 letterId。 */
  async function createDispatchedLetter(
    recipient: string,
    transportType = "HORSE_RELAY",
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

  /** 固定 NORMAL seed：Phase 6 随机事件不参与，保持 Phase 5 纯推进断言确定。 */
  async function setNormalSeed(
    letterId: bigint,
    transportType: TransportType,
    tag: string
  ): Promise<void> {
    await prisma.journey.update({
      where: { letterId },
      data: { simulationSeed: findNormalSeed(transportType, tag) },
    });
  }

  beforeAll(async () => {
    resetStationGraphCache();
    const testDbUrl = requireTestDatabaseUrl(process.env);
    const config = loadConfig({ NODE_ENV: "test" });
    prisma = createPrismaClient(testDbUrl);
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
      account: "alice5",
      password: "alice5-pass",
      nickname: "A5",
      province: "上海市",
      city: "上海市",
      district: "徐汇区",
    });
    bob = await registerUser({
      account: "bob5",
      password: "bob5-pass",
      nickname: "B5",
      province: "北京市",
      city: "北京市",
      district: "海淀区",
    });
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it("单 Leg 激活：ACTIVE + IN_TRANSIT + startedAtSim 正确", async () => {
    const { letterId } = await createDispatchedLetter("bob5", "HORSE_RELAY", "adv-activate");
    const clock = new TestSimulationClock(T0);
    const result = await advanceJourneyToNow(prisma, letterId, clock);
    expect(result.changed).toBe(true);
    expect(result.letterStatus).toBe("IN_TRANSIT");
    expect(result.journeyStatus).toBe("IN_PROGRESS");
    expect(result.currentLegSequence).toBe(0);

    const journey = await prisma.journey.findUniqueOrThrow({ where: { letterId } });
    expect(journey.startedAtSim?.getTime()).toBe(T0);
    expect(journey.lastAdvancedAtSim?.getTime()).toBe(T0);
    expect(journey.currentLegSequence).toBe(0);
    const legs = await prisma.transportLeg.findMany({
      where: { journeyId: journey.id },
      orderBy: { sequence: "asc" },
    });
    expect(legs[0]?.status).toBe("ACTIVE");
    expect(legs[0]?.startedAtSim?.getTime()).toBe(T0);
    expect(legs[0]?.completedAtSim).toBeNull();
    const letter = await prisma.letter.findUniqueOrThrow({ where: { id: letterId } });
    expect(letter.status).toBe("IN_TRANSIT");
  });

  it("所有 Leg 完成 → OUT_FOR_DELIVERY（到达目标站，理论完成时间正确）", async () => {
    const { letterId } = await createDispatchedLetter("bob5", "HORSE_RELAY", "adv-complete");
    await setNormalSeed(letterId, "HORSE_RELAY", "adv-complete");
    const clock = new TestSimulationClock(T0);
    await advanceJourneyToNow(prisma, letterId, clock); // 激活

    const journey = await prisma.journey.findUniqueOrThrow({ where: { letterId } });
    const legs = await prisma.transportLeg.findMany({
      where: { journeyId: journey.id },
      orderBy: { sequence: "asc" },
    });
    const firstLeg = legs[0];
    const firstLegEndMs = T0 + (firstLeg?.plannedDurationSeconds ?? 0) * 1000;
    const totalMs = legs.reduce((acc, l) => acc + l.plannedDurationSeconds * 1000, 0);
    clock.advanceTo(T0 + totalMs); // 一次性推进完成全部 Leg
    const result = await advanceJourneyToNow(prisma, letterId, clock);
    expect(result.letterStatus).toBe("OUT_FOR_DELIVERY");
    expect(result.journeyStatus).toBe("COMPLETED");
    expect(result.currentLegSequence).toBeNull();

    const updatedLegs = await prisma.transportLeg.findMany({
      where: { journeyId: journey.id },
      orderBy: { sequence: "asc" },
    });
    // 首个 Leg 完成于其理论时刻（非 now）
    expect(updatedLegs[0]?.status).toBe("COMPLETED");
    expect(updatedLegs[0]?.completedAtSim?.getTime()).toBe(firstLegEndMs);
    // 最后一个 Leg 完成于总时长累计时刻
    const lastLeg = updatedLegs[updatedLegs.length - 1];
    const lastLegEndMs =
      (lastLeg?.startedAtSim?.getTime() ?? 0) + (lastLeg?.plannedDurationSeconds ?? 0) * 1000;
    expect(lastLegEndMs).toBe(T0 + totalMs);
    const updatedJourney = await prisma.journey.findUniqueOrThrow({ where: { letterId } });
    expect(updatedJourney.completedAtSim?.getTime()).toBe(T0 + totalMs);
    const letter = await prisma.letter.findUniqueOrThrow({ where: { id: letterId } });
    expect(letter.status).toBe("OUT_FOR_DELIVERY");
  });

  it("last-mile：DELIVERED + deliveredAt 设置一次，终态 no-op 不重写", async () => {
    const { letterId } = await createDispatchedLetter("bob5", "HORSE_RELAY", "adv-delivered");
    await setNormalSeed(letterId, "HORSE_RELAY", "adv-delivered");
    const clock = new TestSimulationClock(T0);
    await advanceJourneyToNow(prisma, letterId, clock); // 激活

    const journey = await prisma.journey.findUniqueOrThrow({ where: { letterId } });
    const legs = await prisma.transportLeg.findMany({
      where: { journeyId: journey.id },
      orderBy: { sequence: "asc" },
    });
    const totalMs = legs.reduce((acc, l) => acc + l.plannedDurationSeconds * 1000, 0);
    const deliveredAtMs = T0 + totalMs + LAST_MILE_DURATION_SECONDS * 1000;
    clock.advanceTo(deliveredAtMs);
    const result = await advanceJourneyToNow(prisma, letterId, clock);
    expect(result.letterStatus).toBe("DELIVERED");
    const letter = await prisma.letter.findUniqueOrThrow({ where: { id: letterId } });
    expect(letter.status).toBe("DELIVERED");
    expect(letter.deliveredAt?.getTime()).toBe(deliveredAtMs);

    // 终态再 advance（更晚）→ no-op，deliveredAt 不变
    clock.advanceTo(deliveredAtMs + 100 * HOUR_MS);
    const again = await advanceJourneyToNow(prisma, letterId, clock);
    expect(again.changed).toBe(false);
    const letterAfter = await prisma.letter.findUniqueOrThrow({ where: { id: letterId } });
    expect(letterAfter.deliveredAt?.getTime()).toBe(deliveredAtMs);
  });

  it("多 Leg 大时间跳跃：一次跨多个 Leg，时间结余精确传递（不写成 now）", async () => {
    const { letterId } = await createDispatchedLetter("bob5", "HORSE_RELAY", "adv-multileg");
    await setNormalSeed(letterId, "HORSE_RELAY", "adv-multileg");
    const journey = await prisma.journey.findUniqueOrThrow({ where: { letterId } });
    const legs = await prisma.transportLeg.findMany({
      where: { journeyId: journey.id },
      orderBy: { sequence: "asc" },
    });
    expect(legs.length).toBeGreaterThanOrEqual(3);
    // 控制前 3 个 Leg 各 10h，复现 Prompt 示例（Leg1/Leg2/Leg3 = 10h）
    for (let i = 0; i < 3; i += 1) {
      const leg = legs[i];
      if (!leg) continue;
      await prisma.transportLeg.update({
        where: { id: leg.id },
        data: { plannedDurationSeconds: 10 * 3600 },
      });
    }

    const clock = new TestSimulationClock(T0);
    await advanceJourneyToNow(prisma, letterId, clock); // 建立运输起始基准 T0

    clock.advanceTo(T0 + 25 * HOUR_MS);
    const result = await advanceJourneyToNow(prisma, letterId, clock);
    expect(result.changed).toBe(true);
    expect(result.currentLegSequence).toBe(2); // Leg3 ACTIVE（0-based index 2）

    const updatedLegs = await prisma.transportLeg.findMany({
      where: { journeyId: journey.id },
      orderBy: { sequence: "asc" },
    });
    // Leg1 completed at T0+10h（不是 T0+25h）
    expect(updatedLegs[0]?.status).toBe("COMPLETED");
    expect(updatedLegs[0]?.completedAtSim?.getTime()).toBe(T0 + 10 * HOUR_MS);
    // Leg2 completed at T0+20h（时间结余继续传递）
    expect(updatedLegs[1]?.status).toBe("COMPLETED");
    expect(updatedLegs[1]?.completedAtSim?.getTime()).toBe(T0 + 20 * HOUR_MS);
    // Leg3 active since T0+20h，未完成（进度约 50%）
    expect(updatedLegs[2]?.status).toBe("ACTIVE");
    expect(updatedLegs[2]?.startedAtSim?.getTime()).toBe(T0 + 20 * HOUR_MS);
    expect(updatedLegs[2]?.completedAtSim).toBeNull();
    // 后续 Leg 仍未开始
    expect(updatedLegs[3]?.status).toBe("PLANNED");
    expect(updatedLegs[3]?.startedAtSim).toBeNull();
  });

  it("completedPath 单调增加 / remainingPath 单调减少（GET 视图）", async () => {
    const { trackingNo, letterId } = await createDispatchedLetter(
      "bob5",
      "HORSE_RELAY",
      "adv-path"
    );
    await setNormalSeed(letterId, "HORSE_RELAY", "adv-path");
    const journey = await prisma.journey.findUniqueOrThrow({ where: { letterId } });
    const legs = await prisma.transportLeg.findMany({
      where: { journeyId: journey.id },
      orderBy: { sequence: "asc" },
    });
    for (let i = 0; i < 2; i += 1) {
      const leg = legs[i];
      if (!leg) continue;
      await prisma.transportLeg.update({
        where: { id: leg.id },
        data: { plannedDurationSeconds: 2 * 3600 },
      });
    }

    const clock = new TestSimulationClock(T0);
    await advanceJourneyToNow(prisma, letterId, clock); // 激活（completed=[]，remaining=full）
    const view1 = await getJourney(trackingNo, bob.accessToken);
    const beforeCompleted = view1.json().journey.completedPath.length;
    const beforeRemaining = view1.json().journey.remainingPath.length;
    expect(beforeCompleted).toBe(0);
    expect(beforeRemaining).toBeGreaterThan(0);

    clock.advanceTo(T0 + 3 * HOUR_MS); // 完成 Leg1（2h）
    await advanceJourneyToNow(prisma, letterId, clock);
    const view2 = await getJourney(trackingNo, bob.accessToken);
    const afterCompleted = view2.json().journey.completedPath.length;
    const afterRemaining = view2.json().journey.remainingPath.length;
    expect(afterCompleted).toBeGreaterThan(beforeCompleted); // 只增
    expect(afterRemaining).toBeLessThan(beforeRemaining); // 只减
    // completedPath 是完整路线的前缀、remainingPath 是后缀（允许共享一个衔接节点），
    // 两者并集恰好覆盖完整路线（不重复、不丢失）。
    const routeNames: string[] = view1
      .json()
      .journey.routeNodes.map((n: { name: string }) => n.name);
    const completedNames: string[] = view2
      .json()
      .journey.completedPath.map((n: { name: string }) => n.name);
    const remainingNames: string[] = view2
      .json()
      .journey.remainingPath.map((n: { name: string }) => n.name);
    expect(routeNames.slice(0, completedNames.length)).toEqual(completedNames);
    expect(routeNames.slice(-remainingNames.length)).toEqual(remainingNames);
    const union = new Set([...completedNames, ...remainingNames]);
    expect(union.size).toBe(routeNames.length);
    expect(new Set(routeNames).size).toBe(routeNames.length);
  });

  it("PIGEON 正常推进：单直连 leg → OUT_FOR_DELIVERY → DELIVERED", async () => {
    const { letterId } = await createDispatchedLetter("bob5", "PIGEON", "adv-pigeon");
    await setNormalSeed(letterId, "PIGEON", "adv-pigeon");
    const journey = await prisma.journey.findUniqueOrThrow({ where: { letterId } });
    const legs = await prisma.transportLeg.findMany({ where: { journeyId: journey.id } });
    expect(legs).toHaveLength(1);
    const durationMs = (legs[0]?.plannedDurationSeconds ?? 0) * 1000;

    const clock = new TestSimulationClock(T0);
    await advanceJourneyToNow(prisma, letterId, clock);
    clock.advanceTo(T0 + durationMs);
    const atStation = await advanceJourneyToNow(prisma, letterId, clock);
    expect(atStation.letterStatus).toBe("OUT_FOR_DELIVERY");

    clock.advanceTo(T0 + durationMs + LAST_MILE_DURATION_SECONDS * 1000);
    const delivered = await advanceJourneyToNow(prisma, letterId, clock);
    expect(delivered.letterStatus).toBe("DELIVERED");
    const letter = await prisma.letter.findUniqueOrThrow({ where: { id: letterId } });
    expect(letter.status).toBe("DELIVERED");
  });

  it("同 now 重复 advance：第二次 no-op（幂等）", async () => {
    const { letterId } = await createDispatchedLetter("bob5", "HORSE_RELAY", "adv-idem");
    await setNormalSeed(letterId, "HORSE_RELAY", "adv-idem");
    const clock = new TestSimulationClock(T0);
    clock.advanceTo(T0 + 25 * HOUR_MS);
    const first = await advanceJourneyToNow(prisma, letterId, clock);
    expect(first.changed).toBe(true);

    const before = await prisma.journey.findUniqueOrThrow({ where: { letterId } });
    const second = await advanceJourneyToNow(prisma, letterId, clock);
    expect(second.changed).toBe(false);
    const after = await prisma.journey.findUniqueOrThrow({ where: { letterId } });
    expect(after.lastAdvancedAtSim?.getTime()).toBe(before.lastAdvancedAtSim?.getTime());
    expect(after.status).toBe(before.status);
    expect(after.currentLegSequence).toBe(before.currentLegSequence);
  });

  it("并发 advance：恰一个 changed，无重复完成 / 双 ACTIVE / 500", async () => {
    const { letterId } = await createDispatchedLetter("bob5", "HORSE_RELAY", "adv-concurrent");
    await setNormalSeed(letterId, "HORSE_RELAY", "adv-concurrent");
    const journey = await prisma.journey.findUniqueOrThrow({ where: { letterId } });
    const legs = await prisma.transportLeg.findMany({
      where: { journeyId: journey.id },
      orderBy: { sequence: "asc" },
    });
    for (let i = 0; i < 2; i += 1) {
      const leg = legs[i];
      if (!leg) continue;
      await prisma.transportLeg.update({
        where: { id: leg.id },
        data: { plannedDurationSeconds: 1 * 3600 },
      });
    }
    const clock = new TestSimulationClock(T0 + 5 * HOUR_MS); // 同一模拟 now，两个并发调用共享
    const results = await Promise.all([
      advanceJourneyToNow(prisma, letterId, clock),
      advanceJourneyToNow(prisma, letterId, clock),
    ]);
    expect(results.filter((r) => r.changed)).toHaveLength(1);

    const afterLegs = await prisma.transportLeg.findMany({
      where: { journeyId: journey.id },
      orderBy: { sequence: "asc" },
    });
    // 无重复完成：COMPLETED leg 的 completedAtSim 唯一；无两个 ACTIVE
    expect(afterLegs.filter((l) => l.status === "ACTIVE").length).toBeLessThanOrEqual(1);
    const completedTimes = afterLegs
      .filter((l) => l.status === "COMPLETED")
      .map((l) => l.completedAtSim?.getTime());
    expect(new Set(completedTimes).size).toBe(completedTimes.length);
    // 与顺序执行结果一致（顺序推进一次）
    const journey2 = await prisma.journey.findUniqueOrThrow({ where: { letterId } });
    expect(journey2.currentLegSequence).not.toBeNull();
  });

  it("时间倒退 advance：no-op（不重放、不倒退）", async () => {
    const { letterId } = await createDispatchedLetter("bob5", "HORSE_RELAY", "adv-regression");
    await setNormalSeed(letterId, "HORSE_RELAY", "adv-regression");
    const clock = new TestSimulationClock(T0);
    await advanceJourneyToNow(prisma, letterId, clock);
    clock.advanceTo(T0 + 25 * HOUR_MS);
    const forward = await advanceJourneyToNow(prisma, letterId, clock);
    expect(forward.changed).toBe(true);

    const before = await prisma.journey.findUniqueOrThrow({ where: { letterId } });
    clock.advanceTo(T0 + 10 * HOUR_MS); // 倒退
    const back = await advanceJourneyToNow(prisma, letterId, clock);
    expect(back.changed).toBe(false);
    const after = await prisma.journey.findUniqueOrThrow({ where: { letterId } });
    expect(after.lastAdvancedAtSim?.getTime()).toBe(before.lastAdvancedAtSim?.getTime());
    expect(after.currentLegSequence).toBe(before.currentLegSequence);
  });

  it("unknown Journey.rulesVersion：明确失败（推进以 Journey 冻结版本为权威），事务整体回滚无状态写入", async () => {
    const { letterId } = await createDispatchedLetter("bob5", "HORSE_RELAY", "adv-badrules");
    // 只修改 Journey.rulesVersion，Letter.rulesVersion 保持 "1.0"
    const journeyBefore = await prisma.journey.findUniqueOrThrow({ where: { letterId } });
    expect(journeyBefore.rulesVersion).toBe("1.0");
    await prisma.journey.update({
      where: { letterId },
      data: { rulesVersion: "999.0" },
    });
    const letterBefore = await prisma.letter.findUniqueOrThrow({ where: { id: letterId } });
    const legsBefore = await prisma.transportLeg.findMany({
      where: { journeyId: journeyBefore.id },
      orderBy: { sequence: "asc" },
    });

    const clock = new TestSimulationClock(T0 + 5 * HOUR_MS);
    await expect(advanceJourneyToNow(prisma, letterId, clock)).rejects.toThrow(
      UnknownRulesVersionError
    );

    // 无状态写入：Letter / Journey / Leg 各字段均不变，deliveredAt 不变
    const letterAfter = await prisma.letter.findUniqueOrThrow({ where: { id: letterId } });
    expect(letterAfter.status).toBe(letterBefore.status);
    expect(letterAfter.deliveredAt?.getTime()).toBe(letterBefore.deliveredAt?.getTime());
    const journeyAfter = await prisma.journey.findUniqueOrThrow({ where: { letterId } });
    expect(journeyAfter.status).toBe(journeyBefore.status);
    expect(journeyAfter.currentLegSequence).toBe(journeyBefore.currentLegSequence);
    expect(journeyAfter.lastAdvancedAtSim?.getTime()).toBe(
      journeyBefore.lastAdvancedAtSim?.getTime()
    );
    expect(journeyAfter.startedAtSim?.getTime()).toBe(journeyBefore.startedAtSim?.getTime());
    expect(journeyAfter.completedAtSim?.getTime()).toBe(journeyBefore.completedAtSim?.getTime());
    const legsAfter = await prisma.transportLeg.findMany({
      where: { journeyId: journeyBefore.id },
      orderBy: { sequence: "asc" },
    });
    expect(legsAfter.map((l) => l.status)).toEqual(legsBefore.map((l) => l.status));
    expect(legsAfter.map((l) => l.startedAtSim?.getTime() ?? null)).toEqual(
      legsBefore.map((l) => l.startedAtSim?.getTime() ?? null)
    );
    expect(legsAfter.map((l) => l.completedAtSim?.getTime() ?? null)).toEqual(
      legsBefore.map((l) => l.completedAtSim?.getTime() ?? null)
    );
  });

  it("反向保护：Letter.rulesVersion 未知但 Journey.rulesVersion 有效 → 正常推进（推进不再依赖 Letter）", async () => {
    const { letterId } = await createDispatchedLetter("bob5", "HORSE_RELAY", "adv-letterbad");
    // 只修改 Letter.rulesVersion，Journey.rulesVersion 保持 "1.0"
    await prisma.letter.update({
      where: { id: letterId },
      data: { rulesVersion: "999.0" },
    });
    const journey = await prisma.journey.findUniqueOrThrow({ where: { letterId } });
    expect(journey.rulesVersion).toBe("1.0");

    const clock = new TestSimulationClock(T0);
    const result = await advanceJourneyToNow(prisma, letterId, clock);
    expect(result.changed).toBe(true);
    expect(result.letterStatus).toBe("IN_TRANSIT");
    const legs = await prisma.transportLeg.findMany({
      where: { journeyId: journey.id },
      orderBy: { sequence: "asc" },
    });
    expect(legs[0]?.status).toBe("ACTIVE");
  });

  it("不存在的 Letter / Journey：明确错误", async () => {
    const clock = new TestSimulationClock(T0);
    await expect(advanceJourneyToNow(prisma, BigInt(999999), clock)).rejects.toThrow(
      LetterNotFoundError
    );
    const { letterId } = await createDispatchedLetter("bob5", "HORSE_RELAY", "adv-nojourney");
    await prisma.journey.delete({ where: { letterId } });
    await expect(advanceJourneyToNow(prisma, letterId, clock)).rejects.toThrow(
      JourneyNotFoundError
    );
  });

  it("Recipient 正文解锁：DELIVERED 前 null，DELIVERED 后可读", async () => {
    const { trackingNo, letterId } = await createDispatchedLetter(
      "bob5",
      "HORSE_RELAY",
      "adv-unlock"
    );
    await setNormalSeed(letterId, "HORSE_RELAY", "adv-unlock");
    const journey = await prisma.journey.findUniqueOrThrow({ where: { letterId } });
    const legs = await prisma.transportLeg.findMany({
      where: { journeyId: journey.id },
      orderBy: { sequence: "asc" },
    });
    const clock = new TestSimulationClock(T0);
    await advanceJourneyToNow(prisma, letterId, clock); // 在途：Recipient 看不到正文
    const before = await getLetterDetail(trackingNo, bob.accessToken);
    expect(before.json().letter.content).toBeNull();

    const totalMs = legs.reduce((acc, l) => acc + l.plannedDurationSeconds * 1000, 0);
    const deliveredAtMs = T0 + totalMs + LAST_MILE_DURATION_SECONDS * 1000;
    clock.advanceTo(deliveredAtMs);
    await advanceJourneyToNow(prisma, letterId, clock);
    const after = await getLetterDetail(trackingNo, bob.accessToken);
    expect(after.json().letter.content).toBe("content adv-unlock");
  });

  it("Sender 无 readState / openedAt（阅读隐私）", async () => {
    const { trackingNo, letterId } = await createDispatchedLetter(
      "bob5",
      "HORSE_RELAY",
      "adv-readstate"
    );
    await setNormalSeed(letterId, "HORSE_RELAY", "adv-readstate");
    const journey = await prisma.journey.findUniqueOrThrow({ where: { letterId } });
    const legs = await prisma.transportLeg.findMany({
      where: { journeyId: journey.id },
      orderBy: { sequence: "asc" },
    });
    const clock = new TestSimulationClock(T0);
    await advanceJourneyToNow(prisma, letterId, clock); // 建立运输起始基准 T0
    const totalMs = legs.reduce((acc, l) => acc + l.plannedDurationSeconds * 1000, 0);
    const deliveredAtMs = T0 + totalMs + LAST_MILE_DURATION_SECONDS * 1000;
    clock.advanceTo(deliveredAtMs);
    await advanceJourneyToNow(prisma, letterId, clock);
    // Recipient 拆信（OPENED）
    const openRes = await app.inject({
      method: "POST",
      url: `/api/v1/letters/${trackingNo}/open`,
      headers: { authorization: `Bearer ${bob.accessToken}` },
    });
    expect(openRes.statusCode).toBe(200);
    // Sender 详情序列化：完全不存在 readState / openedAt
    const senderView = await getLetterDetail(trackingNo, alice.accessToken);
    const serialized = JSON.stringify(senderView.json());
    expect(serialized).not.toMatch(/readState/);
    expect(serialized).not.toMatch(/openedAt/);
  });

  it("安全序列化：GET journey 不含 internal id / simulationSeed / plannedDuration / ETA", async () => {
    const { trackingNo, letterId } = await createDispatchedLetter(
      "bob5",
      "HORSE_RELAY",
      "adv-noleak"
    );
    const clock = new TestSimulationClock(T0);
    await advanceJourneyToNow(prisma, letterId, clock);
    const res = await getJourney(trackingNo, bob.accessToken);
    expect(res.statusCode).toBe(200);
    const serialized = JSON.stringify(res.json());
    expect(serialized).not.toMatch(/simulationSeed/);
    expect(serialized).not.toMatch(/plannedDuration/);
    expect(serialized).not.toMatch(/eta/i);
    expect(serialized).not.toMatch(/estimatedArrival/);
    expect(serialized).not.toMatch(/lastAdvancedAtSim/);
    expect(serialized).not.toMatch(/startedAtSim/);
    expect(serialized).not.toMatch(/currentLegSequence/);
    // internal id 不出现（Letter/Journey/Leg id 字段均不得返回）
    expect(serialized).not.toMatch(/"id":/);
  });

  it("later-sent 可先到：多 Letter 独立推进", async () => {
    // HAND_CARRY 慢信先发；HORSE_RELAY 快信后发，同一模拟 now 下快信先 DELIVERED
    const slow = await createDispatchedLetter("bob5", "HAND_CARRY", "adv-slow");
    await setNormalSeed(slow.letterId, "HAND_CARRY", "adv-slow");
    const fast = await createDispatchedLetter("bob5", "HORSE_RELAY", "adv-fast");
    await setNormalSeed(fast.letterId, "HORSE_RELAY", "adv-fast");

    const clock = new TestSimulationClock(T0);
    await advanceJourneyToNow(prisma, slow.letterId, clock);
    await advanceJourneyToNow(prisma, fast.letterId, clock);
    // 推进到"慢信（HAND_CARRY 全程约 42 天）仍在中途、快信（HORSE_RELAY 全程约 9 天）已送达"的时刻
    const nowMs = T0 + 15 * 24 * HOUR_MS;
    clock.advanceTo(nowMs);
    // 慢信 HAND_CARRY 全程还没走完
    const slowResult = await advanceJourneyToNow(prisma, slow.letterId, clock);
    expect(slowResult.letterStatus).not.toBe("DELIVERED");
    // 快信 HORSE_RELAY 已 DELIVERED（后发先到）
    const fastResult = await advanceJourneyToNow(prisma, fast.letterId, clock);
    expect(fastResult.letterStatus).toBe("DELIVERED");
    const fastLetter = await prisma.letter.findUniqueOrThrow({ where: { id: fast.letterId } });
    expect(fastLetter.deliveredAt).toBeTruthy();
  });

  it("零 Leg 同站点 PIGEON：立即到达 → OUT_FOR_DELIVERY → DELIVERED", async () => {
    const letterRes = await createLetter("alice5", "same station", "PIGEON", "adv-zeroleg");
    const trackingNo = letterRes.json().letter.trackingNo;
    const initRes = await initJourney(trackingNo);
    expect(initRes.statusCode).toBe(201);
    const letterId = await letterIdOf(trackingNo);
    const journey = await prisma.journey.findUniqueOrThrow({ where: { letterId } });
    expect(await prisma.transportLeg.findMany({ where: { journeyId: journey.id } })).toHaveLength(
      0
    );

    const clock = new TestSimulationClock(T0);
    const first = await advanceJourneyToNow(prisma, letterId, clock);
    expect(first.letterStatus).toBe("OUT_FOR_DELIVERY");
    clock.advanceTo(T0 + LAST_MILE_DURATION_SECONDS * 1000);
    const second = await advanceJourneyToNow(prisma, letterId, clock);
    expect(second.letterStatus).toBe("DELIVERED");
  });
});
