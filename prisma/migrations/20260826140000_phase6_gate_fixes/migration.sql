-- AlterTable
ALTER TABLE "TransportLeg" ADD COLUMN "primaryEventIndex" INTEGER,
ADD COLUMN "primaryEventOutcome" TEXT,
ADD COLUMN "delaySeconds" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "WorldEvent" ADD COLUMN "nodeId" TEXT,
ADD COLUMN "transportLegSequence" INTEGER;
