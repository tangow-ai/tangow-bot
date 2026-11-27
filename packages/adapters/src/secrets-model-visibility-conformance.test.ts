import type { AgentRunRequest } from "@tangow/adapter-kit";
import type { BotSecretDestination } from "@tangow/contracts";
import type { PrismaClient } from "@tangow/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApprovalAskBlock } from "./approval-ask.js";
import { redactToolArgsForReview } from "./auto-review.js";
import { requestWithBotSecret } from "./bot-secrets.js";
import { sanitizeComposioError } from "./composio-connector.js";
import { redactConnectorPayload, sanitizeConnectorError } from "./connector-safety.js";
import { createRunExecutor } from "./executor.js";
import { FakeWebProvider } from "./fake-web.js";
import { McpConnector } from "./mcp-connector.js";
import type { OAuthMaterial } from "./mcp-oauth.js";
import { oauthMaterialSecrets } from "./mcp-oauth.js";
import { EncryptedSecretStore } from "./secrets.js";
import { recordingSessionLog } from "./session-log/recording.test-support.js";

/**
 * Offline conformance: bot secrets and connector OAuth material must never
 * appear in model-visible tool args/results (or review/approval payloads that
 * feed the model). Prefer existing redaction/injection boundaries.
 *
 * Intentionally does not cover email OTP / magic-link / reset URL redaction.
 */

const OAUTH_ACCESS = "oauth-access-token-conformance-value";
const OAUTH_REFRESH = "oauth-refresh-token-conformance-value";
const OAUTH_CLIENT_SECRET = "oauth-client-secret-conformance-value";
const BOT_SECRET = "bot-secret-conformance-value+/=";

function assertNoLeak(visible: unknown, secrets: string[]) {
  const serialized = JSON.stringify(visible);
  for (const secret of secrets) {
    expect(serialized, `leaked ${secret}`).not.toContain(secret);
  }
}

describe("secrets model-visibility conformance", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("shared connector redaction boundary", () => {
    it("strips OAuth access, refresh, and client secrets from tool payloads", () => {
      const secrets = [OAUTH_ACCESS, OAUTH_REFRESH, OAUTH_CLIENT_SECRET];
      const payload = {
        access_token: OAUTH_ACCESS,
        nested: {
          refresh_token: OAUTH_REFRESH,
          authorization: `Bearer ${OAUTH_ACCESS}`,
        },
        client_secret: OAUTH_CLIENT_SECRET,
        ok: true,
      };
      const redacted = redactConnectorPayload(payload, secrets);
      assertNoLeak(redacted, secrets);
      expect(redacted).toMatchObject({ ok: true });
    });

    it("strips registered secrets and Bearer tokens from connector errors", () => {
      const message = sanitizeConnectorError(
        new Error(`upstream rejected Bearer ${OAUTH_ACCESS} client_secret=${OAUTH_CLIENT_SECRET}`),
        [OAUTH_ACCESS, OAUTH_CLIENT_SECRET],
      );
      assertNoLeak(message, [OAUTH_ACCESS, OAUTH_CLIENT_SECRET]);
      expect(message).toContain("Bearer [redacted]");
    });
  });

  describe("oauth material collection", () => {
    it("redacts Cookie/X-Session and short auth material without corrupting config enums", () => {
      const material: OAuthMaterial = {
        secret: "Bearer static-mcp-token-value",
        env: {
          API_TOKEN: "env-mcp-token-value",
          API_SECRET: "production",
          NODE_ENV: "production",
          AUTH_MODE: "oauth",
          SESSION_TIMEOUT: "3600",
          COOKIE_DOMAIN: "example.test",
          SHORT_API_KEY: "ab12",
          ACCESS_TOKEN: "123456",
        },
        headers: {
          "X-Api-Key": "header-mcp-token-value",
          Cookie: "sid=x",
          "X-Session": "s1",
          "X-Env": "info",
        },
        oauth: {
          tokens: {
            access_token: OAUTH_ACCESS,
            refresh_token: OAUTH_REFRESH,
            token_type: "bearer",
          },
          clientInformation: {
            client_id: "client-id",
            client_secret: OAUTH_CLIENT_SECRET,
          },
        },
      };
      const secrets = oauthMaterialSecrets(material);
      expect(secrets).toEqual(
        expect.arrayContaining([
          "Bearer static-mcp-token-value",
          "static-mcp-token-value",
          "env-mcp-token-value",
          "header-mcp-token-value",
          "sid=x",
          "s1",
          "ab12",
          "123456",
          OAUTH_ACCESS,
          OAUTH_REFRESH,
          OAUTH_CLIENT_SECRET,
        ]),
      );
      // Ordinary config must not enter global substring redaction.
      expect(secrets).not.toContain("production");
      expect(secrets).not.toContain("info");
      expect(secrets).not.toContain("oauth");
      expect(secrets).not.toContain("3600");
      expect(secrets).not.toContain("example.test");

      const payload = {
        ok: true,
        note: "deployed to production with oauth mode",
        cookie: "sid=x",
        session: "s1",
        shortKey: "ab12",
        numericToken: "123456",
      };
      const redacted = redactConnectorPayload(payload, secrets);
      expect(redacted).toMatchObject({
        ok: true,
        note: "deployed to production with oauth mode",
      });
      expect(JSON.stringify(redacted)).not.toContain("sid=x");
      expect(JSON.stringify(redacted)).not.toContain('"s1"');
      expect(JSON.stringify(redacted)).not.toContain("ab12");
      expect(JSON.stringify(redacted)).not.toContain("123456");
      expect(JSON.stringify(redacted)).toContain("production");
      expect(JSON.stringify(redacted)).toContain("oauth");
    });

    it("picks up rotated access tokens from the live material object", () => {
      const material: OAuthMaterial = {
        oauth: {
          tokens: {
            access_token: "oauth-access-token-before-rotation",
            refresh_token: OAUTH_REFRESH,
            token_type: "bearer",
          },
        },
      };
      expect(oauthMaterialSecrets(material)).toContain("oauth-access-token-before-rotation");
      material.oauth!.tokens!.access_token = "oauth-access-token-after-rotation";
      const secrets = oauthMaterialSecrets(material);
      expect(secrets).toContain("oauth-access-token-after-rotation");
      expect(secrets).not.toContain("oauth-access-token-before-rotation");
    });

    it("registers numeric-only values under explicit credential keys", () => {
      const secrets = oauthMaterialSecrets({
        env: {
          ACCESS_TOKEN: "123456",
          API_SECRET: "production",
          REFRESH_TOKEN_TIMEOUT: "3600",
        },
      });
      expect(secrets).toContain("123456");
      expect(secrets).not.toContain("production");
      expect(secrets).not.toContain("3600");
    });
  });

  describe("bot secret_request boundary", () => {
    it("never returns bot-secret plaintext in the tool result", async () => {
      const scope = { userId: "user-1", spaceId: "space-1", botId: "bot-1" };
      const destination: BotSecretDestination = {
        name: "example_api",
        origin: "https://api.example.test",
        auth: { type: "bearer" },
      };
      const secretStore = new EncryptedSecretStore("test-only-encryption-key");
      const encrypted = await secretStore.put(
        BOT_SECRET,
        {
          ...scope,
          operationId: "test",
          traceId: "test",
          signal: new AbortController().signal,
        },
        "secret-1",
      );
      const row = { ...scope, ...destination, ...encrypted, createdAt: new Date() };
      const prisma = {
        bot: {
          findFirst: async () => ({ userId: scope.userId, visibility: "private", shares: [] }),
        },
        spaceMember: { count: async () => 1 },
        botSecret: { findMany: async () => [row] },
      } as unknown as PrismaClient;
      const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
        expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${BOT_SECRET}`);
        return Response.json({
          echo: BOT_SECRET,
          authorization: `Bearer ${BOT_SECRET}`,
          items: [1],
        });
      });
      const registerRedactions = vi.fn();
      const result = await requestWithBotSecret({
        prisma,
        secretStore: secretStore,
        run: scope,
        botId: scope.botId,
        request: { name: destination.name, url: `${destination.origin}/v1/items` },
        signal: new AbortController().signal,
        remote: {
          fetch,
          resolveHostname: async () => [{ address: "8.8.8.8", family: 4 as const }],
        },
        registerRedactions,
      });
      assertNoLeak(result, [BOT_SECRET, `Bearer ${BOT_SECRET}`]);
      expect(registerRedactions).toHaveBeenCalledWith(expect.arrayContaining([BOT_SECRET]));
    });
  });

  describe("MCP connector OAuth boundary", () => {
    it("redacts OAuth tokens and client secrets echoed by tool results", async () => {
      const material: OAuthMaterial = {
        secret: "mcp-static-token",
        oauth: {
          tokens: {
            access_token: OAUTH_ACCESS,
            refresh_token: OAUTH_REFRESH,
            token_type: "bearer",
          },
          clientInformation: {
            client_id: "mcp-client",
            client_secret: OAUTH_CLIENT_SECRET,
          },
        },
      };
      const server = {
        id: "server-1",
        slug: "demo",
        transport: "streamable_http",
        endpoint: "https://mcp.example.test/mcp",
        secretId: "secret-1",
        args: [],
        revision: 1,
      };
      const assignment = {
        botId: "bot-1",
        serverId: "server-1",
        spaceId: "w1",
        userId: "u1",
        allowAllTools: true,
        allowedTools: [],
        server,
      };
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(input, init);
          const message = JSON.parse(await request.text()) as {
            id?: number;
            method?: string;
          };
          if (message.method === "initialize") {
            return Response.json({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion: "2025-11-25",
                capabilities: { tools: {} },
                serverInfo: { name: "test", version: "1" },
              },
            });
          }
          if (message.method === "tools/list") {
            return Response.json({
              jsonrpc: "2.0",
              id: message.id,
              result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] },
            });
          }
          if (message.method === "tools/call") {
            return Response.json({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      access_token: OAUTH_ACCESS,
                      refresh_token: OAUTH_REFRESH,
                      client_secret: OAUTH_CLIENT_SECRET,
                      static: material.secret,
                    }),
                  },
                ],
              },
            });
          }
          return new Response(null, { status: 202 });
        }),
      );

      const prisma = {
        botMcpServer: {
          findMany: vi.fn().mockResolvedValue([assignment]),
          findFirst: vi.fn().mockResolvedValue(assignment),
        },
        secret: {
          findFirst: vi.fn().mockResolvedValue({ id: "secret-1", ciphertext: "encrypted" }),
        },
      };
      const secrets = {
        load: vi.fn().mockReturnValue(JSON.stringify(material)),
      };
      const connector = new McpConnector(prisma as never, secrets as never, {
        network: {
          fetch: (input: string | URL | Request, init?: RequestInit) =>
            globalThis.fetch(input, init),
          resolveHostname: async () => [{ address: "8.8.8.8", family: 4 }],
        },
      });
      const context = {
        spaceId: "w1",
        userId: "u1",
        botId: "bot-1",
        signal: new AbortController().signal,
      } as never;

      const events = [];
      for await (const event of connector.execute(
        {
          tool: "mcp__demo__echo",
          args: {},
          route: { connectorId: "mcp", resourceId: "server-1", toolName: "echo" },
        } as never,
        context,
      )) {
        events.push(event);
      }

      expect(events[0]).toMatchObject({ type: "result" });
      assertNoLeak(events, [OAUTH_ACCESS, OAUTH_REFRESH, OAUTH_CLIENT_SECRET, "mcp-static-token"]);
      await connector.close();
    });
  });

  describe("executor tool results", () => {
    it("masks a run secret that a tool result echoes before the runtime gets it", async () => {
      const run = {
        id: "run-1",
        botId: "bot-1",
        threadId: "thread-1",
        taskId: "task-1",
        spaceId: "space-1",
        userId: "user-1",
        status: "queued",
        trigger: "user",
        leaseFence: 0,
      };
      const log = recordingSessionLog();
      const prisma = {
        sessionEntry: log.sessionEntry,
        $queryRaw: log.queryRaw,
        $transaction: async (work: (tx: unknown) => unknown) => work(prisma),
        run: {
          findMany: async () => [],
          findUnique: async () => run,
          findUniqueOrThrow: async () => run,
          updateMany: async ({ data }: { data: Record<string, unknown> }) => {
            Object.assign(run, data);
            return { count: 1 };
          },
        },
        bot: {
          findFirst: async () => ({ visibility: "private" }),
          findUniqueOrThrow: async () => ({ id: run.botId, userId: run.userId, name: "Bot" }),
          findMany: async () => [],
        },
        attempt: {
          count: async () => 0,
          create: async () => ({ id: "attempt-1" }),
          update: async () => undefined,
          updateMany: async () => ({ count: 1 }),
        },
        thread: { findUniqueOrThrow: async () => ({ id: run.threadId, groupId: null }) },
        task: { findUniqueOrThrow: async () => ({ id: run.taskId, prompt: "Read the page" }) },
        connection: { findMany: async () => [] },
        spaceMember: { findUnique: async () => ({ modelAuto: false }) },
        spaceModelCategory: { findMany: async () => [] },
        spaceModelPreference: { findFirst: async () => null },
        userModelCredential: { findFirst: async () => null },
        deploymentSettings: {
          findUnique: async () => ({
            defaultModelProvider: "scripted",
            defaultModelId: "scripted",
          }),
        },
        taughtSkill: { findMany: async () => [], findFirst: async () => null },
        agentSecret: { findMany: async () => [] },
        agentSkill: { findMany: async () => [] },
        skillSetting: { findMany: async () => [] },
        botSkill: { findMany: async () => [] },
        scratchpadItem: { findMany: async () => [] },
        actionApprovalRule: { findMany: async () => [] },
        actionAutoReviewPreference: { findUnique: async () => null },
        externalEffect: {
          findMany: async () => [],
          findUnique: async () => null,
          create: async ({ data }: { data: object }) => ({ ...data, id: "effect-1" }),
          update: async () => undefined,
          updateMany: async () => ({ count: 1 }),
        },
      };
      const web = new FakeWebProvider();
      web.fetchResult = {
        url: "https://dashboard.example.test/keys",
        title: "API keys",
        text: `Your key: ${BOT_SECRET}`,
        truncated: false,
      };
      let result: unknown;
      const executor = createRunExecutor({
        sessionLog: log.sessionLog,
        prisma,
        runtime: {
          describe: () => ({ capabilities: { scripted: false } }),
          async *run(request: AgentRunRequest) {
            result = await request.executeTool!("web_fetch", { url: web.fetchResult.url }, "c1");
            yield { type: "done" as const, text: "Done" };
          },
        },
        web,
        memory: { read: async () => ({ documents: [] }) },
        memoryProviders: { resolve: async () => null },
        events: {
          append: async () => undefined,
          finalizeRun: async () => ({ continuationRunId: null }),
        },
        jobs: { enqueue: async () => undefined },
        secrets: [BOT_SECRET],
      } as unknown as Parameters<typeof createRunExecutor>[0]);

      await executor.continueRun(run.id, "worker-1");

      assertNoLeak(result, [BOT_SECRET]);
      expect(result).toMatchObject({ title: "API keys", text: "Your key: [redacted]" });
    });
  });

  describe("Composio pattern redaction", () => {
    it("redacts API keys and Bearer tokens from connector errors", () => {
      const message = sanitizeComposioError(
        "denied ak_secretvaluehere COMPOSIO_API_KEY=ak_shouldnotleak Bearer tok_abc",
      );
      expect(message).not.toContain("ak_secretvaluehere");
      expect(message).not.toContain("ak_shouldnotleak");
      expect(message).not.toContain("tok_abc");
      expect(message).toContain("[redacted]");
    });
  });

  describe("model-visible review and approval payloads", () => {
    it("redacts secrets from approval ask blocks and auto-review tool args", () => {
      const secrets = [OAUTH_ACCESS, OAUTH_CLIENT_SECRET, BOT_SECRET];
      const args = {
        to: "person@example.test",
        body: `use ${OAUTH_ACCESS} and ${BOT_SECRET}`,
        client_secret: OAUTH_CLIENT_SECRET,
      };
      const ask = buildApprovalAskBlock("effect-1", "gmail_send_email", args, secrets);
      assertNoLeak(ask, secrets);

      const reviewArgs = redactToolArgsForReview(args, secrets);
      assertNoLeak(reviewArgs, secrets);
    });
  });
});
