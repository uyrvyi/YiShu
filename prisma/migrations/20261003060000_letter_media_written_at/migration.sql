ALTER TABLE "Letter" ADD COLUMN "writtenAt" TIMESTAMP(3);
UPDATE "Letter" SET "writtenAt" = "createdAt";
ALTER TABLE "Letter" ALTER COLUMN "writtenAt" SET NOT NULL;
ALTER TABLE "Letter" ALTER COLUMN "writtenAt" SET DEFAULT CURRENT_TIMESTAMP;

CREATE TABLE "MediaAsset" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerId" BIGINT NOT NULL,
  "purpose" TEXT NOT NULL CHECK ("purpose" IN ('LETTER_IMAGE', 'AVATAR')),
  "mimeType" TEXT NOT NULL,
  "byteSize" INTEGER NOT NULL CHECK ("byteSize" > 0 AND "byteSize" <= 10485760),
  "width" INTEGER NOT NULL,
  "height" INTEGER NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 0,
  "letterId" BIGINT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MediaAsset_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE,
  CONSTRAINT "MediaAsset_letterId_fkey" FOREIGN KEY ("letterId") REFERENCES "Letter"("id") ON DELETE CASCADE
);
CREATE INDEX "MediaAsset_ownerId_createdAt_idx" ON "MediaAsset"("ownerId", "createdAt");
CREATE INDEX "MediaAsset_letterId_position_idx" ON "MediaAsset"("letterId", "position");
ALTER TABLE "User" ADD COLUMN "avatarId" TEXT;
CREATE UNIQUE INDEX "User_avatarId_key" ON "User"("avatarId");
ALTER TABLE "User" ADD CONSTRAINT "User_avatarId_fkey" FOREIGN KEY ("avatarId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL;
