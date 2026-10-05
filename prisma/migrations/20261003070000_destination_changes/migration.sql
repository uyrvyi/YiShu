ALTER TABLE "Journey" ADD COLUMN "destinationRevision" INTEGER NOT NULL DEFAULT 0;
CREATE TABLE "DestinationChange" (
  "id" BIGSERIAL PRIMARY KEY,
  "journeyId" BIGINT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING' CHECK ("status" IN ('PENDING', 'APPLIED', 'SUPERSEDED')),
  "requestedAtSim" TIMESTAMP(3) NOT NULL,
  "destinationNodeId" TEXT NOT NULL,
  "targetProvince" TEXT NOT NULL,
  "targetCity" TEXT NOT NULL,
  "targetDistrict" TEXT NOT NULL,
  "previousTargetProvince" TEXT NOT NULL,
  "previousTargetCity" TEXT NOT NULL,
  "previousTargetDistrict" TEXT NOT NULL,
  "appliedAtSim" TIMESTAMP(3),
  "fromRevision" INTEGER,
  "previousDestinationNodeId" TEXT,
  "previousLastMileReadyAtSim" TIMESTAMP(3),
  CONSTRAINT "DestinationChange_journeyId_fkey" FOREIGN KEY ("journeyId") REFERENCES "Journey"("id") ON DELETE CASCADE
);
CREATE INDEX "DestinationChange_journeyId_status_idx" ON "DestinationChange"("journeyId", "status");
