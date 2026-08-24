import { randomInt } from "node:crypto";

/**
 * Tracking Number 生成（对应开发规范 §12）。
 *
 * 对外格式：YS-YYYYMMDD-K7P2M
 * - 前缀 `YS-`
 * - 日期 `YYYYMMDD`
 * - `-`
 * - 5 位大写字母/数字随机段
 *
 * 不使用纯自增；全局唯一由调用方（数据库唯一约束 + 碰撞重试）保证。
 * 支持注入随机源 / 候选生成器，便于测试确定性验证碰撞重试。
 */

const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** 生成一个 Tracking Number（随机段 5 位）。 */
export function generateTrackingNo(date = new Date()): string {
  const y = date.getUTCFullYear().toString();
  const m = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const d = date.getUTCDate().toString().padStart(2, "0");
  let rand = "";
  for (let i = 0; i < 5; i += 1) {
    rand += CHARS[randomInt(0, CHARS.length)];
  }
  return `YS-${y}${m}${d}-${rand}`;
}

/** 可注入的 Tracking Number 生成器类型。 */
export type TrackingNoGenerator = () => string;

/** 校验 Tracking Number 是否匹配对外格式。 */
export function isValidTrackingNo(value: string): boolean {
  return /^YS-\d{8}-[A-Z0-9]{5}$/.test(value);
}
