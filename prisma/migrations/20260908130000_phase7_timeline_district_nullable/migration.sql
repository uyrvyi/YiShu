-- Phase 7 遗留修复：TimelineEvent.district 语义
-- station 冻结数据只到 province/city；district 无法确认时必须为 NULL（禁止空串伪装）。
-- 只处理 TimelineEvent.district 字段，不触碰其它业务字段；历史空串（若有，仅测试残留）置 NULL。
-- 顺序：先 DROP NOT NULL 再 UPDATE（否则 UPDATE 写 NULL 违反 NOT NULL 约束）。
-- AlterTable
ALTER TABLE "TimelineEvent" ALTER COLUMN "district" DROP NOT NULL;
UPDATE "TimelineEvent" SET "district" = NULL WHERE "district" = '';
