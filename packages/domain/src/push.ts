import { createHash } from "node:crypto";
import type { PrismaClient, TimelineEventType } from "@yishu/db";
import { materializeVisibleTimeline } from "./timeline.js";

export const PUSH_DEVICE_LEASE_MS = 30 * 24 * 60 * 60 * 1000;
export const PUSH_MAX_ATTEMPTS = 5;
export const PUSH_TEXT: Partial<Record<TimelineEventType, string>> = {
  TRANSPORT_DELAYED: "运输延误",
  COURIER_MISSING: "信使失联",
  LETTER_RECOVERED: "运输已恢复",
  TRANSPORT_CHANGED: "寄送方式已变更",
  OUT_FOR_DELIVERY: "信件正在派送",
  DELIVERED: "信件已送达",
  PERMANENTLY_LOST: "信件已确认永久遗失",
  DESTROYED: "信件已损毁",
};

export async function registerPushDevice(
  db: PrismaClient,
  userId: bigint,
  token: string,
  platform: string,
  nowMs: number
): Promise<void> {
  const lock = createHash("sha256")
    .update("push-device:" + token)
    .digest()
    .readBigInt64BE();
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(${lock})::text`;
    await tx.$queryRaw`SELECT id FROM "PushDevice" WHERE "expoPushToken" = ${token} FOR UPDATE`;
    const previous = await tx.pushDevice.findUnique({ where: { expoPushToken: token } });
    const sameOwner = previous?.userId === userId && !previous.disabled;
    await tx.pushDevice.upsert({
      where: { expoPushToken: token },
      create: {
        userId,
        expoPushToken: token,
        platform,
        registeredAtSim: new Date(nowMs),
        expiresAt: new Date(nowMs + PUSH_DEVICE_LEASE_MS),
      },
      update: {
        userId,
        platform,
        disabled: false,
        expiresAt: new Date(nowMs + PUSH_DEVICE_LEASE_MS),
        ...(sameOwner ? {} : { version: { increment: 1 }, registeredAtSim: new Date(nowMs) }),
      },
    });
  });
}

export async function unregisterPushDevice(
  db: PrismaClient,
  userId: bigint,
  token: string
): Promise<void> {
  await db.pushDevice.updateMany({
    where: { userId, expoPushToken: token, disabled: false },
    data: { disabled: true, version: { increment: 1 } },
  });
}

/** Durable dispatch outbox. Only public visible Timeline facts; never raw WorldEvent. */
export async function reconcileLetterPush(
  db: PrismaClient,
  letterId: bigint,
  nowMs: number
): Promise<void> {
  const letter = await db.letter.findUnique({
    where: { id: letterId },
    select: { senderId: true, recipientId: true, sentAt: true, createdAt: true },
  });
  if (!letter) return;
  const facts = await materializeVisibleTimeline(db, letterId, nowMs);
  const devices = await db.pushDevice.findMany({
    where: {
      userId: { in: [letter.senderId, letter.recipientId] },
      disabled: false,
      expiresAt: { gt: new Date(nowMs) },
    },
  });
  const candidates = [
    { sourceKey: "NEW_LETTER", kind: "NEW_LETTER", at: letter.sentAt ?? letter.createdAt },
    ...facts
      .filter((f) => PUSH_TEXT[f.type] !== undefined)
      .map((f) => ({ sourceKey: f.sourceKey, kind: f.type, at: f.visibleAt })),
  ];
  const data = devices.flatMap((d) =>
    candidates
      .filter(
        (f) =>
          f.at.getTime() <= nowMs &&
          f.at >= d.registeredAtSim &&
          (f.kind !== "NEW_LETTER" || d.userId === letter.recipientId)
      )
      .map((f) => ({
        letterId,
        deviceId: d.id,
        userId: d.userId,
        deviceVersion: d.version,
        sourceKey: f.sourceKey,
        kind: f.kind,
      }))
  );
  if (data.length) await db.pushDispatch.createMany({ data, skipDuplicates: true });
}

export interface SafePushMessage {
  title: string;
  body: string;
  data: { trackingNo: string };
}

/** Never forward arbitrary Timeline title/description/metadata. Text is closed and safe. */
export function pushMessage(
  kind: string,
  trackingNo: string,
  senderAccount: string
): SafePushMessage | null {
  const body =
    kind === "NEW_LETTER"
      ? `${senderAccount} 给你送了一封信`
      : PUSH_TEXT[kind as TimelineEventType];
  return body ? { title: "驿书", body, data: { trackingNo } } : null;
}
