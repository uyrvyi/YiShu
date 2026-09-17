import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { registerPushDevice, unregisterPushDevice } from "@yishu/domain/push";

const tokenSchema = z
  .string()
  .max(256)
  .regex(/^(Expo|Exponent)PushToken\[[A-Za-z0-9_-]+\]$/);
const registerSchema = z
  .object({ token: tokenSchema, platform: z.enum(["ios", "android"]) })
  .strict();
const unregisterSchema = z.object({ token: tokenSchema }).strict();

export async function pushRoutes(app: FastifyInstance): Promise<void> {
  app.post("/push/register", { preHandler: [app.authenticate] }, async (req, reply) => {
    const body = registerSchema.parse(req.body);
    const user = await app.prisma.user.findUnique({
      where: { uid: req.user.sub },
      select: { id: true },
    });
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    await registerPushDevice(
      app.prisma,
      user.id,
      body.token,
      body.platform,
      app.simulationClock.now()
    );
    return { ok: true };
  });
  app.delete("/push/unregister", { preHandler: [app.authenticate] }, async (req, reply) => {
    const body = unregisterSchema.parse(req.body);
    const user = await app.prisma.user.findUnique({
      where: { uid: req.user.sub },
      select: { id: true },
    });
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    await unregisterPushDevice(app.prisma, user.id, body.token);
    return { ok: true };
  });
}
