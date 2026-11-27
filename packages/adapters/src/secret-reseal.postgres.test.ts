import { createCipheriv, createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "@tangow/db";
import { createDb } from "@tangow/db";
import { createLogger, createTestSink, installLogger } from "@tangow/logging";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { requestWithBotSecret } from "./bot-secrets.js";
import { IntegrationProviderSettings } from "./integration-provider-settings.js";
import { McpOAuthBroker } from "./mcp-oauth.js";
import { EncryptedSecretStore, resealLegacySecrets } from "./secrets.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

const KEY = "test-only-reseal-encryption-key";
const id = (name: string) => `${name}-${stamp}`;
const stamp = randomBytes(4).toString("hex");

/** How ciphertexts were written before v2: SHA-256 key, no AAD. Test-local, no production seam. */
function legacySeal(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(KEY).digest(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64");
}

const oauth = JSON.stringify({
  oauth: { tokens: { access_token: "fake-token", token_type: "bearer" } },
});
const botKey = "fake-bot-api-key";
const composioKey = "fake-composio-key";
const corrupt = Buffer.from("not a real ciphertext at all").toString("base64");

describePostgres("resealing pre-v2 ciphertexts", () => {
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  const store = new EncryptedSecretStore(KEY);
  const actor = { spaceId: id("space"), userId: id("user") };
  const server = { id: id("server"), endpoint: "https://mcp.example.test", secretId: id("mcp") };
  const seeded: string[] = [];

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = () => db.pool.end();
    await prisma.user.create({
      data: { id: actor.userId, name: "A", email: `${stamp}@tangow.test` },
    });
    await prisma.organization.create({
      data: { id: id("org"), name: "O", slug: id("org"), createdAt: new Date() },
    });
    await prisma.space.create({
      data: { id: actor.spaceId, organizationId: id("org"), name: "S" },
    });
    await prisma.bot.create({
      data: { id: id("bot"), ...actor, name: "Bot", color: "#00C46A" },
    });
    const rows = {
      mcp: legacySeal(oauth),
      bad: corrupt,
      session: legacySeal(oauth),
      bot: legacySeal(botKey),
      provider: legacySeal(JSON.stringify({ provider: "composio", apiKey: composioKey })),
    };
    seeded.push(...Object.values(rows));
    await prisma.secret.createMany({
      data: [
        { id: server.secretId, ...actor, kind: "mcp", ciphertext: rows.mcp },
        { id: id("bad"), ...actor, kind: "memory", ciphertext: rows.bad },
      ],
    });
    await prisma.mcpServer.create({
      data: { ...server, ...actor, slug: id("mcp"), name: "MCP", transport: "http" },
    });
    await prisma.mcpOAuthSession.create({
      data: {
        id: id("session"),
        ...actor,
        serverId: server.id,
        endpoint: server.endpoint,
        redirectUri: "https://tangow.test/callback",
        oauthCiphertext: rows.session,
      },
    });
    await prisma.botSecret.create({
      data: {
        id: id("bot-secret"),
        ...actor,
        name: "example_api",
        origin: "https://api.example.test",
        auth: { type: "bearer" },
        ciphertext: rows.bot,
      },
    });
    await prisma.integrationProviderConfig.create({
      data: { id: "composio", ciphertext: rows.provider },
    });
  });
  afterAll(async () => {
    await prisma?.integrationProviderConfig.deleteMany({ where: { id: "composio" } });
    await prisma?.organization.deleteMany({ where: { id: id("org") } });
    await prisma?.user.deleteMany({ where: { id: actor.userId } });
    await close?.();
  });

  it("rewrites every readable row as v2 for its own reader, keeps and counts the rest", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "tangow-api", sinks: [sink] }));
    const broker = new McpOAuthBroker(prisma, store);
    // Before: the readers accept only v2.
    expect(await broker.statusFor(server, actor)).toBe("none");

    expect(await resealLegacySecrets(prisma, store)).toEqual({
      secrets: { resealed: 1, failed: 1 },
      mcp_oauth_sessions: { resealed: 1, failed: 0 },
      bot_secrets: { resealed: 1, failed: 0 },
      integration_provider_configs: { resealed: 1, failed: 0 },
    });

    // secrets: the MCP broker reads its server's material by the row id.
    expect(await broker.statusFor(server, actor)).toBe("connected");
    // mcp_oauth_sessions: the same reader, bound to the session id as on completion.
    const session = await prisma.mcpOAuthSession.findUniqueOrThrow({
      where: { id: id("session") },
    });
    expect(broker.statusForCiphertext(session.oauthCiphertext, session.id)).toBe("connected");
    expect(broker.statusForCiphertext(session.oauthCiphertext, server.secretId)).toBe("none");
    // bot_secrets: the authenticated request sends the original key.
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ ok: true }));
    await requestWithBotSecret({
      prisma,
      secretStore: store,
      run: actor,
      botId: id("bot"),
      request: { name: "example_api", url: "https://api.example.test/v1" },
      signal: new AbortController().signal,
      remote: { fetch, resolveHostname: async () => [{ address: "8.8.8.8", family: 4 }] },
    });
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
      `Bearer ${botKey}`,
    );
    // integration_provider_configs: provider settings parse the original configuration.
    const factory = vi.fn(() => ({}) as never);
    await new IntegrationProviderSettings(prisma, store, {}, factory).resolve("composio");
    expect(factory).toHaveBeenCalledWith({ provider: "composio", apiKey: composioKey });

    // The row that does not decrypt is kept as it was.
    expect((await prisma.secret.findUniqueOrThrow({ where: { id: id("bad") } })).ciphertext).toBe(
      corrupt,
    );

    // Counters only: no row id, value, ciphertext, length or exception text.
    expect(sink.events.map(({ table, resealed, failed }) => ({ table, resealed, failed }))).toEqual(
      [
        { table: "secrets", resealed: 1, failed: 1 },
        { table: "mcp_oauth_sessions", resealed: 1, failed: 0 },
        { table: "bot_secrets", resealed: 1, failed: 0 },
        { table: "integration_provider_configs", resealed: 1, failed: 0 },
      ],
    );
    const logged = JSON.stringify(sink.events);
    const current = [
      (await prisma.secret.findUniqueOrThrow({ where: { id: server.secretId } })).ciphertext,
      session.oauthCiphertext,
    ];
    for (const text of [
      ...seeded,
      ...current,
      stamp,
      botKey,
      composioKey,
      "fake-token",
      "length",
    ]) {
      expect(logged).not.toContain(text);
    }

    // A second pass finds nothing left to rewrite.
    expect(await resealLegacySecrets(prisma, store)).toEqual({
      secrets: { resealed: 0, failed: 1 },
      mcp_oauth_sessions: { resealed: 0, failed: 0 },
      bot_secrets: { resealed: 0, failed: 0 },
      integration_provider_configs: { resealed: 0, failed: 0 },
    });
  });
});
