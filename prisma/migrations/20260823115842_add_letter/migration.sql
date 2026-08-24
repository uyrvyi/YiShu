-- CreateTable
CREATE TABLE "Letter" (
    "id" BIGSERIAL NOT NULL,
    "trackingNo" TEXT NOT NULL,
    "senderId" BIGINT NOT NULL,
    "recipientId" BIGINT NOT NULL,
    "senderAccountSnapshot" TEXT NOT NULL,
    "senderUidSnapshot" TEXT NOT NULL,
    "senderNicknameSnapshot" TEXT NOT NULL,
    "recipientAccountSnapshot" TEXT NOT NULL,
    "recipientUidSnapshot" TEXT NOT NULL,
    "recipientNicknameSnapshot" TEXT NOT NULL,
    "encryptedContent" TEXT NOT NULL,
    "contentIv" TEXT NOT NULL,
    "contentAuthTag" TEXT NOT NULL,
    "originProvince" TEXT NOT NULL,
    "originCity" TEXT NOT NULL,
    "originDistrict" TEXT NOT NULL,
    "targetProvince" TEXT NOT NULL,
    "targetCity" TEXT NOT NULL,
    "targetDistrict" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "initialTransport" TEXT NOT NULL,
    "currentTransport" TEXT NOT NULL,
    "clientRequestId" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Letter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecipientState" (
    "id" BIGSERIAL NOT NULL,
    "letterId" BIGINT NOT NULL,
    "recipientId" BIGINT NOT NULL,
    "readState" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3),
    "hiddenAt" TIMESTAMP(3),

    CONSTRAINT "RecipientState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SenderState" (
    "id" BIGSERIAL NOT NULL,
    "letterId" BIGINT NOT NULL,
    "senderId" BIGINT NOT NULL,
    "hiddenAt" TIMESTAMP(3),

    CONSTRAINT "SenderState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Letter_trackingNo_key" ON "Letter"("trackingNo");

-- CreateIndex
CREATE INDEX "Letter_recipientId_idx" ON "Letter"("recipientId");

-- CreateIndex
CREATE UNIQUE INDEX "Letter_senderId_clientRequestId_key" ON "Letter"("senderId", "clientRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "RecipientState_letterId_key" ON "RecipientState"("letterId");

-- CreateIndex
CREATE INDEX "RecipientState_recipientId_idx" ON "RecipientState"("recipientId");

-- CreateIndex
CREATE UNIQUE INDEX "SenderState_letterId_key" ON "SenderState"("letterId");

-- CreateIndex
CREATE INDEX "SenderState_senderId_idx" ON "SenderState"("senderId");

-- AddForeignKey
ALTER TABLE "Letter" ADD CONSTRAINT "Letter_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Letter" ADD CONSTRAINT "Letter_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipientState" ADD CONSTRAINT "RecipientState_letterId_fkey" FOREIGN KEY ("letterId") REFERENCES "Letter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipientState" ADD CONSTRAINT "RecipientState_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SenderState" ADD CONSTRAINT "SenderState_letterId_fkey" FOREIGN KEY ("letterId") REFERENCES "Letter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SenderState" ADD CONSTRAINT "SenderState_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
