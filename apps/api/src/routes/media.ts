import { randomUUID } from "node:crypto";
import multipart from "@fastify/multipart";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import sharp from "sharp";
import {
  inspectImage,
  MAX_IMAGE_BYTES,
  MediaError,
  readEncryptedMedia,
  removeMediaFile,
  STAGED_MEDIA_TTL_MS,
  toMediaView,
  writeEncryptedMedia,
} from "../lib/media.js";
import { toUserPublicView } from "../lib/user-view.js";

const idSchema = z.object({ id: z.string().uuid() });

export async function mediaRoutes(app: FastifyInstance): Promise<void> {
  await app.register(multipart, {
    limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 0, parts: 1 },
  });

  async function upload(
    req: FastifyRequest,
    reply: FastifyReply,
    purpose: "LETTER_IMAGE" | "AVATAR"
  ) {
    const user = await app.prisma.user.findUnique({ where: { uid: req.user.sub } });
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    const pendingWhere = {
      ownerId: user.id,
      letterId: null,
      avatarFor: { is: null },
      createdAt: { gt: new Date(Date.now() - STAGED_MEDIA_TTL_MS) },
    };
    // Reject a full temporary-image quota before consuming a large multipart body.
    if ((await app.prisma.mediaAsset.count({ where: pendingWhere })) >= 36) {
      return reply.code(429).send({ error: "too_many_pending_images" });
    }
    let buffer: Buffer | undefined;
    for await (const part of req.parts()) {
      if (part.type !== "file") throw new MediaError("invalid_image", 415);
      buffer = await part.toBuffer();
    }
    if (!buffer) throw new MediaError("invalid_image", 415);
    const imageBuffer = buffer;
    const dimensions = await inspectImage(buffer);
    const id = randomUUID();
    const directory = app.config.MEDIA_STORAGE_DIR;
    await writeEncryptedMedia(directory, id, buffer, app.config.CONTENT_ENCRYPTION_KEY);
    const result = await app.prisma
      .$transaction(async (tx) => {
        // Serialize upload, claim, deletion and avatar replacement for this owner.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`media:${user.id}`}, 0))`;
        const cutoff = new Date(Date.now() - STAGED_MEDIA_TTL_MS);
        // Expiration is handled in bounded background batches, not on the upload path.
        const expired: Array<{ id: string }> = [];
        const staged = await tx.mediaAsset.count({
          where: {
            ownerId: user.id,
            letterId: null,
            avatarFor: { is: null },
            createdAt: { gt: cutoff },
          },
        });
        if (staged >= 36) throw new MediaError("too_many_pending_images", 429);
        const asset = await tx.mediaAsset.create({
          data: { id, ownerId: user.id, purpose, ...dimensions, byteSize: imageBuffer.length },
        });
        if (purpose === "AVATAR") {
          const previous = await tx.user.findUniqueOrThrow({
            where: { id: user.id },
            select: { avatarId: true },
          });
          const updated = await tx.user.update({ where: { id: user.id }, data: { avatarId: id } });
          if (previous.avatarId) {
            await tx.mediaAsset.delete({ where: { id: previous.avatarId } });
            expired.push({ id: previous.avatarId });
          }
          return { asset, user: updated, expired };
        }
        return { asset, user: null, expired };
      })
      .catch(async (error: unknown) => {
        await removeMediaFile(directory, id).catch(() => {
          app.log.warn({ errorClass: "MediaCleanupError" }, "media_cleanup_failed");
        });
        throw error;
      });
    for (const expired of result.expired) {
      // Committed metadata wins; a cleanup failure must not delete the new image.
      await removeMediaFile(directory, expired.id).catch(() => {
        app.log.warn({ errorClass: "MediaCleanupError" }, "media_cleanup_failed");
      });
    }
    return reply
      .code(201)
      .send(
        result.user
          ? { user: toUserPublicView(result.user), image: toMediaView(result.asset) }
          : { image: toMediaView(result.asset) }
      );
  }

  const uploadOptions = {
    onRequest: [app.authenticate],
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  };
  app.post("/media/images", uploadOptions, (req, reply) => upload(req, reply, "LETTER_IMAGE"));
  app.post("/users/me/avatar", uploadOptions, (req, reply) => upload(req, reply, "AVATAR"));

  app.get("/media/:id", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { id } = idSchema.parse(req.params);
    const { size } = z.object({ size: z.enum(["preview"]).optional() }).parse(req.query);
    const user = await app.prisma.user.findUnique({ where: { uid: req.user.sub } });
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    const asset = await app.prisma.mediaAsset.findUnique({
      where: { id },
      include: { letter: true, avatarFor: true },
    });
    const readable =
      asset &&
      (asset.avatarFor !== null ||
        (asset.letter
          ? asset.letter.senderId === user.id ||
            (asset.letter.recipientId === user.id && asset.letter.status === "DELIVERED")
          : asset.ownerId === user.id));
    if (!readable || !asset) return reply.code(404).send({ error: "media_not_found" });
    const original = await readEncryptedMedia(
      app.config.MEDIA_STORAGE_DIR,
      id,
      app.config.CONTENT_ENCRYPTION_KEY
    );
    const buffer =
      size === "preview"
        ? await sharp(original)
            .rotate()
            .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
            .webp({ quality: 82 })
            .toBuffer()
        : original;
    return reply
      .header("cache-control", "private, no-store")
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'")
      .type(size === "preview" ? "image/webp" : asset.mimeType)
      .send(buffer);
  });

  app.delete("/media/:id", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { id } = idSchema.parse(req.params);
    const user = await app.prisma.user.findUnique({ where: { uid: req.user.sub } });
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    const removed = await app.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`media:${user.id}`}, 0))`;
      const where = { id, ownerId: user.id, letterId: null, avatarFor: { is: null } };
      if (!(await tx.mediaAsset.findFirst({ where, select: { id: true } }))) return { count: 0 };
      await removeMediaFile(app.config.MEDIA_STORAGE_DIR, id);
      return tx.mediaAsset.deleteMany({ where });
    });
    if (!removed.count) return reply.code(404).send({ error: "media_not_found" });
    return reply.code(204).send();
  });
}
