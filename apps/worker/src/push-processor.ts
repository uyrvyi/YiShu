import type { PrismaClient } from "@yishu/db";
import { PUSH_MAX_ATTEMPTS, pushMessage } from "@yishu/domain/push";
import type { SimulationClock } from "@yishu/simulation";
import type { PushProvider, PushResult } from "./push-provider.js";

export async function deliverPush(
  db: PrismaClient,
  clock: SimulationClock,
  provider: PushProvider,
  dispatchId: bigint
): Promise<void> {
  const initial = await db.pushDispatch.findUnique({
    where: { id: dispatchId },
    select: { deviceId: true },
  });
  if (!initial) return;
  const retry = await db.$transaction(
    async (tx) => {
      // Serialize ownership changes and delivery, then re-read. Never send A's queued push to B's session.
      await tx.$queryRaw`SELECT id FROM "PushDevice" WHERE id = ${initial.deviceId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "PushDispatch" WHERE id = ${dispatchId} FOR UPDATE`;
      const dispatch = await tx.pushDispatch.findUnique({
        where: { id: dispatchId },
        include: {
          device: true,
          letter: {
            select: {
              trackingNo: true,
              senderAccountSnapshot: true,
              recipientId: true,
              senderId: true,
            },
          },
        },
      });
      if (!dispatch || dispatch.status !== "PENDING") return false;
      const device = dispatch.device;
      const message = pushMessage(
        dispatch.kind,
        dispatch.letter.trackingNo,
        dispatch.letter.senderAccountSnapshot
      );
      const eligible =
        dispatch.kind === "NEW_LETTER"
          ? dispatch.userId === dispatch.letter.recipientId
          : [dispatch.letter.senderId, dispatch.letter.recipientId].includes(dispatch.userId);
      // Recheck Timeline visibility at delivery as well as at dispatch creation.
      const fact = !message
        ? false
        : dispatch.kind === "NEW_LETTER"
          ? true
          : await tx.timelineEvent.findFirst({
              where: {
                letterId: dispatch.letterId,
                sourceKey: dispatch.sourceKey,
                type: dispatch.kind as import("@yishu/db").TimelineEventType,
                visibleAt: { lte: new Date(clock.now()) },
              },
              select: { id: true },
            });
      if (
        !message ||
        !eligible ||
        !fact ||
        device.disabled ||
        device.userId !== dispatch.userId ||
        device.version !== dispatch.deviceVersion ||
        device.expiresAt.getTime() <= clock.now()
      ) {
        await tx.pushDispatch.update({ where: { id: dispatchId }, data: { status: "CANCELLED" } });
        return false;
      }
      if (dispatch.attempts >= PUSH_MAX_ATTEMPTS) {
        await tx.pushDispatch.update({ where: { id: dispatchId }, data: { status: "FAILED" } });
        return false;
      }
      let result: PushResult;
      try {
        result = await provider.send(device.expoPushToken, message);
      } catch {
        result = { status: "retry" };
      }
      const shouldRetry = result.status === "retry" && dispatch.attempts + 1 < PUSH_MAX_ATTEMPTS;
      if (result.status === "invalid")
        await tx.pushDevice.update({
          where: { id: device.id },
          data: { disabled: true, version: { increment: 1 } },
        });
      await tx.pushDispatch.update({
        where: { id: dispatchId },
        data: {
          attempts: { increment: 1 },
          status: result.status === "ok" ? "SENT" : shouldRetry ? "PENDING" : "FAILED",
          ...(result.status === "ok"
            ? { sentAt: new Date(clock.now()), providerTicketId: result.ticketId }
            : { lastErrorCode: result.status }),
        },
      });
      return shouldRetry;
    },
    { timeout: 20000, maxWait: 20000 }
  );
  if (retry) throw new Error("push_provider_retry");
}

export async function checkPushReceipts(db: PrismaClient, provider: PushProvider): Promise<void> {
  let cursor = 0n;
  for (;;) {
    const pending = await db.pushDispatch.findMany({
      where: {
        status: "SENT",
        receiptChecked: false,
        id: { gt: cursor },
        providerTicketId: { not: null },
      },
      take: 100,
      orderBy: { id: "asc" },
    });
    for (const dispatch of pending) {
      if (!dispatch.providerTicketId) continue;
      const result = await provider.receipt(dispatch.providerTicketId);
      if (result === "pending") continue;
      await db.$transaction(async (tx) => {
        if (result === "invalid")
          await tx.pushDevice.updateMany({
            where: {
              id: dispatch.deviceId,
              userId: dispatch.userId,
              version: dispatch.deviceVersion,
            },
            data: { disabled: true, version: { increment: 1 } },
          });
        await tx.pushDispatch.update({
          where: { id: dispatch.id },
          data: { receiptChecked: true, ...(result === "ok" ? {} : { lastErrorCode: result }) },
        });
      });
    }
    if (pending.length < 100) break;
    cursor = pending[pending.length - 1]?.id ?? cursor;
  }
}
