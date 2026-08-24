/**
 * Letter 对外安全视图。
 *
 * - 不暴露 internal letter id、encryptedContent / iv / authTag。
 * - Sender 视图不含 readState（规范 §42/§58）。
 * - Recipient 视图在 status != DELIVERED 时 content 为 null（规范 §49）。
 */

import type { Letter, RecipientState, SenderState } from "@yishu/db";
import type { LetterStatus, RecipientReadState, TransportType } from "@yishu/shared";

export const DELIVERED: LetterStatus = "DELIVERED";
export const CREATED: LetterStatus = "CREATED";

export interface LetterRegion {
  province: string;
  city: string;
  district: string;
}

export interface LetterView {
  trackingNo: string;
  status: LetterStatus;
  initialTransport: TransportType;
  currentTransport: TransportType;
  origin: LetterRegion;
  target: LetterRegion;
  sentAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  /** 正文（仅 Sender 始终可见；Recipient 需 DELIVERED）。 */
  content: string | null;
  /** 发送者身份快照。 */
  sender: { account: string; uid: string; nickname: string };
  /** 收件人身份快照。 */
  recipient: { account: string; uid: string; nickname: string };
}

export interface SenderLetterView extends LetterView {
  /** Sender 视图：readState 完全不存在。 */
  senderState?: { hiddenAt: string | null };
}

export interface RecipientLetterView extends LetterView {
  readState: RecipientReadState;
  recipientState?: { hiddenAt: string | null };
}

function toRegion(l: Letter): LetterRegion {
  return {
    province: l.originProvince,
    city: l.originCity,
    district: l.originDistrict,
  };
}

function toTargetRegion(l: Letter): LetterRegion {
  return {
    province: l.targetProvince,
    city: l.targetCity,
    district: l.targetDistrict,
  };
}

function baseView(l: Letter, content: string | null): LetterView {
  return {
    trackingNo: l.trackingNo,
    status: l.status as LetterStatus,
    initialTransport: l.initialTransport,
    currentTransport: l.currentTransport,
    origin: toRegion(l),
    target: toTargetRegion(l),
    sentAt: l.sentAt ? l.sentAt.toISOString() : null,
    deliveredAt: l.deliveredAt ? l.deliveredAt.toISOString() : null,
    createdAt: l.createdAt.toISOString(),
    content,
    sender: {
      account: l.senderAccountSnapshot,
      uid: l.senderUidSnapshot,
      nickname: l.senderNicknameSnapshot,
    },
    recipient: {
      account: l.recipientAccountSnapshot,
      uid: l.recipientUidSnapshot,
      nickname: l.recipientNicknameSnapshot,
    },
  };
}

/** 构建 Sender 视图：始终可见正文（明文由调用方传入）；不含 readState。 */
export function toSenderLetterView(
  l: Letter,
  plainContent: string | null,
  senderState?: SenderState | null
): SenderLetterView {
  const view = baseView(l, plainContent);
  return {
    ...view,
    senderState: senderState
      ? { hiddenAt: senderState.hiddenAt?.toISOString() ?? null }
      : undefined,
  };
}

/** 构建 Recipient 视图：DELIVERED 前 content 为 null（明文由调用方传入）。 */
export function toRecipientLetterView(
  l: Letter,
  plainContent: string | null,
  recipientState?: RecipientState | null
): RecipientLetterView {
  const canRead = l.status === DELIVERED;
  const view = baseView(l, canRead ? plainContent : null);
  return {
    ...view,
    readState: recipientState?.readState ?? "UNOPENED",
    recipientState: recipientState
      ? { hiddenAt: recipientState.hiddenAt?.toISOString() ?? null }
      : undefined,
  };
}
