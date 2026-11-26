import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { type AgentRuntime, type JobPublisher, runJobKey } from "@tangow/adapter-kit";
import {
  MessagingTeamChatEmulator,
  skillDirName,
  skillLinesByRun,
  userSkillsRoot,
} from "@tangow/adapters";
import type { ModelConnectInput, RunStatus, ThreadSnapshot } from "@tangow/contracts";
import { ACTIVE_RUN_STATUSES, isTerminal, projectThreadItems } from "@tangow/core";
import type { createDb } from "@tangow/db";
import { runMessages } from "@tangow/db";
import { sessionCookieHeader } from "../index.js";
import type { EvalCase, Evidence } from "./cases.js";
import { emptyTrial, type FailureCategory, redact, type TrialResult } from "./report.js";
import { EvalServices } from "./services.js";

type App = { request: (input: string, init?: RequestInit) => Promise<Response> };
export type EvalApp = {
  app: App;
  prisma: ReturnType<typeof createDb>["prisma"];
  jobs: JobPublisher;
  runtime: AgentRuntime;
  /** Where the trial's app keeps its files, skills included. */
  dataDir: string;
  harnessIssues?: readonly string[];
  /** Readies each bot the trial creates, before its first message. */
  prepareBot?: (botId: string) => Promise<void>;
  connector?: { records: readonly unknown[] };
  stop: () => Promise<void>;
};
export type EvalActor = {
  botId: string;
  cookie: string;
  userId: string;
  spaceId: string;
};
export type TrialOptions = {
  connection: ModelConnectInput;
  timeoutMs: number;
  maxToolCalls: number;
  createApp: (services: EvalServices, messaging: MessagingTeamChatEmulator) => Promise<EvalApp>;
};
class EvalFailure extends Error {
  constructor(
    readonly category: FailureCategory,
    message: string,
  ) {
    super(message);
  }
}

/** No coaching retries: scenario setup turns are intentional steps, never repair prompts. */
export async function runTrial(
  scenario: EvalCase,
  trial: number,
  options: TrialOptions,
): Promise<TrialResult> {
  const result = emptyTrial(scenario.id, trial);
  const started = Date.now();
  const deadline = started + options.timeoutMs;
  const services = new EvalServices();
  const messaging = new MessagingTeamChatEmulator({
    provider: "slack",
    capabilities: { groups: false },
  });
  scenario.configure?.(services);
  let handles: EvalApp | undefined;
  let cookie = "";
  let botId = "";
  const runIds: string[] = [];
  const actors: EvalActor[] = [];
  let pendingApproval: Evidence["pendingApproval"] = null;
  let approvalPending = false;
  let priorMemory = "";
  let messagingLinked = false;
  let messagingAddress = "";
  let messagingOriginThreadId: string | null = null;
  const skillCalls: Evidence["skillCalls"] = [];
  const secrets = [options.connection.apiKey ?? "", options.connection.baseUrl ?? ""];
  let phase: FailureCategory = "harness";
  const seenTools = new Map<string, { name: string; botId: string | null }>();
  const teammates = new Map<string, string>();
  let clearedToolCount = 0;
  const seenUsage = new Map<string, { inputTokens: number; outputTokens: number }>();
  // The bots' own tool calls; a helper's run in its own session is not one of them.
  const toolCalls = () => ({
    type: "tool.call",
    session: {
      spaceId: { in: actors.map((actor) => actor.spaceId) },
      kind: { not: "subagent" },
    },
  });
  const countCurrentTools = () => handles!.prisma.sessionEntry.count({ where: toolCalls() });
  // Clearing conversation history deletes its usage rows. Preserve observed records by id so
  // multi-turn totals and budgets never reset or double count.
  const captureTools = async () => {
    if (!handles) return seenTools.size;
    const calls = await handles.prisma.sessionEntry.findMany({
      where: {
        ...toolCalls(),
        ...(seenTools.size ? { id: { notIn: [...seenTools.keys()] } } : {}),
      },
      select: { id: true, payload: true, botId: true },
    });
    for (const call of calls)
      seenTools.set(call.id, {
        name: redact(String((call.payload as { name?: string }).name ?? "unknown"), secrets),
        botId: call.botId,
      });
    return seenTools.size;
  };
  const captureUsage = async () => {
    if (!handles) return;
    const usage = await handles.prisma.usageRecord.findMany({
      where: { OR: actorScopes(actors) },
      select: { id: true, inputTokens: true, outputTokens: true },
    });
    for (const row of usage) seenUsage.set(row.id, row);
  };
  try {
    handles = await options.createApp(services, messaging);
    const { app, prisma } = handles;
    const setupActor = async () => {
      const signup = await app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
        body: JSON.stringify({
          email: `eval-${randomUUID()}@example.test`,
          password: "synthetic-eval-password-12",
          name: "Eval User",
        }),
      });
      if (!signup.ok) throw new EvalFailure("harness", `Fixture signup failed (${signup.status})`);
      cookie = sessionCookieHeader(signup);
      await rpc(app, cookie, "models/connect", options.connection);
      for (const provider of scenario.connections ?? ["GMAIL", "CRM", "GITHUB"])
        await rpc(app, cookie, "connections/begin", {
          connectorId: "composio",
          provider,
          displayName: provider,
        });
      const createBot = (name: string, title: string, description: string) =>
        rpc<{ id: string }>(app, cookie, "bots/create", {
          name,
          title,
          description,
          instructions: "",
          notifyOnFinish: false,
        });
      const useTrialModel = (id: string) =>
        rpc(app, cookie, "bots/update", {
          botId: id,
          modelProvider: options.connection.provider,
          modelId: options.connection.modelId,
        });
      const bot = await createBot(
        "Assistant",
        scenario.bot?.title ?? "",
        scenario.bot?.description ?? "",
      );
      botId = bot.id;
      await handles?.prepareBot?.(botId);
      const persistedBot = await prisma.bot.findUniqueOrThrow({
        where: { id: botId },
        select: { userId: true, spaceId: true },
      });
      actors.push({ botId, cookie, ...persistedBot });
      await useTrialModel(botId);
      for (const teammate of scenario.teammates ?? []) {
        const created = await createBot(teammate.name, teammate.title, teammate.description);
        await handles?.prepareBot?.(created.id);
        await useTrialModel(created.id);
        teammates.set(created.id, teammate.name);
      }
      messagingLinked = false;
      messagingAddress = `U-eval-${randomUUID()}`;
      messaging.resetWitnesses();
      if (scenario.approvalTool)
        await rpc(app, cookie, "approvalRules/set", {
          effect: "require_approval",
          matchKind: "tool",
          matchValue: scenario.approvalTool,
        });
    };
    await setupActor();
    for (const skill of scenario.skills ?? []) await rpc(app, cookie, "agentSkills/create", skill);
    if (scenario.taughtSkill) {
      // Human-authored fixture setup via the same API as the teaching UI; no model work is prefilled.
      await rpc(app, cookie, "computer/boot", { botId });
      await rpc(app, cookie, "computer/takeover", { botId });
      const skill = await rpc<{ id: string }>(app, cookie, "skills/start", {
        botId,
        goal: "Dispatch label",
      });
      await rpc(app, cookie, "computer/input", { botId, kind: "key", payload: { key: "x" } });
      await rpc(app, cookie, "skills/stop", { skillId: skill.id });
      await rpc(app, cookie, "skills/updateDraft", {
        skillId: skill.id,
        name: "Dispatch label",
        playbook: {
          whenToUse: "When asked to run Dispatch label for a city and item count.",
          inputs: ["city", "item count"],
          steps: [
            "Convert city to uppercase and item count to digits.",
            "Write results/dispatch.txt in your home, containing CITY | COUNT | PACKED with the actual values. For example PARIS | 2 | PACKED.",
          ],
          howToCheck: "Read the file and verify the city, count and PACKED marker.",
          whatToReturn: "The saved file path.",
          approvalBoundaries: "No connected-app writes are part of this workflow.",
          failureHandling: "Report a missing input; do not invent it.",
        },
      });
      await rpc(app, cookie, "skills/save", { skillId: skill.id, name: "Dispatch label" });
    }
    phase = "product";
    let lastText = "";
    for (const [stepIndex, step] of scenario.steps.entries()) {
      if (Date.now() >= deadline) throw new EvalFailure("incomplete", "Trial time budget exceeded");
      if ("newWorkspace" in step) {
        priorMemory = (await rpc<Array<{ content: string }>>(app, cookie, "memory/list", { botId }))
          .map((m) => m.content)
          .join("\n");
        await setupActor();
        continue;
      }
      if ("clear" in step) {
        await Promise.all([captureTools(), captureUsage()]);
        await rpc(app, cookie, "threads/clear", { botId });
        clearedToolCount = seenTools.size - (await countCurrentTools());
        continue;
      }
      let runId: string;
      if ("ask" in step) {
        runId = (
          await rpc<{ runId: string }>(app, cookie, "threads/send", { botId, text: step.ask })
        ).runId;
      } else if ("answerCard" in step) {
        if (step.ifWaiting && !approvalPending) continue;
        const waiting = runIds.at(-1);
        const card = waiting
          ? await prisma.sessionEntry.findFirst({
              where: { runId: waiting, type: { in: ["assistant.ask", "effect.requested"] } },
              orderBy: { seq: "desc" },
              select: { id: true },
            })
          : null;
        if (!waiting || !card) throw new EvalFailure("agent", "No card waited for an answer");
        await rpc(app, cookie, "threads/answer", {
          botId,
          runId: waiting,
          messageId: card.id,
          answer: step.answerCard,
        });
        runId = waiting;
      } else if ("slack" in step) {
        if (!messagingLinked) {
          const link = await rpc<{ code: string }>(app, cookie, "messaging/link/start", { botId });
          await messaging.emitInbound({
            isDirect: true,
            from: messagingAddress,
            fromLabel: "Teammate",
            content: link.code,
          });
          await poll(async () => (messaging.sent.length > 0 ? true : undefined), deadline);
          messaging.resetWitnesses();
          messagingLinked = true;
        }
        const inbound = await messaging.emitInbound({
          isDirect: true,
          from: messagingAddress,
          fromLabel: "Teammate",
          content: step.slack,
        });
        messagingOriginThreadId = inbound.threadId;
        runId = await poll(
          async () =>
            (
              await prisma.run.findFirst({
                where: {
                  botId,
                  sourceMessage: {
                    is: {
                      payload: {
                        path: ["clientNonce"],
                        equals: `messaging:${inbound.provider}:${inbound.handle}`,
                      },
                    },
                  },
                },
                orderBy: { createdAt: "desc" },
                select: { id: true },
              })
            )?.id,
          deadline,
        );
      } else {
        const routines = await prisma.routine.findMany({ where: { botId } });
        if (routines.length !== 1)
          throw new EvalFailure("agent", "Expected exactly one authored routine");
        const routine = routines[0]!;
        if (!routine.active || !routine.crons.length)
          throw new EvalFailure("agent", "Authored routine was not scheduled");
        // Force the scheduler's clock edge, not the agent's work. Attribution starts after setup.
        services.calls.length = 0;
        services.seedGithubReleases([
          {
            owner: "example",
            repo: "widget",
            tag: "v2.2.0",
            name: "Widget 2.2",
            body: "Adds CSV import validation.",
            publishedAt: "2026-01-03T09:00:00Z",
            htmlUrl: "https://example.test/widget/releases/v2.2.0",
          },
          ...services.listGithubReleases(),
        ]);
        const scheduledFor = new Date(Date.now() - 1_000);
        await prisma.routine.update({
          where: { id: routine.id },
          data: { nextRunAt: scheduledFor },
        });
        await handles.jobs.enqueue({
          name: "routine.wakeup",
          payload: { routineId: routine.id, scheduledFor: scheduledFor.toISOString() },
        });
        runId = await poll(
          async () =>
            (
              await prisma.run.findFirst({
                where: { botId, routineId: routine.id, id: { notIn: runIds } },
                orderBy: { createdAt: "desc" },
              })
            )?.id,
          deadline,
        );
      }
      runIds.push(runId);
      let seenToolCount = result.toolCalls;
      const terminal = await poll(async () => {
        const [run, toolCount] = await Promise.all([
          prisma.run.findUnique({ where: { id: runId }, select: { status: true, error: true } }),
          countCurrentTools().then((count) => count + clearedToolCount),
        ]);
        seenToolCount = toolCount;
        if (toolCount > options.maxToolCalls)
          throw new EvalFailure("incomplete", "Tool call budget exceeded");
        if (run?.status === "waiting_input" && (scenario.approvalTool || scenario.expectsCard))
          return run;
        if (run && ["waiting_input", "waiting_approval", "paused"].includes(run.status))
          throw new EvalFailure("agent", "Agent requested assistance; no coaching supplied");
        return run && isTerminal(run.status as RunStatus) ? run : undefined;
      }, deadline);
      const calls = await prisma.sessionEntry.findMany({
        where: { runId, type: "tool.call" },
        orderBy: { seq: "asc" },
        select: { payload: true },
      });
      result.toolCalls = seenToolCount;
      result.trace.push({
        step: stepIndex + 1,
        status: terminal.status,
        tools: calls.map((call) =>
          redact(String((call.payload as { name?: string }).name ?? "unknown"), secrets),
        ),
      });
      if (
        terminal.status !== "completed" &&
        !((scenario.approvalTool || scenario.expectsCard) && terminal.status === "waiting_input")
      ) {
        // Provider attribution requires recognizable protocol/auth evidence; unknown runtime failures remain product failures.
        const error = terminal.error ?? "Run did not complete";
        const category =
          /\b(?:401|402|403|429)\b|rate.?limit|invalid api.?key|authentication.*(?:failed|error)/i.test(
            error,
          )
            ? "provider"
            : "product";
        throw new EvalFailure(category, error);
      }
      if ("slack" in step && terminal.status === "completed") {
        await waitForMessagingDelivery(prisma, runId, deadline);
      }
      const completions = await prisma.event.findMany({
        where: { runId, type: "agent.tool.completed" },
        orderBy: { seq: "asc" },
        select: { payload: true },
      });
      for (const { payload } of completions) {
        const { name, outcome } = payload as { name?: string; outcome?: string };
        if (name?.startsWith("skill_")) skillCalls.push({ tool: name, outcome: String(outcome) });
      }
      const snap = await rpc<ThreadSnapshot>(app, cookie, "threads/get", { botId });
      const items = projectThreadItems(snap.entries);
      const botBlocks = items.flatMap((item) =>
        item.kind === "message" && item.role === "bot" ? item.blocks : [],
      );
      const approvalIds = [
        ...botBlocks,
        ...items.flatMap((item) => (item.kind === "effect" && item.card ? [item.card] : [])),
      ].flatMap((block) =>
        block.kind === "ask" && typeof block.approvalEffectId === "string"
          ? [block.approvalEffectId]
          : [],
      );
      approvalPending = terminal.status === "waiting_input" && approvalIds.length > 0;
      pendingApproval = approvalPending
        ? await prisma.externalEffect.findFirst({
            where: { runId, status: "intended", id: { in: approvalIds } },
            select: { kind: true, request: true },
          })
        : null;
      lastText = botBlocks
        .flatMap((block) => (block.kind === "text" ? [block.text] : []))
        .join("\n");
    }
    const files: Evidence["files"] = {};
    // A worker run leaves the computer asleep; awake, it reads the files from the bot's volumes.
    if (scenario.files?.length) await rpc(handles.app, cookie, "computer/boot", { botId });
    for (const path of scenario.files ?? []) {
      try {
        files[path] = (
          await rpc<{ content: string }>(handles.app, cookie, "computer/readFile", { botId, path })
        ).content;
      } catch {
        files[path] = null;
      }
    }
    const memories = await rpc<Array<{ content: string }>>(handles.app, cookie, "memory/list", {
      botId,
    });
    const routines = await handles.prisma.routine.findMany({
      where: { botId },
      select: { name: true, prompt: true, crons: true, active: true },
    });
    const proposals = await handles.prisma.externalEffect.findMany({
      where: { kind: "routine_proposal", run: { botId } },
      orderBy: { createdAt: "asc" },
      select: { status: true, request: true, result: true },
    });
    await captureTools();
    const teammateRuns = (
      await prisma.run.findMany({
        where: { botId: { in: [...teammates.keys()] } },
        orderBy: { createdAt: "asc" },
        select: { botId: true, trigger: true },
      })
    ).map((run) => ({ name: teammates.get(run.botId)!, trigger: run.trigger }));
    const ownBotIds = new Set(actors.map((actor) => actor.botId));
    const skillsWritten: Evidence["skillsWritten"] = [];
    const listed = await rpc<Array<{ id: string; source: string }>>(
      app,
      cookie,
      "agentSkills/list",
    );
    const botRuns = await handles.prisma.run.findMany({ where: { botId }, select: { id: true } });
    const botWrites = [
      ...(
        await skillLinesByRun(
          handles.prisma,
          botRuns.map((run) => run.id),
        )
      ).values(),
    ].flat();
    for (const listedSkill of listed.filter((entry) => entry.source === "user")) {
      const byBot = botWrites.filter(
        (line) => line.skillId === listedSkill.id && line.change !== "deleted",
      );
      if (byBot.length === 0) continue;
      const current = await rpc<{ name: string; content: string }>(app, cookie, "agentSkills/get", {
        skillId: listedSkill.id,
      });
      skillsWritten.push({
        name: current.name,
        change: byBot.some((line) => line.change === "learned") ? "learned" : "updated",
        content: current.content,
        files: await skillFiles(
          path.join(userSkillsRoot(handles.dataDir, actors.at(-1)!), skillDirName(current.name)),
        ),
      });
    }
    const evidence: Evidence = {
      text: lastText,
      files,
      records: services.records,
      notes: services.notes,
      calls: services.calls,
      routines,
      proposals,
      memory: memories.map((m) => m.content).join("\n"),
      approvalPending,
      pendingApproval,
      priorMemory,
      destinationWrites: handles.connector?.records.length ?? 0,
      toolNames: [...seenTools.values()].map((event) => event.name),
      botToolNames: [...seenTools.values()]
        .filter((event) => event.botId !== null && ownBotIds.has(event.botId))
        .map((event) => event.name),
      teammateRuns,
      messaging: {
        originThreadId: messagingOriginThreadId,
        outbound: structuredClone(messaging.sent),
      },
      skillsWritten,
      skillCalls,
    };
    phase = "harness";
    result.criteria = scenario.grade(evidence);
    result.status =
      result.criteria.length > 0 && result.criteria.every((c) => c.pass) ? "passed" : "failed";
    result.category = result.status === "passed" ? null : "agent";
    result.reason = result.status === "passed" ? null : "Outcome criteria failed";
    if (result.status === "failed" && handles.harnessIssues?.length) {
      result.category = "harness";
      result.reason = handles.harnessIssues.join(" ");
    }
    result.artifacts = Object.fromEntries(
      Object.entries({
        ...files,
        "final-response": lastText,
        "memory-snapshot": evidence.memory,
      }).map(([key, value]) => [key, value === null ? null : redact(value, secrets)]),
    );
  } catch (error) {
    result.status = "failed";
    result.category = error instanceof EvalFailure ? error.category : phase;
    result.reason = redact(
      error instanceof Error ? error.message : "Unknown eval failure",
      secrets,
    );
  } finally {
    if (handles) {
      try {
        await cleanupActors(handles, actors);
      } catch {
        result.cleanupFailed = true;
      }
      await captureUsage().catch(() => undefined);
      if (seenUsage.size) {
        result.inputTokens = [...seenUsage.values()].reduce((n, u) => n + u.inputTokens, 0);
        result.outputTokens = [...seenUsage.values()].reduce((n, u) => n + u.outputTokens, 0);
      }
      // Include interrupted and cleared-run calls without retaining raw arguments or ids in reports.
      await captureTools().catch(() => undefined);
      const events = [...seenTools.values()];
      result.toolCalls = events.length;
      if (events.length > options.maxToolCalls) {
        result.status = "failed";
        result.category = "incomplete";
        result.reason = "Tool call budget exceeded";
      }
      if (!result.trace.length && events.length)
        result.trace.push({
          step: 0,
          status: "interrupted",
          tools: events.map((event) => event.name),
        });
    }
    try {
      await handles?.stop();
    } catch {
      result.cleanupFailed = true;
    }
    if (result.cleanupFailed) {
      result.status = "failed";
      result.category = "harness";
      result.reason = "Fixture cleanup failed; remaining trials must not start";
    }
    result.latencyMs = Date.now() - started;
  }
  return result;
}

async function rpc<T>(app: App, cookie: string, proc: string, body: unknown = {}): Promise<T> {
  const res = await app.request(`/rpc/${proc}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ json: body }),
    signal: AbortSignal.timeout(15_000),
  });
  const parsed = (await res.json()) as { json?: T; error?: unknown };
  if (!res.ok || parsed.error) throw new Error(`${proc} failed (${res.status})`);
  return parsed.json as T;
}

async function poll<T>(read: () => Promise<T | undefined>, deadline: number): Promise<T> {
  while (Date.now() < deadline) {
    const result = await read();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new EvalFailure("incomplete", "Trial time budget exceeded");
}

async function waitForMessagingDelivery(
  prisma: EvalApp["prisma"],
  runId: string,
  deadline: number,
): Promise<void> {
  await poll(
    async () =>
      (
        await prisma.run.findUnique({
          where: { id: runId },
          select: { messagingMirroredAt: true },
        })
      )?.messagingMirroredAt ?? undefined,
    deadline,
  );
  const messages = await runMessages(prisma, runId);
  await poll(async () => {
    const outbound = await prisma.messagingOutbound.findMany({
      where: { sourceMessageId: { in: messages.map((message) => message.id) } },
      select: { status: true, providerHandle: true },
    });
    return outbound.length > 0 &&
      outbound.every((row) => row.providerHandle !== null || row.status === "failed")
      ? true
      : undefined;
  }, deadline);
}

/** Every file of a skill folder, scripts/ and references/ included, by path inside it. */
async function skillFiles(dir: string): Promise<Array<{ path: string; content: string }>> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const full = path.join(entry.parentPath, entry.name);
        return { path: path.relative(dir, full), content: await readFile(full, "utf8") };
      }),
  );
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function actorScopes(actors: readonly EvalActor[]) {
  return actors.map(({ userId, spaceId }) => ({ userId, spaceId }));
}

async function findScopeBots(
  prisma: EvalApp["prisma"],
  actors: readonly EvalActor[],
): Promise<Array<{ id: string; userId: string; spaceId: string }>> {
  if (!actors.length) return [];
  return prisma.bot.findMany({
    where: { OR: actorScopes(actors) },
    select: { id: true, userId: true, spaceId: true },
  });
}

function cookieForBot(bot: { userId: string; spaceId: string }, actors: readonly EvalActor[]) {
  return actors.find((actor) => actor.userId === bot.userId && actor.spaceId === bot.spaceId)
    ?.cookie;
}

/** Disable scheduled work and stop every run in each isolated actor scope. */
export async function cleanupActors(
  handles: Pick<EvalApp, "app" | "prisma" | "jobs" | "runtime">,
  actors: readonly EvalActor[],
): Promise<void> {
  if (!actors.length) return;
  const failures: unknown[] = [];
  const scopes = actorScopes(actors);
  let stable = false;

  // A parent can finish spawning a child while its abort is settling. Repeat until
  // every bot and run visible after abort was included in the pass.
  for (let pass = 0; pass < 8; pass++) {
    let bots: Array<{ id: string; userId: string; spaceId: string }> = actors.map((actor) => ({
      id: actor.botId,
      userId: actor.userId,
      spaceId: actor.spaceId,
    }));
    let runsBeforeStop: Array<{ id: string }> = [];
    try {
      await handles.prisma.routine.updateMany({
        where: { OR: scopes },
        data: { active: false, nextRunAt: null },
      });
    } catch (error) {
      failures.push(error);
    }

    try {
      bots = await findScopeBots(handles.prisma, actors);
    } catch (error) {
      failures.push(error);
    }
    try {
      runsBeforeStop = await handles.prisma.run.findMany({
        where: { OR: scopes },
        select: { id: true },
      });
    } catch (error) {
      failures.push(error);
    }

    for (const bot of bots) {
      const actorCookie = cookieForBot(bot, actors);
      if (!actorCookie) {
        failures.push(new Error("No actor session for scoped bot"));
        continue;
      }
      try {
        await rpc(handles.app, actorCookie, "threads/stop", { botId: bot.id });
      } catch (error) {
        failures.push(error);
      }
    }

    let runsAfterStop: Array<{ id: string }> = [];
    try {
      runsAfterStop = await handles.prisma.run.findMany({
        where: { OR: scopes },
        select: { id: true },
      });
    } catch (error) {
      failures.push(error);
    }
    const handledRunIds = new Set([...runsBeforeStop, ...runsAfterStop].map((run) => run.id));
    for (const runId of handledRunIds) {
      try {
        await handles.jobs.cancel(runJobKey(runId));
      } catch (error) {
        failures.push(error);
      }
    }
    for (const runId of handledRunIds) {
      try {
        await handles.runtime.abort(runId);
      } catch (error) {
        failures.push(error);
      }
    }

    let botsAfter: Array<{ id: string; userId: string; spaceId: string }> | undefined;
    let runsAfter: Array<{ id: string; status: string }> | undefined;
    let activeRoutineCount: number | undefined;
    try {
      await handles.prisma.routine.updateMany({
        where: { OR: scopes },
        data: { active: false, nextRunAt: null },
      });
      [botsAfter, runsAfter, activeRoutineCount] = await Promise.all([
        findScopeBots(handles.prisma, actors),
        handles.prisma.run.findMany({
          where: { OR: scopes },
          select: { id: true, status: true },
        }),
        handles.prisma.routine.count({ where: { OR: scopes, active: true } }),
      ]);
    } catch (error) {
      failures.push(error);
    }

    if (
      botsAfter &&
      runsAfter &&
      activeRoutineCount === 0 &&
      botsAfter.every((bot) => bots.some((stopped) => stopped.id === bot.id)) &&
      runsAfter.every(
        (run) =>
          handledRunIds.has(run.id) &&
          !(ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status),
      )
    ) {
      stable = true;
      break;
    }
  }
  if (!stable) failures.push(new Error("Trial scope did not become idle"));
  if (failures.length) throw new Error("Trial work could not be stopped", { cause: failures });
}
