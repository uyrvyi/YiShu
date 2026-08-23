import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { searchQuerySchema, blockUidParamSchema } from "../schemas/user.js";
import { toUserPublicView } from "../lib/user-view.js";

export async function userRoutes(app: FastifyInstance): Promise<void> {
  // 当前用户（规范 §72）：Access Token sub 为对外 UID，用 UID 查询，不依赖 internal id。
  app.get("/users/me", { preHandler: [app.authenticate] }, async (req, reply) => {
    const user = await req.server.prisma.user.findUnique({ where: { uid: req.user.sub } });
    if (!user) {
      return reply.code(404).send({ error: "user_not_found" });
    }
    return reply.send({ user: toUserPublicView(user) });
  });

  // 用户搜索（完整 account 或 8 位 UID 精准确认收件人，规范 §7）
  app.get("/users/search", async (req, reply) => {
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
  });

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

      // 幂等：已存在则返回成功（重复 block 行为正确）
      await req.server.prisma.block.upsert({
        where: {
          blockerId_blockedId: { blockerId: blocker.id, blockedId: target.id },
        },
        update: {},
        create: { blockerId: blocker.id, blockedId: target.id },
      });
      return reply.send({ blocked: toUserPublicView(target) });
    }
  );
}
