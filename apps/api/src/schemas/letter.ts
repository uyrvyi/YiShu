import { z } from "zod";
import { TRANSPORT_TYPES } from "@yishu/shared";

/**
 * 运输方式（对应开发规范 §13，Phase 3 仅保存选择，不实现运输逻辑）。
 * 从 @yishu/shared 消费同一份类型来源。
 */
const transportTypeSchema = z.enum(TRANSPORT_TYPES);

/** 正文：仅纯文字，最大 2000 Unicode 字符（按 code points 计数，规范 §8）。 */
const contentSchema = z
  .string()
  .min(1)
  .refine((v) => Array.from(v).length <= 2000, {
    message: "content exceeds 2000 Unicode characters",
  });

/** 收件人：完整 account 或 8 位 UID（规范 §7 / §73）。 */
const recipientSchema = z.string().min(4).max(24);

export const createLetterSchema = z.object({
  recipient: recipientSchema,
  content: contentSchema,
  transportType: transportTypeSchema,
  clientRequestId: z.string().min(1).max(64),
});

export const trackingNoParamSchema = z.object({
  trackingNo: z.string().regex(/^YS-\d{8}-[A-Z0-9]{5}$/, "invalid trackingNo"),
});

export const listLettersQuerySchema = z.object({
  // direction 可选：sent / received；缺省返回全部（寄出+收到）
  direction: z.enum(["sent", "received"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
