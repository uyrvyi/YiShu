-- CreateEnum
CREATE TYPE "TimelineEventType" AS ENUM ('DISPATCHED', 'DEPARTED_STATION', 'ARRIVED_STATION', 'TRANSPORT_DELAYED', 'COURIER_MISSING', 'LETTER_DROPPED', 'LETTER_RECOVERED', 'TRANSPORT_CHANGED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'PERMANENTLY_LOST', 'DESTROYED');

-- CreateTable
CREATE TABLE "TimelineEvent" (
    "id" BIGSERIAL NOT NULL,
    "letterId" BIGINT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "type" "TimelineEventType" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "province" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "district" TEXT NOT NULL,
    "nodeId" TEXT,
    "mapX" DOUBLE PRECISION,
    "mapY" DOUBLE PRECISION,
    "uncertaintyRadiusKm" DOUBLE PRECISION,
    "happenedAt" TIMESTAMP(3) NOT NULL,
    "visibleAt" TIMESTAMP(3) NOT NULL,
    "importance" INTEGER NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TimelineEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TimelineEvent_letterId_sourceKey_key" ON "TimelineEvent"("letterId", "sourceKey");

-- CreateIndex
CREATE INDEX "TimelineEvent_letterId_happenedAt_sequence_idx" ON "TimelineEvent"("letterId", "happenedAt", "sequence");

-- AddForeignKey
ALTER TABLE "TimelineEvent" ADD CONSTRAINT "TimelineEvent_letterId_fkey" FOREIGN KEY ("letterId") REFERENCES "Letter"("id") ON DELETE CASCADE ON UPDATE CASCADE;
