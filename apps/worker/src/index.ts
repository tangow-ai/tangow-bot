import {
  ISOLATED_JOB_NAMES,
  type JobPublisher,
  type JobWorkerHost,
  LINK_PREVIEW_JOB_CONCURRENCY,
} from "@tangow/adapter-kit";
import { ComposioConnector, IntegrationProviderSettings } from "@tangow/adapters";
import { loadRootEnv } from "@tangow/core/node/load-root-env";

loadRootEnv();

import {
  ChatSdkMessagingSurface,
  composeInProcessRuntime,
  composeWorkers,
  createBackgroundJobHandlers,
  createConnectorStack,
  createFeedbackProvider,
  createJobReconciler,
  createLinkPreviewPurge,
  createMessagingContextLoader,
  createPostgresReconciliationLeadership,
  createPostgresSkillLock,
  createRunExecutor,
  createRunSecretWriter,
  createSandboxProvider,
  createSkillLineSweep,
  createTraceExporterFromEnv,
  createWebProvider,
  createWorkerProvider,
  databaseCapacityBackoffMs,
  EncryptedSecretStore,
  ExpoPushProvider,
  GraphileJobPublisher,
  GraphileJobWorkerHost,
  InMemoryJobQueue,
  isComposioEnabled,
  isMessagingSurfaceEnabled,
  LocalAgentHomeStore,
  LocalArtifactStore,
  McpConnector,
  McpOAuthBroker,
  messagingEnvFromProcess,
  messagingPlatformsFromEnv,
  PostgresRealtimeFanout,
  PostgresSessionLog,
  reconcileComputerUpdates,
  resolveDeploymentModel,
  resolveSandboxProvider,
  resolveWorkerProvider,
  SpaceDecisionProviderResolver,
  SpaceMemoryProviderResolver,
} from "@tangow/adapters";
import { parseSkillLearningMode, resolveEncryptionKey, resolveSupervisorToken } from "@tangow/core";
import {
  createDb,
  createPool,
  createThreadEvents,
  isTooManyDatabaseConnections,
  parsePositiveInteger,
} from "@tangow/db";
import { SERVICE_NAMES } from "@tangow/logging";
import { createRootLogger } from "@tangow/logging/axiom";
import { MarkdownMemoryStore } from "@tangow/memory";

const logger = createRootLogger(SERVICE_NAMES.worker);

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  // Shared by Prisma, the reconciliation leadership lock, and both graphile-worker
  // components (see GraphileJobPublisher/GraphileJobWorkerHost) — one pool instead
  // of four separate ones. Keep this modest: graphile holds a LISTEN client and
  // leadership holds an advisory-lock client for the process lifetime, and a
  // larger max just competes for Postgres max_connections (53300).
  const { prisma, pool } = createDb(databaseUrl, {
    poolMax: parsePositiveInteger(process.env.DB_POOL_MAX, 8),
    applicationName: "tangow-worker",
  });
  const realtime = new PostgresRealtimeFanout({
    connectionString: process.env.REALTIME_DATABASE_URL ?? databaseUrl,
    publisher: pool,
  });
  const secrets = new EncryptedSecretStore(resolveEncryptionKey(process.env));
  const events = createThreadEvents(prisma, realtime, {
    runSecretWriter: createRunSecretWriter(secrets),
  });
  const dataDir = process.env.DATA_DIR ?? "./data";
  // Same resolver the API uses, so both processes agree on provider, model and key.
  const { key: deploymentModelKey } = resolveDeploymentModel();
  const sandboxProvider = resolveSandboxProvider(process.env);
  const sandbox = createSandboxProvider(sandboxProvider, {
    supervisorUrl: process.env.SANDBOX_SUPERVISOR_URL ?? "http://127.0.0.1:7091",
    supervisorToken: sandboxProvider === "docker" ? resolveSupervisorToken(process.env) : undefined,
    e2bApiKey: process.env.E2B_API_KEY,
  });
  const mcpOAuth = new McpOAuthBroker(prisma, secrets);
  const mcp = new McpConnector(
    prisma,
    secrets,
    {
      stdioEnabled: process.env.MCP_STDIO_ENABLED === "true",
      allowedCommands: (process.env.MCP_STDIO_ALLOWED_COMMANDS ?? "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
    },
    mcpOAuth,
  );
  // pollInboundMessages stays false (the default) here: this process
  // only ever sends outbound (messaging.deliver jobs). It must never poll
  // Telegram — that would steal the single getUpdates slot away from the
  // API process, which is the one with the inbound sink actually wired up.
  const messagingPlatforms = messagingPlatformsFromEnv(messagingEnvFromProcess(process.env));
  const messaging = isMessagingSurfaceEnabled(messagingPlatforms, {
    deploymentModelKey,
    openSignup: process.env.MESSAGING_OPEN_SIGNUP === "true",
  })
    ? new ChatSdkMessagingSurface(messagingPlatforms)
    : undefined;
  const integrationSettings = new IntegrationProviderSettings(prisma, secrets, {
    composio: isComposioEnabled(process.env.COMPOSIO_API_KEY)
      ? new ComposioConnector(process.env.COMPOSIO_API_KEY)
      : undefined,
  });
  const stack = createConnectorStack(false, undefined, [...integrationSettings.providers(), mcp]);
  const connector = stack.destination;
  await connector.start();
  integrationSettings.warmDirectories();
  const memory = new MarkdownMemoryStore(prisma);
  const memoryProviders = new SpaceMemoryProviderResolver(prisma, secrets);
  const decisionProviders = new SpaceDecisionProviderResolver(prisma, secrets);
  const home = new LocalAgentHomeStore(dataDir);
  const artifacts = new LocalArtifactStore(dataDir);
  // Optional trace export of worker runs and the controller's model calls. Without configuration
  // this resolves to nothing, so no span is recorded and no vendor endpoint is ever contacted.
  const traceExport = createTraceExporterFromEnv(process.env);
  if (traceExport.warning) logger.warn(traceExport.warning);
  const trace = { exporter: traceExport.exporter, serviceName: SERVICE_NAMES.worker };
  const workers = composeWorkers(
    prisma,
    createWorkerProvider(resolveWorkerProvider(process.env)),
    trace,
  );
  const runtime = composeInProcessRuntime(process.env.AGENT_RUNTIME ?? "", workers, trace);
  const inMemoryJobs = process.env.WAKEUP_DRIVER === "memory" ? new InMemoryJobQueue() : undefined;
  const jobs: JobPublisher = inMemoryJobs ?? new GraphileJobPublisher(pool);
  const jobHost: JobWorkerHost =
    inMemoryJobs ??
    new GraphileJobWorkerHost(pool, {
      concurrency: parsePositiveInteger(process.env.GRAPHILE_WORKER_CONCURRENCY, 4),
      except: ISOLATED_JOB_NAMES,
      // stop() below owns shutdown: graphile's own handler would kill the process mid-way.
      noHandleSignals: true,
    });
  // Link previews read third-party pages: they get a runner of their own, so they can never
  // take a slot a bot run is waiting for (and a slow site can only slow other previews). The
  // in-memory driver (`WAKEUP_DRIVER=memory`, development only) has one queue for every job: no
  // separate runner, so no isolation, and no `maxAttempts` either.
  const previewHost: JobWorkerHost | undefined = inMemoryJobs
    ? undefined
    : new GraphileJobWorkerHost(pool, {
        concurrency: LINK_PREVIEW_JOB_CONCURRENCY,
        only: ISOLATED_JOB_NAMES,
        noHandleSignals: true,
      });
  // Its own small pool: a held skill lock must never take a connection the change itself needs.
  const skillLockPool = createPool(databaseUrl, {
    poolMax: 2,
    applicationName: "tangow-worker-skill-lock",
  });
  const skillLock = createPostgresSkillLock(skillLockPool);
  const skillLearning = parseSkillLearningMode(process.env.SKILL_LEARNING);
  const sessionLog = new PostgresSessionLog(prisma);
  const feedback = createFeedbackProvider();
  const shutdown = new AbortController();
  const executor = createRunExecutor({
    prisma,
    sessionLog,
    skillLock,
    runtime,
    workers: workers.runWorkers,
    sandbox,
    memory,
    memoryProviders,
    decisionProviders,
    home,
    artifacts,
    connector: stack.connector,
    connectors: stack.connector,
    listConnectedPluginSlugs: async (scope) => {
      const provider = await integrationSettings.resolve("composio");
      if (!provider) return [];
      return provider.listConnectedExternalIds({
        userId: scope.userId,
        spaceId: scope.spaceId,
        operationId: "connections.sync",
        traceId: "connections.sync",
        signal: AbortSignal.timeout(15_000),
      });
    },
    secrets: [
      deploymentModelKey ?? "",
      process.env.COMPOSIO_API_KEY ?? "",
      feedback?.secret ?? "",
    ].filter(Boolean),
    secretStore: secrets,
    deploymentModelKey,
    dataDir,
    notifications: new ExpoPushProvider(dataDir),
    jobs,
    events,
    messaging: messaging ? createMessagingContextLoader(prisma) : undefined,
    web: createWebProvider(),
    feedback: feedback?.provider,
    version: process.env.GIT_SHA?.trim() || undefined,
    shutdownSignal: shutdown.signal,
    skillLearning,
  });

  const jobHandlers = createBackgroundJobHandlers({
    executor,
    prisma,
    workers: workers.lifecycle,
    sessionLog,
    sandbox,
    home,
    jobs,
    events,
    workerId: process.pid.toString(),
    runtime,
    secretStore: secrets,
    memory,
    memoryProviders,
    deploymentModelKey,
    messaging,
    artifacts,
    homeMove:
      sandboxProvider === "docker" ? { prisma, workers: workers.lifecycle, dataDir } : undefined,
  });
  // graphile-worker run() connects through the shared pool. createPool already
  // retries connect() on 53300 a finite number of times. Keep retrying start
  // until Postgres has capacity: exhausting then returning from main().catch
  // left a live process that held connections but never ran jobs or registered
  // signal handlers, even after capacity returned. Do not exit(1) here; that
  // crash-loops into the same saturated Postgres. GraphileJobWorkerHost also
  // observes runner.promise after start and restarts with the same backoff if
  // the runner dies later on 53300 (unhandledRejection still swallows that
  // code so we do not Docker crash-loop on transient completeJob failures).
  async function startWithCapacityRetry(
    host: JobWorkerHost,
    handlers: Parameters<JobWorkerHost["start"]>[0],
  ) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await host.start(handlers);
        return;
      } catch (error) {
        if (!isTooManyDatabaseConnections(error)) throw error;
        logger.error("worker job host start waiting on database capacity", error);
        await new Promise((resolve) => setTimeout(resolve, databaseCapacityBackoffMs(attempt)));
      }
    }
  }
  await startWithCapacityRetry(jobHost, jobHandlers);
  if (previewHost) await startWithCapacityRetry(previewHost, jobHandlers);
  const reconciler = createJobReconciler({
    prisma,
    jobs,
    events,
    leadership: createPostgresReconciliationLeadership(pool),
    reconcileComputerUpdates: () => reconcileComputerUpdates({ prisma, jobs }),
    purgeLinkPreviews: createLinkPreviewPurge({ prisma, artifacts }),
    sweepSkillLines: createSkillLineSweep({
      prisma,
      events,
      sessionLog,
      lineOnlyMessages: skillLearning !== "off",
    }),
    reconcileWorkers: workers.reconcileWorkers,
  });
  reconciler.start();

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      // In-flight runs end first and hand their run back, so the job host drains promptly.
      shutdown.abort();
      await reconciler.stop();
      await jobHost.stop();
      await previewHost?.stop();
      await jobs.close();
      await realtime.close();
      await connector.stop();
      await mcp.close();
      await prisma.$disconnect().catch(() => undefined);
      await pool.end().catch(() => undefined);
      await skillLockPool.end().catch(() => undefined);
    } finally {
      await traceExport.exporter?.flush(2_000);
      await logger.flush({ timeoutMs: 2_000 });
    }
  };
  // Exit once stopped: a handle left open must not hold the container until SIGKILL.
  const stopAndExit = () => void stop().finally(() => process.exit(0));
  process.once("SIGTERM", stopAndExit);
  process.once("SIGINT", stopAndExit);
  // graphile-worker fires completeJob() without awaiting it. When pool.connect()
  // then hits Postgres 53300, that rejection is unhandled. Exiting here is the
  // crash loop: Docker restarts the process before Postgres has reaped the old
  // backends, so the next boot cannot connect either. Stay up on that rejection
  // only — do not resume after uncaughtException (Node leaves the process in an
  // undefined state).
  process.on("uncaughtException", (error) => {
    logger.error("uncaughtException", error);
    void stop().finally(() => process.exit(1));
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("unhandledRejection", reason);
    if (isTooManyDatabaseConnections(reason)) return;
    void stop().finally(() => process.exit(1));
  });

  logger.info("worker ready");
}

main().catch(async (error) => {
  logger.error("worker startup failed", error);
  await logger.flush({ timeoutMs: 2_000 });
  // jobHost.start retries 53300 without bound above, so a saturated Postgres at
  // that step does not reach here. Other startup failures still exit.
  process.exit(1);
});
