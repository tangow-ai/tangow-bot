import { ORPCError } from "@orpc/server";
import type { EncryptedSecretStore } from "@tangow/adapters";
import {
  listBotSecrets,
  listSecretsSharedWith,
  normalizeSecretDestination,
  removeBotSecret,
  shareBotSecret,
  storeBotSecret,
} from "@tangow/adapters";
import type {
  Actor,
  BotSecretDestination,
  VaultList,
  VaultPutInput,
  VaultShareInput,
} from "@tangow/contracts";
import type { PrismaClient } from "@tangow/db";

type VaultDeps = { prisma: PrismaClient; secrets: EncryptedSecretStore };

/** The person's keys and the keys shared with them in the active space; never a value. */
export async function listVault(deps: VaultDeps, actor: Actor): Promise<VaultList> {
  const [mine, shared] = await Promise.all([
    listBotSecrets(deps.prisma, actor),
    listSecretsSharedWith(deps.prisma, actor),
  ]);
  return {
    mine: mine.map((row) => ({
      ...normalizeSecretDestination(row),
      botId: row.botId,
      userIds: row.shares.map((share) => share.userId),
      space: row.sharedWithSpace,
    })),
    shared: shared.map((row) => ({ ...normalizeSecretDestination(row), ownerName: row.user.name })),
  };
}

/** Only the key's owner chooses who it is shared with: the lookup is scoped to the actor's keys. */
export async function shareVaultItem(deps: VaultDeps, actor: Actor, input: VaultShareInput) {
  try {
    await shareBotSecret(deps.prisma, actor, input);
  } catch (error) {
    throw new ORPCError(
      error instanceof Error && error.message === "Credential not found"
        ? "NOT_FOUND"
        : "BAD_REQUEST",
      { message: error instanceof Error ? error.message : "Could not save" },
    );
  }
  return { ok: true as const };
}

/** Adds a credential, or replaces the value of one with the same name and destination. */
export async function putVaultItem(
  deps: VaultDeps,
  actor: Actor,
  { value, ...destination }: VaultPutInput,
): Promise<BotSecretDestination> {
  try {
    await deps.prisma.$transaction((tx) =>
      storeBotSecret({
        tx,
        secretStore: deps.secrets,
        scope: actor,
        destination,
        plaintext: value,
      }),
    );
  } catch (error) {
    // The store's errors describe the destination or the limit, never the value.
    throw new ORPCError("BAD_REQUEST", {
      message: error instanceof Error ? error.message : "Could not save",
    });
  }
  return normalizeSecretDestination(destination);
}

export async function removeVaultItem(deps: VaultDeps, actor: Actor, name: string) {
  await removeBotSecret(deps.prisma, actor, name);
  return { ok: true as const };
}
