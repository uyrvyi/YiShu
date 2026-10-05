import type { TransportType } from "@yishu/shared";
import type { LetterView } from "../api/letterApi";
import { LetterApiError } from "../api/letterApi";
import { AuthExpiredError } from "../api/authenticatedFetch";
import { STATUS_LABELS } from "../map/presentation";

export const TRANSPORT_LABELS: Record<TransportType, string> = {
  HAND_CARRY: "托人捎信",
  HORSE_RELAY: "驿马",
  EXPRESS_RELAY: "加急驿递",
  PIGEON: "飞鸽传书",
};

export function isTerminal(status: LetterView["status"]): boolean {
  return status === "DELIVERED" || status === "PERMANENTLY_LOST" || status === "DESTROYED";
}

export function bodyTextFor(letter: LetterView): string | null {
  if (letter.readState !== undefined) {
    return letter.status === "DELIVERED" && letter.readState === "OPENED" ? letter.content : null;
  }
  return letter.content;
}

export function statusCopy(status: LetterView["status"]): string {
  return STATUS_LABELS[status];
}

export function statusTone(status: LetterView["status"]): "green" | "muted" | "orange" | "error" {
  if (status === "CREATED") return "muted";
  if (status === "PERMANENTLY_LOST" || status === "DESTROYED") return "error";
  if (status === "COURIER_MISSING" || status === "LETTER_MISSING" || status === "DELAYED") {
    return "orange";
  }
  return "green";
}

export function problemMessage(error: unknown): string {
  if (error instanceof AuthExpiredError) return "登录已过期，请重新登录";
  if (error instanceof LetterApiError) {
    const messages: Record<string, string> = {
      blocked_by_recipient: "无法寄送给这位收件人",
      user_not_found: "未找到该用户",
      letter_not_found: "信件不存在或无法查看",
      no_station_mapping: "当前地址暂时没有可用路线",
      unknown_graph_version: "路线数据暂时不可用",
      idempotency_conflict: "草稿已变更，请重新写信",
      not_delivered: "信件送达后才能拆阅",
      not_terminal: "信件结束运输后才能隐藏",
      rate_limited: "操作过于频繁，请稍后再试",
      image_too_large: "每张图片不能超过 10 MB",
      too_many_images: "每封信最多添加 9 张图片",
      invalid_image: "图片无法读取，请选择 JPG、PNG、WebP、GIF 或 AVIF 图片",
      image_unavailable: "图片已过期或不能使用，请移除后重新上传",
      too_many_pending_images: "待发送图片过多，请移除不用的图片后再试",
      media_not_found: "图片不存在或暂时不能查看",
    };
    return (
      messages[error.code] ??
      (error.status >= 500 ? "服务暂时不可用，请稍后重试" : "操作未完成，请重试")
    );
  }
  if (
    error instanceof TypeError ||
    (error instanceof Error && /network|fetch/i.test(error.message))
  ) {
    return "网络连接不可用，请检查网络后重试";
  }
  return "操作未完成，请重试";
}
