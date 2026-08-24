import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, requireTestDatabaseUrl } from "@yishu/config";
import { createPrismaClient, type PrismaClient } from "@yishu/db";
import { buildApp } from "../app.js";
import type { FastifyInstance } from "fastify";
import { resetStationGraphCache } from "../lib/stationGraph.js";

/**
 * Phase 4 Journey 集成测试（fsharp：ground/Pigeon/继承字段/并发幂等/安全序列化）。
 * 仅 *_test 库。
 */
describe("journey integration", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let alice: { account: string; uid: string; accessToken: string };
  let bob: { account: string; uid: string; accessToken: string };

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

  // Letter 对外视图不暴露 internal id（安全设计），测试通过 trackingNo 反查 id。
  async function letterIdOf(trackingNo: string): Promise<bigint> {
    const l = await prisma.letter.findUniqueOrThrow({ where: { trackingNo } });
    return l.id;
  }

  /** 轮询直到存在“正被 T1 后端进程阻塞”的锁等待会话（行锁等待的典型形态：wait_event=transactionid）。
   * 注：等待 FOR UPDATE 行锁的 UPDATE 在 pg_locks 中表现为 `locktype='transactionid'` 而非 `tuple`，
   * 故用 pg_stat_activity 的 wait_event_type='Lock' + wait_event='transactionid' 判断；
   * 且必须用 pg_blocking_pids(waiter.pid) 包含 T1 的 pg_backend_pid 确认阻塞源，排除其他会话假阳性；
   * 并限定 current_database()（仅本测试库）、排除自身会话（pg_backend_pid）。
   * 轮询用共享连接池的独立连接。超时抛错避免测试悬挂（调用方须在 finally 释放 T1）。 */
  async function waitForRowLockWait(t1BackendPid: number, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rows = await prisma.$queryRaw<Array<{ waiting: number }>>`
        SELECT count(*)::int AS waiting
        FROM pg_stat_activity AS waiter
        WHERE waiter.wait_event_type = 'Lock'
          AND waiter.wait_event = 'transactionid'
          AND waiter.datname = current_database()
          AND waiter.pid <> pg_backend_pid()
          AND pg_blocking_pids(waiter.pid) @> ARRAY[${t1BackendPid}]::int[]
      `;
      if ((rows[0]?.waiting ?? 0) > 0) return;
      if (Date.now() > deadline) {
        throw new Error(
          `timeout: init transaction did not block on Letter row lock held by backend ${t1BackendPid}`
        );
      }
      await new Promise((r) => setTimeout(r, 25));
    }
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
      account: "alicej",
      password: "alicej-pass",
      nickname: "AJ",
      province: "上海市",
      city: "上海市",
      district: "徐汇区",
    });
    bob = await registerUser({
      account: "bobj",
      password: "bobj-pass",
      nickname: "BJ",
      province: "北京市",
      city: "北京市",
      district: "海淀区",
    });
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it("ground HORSE_RELAY Journey：创建 + 继承字段 + 原子 legs + completed/remaining", async () => {
    const letterRes = await createLetter("bobj", "ground journey", "HORSE_RELAY", "j-ground");
    const trackingNo = letterRes.json().letter.trackingNo;

    const jres = await initJourney(trackingNo);
    expect(jres.statusCode).toBe(201);
    const journey = jres.json().journey;
    // 起点/终点 station 名称
    expect(journey.origin.name).toBe("上海");
    expect(journey.destination.name).toBe("北京");
    expect(journey.totalDistanceKm).toBeGreaterThan(0);
    expect(journey.legs.length).toBeGreaterThan(0);
    // completedPath 空、remainingPath 非空（本阶段全 PLANNED）
    expect(journey.completedPath).toEqual([]);
    expect(journey.remainingPath.length).toBeGreaterThan(0);

    // 数据库校验：1 Journey + N Legs + 继承字段
    const dbJourney = await prisma.journey.findUniqueOrThrow({
      where: { letterId: await letterIdOf(trackingNo) },
      include: { legs: true },
    });
    expect(dbJourney.rulesVersion).toBe("1.0");
    expect(dbJourney.graphVersion).toBe("china-v1");
    expect(dbJourney.simulationSeed).toBeTruthy();
    // simulationSeed 必须等于 Letter 的 simulationSeed
    const letter = await prisma.letter.findUniqueOrThrow({ where: { id: dbJourney.letterId } });
    expect(dbJourney.simulationSeed).toBe(letter.simulationSeed);
    // Letter 进入 DISPATCHED
    expect(letter.status).toBe("DISPATCHED");
    // legs 序列从 0 递增、距离>0、transport 合法
    const legs = dbJourney.legs.slice().sort((a, b) => a.sequence - b.sequence);
    legs.forEach((leg, i) => {
      expect(leg.sequence).toBe(i);
      expect(leg.distanceKm).toBeGreaterThan(0);
      expect(["HAND_CARRY", "HORSE_RELAY", "EXPRESS_RELAY", "PIGEON"]).toContain(leg.transportType);
    });
    const totalDistance = legs.reduce((acc, l) => acc + l.distanceKm, 0);
    expect(Math.round(totalDistance)).toBe(Math.round(dbJourney.totalDistanceKm));

    // 安全序列化：不返回 internal id / simulationSeed / plannedDuration / ETA
    const serialized = JSON.stringify(journey);
    expect(serialized).not.toMatch(/simulationSeed/);
    expect(serialized).not.toMatch(/plannedDuration/);
    expect(serialized).not.toMatch(/eta/i);
    expect(serialized).not.toMatch(/estimatedArrival/);
  });

  it("PIGEON Journey：单直连 leg、不走 road graph、Haversine 距离", async () => {
    const letterRes = await createLetter("bobj", "pigeon journey", "PIGEON", "j-pigeon");
    const trackingNo = letterRes.json().letter.trackingNo;
    const jres = await initJourney(trackingNo);
    expect(jres.statusCode).toBe(201);
    const journey = jres.json().journey;
    expect(journey.legs).toHaveLength(1);
    expect(journey.legs[0].transportType).toBe("PIGEON");
    // 直线距离应明显小于地面多段路程（上海→北京直线 ~1067km）
    expect(journey.totalDistanceKm).toBeGreaterThan(900);
    expect(journey.totalDistanceKm).toBeLessThan(1300);

    const dbJourney = await prisma.journey.findUniqueOrThrow({
      where: { letterId: await letterIdOf(trackingNo) },
      include: { legs: true },
    });
    expect(dbJourney.legs).toHaveLength(1);
    expect(dbJourney.legs.at(0)?.transportType).toBe("PIGEON");
  });

  it("仅 Sender 可初始化；Recipient/第三方 404（不泄露 Letter 存在）", async () => {
    const letterRes = await createLetter("bobj", "perm check", "HORSE_RELAY", "j-perm");
    const trackingNo = letterRes.json().letter.trackingNo;
    const recipientTry = await initJourney(trackingNo, bob.accessToken);
    expect(recipientTry.statusCode).toBe(404);
    // Sender 成功
    const ok = await initJourney(trackingNo);
    expect(ok.statusCode).toBe(201);
    // Recipient 查询可见（同视图）
    const getByRecipient = await getJourney(trackingNo, bob.accessToken);
    expect(getByRecipient.statusCode).toBe(200);
    expect(getByRecipient.json().journey.origin.name).toBe("上海");
  });

  it("并发初始化：最终仅 1 个 Journey、Legs 不重复（UNIQUE letterId 保障）", async () => {
    const letterRes = await createLetter("bobj", "concurrent", "HORSE_RELAY", "j-concurrent");
    const trackingNo = letterRes.json().letter.trackingNo;
    const letterId = await letterIdOf(trackingNo);

    // 并发触发两次初始化：必须恰好一个 201（真正创建）、一个 200（幂等返回现有）
    const [r1, r2] = await Promise.all([initJourney(trackingNo), initJourney(trackingNo)]);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([200, 201]);

    const journeys = await prisma.journey.findMany({ where: { letterId } });
    expect(journeys).toHaveLength(1);
    const journeyId = journeys[0]?.id;
    expect(journeyId).toBeDefined();
    const legs = await prisma.transportLeg.findMany({ where: { journeyId } });
    // legs 不重复（sequence 唯一）
    const seqs = new Set(legs.map((l) => l.sequence));
    expect(seqs.size).toBe(legs.length);
  });

  it("Letter 已存在 Journey 时再次 POST 返回现有（幂等 200）", async () => {
    const letterRes = await createLetter("bobj", "idempotent", "HORSE_RELAY", "j-idem");
    const trackingNo = letterRes.json().letter.trackingNo;
    const first = await initJourney(trackingNo);
    expect(first.statusCode).toBe(201);
    const second = await initJourney(trackingNo);
    expect(second.statusCode).toBe(200);
    const journeys = await prisma.journey.findMany({
      where: { letterId: await letterIdOf(trackingNo) },
    });
    expect(journeys).toHaveLength(1);
  });

  it("Sender/Recipient 看到相同 route 事实（同视图）", async () => {
    const letterRes = await createLetter("bobj", "same view", "HORSE_RELAY", "j-sameview");
    const trackingNo = letterRes.json().letter.trackingNo;
    await initJourney(trackingNo);
    const senderView = await getJourney(trackingNo, alice.accessToken);
    const recipientView = await getJourney(trackingNo, bob.accessToken);
    expect(senderView.json().journey.legs.length).toBe(recipientView.json().journey.legs.length);
    expect(senderView.json().journey.totalDistanceKm).toBe(
      recipientView.json().journey.totalDistanceKm
    );
  });

  it("非 CREATED（终态 DELIVERED）Letter 初始化 → 409，状态不倒退（HIGH-2）", async () => {
    const letterRes = await createLetter("bobj", "terminal letter", "HORSE_RELAY", "j-terminal");
    const trackingNo = letterRes.json().letter.trackingNo;
    const letterId = await letterIdOf(trackingNo);
    // 直接置为终态 DELIVERED（含 deliveredAt）
    await prisma.letter.update({
      where: { id: letterId },
      data: { status: "DELIVERED", deliveredAt: new Date("2026-08-24T00:00:00Z") },
    });
    const res = await initJourney(trackingNo);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("letter_not_created");
    // 不得创建 Journey，且 Letter 状态仍为 DELIVERED（不得倒退到 DISPATCHED）
    const journeys = await prisma.journey.findMany({ where: { letterId } });
    expect(journeys).toHaveLength(0);
    const letter = await prisma.letter.findUniqueOrThrow({ where: { id: letterId } });
    expect(letter.status).toBe("DELIVERED");
    expect(letter.deliveredAt).toBeTruthy();
  });

  it("未知 graphVersion → 422 unknown_graph_version（BLOCKER-1 冻结拒绝）", async () => {
    const letterRes = await createLetter("bobj", "bad graph", "HORSE_RELAY", "j-badgraph");
    const trackingNo = letterRes.json().letter.trackingNo;
    await prisma.letter.update({
      where: { trackingNo },
      data: { graphVersion: "china-v999" },
    });
    const res = await initJourney(trackingNo);
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("unknown_graph_version");
    expect(res.json().version).toBe("china-v999");
    // 不得创建 Journey
    const journeys = await prisma.journey.findMany({
      where: { letterId: await letterIdOf(trackingNo) },
    });
    expect(journeys).toHaveLength(0);
  });

  it("未知 rulesVersion → 422 unknown_rules_version（BLOCKER-1 冻结拒绝）", async () => {
    const letterRes = await createLetter("bobj", "bad rules", "HORSE_RELAY", "j-badrules");
    const trackingNo = letterRes.json().letter.trackingNo;
    await prisma.letter.update({
      where: { trackingNo },
      data: { rulesVersion: "999.0" },
    });
    const res = await initJourney(trackingNo);
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("unknown_rules_version");
    expect(res.json().version).toBe("999.0");
  });

  it("同站点 PIGEON：零 Leg 但运输方式仍为 PIGEON（HIGH-3，不得 HAND_CARRY 兜底）", async () => {
    const letterRes = await createLetter("alicej", "same station", "PIGEON", "j-samepigeon");
    const trackingNo = letterRes.json().letter.trackingNo;
    const res = await initJourney(trackingNo);
    expect(res.statusCode).toBe(201);
    const journey = res.json().journey;
    expect(journey.transportType).toBe("PIGEON");
    expect(journey.legs).toHaveLength(0);
    expect(journey.totalDistanceKm).toBe(0);
    expect(journey.origin.name).toBe("上海");
    expect(journey.destination.name).toBe("上海");
  });

  it("行锁竞态：初始化期间状态被并发改为终态 → 409 letter_status_conflict，事务整体回滚（MEDIUM-1）", async () => {
    const letterRes = await createLetter("bobj", "row lock race", "HORSE_RELAY", "j-rowlock");
    const trackingNo = letterRes.json().letter.trackingNo;
    const letterId = await letterIdOf(trackingNo);

    // 确定性交错（无固定延迟）：
    //   T1 持有 Letter 行锁（FOR UPDATE）→ 握手通知主测试（携带 T1 的 pg_backend_pid）
    //   主测试启动 init（事务外读到 CREATED，事务内 UPDATE 阻塞等行锁）
    //   主测试轮询 pg_stat_activity + pg_blocking_pids，确认 init 正被 T1 阻塞 → 放行 T1 提交 DELIVERED
    //   条件更新匹配 0 行 → LetterStatusConflictError → 409，整体回滚
    // 释放必须 once：timeout / 断言失败路径也须放行 T1，避免测试悬挂。
    let signalLockHeld: ((pid: number) => void) | undefined;
    const lockHeld = new Promise<number>((resolve) => {
      signalLockHeld = resolve;
    });
    let signalGo: (() => void) | undefined;
    const goT1 = new Promise<void>((resolve) => {
      signalGo = resolve;
    });
    let t1Released = false;
    const releaseT1Once = (): void => {
      if (t1Released) return;
      t1Released = true;
      signalGo?.();
    };

    const t1 = prisma.$transaction(async (tx) => {
      // T1 真正的 backend pid：探针用它确认“init 被本测试的 T1 阻塞”，排除假阳性
      const pidRows = await tx.$queryRaw<
        Array<{ pid: number }>
      >`SELECT pg_backend_pid()::int AS pid`;
      const t1Pid = pidRows[0]?.pid;
      if (t1Pid == null) throw new Error("T1 backend pid unavailable");
      await tx.$queryRaw`SELECT id FROM "Letter" WHERE id = ${letterId} FOR UPDATE`;
      signalLockHeld?.(t1Pid); // 行锁已持有
      await goT1; // 等待主测试确认 init 事务已阻塞在 T1 持有的行锁上
      await tx.letter.update({
        where: { id: letterId },
        data: { status: "DELIVERED", deliveredAt: new Date("2026-08-24T02:00:00Z") },
      });
      return t1Pid;
    });
    // 兜底：锁握手超时等异常路径不再 await t1 时，吞掉其拒绝避免 unhandled rejection
    void t1.catch(() => undefined);

    const t1BackendPid = await Promise.race([
      lockHeld,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout: T1 did not acquire Letter row lock")), 5000)
      ),
    ]); // 确定性：T1 已持有行锁
    const initPromise = initJourney(trackingNo); // 不 await：条件更新将阻塞等待行锁
    let probeError: unknown;
    try {
      await waitForRowLockWait(t1BackendPid); // 确定性：init 事务正被 T1 阻塞
    } catch (err) {
      probeError = err; // 探针超时也走 finally 放行 T1，避免悬挂
    } finally {
      releaseT1Once(); // 放行 T1 提交 DELIVERED（只放行一次）
    }
    await t1;
    const res = await initPromise;
    if (probeError !== undefined) throw probeError;

    // 明确业务冲突 409，而非 500
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("letter_status_conflict");
    // 整体回滚：不残留 Journey / Leg
    const journeys = await prisma.journey.findMany({ where: { letterId } });
    expect(journeys).toHaveLength(0);
    // Letter 保持 DELIVERED（终态不被倒退）
    const letter = await prisma.letter.findUniqueOrThrow({ where: { id: letterId } });
    expect(letter.status).toBe("DELIVERED");
    expect(letter.deliveredAt).toBeTruthy();
  }, 15000);
});
