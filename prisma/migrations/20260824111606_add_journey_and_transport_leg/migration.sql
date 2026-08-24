-- CreateEnum
CREATE TYPE "JourneyStatus" AS ENUM ('PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TransportLegStatus" AS ENUM ('PLANNED', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "Journey" (
    "id" BIGSERIAL NOT NULL,
    "letterId" BIGINT NOT NULL,
    "originNodeId" TEXT NOT NULL,
    "destinationNodeId" TEXT NOT NULL,
    "status" "JourneyStatus" NOT NULL DEFAULT 'PLANNED',
    "rulesVersion" TEXT NOT NULL,
    "graphVersion" TEXT NOT NULL,
    "simulationSeed" TEXT NOT NULL,
    "totalDistanceKm" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Journey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransportLeg" (
    "id" BIGSERIAL NOT NULL,
    "journeyId" BIGINT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "fromNodeId" TEXT NOT NULL,
    "toNodeId" TEXT NOT NULL,
    "transportType" "TransportType" NOT NULL,
    "distanceKm" DOUBLE PRECISION NOT NULL,
    "plannedDurationSeconds" INTEGER NOT NULL,
    "status" "TransportLegStatus" NOT NULL DEFAULT 'PLANNED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TransportLeg_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Journey_letterId_key" ON "Journey"("letterId");

-- CreateIndex
CREATE INDEX "Journey_letterId_idx" ON "Journey"("letterId");

-- CreateIndex
CREATE INDEX "TransportLeg_journeyId_idx" ON "TransportLeg"("journeyId");

-- CreateIndex
CREATE UNIQUE INDEX "TransportLeg_journeyId_sequence_key" ON "TransportLeg"("journeyId", "sequence");

-- AddForeignKey
ALTER TABLE "Journey" ADD CONSTRAINT "Journey_letterId_fkey" FOREIGN KEY ("letterId") REFERENCES "Letter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportLeg" ADD CONSTRAINT "TransportLeg_journeyId_fkey" FOREIGN KEY ("journeyId") REFERENCES "Journey"("id") ON DELETE CASCADE ON UPDATE CASCADE;
