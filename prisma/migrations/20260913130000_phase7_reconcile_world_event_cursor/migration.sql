-- Phase 7 Upgrade Compatibility（HIGH）：校准 Journey.nextWorldEventIndex，使其大于所有
-- **已使用或已预留** 的 WorldEvent 编号。
--
-- 背景：旧版本（migration 13 及之前）在 Leg 首次激活时就把 primaryEventIndex 预留到
-- TransportLeg.primaryEventIndex，而该事件行要等 Leg 完成点才写入。migration 14 的回填只看了
-- MAX(WorldEvent.eventIndex)+1，因此在"有预留编号但尚无事件行"的合法旧状态下会得到
-- nextWorldEventIndex = 0，随后 LOST_PATH（用预留编号 0）与 canonical COURIER_MISSING（新分配 0）
-- 撞上 (journeyId, eventIndex) 唯一约束 → P2002，在途 Journey 升级后无法继续推进。
--
-- 语义（正式不变量）：eventIndex **唯一 + 单调 + 不碰撞**。
-- 新 Journey 正常路径可连续；由旧版本升级的 Journey 允许继承历史 gap（不重写冻结数据）。
--
-- 本迁移只抬高 cursor 下界，**不**修改：
--   TransportLeg.primaryEventIndex（冻结的预留编号）、primaryEventOutcome、Journey.nextRandomDrawIndex、
--   simulationSeed、WorldEvent 历史、任何已冻结 transport 结果。
-- AlterTable
UPDATE "Journey"
SET "nextWorldEventIndex" = GREATEST(
  "nextWorldEventIndex",
  COALESCE(
    (SELECT MAX("eventIndex") + 1 FROM "WorldEvent" w WHERE w."journeyId" = "Journey"."id"),
    0
  ),
  COALESCE(
    (SELECT MAX("primaryEventIndex") + 1 FROM "TransportLeg" l WHERE l."journeyId" = "Journey"."id"),
    0
  ),
  0
);
