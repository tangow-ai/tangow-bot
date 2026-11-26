import { randomBytes } from "node:crypto";
import { BotSecretDestination, SecretHttpRequest } from "@tangow/contracts";
import type { Prisma, PrismaClient } from "@tangow/db";
import { combineSignals, redactConnectorPayload } from "./connector-safety.js";
import { createSafeRemoteFetch, type RemoteTransportDependencies } from "./remote-mcp.js";
import type { EncryptedSecretStore } from "./secrets.js";
import { readBodyCapped, withAbort } from "./web-ssrf.js";

/** A credential belongs to a person in a space; every bot of theirs there can use it. */
export type BotSecretScope = { userId: string; spaceId: string };
function scopeFields({ userId, spaceId }: BotSecretScope): BotSecretScope {
  return { userId, spaceId };
}

/** Serializes saves and deletions in one person's vault, including concurrent first saves. */
async function lockScope(tx: Prisma.TransactionClient, { userId, spaceId }: BotSecretScope) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('bot-secrets'), hashtext(${`${userId}:${spaceId}`}))`;
}

const metadata = { name: true, origin: true, auth: true } as const;

function credentialHeader(destination: BotSecretDestination, plaintext: string) {
  const name = destination.auth.type === "header" ? destination.auth.name : "Authorization";
  const value =
    destination.auth.type === "bearer"
      ? `Bearer ${plaintext}`
      : destination.auth.type === "basic"
        ? `Basic ${Buffer.from(`${destination.auth.username}:${plaintext}`).toString("base64")}`
        : plaintext;
  try {
    const headers = new Headers({ [name]: value });
    if (headers.get(name) !== value) throw new Error("Header value was normalized");
  } catch {
    throw new Error("Credential cannot be used with this authentication method");
  }
  return { name, value };
}

export function normalizeSecretDestination(value: unknown): BotSecretDestination {
  const destination = BotSecretDestination.parse(value);
  return { ...destination, origin: new URL(destination.origin).origin };
}

export function sameSecretDestination(
  left: BotSecretDestination,
  right: BotSecretDestination,
): boolean {
  return (
    left.name === right.name &&
    left.origin === right.origin &&
    JSON.stringify(left.auth) === JSON.stringify(right.auth)
  );
}

export async function findBotSecret(prisma: PrismaClient, scope: BotSecretScope, name: string) {
  const row = await prisma.botSecret.findFirst({
    where: { ...scopeFields(scope), name },
    select: metadata,
  });
  return row ? normalizeSecretDestination(row) : null;
}

/**
 * Space roles that count for sharing. Spaces have owners and members only; any other role added
 * later (a guest, say) neither receives a shared key nor makes one usable.
 */
export const SHARING_ROLES = ["owner", "member"];

const nothing: Prisma.BotSecretWhereInput = { id: { in: [] } };

/**
 * The only rule for which saved keys a run may use on a bot, evaluated on every call. A key K is
 * usable by run R on bot X, all three in R's space, when either:
 * - own: R, X's owner and K's owner are the same person; or
 * - shared: R and X's owner are members, K's owner is a member who can see X, and R and X's owner
 *   are each K's owner, a person K is shared with, or (K shared with the whole space) any member.
 * Leaving the space, unsharing the bot or the key, or archiving the bot ends access on the next call.
 */
export async function usableSecretsWhere(
  prisma: PrismaClient,
  run: BotSecretScope,
  botId: string,
): Promise<Prisma.BotSecretWhereInput> {
  const { spaceId } = run;
  const bot = await prisma.bot.findFirst({
    where: { id: botId, spaceId, archivedAt: null },
    select: { userId: true, visibility: true, shares: { select: { userId: true } } },
  });
  if (!bot) return nothing;
  const people = [...new Set([run.userId, bot.userId])];
  const members = await prisma.spaceMember.count({
    where: { spaceId, userId: { in: people }, role: { in: SHARING_ROLES } },
  });
  const seeBot =
    bot.visibility === "space"
      ? {}
      : {
          userId: {
            in: [
              bot.userId,
              ...(bot.visibility === "people" ? bot.shares : []).map((s) => s.userId),
            ],
          },
        };
  const usable = [
    ...(run.userId === bot.userId ? [{ userId: run.userId }] : []),
    ...(members === people.length
      ? [
          {
            ...seeBot,
            user: {
              members: {
                some: { spaceMemberships: { some: { spaceId, role: { in: SHARING_ROLES } } } },
              },
            },
            OR: [
              { sharedWithSpace: true },
              {
                AND: people.map((userId) => ({
                  OR: [{ userId }, { shares: { some: { userId } } }],
                })),
              },
            ],
          },
        ]
      : []),
  ];
  return usable.length > 0 ? { spaceId, OR: usable } : nothing;
}

/** The run user's own key first, then everyone else's oldest first, so a name always resolves the same way. */
function byPreference<T extends { userId: string; createdAt: Date; id: string }>(
  rows: T[],
  userId: string,
): T[] {
  return rows.sort(
    (a, b) =>
      Number(b.userId === userId) - Number(a.userId === userId) ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/**
 * Names, sites and methods of the keys a run may use, each name once, never a value or owner.
 * `shared` marks a key someone else owns, whose site they chose: a key planted under a familiar
 * name to catch what the bot sends must not pass for the run user's own.
 */
export async function listUsableSecrets(
  prisma: PrismaClient,
  run: BotSecretScope,
  botId: string,
): Promise<Array<BotSecretDestination & { shared: boolean }>> {
  const rows = await prisma.botSecret.findMany({
    where: await usableSecretsWhere(prisma, run, botId),
    select: { ...metadata, id: true, userId: true, createdAt: true },
  });
  const byName = new Map<string, BotSecretDestination & { shared: boolean }>();
  for (const row of byPreference(rows, run.userId)) {
    if (!byName.has(row.name)) {
      byName.set(row.name, {
        ...normalizeSecretDestination(row),
        shared: row.userId !== run.userId,
      });
    }
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : 1)).slice(0, 100);
}

async function findUsableSecret(
  prisma: PrismaClient,
  run: BotSecretScope,
  botId: string,
  name: string,
) {
  const rows = await prisma.botSecret.findMany({
    where: { AND: [await usableSecretsWhere(prisma, run, botId), { name }] },
  });
  return byPreference(rows, run.userId)[0];
}

export async function storeBotSecret(input: {
  tx: Prisma.TransactionClient;
  secretStore: EncryptedSecretStore;
  scope: BotSecretScope;
  destination: BotSecretDestination;
  plaintext: string;
  createdByBotId?: string;
}): Promise<void> {
  const { tx, secretStore, scope, plaintext } = input;
  if (!plaintext || plaintext.length > 16_384) throw new Error("Invalid credential length");
  const destination = normalizeSecretDestination(input.destination);
  credentialHeader(destination, plaintext);
  await lockScope(tx, scope);
  const existing = await tx.botSecret.findFirst({
    where: { ...scopeFields(scope), name: destination.name },
  });
  if (existing && !sameSecretDestination(normalizeSecretDestination(existing), destination)) {
    throw new Error("Remove the existing credential before changing its destination");
  }
  if (!existing && (await tx.botSecret.count({ where: scopeFields(scope) })) >= 100) {
    throw new Error("Credential limit reached");
  }
  const id = existing?.id ?? randomBytes(12).toString("hex");
  const encrypted = await secretStore.put(
    plaintext,
    {
      operationId: id,
      traceId: id,
      userId: scope.userId,
      spaceId: scope.spaceId,
      signal: new AbortController().signal,
    },
    id,
  );
  if (existing) {
    await tx.botSecret.update({ where: { id }, data: { ciphertext: encrypted.ciphertext } });
  } else {
    await tx.botSecret.create({
      data: {
        id,
        ...scopeFields(scope),
        botId: input.createdByBotId ?? null,
        ...destination,
        ciphertext: encrypted.ciphertext,
      },
    });
  }
}

/** The person's own keys in the space and who each is shared with; never a value. */
export function listBotSecrets(prisma: PrismaClient, scope: BotSecretScope) {
  return prisma.botSecret.findMany({
    where: scopeFields(scope),
    select: {
      ...metadata,
      botId: true,
      sharedWithSpace: true,
      shares: { select: { userId: true }, orderBy: { createdAt: "asc" } },
    },
    orderBy: { name: "asc" },
    take: 100,
  });
}

/** Keys other members share with this person, while they can use them; never a value. */
export function listSecretsSharedWith(prisma: PrismaClient, scope: BotSecretScope) {
  const { userId, spaceId } = scope;
  return prisma.botSecret.findMany({
    where: {
      spaceId,
      userId: { not: userId },
      user: {
        members: { some: { spaceMemberships: { some: { spaceId, role: { in: SHARING_ROLES } } } } },
      },
      OR: [
        { shares: { some: { userId } } },
        {
          sharedWithSpace: true,
          space: { memberships: { some: { userId, role: { in: SHARING_ROLES } } } },
        },
      ],
    },
    select: { ...metadata, user: { select: { name: true } } },
    orderBy: [{ name: "asc" }, { createdAt: "asc" }],
    take: 100,
  });
}

/**
 * The owner chooses who a key is shared with: people of the space, and whether every current and
 * future member may use it. Never inferred from a bot's sharing.
 */
export async function shareBotSecret(
  prisma: PrismaClient,
  scope: BotSecretScope,
  input: { name: string; userIds: readonly string[]; space: boolean },
): Promise<void> {
  const userIds = [...new Set(input.userIds)].filter((id) => id !== scope.userId);
  await prisma.$transaction(async (tx) => {
    await lockScope(tx, scope);
    const secret = await tx.botSecret.findFirst({
      where: { ...scopeFields(scope), name: input.name },
      select: { id: true },
    });
    if (!secret) throw new Error("Credential not found");
    const members = await tx.spaceMember.count({
      where: { spaceId: scope.spaceId, userId: { in: userIds }, role: { in: SHARING_ROLES } },
    });
    if (members !== userIds.length)
      throw new Error("A key can only be shared with members of its space");
    await tx.botSecret.update({ where: { id: secret.id }, data: { sharedWithSpace: input.space } });
    await tx.botSecretShare.deleteMany({
      where: { secretId: secret.id, userId: { notIn: userIds } },
    });
    await tx.botSecretShare.createMany({
      data: userIds.map((userId) => ({ secretId: secret.id, spaceId: scope.spaceId, userId })),
      skipDuplicates: true,
    });
  });
}

export async function removeBotSecret(prisma: PrismaClient, scope: BotSecretScope, name: string) {
  await prisma.$transaction(async (tx) => {
    await lockScope(tx, scope);
    await tx.botSecret.deleteMany({ where: { ...scopeFields(scope), name } });
  });
}

/** Credentials are resolved only inside this destination-bound HTTP boundary. */
export async function requestWithBotSecret(input: {
  prisma: PrismaClient;
  secretStore: EncryptedSecretStore;
  run: BotSecretScope;
  botId: string;
  request: unknown;
  signal: AbortSignal;
  remote?: RemoteTransportDependencies;
  registerRedactions?: (values: string[]) => void;
}): Promise<unknown> {
  const request = SecretHttpRequest.parse(input.request);
  const row = await findUsableSecret(input.prisma, input.run, input.botId, request.name);
  // Missing, someone's private key, or a shared key outside the rule: one answer, no owner.
  if (!row) return { error: "Credential is unavailable. Use request_secret to save it first." };
  const destination = normalizeSecretDestination(row);
  const url = new URL(request.url);
  if (url.origin !== destination.origin || url.username || url.password || url.hash) {
    return { error: "This credential cannot be sent to that destination." };
  }
  const plaintext = input.secretStore.load(row.ciphertext, row.id);
  const headers = new Headers({ accept: "application/json", "content-type": request.contentType });
  const { name: headerName, value: headerValue } = credentialHeader(destination, plaintext);
  const redactions = [
    ...new Set([
      plaintext,
      headerValue,
      Buffer.from(plaintext).toString("base64"),
      encodeURIComponent(plaintext),
      headerValue.replace(/^Basic /, ""),
    ]),
  ].filter(Boolean);
  input.registerRedactions?.(redactions);
  const controller = new AbortController();
  const signal = combineSignals(input.signal, controller.signal, AbortSignal.timeout(30_000));
  const fetch = createSafeRemoteFetch(input.remote?.fetch, input.remote?.resolveHostname);
  try {
    headers.set(headerName, headerValue);
    const response = await withAbort(
      fetch(url, { method: request.method, headers, body: request.body, signal }),
      signal,
    );
    const bytes = await readBodyCapped(response, 1_000_000, signal);
    const text = new TextDecoder().decode(bytes);
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* Plain text responses are supported. */
    }
    // Redact before truncating, so an output boundary cannot expose part of a value.
    const safe = JSON.stringify(redactConnectorPayload(body, redactions));
    return {
      status: response.status,
      body: safe.length > 20_000 ? safe.slice(0, 20_000) : JSON.parse(safe),
      truncated: safe.length > 20_000,
    };
  } catch {
    return { error: "Authenticated request failed. Check the destination and credential." };
  } finally {
    controller.abort();
    await withAbort(fetch.close(), AbortSignal.timeout(1000)).catch(() => undefined);
  }
}
