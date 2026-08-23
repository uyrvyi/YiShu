import { z } from "zod";

/** 用户搜索关键词：支持 account 或 8 位 UID（规范 §7）。 */
export const searchQuerySchema = z.object({
  q: z.string().min(1).max(24),
});

/** 拉黑目标：8 位 UID（规范 §10 / §7）。 */
export const blockUidParamSchema = z.object({
  uid: z.string().regex(/^[1-9][0-9]{7}$/, "uid must be an 8-digit number"),
});
