import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { ORPCError, onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type {
  AgentRuntime,
  JobPublisher,
  MessagingSurface,
  RealtimeFanout,
  SandboxProvider,
  TransactionalEmailProvider,
  WorkerProvider,
} from "@tangow/adapter-kit";
import type {
  ComposioProvider,
  ConnectorRegistry,
  DestinationEmulator,
  RemoteTransportDependencies,
} from "@tangow/adapters";
import {
  applyMessagingOutboundStatus,
  ChatSdkMessagingSurface,
  ComposioConnector,
  composeInProcessRuntime,
  composeWorkers,
  createBackgroundJobHandlers,
  createConnectorStack,
  createFeedbackProvider,
  createJobReconciler,
  createLinkPreviewPurge,
  createMessagingContextLoader,
  createMessagingTeamChatSender,
  createPostgresSkillLock,
  createRunExecutor,
  createRunSecretWriter,
  createSandboxProvider,
  createSkillLineSweep,
  createTraceExporterFromEnv,
  createWebProvider,
  createWorkerProvider,
  destroyBot,
  EmailEmulator,
  EncryptedSecretStore,
  ExpoPushProvider,
  GraphileJobPublisher,
  InMemoryJobQueue,
  InMemoryRealtimeFanout,
  IntegrationProviderSettings,
  isComposioEnabled,
  isMessagingSurfaceEnabled,
  LocalAgentHomeStore,
  LocalArtifactStore,
  McpConnector,
  McpOAuthBroker,
  messagingPlatformsFromEnv,
  PiOAuthLogins,
  PostgresRealtimeFanout,
  PostgresSessionLog,
  pushTokenPath,
  reconcileComputerUpdates,
  removeUserSkillDirs,
  SmtpEmailProvider,
  SpaceDecisionProviderResolver,
  SpaceMemoryProviderResolver,
  toTeamChatInbound,
} from "@tangow/adapters";
import type { GuestConnector } from "@tangow/adapters/runtime-worker";
import { createAuth, isBlockedAuthPath } from "@tangow/auth";
import { signupPolicyFromEnv } from "@tangow/core";
import type { Pool, PrismaClient } from "@tangow/db";
import {
  createDb,
  createPool,
  createThreadEvents,
  deleteOwnerVolumes,
  parsePositiveInteger,
  provisionMessagingIdentity,
  requireMembership,
} from "@tangow/db";
import type { Logger } from "@tangow/logging";
import {
  createServiceLogger,
  enrichLogContext,
  getLogger,
  installLogger,
  SERVICE_NAMES,
} from "@tangow/logging";
import { requestLogging } from "@tangow/logging/hono";
import { MarkdownMemoryStore } from "@tangow/memory";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppEnv } from "./env.js";
import { loadEnv } from "./env.js";
import {
  createMessagingInboundHandler,
  teamChatSenderCanWakeMessageRoutines,
  wakeMessageRoutines,
} from "./messaging-inbound.js";
import { mountMessagingWebhookRoutes } from "./messaging-webhook.js";
import { moveMcpSources } from "./move-mcp-sources.js";
import { mountApiRequestBodyLimits } from "./request-body-limit.js";
import { createRouter } from "./router.js";
import { mountScreenTarget } from "./screen-proxy.js";
import { isDeferredReservationLost, TeamChatBridge } from "./team-chat-bridge.js";
import { ModelTeamChatEngagementJudge } from "./team-chat-judge.js";
import {
  PendingTeamChatInbound,
  prefersTeamChatSurface,
  settleWithTimeout,
  TEAM_CHAT_STARTUP_SHUTDOWN_MS,
} from "./team-chat-startup.js";
import { mountVoiceHttpRoutes } from "./voice.js";
import { mountWebhookHttpRoutes } from "./webhook.js";

export interface AppHandles {
  app: Hono;
  prisma: PrismaClient;
  jobs: JobPublisher;
  sandbox: SandboxProvider;
  connector: DestinationEmulator;
  composio?: ComposioProvider;
  connectors: ConnectorRegistry;
  messaging?: MessagingSurface;
  email?: TransactionalEmailProvider;
  executor: ReturnType<typeof createRunExecutor>;
  runtime: AgentRuntime;
  stop: () => Promise<void>;
}

export async function createApp(
  overrides: Partial<AppEnv> & {
    prisma?: PrismaClient;
    realtime?: RealtimeFanout;
    sandbox?: SandboxProvider;
    workers?: WorkerProvider & GuestConnector;
    composio?: ComposioProvider;
    messaging?: MessagingSurface;
    email?: TransactionalEmailProvider;
    remoteConnectors?: RemoteTransportDependencies;
    logger?: Logger;
  } = {},
): Promise<AppHandles> {
  const {
    prisma: prismaOverride,
    realtime: realtimeOverride,
    sandbox: sandboxOverride,
    workers: workersOverride,
    composio: composioOverride,
    messaging: messagingOverride,
    email: emailOverride,
    remoteConnectors,
    logger: loggerOverride,
    ...envOverrides
  } = overrides;
  const env = { ...loadEnv(process.env), ...envOverrides };
  const logger = loggerOverride ?? createServiceLogger({ service: SERVICE_NAMES.api });
  installLogger(logger);
  const created = prismaOverride
    ? { prisma: prismaOverride, pool: undefined }
    : createDb(env.databaseUrl, {
        poolMax: parsePositiveInteger(process.env.DB_POOL_MAX, 4),
        applicationName: "tangow-api",
      });
  const { prisma } = created;
  const realtime =
    realtimeOverride ??
    (created.pool
      ? new PostgresRealtimeFanout({
          connectionString: env.realtimeDatabaseUrl,
          publisher: created.pool,
        })
      : new InMemoryRealtimeFanout());
  const secrets = new EncryptedSecretStore(env.encryptionKey);
  await moveMcpSources(prisma, secrets, (message) => logger.warn(message));
  const events = createThreadEvents(prisma, realtime, {
    runSecretWriter: createRunSecretWriter(secrets),
  });
  const environmentSignupPolicy = signupPolicyFromEnv(env);
  const deploymentSettings = await prisma.deploymentSettings.upsert({
    where: { id: "default" },
    create: {
      id: "default",
      signupsEnabled: environmentSignupPolicy.enabled,
      signupAllowlist: environmentSignupPolicy.allowlist.join(","),
      signupPolicyInitialized: true,
    },
    update: {},
  });
  if (!deploymentSettings.signupPolicyInitialized) {
    // Older versions created this row with schema defaults even though auth
    // still enforced the environment policy. Copy that effective policy once
    // so upgrades preserve behavior before Settings becomes authoritative.
    await prisma.deploymentSettings.updateMany({
      where: { id: "default", signupPolicyInitialized: false },
      data: {
        signupsEnabled: environmentSignupPolicy.enabled,
        signupAllowlist: environmentSignupPolicy.allowlist.join(","),
        signupPolicyInitialized: true,
      },
    });
  }

  const jobKind = env.wakeupDriver;
  const inMemoryJobs = jobKind === "memory" ? new InMemoryJobQueue() : undefined;
  // prismaOverride skips createDb, so there is no shared pool. The previous
  // GraphileJobPublisher(databaseUrl) path opened its own connections; keep a
  // bounded pool for that override path instead of passing undefined.
  let ownedJobPool: Pool | undefined;
  if (!inMemoryJobs && !created.pool) {
    ownedJobPool = createPool(env.databaseUrl, {
      poolMax: parsePositiveInteger(process.env.DB_POOL_MAX, 4),
      applicationName: "tangow-api-jobs",
    });
  }
  const jobPool = created.pool ?? ownedJobPool;
  const jobs = inMemoryJobs
    ? inMemoryJobs
    : new GraphileJobPublisher(
        jobPool ??
          (() => {
            throw new Error("Graphile job publisher requires a PostgreSQL pool");
          })(),
      );
  const sandbox: SandboxProvider =
    sandboxOverride ??
    createSandboxProvider(env.sandboxProvider, {
      supervisorUrl: env.sandboxSupervisorUrl,
      supervisorToken: env.sandboxSupervisorToken,
      e2bApiKey: env.e2bApiKey,
    });
  const mcpOAuth = new McpOAuthBroker(prisma, secrets, remoteConnectors);
  const memoryProviders = new SpaceMemoryProviderResolver(prisma, secrets);
  const decisionProviders = new SpaceDecisionProviderResolver(prisma, secrets);
  const oauthLogins = new PiOAuthLogins();
  const home = new LocalAgentHomeStore(env.dataDir);
  const artifacts = new LocalArtifactStore(env.dataDir);
  // Optional trace export of worker runs and the controller's model calls. Without configuration
  // this resolves to nothing, so no span is recorded and no vendor endpoint is ever contacted.
  const traceExport = createTraceExporterFromEnv(process.env);
  if (traceExport.warning) logger.warn(traceExport.warning);
  const trace = { exporter: traceExport.exporter, serviceName: SERVICE_NAMES.api };
  const workers = composeWorkers(
    prisma,
    workersOverride ?? createWorkerProvider(env.workerProvider),
    trace,
  );
  const runtime = composeInProcessRuntime(env.agentRuntime, workers, trace);
  const memory = new MarkdownMemoryStore(prisma);
  const mcp = new McpConnector(
    prisma,
    secrets,
    {
      stdioEnabled: env.mcpStdioEnabled,
      allowedCommands: env.mcpStdioAllowedCommands,
      network: remoteConnectors,
    },
    mcpOAuth,
  );
  // This process registers the inbound sink (messaging.onInbound below),
  // so it's the one that must hold Telegram's live getUpdates connection —
  // see messagingPlatformsFromEnv's docstring for why a second poller
  // elsewhere (e.g. the worker) would actively break this.
  const messagingPlatforms = messagingPlatformsFromEnv(env, { pollInboundMessages: true });
  const messaging =
    messagingOverride ??
    (isMessagingSurfaceEnabled(messagingPlatforms, {
      deploymentModelKey: env.deploymentModelKey,
      openSignup: env.messagingOpenSignup,
    })
      ? new ChatSdkMessagingSurface(messagingPlatforms)
      : undefined);
  const localEmailEmulator =
    !emailOverride && !env.smtpUrl && env.emailEmulator
      ? new EmailEmulator((message) => {
          getLogger().info("email emulator captured message", {
            "email.subject": message.subject,
          });
        })
      : undefined;
  if (localEmailEmulator && !isLoopbackHost(env.apiHost)) {
    throw new Error("EMAIL_EMULATOR requires API_HOST to be a loopback host");
  }
  const email: TransactionalEmailProvider | undefined =
    emailOverride ??
    (env.smtpUrl
      ? new SmtpEmailProvider({ url: env.smtpUrl, from: env.emailFrom ?? "" })
      : localEmailEmulator);
  const integrationSettings = new IntegrationProviderSettings(prisma, secrets, {
    composio:
      composioOverride ??
      (isComposioEnabled(env.composioApiKey)
        ? new ComposioConnector(env.composioApiKey)
        : undefined),
  });
  const stack = createConnectorStack(false, composioOverride, [
    ...integrationSettings
      .providers()
      .filter((provider) => !composioOverride || provider.describe().id !== "composio"),
    mcp,
  ]);
  const connector = stack.destination;
  await connector.start();
  integrationSettings.warmDirectories();
  const notifications = new ExpoPushProvider(env.dataDir);
  const auth = createAuth(prisma, {
    secret: env.authSecret,
    baseURL: env.authUrl,
    webOrigin: env.webOrigin,
    signupsEnabled: env.signupsEnabled,
    signupAllowlist: env.signupAllowlist,
    email,
    onEmailError: (error) => getLogger().error("transactional email delivery failed", error),
    extraOrigins: [
      "tangow://",
      "exp://",
      "exp://*",
      "http://localhost:8081",
      "http://127.0.0.1:8081",
      "http://localhost:19006",
      "http://127.0.0.1:19006",
    ],
    beforeDeleteUser: async (userId, { personalOrganizationIds }) => {
      const context = (spaceId: string) => ({
        operationId: `account-delete:${userId}`,
        traceId: `account-delete:${userId}`,
        spaceId,
        userId,
        signal: new AbortController().signal,
      });
      const bots = await prisma.bot.findMany({
        where: { userId },
        select: { id: true, userId: true, spaceId: true, name: true, archivedAt: true },
      });
      await Promise.all(
        bots.map((bot) =>
          destroyBot(
            {
              prisma,
              sandbox,
              home,
              jobs,
              events,
              artifacts,
              dataDir: env.dataDir,
              workerLifecycle: workers.lifecycle,
            },
            bot,
            { ...context(bot.spaceId), botId: bot.id },
            { deleteMemories: true },
          ),
        ),
      );
      // What remains is their memory in Spaces they joined: their own there, and their private
      // memory of bots shared with them. Team memory is stored under each bot's owner.
      await prisma.memoryDocument.deleteMany({ where: { userId } });
      // Deleting those organizations deletes their spaces, which a volume row would block.
      const spaces = await prisma.space.findMany({
        where: { organizationId: { in: personalOrganizationIds } },
        select: { id: true },
      });
      for (const { id: spaceId } of spaces) {
        await workers.lifecycle.releaseOwnerWorkers({ spaceId }, context(spaceId));
        await prisma.$transaction((tx) => deleteOwnerVolumes(tx, { spaceId }));
      }
      if (spaces.length > 0) {
        await workers.lifecycle
          .sweepVolumes(context(spaces[0]!.id))
          .catch((error) => getLogger().error("volume sweep after account deletion", error));
      }
      await rm(pushTokenPath(env.dataDir, userId), { force: true }).catch(() => undefined);
      await removeUserSkillDirs(env.dataDir, userId);
    },
  });
  const shutdown = new AbortController();
  // Its own small pool: a held skill lock must never take a connection the change itself needs.
  const skillLockPool = createPool(env.databaseUrl, {
    poolMax: 2,
    applicationName: "tangow-api-skill-lock",
  });
  const skillLock = createPostgresSkillLock(skillLockPool);
  const sessionLog = new PostgresSessionLog(prisma);
  const feedback = createFeedbackProvider();
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
      env.deploymentModelKey ?? "",
      env.composioApiKey ?? "",
      feedback?.secret ?? "",
    ].filter(Boolean),
    secretStore: secrets,
    secretHttp: remoteConnectors,
    deploymentModelKey: env.deploymentModelKey,
    dataDir: env.dataDir,
    notifications,
    jobs,
    events,
    messaging: messaging ? createMessagingContextLoader(prisma) : undefined,
    web: createWebProvider(),
    feedback: feedback?.provider,
    version: env.gitSha ?? env.imageTag,
    shutdownSignal: shutdown.signal,
    skillLearning: env.skillLearning,
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
    workerId: "api",
    runtime,
    secretStore: secrets,
    memory,
    memoryProviders,
    deploymentModelKey: env.deploymentModelKey,
    messaging,
    artifacts,
    homeMove:
      env.sandboxProvider === "docker"
        ? { prisma, workers: workers.lifecycle, dataDir: env.dataDir }
        : undefined,
  });
  if (inMemoryJobs) {
    await inMemoryJobs.start(jobHandlers);
  }
  const reconciler = inMemoryJobs
    ? createJobReconciler({
        prisma,
        jobs,
        reconcileComputerUpdates: () => reconcileComputerUpdates({ prisma, jobs }),
        purgeLinkPreviews: createLinkPreviewPurge({ prisma, artifacts }),
        sweepSkillLines: createSkillLineSweep({
          prisma,
          events,
          sessionLog,
          lineOnlyMessages: env.skillLearning !== "off",
        }),
        reconcileWorkers: workers.reconcileWorkers,
      })
    : undefined;
  reconciler?.start();

  const router = createRouter({
    prisma,
    workerLifecycle: workers.lifecycle,
    workers: workers.lifecycle,
    skillLock,
    events,
    sessionLog,
    auth,
    jobs,
    sandbox,
    memory,
    memoryProviders,
    home,
    secrets,
    oauthLogins,
    integrationSettings,
    mcpOAuth,
    composio: stack.composio,
    connectors: stack.connector,
    remoteConnectors,
    artifacts,
    dataDir: env.dataDir,
    messaging: {
      enabled: Boolean(messaging),
      providers: messaging?.platforms().map((platform) => platform.provider) ?? [],
      openSignup: env.messagingOpenSignup,
    },
    env: {
      agentRuntime: env.agentRuntime,
      defaultProvider: env.defaultProvider,
      defaultModel: env.defaultModel,
      teamChatJudgeProvider: env.teamChatJudgeProvider,
      teamChatJudgeModel: env.teamChatJudgeModel,
      deploymentModelKey: env.deploymentModelKey,
      webOrigin: env.webOrigin,
      screenProxySecret: env.screenProxySecret,
      sandboxProvider: env.sandboxProvider,
      gitSha: env.gitSha,
      updaterUrl: env.updaterUrl,
      updaterToken: env.updaterToken,
      imageTag: env.imageTag,
      mcpStdioEnabled: env.mcpStdioEnabled,
      mcpStdioAllowedCommands: env.mcpStdioAllowedCommands,
    },
  });
  const rpc = new RPCHandler(router, {
    clientInterceptors: [onError((error, { path }) => logUnexpectedRpcError(error, path))],
  });
  const app = new Hono();
  app.use("*", requestLogging(logger));
  app.use(
    "*",
    cors({
      origin: (origin) => {
        if (!origin) return env.webOrigin;
        return isTrustedOrigin(origin, env) ? origin : "";
      },
      credentials: true,
    }),
  );
  app.get("/api/auth/capabilities", (c) =>
    c.json({
      passwordReset: Boolean(email),
      resetUrl: email ? new URL("/reset-password", env.webOrigin).href : null,
    }),
  );
  if (localEmailEmulator && env.nodeEnv === "development") {
    app.get(
      "/api/dev/emails",
      () =>
        new Response(JSON.stringify(localEmailEmulator.sent), {
          headers: { "cache-control": "no-store", "content-type": "application/json" },
        }),
    );
  }
  mountApiRequestBodyLimits(app);
  mountScreenTarget(app, prisma, env.screenProxySecret);
  app.on(["GET", "POST"], "/api/auth/*", async (c) => {
    const path = new URL(c.req.url).pathname.replace("/api/auth", "");
    if (isBlockedAuthPath(path)) {
      return c.json({ error: "Not available in version 1" }, 404);
    }
    return auth.handler(c.req.raw);
  });
  app.use("/rpc/*", async (c, next) => {
    const session = await auth.api.getSession({ headers: sessionHeaders(c.req.raw) });
    const requestedSpaceId = c.req.header("x-tangow-space-id");
    const actor = session?.user
      ? await requireMembership(prisma, session.user.id, requestedSpaceId).catch(() => null)
      : null;
    if (actor) {
      enrichLogContext({ "user.id": actor.userId, "space.id": actor.spaceId });
    }
    const { matched, response } = await rpc.handle(c.req.raw, {
      prefix: "/rpc",
      context: { actor, signal: c.req.raw.signal },
    });
    if (matched) return c.newResponse(response.body, response);
    await next();
  });
  mountVoiceHttpRoutes(app, { prisma, secrets }, async (c) => {
    const session = await auth.api.getSession({ headers: sessionHeaders(c.req.raw) });
    if (!session?.user) return null;
    const actor = await requireMembership(
      prisma,
      session.user.id,
      c.req.header("x-tangow-space-id"),
    ).catch(() => null);
    if (actor) enrichLogContext({ "user.id": actor.userId, "space.id": actor.spaceId });
    return actor;
  });
  mountWebhookHttpRoutes(app, { prisma, secrets, events, jobs });
  // Shared with stop so a shutdown during retry delays does not restart polling.
  let messagingStopped = false;
  let clearMessagingRetryDelay: (() => void) | undefined;
  let messagingInitTask: Promise<void> | undefined;
  let clearTeamChatRetryDelay: (() => void) | undefined;
  let teamChatInitTask: Promise<void> | undefined;
  // Messaging webhooks only exist when the surface is enabled.
  let teamChatBridge: TeamChatBridge | undefined;
  /** Constructed even before start() succeeds so stop() can cancel in-flight startup. */
  let teamChatBridgeInstance: TeamChatBridge | undefined;
  const pendingTeamChatInbound = new PendingTeamChatInbound();
  if (messaging) {
    const inboundDeps = {
      prisma,
      events,
      jobs,
      provision: (request, policyEnv) => provisionMessagingIdentity(prisma, request, policyEnv),
      openSignup: env.messagingOpenSignup,
      signupPolicy: {
        signupsEnabled: env.signupsEnabled,
        signupAllowlist: env.signupAllowlist,
      },
      typing: (threadId) => {
        // Keep conversation addresses out of trace ids — those reach logs
        // and telemetry, a different trust boundary than the database.
        const operationId = `messaging.typing:${randomUUID()}`;
        return messaging.sendTyping(threadId, {
          operationId,
          traceId: operationId,
          spaceId: "",
          userId: "",
          // Cosmetic side call: the wait is bounded so a stalled vendor
          // response never holds our callback chain (the Chat SDK adapter
          // API cannot cancel the underlying request itself).
          signal: AbortSignal.timeout(2000),
        });
      },
    } satisfies Parameters<typeof createMessagingInboundHandler>[0];
    const inbound = createMessagingInboundHandler(inboundDeps);
    const handleTeamChatInbound = async (
      bridge: TeamChatBridge,
      event: Parameters<typeof wakeMessageRoutines>[2],
    ) => {
      const mapped = toTeamChatInbound(event);
      if (!mapped) {
        await inbound(event);
        return;
      }
      const canWake = await teamChatSenderCanWakeMessageRoutines(inboundDeps, event);
      if (!canWake) {
        await bridge.receive(mapped);
        return;
      }

      // Persist a non-reconcilable row until routine routing owns or releases
      // the message, so the timer cannot start a second TeamChat run.
      const target = await bridge.receive(mapped, { queueAgent: false });
      if (!target.deferred) return;
      const leaseHeartbeat = await bridge.startDeferredReservationHeartbeat(
        target.externalMessageId,
      );
      let woken = false;
      bridge.markRoutineWakeInFlight(target.externalMessageId);
      try {
        const wakePromise = wakeMessageRoutines(inboundDeps, target, event, {
          // Must match TeamChatBridge ExternalConversation / recovery provider.
          deliveryProvider: bridge.providerId,
          externalMessageId: target.externalMessageId,
        });
        try {
          woken = await Promise.race([wakePromise, leaseHeartbeat.lost]);
        } catch (error) {
          if (isDeferredReservationLost(error)) {
            // Lease loss must not start a fallback agent beside an in-flight
            // wake: re-hold exclusive ownership while awaiting that wake, then
            // resolve from its settled result.
            let hold: { stop: () => void } | undefined;
            try {
              hold = await bridge.startDeferredReservationHeartbeat(target.externalMessageId);
            } catch {
              // Row already left deferred; wake CAS / resolve decide the winner.
            }
            try {
              try {
                woken = await wakePromise;
              } catch (wakeError) {
                const released = await bridge.resolveDeferredMessage(
                  target.externalMessageId,
                  "agent",
                  mapped.kind,
                );
                if (!released) {
                  throw new Error("Team chat deferred message ownership conflict", {
                    cause: wakeError,
                  });
                }
                await bridge.reconcileOnce();
                getLogger().error(
                  "team chat routine wake failed after deferred lease loss",
                  wakeError,
                );
                return;
              }
            } finally {
              hold?.stop();
            }
          } else {
            await bridge.resolveDeferredMessage(target.externalMessageId, "agent", mapped.kind);
            await bridge.reconcileOnce();
            throw error;
          }
        }
        const resolved = await bridge.resolveDeferredMessage(
          target.externalMessageId,
          woken ? "routine" : "agent",
          mapped.kind,
        );
        if (!resolved) {
          throw new Error("Team chat deferred message ownership conflict");
        }
        if (!woken) await bridge.reconcileOnce();
      } finally {
        bridge.clearRoutineWakeInFlight(target.externalMessageId);
        leaseHeartbeat.stop();
      }
    };
    const flushPendingTeamChatInbound = (bridge: TeamChatBridge) => {
      pendingTeamChatInbound.flush((event) => handleTeamChatInbound(bridge, event));
    };
    if (env.teamChatBotId) {
      const judge =
        env.teamChatJudgeProvider && env.teamChatJudgeModel
          ? new ModelTeamChatEngagementJudge({
              prisma,
              runtime,
              secrets,
              deploymentProvider: env.defaultProvider,
              deploymentModel: env.defaultModel,
              deploymentModelKey: env.deploymentModelKey,
              providerOverride: env.teamChatJudgeProvider,
              modelOverride: env.teamChatJudgeModel,
            })
          : new ModelTeamChatEngagementJudge({
              prisma,
              runtime,
              secrets,
              deploymentProvider: env.defaultProvider,
              deploymentModel: env.defaultModel,
              deploymentModelKey: env.deploymentModelKey,
            });
      const bridge = new TeamChatBridge({
        prisma,
        events,
        jobs,
        send: createMessagingTeamChatSender(messaging),
        providerId: "slack",
        botId: env.teamChatBotId,
        judge,
      });
      teamChatBridgeInstance = bridge;
      try {
        await bridge.start();
        teamChatBridge = bridge;
      } catch (error) {
        getLogger().error("team chat bridge failed to start; retrying", error);
        teamChatInitTask = (async () => {
          let delayMs = 2_000;
          while (!messagingStopped) {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, delayMs);
              clearTeamChatRetryDelay = () => {
                clearTimeout(timer);
                clearTeamChatRetryDelay = undefined;
                resolve();
              };
            });
            clearTeamChatRetryDelay = undefined;
            if (messagingStopped) return;
            try {
              await bridge.start();
              if (messagingStopped) {
                await bridge.stop();
                return;
              }
              teamChatBridge = bridge;
              flushPendingTeamChatInbound(bridge);
              return;
            } catch (retryError) {
              if (
                retryError instanceof Error &&
                retryError.message === "Team chat bridge start cancelled"
              ) {
                return;
              }
              getLogger().error("team chat bridge failed to start; retrying", retryError);
              delayMs = Math.min(delayMs * 5, 30_000);
            }
          }
        })();
      }
    }
    messaging.onInbound(async (event) => {
      if (event.type !== "message") {
        await applyMessagingOutboundStatus(prisma, event);
        return;
      }
      if (prefersTeamChatSurface(event, env.teamChatBotId)) {
        const bridge = teamChatBridge;
        if (bridge) {
          await handleTeamChatInbound(bridge, event);
          return;
        }
        // Bridge is still starting (or retrying). Do not fall through to the
        // personal-line inbound path — that bypasses externalMessage ownership
        // and can wake routines for unlinked TeamChat senders.
        if (teamChatInitTask) {
          const pending = pendingTeamChatInbound.enqueue(event);
          if (!pending) {
            throw new Error("Team chat inbound buffer is full");
          }
          await pending;
          return;
        }
        throw new Error("Team chat bridge is unavailable");
      }
      await inbound(event);
    });
    mountMessagingWebhookRoutes(app, { messaging });
    // Start polling-mode adapters (e.g. Telegram with no public webhook URL
    // registered) immediately rather than waiting for the first webhook
    // POST or outbound send to lazily trigger it. This is the process that
    // owns the inbound sink registered just above, so it must be the one
    // holding the live connection — a second poller elsewhere (e.g. the
    // worker) would only fight this one for Telegram's single getUpdates
    // slot without ever seeing the messages itself.
    // Bounded retries cover transient Telegram startup failures; polling-only
    // bots otherwise stay dark until an unrelated outbound send re-inits.
    messagingInitTask = (async () => {
      const delayMs = [0, 2_000, 10_000];
      for (let attempt = 0; attempt < delayMs.length; attempt += 1) {
        if (messagingStopped) return;
        if (delayMs[attempt]! > 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, delayMs[attempt]);
            clearMessagingRetryDelay = () => {
              clearTimeout(timer);
              clearMessagingRetryDelay = undefined;
              resolve();
            };
          });
          clearMessagingRetryDelay = undefined;
        }
        if (messagingStopped) return;
        try {
          await messaging.initialize?.();
          return;
        } catch (error) {
          getLogger().error(
            attempt === delayMs.length - 1
              ? "messaging surface initialize failed"
              : "messaging surface initialize failed; retrying",
            error,
          );
        }
      }
    })();
  }

  app.get("/health", (c) =>
    c.json({
      ok: true,
      runtime: env.agentRuntime,
      sandbox: env.sandboxProvider,
      composio: Boolean(stack.composio),
      messaging: Boolean(messaging),
      email: email?.describe().id ?? null,
      jobs: jobKind,
      realtime: realtime.describe().id,
      revision: env.gitSha ?? null,
    }),
  );

  return {
    app,
    prisma,
    jobs,
    sandbox,
    connector,
    composio: stack.composio,
    connectors: stack.connector,
    messaging,
    email,
    executor,
    runtime,
    stop: async () => {
      // Abort in-flight continueRun boot waits before draining jobs so stop() cannot sit
      // on waitForComputerReady for the full boot-wait window during shared Postgres journeys.
      shutdown.abort();
      oauthLogins.abortAll();
      messagingStopped = true;
      clearMessagingRetryDelay?.();
      clearTeamChatRetryDelay?.();
      pendingTeamChatInbound.reject(new Error("Team chat bridge stopped before startup"));
      // Cancel in-flight start() before awaiting the retry task so stop() cannot
      // sit on DB/reconcile work that bridge.start() is still running.
      await settleWithTimeout(
        teamChatBridgeInstance ? teamChatBridgeInstance.stop().catch(() => undefined) : undefined,
        TEAM_CHAT_STARTUP_SHUTDOWN_MS,
      );
      await messagingInitTask?.catch(() => undefined);
      await settleWithTimeout(teamChatInitTask, TEAM_CHAT_STARTUP_SHUTDOWN_MS);
      await messaging?.shutdown?.();
      await teamChatBridge?.stop();
      await email?.drain?.();
      await reconciler?.stop();
      await jobs.close();
      await realtime.close();
      await connector.stop();
      await mcp.close();
      await prisma.$disconnect().catch(() => undefined);
      await created.pool?.end().catch(() => undefined);
      await ownedJobPool?.end().catch(() => undefined);
      await skillLockPool.end().catch(() => undefined);
      await traceExport.exporter?.flush(2_000);
      await logger.flush({ timeoutMs: 2_000 });
    },
  };
}

function isTrustedOrigin(origin: string, env: AppEnv) {
  if (!origin) return true;
  if (origin === env.webOrigin || origin === env.apiUrl || origin === env.authUrl) return true;
  if (origin.startsWith("tangow://") || origin.startsWith("exp://")) return true;
  try {
    const host = new URL(origin).hostname;
    return isLoopbackHost(host);
  } catch {
    return false;
  }
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function sessionHeaders(request: Request) {
  const headers = new Headers(request.headers);
  const authz = headers.get("authorization");
  if (authz?.toLowerCase().startsWith("bearer ") && !headers.get("cookie")) {
    headers.set("cookie", `better-auth.session_token=${authz.slice(7).trim()}`);
  }
  return headers;
}

/**
 * An ORPCError is a decision the router made (BAD_REQUEST, UNAUTHORIZED, ...) and reaches the
 * caller intact. Everything else is flattened into an opaque "Internal server error", so
 * unless it is logged here the only record of what actually broke is gone.
 *
 * The cause chain matters as much as the message: undici and most SDKs report a bare
 * "fetch failed" and keep the host and errno one level down.
 */
export function logUnexpectedRpcError(error: unknown, path: readonly string[]): void {
  if (error instanceof ORPCError) return;
  const where = `rpc ${path.join("/")} failed`;
  getLogger().error(where, error);
}
