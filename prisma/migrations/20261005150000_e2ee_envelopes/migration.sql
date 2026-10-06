CREATE TABLE "EncryptionIdentity" (
  "userId" BIGINT NOT NULL,
  "keyId" TEXT NOT NULL,
  "registration" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EncryptionIdentity_pkey" PRIMARY KEY ("userId"),
  CONSTRAINT "EncryptionIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "EncryptionIdentity_keyId_key" ON "EncryptionIdentity"("keyId");
ALTER TABLE "Letter" ADD COLUMN "contentVersion" TEXT NOT NULL DEFAULT 'server-v1', ADD COLUMN "e2ee" JSONB;
ALTER TABLE "Letter" ALTER COLUMN "writtenAt" DROP NOT NULL;
ALTER TABLE "MediaAsset" ADD COLUMN "contentVersion" TEXT NOT NULL DEFAULT 'server-v1';
