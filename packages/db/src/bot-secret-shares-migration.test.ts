import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PgliteDatabase } from "./pglite.test-support.js";
import { applyMigration, migrationNames, openPgliteDatabase } from "./pglite.test-support.js";

const SHARES = "20261116120000_bot_secret_shares";

let database: PgliteDatabase;
let pglite: PGlite;

beforeAll(async () => {
  const names = await migrationNames();
  database = await openPgliteDatabase(async (created) => {
    pglite = created;
    for (const name of names.slice(0, names.indexOf(SHARES))) await applyMigration(created, name);
  });
  const { prisma } = database;
  for (const user of ["user_a", "user_b"]) {
    await prisma.user.create({ data: { id: user, name: user, email: `${user}@tangow.test` } });
  }
  await prisma.organization.create({
    data: { id: "org", name: "O", slug: "org-shares", createdAt: new Date() },
  });
  await prisma.space.create({ data: { id: "space", organizationId: "org", name: "S" } });
  for (const user of ["user_a", "user_b"]) {
    await prisma.member.create({
      data: {
        id: `m_${user}`,
        organizationId: "org",
        userId: user,
        role: "member",
        createdAt: new Date(),
      },
    });
    await prisma.spaceMember.create({
      data: {
        id: `sm_${user}`,
        spaceId: "space",
        organizationId: "org",
        userId: user,
        createdAt: new Date(),
      },
    });
  }
  for (const id of ["k1", "k2"]) {
    await pglite.query(
      `INSERT INTO "bot_secrets" ("id","userId","spaceId","name","origin","auth","ciphertext","updatedAt")
       VALUES ($1,'user_a','space',$1,'https://api.example.test','{"type":"bearer"}',$2,now())`,
      [id, `v2:${id}`],
    );
  }
  await applyMigration(pglite, SHARES);
});
afterAll(() => database.close());

describe("bot_secret_shares migration", () => {
  it("keeps every key as it was, private", async () => {
    expect(
      await database.prisma.botSecret.findMany({
        select: { id: true, ciphertext: true, sharedWithSpace: true },
        orderBy: { id: "asc" },
      }),
    ).toEqual([
      { id: "k1", ciphertext: "v2:k1", sharedWithSpace: false },
      { id: "k2", ciphertext: "v2:k2", sharedWithSpace: false },
    ]);
    expect(await database.prisma.botSecretShare.count()).toBe(0);
  });

  it("drops a key's shares with the key", async () => {
    const { prisma } = database;
    await prisma.botSecretShare.create({
      data: { secretId: "k1", spaceId: "space", userId: "user_b" },
    });
    await prisma.botSecret.delete({ where: { id: "k1" } });
    expect(await prisma.botSecretShare.count()).toBe(0);
  });

  it("refuses a share with someone outside the space", async () => {
    await expect(
      database.prisma.botSecretShare.create({
        data: { secretId: "k2", spaceId: "space", userId: "user_c" },
      }),
    ).rejects.toThrow();
  });
});
