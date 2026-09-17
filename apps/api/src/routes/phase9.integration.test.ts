import { randomUUID } from "node:crypto";
import { createServer, connect, type Socket } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig, requireTestDatabaseUrl } from "@yishu/config";
import { createPrismaClient, type PrismaClient } from "@yishu/db";
import { TestSimulationClock, deterministicDraw } from "@yishu/simulation";
import { reconcileLetterPush, registerPushDevice, pushMessage } from "@yishu/domain/push";
import { advanceJourneyToNow, materializeVisibleTimeline } from "@yishu/domain";
import { createQueues, redisConnection, type Queues } from "@yishu/worker/queue";
import { processJourney, scheduleJourney } from "@yishu/worker/scheduler";
import { deliverPush, checkPushReceipts } from "@yishu/worker/push-processor";
import { startWorkerRuntime } from "@yishu/worker/runtime";
import type { PushProvider } from "@yishu/worker/push-provider";
import { buildApp } from "../app.js";
import type { FastifyInstance } from "fastify";

// Real PostgreSQL + Redis, fake provider only. Never touch a production queue namespace.
describe("Phase 9 scheduling and push integration", () => {
  const prefix = `yishu-test-${randomUUID()}`;
  const base = Date.UTC(2026, 8, 17);
  const clock = new TestSimulationClock(base);
  let db: PrismaClient;
  let app: FastifyInstance;
  let queues: Queues;
  let redisUrl: string;
  let alice: { id: bigint; accessToken: string };
  let bob: { id: bigint; accessToken: string };
  const accounts = [`p9a${randomUUID().slice(0, 8)}`, `p9b${randomUUID().slice(0, 8)}`];
  const provider: PushProvider = {
    send: vi.fn(async () => ({ status: "ok" as const, ticketId: "fake-ticket" })),
    receipt: vi.fn(async () => "ok" as const),
  };

  async function user(account: string) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        account,
        password: "phase9-test-password",
        nickname: "P9",
        province: account === accounts[0] ? "上海市" : "北京市",
        city: account === accounts[0] ? "上海市" : "北京市",
        district: "徐汇区",
      },
    });
    expect(response.statusCode).toBe(201);
    const row = await db.user.findUniqueOrThrow({ where: { account } });
    return { id: row.id, accessToken: response.json().accessToken as string };
  }
  async function letter(journey = false) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/letters",
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: {
        recipient: accounts[1],
        content: "NEVER_SEND_THIS_SECRET",
        transportType: "PIGEON",
        clientRequestId: randomUUID(),
      },
    });
    expect(response.statusCode).toBe(201);
    const trackingNo: string = response.json().letter.trackingNo;
    // Phase 3 creation uses database wall-clock timestamps; freeze this fixture explicitly.
    await db.letter.update({
      where: { trackingNo },
      data: { createdAt: new Date(base), sentAt: new Date(base) },
    });
    if (journey)
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/v1/letters/${trackingNo}/journey`,
            headers: { authorization: `Bearer ${alice.accessToken}` },
          })
        ).statusCode
      ).toBe(201);
    const row = await db.letter.findUniqueOrThrow({
      where: { trackingNo },
      include: { journey: true },
    });
    if (row.journey) {
      let seed = 0;
      while (deterministicDraw(`phase9-normal-${seed}`, 0) >= 0.92) seed++;
      await db.journey.update({
        where: { id: row.journey.id },
        data: { simulationSeed: `phase9-normal-${seed}` },
      });
    }
    return row;
  }
  async function dispatch() {
    await registerPushDevice(db, bob.id, "ExpoPushToken[phase9_fake]", "android", base - 1);
    const row = await letter();
    await reconcileLetterPush(db, row.id, clock.now());
    return db.pushDispatch.findFirstOrThrow({ where: { letterId: row.id } });
  }
  beforeAll(async () => {
    const config = loadConfig({ NODE_ENV: "test" });
    db = createPrismaClient(requireTestDatabaseUrl(process.env));
    redisUrl = config.REDIS_URL;
    app = buildApp(config, { prisma: db, simulationClock: clock });
    alice = await user(accounts[0] as string);
    bob = await user(accounts[1] as string);
    queues = createQueues(redisConnection(redisUrl), prefix);
    await Promise.all(Object.values(queues).map((q) => q.waitUntilReady()));
  });
  afterEach(async () => {
    await Promise.all(Object.values(queues).map((q) => q.obliterate({ force: true })));
    await db.letter.deleteMany({ where: { senderId: alice.id } });
    await db.pushDevice.deleteMany({ where: { userId: { in: [alice.id, bob.id] } } });
    clock.advanceTo(base);
    vi.mocked(provider.send)
      .mockReset()
      .mockResolvedValue({ status: "ok", ticketId: "fake-ticket" });
    vi.mocked(provider.receipt).mockReset().mockResolvedValue("ok");
  });
  afterAll(async () => {
    if (queues) await Promise.all(Object.values(queues).map((q) => q.close()));
    if (app) await app.close();
    if (db) {
      await db.refreshToken.deleteMany({ where: { user: { account: { in: accounts } } } });
      await db.user.deleteMany({ where: { account: { in: accounts } } });
      await db.$disconnect();
    }
  });

  it("requires auth, supports multiple devices, and unregisters only the owner", async () => {
    const payload = { token: "ExpoPushToken[phase9_one]", platform: "android" };
    expect(
      (await app.inject({ method: "POST", url: "/api/v1/push/register", payload })).statusCode
    ).toBe(401);
    for (const token of [payload.token, "ExpoPushToken[phase9_two]"]) {
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/push/register",
            payload: { ...payload, token },
            headers: { authorization: `Bearer ${alice.accessToken}` },
          })
        ).statusCode
      ).toBe(200);
    }
    expect(await db.pushDevice.count({ where: { userId: alice.id } })).toBe(2);
    await app.inject({
      method: "DELETE",
      url: "/api/v1/push/unregister",
      payload: { token: payload.token },
      headers: { authorization: `Bearer ${bob.accessToken}` },
    });
    expect(
      (await db.pushDevice.findUniqueOrThrow({ where: { expoPushToken: payload.token } })).disabled
    ).toBe(false);
    await app.inject({
      method: "DELETE",
      url: "/api/v1/push/unregister",
      payload: { token: payload.token },
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(
      (await db.pushDevice.findUniqueOrThrow({ where: { expoPushToken: payload.token } })).disabled
    ).toBe(true);
  });

  it("deduplicates recipient-only NEW_LETTER and sends a closed safe payload", async () => {
    const item = await dispatch();
    await registerPushDevice(db, alice.id, "ExpoPushToken[phase9_sender]", "ios", base - 1);
    await Promise.all([
      reconcileLetterPush(db, item.letterId, base),
      reconcileLetterPush(db, item.letterId, base),
    ]);
    expect(await db.pushDispatch.count({ where: { letterId: item.letterId } })).toBe(1);
    await Promise.all([
      deliverPush(db, clock, provider, item.id),
      deliverPush(db, clock, provider, item.id),
    ]);
    expect(provider.send).toHaveBeenCalledTimes(1);
    const message = vi.mocked(provider.send).mock.calls[0]?.[1];
    if (!message) throw new Error("missing_push_message");
    expect(message.body).toBe(`${accounts[0]} 给你送了一封信`);
    expect(Object.keys(message).sort()).toEqual(["body", "data", "title"]);
    expect(Object.keys(message.data)).toEqual(["trackingNo"]);
    expect(JSON.stringify(message)).not.toMatch(
      /content|openedAt|readState|simulationSeed|anomalyType|LETTER_DROPPED|ROBBERY|LOST_PATH|SERIOUS_ACCIDENT|ETA|remainingSeconds|NEVER_SEND_THIS_SECRET/
    );
  });

  it("account switch cancels an old owner's queued notification", async () => {
    const item = await dispatch();
    await registerPushDevice(db, alice.id, "ExpoPushToken[phase9_fake]", "android", base);
    await deliverPush(db, clock, provider, item.id);
    expect(provider.send).not.toHaveBeenCalled();
    expect((await db.pushDispatch.findUniqueOrThrow({ where: { id: item.id } })).status).toBe(
      "CANCELLED"
    );
  });

  it("provider failure does not change Letter and invalid token is disabled", async () => {
    const item = await dispatch();
    const before = await db.letter.findUniqueOrThrow({ where: { id: item.letterId } });
    vi.mocked(provider.send)
      .mockResolvedValueOnce({ status: "retry" })
      .mockResolvedValueOnce({ status: "invalid" });
    await expect(deliverPush(db, clock, provider, item.id)).rejects.toThrow("push_provider_retry");
    await deliverPush(db, clock, provider, item.id);
    expect(await db.letter.findUniqueOrThrow({ where: { id: item.letterId } })).toEqual(before);
    expect((await db.pushDevice.findUniqueOrThrow({ where: { id: item.deviceId } })).disabled).toBe(
      true
    );
  });

  it("invalid receipt disables its original device generation", async () => {
    const item = await dispatch();
    await deliverPush(db, clock, provider, item.id);
    vi.mocked(provider.receipt).mockResolvedValue("invalid");
    await checkPushReceipts(db, provider);
    expect((await db.pushDevice.findUniqueOrThrow({ where: { id: item.deviceId } })).disabled).toBe(
      true
    );
  });

  it("hidden causes and ordinary station events never become push text", () => {
    for (const kind of [
      "ROBBERY",
      "LOST_PATH",
      "LETTER_DROPPED",
      "SERIOUS_ACCIDENT",
      "REROUTED",
      "DEPARTED_STATION",
      "ARRIVED_STATION",
      "DISPATCHED",
      "OPENED",
    ]) {
      expect(pushMessage(kind, "tracking", "sender")).toBeNull();
    }
  });

  it("real Redis delayed enqueue is duplicate-safe with identity-only payload", async () => {
    const row = await letter(true);
    if (!row.journey) throw new Error("missing_journey");
    await Promise.all([
      scheduleJourney(db, queues, row.journey.id),
      scheduleJourney(db, queues, row.journey.id),
    ]);
    const jobs = await queues.journey.getJobs(["delayed"]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.data).toEqual({ journeyId: String(row.journey.id) });
    expect(jobs[0]?.delay).toBe(5000);
  });

  it("concurrent processing, early retry and terminal stale job are idempotent", async () => {
    const row = await letter(true);
    if (!row.journey) throw new Error("missing_journey");
    const id = row.journey.id;
    await Promise.all([
      processJourney(db, queues, clock, id),
      processJourney(db, queues, clock, id),
    ]);
    const before = await db.journey.findUniqueOrThrow({ where: { id }, include: { legs: true } });
    await processJourney(db, queues, clock, id);
    expect(await db.journey.findUniqueOrThrow({ where: { id }, include: { legs: true } })).toEqual(
      before
    );
    clock.advanceBy(40 * 86400000);
    await processJourney(db, queues, clock, id);
    expect((await db.letter.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("DELIVERED");
    await queues.journey.obliterate({ force: true });
    const terminal = await db.journey.findUniqueOrThrow({ where: { id } });
    clock.advanceBy(86400000);
    await processJourney(db, queues, clock, id);
    expect(await db.journey.findUniqueOrThrow({ where: { id } })).toEqual(terminal);
    expect(await queues.journey.getJobCounts("waiting", "delayed")).toMatchObject({
      waiting: 0,
      delayed: 0,
    });
  });

  it("production runtime consumes persisted queue after restart and closes resources", async () => {
    const row = await letter(true);
    if (!row.journey) throw new Error("missing_journey");
    const journeyId = row.journey.id;
    await scheduleJourney(db, queues, journeyId, 100);
    const options = { db, redisUrl, clock, provider, prefix };
    let runtime = await startWorkerRuntime(options);
    try {
      await vi.waitFor(
        async () =>
          expect(
            (await db.journey.findUniqueOrThrow({ where: { id: journeyId } })).lastAdvancedAtSim
          ).not.toBeNull(),
        { timeout: 10000 }
      );
    } finally {
      await runtime.close();
    }
    clock.advanceBy(40 * 86400000);
    runtime = await startWorkerRuntime(options);
    try {
      await vi.waitFor(
        async () =>
          expect((await db.letter.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(
            "DELIVERED"
          ),
        { timeout: 15000 }
      );
    } finally {
      await runtime.close();
    }
    expect(runtime.workers.every((worker) => worker.closing !== undefined)).toBe(true);
  });

  it("unavailable Redis fails safely and a subsequent healthy startup recovers", async () => {
    await expect(
      startWorkerRuntime({ db, redisUrl: "redis://127.0.0.1:1", clock, provider, prefix })
    ).rejects.toThrow("worker_dependency_unavailable");
    const runtime = await startWorkerRuntime({ db, redisUrl, clock, provider, prefix });
    await runtime.close();
  });

  it("two real consumers and duplicate jobs match one canonical progression", async () => {
    const control = await letter(true);
    const queued = await letter(true);
    if (!queued.journey) throw new Error("missing_journey");
    await advanceJourneyToNow(db, control.id, clock);
    await processJourney(db, queues, clock, queued.journey.id);
    clock.advanceBy(40 * 86400000);
    await advanceJourneyToNow(db, control.id, clock);
    await materializeVisibleTimeline(db, control.id, clock.now());
    await queues.journey.add(
      "advance",
      { journeyId: String(queued.journey.id) },
      { jobId: "duplicate-one" }
    );
    await queues.journey.add(
      "advance",
      { journeyId: String(queued.journey.id) },
      { jobId: "duplicate-two" }
    );
    const first = await startWorkerRuntime({ db, redisUrl, clock, provider, prefix });
    let second: Awaited<ReturnType<typeof startWorkerRuntime>> | undefined;
    try {
      second = await startWorkerRuntime({ db, redisUrl, clock, provider, prefix });
      await vi.waitFor(
        async () =>
          expect((await db.letter.findUniqueOrThrow({ where: { id: queued.id } })).status).toBe(
            "DELIVERED"
          ),
        { timeout: 10000 }
      );
    } finally {
      await Promise.all([first.close(), second?.close()]);
    }
    const snapshot = async (letterId: bigint) => ({
      letter: await db.letter.findUniqueOrThrow({
        where: { id: letterId },
        select: { status: true, deliveredAt: true },
      }),
      journey: await db.journey.findUniqueOrThrow({
        where: { letterId },
        select: {
          status: true,
          lastAdvancedAtSim: true,
          completedAtSim: true,
          currentLegSequence: true,
          nextRandomDrawIndex: true,
          nextWorldEventIndex: true,
          legs: {
            orderBy: { sequence: "asc" },
            select: {
              sequence: true,
              status: true,
              startedAtSim: true,
              completedAtSim: true,
              primaryEventIndex: true,
              primaryEventOutcome: true,
              delaySeconds: true,
            },
          },
        },
      }),
      timeline: await db.timelineEvent.findMany({
        where: { letterId },
        orderBy: { sourceKey: "asc" },
        select: { type: true, happenedAt: true, visibleAt: true },
      }),
    });
    expect(await snapshot(queued.id)).toEqual(await snapshot(control.id));
  });

  it("running workers recover after a temporary Redis network outage", async () => {
    const target = new URL(redisUrl);
    const sockets = new Set<Socket>();
    let unavailable = false;
    const proxy = createServer((client) => {
      if (unavailable) {
        client.destroy();
        return;
      }
      const upstream = connect(Number(target.port || 6379), target.hostname);
      sockets.add(client);
      sockets.add(upstream);
      client.on("error", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
      client.on("close", () => {
        sockets.delete(client);
        upstream.destroy();
      });
      upstream.on("close", () => {
        sockets.delete(upstream);
        client.destroy();
      });
      client.pipe(upstream).pipe(client);
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("missing_proxy_port");
    const proxyUrl = new URL(redisUrl);
    proxyUrl.hostname = "127.0.0.1";
    proxyUrl.port = String(address.port);
    const row = await letter(true);
    const onError = vi.fn();
    let runtime: Awaited<ReturnType<typeof startWorkerRuntime>> | undefined;
    try {
      runtime = await startWorkerRuntime({
        db,
        redisUrl: proxyUrl.toString(),
        clock,
        provider,
        prefix,
        onError,
      });
      await vi.waitFor(
        async () =>
          expect(
            (await db.journey.findUniqueOrThrow({ where: { letterId: row.id } })).lastAdvancedAtSim
          ).not.toBeNull(),
        { timeout: 10000 }
      );
      unavailable = true;
      for (const socket of sockets) socket.destroy();
      await vi.waitFor(() => expect(onError).toHaveBeenCalled(), { timeout: 5000 });
      clock.advanceBy(40 * 86400000);
      unavailable = false;
      await vi.waitFor(
        async () =>
          expect((await db.letter.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(
            "DELIVERED"
          ),
        { timeout: 15000 }
      );
    } finally {
      unavailable = false;
      await runtime?.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });
});
