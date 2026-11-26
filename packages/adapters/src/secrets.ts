import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import type { AdapterContext, SecretRecord, SecretStore } from "@tangow/adapter-kit";
import type { PrismaClient } from "@tangow/db";
import { getLogger } from "@tangow/logging";

const VERSION_PREFIX = "v2:";
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function legacyKeyFrom(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

function keyFrom(secret: string, salt: Buffer): Buffer {
  return scryptSync(secret, salt, 32, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

/** Each store's key, readable only in this module, so the legacy decryption stays private here. */
const storeKeys = new WeakMap<EncryptedSecretStore, string>();

export class EncryptedSecretStore implements SecretStore {
  constructor(private readonly encryptionKey: string) {
    storeKeys.set(this, encryptionKey);
  }

  describe() {
    return {
      id: "app-encrypted",
      contractVersion: "1",
      adapterVersion: "0.2.0",
      capabilities: { rotate: true },
    };
  }

  async put(
    plaintext: string,
    _context: AdapterContext,
    recordId = randomBytes(12).toString("hex"),
  ): Promise<SecretRecord> {
    return { id: recordId, ciphertext: this.seal(plaintext, recordId) };
  }

  private seal(plaintext: string, recordId: string): string {
    const salt = randomBytes(SALT_BYTES);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", keyFrom(this.encryptionKey, salt), iv);
    cipher.setAAD(Buffer.from(recordId));
    const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${VERSION_PREFIX}${Buffer.concat([salt, iv, tag, enc]).toString("base64")}`;
  }

  async get(id: string, _context: AdapterContext): Promise<string> {
    throw new Error(`SecretStore.get requires persistence; use load(${id})`);
  }

  load(ciphertext: string, recordId: string): string {
    if (ciphertext.startsWith(VERSION_PREFIX)) {
      const buf = Buffer.from(ciphertext.slice(VERSION_PREFIX.length), "base64");
      if (buf.length < SALT_BYTES + IV_BYTES + TAG_BYTES) {
        throw new Error("Encrypted secret is malformed");
      }
      const salt = buf.subarray(0, SALT_BYTES);
      const iv = buf.subarray(SALT_BYTES, SALT_BYTES + IV_BYTES);
      const tag = buf.subarray(SALT_BYTES + IV_BYTES, SALT_BYTES + IV_BYTES + TAG_BYTES);
      const enc = buf.subarray(SALT_BYTES + IV_BYTES + TAG_BYTES);
      const decipher = createDecipheriv("aes-256-gcm", keyFrom(this.encryptionKey, salt), iv);
      decipher.setAAD(Buffer.from(recordId));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
    }

    // Ciphertexts written before v2 are rewritten at startup by resealLegacySecrets.
    throw new Error("Encrypted secret uses an unsupported format");
  }

  redact(value: string): string {
    return value
      .replace(/sk-[a-zA-Z0-9-_]{8,}/g, "[redacted]")
      .replace(/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, "[redacted]");
  }
}

/** Ciphertexts written before v2: a single SHA-256 key derivation and no AAD. */
function openLegacy(ciphertext: string, encryptionKey: string): string {
  const buf = Buffer.from(ciphertext, "base64");
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const enc = buf.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", legacyKeyFrom(encryptionKey), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

type ResealTable = {
  rows(): Promise<Array<{ id: string; ciphertext: string }>>;
  /** Compare-and-swap: a row rewritten meanwhile (by another replica, or a new save) is left alone. */
  swap(id: string, from: string, to: string): Promise<number>;
  /** The record id each table's reader binds its ciphertext to. */
  aad(id: string): string;
};

const legacy = { not: { startsWith: VERSION_PREFIX } };

function resealTables(prisma: PrismaClient): Record<string, ResealTable> {
  return {
    secrets: {
      rows: () =>
        prisma.secret.findMany({
          where: { ciphertext: legacy },
          select: { id: true, ciphertext: true },
        }),
      swap: async (id, from, to) =>
        (
          await prisma.secret.updateMany({
            where: { id, ciphertext: from },
            data: { ciphertext: to },
          })
        ).count,
      aad: (id) => id,
    },
    mcp_oauth_sessions: {
      rows: async () =>
        (
          await prisma.mcpOAuthSession.findMany({
            where: { oauthCiphertext: legacy },
            select: { id: true, oauthCiphertext: true },
          })
        ).map((row) => ({ id: row.id, ciphertext: row.oauthCiphertext })),
      swap: async (id, from, to) =>
        (
          await prisma.mcpOAuthSession.updateMany({
            where: { id, oauthCiphertext: from },
            data: { oauthCiphertext: to },
          })
        ).count,
      aad: (id) => id,
    },
    bot_secrets: {
      rows: () =>
        prisma.botSecret.findMany({
          where: { ciphertext: legacy },
          select: { id: true, ciphertext: true },
        }),
      swap: async (id, from, to) =>
        (
          await prisma.botSecret.updateMany({
            where: { id, ciphertext: from },
            data: { ciphertext: to },
          })
        ).count,
      aad: (id) => id,
    },
    integration_provider_configs: {
      rows: () =>
        prisma.integrationProviderConfig.findMany({
          where: { ciphertext: legacy },
          select: { id: true, ciphertext: true },
        }),
      swap: async (id, from, to) =>
        (
          await prisma.integrationProviderConfig.updateMany({
            where: { id, ciphertext: from },
            data: { ciphertext: to },
          })
        ).count,
      aad: (id) => `integration-provider:${id}`,
    },
  };
}

export type ResealCounts = Record<string, { resealed: number; failed: number }>;

/**
 * Rewrites every pre-v2 ciphertext as v2, bound to the record id its reader uses. Run by the API
 * and the worker before serving; idempotent, and safe with several replicas. A row that does not
 * decrypt is kept untouched and counted. Logs counters per table only.
 */
export async function resealLegacySecrets(
  prisma: PrismaClient,
  store: EncryptedSecretStore,
): Promise<ResealCounts> {
  const key = storeKeys.get(store);
  if (key === undefined) throw new Error("Unknown secret store");
  const counts: ResealCounts = {};
  for (const [table, spec] of Object.entries(resealTables(prisma))) {
    const count = { resealed: 0, failed: 0 };
    for (const row of await spec.rows()) {
      let next: string;
      try {
        next = (await store.put(openLegacy(row.ciphertext, key), resealContext, spec.aad(row.id)))
          .ciphertext;
      } catch {
        count.failed += 1;
        continue;
      }
      count.resealed += await spec.swap(row.id, row.ciphertext, next);
    }
    counts[table] = count;
    // One line per table, keyed so log redaction (which hides any "secret" key) keeps the counts.
    getLogger().info("secrets.resealed", { table, ...count });
  }
  return counts;
}

const resealContext: AdapterContext = {
  operationId: "reseal",
  traceId: "reseal",
  spaceId: "",
  userId: "",
  signal: new AbortController().signal,
};
