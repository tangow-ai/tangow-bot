import { ORPCError } from "@orpc/server";
import type { EncryptedSecretStore } from "@tangow/adapters";
import {
  decisionProviderRequiresDeploymentOwner,
  prepareDecisionProviderConnection,
  toStringRecord,
} from "@tangow/adapters";
import type { Actor } from "@tangow/contracts";
import { findSpaceDecisionConfig, Prisma, type PrismaClient } from "@tangow/db";
import { requireSpaceOwner } from "./memory-provider-config.js";
import { withSerializableRetry } from "./serializable-retry.js";

export interface DecisionProviderConfigDeps {
  prisma: PrismaClient;
  secrets: Pick<EncryptedSecretStore, "put">;
}

export async function persistDecisionProviderConfig(
  deps: DecisionProviderConfigDeps,
  actor: Actor,
  input: {
    provider: string;
    settings: Record<string, string>;
    credentials: Record<string, string>;
  },
) {
  await requireSpaceOwner(deps.prisma, actor);
  let prepared: Awaited<ReturnType<typeof prepareDecisionProviderConnection>>;
  try {
    prepared = await prepareDecisionProviderConnection(input);
  } catch (error) {
    throw new ORPCError("BAD_REQUEST", {
      message: error instanceof Error ? error.message : "Decision provider connection failed",
    });
  }
  // Loopback, LAN, and cleartext endpoints stay with the deployment owner.
  if (
    decisionProviderRequiresDeploymentOwner(prepared.provider, prepared.settings) &&
    !actor.isDeploymentOwner
  ) {
    throw new ORPCError("FORBIDDEN");
  }
  const stored = await deps.secrets.put(JSON.stringify(prepared.credentials), {
    operationId: "decision-provider-config",
    traceId: "decision-provider-config",
    spaceId: actor.spaceId,
    userId: actor.userId,
    signal: new AbortController().signal,
  });
  const config = await withSerializableRetry(() =>
    deps.prisma.$transaction(
      async (tx) => {
        const existing = await findSpaceDecisionConfig(tx, actor.spaceId);
        const secret = await tx.secret.create({
          data: {
            id: stored.id,
            userId: actor.userId,
            spaceId: actor.spaceId,
            kind: "decision-provider",
            ciphertext: stored.ciphertext,
          },
        });
        const data = {
          userId: actor.userId,
          provider: prepared.provider,
          settings: prepared.settings,
          secretId: secret.id,
        };
        const updated = await tx.spaceDecisionConfig.upsert({
          where: { spaceId: actor.spaceId },
          create: { spaceId: actor.spaceId, ...data },
          update: data,
        });
        if (existing && existing.secretId !== secret.id) {
          await tx.secret.deleteMany({ where: { id: existing.secretId } });
        }
        return updated;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
  return serializeSpaceDecisionConfig(config);
}

export function serializeSpaceDecisionConfig(config: {
  provider: string;
  settings: unknown;
  updatedAt: Date;
}) {
  return {
    provider: config.provider,
    settings: toStringRecord(config.settings),
    updatedAt: config.updatedAt.toISOString(),
  };
}

export async function disconnectDecisionProvider(deps: DecisionProviderConfigDeps, actor: Actor) {
  await requireSpaceOwner(deps.prisma, actor);
  await withSerializableRetry(() =>
    deps.prisma.$transaction(
      async (tx) => {
        const existing = await findSpaceDecisionConfig(tx, actor.spaceId);
        if (!existing) return;
        await tx.spaceDecisionConfig.delete({ where: { id: existing.id } });
        await tx.secret.deleteMany({ where: { id: existing.secretId } });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
  return { ok: true as const };
}
