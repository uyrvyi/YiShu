import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { routeMapViewSchema, toPublicLetterStatus } from "@yishu/shared";
import { trackingNoParamSchema } from "../schemas/letter.js";
import { materializeVisibleTimeline } from "../lib/timeline.js";
import { projectRouteMap, type PlannedLegSegment } from "../lib/map-view.js";

/**
 * Map 路由（Phase 8；对应开发规范 §74 + Phase 8 可见性冻结）。
 *
 * ```http
 * GET /api/v1/letters/:trackingNo/map
 * ```
 *
 * - Sender / Recipient 均可访问且**返回完全相同的图**（阶段规划 Phase 8 Gate：sender/recipient 同图）。
 * - 第三方一律 404（不泄露 Letter 是否存在）。
 * - 只返回用户可见状态（`toPublicLetterStatus`，内部 `LETTER_DROPPED` → `IN_TRANSIT`）与
 *   用户可见 Timeline 事实；**不返回** `dropArea` / 掉落范围 / 掉落原因 / exact GPS / ETA /
 *   任何 internal id；无在线地图 / 瓦片 / geocoder（§14 / §18 / Phase 8 冻结）。
 * - 只提供 GET：用户不能主动改路线 / 运输方式 / 位置。
 */
export async function mapRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/letters/:trackingNo/map",
    { preHandler: [app.authenticate] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { trackingNo } = trackingNoParamSchema.parse(req.params);
      const user = await req.server.prisma.user.findUnique({ where: { uid: req.user.sub } });
      if (!user) {
        return reply.code(401).send({ error: "unauthorized" });
      }

      const letter = await req.server.prisma.letter.findUnique({
        where: { trackingNo },
        include: { journey: { include: { legs: { orderBy: { sequence: "asc" } } } } },
      });
      // 权限：仅 Sender / Recipient；第三方 404（与 Timeline / Journey 一致）
      if (!letter || (letter.senderId !== user.id && letter.recipientId !== user.id)) {
        return reply.code(404).send({ error: "letter_not_found" });
      }

      // SimulationClock 是唯一业务时钟（禁止 Date.now() 决定可见性与位置）
      const nowMs = req.server.simulationClock.now();
      // 事实来源：用户可见 Timeline（幂等物化；绝不读 WorldEvent payload / Journey anomaly）
      const visibleEvents = await materializeVisibleTimeline(req.server.prisma, letter.id, nowMs);

      const journey = letter.journey ?? null;
      // 计划路线几何：只取 (sequence, from, to, plannedDurationSeconds)；不读 leg.status /
      // anomaly → 隐藏掉落无法通过本路径改变用户可见地图模式。
      const plannedLegs: PlannedLegSegment[] =
        journey === null
          ? []
          : journey.legs.map((leg) => ({
              sequence: leg.sequence,
              fromNodeId: leg.fromNodeId,
              toNodeId: leg.toNodeId,
              plannedDurationSeconds: leg.plannedDurationSeconds,
            }));

      const view = projectRouteMap({
        graphVersion: letter.graphVersion,
        publicStatus: toPublicLetterStatus(letter.status),
        nowMs,
        visibleEvents,
        originNodeId: journey?.originNodeId ?? null,
        destinationNodeId: journey?.destinationNodeId ?? null,
        plannedLegs,
      });

      // 输出净化：strip-parse 保证任何意外多出的内部字段在序列化前被剥离（共享 schema 非 passthrough）。
      return reply.send(routeMapViewSchema.parse(view));
    }
  );
}
