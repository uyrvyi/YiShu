import { randomInt } from "node:crypto";

/**
 * UID 生成（对应开发规范 §4.2）。
 *
 * - 8 位纯数字
 * - 第一位不能为 0
 * - 不使用连续自增
 * - 全局唯一由调用方（数据库唯一约束 + 碰撞重试）保证
 *
 * 支持注入随机源 / 候选生成器，便于测试确定性验证碰撞重试。
 */

/** 默认 UID 生成器：8 位数字，首位 1-9。 */
export function generateUid(): string {
  const first = randomInt(1, 10).toString();
  let rest = "";
  for (let i = 0; i < 7; i += 1) {
    rest += randomInt(0, 10).toString();
  }
  return first + rest;
}

/** 可注入的 UID 生成器类型。 */
export type UidGenerator = () => string;
