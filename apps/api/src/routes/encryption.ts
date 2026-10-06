import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { identityRegistrationSchema, verifyRegistration } from "@yishu/shared/e2ee";

export async function encryptionRoutes(app: FastifyInstance): Promise<void> {
  const options = {
    preHandler: [app.authenticate],
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  };
  app.get("/encryption/me", options, async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const user = await app.prisma.user.findUnique({
      where: { uid: req.user.sub },
      include: { encryptionIdentity: true },
    });
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    return { registration: user.encryptionIdentity?.registration ?? null };
  });
  app.get("/encryption/keys/:uid", options, async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const { uid } = z.object({ uid: z.string().regex(/^[1-9][0-9]{7}$/) }).parse(req.params);
    const user = await app.prisma.user.findUnique({
      where: { uid },
      include: { encryptionIdentity: true },
    });
    if (!user?.encryptionIdentity)
      return reply.code(404).send({ error: "e2ee_recipient_not_ready" });
    return {
      identity: identityRegistrationSchema.parse(user.encryptionIdentity.registration).identity,
    };
  });
  app.post("/encryption/me", options, async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const record = identityRegistrationSchema.parse(req.body);
    if (record.identity.uid !== req.user.sub || !verifyRegistration(record))
      return reply.code(400).send({ error: "e2ee_invalid_identity" });
    const user = await app.prisma.user.findUnique({ where: { uid: req.user.sub } });
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    const result = await app.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`profile:${user.id}`}, 0))`;
      const existing = await tx.encryptionIdentity.findUnique({ where: { userId: user.id } });
      if (existing)
        return (
          JSON.stringify(identityRegistrationSchema.parse(existing.registration)) ===
          JSON.stringify(record)
        );
      await tx.encryptionIdentity.create({
        data: { userId: user.id, keyId: record.identity.keyId, registration: record },
      });
      return true;
    });
    return result
      ? reply.send({ identity: record.identity })
      : reply.code(409).send({ error: "e2ee_identity_already_exists" });
  });
}
