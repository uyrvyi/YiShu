-- AlterEnum
ALTER TYPE "TransportLegStatus" ADD VALUE 'ACTIVE';

-- AlterTable
ALTER TABLE "Journey" ADD COLUMN "startedAtSim" TIMESTAMP(3),
ADD COLUMN "completedAtSim" TIMESTAMP(3),
ADD COLUMN "lastAdvancedAtSim" TIMESTAMP(3),
ADD COLUMN "currentLegSequence" INTEGER;

-- AlterTable
ALTER TABLE "TransportLeg" ADD COLUMN "startedAtSim" TIMESTAMP(3),
ADD COLUMN "completedAtSim" TIMESTAMP(3);
