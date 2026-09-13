-- Phase 7 Gate（HIGH）：解耦 deterministic random cursor 与 WorldEvent 编号。
-- 旧 Journey.nextEventIndex 实际语义是"随机决策游标"（draw index），却被当作 WorldEvent.eventIndex 使用，
-- 导致记录派生事实（canonical COURIER_MISSING / TRANSPORT_CHANGED / PERMANENTLY_LOST）时额外消费随机数。
-- 本轮：rename 为 nextRandomDrawIndex（语义即随机游标，历史值可直接继承 → replay 兼容），
-- 并新增 nextWorldEventIndex 作为独立事件编号分配器（不触摸随机游标）。
-- AlterTable
ALTER TABLE "Journey" RENAME COLUMN "nextEventIndex" TO "nextRandomDrawIndex";
ALTER TABLE "Journey" ADD COLUMN "nextWorldEventIndex" INTEGER NOT NULL DEFAULT 0;

-- 已有数据的 Journey：事件编号分配器从现有最大 eventIndex+1 继续，避免与历史 WorldEvent 冲突
UPDATE "Journey"
SET "nextWorldEventIndex" = COALESCE(
  (SELECT MAX("eventIndex") + 1 FROM "WorldEvent" WHERE "WorldEvent"."journeyId" = "Journey"."id"),
  0
);
