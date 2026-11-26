import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PgliteDatabase } from "./pglite.test-support.js";
import { applyMigration, migrationNames, openPgliteDatabase } from "./pglite.test-support.js";

const PERSON_SCOPE = "20261115120000_bot_secrets_person_scope";
const long = `a${"b".repeat(63)}`;

let database: PgliteDatabase;
let pglite: PGlite;

beforeAll(async () => {
  const names = await migrationNames();
  database = await openPgliteDatabase(async (created) => {
    pglite = created;
    for (const name of names.slice(0, names.indexOf(PERSON_SCOPE))) {
      await applyMigration(created, name);
    }
  });
  const { prisma } = database;
  await prisma.user.create({ data: { id: "user_a", name: "A", email: "a@tangow.test" } });
  await prisma.organization.create({
    data: { id: "org", name: "O", slug: "org-vault", createdAt: new Date() },
  });
  await prisma.space.create({ data: { id: "space_a", organizationId: "org", name: "S" } });
  for (const bot of ["bot_1", "bot_2", "bot_3"]) {
    await prisma.bot.create({
      data: { id: bot, spaceId: "space_a", userId: "user_a", name: bot, color: "#00C46A" },
    });
  }
  // Under the per-bot scope, three bots of one person saved "github"; one already had "github_2".
  const rows: Array<[string, string, string, number]> = [
    ["s1", "bot_1", "github", 1],
    ["s2", "bot_2", "github", 2],
    ["s3", "bot_3", "github", 3],
    ["s4", "bot_1", "github_2", 4],
    ["s5", "bot_1", long, 5],
    ["s6", "bot_2", long, 6],
  ];
  for (const [id, botId, name, minute] of rows) {
    await pglite.query(
      `INSERT INTO "bot_secrets" ("id","userId","spaceId","botId","name","origin","auth","ciphertext","createdAt","updatedAt")
       VALUES ($1,'user_a','space_a',$2,$3,'https://api.example.test','{"type":"bearer"}',$4,$5,$5)`,
      [id, botId, name, `v2:${id}`, new Date(Date.UTC(2026, 9, 1, 9, minute))],
    );
  }
  await applyMigration(pglite, PERSON_SCOPE);
});
afterAll(() => database.close());

describe("bot_secrets person scope migration", () => {
  it("keeps every row and value, suffixing newer duplicates to a free valid name", async () => {
    const rows = await database.prisma.botSecret.findMany({
      select: { id: true, name: true, ciphertext: true },
      orderBy: { id: "asc" },
    });
    expect(rows).toEqual([
      { id: "s1", name: "github", ciphertext: "v2:s1" },
      { id: "s2", name: "github_3", ciphertext: "v2:s2" },
      { id: "s3", name: "github_4", ciphertext: "v2:s3" },
      { id: "s4", name: "github_2", ciphertext: "v2:s4" },
      { id: "s5", name: long, ciphertext: "v2:s5" },
      { id: "s6", name: `${long.slice(0, 62)}_2`, ciphertext: "v2:s6" },
    ]);
    expect(rows.every((row) => /^[a-z][a-z0-9_]{0,63}$/.test(row.name))).toBe(true);
  });

  it("keeps a credential when the bot that saved it is deleted", async () => {
    await database.prisma.bot.delete({ where: { id: "bot_3" } });
    expect(
      await database.prisma.botSecret.findUniqueOrThrow({
        where: { id: "s3" },
        select: { botId: true },
      }),
    ).toMatchObject({ botId: null });
  });
});
