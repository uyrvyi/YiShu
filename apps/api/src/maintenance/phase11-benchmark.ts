import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { loadConfig, requireTestDatabaseUrl, resolveRepoRoot } from "@yishu/config";
import { createPrismaClient, type PrismaClient, type Prisma } from "@yishu/db";
import { advanceJourneyToNow, materializeVisibleTimeline } from "@yishu/domain";
import {
  getDefaultGraphVersion,
  getGraphVersions,
  planRoute,
  resetStationGraphCache,
} from "@yishu/domain/stationGraph";
import { RULES_VERSIONS, TRANSPORT_TYPES } from "@yishu/shared";
import { TestSimulationClock } from "@yishu/simulation";
import { createQueues, redisConnection, type Queues } from "@yishu/worker/queue";
import { processJourney } from "@yishu/worker/scheduler";
import { buildApp } from "../app.js";
import { encryptContent } from "../lib/crypto.js";
import { initializeJourney } from "../lib/journey.js";
import { DUMMY_PASSWORD_HASH } from "../lib/password.js";

const exec = promisify(execFile);
const BASE = Date.UTC(2026, 8, 30);
const DAY = 86400000;
const USERS = 100;
const LETTERS = 10000;
const JOURNEYS = 96;
const BODY = "phase11 synthetic benchmark body ".repeat(50);

function summarize(name: string, durations: number[], elapsedMs: number, concurrency: number) {
  assert(durations.length > 0);
  durations.sort((a, b) => a - b);
  const samples = durations.length;
  const quantile = (fraction: number) =>
    Number((durations[Math.ceil(fraction * samples) - 1] ?? 0).toFixed(2));
  return {
    name,
    samples,
    concurrency,
    p50Ms: quantile(0.5),
    p95Ms: quantile(0.95),
    p99Ms: quantile(0.99),
    maxMs: quantile(1),
    operationsPerSecond: Number(((samples * 1000) / elapsedMs).toFixed(2)),
  };
}

async function measure(
  name: string,
  samples: number,
  concurrency: number,
  work: (index: number) => unknown | Promise<unknown>
) {
  const durations: number[] = [];
  let next = 0;
  const start = performance.now();
  const results = await Promise.allSettled(
    Array.from({ length: concurrency }, async () => {
      for (;;) {
        const index = next++;
        if (index >= samples) return;
        const before = performance.now();
        await work(index);
        durations.push(performance.now() - before);
      }
    })
  );
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return summarize(name, durations, performance.now() - start, concurrency);
}

async function pacedReadSoak(work: (index: number) => Promise<void>) {
  const start = performance.now();
  const heapBefore = process.memoryUsage().heapUsed;
  const durations: number[] = [];
  let next = 0;
  // 32 req/s covers 50 clients at 3 detail requests/5s plus list polling/30s.
  while (performance.now() - start < 60000) {
    const batchStart = performance.now();
    const results = await Promise.allSettled(
      Array.from({ length: 16 }, async () => {
        const index = next++;
        const before = performance.now();
        await work(index);
        durations.push(performance.now() - before);
      })
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    await delay(Math.max(0, 500 - (performance.now() - batchStart)));
  }
  return {
    metric: summarize("paced_read_soak", durations, performance.now() - start, 16),
    seconds: Number(((performance.now() - start) / 1000).toFixed(2)),
    targetRequestsPerSecond: 32,
    heapUsedMiBBefore: Number((heapBefore / 1024 / 1024).toFixed(2)),
    heapUsedMiBAfter: Number((process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)),
  };
}

async function seed(db: PrismaClient, key: string, graphVersion: string) {
  await db.user.createMany({
    data: Array.from({ length: USERS }, (_, index) => ({
      uid: String(40000000 + index),
      account: `benchmark_${index}`,
      nickname: "Benchmark",
      passwordHash: DUMMY_PASSWORD_HASH,
      province: "上海市",
      city: "上海市",
      district: "徐汇区",
    })),
  });
  const users = await db.user.findMany({ orderBy: { id: "asc" } });
  for (let offset = 0; offset < LETTERS; offset += 500) {
    const data: Prisma.LetterCreateManyInput[] = [];
    for (let index = offset; index < offset + 500; index++) {
      const sender = users[index < 1000 ? 0 : 2 + (index % (USERS - 2))];
      const recipient = users[index < 1000 ? 1 : 2 + ((index + 1) % (USERS - 2))];
      const transport = TRANSPORT_TYPES[index % TRANSPORT_TYPES.length];
      assert(sender && recipient && transport);
      const encrypted = encryptContent(BODY, key);
      data.push({
        trackingNo: `YS-20260930-${index.toString(36).toUpperCase().padStart(5, "0")}`,
        senderId: sender.id,
        recipientId: recipient.id,
        senderAccountSnapshot: sender.account,
        senderUidSnapshot: sender.uid,
        senderNicknameSnapshot: sender.nickname,
        recipientAccountSnapshot: recipient.account,
        recipientUidSnapshot: recipient.uid,
        recipientNicknameSnapshot: recipient.nickname,
        encryptedContent: encrypted.ciphertext,
        contentIv: encrypted.iv,
        contentAuthTag: encrypted.authTag,
        originProvince: "上海市",
        originCity: "上海市",
        originDistrict: "徐汇区",
        targetProvince: "北京市",
        targetCity: "北京市",
        targetDistrict: "海淀区",
        status: "CREATED",
        initialTransport: transport,
        currentTransport: transport,
        clientRequestId: `benchmark-${index}`,
        requestFingerprint: createHash("sha256").update(`body-${index}`).digest("hex"),
        rulesVersion: "1.0",
        graphVersion,
        simulationSeed: createHash("sha256").update(`benchmark-${index}`).digest("hex"),
        createdAt: new Date(BASE + index),
        sentAt: new Date(BASE + index),
      });
    }
    await db.letter.createMany({ data });
  }
  const letters = await db.letter.findMany({
    orderBy: { id: "asc" },
    select: { id: true, senderId: true, recipientId: true, trackingNo: true },
  });
  for (let offset = 0; offset < letters.length; offset += 500) {
    const page = letters.slice(offset, offset + 500);
    await db.senderState.createMany({
      data: page.map((letter) => ({
        letterId: letter.id,
        senderId: letter.senderId,
        hiddenAt: letter.id > 200n && letter.id <= 1000n ? new Date(BASE) : null,
      })),
    });
    await db.recipientState.createMany({
      data: page.map((letter) => ({
        letterId: letter.id,
        recipientId: letter.recipientId,
        readState: "UNOPENED",
      })),
    });
  }
  const journeys = [];
  for (const letter of letters.slice(0, JOURNEYS)) {
    const initialized = await initializeJourney(db, letter.id);
    await advanceJourneyToNow(db, letter.id, new TestSimulationClock(BASE + DAY));
    await materializeVisibleTimeline(db, letter.id, BASE + DAY);
    journeys.push({ id: initialized.journey.id, trackingNo: letter.trackingNo });
  }
  assert.equal(letters.length, LETTERS);
  assert.equal(users.length, USERS);
  return { users, journeys };
}

async function integrity(db: PrismaClient) {
  const [row] = await db.$queryRaw<
    Array<{
      missingStates: number;
      wrongOwners: number;
      frozenMismatch: number;
      invalidEventCursor: number;
      multipleActive: number;
      unvalidatedForeignKeys: number;
    }>
  >`
    SELECT
      (SELECT COUNT(*)::int FROM "Letter" l LEFT JOIN "SenderState" s ON s."letterId" = l.id LEFT JOIN "RecipientState" r ON r."letterId" = l.id WHERE s.id IS NULL OR r.id IS NULL) AS "missingStates",
      (SELECT COUNT(*)::int FROM "Letter" l JOIN "SenderState" s ON s."letterId" = l.id JOIN "RecipientState" r ON r."letterId" = l.id WHERE s."senderId" <> l."senderId" OR r."recipientId" <> l."recipientId") AS "wrongOwners",
      (SELECT COUNT(*)::int FROM "Journey" j JOIN "Letter" l ON l.id = j."letterId" WHERE j."simulationSeed" <> l."simulationSeed" OR j."graphVersion" <> l."graphVersion" OR j."rulesVersion" <> l."rulesVersion") AS "frozenMismatch",
      (SELECT COUNT(*)::int FROM "WorldEvent" e JOIN "Journey" j ON j.id = e."journeyId" WHERE e."eventIndex" >= j."nextWorldEventIndex") AS "invalidEventCursor",
      (SELECT COUNT(*)::int FROM (SELECT "journeyId" FROM "TransportLeg" WHERE status = 'ACTIVE' GROUP BY "journeyId" HAVING COUNT(*) > 1) violations) AS "multipleActive",
      (SELECT COUNT(*)::int FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace AND NOT convalidated) AS "unvalidatedForeignKeys"
  `;
  assert(row);
  assert(
    Object.values(row).every((count) => count === 0),
    "business_integrity_failed"
  );
  const versions = getGraphVersions();
  for (const journey of await db.journey.findMany()) {
    assert(versions.includes(journey.graphVersion));
    assert(RULES_VERSIONS.some((version) => version === journey.rulesVersion));
    assert.match(journey.simulationSeed, /^[0-9a-f]{64}$/);
  }
  return row;
}

async function main() {
  const config = loadConfig();
  const testUrl = new URL(requireTestDatabaseUrl(process.env));
  const databaseName = `yishu_phase11_${randomUUID().replaceAll("-", "")}_test`;
  assert.match(databaseName, /^yishu_phase11_[a-f0-9]{32}_test$/);
  const adminUrl = new URL(testUrl);
  adminUrl.pathname = "/postgres";
  testUrl.pathname = `/${databaseName}`;
  requireTestDatabaseUrl({ TEST_DATABASE_URL: testUrl.href });
  const admin = createPrismaClient(adminUrl.href);
  const db = createPrismaClient(testUrl.href);
  const app = buildApp(
    { ...config, NODE_ENV: "test", DATABASE_URL: testUrl.href },
    { prisma: db, simulationClock: new TestSimulationClock(BASE + DAY) }
  );
  let created = false;
  let queues: Queues | undefined;
  let queuesRemoved = true;
  let stage = "create_isolated_database";
  let report: object | undefined;
  try {
    // The identifier is generated locally and validated; never target the configured dev/test database.
    await admin.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`);
    created = true;
    const cwd = resolveRepoRoot();
    const env = { ...process.env, DATABASE_URL: testUrl.href };
    stage = "fresh_migrations_and_schema_diff";
    await exec("pnpm", ["exec", "prisma", "migrate", "deploy"], { cwd, env, timeout: 120000 });
    await exec(
      "pnpm",
      [
        "exec",
        "prisma",
        "migrate",
        "diff",
        "--from-config-datasource",
        "--to-schema",
        "prisma/schema.prisma",
        "--exit-code",
      ],
      { cwd, env, timeout: 120000 }
    );
    const history = await db.$queryRaw<
      Array<{ unfinished: number; applied: number }>
    >`SELECT COUNT(*) FILTER (WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)::int AS unfinished, COUNT(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)::int AS applied FROM "_prisma_migrations"`;
    const disk = (
      await readdir(path.join(cwd, "prisma/migrations"), { withFileTypes: true })
    ).filter((entry) => entry.isDirectory()).length;
    assert.equal(history[0]?.unfinished, 0);
    assert.equal(history[0]?.applied, disk);

    stage = "seed_100_users_10000_letters";
    const graphVersion = getDefaultGraphVersion();
    const { users, journeys } = await seed(db, config.CONTENT_ENCRYPTION_KEY, graphVersion);
    const before = await integrity(db);
    await db.$executeRawUnsafe("ANALYZE");
    await app.ready();
    const sender = users[0];
    const recipient = users[1];
    assert(sender && recipient && journeys.length === JOURNEYS);
    const senderHeaders = {
      authorization: `Bearer ${app.jwt.sign({ sub: sender.uid }, { expiresIn: 3600 })}`,
    };
    const recipientHeaders = {
      authorization: `Bearer ${app.jwt.sign({ sub: recipient.uid }, { expiresIn: 3600 })}`,
    };
    const route = {
      graphVersion,
      originNodeId: "shanghai",
      destinationNodeId: "beijing",
      transportType: "HORSE_RELAY" as const,
    };
    const metrics = [];
    stage = "graph_and_api_measurements";
    metrics.push(
      await measure("graph_cold_load_and_route", 30, 1, () => {
        resetStationGraphCache();
        planRoute(route);
      })
    );

    metrics.push(await measure("cached_ground_route", 500, 1, () => planRoute(route)));
    const endpoints = [
      { name: "sent_list_50_with_800_hidden", suffix: "?direction=sent&limit=50", list: true },
      {
        name: "received_list_50",
        suffix: "?direction=received&limit=50",
        list: true,
        recipient: true,
      },
      { name: "letter_detail", suffix: "" },
      { name: "journey", suffix: "/journey" },
      { name: "timeline", suffix: "/timeline" },
      { name: "map", suffix: "/map", recipient: true },
    ];
    const request = async (endpoint: (typeof endpoints)[number], index: number) => {
      const journey = journeys[index % journeys.length];
      assert(journey);
      const response = await app.inject({
        url: endpoint.list
          ? `/api/v1/letters${endpoint.suffix}`
          : `/api/v1/letters/${journey.trackingNo}${endpoint.suffix}`,
        headers: endpoint.recipient ? recipientHeaders : senderHeaders,
      });
      assert.equal(response.statusCode, 200, endpoint.name);
      if (endpoint.list) assert.equal(response.json().letters.length, 50, endpoint.name);
    };
    for (const endpoint of endpoints) {
      await request(endpoint, 0);
      metrics.push(await measure(endpoint.name, 100, 20, (index) => request(endpoint, index)));
    }
    metrics.push(
      await measure("mixed_polling", 600, 20, (index) => {
        const endpoint = endpoints[index % endpoints.length];
        assert(endpoint);
        return request(endpoint, index);
      })
    );

    stage = "paced_read_soak";
    console.log("Phase 11: 60s paced read soak started (32 requests/s).");
    const readWorld = () =>
      db.journey.findMany({
        orderBy: { id: "asc" },
        include: {
          legs: { orderBy: { sequence: "asc" } },
          worldEvents: { orderBy: { eventIndex: "asc" } },
          letter: { select: { status: true, currentTransport: true, deliveredAt: true } },
        },
      });
    const frozenWorld = await readWorld();
    const soak = await pacedReadSoak((index) => {
      const endpoint = endpoints[index % endpoints.length];
      assert(endpoint);
      return request(endpoint, index);
    });
    assert.deepEqual(await readWorld(), frozenWorld, "read_soak_changed_world_truth");
    metrics.push(soak.metric);

    stage = "worker_handler_measurement";
    const prefix = `yishu-benchmark-${randomUUID()}`;
    queues = createQueues(redisConnection(config.REDIS_URL), prefix);
    const testQueues = queues;
    await Promise.all(Object.values(testQueues).map((queue) => queue.waitUntilReady()));
    const clock = new TestSimulationClock(BASE + 365 * DAY);
    const worker = await measure("worker_handler_one_year_progression", JOURNEYS, 4, (index) => {
      const journey = journeys[index];
      assert(journey);
      return processJourney(db, testQueues, clock, journey.id);
    });
    metrics.push(worker);
    const after = await integrity(db);
    const terminal = await db.letter.count({
      where: {
        journey: { isNot: null },
        status: { in: ["DELIVERED", "PERMANENTLY_LOST", "DESTROYED"] },
      },
    });
    assert.equal(terminal, JOURNEYS);
    const checks = {
      apiP95Below500Ms: metrics
        .filter(
          (metric) =>
            endpoints.some((endpoint) => endpoint.name === metric.name) ||
            metric.name === "mixed_polling" ||
            metric.name === "paced_read_soak"
        )
        .every((metric) => metric.p95Ms < 500),
      workerP95Below2000Ms: worker.p95Ms < 2000,
      workerAtLeast5PerSecond: worker.operationsPerSecond >= 5,
    };
    const pass = Object.values(checks).every(Boolean);
    report = {
      status: pass ? "BASELINE_PASS" : "BASELINE_FAIL",
      environment: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        availableParallelism: availableParallelism(),
      },
      workload: {
        users: USERS,
        letters: LETTERS,
        journeys: JOURNEYS,
        maxUserLetters: 1000,
        maxConcurrentRequests: 20,
        bodyCodePoints: BODY.length,
        graphVersion,
      },
      migrations: { freshApplied: disk, schemaDiff: "empty" },
      integrity: { before, after },
      soak: { ...soak, metric: undefined, worldTruthUnchanged: true },
      metrics,
      checks,
      limitations: [
        "Fastify inject includes authentication/DB/serialization, not TCP/TLS or mobile latency",
        "Worker metric invokes the real processor with isolated Redis queues, not queue dispatch throughput",
        "Thresholds are local regression guards, not a confirmed production capacity SLA",
        "60s paced reads and one-year simulated advancement do not replace multi-hour runtime endurance testing",
      ],
    };
    if (!pass) process.exitCode = 1;
  } catch (error) {
    console.error(
      JSON.stringify({
        status: "ERROR",
        stage,
        errorClass: error instanceof Error ? error.name : "UnknownError",
      })
    );
    process.exitCode = 1;
  } finally {
    if (queues) {
      const cleanup = await Promise.allSettled(
        Object.values(queues).map(async (queue) => {
          try {
            await queue.obliterate({ force: true });
          } finally {
            await queue.close();
          }
        })
      );
      queuesRemoved = cleanup.every((result) => result.status === "fulfilled");
      if (!queuesRemoved) process.exitCode = 1;
    }
    await app.close();
    await db.$disconnect();
    try {
      if (created) await admin.$executeRawUnsafe(`DROP DATABASE "${databaseName}"`);
    } finally {
      await admin.$disconnect();
    }
  }
  if (report)
    console.log(
      JSON.stringify(
        { ...report, isolatedDatabaseRemoved: true, isolatedQueuesRemoved: queuesRemoved },
        null,
        2
      )
    );
}

void main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      status: "cleanup_or_initialization_failed",
      errorClass: error instanceof Error ? error.name : "UnknownError",
    })
  );
  process.exitCode = 1;
});
