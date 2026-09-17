CREATE TYPE "PushDispatchStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'CANCELLED');
CREATE TABLE "PushDevice" (
  "id" BIGSERIAL NOT NULL,
  "userId" BIGINT NOT NULL,
  "expoPushToken" TEXT NOT NULL,
  "platform" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "disabled" BOOLEAN NOT NULL DEFAULT false,
  "registeredAtSim" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PushDevice_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PushDevice_expoPushToken_key" ON "PushDevice"("expoPushToken");
CREATE INDEX "PushDevice_userId_disabled_idx" ON "PushDevice"("userId", "disabled");
ALTER TABLE "PushDevice" ADD CONSTRAINT "PushDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE TABLE "PushDispatch" (
  "id" BIGSERIAL NOT NULL,
  "letterId" BIGINT NOT NULL,
  "deviceId" BIGINT NOT NULL,
  "userId" BIGINT NOT NULL,
  "deviceVersion" INTEGER NOT NULL,
  "sourceKey" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "status" "PushDispatchStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "providerTicketId" TEXT,
  "receiptChecked" BOOLEAN NOT NULL DEFAULT false,
  "lastErrorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sentAt" TIMESTAMP(3),
  CONSTRAINT "PushDispatch_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PushDispatch_letterId_sourceKey_deviceId_userId_deviceVersion_key" ON "PushDispatch"("letterId", "sourceKey", "deviceId", "userId", "deviceVersion");
CREATE INDEX "PushDispatch_status_id_idx" ON "PushDispatch"("status", "id");
ALTER TABLE "PushDispatch" ADD CONSTRAINT "PushDispatch_letterId_fkey" FOREIGN KEY ("letterId") REFERENCES "Letter"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PushDispatch" ADD CONSTRAINT "PushDispatch_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "PushDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
