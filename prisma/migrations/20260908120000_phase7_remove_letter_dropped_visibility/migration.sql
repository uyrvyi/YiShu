-- Phase 7 Gate（BLOCKER）：TimelineEventType 为用户可见事实 enum，
-- 冻结规则 LETTER_DROPPED = HIDDEN（不得以任何形式向用户暴露"信件掉落"），
-- 因此该类型不得继续存在于用户可见 enum。此为 corrective migration，不修改历史 migration。
-- PostgreSQL 不支持 ALTER TYPE ... DROP VALUE（"dropping an enum value is not implemented"），
-- 故采用"重建 enum"标准做法：RENAME 旧类型 → CREATE 新类型（无 LETTER_DROPPED）→ 转换表列 → DROP 旧类型。
-- 说明：dev/test 两库 TimelineEvent 表在测试隔离流程下为空（投影层从未按 LETTER_DROPPED 写入），
-- 转换无数据丢失风险；USING ("type"::text)::"TimelineEventType" 作为显式安全转换。

-- AlterEnum
ALTER TYPE "TimelineEventType" RENAME TO "TimelineEventType_old";
CREATE TYPE "TimelineEventType" AS ENUM ('DISPATCHED', 'DEPARTED_STATION', 'ARRIVED_STATION', 'TRANSPORT_DELAYED', 'COURIER_MISSING', 'LETTER_RECOVERED', 'TRANSPORT_CHANGED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'PERMANENTLY_LOST', 'DESTROYED');
ALTER TABLE "TimelineEvent" ALTER COLUMN "type" TYPE "TimelineEventType" USING ("type"::text)::"TimelineEventType";
DROP TYPE "TimelineEventType_old";
