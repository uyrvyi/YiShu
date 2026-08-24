-- CreateEnum
CREATE TYPE "TransportType" AS ENUM ('HAND_CARRY', 'HORSE_RELAY', 'EXPRESS_RELAY', 'PIGEON');

-- CreateEnum
CREATE TYPE "LetterStatus" AS ENUM ('CREATED', 'DISPATCHED', 'IN_TRANSIT', 'AT_STATION', 'TRANSFER', 'DELAYED', 'COURIER_MISSING', 'LETTER_DROPPED', 'LETTER_MISSING', 'RECOVERED', 'TRANSPORT_CHANGED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'PERMANENTLY_LOST', 'DESTROYED');

-- CreateEnum
CREATE TYPE "RecipientReadState" AS ENUM ('UNOPENED', 'OPENED');

-- 转换既有文本列类型为 enum（保留现有值，避免删除重建丢失数据）
ALTER TABLE "Letter" ALTER COLUMN "status" TYPE "LetterStatus" USING "status"::"LetterStatus";
ALTER TABLE "Letter" ALTER COLUMN "initialTransport" TYPE "TransportType" USING "initialTransport"::"TransportType";
ALTER TABLE "Letter" ALTER COLUMN "currentTransport" TYPE "TransportType" USING "currentTransport"::"TransportType";
ALTER TABLE "RecipientState" ALTER COLUMN "readState" TYPE "RecipientReadState" USING "readState"::"RecipientReadState";

-- 新增 requestFingerprint（先 nullable，backfill 后再 NOT NULL）
ALTER TABLE "Letter" ADD COLUMN "requestFingerprint" TEXT;

-- 为既有记录回填确定性 fingerprint（trackingNo + clientRequestId 的 SHA-256）
UPDATE "Letter"
SET "requestFingerprint" = encode(
  sha256(convert_to("trackingNo" || ':' || "clientRequestId", 'UTF8')),
  'hex'
)
WHERE "requestFingerprint" IS NULL;

ALTER TABLE "Letter" ALTER COLUMN "requestFingerprint" SET NOT NULL;

-- 回填旧 simulationSeed（前序迁移可能填了空串）；生成 64 位随机 hex
UPDATE "Letter"
SET "simulationSeed" = lower(
  replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
)
WHERE "simulationSeed" = '' OR "simulationSeed" IS NULL;

ALTER TABLE "Letter" ALTER COLUMN "simulationSeed" DROP DEFAULT;
