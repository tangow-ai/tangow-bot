-- A key's owner can share it with people of its space, or with the whole space. Additive only:
-- existing keys stay private (no share rows, flag off).
ALTER TABLE "bot_secrets" ADD COLUMN     "sharedWithSpace" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "bot_secret_shares" (
    "secretId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_secret_shares_pkey" PRIMARY KEY ("secretId","userId")
);

-- CreateIndex
CREATE INDEX "bot_secret_shares_spaceId_userId_idx" ON "bot_secret_shares"("spaceId", "userId");

-- AddForeignKey
ALTER TABLE "bot_secret_shares" ADD CONSTRAINT "bot_secret_shares_secretId_fkey" FOREIGN KEY ("secretId") REFERENCES "bot_secrets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Leaving the space removes the person's shares.
ALTER TABLE "bot_secret_shares" ADD CONSTRAINT "bot_secret_shares_spaceId_userId_fkey" FOREIGN KEY ("spaceId", "userId") REFERENCES "space_members"("spaceId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
