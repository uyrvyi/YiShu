/**
 * 移动端基础格式化工具（Phase 1 骨架）。
 */

/** 数字补零为两位数。 */
export function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}
