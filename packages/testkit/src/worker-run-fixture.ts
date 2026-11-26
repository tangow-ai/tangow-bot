import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type {
  AgentRuntime,
  ConnectorProvider,
  MemoryStore,
  SandboxProvider,
  WorkerProvider,
} from "@tangow/adapter-kit";
import {
  createBackgroundJobHandlers,
  createInMemorySkillLock,
  createRunExecutor,
  createRunSecretWriter,
  createWorkerLifecycle,
  EncryptedSecretStore,
  InMemoryJobQueue,
  LocalAgentHomeStore,
  LocalArtifactStore,
  ModelCallRuntime,
  PostgresSessionLog,
  provisionComputer,
} from "@tangow/adapters";
import type {
  GuestConnector,
  RunWorkers,
  WorkerClock,
  WorkerTrace,
} from "@tangow/adapters/runtime-worker";
import { createRunWorkers } from "@tangow/adapters/runtime-worker";
import type { GuestHarness } from "@tangow/agent-run-worker";
import type { SessionEntry } from "@tangow/contracts";
import type { PrismaClient } from "@tangow/db";
import { createThreadEvents } from "@tangow/db";
import { openPgliteDatabase } from "@tangow/db/pglite.test-support";
import type { LocalWorkerFaults } from "./local-worker-provider.js";
import { LocalWorkerProvider } from "./local-worker-provider.js";
import type { ModelEmulatorStep } from "./model-emulator.js";
import { startModelEmulator } from "./model-emulator.js";
import { VolumeComputer } from "./volume-computer.js";
import { openBenchPostgres } from "./worker-live/database.js";

const MODEL_KEY = "worker-fixture-model-key";

/** Lets a step call a controller tool by its Tangow name, which Pi native offers over MCP. */
/** The call after the model ended on text the person never sees: it is told how to reach them. */
export const afterPrivateText: ModelEmulatorStep = {
  expect(request) {
    assert.match(
      JSON.stringify(request.messages.at(-1)),
      /Nothing you wrote reached the user: only mcp__tangow__message_user does/,
    );
  },
  response: { type: "text", text: "" },
};

export function offeredToolNames(step: ModelEmulatorStep): ModelEmulatorStep {
  return {
    ...step,
    response(request) {
      const reply = typeof step.response === "function" ? step.response(request) : step.response;
      if (reply.type !== "tool") return reply;
      const offered = new Set(request.tools?.map((tool) => tool.function.name));
      const name = (called: string) =>
        offered.has(called) || !offered.has(`mcp__tangow__${called}`)
          ? called
          : `mcp__tangow__${called}`;
      return {
        ...reply,
        name: name(reply.name),
        ...(reply.siblings && {
          siblings: reply.siblings.map((sibling) => ({ ...sibling, name: name(sibling.name) })),
        }),
      };
    },
  };
}
const SPACE = "space-worker";
const USER = "user-worker";

const emptyMemory: MemoryStore = {
  describe: () => ({
    id: "empty",
    contractVersion: "1",
    adapterVersion: "1",
    capabilities: { search: false, revisions: false, markdownPortable: false },
  }),
  read: async () => ({ documents: [] }),
  search: async () => [],
  commit: async () => {
    throw new Error("Unexpected memory write");
  },
  async *exportMarkdown() {},
  importMarkdown: async () => {
    throw new Error("Unexpected memory import");
  },
};

/**
 * The real executor on PGlite, with the model emulator behind the controller's relay. Its bot's
 * home is on volumes, so a product run goes to a local guest through the worker routing. `restart`
 * drops the executor, the runtime and the launcher and builds new ones on the same database, as a
 * controller restart would.
 */
export async function startWorkerRun<
  Provider extends WorkerProvider & GuestConnector = LocalWorkerProvider,
>(options: {
  steps: ModelEmulatorStep[];
  memory?: MemoryStore;
  memoryProviders?: Parameters<typeof createRunExecutor>[0]["memoryProviders"];
  databaseUrl?: string;
  tools?: ConnectorProvider;
  /** Values the controller masks wherever the model would see them. */
  secrets?: string[];
  /**
   * Bills a catalog Anthropic model with a plain API key instead of a custom OpenAI-compatible
   * connection; the catalog entry points at the emulator for the fixture's lifetime.
   */
  protocol?: "openai" | "anthropic";
  /**
   * Bills this catalog model with a plain API key. Without `apiKey` its catalog entry points at
   * the emulator for the fixture's lifetime; with one, the provider itself answers.
   */
  catalogModel?: { provider: string; id: string; apiKey?: string };
  /**
   * Runs guests on this provider instead of the local runner, as the live lanes do with E2B. Its
   * volumes are provisioned through the lifecycle.
   */
  provider?: () => Provider;
  /** The bot's computer instead of the fake one on local volumes. */
  sandbox?: SandboxProvider;
  /** The `DATA_DIR` the computer shares, homes included, as a Docker computer's supervisor does. */
  dataDir?: string;
  mode?: "memory" | "child";
  /** The harness a `memory` guest runs instead of Pi native. */
  harness?: GuestHarness;
  /** The bundled guest a `child` mode runs instead of the source. */
  guestEntry?: string;
  faults?: LocalWorkerFaults;
  clock?: WorkerClock;
  /** Runs the bot with this runtime and no worker routing. */
  runtime?: (prisma: PrismaClient) => AgentRuntime;
  /** The bot's computer: a dedicated one by default, or none at all. */
  computerScope?: "team" | "dedicated" | "none";
  /** Wraps how the controller reaches the guest, to observe its frames. */
  connector?: (provider: Provider) => GuestConnector;
  /** Wraps the client the controller uses, to observe its queries. */
  prisma?: (prisma: PrismaClient) => PrismaClient;
  /** Wraps the executor's worker routing, to fail or race it. */
  workers?: (workers: RunWorkers) => RunWorkers;
  /** The guest reads screens from the bot's home instead of getting them in tool results. */
  screensByPath?: boolean;
  /** The connection's model sees at most this many images a request. */
  maxImagesPerPrompt?: number;
  /** Exports each worker run's trace here. */
  trace?: WorkerTrace;
}) {
  const database = options.databaseUrl
    ? await openBenchPostgres(options.databaseUrl)
    : await openPgliteDatabase();
  const prisma = options.prisma?.(database.prisma) ?? database.prisma;
  const dir = await mkdtemp(path.join(tmpdir(), "tangow-worker-run-"));
  const dataDir = options.dataDir ?? path.join(dir, "data");
  const homesRoot = options.dataDir ?? path.join(dir, "homes");
  const catalog =
    options.catalogModel ??
    (options.protocol === "anthropic"
      ? { provider: "anthropic", id: "claude-haiku-4-5", apiKey: undefined }
      : undefined);
  const entry = catalog && builtinModels().getModel(catalog.provider, catalog.id);
  if (catalog && !entry) throw new Error(`No catalog model ${catalog.provider}/${catalog.id}`);
  const model = await startModelEmulator({
    apiKey: MODEL_KEY,
    steps: options.steps.map(offeredToolNames),
    ...(entry
      ? { protocol: entry.api === "anthropic-messages" ? "anthropic" : "openai", modelId: entry.id }
      : {}),
  });
  const catalogUrl = entry?.baseUrl;
  const emulated = entry && catalog.apiKey === undefined;
  if (emulated) entry.baseUrl = model.baseUrl;
  const modelProvider = catalog?.provider ?? model.model.provider;
  const secretStore = new EncryptedSecretStore("worker-fixture-encryption-key");
  const sessionLog = new PostgresSessionLog(prisma);
  const sandbox =
    options.sandbox ??
    new VolumeComputer((volumeRef) =>
      (current.provider as unknown as LocalWorkerProvider).volumePath(volumeRef),
    );

  await prisma.user.create({ data: { id: USER, name: "Worker", email: "worker@tangow.test" } });
  await prisma.organization.create({
    data: { id: "org-worker", name: "Worker", slug: "org-worker", createdAt: new Date() },
  });
  await prisma.space.create({ data: { id: SPACE, organizationId: "org-worker", name: "Worker" } });
  const joined = new Date();
  await prisma.member.create({
    data: {
      id: "member-worker",
      organizationId: "org-worker",
      userId: USER,
      role: "owner",
      createdAt: joined,
    },
  });
  await prisma.spaceMember.create({
    data: {
      id: "space-member-worker",
      spaceId: SPACE,
      organizationId: "org-worker",
      userId: USER,
      role: "owner",
      createdAt: joined,
    },
  });
  const computerScope = options.computerScope ?? "dedicated";
  const computer =
    computerScope === "none"
      ? null
      : await prisma.computer.create({
          data: {
            spaceId: SPACE,
            userId: USER,
            scope: computerScope,
            scopeKey: "worker-computer",
            homeKey: "worker-computer",
            kind: options.sandbox?.describe().id === "docker" ? "docker" : "e2b",
            homeStorage: "volumes",
          },
        });
  const bot = await prisma.bot.create({
    data: {
      spaceId: SPACE,
      userId: USER,
      name: "Worker",
      color: "#000000",
      computerId: computer?.id ?? null,
      modelProvider,
      modelId: model.model.id,
    },
  });
  const sealed = await secretStore.put(
    catalog
      ? (catalog.apiKey ?? MODEL_KEY)
      : JSON.stringify({
          kind: "openai_compatible",
          baseUrl: model.baseUrl,
          apiKey: MODEL_KEY,
          ...(options.maxImagesPerPrompt && {
            visionModelIds: [model.model.id],
            maxImagesPerPrompt: options.maxImagesPerPrompt,
          }),
        }),
    {
      operationId: "fixture",
      traceId: "fixture",
      spaceId: SPACE,
      userId: USER,
      signal: new AbortController().signal,
    },
  );
  await prisma.secret.create({
    data: { id: sealed.id, userId: USER, kind: "model", ciphertext: sealed.ciphertext },
  });
  const credential = await prisma.userModelCredential.create({
    data: { userId: USER, provider: modelProvider, label: "Fixture", secretId: sealed.id },
  });
  await prisma.spaceModelPreference.create({
    data: {
      spaceId: SPACE,
      userId: USER,
      credentialId: credential.id,
      modelId: model.model.id,
      isDefault: true,
    },
  });
  if (!options.provider && computer) {
    await prisma.volume.createMany({
      data: [
        { kind: "bot_private", spaceId: SPACE, botId: bot.id, providerKind: "local-worker" },
        { kind: "space_shared", spaceId: SPACE, userId: USER, providerKind: "local-worker" },
      ].map((volume) => ({ ...volume, providerRef: volume.kind })),
    });
  }
  const thread = await prisma.thread.create({
    data: { spaceId: SPACE, userId: USER, botId: bot.id },
  });
  const events = createThreadEvents(prisma, undefined, {
    runSecretWriter: createRunSecretWriter(secretStore),
  });

  const build = () => {
    const provider =
      options.provider?.() ??
      (new LocalWorkerProvider({
        mode: options.mode ?? "memory",
        root: path.join(dir, "workers"),
        faults: options.faults,
        entry: options.guestEntry,
        harness: options.harness,
      }) as unknown as Provider);
    const lifecycle = createWorkerLifecycle({ prisma, provider });
    const runtime: AgentRuntime = options.runtime?.(prisma) ?? new ModelCallRuntime();
    const routing = options.runtime
      ? undefined
      : createRunWorkers({
          prisma,
          lifecycle,
          connector: options.connector?.(provider) ?? provider,
          clock: options.clock,
          screensByPath: options.screensByPath,
          trace: options.trace,
        });
    const workers = routing && (options.workers?.(routing) ?? routing);
    const executor = createRunExecutor({
      prisma,
      sessionLog,
      events,
      sandbox,
      home: new LocalAgentHomeStore(homesRoot),
      dataDir,
      artifacts: new LocalArtifactStore(dataDir),
      memory: options.memory ?? emptyMemory,
      memoryProviders: options.memoryProviders ?? { resolve: async () => null },
      secretStore,
      jobs: new InMemoryJobQueue(),
      skillLock: createInMemorySkillLock(),
      skillLearning: "off",
      secrets: options.secrets ?? [],
      connector: options.tools,
      runtime,
      workers,
    });
    return { provider, lifecycle, runtime, executor };
  };
  let current = build();
  if (options.provider && computer) {
    const context = {
      operationId: "worker-fixture",
      traceId: "worker-fixture",
      spaceId: SPACE,
      userId: USER,
      signal: new AbortController().signal,
    };
    await current.lifecycle.ensureVolume(
      { kind: "bot_private", spaceId: SPACE, botId: bot.id },
      context,
    );
    await current.lifecycle.ensureVolume(
      { kind: "space_shared", spaceId: SPACE, userId: USER },
      context,
    );
  }

  return {
    prisma,
    model,
    sandbox,
    bot,
    thread,
    events,
    get provider() {
      return current.provider;
    },
    get lifecycle() {
      return current.lifecycle;
    },
    /** A user message that starts a queued run. */
    async send(text: string) {
      const sent = await events.sendUserMessage({
        spaceId: SPACE,
        threadId: thread.id,
        botId: bot.id,
        userId: USER,
        blocks: [{ kind: "text", text }],
        prompt: text,
        trigger: "user",
      });
      return sent.runId!;
    },
    continueRun(runId: string) {
      return current.executor.continueRun(runId, "worker-fixture");
    },
    wakeRoutine(routineId: string, scheduledFor: Date) {
      return current.executor.wakeRoutine(routineId, scheduledFor.toISOString());
    },
    /** Starts the bot's computer the way a person opening it does, outside any run. */
    startComputer() {
      if (!computer) throw new Error("The bot has no computer");
      return provisionComputer(
        {
          prisma,
          sandbox,
          events,
          home: new LocalAgentHomeStore(homesRoot),
          dataDir,
          jobs: new InMemoryJobQueue(),
          workers: current.lifecycle,
        },
        computer.id,
        {
          operationId: "worker-fixture-computer",
          traceId: "worker-fixture-computer",
          spaceId: SPACE,
          userId: USER,
          signal: new AbortController().signal,
        },
      );
    },
    /** Runs the thread's history compaction job now, keeping about a quarter of `historyBudget`. */
    compactHistory(historyBudget: number) {
      return createBackgroundJobHandlers({
        executor: current.executor,
        prisma,
        sessionLog,
        sandbox,
        home: new LocalAgentHomeStore(homesRoot),
        jobs: new InMemoryJobQueue(),
        events,
        workerId: "worker-fixture",
        runtime: current.runtime,
        secretStore,
        memory: options.memory ?? emptyMemory,
        memoryProviders: options.memoryProviders ?? { resolve: async () => null },
        workers: current.lifecycle,
      })["history.compact"]({ threadId: thread.id, historyBudget });
    },
    /** Builds a new controller on the same database; the old one's guests are left as they are. */
    restart() {
      const old = current;
      current = build();
      return old.provider;
    },
    runEntries(runId: string): Promise<SessionEntry[]> {
      return sessionLog.readRun(runId);
    },
    userId: USER,
    spaceId: SPACE,
    async close() {
      await (current.provider as unknown as Partial<LocalWorkerProvider>).dispose?.();
      await model.close();
      if (emulated) entry.baseUrl = catalogUrl!;
      await database.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
