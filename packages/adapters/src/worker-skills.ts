import { createHash } from "node:crypto";
import type { SecretStore, WorkerSkill } from "@tangow/adapter-kit";
import { containsSecret, parseSkillMd } from "@tangow/core";
import type { PrismaClient } from "@tangow/db";
import { getLogger } from "@tangow/logging";

/** Reports are observations by an untrusted guest. Reject secrets instead of storing masked skills. */
export async function indexWorkerSkills(
  prisma: PrismaClient,
  owner: { spaceId: string; userId: string; botId: string; runId: string; fence: number },
  skills: readonly WorkerSkill[],
  sources: readonly WorkerSkill["source"][],
  secrets: readonly string[],
  secretStore: Pick<SecretStore, "open">,
  receivedAt = new Date(),
): Promise<void> {
  const sharedSecrets: string[] = [];
  if (sources.includes("shared")) {
    const rows = await prisma.botSecret.findMany({
      where: { spaceId: owner.spaceId },
      select: { id: true, ciphertext: true },
    });
    for (const row of rows) {
      const opened = await secretStore.open(row.ciphertext, row.id);
      // Without every saved credential the report cannot be checked, so it is not indexed.
      if (!opened.ok) throw new Error(`Saved credentials are not readable: ${opened.reason}`);
      sharedSecrets.push(opened.plaintext);
    }
  }
  const clean = skills.filter((skill) => {
    if (skill.source === "managed" || !sources.includes(skill.source)) return false;
    const parsed = parseSkillMd(skill.content);
    if (
      "error" in parsed ||
      parsed.name !== skill.name ||
      parsed.description !== skill.description ||
      createHash("sha256").update(skill.content).digest("hex") !== skill.contentHash
    )
      return false;
    const secret =
      (skill.source === "shared" &&
        containsSecret([skill.name, skill.description], sharedSecrets)) ||
      [
        skill.name,
        skill.description,
        skill.path,
        skill.content,
        ...skill.files.flatMap((file) => [file.path, file.content]),
      ].some((text) => containsSecret(text, [...secrets]));
    if (secret) getLogger().warn("skills.index_refused", { botId: owner.botId, reason: "secret" });
    return !secret;
  });
  await prisma.$transaction(async (tx) => {
    // Same run lock as cancellation and completion. A stale report never replaces the index.
    await tx.$queryRaw`SELECT id FROM runs WHERE id = ${owner.runId} FOR UPDATE`;
    const held = await tx.run.findFirst({
      where: {
        id: owner.runId,
        botId: owner.botId,
        spaceId: owner.spaceId,
        leaseFence: owner.fence,
        leaseExpiresAt: { gt: new Date() },
        status: { in: ["leased", "running"] },
      },
    });
    if (!held) return;
    // The worker mounted its bot owner's shared volume, whose row orders that person's reports.
    const [volume] = sources.includes("shared")
      ? await tx.$queryRaw<{ id: string; userId: string; skillIndexReceivedAt: Date | null }[]>`
          SELECT v.id, v."userId", v."skillIndexReceivedAt" FROM volumes v
          JOIN bots b ON b.id = ${owner.botId}
          WHERE v.kind = 'space_shared' AND v."spaceId" = b."spaceId" AND v."userId" = b."userId"
          FOR UPDATE OF v`
      : [];
    const shared =
      volume !== undefined &&
      (volume.skillIndexReceivedAt === null || receivedAt >= volume.skillIndexReceivedAt);
    if (shared) {
      await tx.volume.update({
        where: { id: volume.id },
        data: { skillIndexReceivedAt: receivedAt },
      });
    }
    await tx.volumeSkill.deleteMany({
      where: {
        OR: [
          {
            botId: owner.botId,
            source: { in: sources.includes("bot") ? ["bot", "managed"] : ["managed"] },
          },
          ...(shared
            ? [{ source: "shared", bot: { spaceId: owner.spaceId, userId: volume.userId } }]
            : []),
        ],
      },
    });
    await tx.volumeSkill.createMany({
      data: clean
        .filter((skill) => skill.source !== "shared" || shared)
        .map(({ files: _, ...skill }) => ({
          ...skill,
          content: skill.source === "shared" ? "" : skill.content,
          botId: owner.botId,
        })),
      skipDuplicates: true,
    });
  });
}
