import type {
  AgentHomeStore,
  AgentRuntime,
  ArtifactStore,
  BackgroundJobHandlers,
  JobPublisher,
  MemoryStore,
  MessagingSurface,
  SandboxProvider,
  SessionLog,
} from "@tangow/adapter-kit";
import { messagingDeliverJob } from "@tangow/adapter-kit";
import type { Prisma, PrismaClient, ThreadEvents } from "@tangow/db";
import { getLogger } from "@tangow/logging";
import { expireComputerControl } from "./computer-control.js";
import {
  scheduleComputerSleep,
  sleepBotScreenIfIdle,
  sleepComputerIfIdle,
} from "./computer-idle.js";
import { performComputerUpdate } from "./computer-update.js";
import { moveIdleDockerHomes } from "./docker-home-migration.js";
import type { createRunExecutor } from "./executor.js";
import { compactHistory } from "./history-compaction.js";
import { runLinkPreviewJob } from "./link-preview/job.js";
import type { MemoryProviderResolver } from "./memory-provider-factory.js";
import { deliverMessagingOutbound, mirrorMessagingOutbound } from "./messaging-delivery.js";
import type { EncryptedSecretStore } from "./secrets.js";
import { expireTaughtSkillTeaching } from "./teaching-session.js";
import type { WorkerLifecycle } from "./worker-lifecycle.js";

export function createBackgroundJobHandlers(deps: {
  executor: ReturnType<typeof createRunExecutor>;
  prisma: PrismaClient;
  sessionLog: SessionLog<Prisma.TransactionClient>;
  sandbox: SandboxProvider;
  home: AgentHomeStore;
  jobs: JobPublisher;
  events: ThreadEvents;
  workerId: string;
  runtime: AgentRuntime;
  secretStore: EncryptedSecretStore;
  memory: MemoryStore;
  memoryProviders: MemoryProviderResolver;
  deploymentModelKey?: string;
  messaging?: MessagingSurface;
  /** Where link preview images are kept; without it `link.preview` jobs do nothing. */
  artifacts?: ArtifactStore;
  /** Creates a home's missing volumes before `computer.update` boots its new machine. */
  workers: Pick<WorkerLifecycle, "provisionHomeVolumes">;
  /** Moves Docker homes onto volumes as their computers suspend. */
  homeMove?: { prisma: PrismaClient; workers: WorkerLifecycle; dataDir: string };
}): BackgroundJobHandlers {
  const deliverMessaging = async (runId?: string) => {
    if (!deps.messaging) return;
    await deliverMessagingOutbound(
      { prisma: deps.prisma, messaging: deps.messaging, events: deps.events, jobs: deps.jobs },
      { runId },
      {
        operationId: `messaging.deliver:${runId ?? "drain"}`,
        traceId: `messaging.deliver:${runId ?? "drain"}`,
        spaceId: "",
        userId: "",
        signal: new AbortController().signal,
      },
    );
  };

  return {
    "run.continue": async (payload) => {
      await deps.executor.continueRun(payload.runId, deps.workerId);
      // Automatic messaging mirror: once the run's bot messages are durable,
      // copy them into the outbox. Never let mirror failures fail the run.
      if (deps.messaging) {
        await mirrorMessagingOutbound(
          { prisma: deps.prisma, messaging: deps.messaging, events: deps.events, jobs: deps.jobs },
          payload.runId,
        );
        await deps.jobs.enqueue(messagingDeliverJob()).catch(async (error) => {
          getLogger().error("messaging.deliver enqueue error", error);
          await deliverMessaging();
        });
      }
    },
    "messaging.deliver": async (payload) => {
      await deliverMessaging(payload.runId);
    },
    "routine.wakeup": async (payload) => {
      await deps.executor.wakeRoutine(payload.routineId, payload.scheduledFor);
    },
    "computer.update": async ({ updateId }) => {
      await performComputerUpdate(deps, updateId);
    },
    "computer.sleep": async (payload) => {
      await sleepComputerIfIdle(deps, payload.computerId);
      // A Docker home still off volumes moves once its computer suspends, before its next boot.
      if (deps.homeMove) {
        await moveIdleDockerHomes(
          deps.homeMove,
          {
            operationId: `computer.home-move:${payload.computerId}`,
            traceId: `computer.home-move:${payload.computerId}`,
            spaceId: "",
            userId: "",
            signal: new AbortController().signal,
          },
          payload.computerId,
        ).catch((error: unknown) =>
          getLogger().error("docker home move failed", error, { computerId: payload.computerId }),
        );
      }
    },
    "computer.screen-sleep": async (payload) => {
      await sleepBotScreenIfIdle(deps, payload);
    },
    "computer.control-expire": async (payload) => {
      if (await expireComputerControl(deps, payload.computerId, payload.leaseId)) {
        scheduleComputerSleep(deps.jobs, payload.computerId);
      }
    },
    "skill.teaching-expire": async (payload) => {
      await expireTaughtSkillTeaching(deps, payload.skillId);
    },
    "link.preview": async (payload) => {
      if (!deps.artifacts) return;
      await runLinkPreviewJob(
        { prisma: deps.prisma, artifacts: deps.artifacts, events: deps.events },
        payload,
      );
    },
    "history.compact": async (payload) => {
      await compactHistory(
        {
          prisma: deps.prisma,
          sessionLog: deps.sessionLog,
          runtime: deps.runtime,
          memory: deps.memory,
          memoryProviders: deps.memoryProviders,
          deploymentModelKey: deps.deploymentModelKey,
          ...(deps.executor.resolveModel ? { resolveModel: deps.executor.resolveModel } : {}),
        },
        payload.threadId,
        payload.historyBudget,
      );
    },
  };
}
