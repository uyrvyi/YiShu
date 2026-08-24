-- AlterTable
ALTER TABLE "Letter" ADD COLUMN     "graphVersion" TEXT NOT NULL DEFAULT 'china-v1',
ADD COLUMN     "rulesVersion" TEXT NOT NULL DEFAULT '1.0',
ADD COLUMN     "simulationSeed" TEXT NOT NULL DEFAULT '';
