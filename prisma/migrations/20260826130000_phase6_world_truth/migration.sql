-- CreateEnum
CREATE TYPE "JourneyAnomalyType" AS ENUM ('COURIER_MISSING', 'LETTER_DROPPED');

-- CreateEnum
CREATE TYPE "WorldEventType" AS ENUM ('DELAYED', 'REROUTED', 'ROBBERY', 'COURIER_MISSING', 'LOST_PATH', 'LETTER_DROPPED', 'SERIOUS_ACCIDENT', 'RECOVERED', 'TRANSPORT_CHANGED', 'PERMANENTLY_LOST', 'DESTROYED');

-- AlterTable
ALTER TABLE "Journey" ADD COLUMN "nextEventIndex" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "anomalyType" "JourneyAnomalyType",
ADD COLUMN "anomalyStartedAtSim" TIMESTAMP(3),
ADD COLUMN "anomalyResolvedAtSim" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "WorldEvent" (
    "id" BIGSERIAL NOT NULL,
    "journeyId" BIGINT NOT NULL,
    "eventIndex" INTEGER NOT NULL,
    "eventType" "WorldEventType" NOT NULL,
    "occurredAtSim" TIMESTAMP(3) NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorldEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorldEvent_journeyId_eventIndex_key" ON "WorldEvent"("journeyId", "eventIndex");

-- CreateIndex
CREATE INDEX "WorldEvent_journeyId_idx" ON "WorldEvent"("journeyId");

-- AddForeignKey
ALTER TABLE "WorldEvent" ADD CONSTRAINT "WorldEvent_journeyId_fkey" FOREIGN KEY ("journeyId") REFERENCES "Journey"("id") ON DELETE CASCADE ON UPDATE CASCADE;
