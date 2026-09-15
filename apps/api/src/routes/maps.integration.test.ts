import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { loadConfig, requireTestDatabaseUrl, resolveRepoRoot } from "@yishu/config";
import { createPrismaClient, type PrismaClient } from "@yishu/db";
import { deterministicDraw, TestSimulationClock } from "@yishu/simulation";
import {
  LAST_MILE_DURATION_SECONDS,
  MAP_APPROXIMATE_MAX_RATIO,
  MAP_DATA_BOUNDS,
  MAP_FACT_LIMIT,
  MAP_FIT,
  TIMELINE_IMPORTANCE,
  type TimelineEventType,
  type TransportType,
} from "@yishu/shared";
import { buildApp } from "../app.js";
import { getStationNode, resetStationGraphCache } from "../lib/stationGraph.js";
import { advanceJourneyToNow } from "../lib/journey-advance.js";

/**
 * Phase 8 Map 集成测试（仅 `*_test` 库）。
 *
 * 对应阶段规划 Phase 8 Gate：
 * - 完全离线 + mapX/mapY 正确 + 固定 viewBox 契约（数据即契约）
 * - sender / recipient 同图；第三方 404
 * - 已走实线 / 未走虚线 / 当前大概位置（非精确 GPS）/ 无 ETA
 * - 信使失联：只保留最后确报，不再推测位置，未走路线仍为虚线
 * - 隐藏掉落（internal `LETTER_DROPPED`）全局 HIDDEN：用户可见状态仍 `IN_TRANSIT`、
 *   无掉落范围 / 无掉落原因、隐藏期间不产生新的用户可确认事实
 * - map facts 只来自用户可见 Timeline（集合包含、≤5、时间升序）
 */

const GRAPH_VERSION = "china-v1";
const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** §74 冻结字段（多一个都算泄漏）。 */
const ALLOWED_KEYS = [
  "approximatePosition",
  "completedPath",
  "destination",
  "facts",
  "lastKnownPosition",
  "origin",
  "remainingPath",
  "status",
] as const;
const ALLOWED_FACT_KEYS = [
  "description",
  "happenedAt",
  "location",
  "title",
  "type",
  "x",
  "y",
] as const;

/** 任何用户可见地图输出都不得出现的内部 / 禁止信息。 */
const FORBIDDEN_SUBSTRINGS = [
  "DROP",
  "drop",
  "掉落",
  "anomaly",
  "cause",
  "LOST_PATH",
  "ROBBERY",
  "SERIOUS_ACCIDENT",
  "抢劫",
  "事故",
  "死亡",
  "eta",
  "ETA",
  "countdown",
  "estimate",
  "prediction",
  "gps",
  "lat",
  "lng",
];

interface Point {
  x: number;
  y: number;
}
interface StationView extends Point {
  name: string;
  province: string;
  city: string;
}
interface FactView {
  type: string;
  title: string;
  description: string;
  location: { province: string; city: string };
  happenedAt: string;
  x: number;
  y: number;
}
interface MapDto {
  status: string;
  origin: StationView | null;
  destination: StationView | null;
  completedPath: Point[];
  remainingPath: Point[];
  approximatePosition: Point | null;
  lastKnownPosition: Point | null;
  facts: FactView[];
}
interface TimelineDto {
  type: string;
  title: string;
  description: string;
  location: { province: string; city: string };
  happenedAt: string;
}

describe("map integration (Phase 8)", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let clock: TestSimulationClock;
  let alice: { uid: string; accessToken: string };
  let bob: { uid: string; accessToken: string };
  let carol: { uid: string; accessToken: string };

  const T0 = new Date("2026-11-01T00:00:00Z").getTime();

  const HC = {
    NORMAL: [0, 0.84] as const,
    REROUTE: [0.89, 0.93] as const,
    LOST_PATH: [0.93, 0.95] as const,
    ROBBERY: [0.95, 0.97] as const,
    COURIER_MISSING: [0.97, 0.985] as const,
    LETTER_DROPPED: [0.985, 0.995] as const,
  } as const;
  /** ROBBERY 二级分支：MISSING_DROPPED（.80–.95）→ 后台 LETTER_DROPPED（不产生 COURIER_MISSING）。 */
  const ROBBERY_DROPPED: readonly [number, number] = [0.8, 0.99];
  /** PIGEON primary event：NORMAL / SERIOUS_ACCIDENT（§28 概率表）。 */
  const PIGEON_NORMAL: readonly [number, number] = [0, 0.92];
  const PIGEON_ACCIDENT: readonly [number, number] = [0.997, 1];
  const DROP_WINDOW = { WITHIN_24H: [0, 0.5] as const, NEVER: [0.9, 1] as const } as const;

  function findSeed0(range: readonly [number, number], tag: string): string {
    for (let i = 0; i < 500000; i += 1) {
      const seed = `${tag}-${i}`;
      const d = deterministicDraw(seed, 0);
      if (d >= range[0] && d < range[1]) return seed;
    }
    throw new Error(`no seed found for ${tag}`);
  }

  function findSeed012(
    r0: readonly [number, number],
    r1: readonly [number, number],
    r2: readonly [number, number],
    tag: string
  ): string {
    for (let i = 0; i < 2000000; i += 1) {
      const seed = `${tag}-${i}`;
      const d0 = deterministicDraw(seed, 0);
      const d1 = deterministicDraw(seed, 1);
      const d2 = deterministicDraw(seed, 2);
      if (d0 >= r0[0] && d0 < r0[1] && d1 >= r1[0] && d1 < r1[1] && d2 >= r2[0] && d2 < r2[1]) {
        return seed;
      }
    }
    throw new Error(`no seed found for ${tag}`);
  }

  function findSeed01(
    r0: readonly [number, number],
    r1: readonly [number, number],
    tag: string
  ): string {
    for (let i = 0; i < 1000000; i += 1) {
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
    return { uid: body.user.uid, accessToken: body.accessToken };
  }

  async function createLetter(
    transportType: TransportType,
    clientRequestId: string,
    initJourney = true
  ): Promise<{ trackingNo: string; letterId: bigint }> {
    // 本文件所有信件的时间轴锚点统一为 T0（避免用例顺序影响 Journey 起始时刻）
    clock.advanceTo(T0);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/letters",
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: {
        recipient: bob.uid,
        content: `content ${clientRequestId}`,
        transportType,
        clientRequestId,
      },
    });
    const trackingNo = res.json().letter.trackingNo as string;
    if (initJourney) {
      const initRes = await app.inject({
        method: "POST",
        url: `/api/v1/letters/${trackingNo}/journey`,
        headers: { authorization: `Bearer ${alice.accessToken}` },
      });
      expect(initRes.statusCode).toBe(201);
    }
    const letter = await prisma.letter.findUniqueOrThrow({ where: { trackingNo } });
    // 冻结寄出时刻：位置插值的时间锚点（DISPATCHED 事实）必须稳定可复算
    await prisma.letter.update({ where: { id: letter.id }, data: { sentAt: new Date(T0) } });
    return { trackingNo, letterId: letter.id };
  }

  async function setSeed(letterId: bigint, seed: string): Promise<void> {
    await prisma.journey.update({ where: { letterId }, data: { simulationSeed: seed } });
  }

  async function advanceTo(letterId: bigint, atMs: number): Promise<void> {
    clock.advanceTo(atMs);
    await advanceJourneyToNow(prisma, letterId, clock);
  }

  function getMap(trackingNo: string, token: string) {
    return app.inject({
      method: "GET",
      url: `/api/v1/letters/${trackingNo}/map`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  async function mapOf(trackingNo: string, token: string): Promise<MapDto> {
    const res = await getMap(trackingNo, token);
    expect(res.statusCode).toBe(200);
    return res.json() as MapDto;
  }

  async function timelineOf(trackingNo: string, token: string): Promise<TimelineDto[]> {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/letters/${trackingNo}/timeline`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    return res.json().timeline as TimelineDto[];
  }

  async function journeyOf(letterId: bigint) {
    return prisma.journey.findUniqueOrThrow({ where: { letterId } });
  }

  async function firstLegOf(letterId: bigint) {
    const journey = await journeyOf(letterId);
    return prisma.transportLeg.findFirstOrThrow({
      where: { journeyId: journey.id, sequence: 0 },
    });
  }

  async function letterStatusOf(letterId: bigint): Promise<string> {
    const letter = await prisma.letter.findUniqueOrThrow({ where: { id: letterId } });
    return letter.status;
  }

  function coordsOf(nodeId: string): Point {
    const node = getStationNode(nodeId, GRAPH_VERSION);
    return { x: node.mapX, y: node.mapY };
  }

  function assertNoLeak(dto: MapDto): void {
    const json = JSON.stringify(dto);
    for (const forbidden of FORBIDDEN_SUBSTRINGS) {
      expect(json.includes(forbidden), `leaked "${forbidden}"`).toBe(false);
    }
  }

  function assertShape(dto: MapDto): void {
    expect(Object.keys(dto).sort()).toEqual([...ALLOWED_KEYS]);
    for (const fact of dto.facts) {
      expect(Object.keys(fact).sort()).toEqual([...ALLOWED_FACT_KEYS]);
      expect(Object.keys(fact.location).sort()).toEqual(["city", "province"]);
    }
    for (const station of [dto.origin, dto.destination]) {
      if (station !== null) {
        expect(Object.keys(station).sort()).toEqual(["city", "name", "province", "x", "y"]);
      }
    }
  }

  /** map facts 只能来自用户可见 Timeline（集合包含 + 上限 + 时间升序）。 */
  function assertFactsFromTimeline(dto: MapDto, timeline: TimelineDto[]): void {
    expect(dto.facts.length).toBeLessThanOrEqual(MAP_FACT_LIMIT);
    for (const fact of dto.facts) {
      const matched = timeline.some(
        (event) =>
          event.type === fact.type &&
          event.title === fact.title &&
          event.description === fact.description &&
          event.happenedAt === fact.happenedAt &&
          event.location.province === fact.location.province &&
          event.location.city === fact.location.city
      );
      expect(matched, `fact ${fact.type} 不在用户可见 Timeline 中`).toBe(true);
    }
    const times = dto.facts.map((f) => Date.parse(f.happenedAt));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  }

  /** HIDDEN cause 绝不能成为用户可见 FactNode（信件掉落 / 迷路 / 抢劫 / 严重事故）。 */
  const HIDDEN_FACT_TYPES = [
    "LETTER_DROPPED",
    "LOST_PATH",
    "ROBBERY",
    "SERIOUS_ACCIDENT",
    "REROUTED",
    "COURIER_DEAD",
  ] as const;

  function assertNoHiddenFactNode(dto: MapDto): void {
    for (const fact of dto.facts) {
      expect(
        (HIDDEN_FACT_TYPES as readonly string[]).includes(fact.type),
        `hidden fact node leaked: ${fact.type}`
      ).toBe(false);
    }
  }

  async function legsOf(letterId: bigint) {
    const journey = await journeyOf(letterId);
    return prisma.transportLeg.findMany({
      where: { journeyId: journey.id },
      orderBy: { sequence: "asc" },
    });
  }

  async function worldEventsOf(letterId: bigint) {
    const journey = await journeyOf(letterId);
    return prisma.worldEvent.findMany({
      where: { journeyId: journey.id },
      orderBy: { eventIndex: "asc" },
    });
  }

  async function worldTruthSnapshot(letterId: bigint) {
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
    const timeline = await prisma.timelineEvent.findMany({
      where: { letterId },
      orderBy: { sequence: "asc" },
    });
    return {
      letter: {
        status: letter.status,
        currentTransport: letter.currentTransport,
        sentAt: letter.sentAt?.getTime() ?? null,
        deliveredAt: letter.deliveredAt?.getTime() ?? null,
        updatedAt: letter.updatedAt.getTime(),
      },
      journey: {
        status: journey.status,
        anomalyType: journey.anomalyType,
        lastAdvancedAtSim: journey.lastAdvancedAtSim?.getTime() ?? null,
        lastMileReadyAtSim: journey.lastMileReadyAtSim?.getTime() ?? null,
        nextRandomDrawIndex: journey.nextRandomDrawIndex,
        nextWorldEventIndex: journey.nextWorldEventIndex,
        updatedAt: journey.updatedAt.getTime(),
      },
      legs: legs.map((leg) => ({
        sequence: leg.sequence,
        status: leg.status,
        fromNodeId: leg.fromNodeId,
        toNodeId: leg.toNodeId,
        transportType: leg.transportType,
        primaryEventIndex: leg.primaryEventIndex,
        primaryEventOutcome: leg.primaryEventOutcome,
        delaySeconds: leg.delaySeconds,
        startedAtSim: leg.startedAtSim?.getTime() ?? null,
        completedAtSim: leg.completedAtSim?.getTime() ?? null,
      })),
      events: events.map((event) => ({
        eventIndex: event.eventIndex,
        eventType: event.eventType,
        nodeId: event.nodeId,
        transportLegSequence: event.transportLegSequence,
        payload: event.payload,
        occurredAtSim: event.occurredAtSim.getTime(),
      })),
      timeline: timeline.map((event) => ({
        sourceKey: event.sourceKey,
        sequence: event.sequence,
        type: event.type,
        happenedAt: event.happenedAt.getTime(),
        visibleAt: event.visibleAt.getTime(),
        nodeId: event.nodeId,
        mapX: event.mapX,
        mapY: event.mapY,
      })),
    };
  }

  /** last-known 必须落在「已由独立 fact 公开的站点」上（不显示事故点 / 不推测遗失点）。 */
  function expectCoordsAmong(actual: Point, nodeIds: readonly string[]): void {
    const matched = nodeIds.some((nodeId) => {
      const expected = coordsOf(nodeId);
      return Math.abs(actual.x - expected.x) < 1e-6 && Math.abs(actual.y - expected.y) < 1e-6;
    });
    expect(matched, `lastKnownPosition 不在任何已确认站点上: ${JSON.stringify(actual)}`).toBe(true);
  }

  function expectCoords(actual: Point, nodeId: string, precision = 6): void {
    const expected = coordsOf(nodeId);
    expect(actual.x).toBeCloseTo(expected.x, precision);
    expect(actual.y).toBeCloseTo(expected.y, precision);
  }

  function clampRatio(value: number): number {
    return Math.min(MAP_APPROXIMATE_MAX_RATIO, Math.max(0, value));
  }

  function last<T>(items: readonly T[]): T | null {
    return items.length === 0 ? null : (items[items.length - 1] as T);
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

    const stamp = `${Date.now()}`;
    const region = (province: string, city: string, district: string) => ({
      password: "password123",
      nickname: "map-user",
      province,
      city,
      district,
    });
    alice = await registerUser({
      account: `mp_alice_${stamp}`,
      ...region("上海市", "上海市", "徐汇区"),
    });
    bob = await registerUser({
      account: `mp_bob_${stamp}`,
      ...region("北京市", "北京市", "海淀区"),
    });
    carol = await registerUser({
      account: `mp_carol_${stamp}`,
      ...region("广东省", "广州市", "天河区"),
    });
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it("shared MAP_DATA_BOUNDS / MAP_FIT 与生成资产一致，且包含全部站点锚点（地图映射契约）", () => {
    const root = resolveRepoRoot();
    const nodesPath = path.join(root, "data", "graphs", GRAPH_VERSION, "station_nodes.json");
    const nodes = JSON.parse(readFileSync(nodesPath, "utf8")) as Array<{
      id: string;
      mapX: number;
      mapY: number;
    }>;
    // Phase 8 Gate M5：fit 范围 = 行政边界底图 ∪ 站点锚点（底图严格大于站点范围）
    const districtsPath = path.join(root, "data", "maps", "china-districts.json");
    const districts = JSON.parse(readFileSync(districtsPath, "utf8")) as {
      bounds: { minX: number; maxX: number; minY: number; maxY: number };
      fit: { scale: number; tx: number; ty: number };
    };
    expect(districts.bounds).toEqual(MAP_DATA_BOUNDS);
    expect(districts.fit).toEqual(MAP_FIT);

    const xs = nodes.map((n) => n.mapX);
    const ys = nodes.map((n) => n.mapY);
    for (const node of nodes) {
      expect(node.mapX, `${node.id} mapX 越界`).toBeGreaterThanOrEqual(MAP_DATA_BOUNDS.minX);
      expect(node.mapX, `${node.id} mapX 越界`).toBeLessThanOrEqual(MAP_DATA_BOUNDS.maxX);
      expect(node.mapY, `${node.id} mapY 越界`).toBeGreaterThanOrEqual(MAP_DATA_BOUNDS.minY);
      expect(node.mapY, `${node.id} mapY 越界`).toBeLessThanOrEqual(MAP_DATA_BOUNDS.maxY);
    }
    // 行政边界底图必须严格超出站点范围（证明底图不是站点 hull 推导）
    expect(MAP_DATA_BOUNDS.minX).toBeLessThan(Math.min(...xs));
    expect(MAP_DATA_BOUNDS.maxX).toBeGreaterThan(Math.max(...xs));
    expect(MAP_DATA_BOUNDS.minY).toBeLessThan(Math.min(...ys));
    expect(MAP_DATA_BOUNDS.maxY).toBeGreaterThan(Math.max(...ys));
  });

  it("静态地图资产完全离线（无在线地图 / 瓦片 / geocoder 引用）", () => {
    const root = resolveRepoRoot();
    const assets = [
      path.join(root, "data", "maps", "china-map.svg"),
      path.join(root, "data", "maps", "china-districts.json"),
      path.join(root, "apps", "mobile", "src", "map", "chinaMapData.ts"),
    ];
    const banned = [
      "amap",
      "baidu",
      "qq.com",
      "google",
      "mapbox",
      "openstreetmap",
      "tile",
      "geocod",
      "api_key",
      "apikey",
    ];
    for (const asset of assets) {
      const content = readFileSync(asset, "utf8");
      const lower = content.toLowerCase();
      for (const word of banned) {
        expect(lower.includes(word), `${asset} 含在线地图引用 "${word}"`).toBe(false);
      }
      // 唯一允许出现的 URI 是 SVG 命名空间（不是网络请求）
      const urls = content.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
      for (const url of urls) {
        expect(url.startsWith("http://www.w3.org/")).toBe(true);
      }
    }
  });

  it("sender / recipient 同图；第三方 404；无 Journey 时安全空视图", async () => {
    const { trackingNo, letterId } = await createLetter("HORSE_RELAY", "mp-visibility");
    await advanceTo(letterId, T0);

    const senderView = await mapOf(trackingNo, alice.accessToken);
    const recipientView = await mapOf(trackingNo, bob.accessToken);
    expect(recipientView).toEqual(senderView);
    assertShape(senderView);
    assertNoLeak(senderView);

    // 同 now 重复请求（刷新频率无关）
    expect(await mapOf(trackingNo, alice.accessToken)).toEqual(senderView);

    const thirdParty = await getMap(trackingNo, carol.accessToken);
    expect(thirdParty.statusCode).toBe(404);
    const anonymous = await app.inject({
      method: "GET",
      url: `/api/v1/letters/${trackingNo}/map`,
    });
    expect(anonymous.statusCode).toBe(401);

    // 无 Journey：不崩溃、不泄漏、空几何（尚未启程）
    const { trackingNo: noJourney } = await createLetter("HORSE_RELAY", "mp-no-journey", false);
    const empty = await mapOf(noJourney, alice.accessToken);
    assertShape(empty);
    assertNoLeak(empty);
    expect(empty.origin).toBeNull();
    expect(empty.destination).toBeNull();
    expect(empty.completedPath).toEqual([]);
    expect(empty.remainingPath).toEqual([]);
    expect(empty.facts).toEqual([]);
    expect(empty.status).toBe("CREATED");
  });

  // -------------------------------------------------------------------------
  // 实线 / 虚线 / 大概位置（无 GPS、无 ETA）
  // -------------------------------------------------------------------------

  it("正常运输：已走实线 + 未走虚线 + 区间内大概位置（无精确 GPS / 无 ETA）", async () => {
    const { trackingNo, letterId } = await createLetter("HORSE_RELAY", "mp-normal");
    await setSeed(letterId, findSeed0(HC.NORMAL, "mp-normal"));
    await advanceTo(letterId, T0);

    const journey = await journeyOf(letterId);
    const leg0 = await firstLegOf(letterId);
    // 推进到第一条 leg 的 50%：尚未到达下一站
    const midMs = T0 + Math.floor((leg0.plannedDurationSeconds * 1000) / 2);
    await advanceTo(letterId, midMs);

    const view = await mapOf(trackingNo, alice.accessToken);
    const timeline = await timelineOf(trackingNo, alice.accessToken);
    assertShape(view);
    assertNoLeak(view);
    assertFactsFromTimeline(view, timeline);
    expect(["DISPATCHED", "IN_TRANSIT"]).toContain(view.status);

    const origin = view.origin;
    const destination = view.destination;
    if (origin === null || destination === null) throw new Error("origin/destination missing");
    expectCoords(origin, journey.originNodeId);
    expectCoords(destination, journey.destinationNodeId);

    // 已走实线：只由用户可见事实确认（此刻只有寄出事实）
    expect(view.completedPath.length).toBeGreaterThanOrEqual(1);
    const firstPoint = view.completedPath[0];
    if (firstPoint === undefined) throw new Error("empty completedPath");
    expectCoords(firstPoint, journey.originNodeId);
    const lastKnown = view.lastKnownPosition;
    if (lastKnown === null) throw new Error("lastKnownPosition null");
    expect(last(view.completedPath)).toEqual(lastKnown);

    // 未走虚线：从当前确报点继续，终点为最后一个点
    expect(view.remainingPath.length).toBeGreaterThanOrEqual(2);
    expect(view.remainingPath[0]).toEqual(lastKnown);
    const tail = last(view.remainingPath);
    if (tail === null) throw new Error("empty remainingPath");
    expectCoords(tail, journey.destinationNodeId);

    // 大概位置：按「用户可见出发时刻 → now」线性插值，且被 MAP_APPROXIMATE_MAX_RATIO 限制在区间内部
    const dispatched = timeline.find((event) => event.type === "DISPATCHED");
    if (dispatched === undefined) throw new Error("no DISPATCHED fact");
    const ratio = clampRatio(
      (midMs - Date.parse(dispatched.happenedAt)) / (leg0.plannedDurationSeconds * 1000)
    );
    expect(ratio).toBeGreaterThan(0);
    expect(ratio).toBeLessThan(1);
    const from = coordsOf(leg0.fromNodeId);
    const to = coordsOf(leg0.toNodeId);
    const approx = view.approximatePosition;
    if (approx === null) throw new Error("approximatePosition null");
    expect(Math.abs(approx.x - (from.x + (to.x - from.x) * ratio))).toBeLessThan(0.11);
    expect(Math.abs(approx.y - (from.y + (to.y - from.y) * ratio))).toBeLessThan(0.11);
    // 不是精确 GPS：不落在任一站点坐标上，也不越过下一站
    expect(approx).not.toEqual(from);
    expect(approx).not.toEqual(to);
    expect(Math.hypot(approx.x - from.x, approx.y - from.y)).toBeGreaterThan(0.2);
    expect(Math.hypot(approx.x - to.x, approx.y - to.y)).toBeGreaterThan(0.2);

    // 响应中不存在任何 ETA / 剩余时间 / 预测字段
    const keys = JSON.stringify(view);
    for (const banned of ["eta", "remainingTime", "countdown", "predict", "arriveAt"]) {
      expect(keys.toLowerCase().includes(banned.toLowerCase())).toBe(false);
    }
  });

  it("交付后：终态只表达确认结果、保持最后可确认位置，facts 只展示最新 5 个用户可见事实", async () => {
    const { trackingNo, letterId } = await createLetter("HAND_CARRY", "mp-delivered");
    await setSeed(letterId, findSeed0(HC.NORMAL, "mp-delivered"));
    await advanceTo(letterId, T0);
    await advanceTo(letterId, T0 + DAY_MS * 200);

    const view = await mapOf(trackingNo, alice.accessToken);
    const timeline = await timelineOf(trackingNo, alice.accessToken);
    assertShape(view);
    assertNoLeak(view);
    assertFactsFromTimeline(view, timeline);

    expect(view.status).toBe("DELIVERED");
    expect(view.approximatePosition).toBeNull();
    const lastKnown = view.lastKnownPosition;
    if (lastKnown === null) throw new Error("lastKnownPosition null");
    expectCoords(lastKnown, (await journeyOf(letterId)).destinationNodeId);
    expect(last(view.completedPath)).toEqual(lastKnown);
    // H1 回归：已送达（陆路多段）不得再返回剩余路线
    // （旧 bug：按 nodeId 找不到后继 leg 时 fallback 到整条路线 → 已走完的路线被当成未走）
    expect(view.remainingPath).toEqual([]);

    // 事实多于上限时按 §21 优先级截断：最高优先级事实必须被完整保留（上限内）
    expect(timeline.length).toBeGreaterThan(MAP_FACT_LIMIT);
    expect(view.facts.length).toBe(MAP_FACT_LIMIT);
    const importance = (type: string): number => TIMELINE_IMPORTANCE[type as TimelineEventType];
    const topPriority = Math.max(...timeline.map((event) => importance(event.type)));
    const topCount = timeline.filter((event) => importance(event.type) === topPriority).length;
    expect(view.facts.filter((fact) => importance(fact.type) === topPriority).length).toBe(
      Math.min(topCount, MAP_FACT_LIMIT)
    );
  });

  // -------------------------------------------------------------------------
  // 信使失联：最后确报
  // -------------------------------------------------------------------------

  it("信使失联：只保留最后确报、不再推测位置，未走路线仍为虚线；继续推进不产生新事实", async () => {
    const { trackingNo, letterId } = await createLetter("HAND_CARRY", "mp-missing");
    await setSeed(letterId, findSeed0(HC.COURIER_MISSING, "mp-missing"));
    await advanceTo(letterId, T0);
    const leg0 = await firstLegOf(letterId);
    // 事件时间 = leg 完成点（+1h 缓冲）
    const eventMs = T0 + leg0.plannedDurationSeconds * 1000 + HOUR_MS;
    await advanceTo(letterId, eventMs);

    const journey = await journeyOf(letterId);
    expect(journey.anomalyType).toBe("COURIER_MISSING");

    const view = await mapOf(trackingNo, alice.accessToken);
    assertShape(view);
    assertNoLeak(view);
    expect(view.status).toBe("COURIER_MISSING");
    // 失联后不再生成新的推测位置
    expect(view.approximatePosition).toBeNull();

    const lastKnown = view.lastKnownPosition;
    if (lastKnown === null) throw new Error("lastKnownPosition null");
    expect(last(view.completedPath)).toEqual(lastKnown);
    // 未走路线仍是虚线（仍可展示，但不得暗示当前位置）
    expect(view.remainingPath.length).toBeGreaterThanOrEqual(2);
    expect(view.remainingPath[0]).toEqual(lastKnown);

    // 继续推进（未到 7 天永久丢失）：最后确报 / 已走实线 / 事实集合均不变
    await advanceTo(letterId, eventMs + DAY_MS * 2);
    const later = await mapOf(trackingNo, alice.accessToken);
    assertNoLeak(later);
    expect(later.status).toBe("COURIER_MISSING");
    expect(later.approximatePosition).toBeNull();
    expect(later.lastKnownPosition).toEqual(lastKnown);
    expect(later.completedPath).toEqual(view.completedPath);
    expect(later.facts).toEqual(view.facts);
  });

  // -------------------------------------------------------------------------
  // 隐藏掉落：全局 HIDDEN
  // -------------------------------------------------------------------------

  it("隐藏掉落（internal LETTER_DROPPED）全局 HIDDEN：状态仍 IN_TRANSIT、无掉落范围 / 原因，不产生新事实", async () => {
    const { trackingNo, letterId } = await createLetter("HAND_CARRY", "mp-hidden-drop");
    // draw 0 = LETTER_DROPPED 主结果；draw 1 = 恢复窗口（本用例取「永不恢复」）
    await setSeed(letterId, findSeed01(HC.LETTER_DROPPED, DROP_WINDOW.NEVER, "mp-hidden-drop"));
    await advanceTo(letterId, T0);
    const leg0 = await firstLegOf(letterId);
    const dropMs = T0 + leg0.plannedDurationSeconds * 1000 + HOUR_MS;
    await advanceTo(letterId, dropMs);

    // 前置：内部世界真相确实是「已掉落」（否则本用例无意义）
    expect(await letterStatusOf(letterId)).toBe("LETTER_DROPPED");
    expect((await journeyOf(letterId)).anomalyType).toBe("LETTER_DROPPED");

    const view = await mapOf(trackingNo, alice.accessToken);
    const timeline = await timelineOf(trackingNo, alice.accessToken);
    assertShape(view);
    assertNoLeak(view);
    // 内部 LETTER_DROPPED 不得改变用户可见地图模式
    expect(view.status).toBe("IN_TRANSIT");
    assertFactsFromTimeline(view, timeline);
    // 无掉落范围 / 掉落原因 / 掉落坐标（V1 无 dropArea）
    const json = JSON.stringify(view);
    expect(json.includes("dropArea")).toBe(false);
    expect(json.includes("radius")).toBe(false);
    expect(json.includes("掉落")).toBe(false);
    expect(JSON.stringify(timeline).includes("掉落")).toBe(false);
    expect(timeline.some((event) => event.type === "LETTER_DROPPED")).toBe(false);

    // 隐藏掉落期间（7 天内）：不产生任何新的用户可确认事实，已走实线 / 最后确报也不变
    await advanceTo(letterId, dropMs + DAY_MS * 3);
    const stillHidden = await mapOf(trackingNo, alice.accessToken);
    assertNoLeak(stillHidden);
    expect(await letterStatusOf(letterId)).toBe("LETTER_DROPPED");
    expect(stillHidden.status).toBe("IN_TRANSIT");
    expect(stillHidden.facts).toEqual(view.facts);
    expect(stillHidden.completedPath).toEqual(view.completedPath);
    expect(stillHidden.lastKnownPosition).toEqual(view.lastKnownPosition);
    expect(stillHidden.remainingPath).toEqual(view.remainingPath);

    // 超过恢复窗口 → 只表达终态确认结果，仍不暴露掉落原因 / 掉落范围
    await advanceTo(letterId, dropMs + DAY_MS * 30);
    const terminal = await mapOf(trackingNo, alice.accessToken);
    assertShape(terminal);
    assertNoLeak(terminal);
    expect(terminal.status).toBe("PERMANENTLY_LOST");
    expect(terminal.approximatePosition).toBeNull();
    expect(terminal.lastKnownPosition).toEqual(view.lastKnownPosition);
  });

  // -------------------------------------------------------------------------
  // 隐藏 cause 等价：ROBBERY / LOST_PATH 不得单独改变地图
  // -------------------------------------------------------------------------

  it("ROBBERY（HIDDEN）不产生独有地图变化：无 COURIER_MISSING / 无掉落 / 状态仍 IN_TRANSIT", async () => {
    const { trackingNo, letterId } = await createLetter("HAND_CARRY", "mp-robbery");
    // draw 0 = ROBBERY（§28）；draw 1 = §32 二级分支 MISSING_DROPPED → 后台 LETTER_DROPPED；
    // draw 2 = 恢复窗口 NEVER → 隐藏期间不会因恢复产生新的用户可见事实
    await setSeed(
      letterId,
      findSeed012(HC.ROBBERY, ROBBERY_DROPPED, DROP_WINDOW.NEVER, "mp-robbery")
    );
    await advanceTo(letterId, T0);
    const before = await mapOf(trackingNo, alice.accessToken);

    const leg0 = await firstLegOf(letterId);
    const robberyMs = T0 + leg0.plannedDurationSeconds * 1000 + HOUR_MS;
    await advanceTo(letterId, robberyMs);

    // 前置：世界真相确实走了 ROBBERY → MISSING_DROPPED（否则本用例无意义）
    const worldEvents = await worldEventsOf(letterId);
    expect(worldEvents.some((event) => event.eventType === "ROBBERY")).toBe(true);
    expect(await letterStatusOf(letterId)).toBe("LETTER_DROPPED");
    expect((await journeyOf(letterId)).anomalyType).toBe("LETTER_DROPPED");

    const view = await mapOf(trackingNo, alice.accessToken);
    const timeline = await timelineOf(trackingNo, alice.accessToken);
    assertShape(view);
    assertNoLeak(view);
    assertFactsFromTimeline(view, timeline);
    assertNoHiddenFactNode(view);

    // 用户可见状态与「相同可见事实」的正常世界一致（仍为在途，无独有视觉模式）
    expect(view.status).toBe("IN_TRANSIT");
    // HIDDEN cause 不得生成任何用户可确认事实（尤其不得出现 COURIER_MISSING）
    expect(timeline.some((event) => event.type === "COURIER_MISSING")).toBe(false);
    // 路线与事实只能单调追加 / 保留，绝不被隐藏 cause 改写
    expect(view.completedPath.slice(0, before.completedPath.length)).toEqual(before.completedPath);
    expect(view.lastKnownPosition).toEqual(last(view.completedPath));
    expect(view.origin).toEqual(before.origin);
    expect(view.destination).toEqual(before.destination);
    expect(view.remainingPath[0]).toEqual(view.lastKnownPosition);
    expect(view.facts.length).toBeGreaterThanOrEqual(before.facts.length);

    // 隐藏期间继续推进：除「按冻结计划前进的位置」外，可见地图完全不变
    // （无新事实 / 无 status 变化 / 无路线改写 / 无掉落信息）
    await advanceTo(letterId, robberyMs + DAY_MS * 3);
    const stillHidden = await mapOf(trackingNo, alice.accessToken);
    assertNoLeak(stillHidden);
    assertNoHiddenFactNode(stillHidden);
    expect(await letterStatusOf(letterId)).toBe("LETTER_DROPPED");
    expect({ ...stillHidden, approximatePosition: null }).toEqual({
      ...view,
      approximatePosition: null,
    });
    const prevPosition = view.approximatePosition;
    const nextPosition = stillHidden.approximatePosition;
    if (prevPosition === null || nextPosition === null) throw new Error("position null");
    const nextNode = stillHidden.remainingPath[1];
    if (nextNode === undefined) throw new Error("no next planned node");
    const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
    // 位置仍沿冻结计划单调前进（既不因隐藏 cause 冻结，也不跳变到路线外）
    expect(distance(nextPosition, nextNode)).toBeLessThanOrEqual(
      distance(prevPosition, nextNode) + 1e-6
    );
  });

  it("LOST_PATH（HIDDEN cause）只暴露 canonical COURIER_MISSING：approximatePosition=null、无 cause 泄漏", async () => {
    const { trackingNo, letterId } = await createLetter("HAND_CARRY", "mp-lost-path");
    await setSeed(letterId, findSeed0(HC.LOST_PATH, "mp-lost-path"));
    await advanceTo(letterId, T0);
    const leg0 = await firstLegOf(letterId);
    const eventMs = T0 + leg0.plannedDurationSeconds * 1000 + HOUR_MS;
    await advanceTo(letterId, eventMs);

    // 世界真相：HIDDEN cause = LOST_PATH 事件 + canonical COURIER_MISSING 异常
    const worldEvents = await worldEventsOf(letterId);
    expect(worldEvents.some((event) => event.eventType === "LOST_PATH")).toBe(true);
    expect((await journeyOf(letterId)).anomalyType).toBe("COURIER_MISSING");
    expect(await letterStatusOf(letterId)).toBe("COURIER_MISSING");
    // 用户可见 Timeline 里绝不允许出现 LOST_PATH
    const rawTimeline = await prisma.timelineEvent.findMany({ where: { letterId } });
    expect(rawTimeline.some((event) => String(event.type) === "LOST_PATH")).toBe(false);

    const view = await mapOf(trackingNo, alice.accessToken);
    const timeline = await timelineOf(trackingNo, alice.accessToken);
    assertShape(view);
    assertNoLeak(view);
    assertFactsFromTimeline(view, timeline);
    assertNoHiddenFactNode(view);

    // 只表达 canonical 失联事实，不表达 HIDDEN cause
    expect(view.status).toBe("COURIER_MISSING");
    expect(view.approximatePosition).toBeNull();
    expect(timeline.filter((event) => event.type === "COURIER_MISSING").length).toBe(1);
    const json = JSON.stringify({ view, timeline });
    for (const banned of ["LOST_PATH", "迷路", "cause"]) {
      expect(json.includes(banned), `leaked "${banned}"`).toBe(false);
    }

    // 失联后只保留最后确报，未走路线仍为虚线
    const lastKnown = view.lastKnownPosition;
    if (lastKnown === null) throw new Error("lastKnownPosition null");
    expect(last(view.completedPath)).toEqual(lastKnown);
    expect(view.remainingPath[0]).toEqual(lastKnown);
    const tail = last(view.remainingPath);
    if (tail === null) throw new Error("empty remainingPath");
    expectCoords(tail, (await journeyOf(letterId)).destinationNodeId);
  });

  it("reroute：completedPath 永不重写、remainingPath 采用重建路线（B → X → Y → D）", async () => {
    const { trackingNo, letterId } = await createLetter("HAND_CARRY", "mp-reroute");
    await setSeed(letterId, findSeed0(HC.REROUTE, "mp-reroute"));
    await advanceTo(letterId, T0);

    const leg0 = await firstLegOf(letterId);
    const midMs = T0 + Math.floor((leg0.plannedDurationSeconds * 1000) / 2);
    await advanceTo(letterId, midMs);
    const before = await mapOf(trackingNo, alice.accessToken);
    assertNoLeak(before);

    // 改道发生在第一条 leg 完成点
    const eventMs = T0 + leg0.plannedDurationSeconds * 1000 + HOUR_MS;
    await advanceTo(letterId, eventMs);

    // 推进到重建后的第二条 leg 完成点：产生新的已确认到达事实
    const journey = await journeyOf(letterId);
    const legs = await legsOf(letterId);
    const worldEvents = await worldEventsOf(letterId);
    // 世界真相：该 leg 抽中 REROUTE 并真的重建了剩余路线（REROUTED 事件 + legs 数增加）
    const firstPlannedLeg = legs[0];
    if (firstPlannedLeg === undefined) throw new Error("no legs");
    expect(firstPlannedLeg.primaryEventOutcome).toBe("REROUTE");
    expect(worldEvents.some((event) => event.eventType === "REROUTED")).toBe(true);
    expect(journey.anomalyType).toBeNull();
    const firstLeg = legs[0];
    const secondLeg = legs[1];
    if (firstLeg === undefined || secondLeg === undefined) throw new Error("legs missing");
    // 重建后的路线必须从第一条 leg 的完成点继续（A→B 之后是 B→X→Y→D）
    expect(firstLeg.toNodeId).toBe(secondLeg.fromNodeId);
    await advanceTo(letterId, eventMs + secondLeg.plannedDurationSeconds * 1000 + HOUR_MS);

    const after = await mapOf(trackingNo, alice.accessToken);
    const timeline = await timelineOf(trackingNo, alice.accessToken);
    assertShape(after);
    assertNoLeak(after);
    assertFactsFromTimeline(after, timeline);
    assertNoHiddenFactNode(after);

    // completed history 永不重写：旧 prefix 必须完整保留在新增 history 之前
    expect(after.completedPath.length).toBeGreaterThan(before.completedPath.length);
    expect(after.completedPath.slice(0, before.completedPath.length)).toEqual(before.completedPath);
    // completedPath 只来自用户可见事实：origin + 每一个已确认到达
    const arrivedCount = timeline.filter((event) => event.type === "ARRIVED_STATION").length;
    expect(arrivedCount).toBeGreaterThanOrEqual(2);
    expect(after.completedPath.length).toBe(1 + arrivedCount);
    expect(after.completedPath[0]).toEqual(coordsOf(journey.originNodeId));

    const lastKnown = after.lastKnownPosition;
    if (lastKnown === null) throw new Error("lastKnownPosition null");
    expect(last(after.completedPath)).toEqual(lastKnown);
    expectCoords(lastKnown, secondLeg.toNodeId);

    // remainingPath = 重建后剩余路线（当前确认节点 → 终点，虚线），逐点校验
    expect(after.remainingPath[0]).toEqual(lastKnown);
    const expectedRemaining: Point[] = [{ x: lastKnown.x, y: lastKnown.y }];
    for (const leg of legs.filter((item) => item.sequence > secondLeg.sequence)) {
      expectedRemaining.push(coordsOf(leg.toNodeId));
    }
    expect(after.remainingPath.length).toBe(expectedRemaining.length);
    after.remainingPath.forEach((point, index) => {
      const expected = expectedRemaining[index];
      if (expected === undefined) throw new Error("unexpected extra point");
      expect(point.x).toBeCloseTo(expected.x, 6);
      expect(point.y).toBeCloseTo(expected.y, 6);
    });
    const destinationTail = last(after.remainingPath);
    if (destinationTail === null) throw new Error("empty remainingPath");
    expectCoords(destinationTail, journey.destinationNodeId);
  });

  it("PIGEON 正常运输：单段直连不产生伪事实、无 ETA、位置只来自已确认事实", async () => {
    const { trackingNo, letterId } = await createLetter("PIGEON", "mp-pigeon-normal");
    await setSeed(letterId, findSeed0(PIGEON_NORMAL, "mp-pigeon-normal"));
    await advanceTo(letterId, T0);

    const journey = await journeyOf(letterId);
    const legs = await prisma.transportLeg.findMany({
      where: { journeyId: journey.id },
      orderBy: { sequence: "asc" },
    });
    // PIGEON 单段直连（同站时允许零 Leg，此用例为跨城直达）
    expect(legs.length).toBe(1);
    const leg0 = legs[0];
    if (leg0 === undefined) throw new Error("leg0 missing");

    const before = await mapOf(trackingNo, alice.accessToken);
    assertShape(before);
    assertNoLeak(before);
    expect(before.completedPath.length).toBe(1);
    expect(before.completedPath[0]).toEqual(coordsOf(journey.originNodeId));
    expect(before.remainingPath.length).toBe(2);
    expect(before.remainingPath[0]).toEqual(coordsOf(journey.originNodeId));
    expect(before.remainingPath[1]).toEqual(coordsOf(journey.destinationNodeId));

    // 中途：position 为区间插值（不等于任何端点），路线不变
    const mid = await (async () => {
      await advanceTo(letterId, T0 + Math.floor((leg0.plannedDurationSeconds * 1000) / 2));
      return mapOf(trackingNo, alice.accessToken);
    })();
    assertNoLeak(mid);
    expect(mid.approximatePosition).not.toBeNull();
    expect(mid.remainingPath).toEqual(before.remainingPath);
    expect(mid.completedPath).toEqual(before.completedPath);

    // 到达目的站（OUT_FOR_DELIVERY）：completedPath 完整、位置锚定目的站、无 ETA
    const arrivalMs = T0 + leg0.plannedDurationSeconds * 1000 + HOUR_MS;
    await advanceTo(letterId, arrivalMs);
    const arrived = await mapOf(trackingNo, alice.accessToken);
    const timeline = await timelineOf(trackingNo, alice.accessToken);
    assertShape(arrived);
    assertNoLeak(arrived);
    assertFactsFromTimeline(arrived, timeline);
    assertNoHiddenFactNode(arrived);
    expect(arrived.status).toBe("OUT_FOR_DELIVERY");
    expect(arrived.completedPath.length).toBe(1 + 1);
    expect(arrived.completedPath[1]).toEqual(coordsOf(journey.destinationNodeId));
    expect(arrived.approximatePosition).toEqual(coordsOf(journey.destinationNodeId));
    // 全部 leg 已完成（仅剩最后一公里，无规划几何）→ 不再返回剩余路线
    expect(arrived.remainingPath).toEqual([]);

    // DELIVERED（last-mile 结束）：completedPath 完整、approximatePosition = null、终点为 anchor
    await advanceTo(letterId, arrivalMs + LAST_MILE_DURATION_SECONDS * 1000 + HOUR_MS);
    const delivered = await mapOf(trackingNo, alice.accessToken);
    const deliveredTimeline = await timelineOf(trackingNo, alice.accessToken);
    assertShape(delivered);
    assertNoLeak(delivered);
    assertFactsFromTimeline(delivered, deliveredTimeline);
    assertNoHiddenFactNode(delivered);
    expect(delivered.status).toBe("DELIVERED");
    expect(delivered.approximatePosition).toBeNull();
    expect(delivered.completedPath.length).toBe(1 + 1);
    expect(delivered.completedPath[1]).toEqual(coordsOf(journey.destinationNodeId));
    expect(delivered.lastKnownPosition).toEqual(coordsOf(journey.destinationNodeId));
    expect(delivered.remainingPath).toEqual([]);
    expect(deliveredTimeline.some((event) => event.type === "DELIVERED")).toBe(true);
  });

  it("PIGEON 严重事故 → DESTROYED：只表达终态确认结果，不暴露事故点 / cause", async () => {
    const { trackingNo, letterId } = await createLetter("PIGEON", "mp-pigeon-destroyed");
    await setSeed(letterId, findSeed0(PIGEON_ACCIDENT, "mp-pigeon-destroyed"));
    await advanceTo(letterId, T0);
    const before = await mapOf(trackingNo, alice.accessToken);

    const leg0 = await firstLegOf(letterId);
    await advanceTo(letterId, T0 + leg0.plannedDurationSeconds * 1000 + HOUR_MS);

    const view = await mapOf(trackingNo, alice.accessToken);
    const timeline = await timelineOf(trackingNo, alice.accessToken);
    assertShape(view);
    assertNoLeak(view);
    assertFactsFromTimeline(view, timeline);
    assertNoHiddenFactNode(view);

    expect(await letterStatusOf(letterId)).toBe("DESTROYED");
    expect(view.status).toBe("DESTROYED");
    expect(view.approximatePosition).toBeNull();
    // 不显示事故点：last-known 只能落在「已由独立 safe fact 公开过」的站点上（寄出点 / 已确认到达点），
    // 不允许出现事故现场坐标或非站点插值点
    const journey = await journeyOf(letterId);
    const legs = await legsOf(letterId);
    const lastKnown = view.lastKnownPosition;
    if (lastKnown === null) throw new Error("lastKnownPosition null");
    expectCoordsAmong(lastKnown, [journey.originNodeId, ...legs.map((leg) => leg.toNodeId)]);
    // 历史永不被隐藏 cause 改写
    expect(view.completedPath.slice(0, before.completedPath.length)).toEqual(before.completedPath);
    expect(view.lastKnownPosition).toEqual(last(view.completedPath));
    // 已确认到达过目的站（事故发生在 leg 完成点）：事实必须与 completedPath 数量自洽
    const arrivedStops = timeline.filter((event) => event.type === "ARRIVED_STATION").length;
    expect(view.completedPath.length).toBe(1 + arrivedStops);
    expect(timeline.some((event) => event.type === "DESTROYED")).toBe(true);
    const json = JSON.stringify({ view, timeline });
    for (const banned of ["SERIOUS_ACCIDENT", "事故", "ROBBERY", "抢劫", "death", "死亡"]) {
      expect(json.includes(banned), `leaked "${banned}"`).toBe(false);
    }
  });

  // -------------------------------------------------------------------------
  // Map GET 纯度 / refresh-frequency independence
  // -------------------------------------------------------------------------

  it("Map GET 纯度：100 次刷新零 World Truth / 游标变化，DTO 完全一致", async () => {
    const { trackingNo, letterId } = await createLetter("HORSE_RELAY", "mp-purity");
    await setSeed(letterId, findSeed0(HC.NORMAL, "mp-purity"));
    await advanceTo(letterId, T0);
    const leg0 = await firstLegOf(letterId);
    await advanceTo(letterId, T0 + Math.floor((leg0.plannedDurationSeconds * 1000) / 3));

    // 第一次 GET 允许触发 lazy materialization；此后必须完全只读
    const first = await mapOf(trackingNo, alice.accessToken);
    const snapshotBefore = await worldTruthSnapshot(letterId);

    for (let i = 0; i < 100; i += 1) {
      const res = await getMap(trackingNo, alice.accessToken);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(first);
    }

    const snapshotAfter = await worldTruthSnapshot(letterId);
    expect(snapshotAfter).toEqual(snapshotBefore);
    const after = await worldTruthSnapshot(letterId);
    expect(after.journey.nextRandomDrawIndex).toBe(snapshotBefore.journey.nextRandomDrawIndex);
    expect(after.journey.nextWorldEventIndex).toBe(snapshotBefore.journey.nextWorldEventIndex);
    expect(after.events.length).toBe(snapshotBefore.events.length);
    expect(after.timeline.length).toBe(snapshotBefore.timeline.length);
    // Simulation 未被推进：GET 不改变 lastAdvancedAtSim
    expect(after.journey.lastAdvancedAtSim).toEqual(snapshotBefore.journey.lastAdvancedAtSim);
  });

  it("Map DTO 真实响应扫描：递归键 + 原始 JSON 全文均不含 internal / HIDDEN / 隐私 / 预测字段", async () => {
    const { trackingNo, letterId } = await createLetter("HORSE_RELAY", "mp-real-scan");
    await setSeed(letterId, findSeed0(HC.NORMAL, "mp-real-scan"));
    await advanceTo(letterId, T0);
    const leg0 = await firstLegOf(letterId);
    await advanceTo(letterId, T0 + Math.floor((leg0.plannedDurationSeconds * 1000) / 3));

    const res = await getMap(trackingNo, alice.accessToken);
    expect(res.statusCode).toBe(200);
    // 安全契约必须扫描**真实 authenticated 响应**（旧测试只扫手写 sample，无法发现真实响应问题）
    const raw = res.body;
    const dto = res.json() as Record<string, unknown>;

    const bannedKeys = new Set([
      "id",
      "letterId",
      "journeyId",
      "worldEventId",
      "eventIndex",
      "sourceKey",
      "sequence",
      "simulationSeed",
      "rulesVersion",
      "graphVersion",
      "payload",
      "anomalyType",
      "primaryEventOutcome",
      "primaryEventIndex",
      "nextRandomDrawIndex",
      "nextWorldEventIndex",
      "lat",
      "lng",
      "latitude",
      "longitude",
      "eta",
      "remainingSeconds",
      "dropArea",
      "uncertaintyRadiusKm",
      "readState",
      "openedAt",
    ]);
    const keys = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) walk(item);
        return;
      }
      if (typeof value !== "object" || value === null) return;
      for (const [key, child] of Object.entries(value)) {
        keys.add(key);
        walk(child);
      }
    };
    walk(dto);
    expect(keys.size).toBeGreaterThan(0);
    for (const key of keys) {
      expect(bannedKeys.has(key), `Map DTO 含禁止键 "${key}"`).toBe(false);
    }

    // 原始 JSON 全文扫描：HIDDEN cause / 掉落 / 内部字段名不得以任何形式出现
    const bannedTokens = [
      "LETTER_DROPPED",
      "LOST_PATH",
      "ROBBERY",
      "SERIOUS_ACCIDENT",
      "REROUTED",
      "COURIER_DEAD",
      "dropArea",
      "drop",
      "anomaly",
      "cause",
      "payload",
      "simulationSeed",
      "rulesVersion",
      "graphVersion",
      "eventIndex",
      "primaryEvent",
      "nextRandomDrawIndex",
      "nextWorldEventIndex",
      "lat",
      "lng",
      "latitude",
      "longitude",
      "eta",
      "countdown",
      "prediction",
      "remainingSeconds",
      "readState",
      "openedAt",
      "trackingNo",
    ];
    for (const token of bannedTokens) {
      expect(raw.includes(token), `Map 原始响应泄漏 "${token}"`).toBe(false);
    }

    // 真实响应形状必须与白名单契约一致（无多余 / 缺失字段）
    assertShape(dto as unknown as MapDto);
  });
});
