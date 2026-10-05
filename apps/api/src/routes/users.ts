import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { searchQuerySchema, blockUidParamSchema } from "../schemas/user.js";
import { toUserPublicView } from "../lib/user-view.js";
import { acquireBlockLetterPairLock } from "../lib/blockLock.js";
import { z } from "zod";
import { nicknameSchema, regionSchema } from "../schemas/auth.js";
import { updateProfile } from "../lib/profile.js";
import { NoStationMappingError } from "../lib/stationGraph.js";

const profileSchema = z
  .object({
    nickname: nicknameSchema.optional(),
    region: z
      .object({
        province: regionSchema,
        city: regionSchema,
        district: regionSchema,
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((input) => input.nickname !== undefined || input.region !== undefined);

export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.patch("/users/me", { preHandler: [app.authenticate] }, async (req, reply) => {
    const input = profileSchema.parse(req.body);
    try {
      const user = await updateProfile(app.prisma, req.user.sub, input, app.simulationClock);
      if (!user) return reply.code(404).send({ error: "user_not_found" });
      return reply.send({ user: toUserPublicView(user) });
    } catch (error) {
      if (error instanceof NoStationMappingError)
        return reply.code(400).send({ error: "no_station_mapping" });
      throw error;
    }
  });
  // 当前用户（规范 §72）：Access Token sub 为对外 UID，用 UID 查询，不依赖 internal id。
  app.get("/users/me", { preHandler: [app.authenticate] }, async (req, reply) => {
    const user = await req.server.prisma.user.findUnique({ where: { uid: req.user.sub } });
    if (!user) {
      return reply.code(404).send({ error: "user_not_found" });
    }
    return reply.send({ user: toUserPublicView(user) });
  });

  // 用户搜索（完整 account 或 8 位 UID 精准确认收件人，规范 §7）
  app.get(
    "/users/search",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { q } = searchQuerySchema.parse(req.query);
      const isUid = /^[1-9][0-9]{7}$/.test(q);
      let user;
      if (isUid) {
        user = await req.server.prisma.user.findUnique({ where: { uid: q } });
      } else {
        user = await req.server.prisma.user.findUnique({
          where: { account: q.toLowerCase() },
        });
      }
      if (!user) {
        return reply.code(404).send({ error: "user_not_found" });
      }
      // V1：精准确认，返回单个安全用户对象（不返回 results 列表）
      return reply.send(toUserPublicView(user));
    }
  );

  // 拉黑用户（规范 §10）
  app.post(
    "/users/:uid/block",
    { preHandler: [app.authenticate] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { uid } = blockUidParamSchema.parse(req.params);
      // 当前用户来自 Access Token 的对外 UID
      const blocker = await req.server.prisma.user.findUnique({
        where: { uid: req.user.sub },
      });
      if (!blocker) {
        return reply.code(401).send({ error: "unauthorized" });
      }

      const target = await req.server.prisma.user.findUnique({ where: { uid } });
      if (!target) {
        return reply.code(404).send({ error: "user_not_found" });
      }
      if (target.id === blocker.id) {
        return reply.code(400).send({ error: "cannot_block_self" });
      }

      // 幂等：已存在则返回成功；使用 advisory lock 与 Letter 创建协调并发（规范 §10）
      await req.server.prisma.$transaction(async (tx) => {
        await acquireBlockLetterPairLock(tx, blocker.id, target.id);
        await tx.block.upsert({
          where: {
            blockerId_blockedId: { blockerId: blocker.id, blockedId: target.id },
          },
          update: {},
          create: { blockerId: blocker.id, blockedId: target.id },
        });
      });
      return reply.send({ blocked: toUserPublicView(target) });
    }
  );
}
