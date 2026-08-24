import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Journey, TransportLeg, Letter } from "@yishu/db";
import {
  initializeJourney,
  JourneyAlreadyExistsError,
  LetterNotFoundError,
  LetterNotCreatedError,
  LetterStatusConflictError,
  NoStationMappingError,
  UnknownGraphVersionError,
  toPathViews,
  publicRouteNodes,
  stationName,
} from "../lib/journey.js";
import { UnknownRulesVersionError } from "@yishu/shared";
import { trackingNoParamSchema } from "../schemas/letter.js";
import type { TransportType } from "@yishu/shared";

interface LetterWithJourney extends Letter {
  journey?: (Journey & { legs: TransportLeg[] }) | null;
}

/** Journey 用户可见视图（安全序列化，对应 Phase 4 Prompt §26/§28）。 */
interface JourneyView {
  origin: { name: string };
  destination: { name: string };
  transportType: TransportType;
  totalDistanceKm: number;
  status: string;
  // 路线节点（公共 station name + 地图坐标，不含 internal id）
  routeNodes: Array<{ name: string; mapX: number; mapY: number }>;
  completedPath: Array<{ name: string; mapX: number; mapY: number }>;
  remainingPath: Array<{ name: string; mapX: number; mapY: number }>;
  legs: Array<{
    sequence: number;
    from: { name: string };
    to: { name: string };
    transportType: TransportType;
    distanceKm: number;
    status: string;
  }>;
}

/**
 * 构建 Journey 用户可见视图（严格不返回 internal id / simulationSeed / plannedDuration / ETA）。
 * transportType 必须来自 Letter 冻结的 initialTransport（Phase 4 Final Gate HIGH-3：
 * 同站点 PIGEON 零 Leg 时不得用 HAND_CARRY 兜底，否则与冻结事实不一致）。
 */
function toJourneyView(
  journey: Journey & { legs: TransportLeg[] },
  fullRouteNodeIds: string[],
  transportType: TransportType,
  graphVersion: string
): JourneyView {
  const { completedPath, remainingPath } = toPathViews(journey.legs, fullRouteNodeIds);
  return {
    origin: { name: stationName(journey.originNodeId, graphVersion) },
    destination: { name: stationName(journey.destinationNodeId, graphVersion) },
    transportType,
    totalDistanceKm: journey.totalDistanceKm,
    status: journey.status,
    routeNodes: publicRouteNodes(fullRouteNodeIds, graphVersion),
    completedPath: publicRouteNodes(completedPath, graphVersion),
    remainingPath: publicRouteNodes(remainingPath, graphVersion),
    legs: journey.legs
      .slice()
      .sort((a, b) => a.sequence - b.sequence)
      .map((leg) => ({
        sequence: leg.sequence,
        from: { name: stationName(leg.fromNodeId, graphVersion) },
        to: { name: stationName(leg.toNodeId, graphVersion) },
        transportType: leg.transportType,
        distanceKm: leg.distanceKm,
        status: leg.status,
      })),
  };
}

export async function journeyRoutes(app: FastifyInstance): Promise<void> {
  // 初始化 Journey（仅 Sender；幂等 201/200，并发安全）
  app.post(
    "/letters/:trackingNo/journey",
    { preHandler: [app.authenticate] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { trackingNo } = trackingNoParamSchema.parse(req.params);
      const user = await req.server.prisma.user.findUnique({ where: { uid: req.user.sub } });
      if (!user) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      const letter = (await req.server.prisma.letter.findUnique({
        where: { trackingNo },
        include: { journey: { include: { legs: { orderBy: { sequence: "asc" } } } } },
      })) as LetterWithJourney | null;
      if (!letter || letter.senderId !== user.id) {
        // Sender 专属；第三方/Recipient 一律 404，不泄露 Letter 存在
        return reply.code(404).send({ error: "letter_not_found" });
      }

      let result;
      try {
        result = await initializeJourney(req.server.prisma, letter.id);
      } catch (err) {
        if (err instanceof JourneyAlreadyExistsError) {
          // 已存在 → 返回现有 Journey（200，幂等语义）
          const existing = await req.server.prisma.journey.findUniqueOrThrow({
            where: { letterId: letter.id },
            include: { legs: { orderBy: { sequence: "asc" } } },
          });
          const fullRouteNodeIds = [existing.originNodeId, ...existing.legs.map((l) => l.toNodeId)];
          const view = toJourneyView(
            existing,
            fullRouteNodeIds,
            letter.initialTransport,
            letter.graphVersion
          );
          return reply.send({ journey: view });
        }
        if (err instanceof LetterNotFoundError) {
          return reply.code(404).send({ error: "letter_not_found" });
        }
        if (err instanceof LetterNotCreatedError) {
          return reply.code(409).send({ error: "letter_not_created", status: err.status });
        }
        if (err instanceof LetterStatusConflictError) {
          // 状态在检查后被并发事务改变（如被置为终态）→ 明确业务冲突 409，而非 500
          return reply.code(409).send({ error: "letter_status_conflict" });
        }
        if (err instanceof NoStationMappingError) {
          return reply.code(422).send({ error: "no_station_mapping", detail: err.detail });
        }
        if (err instanceof UnknownGraphVersionError) {
          return reply
            .code(422)
            .send({ error: "unknown_graph_version", version: err.graphVersion });
        }
        if (err instanceof UnknownRulesVersionError) {
          return reply
            .code(422)
            .send({ error: "unknown_rules_version", version: err.rulesVersion });
        }
        throw err;
      }

      // 计算 full route（origin → ... → destination）用于 routeNodes
      const fullRouteNodeIds = [result.journey.originNodeId, ...result.legs.map((l) => l.toNodeId)];
      const view = toJourneyView(
        { ...result.journey, legs: result.legs } as Journey & { legs: TransportLeg[] },
        fullRouteNodeIds,
        letter.initialTransport,
        letter.graphVersion
      );
      return reply.code(result.created ? 201 : 200).send({ journey: view });
    }
  );

  // 查询 Journey（Sender / Recipient 均可；同视图；第三方 404）
  app.get(
    "/letters/:trackingNo/journey",
    { preHandler: [app.authenticate] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { trackingNo } = trackingNoParamSchema.parse(req.params);
      const user = await req.server.prisma.user.findUnique({ where: { uid: req.user.sub } });
      if (!user) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      const letter = (await req.server.prisma.letter.findUnique({
        where: { trackingNo },
        include: { journey: { include: { legs: { orderBy: { sequence: "asc" } } } } },
      })) as LetterWithJourney | null;
      if (!letter || (letter.senderId !== user.id && letter.recipientId !== user.id)) {
        return reply.code(404).send({ error: "letter_not_found" });
      }
      if (!letter.journey) {
        return reply.code(404).send({ error: "journey_not_initialized" });
      }
      const fullRouteNodeIds = [
        letter.journey.originNodeId,
        ...letter.journey.legs.map((l) => l.toNodeId),
      ];
      const view = toJourneyView(
        letter.journey as Journey & { legs: TransportLeg[] },
        fullRouteNodeIds,
        letter.initialTransport,
        letter.graphVersion
      );
      return reply.send({ journey: view });
    }
  );
}
