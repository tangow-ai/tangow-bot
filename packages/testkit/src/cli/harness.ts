import { execSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import path from "node:path";
import { loadRootEnv } from "@tangow/core/node/load-root-env";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { createApp } from "../../../../apps/api/src/app.ts";
import { fileUrlToRepoFile, touchedFiles, writeImpactMap } from "../e2e-impact.js";
import { runProcess } from "./process.js";

loadRootEnv();

const integration = process.argv.includes("--integration");
const e2e = process.argv.includes("--e2e");
const impact = process.argv.includes("--impact");
const ui = process.argv.includes("--ui");
const record = process.argv.includes("--record") || Boolean(process.env.CI);
const sandboxArg = process.argv.find((arg) => arg.startsWith("--sandbox="));
const specArg = process.argv.find((arg) => arg.startsWith("--spec="));
const grepArg = process.argv.find((arg) => arg.startsWith("--grep="));
const sandboxProvider = sandboxArg?.slice("--sandbox=".length) ?? "fake";
const e2eSpecs = specArg?.slice("--spec=".length).split(",").filter(Boolean) ?? [];
const e2eGrep = grepArg?.slice("--grep=".length);

if (Number(integration) + Number(e2e) !== 1) {
  throw new Error("Pass exactly one of --integration or --e2e");
}
if (impact && (!e2e || e2eSpecs.length > 0 || e2eGrep)) {
  throw new Error("--impact records the whole e2e suite; pass it with --e2e only");
}
if (ui && (!e2e || impact || process.env.CI || sandboxProvider !== "fake")) {
  throw new Error("--ui requires local e2e with the fake sandbox, without --impact");
}
if (!["fake", "e2b"].includes(sandboxProvider)) {
  throw new Error('Sandbox must be "fake" or "e2b"');
}
if (integration && sandboxProvider !== "fake") {
  throw new Error("Integration tests only support the fake sandbox");
}
if (sandboxProvider === "e2b" && !process.env.E2B_API_KEY) {
  throw new Error("E2B_API_KEY is required when --sandbox=e2b");
}

async function main() {
  const mode = integration ? "integration" : "e2e";
  const reportDir = path.resolve("test-report", mode);
  await mkdir(reportDir, { recursive: true });
  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  try {
    const databaseUrl = container.getConnectionUri();
    const apiPort = Number(process.env.API_PORT ?? 3110);
    const webPort = Number(process.env.WEB_PORT ?? 5180);
    const webOrigin = `http://127.0.0.1:${webPort}`;

    process.env.DATABASE_URL = databaseUrl;
    process.env.REALTIME_DATABASE_URL = databaseUrl;
    process.env.VERIFY_DATABASE = "1";
    process.env.WAKEUP_DRIVER = "memory";
    process.env.SANDBOX_PROVIDER = sandboxProvider;
    process.env.AGENT_RUNTIME = "scripted";
    process.env.COMPOSIO_API_KEY = "";
    process.env.BETTER_AUTH_SECRET = "test-secret-test-secret-32chars!";
    process.env.ENCRYPTION_KEY = "test-encryption-key-test-encryption-key";
    process.env.SANDBOX_SUPERVISOR_TOKEN = "test-supervisor-token-test-32chars";
    process.env.SCREEN_PROXY_SECRET = "test-screen-proxy-secret-test-32chars";
    process.env.BETTER_AUTH_URL = webOrigin;
    process.env.WEB_ORIGIN = webOrigin;
    process.env.API_PORT = String(apiPort);
    process.env.API_URL = `http://127.0.0.1:${apiPort}`;
    process.env.API_PROXY_TARGET = `http://127.0.0.1:${apiPort}`;
    process.env.WEB_PORT = String(webPort);
    process.env.PLAYWRIGHT_BASE_URL = webOrigin;
    process.env.DATA_DIR = path.join(reportDir, "data");
    process.env.SIGNUPS_ENABLED = "true";
    process.env.SIGNUP_ALLOWLIST = "";
    process.env.CI = "1";

    execSync("pnpm --filter @tangow/db generate", { stdio: "inherit", env: process.env });
    execSync("pnpm --filter @tangow/db exec prisma migrate deploy", {
      stdio: "inherit",
      env: process.env,
      cwd: path.resolve("packages/db"),
    });

    if (integration) {
      const suites = [
        "packages/testkit/src/executor-worker-helper.test.ts",
        "packages/testkit/src/worker-skills.test.ts",
        "packages/testkit/src/eval-history.postgres.test.ts",
        "packages/testkit/src/journeys.test.ts",
        "packages/testkit/src/authorization.test.ts",
        "packages/testkit/src/attachments.test.ts",
        "packages/testkit/src/voice.test.ts",
        "packages/testkit/src/search.test.ts",
        "packages/testkit/src/executor-lifecycle.test.ts",
        "packages/testkit/src/connections.test.ts",
        "packages/testkit/src/tangow-setup.postgres.test.ts",
        "packages/testkit/src/bot-secrets.test.ts",
        "apps/api/src/model-routing.postgres.test.ts",
        "packages/db/src/sessions.postgres.test.ts",
        "packages/db/src/drop-messages.postgres.test.ts",
        "packages/db/src/messaging.postgres.test.ts",
        "packages/memory/src/commit.postgres.test.ts",
        "packages/adapters/src/wakeup.postgres.test.ts",
        "packages/adapters/src/realtime.postgres.test.ts",
        "packages/adapters/src/secret-reseal.postgres.test.ts",
        "packages/adapters/src/job-reconciler.postgres.test.ts",
        "packages/adapters/src/executor-run-log.postgres.test.ts",
        "packages/adapters/src/skill-lock.postgres.test.ts",
        "packages/adapters/src/worker-lifecycle.postgres.test.ts",
      ];
      // Each app reconciles all durable work in its database, including intentionally
      // unfinished fixture runs. Clone the pristine migrated schema so one suite
      // cannot execute another suite's backlog or wait for it during shutdown.
      const template = container.getDatabase().replaceAll('"', '""');
      const databaseCommand = async (statement: string) => {
        const result = await container.exec([
          "psql",
          "-U",
          container.getUsername(),
          "-d",
          "postgres",
          "-v",
          "ON_ERROR_STOP=1",
          "-c",
          statement,
        ]);
        if (result.exitCode !== 0)
          throw new Error("Isolated integration database operation failed");
      };
      for (const [index, suite] of suites.entries()) {
        const database = `integration_${index}`;
        await databaseCommand(`CREATE DATABASE "${database}" TEMPLATE "${template}"`);
        const suiteUrl = new URL(databaseUrl);
        suiteUrl.pathname = `/${database}`;
        try {
          await runProcess("pnpm", ["exec", "vitest", "run", suite], {
            ...process.env,
            DATABASE_URL: suiteUrl.toString(),
            REALTIME_DATABASE_URL: suiteUrl.toString(),
            OPENROUTER_API_KEY: "",
            MODEL_API_KEY: "",
          });
        } finally {
          await databaseCommand(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
        }
      }
      await writeSummary(reportDir, {
        ok: true,
        mode,
        sandbox: process.env.SANDBOX_PROVIDER,
      });
      return;
    }

    // Started before the API loads so every API function call is counted.
    const apiCoverage = impact ? await startApiCoverage() : undefined;
    const impactDir = path.join(reportDir, "impact");
    if (impact) {
      await rm(impactDir, { recursive: true, force: true });
      await mkdir(impactDir, { recursive: true });
      process.env.E2E_IMPACT_DIR = impactDir;
    }
    const [{ ComposioEmulator, EmailEmulator, ThirdPartyConnectorEmulator }, { createApp }] =
      await Promise.all([import("@tangow/adapters"), import("../../../../apps/api/src/app.ts")]);
    const { serve } = await import("@hono/node-server");
    const thirdParties = new ThirdPartyConnectorEmulator();
    const email = new EmailEmulator();
    const handles = await createApp({
      databaseUrl,
      prisma: undefined,
      composio: new ComposioEmulator(),
      email,
      remoteConnectors: {
        fetch: thirdParties.fetch,
        resolveHostname: thirdParties.resolveHostname,
      },
    });
    let activeRequests = 0;
    const requestWaiters = new Set<() => void>();
    const server = serve({
      fetch: async (request) => {
        const { pathname } = new URL(request.url);
        if (pathname === "/__e2e/emails") {
          return Response.json(email.sent, { headers: { "cache-control": "no-store" } });
        }
        if (pathname === "/__e2e/impact" && apiCoverage) {
          return Response.json(await apiCoverage(), { headers: { "cache-control": "no-store" } });
        }
        activeRequests += 1;
        try {
          return await handles.app.fetch(request);
        } finally {
          activeRequests -= 1;
          if (activeRequests === 0) {
            for (const resolve of requestWaiters) resolve();
            requestWaiters.clear();
          }
        }
      },
      port: apiPort,
      hostname: "127.0.0.1",
    });
    await waitForHealth(`http://127.0.0.1:${apiPort}/health`, 15_000);

    try {
      try {
        await runProcess(
          "pnpm",
          [
            "--filter",
            "@tangow/web",
            "exec",
            "playwright",
            "test",
            ...e2eSpecs,
            ...(e2eGrep ? ["--grep", e2eGrep] : []),
            ...(ui ? ["--ui"] : []),
            // One test at a time so the API coverage belongs to the test that ran.
            ...(impact ? ["--workers=1"] : []),
          ],
          {
            ...process.env,
            CI: "1",
            E2E_RECORD: record ? "1" : "0",
            // Pin English so e2e selectors match source messages regardless of runner locale.
            VITE_DEFAULT_UI_LOCALE: "en",
          },
        );
      } catch (error) {
        const failedRuns = await handles.prisma.run.findMany({
          where: { status: "failed" },
          select: { id: true, error: true },
        });
        if (failedRuns.length) console.error("Failed agent runs:", failedRuns);
        throw error;
      }
      if (impact) {
        const commit = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
        const map = writeImpactMap(impactDir, process.cwd(), commit);
        console.log(`Impact map: ${map.specs} specs, ${map.files} files, ${map.bytes} bytes`);
      }
      await writeSummary(reportDir, {
        ok: true,
        mode,
        sandbox: process.env.SANDBOX_PROVIDER,
        apiPort,
        webPort,
      });
    } finally {
      const cleanupErrors: unknown[] = [];
      const computers = await managedComputers(handles).catch((error) => {
        cleanupErrors.push(error);
        return [];
      });
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (activeRequests > 0) {
        await new Promise<void>((resolve) => requestWaiters.add(resolve));
      }
      await handles.stop().catch(() => undefined);
      for (let index = 0; index < computers.length; index += 4) {
        const results = await Promise.allSettled(
          computers.slice(index, index + 4).map((computer) =>
            handles.sandbox.destroy(
              {
                id: computer.providerRef!,
                botId: computer.homeKey,
                kind: "e2b",
                providerRef: computer.providerRef!,
              },
              {
                operationId: "e2e-cleanup",
                traceId: "e2e-cleanup",
                spaceId: computer.spaceId,
                userId: computer.userId,
                signal: new AbortController().signal,
              },
            ),
          ),
        );
        for (const result of results) {
          if (result.status === "rejected") cleanupErrors.push(result.reason);
        }
      }
      if (cleanupErrors.length) {
        console.error(
          new AggregateError(cleanupErrors, "Could not destroy every managed test sandbox"),
        );
        process.exitCode = 1;
      }
    }
  } finally {
    await container.stop().catch(() => undefined);
  }
}

type AppHandles = Awaited<ReturnType<typeof createApp>>;

/** Returns a reader of the repo files the API ran since the previous read. */
async function startApiCoverage() {
  const session = new Session();
  session.connect();
  await session.post("Profiler.enable");
  await session.post("Profiler.startPreciseCoverage", { callCount: true, detailed: false });
  const repoRoot = process.cwd();
  return async () => {
    const { result } = await session.post("Profiler.takePreciseCoverage");
    return touchedFiles(result, (url) => fileUrlToRepoFile(url, repoRoot));
  };
}

async function managedComputers(handles: AppHandles) {
  if (sandboxProvider !== "e2b") return [];
  return handles.prisma.computer.findMany({
    where: { providerRef: { not: null } },
    select: { homeKey: true, providerRef: true, userId: true, spaceId: true },
  });
}

async function writeSummary(reportDir: string, summary: Record<string, unknown>) {
  await writeFile(
    path.join(reportDir, "summary.json"),
    JSON.stringify({ ...summary, at: new Date().toISOString() }, null, 2),
  );
}

async function waitForHealth(url: string, ms: number) {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < ms) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      last = `${res.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`API health check failed for ${url}: ${last}`);
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
