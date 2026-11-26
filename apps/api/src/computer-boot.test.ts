import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PgliteDatabase } from "@tangow/db/pglite.test-support";
import { openPgliteDatabase } from "@tangow/db/pglite.test-support";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FakeSandboxProvider } from "../../../packages/adapters/src/fake-sandbox.js";
import { FakeWorkerProvider } from "../../../packages/adapters/src/fake-worker-provider.js";
import type { GuestConnector } from "../../../packages/adapters/src/runtime-worker/launcher.js";
import type { AppHandles } from "./app.js";
import { createApp } from "./app.js";

// A new home on volumes belongs to a Docker or E2B computer; these tests drive the API as
// production assembles it, so they also cover the wiring of the worker lifecycle in createApp.
let database: PgliteDatabase;
let dataDir: string;
let handles: AppHandles;
let sandbox: FakeSandboxProvider;
let cookie: string;

beforeEach(async () => {
  vi.stubEnv("SANDBOX_PROVIDER", "docker");
  // Required by the environment; PGlite replaces the database, so nothing connects to it.
  vi.stubEnv("DATABASE_URL", "postgres://tangow:tangow@127.0.0.1:1/unused");
  database = await openPgliteDatabase();
  dataDir = await mkdtemp(path.join(tmpdir(), "tangow-boot-"));
  sandbox = new FakeSandboxProvider();
  const provision = sandbox.provision.bind(sandbox);
  vi.spyOn(sandbox, "provision").mockImplementation(async (request, context) => ({
    ...(await provision(request, context)),
    kind: "docker",
  }));
  handles = await createApp({
    prisma: database.prisma,
    sandbox,
    workers: new FakeWorkerProvider() as FakeWorkerProvider & GuestConnector,
    dataDir,
    wakeupDriver: "memory",
    agentRuntime: "scripted",
    signupsEnabled: "true",
  });
  const signup = await handles.app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({
      email: "owner@tangow.test",
      password: "test-password-123",
      name: "Owner",
    }),
  });
  cookie = signup.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
});

afterEach(async () => {
  await handles?.stop();
  await database.close();
  await rm(dataDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function rpc<T>(procedure: string, input: unknown): Promise<T> {
  const response = await handles.app.request(`/rpc/${procedure}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ json: input }),
  });
  const body = (await response.json()) as { json: T };
  expect(response.status, JSON.stringify(body)).toBe(200);
  return body.json;
}

async function newBot() {
  return rpc<{ id: string }>("bots/create", {
    name: "Writer",
    title: "Writer",
    description: "",
    instructions: "",
    notifyOnFinish: false,
  });
}

function expectVolumesMounted() {
  expect(vi.mocked(sandbox.provision).mock.calls.at(-1)![0].volumeHome?.mounts).toHaveLength(2);
}

it("boots a new bot's computer from its screen with its home volumes", async () => {
  const bot = await newBot();

  await rpc("computer/boot", { botId: bot.id });

  expectVolumesMounted();
});

it("updates a new bot's computer with its home volumes", async () => {
  const bot = await newBot();

  const update = await rpc<{ id: string }>("computer/update", { botId: bot.id });

  await expect
    .poll(
      async () =>
        (await handles.prisma.computerUpdate.findUniqueOrThrow({ where: { id: update.id } }))
          .status,
    )
    .toBe("completed");
  expectVolumesMounted();
});
