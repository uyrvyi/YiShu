import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  Letter,
  MediaAsset,
  RecipientState,
  SenderState,
  Journey,
  TransportLeg,
} from "@yishu/db";
import { MediaError, STAGED_MEDIA_TTL_MS } from "../lib/media.js";
import { encryptContent, decryptContent } from "../lib/crypto.js";
import { generateTrackingNo } from "../lib/trackingNo.js";
import { createWithTrackingRetry, MAX_TRACKING_RETRY } from "../lib/trackingNoRetry.js";
import { computeRequestFingerprint, generateSimulationSeed } from "../lib/fingerprint.js";
import { acquireBlockLetterPairLock } from "../lib/blockLock.js";
import {
  createLetterSchema,
  trackingNoParamSchema,
  listLettersQuerySchema,
} from "../schemas/letter.js";
import type { LetterStatus } from "@yishu/shared";
import {
  toSenderLetterView,
  toRecipientLetterView,
  DELIVERED,
  type LetterView,
} from "../lib/letter-view.js";
import { stationName } from "../lib/journey.js";
import { getDefaultGraphVersion } from "../lib/stationGraph.js";
import {
  assertDistrictTransportRegion,
  InvalidTransportRegionError,
} from "../lib/district-transport-validation.js";
import { E2EE_VERSION, identityRegistrationSchema, verifyLetter } from "@yishu/shared/e2ee";

interface LetterWithState extends Letter {
  recipientState?: RecipientState | null;
  senderState?: SenderState | null;
  images?: MediaAsset[];
}

/** 收件人已拉黑发送者时的业务错误。 */
class BlockedByRecipientError extends Error {
  constructor() {
    super("blocked_by_recipient");
    this.name = "BlockedByRecipientError";
  }
}

export async function letterRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("Cache-Control", "private, no-store");
    return payload;
  });
  // 创建信件（对应规范 §8 / §73）
  app.post(
    "/letters",
    {
      preHandler: [app.authenticate],
      onRequest: async (req, reply) => {
        if (
          app.config.NODE_ENV === "production" &&
          req.headers["x-yishu-content-protocol"] !== E2EE_VERSION
        )
          return reply.code(409).send({ error: "e2ee_required" });
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = createLetterSchema.parse(req.body);
      const sender = await req.server.prisma.user.findUnique({ where: { uid: req.user.sub } });
      if (!sender) {
        return reply.code(401).send({ error: "unauthorized" });
      }

      // 精准解析收件人（account 或 8 位 UID）
      const recipient = await req.server.prisma.user.findUnique({
        where: /^[1-9][0-9]{7}$/.test(body.recipient)
          ? { uid: body.recipient }
          : { account: body.recipient.toLowerCase() },
      });
      if (!recipient) {
        return reply.code(404).send({ error: "user_not_found" });
      }

      // 请求指纹（规范化 recipient UID + content + transportType，规范 §67）
      const fingerprint = computeRequestFingerprint({
        recipientUid: recipient.uid,
        content: body.e2ee ? JSON.stringify(body.e2ee) : (body.content ?? ""),
        transportType: body.transportType,
        imageIds: body.imageIds,
        writtenAt: body.writtenAt,
      });

      // 幂等：senderId + clientRequestId 唯一；同 key 不同 body → 409（规范 §67）
      const existing = await req.server.prisma.letter.findUnique({
        where: {
          senderId_clientRequestId: {
            senderId: sender.id,
            clientRequestId: body.clientRequestId,
          },
        },
        include: {
          senderState: true,
          recipientState: true,
          images: { orderBy: { position: "asc" } },
        },
      });
      if (existing) {
        if (existing.requestFingerprint !== fingerprint) {
          return reply.code(409).send({ error: "idempotency_conflict" });
        }
        return reply.send({
          letter: toSenderLetterView(existing, decrypt(existing, req), existing.senderState),
        });
      }

      if (app.config.NODE_ENV === "production" && !body.e2ee)
        return reply.code(409).send({ error: "e2ee_required" });

      // 加密正文（规范 §48）
      const encrypted = body.e2ee
        ? { ciphertext: "", iv: "", authTag: "" }
        : encryptContent(body.content ?? "", req.server.config.CONTENT_ENCRYPTION_KEY);
      if (
        body.e2ee &&
        (!verifyLetter(body.e2ee) ||
          body.e2ee.sender.uid !== sender.uid ||
          body.e2ee.recipient.uid !== recipient.uid ||
          body.e2ee.clientRequestId !== body.clientRequestId ||
          body.e2ee.transportType !== body.transportType ||
          JSON.stringify(body.e2ee.imageIds) !== JSON.stringify(body.imageIds ?? []))
      )
        return reply.code(400).send({ error: "e2ee_invalid_envelope" });

      // block 检查 + 创建在事务内（advisory lock 协调并发）；Tracking Number 碰撞重试
      const result = await createWithTrackingRetry<LetterWithState>({
        generator: generateTrackingNo,
        maxRetries: MAX_TRACKING_RETRY,
        create: async (trackingNo) => {
          try {
            const letter = await req.server.prisma.$transaction(async (tx) => {
              // 与 Block 创建共用同一把 advisory lock（方向无关）
              await acquireBlockLetterPairLock(tx, recipient.id, sender.id);
              // block 拦截：若 Recipient 已拉黑 Sender，禁止创建（规范 §10）
              const blocked = await tx.block.findUnique({
                where: {
                  blockerId_blockedId: { blockerId: recipient.id, blockedId: sender.id },
                },
              });
              if (blocked) {
                throw new BlockedByRecipientError();
              }
              for (const id of [...new Set([sender.id, recipient.id])].sort((a, b) =>
                a < b ? -1 : a > b ? 1 : 0
              )) {
                await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`profile:${id}`}, 0))`;
              }
              const currentSender = await tx.user.findUniqueOrThrow({ where: { id: sender.id } });
              const senderKey = await tx.encryptionIdentity.findUnique({
                where: { userId: sender.id },
              });
              const recipientKey = await tx.encryptionIdentity.findUnique({
                where: { userId: recipient.id },
              });
              if (!body.e2ee && (senderKey || recipientKey))
                throw new MediaError("e2ee_required", 409);
              if (
                body.e2ee &&
                (!senderKey ||
                  !recipientKey ||
                  senderKey.keyId !== body.e2ee.sender.keyId ||
                  recipientKey.keyId !== body.e2ee.recipient.keyId ||
                  JSON.stringify(
                    identityRegistrationSchema.parse(senderKey.registration).identity
                  ) !== JSON.stringify(body.e2ee.sender) ||
                  JSON.stringify(
                    identityRegistrationSchema.parse(recipientKey.registration).identity
                  ) !== JSON.stringify(body.e2ee.recipient))
              )
                throw new MediaError("e2ee_key_changed", 409);
              const currentRecipient = await tx.user.findUniqueOrThrow({
                where: { id: recipient.id },
              });
              const graphVersion = getDefaultGraphVersion();
              if (req.server.config.NEW_LETTER_RULES_VERSION === "1.1") {
                assertDistrictTransportRegion(currentSender, graphVersion, "origin");
                assertDistrictTransportRegion(currentRecipient, graphVersion, "destination");
              }
              if (body.imageIds?.length) {
                await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`media:${sender.id}`}, 0))`;
              }
              const letter = await tx.letter.create({
                data: {
                  trackingNo,
                  senderId: sender.id,
                  recipientId: recipient.id,
                  senderAccountSnapshot: sender.account,
                  senderUidSnapshot: sender.uid,
                  senderNicknameSnapshot: currentSender.nickname,
                  recipientAccountSnapshot: recipient.account,
                  recipientUidSnapshot: recipient.uid,
                  recipientNicknameSnapshot: currentRecipient.nickname,
                  encryptedContent: encrypted.ciphertext,
                  contentIv: encrypted.iv,
                  contentAuthTag: encrypted.authTag,
                  ...(body.e2ee ? { contentVersion: E2EE_VERSION, e2ee: body.e2ee } : {}),
                  originProvince: currentSender.province,
                  originCity: currentSender.city,
                  originDistrict: currentSender.district,
                  targetProvince: currentRecipient.province,
                  targetCity: currentRecipient.city,
                  targetDistrict: currentRecipient.district,
                  status: "CREATED",
                  initialTransport: body.transportType,
                  currentTransport: body.transportType,
                  clientRequestId: body.clientRequestId,
                  requestFingerprint: fingerprint,
                  rulesVersion: req.server.config.NEW_LETTER_RULES_VERSION,
                  // 图版本来自注册表（禁止硬编码）：Phase 8 起新信件默认 china-v2
                  graphVersion,
                  simulationSeed: generateSimulationSeed(),
                  sentAt:
                    req.server.config.NEW_LETTER_RULES_VERSION === "1.1"
                      ? new Date(req.server.simulationClock.now())
                      : new Date(),
                  writtenAt: body.e2ee
                    ? null
                    : body.writtenAt
                      ? new Date(body.writtenAt)
                      : new Date(),
                  recipientState: {
                    create: { recipientId: recipient.id, readState: "UNOPENED" },
                  },
                  senderState: { create: { senderId: sender.id } },
                },
                include: { senderState: true, recipientState: true },
              });
              for (const [position, id] of (body.imageIds ?? []).entries()) {
                const claimed = await tx.mediaAsset.updateMany({
                  where: {
                    id,
                    ownerId: sender.id,
                    purpose: "LETTER_IMAGE",
                    contentVersion: body.e2ee ? E2EE_VERSION : "server-v1",
                    letterId: null,
                    createdAt: { gt: new Date(Date.now() - STAGED_MEDIA_TTL_MS) },
                  },
                  data: { letterId: letter.id, position },
                });
                if (claimed.count !== 1) throw new MediaError("image_unavailable");
              }
              const images = await tx.mediaAsset.findMany({
                where: { letterId: letter.id },
                orderBy: { position: "asc" },
              });
              return { ...letter, images };
            });
            return { kind: "created" as const, value: letter };
          } catch (err) {
            if (err instanceof MediaError) throw err;
            if (err instanceof BlockedByRecipientError) {
              return { kind: "blocked" as const };
            }
            // 唯一约束冲突：读原 Letter 比较 fingerprint（并发幂等）
            const original = await req.server.prisma.letter.findUnique({
              where: {
                senderId_clientRequestId: {
                  senderId: sender.id,
                  clientRequestId: body.clientRequestId,
                },
              },
              include: {
                senderState: true,
                recipientState: true,
                images: { orderBy: { position: "asc" } },
              },
            });
            if (original) {
              if (original.requestFingerprint !== fingerprint) {
                return { kind: "conflict" as const };
              }
              return { kind: "created" as const, value: original, existed: true };
            }
            if (err instanceof InvalidTransportRegionError) throw err;
            const fields = conflictFields(err);
            if (fields.includes("trackingNo")) {
              return { kind: "collision" as const };
            }
            return { kind: "error" as const };
          }
        },
      });

      if (result.kind === "blocked") {
        return reply.code(403).send({ error: "blocked_by_recipient" });
      }
      if (result.kind === "conflict") {
        return reply.code(409).send({ error: "idempotency_conflict" });
      }
      if (result.kind === "collision") {
        return reply.code(500).send({ error: "tracking_generation_failed" });
      }
      if (result.kind === "error") {
        return reply.code(500).send({ error: "internal_error" });
      }

      // 并发幂等（已存在）返回 200；新建返回 201
      return reply.code(result.existed ? 200 : 201).send({
        letter: toSenderLetterView(
          result.value,
          decrypt(result.value, req),
          result.value.senderState
        ),
      });
    }
  );

  // 信件列表（寄出 / 收到）
  app.get(
    "/letters",
    { preHandler: [app.authenticate] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { direction, limit } = listLettersQuerySchema.parse(req.query);
      const user = await req.server.prisma.user.findUnique({ where: { uid: req.user.sub } });
      if (!user) {
        return reply.code(401).send({ error: "unauthorized" });
      }

      const where =
        direction === "sent"
          ? { senderId: user.id }
          : direction === "received"
            ? { recipientId: user.id }
            : { OR: [{ senderId: user.id }, { recipientId: user.id }] };

      const letters = await req.server.prisma.letter.findMany({
        where: {
          AND: [
            where,
            {
              OR: [
                {
                  senderId: user.id,
                  OR: [{ senderState: { is: null } }, { senderState: { is: { hiddenAt: null } } }],
                },
                {
                  senderId: { not: user.id },
                  OR: [
                    { recipientState: { is: null } },
                    { recipientState: { is: { hiddenAt: null } } },
                  ],
                },
              ],
            },
          ],
        },
        orderBy: { createdAt: "desc" },
        take: limit,
        include: {
          senderState: true,
          recipientState: true,
          images: { orderBy: { position: "asc" } },
        },
      });

      const items = letters.map((l) => toLetterViewFor(l, user.id, req));
      return reply.send({ letters: items });
    }
  );

  // 信件详情
  app.get(
    "/letters/:trackingNo",
    { preHandler: [app.authenticate] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { trackingNo } = trackingNoParamSchema.parse(req.params);
      const user = await req.server.prisma.user.findUnique({ where: { uid: req.user.sub } });
      if (!user) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      const letter = await req.server.prisma.letter.findUnique({
        where: { trackingNo },
        include: {
          senderState: true,
          recipientState: true,
          images: { orderBy: { position: "asc" } },
          journey: { include: { legs: { orderBy: { sequence: "asc" } } } },
        },
      });
      if (!letter || (letter.senderId !== user.id && letter.recipientId !== user.id)) {
        return reply.code(404).send({ error: "letter_not_found" });
      }
      const view = toLetterViewFor(letter, user.id, req);
      // 计划路线仅向寄件人展示；收件人详情不包含尚未发生的路段。
      const journeySummary =
        letter.senderId === user.id && letter.journey
          ? buildJourneySummary(letter.journey, letter.graphVersion)
          : null;
      return reply.send({ letter: { ...view, journey: journeySummary } });
    }
  );

  // 拆信（仅 Recipient，需 DELIVERED）
  app.post(
    "/letters/:trackingNo/open",
    { preHandler: [app.authenticate] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { trackingNo } = trackingNoParamSchema.parse(req.params);
      const user = await req.server.prisma.user.findUnique({ where: { uid: req.user.sub } });
      if (!user) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      const letter = await req.server.prisma.letter.findUnique({
        where: { trackingNo },
        include: { recipientState: true },
      });
      if (!letter || letter.recipientId !== user.id) {
        return reply.code(404).send({ error: "letter_not_found" });
      }
      if (letter.status !== DELIVERED) {
        return reply.code(409).send({ error: "not_delivered" });
      }
      if (!letter.recipientState) {
        throw new Error("recipient_state_missing");
      }
      // Compare-and-set preserves the first openedAt across concurrent requests.
      await req.server.prisma.recipientState.updateMany({
        where: { letterId: letter.id, readState: "UNOPENED" },
        data: { readState: "OPENED", openedAt: new Date() },
      });
      return reply.send({ ok: true });
    }
  );

  // 隐藏（仅终态 Letter；Sender / Recipient 各自独立）
  app.post(
    "/letters/:trackingNo/hide",
    { preHandler: [app.authenticate] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { trackingNo } = trackingNoParamSchema.parse(req.params);
      const user = await req.server.prisma.user.findUnique({ where: { uid: req.user.sub } });
      if (!user) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      const letter = await req.server.prisma.letter.findUnique({ where: { trackingNo } });
      if (!letter || (letter.senderId !== user.id && letter.recipientId !== user.id)) {
        return reply.code(404).send({ error: "letter_not_found" });
      }
      if (!isTerminal(letter.status)) {
        return reply.code(409).send({ error: "not_terminal" });
      }
      const isSender = letter.senderId === user.id;
      const hiddenAt = new Date();
      if (isSender) {
        await req.server.prisma.senderState.upsert({
          where: { letterId: letter.id },
          update: { hiddenAt },
          create: { letterId: letter.id, senderId: user.id, hiddenAt },
        });
      } else {
        await req.server.prisma.recipientState.upsert({
          where: { letterId: letter.id },
          update: { hiddenAt },
          create: { letterId: letter.id, recipientId: user.id, readState: "UNOPENED", hiddenAt },
        });
      }
      return reply.send({ ok: true });
    }
  );
}

/** 解密正文（服务端内部）；完整性错误抛出，进入统一安全错误处理（500），不静默置 null。 */
function decrypt(l: LetterWithState, req: FastifyRequest): string | null {
  if (l.contentVersion === E2EE_VERSION) return null;
  return decryptContent(
    { ciphertext: l.encryptedContent, iv: l.contentIv, authTag: l.contentAuthTag },
    req.server.config.CONTENT_ENCRYPTION_KEY
  );
}

/** 提取唯一约束冲突涉及的字段名（兼容 Prisma 7 driver adapter）。 */
function conflictFields(err: unknown): string[] {
  const meta = (
    err as {
      meta?: {
        target?: unknown;
        driverAdapterError?: { cause?: { constraint?: { fields?: string[] } } };
      };
    }
  ).meta;
  const fields = Array.isArray(meta?.target)
    ? (meta.target as string[])
    : (meta?.driverAdapterError?.cause?.constraint?.fields ?? []);
  return fields;
}

/** 终态判定（规范 §37）。 */
function isTerminal(status: LetterStatus): boolean {
  return status === "DELIVERED" || status === "PERMANENTLY_LOST" || status === "DESTROYED";
}

/** 根据查看者视角构建 Letter 视图。 */
function toLetterViewFor(l: LetterWithState, viewerId: bigint, req: FastifyRequest): LetterView {
  if (l.senderId === viewerId) {
    return toSenderLetterView(l, decrypt(l, req), l.senderState);
  }
  return toRecipientLetterView(l, decrypt(l, req), l.recipientState);
}

/**
 * 从 Journey 构建用户可见摘要（Phase 4：安全字段）。
 * 仅含：起点/终点 station name、totalDistanceKm、legs 序列（name + distance + transport）。
 * 不含：internal id、simulationSeed、plannedDuration、ETA。
 */
function buildJourneySummary(
  journey: Journey & { legs: TransportLeg[] },
  graphVersion: string
): {
  origin: { name: string };
  destination: { name: string };
  totalDistanceKm: number;
  status: string;
  legs: Array<{
    sequence: number;
    from: { name: string };
    to: { name: string };
    transportType: string;
    distanceKm: number;
    status: string;
  }>;
} {
  return {
    origin: { name: stationName(journey.originNodeId, graphVersion) },
    destination: { name: stationName(journey.destinationNodeId, graphVersion) },
    totalDistanceKm: journey.totalDistanceKm,
    status: journey.status,
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
