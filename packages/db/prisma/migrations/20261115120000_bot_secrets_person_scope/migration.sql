-- A credential now belongs to a person in a space instead of one bot. Names that two bots of the
-- same person used are kept apart by suffixing the newer rows (github, github_2, ...). Nothing is
-- deleted and no value is read: the ciphertext is bound to the row id, which does not change.
DO $$
DECLARE
  item RECORD;
  n INTEGER;
  candidate TEXT;
BEGIN
  FOR item IN
    SELECT "id", "userId", "spaceId", "name"
    FROM (
      SELECT *, row_number() OVER (
        PARTITION BY "userId", "spaceId", "name" ORDER BY "createdAt", "id"
      ) AS position
      FROM "bot_secrets"
    ) ranked
    WHERE position > 1
    ORDER BY "createdAt", "id"
  LOOP
    n := 2;
    LOOP
      -- Names allow 64 characters, so long names are shortened to fit the suffix.
      candidate := left(item."name", 63 - length(n::TEXT)) || '_' || n;
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM "bot_secrets"
        WHERE "userId" = item."userId" AND "spaceId" = item."spaceId" AND "name" = candidate
      );
      n := n + 1;
    END LOOP;
    UPDATE "bot_secrets" SET "name" = candidate WHERE "id" = item."id";
  END LOOP;
END $$;

DROP INDEX "bot_secrets_userId_spaceId_botId_name_key";
CREATE UNIQUE INDEX "bot_secrets_userId_spaceId_name_key" ON "bot_secrets"("userId", "spaceId", "name");

-- The bot that saved a credential is only a record of who created it; deleting the bot keeps it.
ALTER TABLE "bot_secrets" ALTER COLUMN "botId" DROP NOT NULL;
ALTER TABLE "bot_secrets" DROP CONSTRAINT "bot_secrets_botId_fkey";
ALTER TABLE "bot_secrets" ADD CONSTRAINT "bot_secrets_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE SET NULL ON UPDATE CASCADE;
