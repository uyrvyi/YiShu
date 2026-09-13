import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { trackingNoParamSchema } from "../schemas/letter.js";
import { materializeVisibleTimeline, toTimelineEventView } from "../lib/timeline.js";

/**
 * Timeline 路由（Phase 7；对应开发规范 §72 / §75）。
 *
 * ```http
 * GET /api/v1/letters/:trackingNo/timeline
 * ```
 *
 * - Sender / Recipient 均可访问，且**返回完全相同的用户可见运输事实**（阶段规划 Phase 7 双方一致）。
 * - 第三方一律 404（不泄露 Letter 是否存在）。
 * - 只返回 `visibleAt <= simulationClock.now()` 的事件；DELAYED 事件在可见前服务端不返回。
 * - 只提供 GET：用户不能主动改变世界事实或 visibility（禁止 POST /reveal /confirm /advance）。
 */
export async function timelineRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/letters/:trackingNo/timeline",
    { preHandler: [app.authenticate] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { trackingNo } = trackingNoParamSchema.parse(req.params);
      const user = await req.server.prisma.user.findUnique({ where: { uid: req.user.sub } });
      if (!user) {
        return reply.code(401).send({ error: "unauthorized" });
      }

      const letter = await req.server.prisma.letter.findUnique({ where: { trackingNo } });
      // 权限：仅 Sender / Recipient；第三方 404（与现有 Letter 可见性规则一致）
      if (!letter || (letter.senderId !== user.id && letter.recipientId !== user.id)) {
        return reply.code(404).send({ error: "letter_not_found" });
      }

      // SimulationClock 是唯一业务时钟（禁止 Date.now() 决定可见性）
      const nowMs = req.server.simulationClock.now();
      const events = await materializeVisibleTimeline(req.server.prisma, letter.id, nowMs);
      return reply.send({ timeline: events.map(toTimelineEventView) });
    }
  );
}
