import type { FastifyInstance } from "fastify";
import { NoRouteError } from "@yishu/routing";
import {
  LAST_MILE_DURATION_SECONDS,
  firstMileDurationSeconds,
  TRANSPORT_TYPES,
  plannedDurationSeconds,
  nextStationEstimateSchema,
  transportEstimatesSchema,
  toPublicLetterStatus,
} from "@yishu/shared";
import { transportEstimateRequestSchema, trackingNoParamSchema } from "../schemas/letter.js";
import {
  getDefaultGraphVersion,
  resolveStationForRegion,
  planRoute,
  NoStationMappingError,
  UnknownGraphVersionError,
} from "../lib/stationGraph.js";
import { materializeVisibleTimeline } from "../lib/timeline.js";
import { projectNextStationEstimate } from "../lib/map-view.js";
import { assertDistrictTransportRegion } from "../lib/district-transport-validation.js";
import { assertServiceRegion } from "../lib/service-area.js";

export async function estimateRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/transport-estimates",
    {
      preHandler: [app.authenticate],
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const { recipient: query } = transportEstimateRequestSchema.parse(req.body);
      const sender = await app.prisma.user.findUnique({ where: { uid: req.user.sub } });
      if (!sender) return reply.code(401).send({ error: "unauthorized" });
      const recipient = await app.prisma.user.findUnique({
        where: /^[1-9][0-9]{7}$/.test(query) ? { uid: query } : { account: query.toLowerCase() },
      });
      if (!recipient) return reply.code(404).send({ error: "user_not_found" });
      const blocked = await app.prisma.block.findUnique({
        where: {
          blockerId_blockedId: {
            blockerId: recipient.id,
            blockedId: sender.id,
          },
        },
      });
      if (blocked) return reply.code(403).send({ error: "blocked_by_recipient" });
      try {
        assertServiceRegion(sender);
        assertServiceRegion(recipient);
        const graphVersion = getDefaultGraphVersion();
        if (app.config.NEW_LETTER_RULES_VERSION === "1.1") {
          assertDistrictTransportRegion(sender, graphVersion, "origin");
          assertDistrictTransportRegion(recipient, graphVersion, "destination");
        }
        const originNodeId = resolveStationForRegion(sender, graphVersion);
        const destinationNodeId = resolveStationForRegion(recipient, graphVersion);
        const estimates = TRANSPORT_TYPES.flatMap((transportType) => {
          try {
            const route = planRoute({
              graphVersion,
              originNodeId,
              destinationNodeId,
              transportType,
            });
            const durationSeconds = route.edges.reduce(
              (total, edge) =>
                total +
                plannedDurationSeconds(
                  app.config.NEW_LETTER_RULES_VERSION,
                  edge.transportType,
                  edge.distanceKm
                ),
              LAST_MILE_DURATION_SECONDS +
                firstMileDurationSeconds(app.config.NEW_LETTER_RULES_VERSION)
            );
            return [
              {
                transportType,
                distanceKm: Math.round(route.totalDistanceKm * 10) / 10,
                durationSeconds: Math.ceil(durationSeconds),
              },
            ];
          } catch (error) {
            if (error instanceof NoRouteError) return [];
            throw error;
          }
        });
        return reply.send(transportEstimatesSchema.parse({ estimates }));
      } catch (error) {
        if (error instanceof NoStationMappingError)
          return reply.code(422).send({ error: "no_station_mapping" });
        if (error instanceof UnknownGraphVersionError)
          return reply.code(422).send({ error: "unknown_graph_version" });
        throw error;
      }
    }
  );

  app.get(
    "/letters/:trackingNo/estimate",
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const { trackingNo } = trackingNoParamSchema.parse(req.params);
      const user = await app.prisma.user.findUnique({ where: { uid: req.user.sub } });
      if (!user) return reply.code(401).send({ error: "unauthorized" });
      const letter = await app.prisma.letter.findUnique({
        where: { trackingNo },
        include: { journey: { include: { legs: { orderBy: { sequence: "asc" } } } } },
      });
      if (!letter || letter.senderId !== user.id)
        return reply.code(404).send({ error: "letter_not_found" });
      const nowMs = app.simulationClock.now();
      const visibleEvents = await materializeVisibleTimeline(app.prisma, letter.id, nowMs);
      const estimate = projectNextStationEstimate({
        graphVersion: letter.graphVersion,
        publicStatus: toPublicLetterStatus(letter.status),
        nowMs,
        visibleEvents,
        originStationReadyAtMs: letter.journey?.originStationReadyAtSim?.getTime() ?? null,
        originNodeId: letter.journey?.originNodeId ?? null,
        destinationNodeId: letter.journey?.destinationNodeId ?? null,
        plannedLegs:
          letter.journey?.legs.map((leg) => ({
            sequence: leg.sequence,
            fromNodeId: leg.fromNodeId,
            toNodeId: leg.toNodeId,
            plannedDurationSeconds: leg.plannedDurationSeconds,
          })) ?? [],
      });
      return reply.send(nextStationEstimateSchema.parse(estimate));
    }
  );
}
