import type { TransportType } from "@yishu/shared";
import { REGION_SERVICE_UNAVAILABLE, REGION_SERVICE_UNAVAILABLE_MESSAGE } from "@yishu/shared";
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
  if (
    (error instanceof Error && error.message === REGION_SERVICE_UNAVAILABLE) ||
    (error instanceof LetterApiError && error.code === REGION_SERVICE_UNAVAILABLE)
  )
    return REGION_SERVICE_UNAVAILABLE_MESSAGE;
  const encryptionMessages: Record<string, string> = {
    e2ee_setup_required: "本机加密尚未准备就绪，请检查网络后重试。",
    e2ee_recovery_required: "本机没有可用密钥，请使用恢复码恢复。账号密码不能代替恢复码。",
    e2ee_contact_unverified: "联系人密钥尚未准备就绪，请重试。",
    e2ee_fingerprint_mismatch: "安全码不一致，请与对方重新核对，不要发送。",
    e2ee_key_changed: "对方密钥发生变化，已停止发送或解密，请重新核对安全码。",
    e2ee_recipient_not_ready: "对方尚未在新版应用中登录，无法获取其加密公钥。请让对方先登录一次。",
    e2ee_required: "此账号只能寄送加密信件，请先完成本机加密设置。",
    e2ee_not_ready: "请先完成本机加密设置。",
    e2ee_readd_images: "这些图片未加密，请移除后重新添加。",
    e2ee_unavailable: "后端尚未提供加密服务，需要先发布兼容的后端。",
    e2ee_identity_already_exists: "账号已有密钥，不能覆盖。请使用原恢复码恢复。",
    e2ee_registration_missing:
      "本机仍有密钥，但服务器登记缺失。已保留本机密钥并停止自动创建，请检查加密服务，不要卸载应用。",
    e2ee_wrong_recovery_code: "恢复码不正确或备份损坏，请重新核对。",
    e2ee_backup_unavailable:
      "此设备没有保存恢复码。原有手动开启的账号可输入已保存的恢复码恢复，之后即可再次查看备份。",
    e2ee_session_changed: "登录状态已变化，请重新打开页面。",
    e2ee_invalid_signature: "信件完整性校验失败，未显示内容。",
    e2ee_decryption_failed: "信件未能安全解密，请检查密钥和安全码。",
    e2ee_unknown_version: "信件使用了尚不支持的加密版本，请更新应用。",
  };
  const encryptionCode =
    error instanceof LetterApiError ? error.code : error instanceof Error ? error.message : "";
  if (encryptionMessages[encryptionCode]) return encryptionMessages[encryptionCode];
  if (error instanceof AuthExpiredError) return "登录已过期，请重新登录";
  if (error instanceof LetterApiError) {
    const messages: Record<string, string> = {
      blocked_by_recipient: "无法寄送给这位收件人",
      cannot_send_to_self: "不能给自己寄信，请选择其他收件人",
      user_not_found: "未找到该用户",
      letter_not_found: "信件不存在或无法查看",
      no_station_mapping: "当前地址暂时没有可用路线",
      origin_region_unavailable:
        "你的所在地区暂不支持完整运输路线，请在“我的”中重新选择省、市、区县",
      destination_region_unavailable:
        "收件人的地区暂不支持完整运输路线，请对方重新选择省、市、区县",
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
