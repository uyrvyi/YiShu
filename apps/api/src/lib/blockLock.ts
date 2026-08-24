import type { Prisma } from "@yishu/db";

/**
 * Block / Letter 并发协调的 advisory lock。
 *
 * 规则（开发规范 §10）：Recipient 拉黑 Sender 后，Sender 不能给 Recipient 发新信。
 * 为防止 Block 与 Letter 创建之间的并发竞态，二者必须使用同一个 transaction-scoped
 * advisory lock，确保串行化。
 *
 * - `pg_advisory_xact_lock` 事务级锁，事务结束自动释放。
 * - pair key 稳定：对两个 id 排序后拼接，方向无关（A blocks B 与 B 给 A 发信用同一把锁）。
 * - 使用参数化 raw query，禁止 SQL 字符串拼接。
 */

/**
 * 获取 Block/Letter pair advisory lock（事务级）。
 * @param tx 事务客户端（Prisma TransactionClient）。
 * @param blockerId 拉黑方（或收件方）。
 * @param blockedId 被拉黑方（或发件方）。
 */
export async function acquireBlockLetterPairLock(
  tx: Prisma.TransactionClient,
  blockerId: bigint,
  blockedId: bigint
): Promise<void> {
  // 排序保证方向无关
  const [a, b] = blockerId < blockedId ? [blockerId, blockedId] : [blockedId, blockerId];
  const pairKey = `${a.toString()}:${b.toString()}`;
  // hashtextextended(seed=0) 生成稳定 int8 advisory key
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${pairKey}, 0))`;
}
