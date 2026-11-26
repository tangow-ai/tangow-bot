import type {
  AgentHomeStore,
  AgentRuntime,
  ArtifactStore,
  JobPublisher,
  MemoryStore,
  MessagingSurface,
  SandboxProvider,
  SessionLog,
} from "@tangow/adapter-kit";
import type { Prisma, PrismaClient, ThreadEvents } from "@tangow/db";
import { createLogger, createTestSink, installLogger } from "@tangow/logging";
import { describe, expect, it, vi } from "vitest";
import { createBackgroundJobHandlers } from "./background-job-handlers.js";
import { createRunExecutor } from "./executor.js";
import { compactHistory } from "./history-compaction.js";
import { runLinkPreviewJob } from "./link-preview/job.js";
import { deliverMessagingOutbound, mirrorMessagingOutbound } from "./messaging-delivery.js";
import type { EncryptedSecretStore } from "./secrets.js";

vi.mock("./history-compaction.js", () => ({ compactHistory: vi.fn(async () => undefined) }));
vi.mock("./link-preview/job.js", () => ({ runLinkPreviewJob: vi.fn(async () => undefined) }));
vi.mock("./messaging-delivery.js", () => ({
  deliverMessagingOutbound: vi.fn(async () => undefined),
  mirrorMessagingOutbound: vi.fn(async () => undefined),
}));

// None of these jobs boots a computer, so no home ever needs volumes.
const workers = { provisionHomeVolumes: async () => undefined };

describe("createBackgroundJobHandlers", () => {
  it("delivers directly when shutdown rejects a completed run's mirror job", async () => {
    const enqueueError = new Error("Background job publisher is closing");
    const jobs = {
      enqueue: vi.fn(async () => {
        throw enqueueError;
      }),
    } as unknown as JobPublisher;
    const sink = createTestSink();
    installLogger(createLogger({ service: "tangow-worker", sinks: [sink] }));
    const handlers = createBackgroundJobHandlers({
      executor: {
        continueRun: vi.fn(async () => undefined),
      } as unknown as ReturnType<typeof createRunExecutor>,
      prisma: {} as unknown as PrismaClient,
      sessionLog: {} as unknown as SessionLog<Prisma.TransactionClient>,
      sandbox: {} as unknown as SandboxProvider,
      home: {} as unknown as AgentHomeStore,
      jobs,
      events: {} as unknown as ThreadEvents,
      workerId: "worker-1",
      runtime: {} as unknown as AgentRuntime,
      secretStore: {} as unknown as EncryptedSecretStore,
      memory: {} as unknown as MemoryStore,
      memoryProviders: { resolve: vi.fn(async () => null) },
      workers,
      messaging: {} as unknown as MessagingSurface,
    });

    await handlers["run.continue"]({ runId: "run-1" });

    expect(mirrorMessagingOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ prisma: expect.anything(), messaging: expect.anything(), jobs }),
      "run-1",
    );
    expect(deliverMessagingOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ prisma: expect.anything(), messaging: expect.anything(), jobs }),
      { runId: undefined },
      expect.objectContaining({ operationId: "messaging.deliver:drain" }),
    );
    expect(sink.events.some((event) => event.message === "messaging.deliver enqueue error")).toBe(
      true,
    );
    installLogger(createLogger({ service: "tangow-worker", level: "off", sinks: [] }));
  });

  it("compacts the requested thread with the session log, runtime, and model key it was given", async () => {
    const prisma = {} as unknown as PrismaClient;
    const sessionLog = {} as unknown as SessionLog<Prisma.TransactionClient>;
    const runtime = {} as unknown as AgentRuntime;
    const jobs = {} as unknown as JobPublisher;
    const secretStore = {} as unknown as EncryptedSecretStore;
    const memory = {} as unknown as MemoryStore;
    const memoryProviders = { resolve: vi.fn(async () => null) };
    const resolveModel = vi.fn();
    const handlers = createBackgroundJobHandlers({
      executor: { resolveModel } as unknown as ReturnType<typeof createRunExecutor>,
      prisma,
      sessionLog,
      sandbox: {} as unknown as SandboxProvider,
      home: {} as unknown as AgentHomeStore,
      jobs,
      events: {} as unknown as ThreadEvents,
      workerId: "worker-1",
      runtime,
      secretStore,
      memory,
      memoryProviders,
      workers,
      deploymentModelKey: "openrouter-key",
    });

    await handlers["history.compact"]({ threadId: "thread-1", historyBudget: 20_000 });

    expect(compactHistory).toHaveBeenCalledWith(
      {
        prisma,
        sessionLog,
        runtime,
        memory,
        memoryProviders,
        deploymentModelKey: "openrouter-key",
        resolveModel,
      },
      "thread-1",
      20_000,
    );
  });

  it("resolves the deployment model when no user credential is configured", async () => {
    const prisma = {
      spaceMember: { findUnique: async () => ({ modelAuto: false }) },
      spaceModelCategory: { findMany: async () => [] },
      spaceModelPreference: { findFirst: vi.fn(async () => null) },
      userModelCredential: { findFirst: vi.fn(async () => null) },
      deploymentSettings: { findUnique: vi.fn(async () => null) },
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
      deploymentModelKey: "deployment-key",
    } as Parameters<typeof createRunExecutor>[0]);

    await expect(
      executor.resolveModel({ userId: "user-1", spaceId: "workspace-1" }),
    ).resolves.toEqual({
      provider: "openrouter",
      id: "openai/gpt-5.6-luna",
      apiKey: "deployment-key",
      baseUrl: undefined,
      // The deployment model carries no stored context window, so it comes from the catalog.
      contextWindow: 1_050_000,
      thinkingLevel: null,
      oauth: undefined,
    });
  });

  it("preserves a configured local model when resolving background compaction", async () => {
    const prisma = {
      spaceMember: { findUnique: async () => ({ modelAuto: false }) },
      spaceModelCategory: { findMany: async () => [] },
      spaceModelPreference: { findFirst: vi.fn(async () => null) },
      userModelCredential: { findFirst: vi.fn(async () => null) },
      deploymentSettings: {
        findUnique: vi.fn(async () => ({
          defaultModelProvider: "local",
          defaultModelId: "qwen3:4b",
        })),
      },
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
    } as Parameters<typeof createRunExecutor>[0]);

    await expect(
      executor.resolveModel({ userId: "user-1", spaceId: "workspace-1" }),
    ).resolves.toEqual({
      provider: "local",
      id: "qwen3:4b",
      apiKey: undefined,
      baseUrl: undefined,
      thinkingLevel: null,
      oauth: undefined,
    });
  });

  it("runs link.preview with the database, the artifact store and the event notifier", async () => {
    const prisma = {} as unknown as PrismaClient;
    const artifacts = { put: vi.fn() } as unknown as ArtifactStore;
    const events = { notify: vi.fn() } as unknown as ThreadEvents;
    const make = (withArtifacts: boolean) =>
      createBackgroundJobHandlers({
        executor: {} as unknown as ReturnType<typeof createRunExecutor>,
        prisma,
        sessionLog: {} as unknown as SessionLog<Prisma.TransactionClient>,
        sandbox: {} as unknown as SandboxProvider,
        home: {} as unknown as AgentHomeStore,
        jobs: {} as unknown as JobPublisher,
        events,
        workerId: "worker-1",
        runtime: {} as unknown as AgentRuntime,
        secretStore: {} as unknown as EncryptedSecretStore,
        memory: {} as unknown as MemoryStore,
        memoryProviders: { resolve: vi.fn(async () => null) },
        workers,
        ...(withArtifacts ? { artifacts } : {}),
      });

    await make(true)["link.preview"]({ runId: "run-1" });
    expect(runLinkPreviewJob).toHaveBeenCalledWith(
      { prisma, artifacts, events },
      { runId: "run-1" },
    );

    // Without a store for the images there is nothing to do, and it is not an error.
    vi.mocked(runLinkPreviewJob).mockClear();
    await expect(make(false)["link.preview"]({ messageId: "m" })).resolves.toBeUndefined();
    expect(runLinkPreviewJob).not.toHaveBeenCalled();
  });
});
