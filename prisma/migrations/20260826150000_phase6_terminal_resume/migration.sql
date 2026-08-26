-- AlterTable
ALTER TABLE "Journey" ADD COLUMN "resumeAtSim" TIMESTAMP(3);

-- 防御性回填（dev/test 均无 WorldEvent 数据，正式环境亦应无 null；保证 NOT NULL 迁移可执行）
UPDATE "WorldEvent" SET "nodeId" = '' WHERE "nodeId" IS NULL;

-- AlterTable
ALTER TABLE "WorldEvent" ALTER COLUMN "nodeId" SET NOT NULL;
