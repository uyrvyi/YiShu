import { z } from "zod";

/**
 * 账号：4~24 字符，仅允许字母 / 0-9 / _，保存前统一转小写（规范 §4.3）。
 * 允许输入大写字母，但存储时统一转为小写。
 * 禁止纯 8 位数字（与 UID 格式歧义，避免信件误投）。
 */
export const accountSchema = z
  .string()
  .min(4)
  .max(24)
  .regex(/^[a-zA-Z0-9_]+$/, "account may only contain a-z, 0-9, _")
  .refine((v) => !/^\d{8}$/.test(v), "account may not be an 8-digit number (UID-like)")
  .transform((v) => v.toLowerCase());

/**
 * 密码：8~72 字符（规范 §4.5）。
 */
export const passwordSchema = z.string().min(8).max(72);

/**
 * 昵称：1~20 Unicode 字符（规范 §4.4）。
 */
export const nicknameSchema = z
  .string()
  .min(1)
  .refine((value) => Array.from(value).length <= 20, {
    message: "nickname exceeds 20 Unicode characters",
  });

/** 行政区字段：必须非空（规范 §6 首次收发区域）。 */
export const regionSchema = z.string().min(1).max(100);

export const registerSchema = z.object({
  account: accountSchema,
  password: passwordSchema,
  nickname: nicknameSchema,
  province: regionSchema,
  city: regionSchema,
  district: regionSchema,
});

export const loginSchema = z.object({
  account: accountSchema,
  password: passwordSchema,
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});
