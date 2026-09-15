import type { PrismaClient, Journey, TransportLeg } from "@yishu/db";
import type { TransportType, JourneyStatus, TransportLegStatus } from "@yishu/shared";
import { plannedDurationSeconds } from "@yishu/shared";
import { resolveStationForRegion, planRoute, getStationNode } from "./stationGraph.js";
import { resolveDisplayStationPoint } from "./map-station-point.js";

// 供路由层统一捕获处理（类型化错误）
export { NoStationMappingError, UnknownGraphVersionError } from "./stationGraph.js";

/**
 * Journey 初始化 service（Phase 4 Prompt §20–§24）。
 *
 * 职责：
 * 1. 查询 Letter，确认尚无 Journey；且 Letter 必须处于 CREATED（Phase 4 Final Gate HIGH-2）
 * 2. 继承 Letter 冻结值：rulesVersion / graphVersion / simulationSeed；
 *    规划必须使用这些版本（图按 graphVersion 加载、时长按 rulesVersion 换算），未知版本明确拒绝
 * 3. region → station（origin/target，按 graphVersion）
 * 4. 按 TransportType：PIGEON 直连 / ground Dijkstra
 * 5. 事务原子创建 Journey + TransportLeg[]（原子；任何失败 rollback）
 * 6. 初始化：completedPath=[]、remainingPath=full route（动态计算，见 toPathViews）
 *
 * 并发幂等：Journey.letterId UNIQUE 作为最终竞态保障；
 * 先查后建 + 唯一约束 + P2002 重读现有 Journey（created:false），保证同一 Letter 只能有 1 个 Journey。
 */

export class JourneyAlreadyExistsError extends Error {
  constructor(public readonly letterId: bigint) {
    super("journey_already_exists");
    this.name = "JourneyAlreadyExistsError";
  }
}

export class LetterNotFoundError extends Error {
  constructor(public readonly letterId: bigint) {
    super("letter_not_found");
    this.name = "LetterNotFoundError";
  }
}

/** Letter 不是 CREATED 状态，禁止初始化（Phase 4 Final Gate HIGH-2）。 */
export class LetterNotCreatedError extends Error {
  constructor(
    public readonly letterId: bigint,
    public readonly status: string
  ) {
    super("letter_not_created");
    this.name = "LetterNotCreatedError";
  }
}

/** 事务内条件更新失败（状态在检查后已被其他事务改变）→ 整体回滚，路由映射为 409。 */
export class LetterStatusConflictError extends Error {
  constructor(public readonly letterId: bigint) {
    super("letter_status_conflict");
    this.name = "LetterStatusConflictError";
  }
}

export interface InitializedJourney {
  journey: Journey;
  legs: TransportLeg[];
  /** 完整路线节点 id 序列（remainingPath 初始值）。 */
  fullRouteNodeIds: string[];
  /** 本次是否由本请求创建；P2002 重读现有时 false（并发幂等 → HTTP 200）。 */
  created: boolean;
}

/**
 * 初始化某封信的 Journey。
 * @param prisma 数据库客户端
 * @param letterId Letter 内部 id
 * @returns 已创建的 Journey 与 Legs（含 created 语义）
 * @throws LetterNotFoundError / JourneyAlreadyExistsError / LetterNotCreatedError /
 *         NoStationMappingError / UnknownGraphVersionError / UnknownRulesVersionError
 */
export async function initializeJourney(
  prisma: PrismaClient,
  letterId: bigint
): Promise<InitializedJourney> {
  // 1. 查询 Letter（含现有 Journey，确认幂等）
  const letter = await prisma.letter.findUnique({
    where: { id: letterId },
    include: { journey: true },
  });
  if (!letter) {
    throw new LetterNotFoundError(letterId);
  }
  // 幂等优先：已有 Journey → 直接返回现有（不因状态变化而误报 409）
  if (letter.journey) {
    throw new JourneyAlreadyExistsError(letterId);
  }
  // 冻结版本语义：Letter 上的 graphVersion/rulesVersion 必须真实参与规划
  const graphVersion = letter.graphVersion;
  const rulesVersion = letter.rulesVersion;
  // 只有 CREATED 可初始化；终态/中间态一律拒绝（Phase 4 Final Gate HIGH-2）
  if (letter.status !== "CREATED") {
    throw new LetterNotCreatedError(letterId, letter.status);
  }

  // 2. region → station（按 graphVersion）
  const originNodeId = resolveStationForRegion(
    { province: letter.originProvince, city: letter.originCity, district: letter.originDistrict },
    graphVersion
  );
  const destinationNodeId = resolveStationForRegion(
    { province: letter.targetProvince, city: letter.targetCity, district: letter.targetDistrict },
    graphVersion
  );

  // 3. 规划路线（PIGEON / ground；按 graphVersion）
  const transportType = letter.initialTransport as TransportType;
  const route = planRoute({ graphVersion, originNodeId, destinationNodeId, transportType });

  // 4. 构建 Leg 数据（sequence 从 0 开始；时长按 rulesVersion）
  const legData = route.edges.map((edge, index) => ({
    sequence: index,
    fromNodeId: edge.from,
    toNodeId: edge.to,
    transportType: edge.transportType,
    distanceKm: edge.distanceKm,
    plannedDurationSeconds: plannedDurationSeconds(
      rulesVersion,
      edge.transportType,
      edge.distanceKm
    ),
    status: "PLANNED" as TransportLegStatus,
  }));

  // 5. 事务原子创建 Journey + Legs + 条件更新 Letter → DISPATCHED
  let created = true;
  let txResult: { journey: Journey; legs: TransportLeg[] };
  try {
    txResult = await prisma.$transaction(async (tx) => {
      const journey = await tx.journey.create({
        data: {
          letterId: letter.id,
          originNodeId,
          destinationNodeId,
          status: "PLANNED" as JourneyStatus,
          rulesVersion,
          graphVersion,
          simulationSeed: letter.simulationSeed,
          totalDistanceKm: route.totalDistanceKm,
        },
      });
      await tx.transportLeg.createMany({
        data: legData.map((leg) => ({ ...leg, journeyId: journey.id })),
      });
      // 条件更新：只有仍为 CREATED 才允许 → DISPATCHED（防止终态 Letter 状态倒退）
      const updated = await tx.letter.updateMany({
        where: { id: letter.id, status: "CREATED" },
        data: { status: "DISPATCHED" },
      });
      if (updated.count === 0) {
        throw new LetterStatusConflictError(letter.id);
      }
      const legs = await tx.transportLeg.findMany({
        where: { journeyId: journey.id },
        orderBy: { sequence: "asc" },
      });
      return { journey, legs: legs as TransportLeg[] };
    });
  } catch (err) {
    if (err instanceof LetterStatusConflictError) throw err;
    // 并发竞态：另一请求已抢先创建（letterId UNIQUE 冲突）→ 返回现有 Journey（幂等 200）
    if (isLetterUniqueConflict(err)) {
      created = false;
      const existing = await prisma.journey.findUniqueOrThrow({
        where: { letterId: letter.id },
        include: { legs: { orderBy: { sequence: "asc" } } },
      });
      txResult = { journey: existing, legs: existing.legs as TransportLeg[] };
    } else {
      throw err;
    }
  }

  return {
    journey: txResult.journey,
    legs: txResult.legs,
    fullRouteNodeIds: route.nodes,
    created,
  };
}

/** 判断是否为 Journey.letterId 唯一约束冲突（Prisma P2002）。
 * 兼容 Prisma 7 driver adapter 的错误形状（meta.target 或 meta.driverAdapterError.cause.constraint.fields）。
 * 字段名可能带 PostgreSQL 转义引号（如 `"letterId"`），统一去引号规范化后匹配。
 * 只识别 letterId 约束；无法确认时重新抛出（不把其他唯一冲突误当幂等）。 */
function isLetterUniqueConflict(err: unknown): boolean {
  const e = err as {
    code?: string;
    meta?: {
      target?: unknown;
      driverAdapterError?: { cause?: { constraint?: { fields?: string[] } } };
    };
  };
  if (e?.code !== "P2002") return false;
  const norm = (s: string): string => s.replace(/"/g, "");
  const target = e.meta?.target;
  if (Array.isArray(target) && target.map(norm).includes("letterId")) return true;
  if (typeof target === "string" && norm(target) === "letterId") return true;
  const driverFields = e.meta?.driverAdapterError?.cause?.constraint?.fields;
  if (Array.isArray(driverFields) && driverFields.map(norm).includes("letterId")) return true;
  return false; // 无法确认约束 → 不按 letterId 冲突处理，向上抛出
}

/**
 * 计算已完成 / 剩余路径（Phase 4 Prompt §23）。
 * 数据设计支持动态计算：completedPath 来自已 COMPLETED 的 legs（本阶段全 PLANNED），
 * remainingPath 来自未完成的 legs。
 * 本阶段所有 Leg 初始 PLANNED → completedPath=[]、remainingPath=full route。
 * completedPath 永远不可被重写（reroute 时只改 remainingPath）。
 */
export function toPathViews(
  legs: TransportLeg[],
  fullRouteNodeIds: string[]
): { completedPath: string[]; remainingPath: string[] } {
  const completedNodeIds: string[] = [];
  const remainingNodeIds: string[] = [];
  let prevCompleted: string | null = null;
  for (const leg of [...legs].sort((a, b) => a.sequence - b.sequence)) {
    if (leg.status === "COMPLETED") {
      // 链首补 from，之后补 to
      if (prevCompleted === null) completedNodeIds.push(leg.fromNodeId);
      completedNodeIds.push(leg.toNodeId);
      prevCompleted = leg.toNodeId;
    } else {
      if (remainingNodeIds.length === 0) remainingNodeIds.push(leg.fromNodeId);
      remainingNodeIds.push(leg.toNodeId);
    }
  }
  // 回退：无 legs 时返回完整路线作为 remaining
  if (legs.length === 0) {
    return { completedPath: [], remainingPath: fullRouteNodeIds };
  }
  return { completedPath: completedNodeIds, remainingPath: remainingNodeIds };
}

/** 取节点公共名称（用户可见 station name，不暴露 internal id；按 graphVersion）。 */
export function stationName(nodeId: string, graphVersion: string): string {
  return getStationNode(nodeId, graphVersion).name;
}

/**
 * 取路线节点公共视图（name + mapX/mapY，不含 internal id；按 graphVersion）。
 *
 * 坐标经 `map-station-point.ts` 解析（冻结图坐标 + 版本化显示修正），与 Map DTO / Timeline
 * 保持同一显示位置；显示修正不改变路由与距离。
 */
export function publicRouteNodes(
  nodeIds: string[],
  graphVersion: string
): Array<{
  name: string;
  mapX: number;
  mapY: number;
}> {
  return nodeIds.map((id) => {
    const n = getStationNode(id, graphVersion);
    const point = resolveDisplayStationPoint(id, graphVersion);
    return { name: n.name, mapX: point.x, mapY: point.y };
  });
}
