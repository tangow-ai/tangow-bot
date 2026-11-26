import { setTimeout as sleep } from "node:timers/promises";
import { RunModelDecisionSchema, ThinkingLevelSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import * as z from "zod";
import { redact } from "../report.js";
import type { CalibrationDriver, CalibrationJob } from "./campaign.js";
import type { CalibrationConfig, CalibrationSession, FrozenProfile } from "./config.js";
import type { CalibrationLimits, CalibrationTrial } from "./types.js";

const CreatedBot = z.object({ id: z.string() });
const SentRun = z.object({ runId: z.string() });
const Envelope = z.object({ json: z.unknown() });
const TextPayload = z.object({
  blocks: z.array(z.unknown()),
  midTurn: z.boolean().optional(),
  toPerson: z.boolean().optional(),
});
const TextBlock = z.object({ kind: z.literal("text"), text: z.string() });
const ToolCall = z.object({ name: z.string(), callId: z.string() });
const ToolResult = z.object({ callId: z.string(), isError: z.boolean() });
const Started = z.object({ routing: RunModelDecisionSchema.optional() });
const ModelChoice = z.object({
  provider: z.string(),
  id: z.string(),
  thinkingLevels: z.array(ThinkingLevelSchema).optional(),
});
const terminal = new Set(["completed", "failed", "cancelled"]);
const instructions =
  "Use only the synthetic data supplied in this conversation. Do not access external services or the web, create bots or subagents, or save persistent memories or skills. Local calculation tools are allowed. Return the format requested in the task.";

export async function calibrationRpc(input: {
  session: CalibrationSession;
  procedure: string;
  body?: unknown;
}): Promise<unknown> {
  const response = await fetch(new URL(`/rpc/${input.procedure}`, input.session.baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${input.session.token}`,
      origin: input.session.origin,
      "x-rakazo-space-id": input.session.spaceId,
    },
    body: JSON.stringify({ json: input.body ?? {} }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`RPC ${input.procedure} failed (${response.status})`);
  return Envelope.parse(await response.json()).json;
}

export async function prepareLiveCalibration(input: {
  prisma: PrismaClient;
  session: CalibrationSession;
  config: CalibrationConfig;
  profile?: FrozenProfile;
}): Promise<() => Promise<void>> {
  const { prisma, session } = input;
  const userSession = await prisma.session.findUnique({ where: { token: session.token } });
  if (!userSession || userSession.userId !== session.userId || userSession.expiresAt <= new Date())
    throw new Error("Private session is invalid or expired");
  const member = await prisma.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: session.spaceId, userId: session.userId } },
  });
  if (!member || userSession.activeOrganizationId !== member.organizationId)
    throw new Error("Private session does not select the benchmark space");
  const liveRuns = await prisma.run.count({
    where: { userId: session.userId, spaceId: session.spaceId, status: { notIn: [...terminal] } },
  });
  if (liveRuns) throw new Error("Benchmark account already has unfinished runs");
  const owner = await prisma.deploymentSettings.findUnique({ where: { id: "default" } });
  if (owner?.ownerUserId === session.userId)
    throw new Error("Use an isolated benchmark account, not the deployment owner");
  const catalog = z
    .array(ModelChoice)
    .parse(await calibrationRpc({ session, procedure: "models/list" }));
  const credentials = await prisma.userModelCredential.findMany({
    where: { userId: session.userId },
  });
  for (const candidate of input.config.candidates) {
    const matches = credentials.filter((credential) => credential.provider === candidate.provider);
    if (matches.length !== 1 || matches[0]?.id !== session.connections[candidate.connection])
      throw new Error("Benchmark connections require exactly one matching credential per provider");
    const model = catalog.find(
      (item) => item.provider === candidate.provider && item.id === candidate.modelId,
    );
    if (!model?.thinkingLevels?.includes(candidate.thinkingLevel))
      throw new Error("Requested model and thinking level are not exposed by this deployment");
  }
  await calibrationRpc({ session, procedure: "models/routing" });
  if (!input.profile) return async () => {};
  const original = await prisma.spaceModelCategory.findMany({
    where: { spaceId: session.spaceId, userId: session.userId },
  });
  const findCandidate = (id: string) => {
    const candidate = input.config.candidates.find((item) => item.id === id);
    if (!candidate) throw new Error("Unknown frozen profile candidate");
    return candidate;
  };
  const restore = async () => {
    for (const category of ["fast", "everyday", "complex"]) {
      const previous = original.find((item) => item.category === category);
      if (previous) {
        const credential = credentials.find((item) => item.id === previous.credentialId);
        if (!credential) throw new Error("Cannot restore benchmark routing connection");
        await calibrationRpc({
          session,
          procedure: "models/setCategory",
          body: {
            category,
            provider: credential.provider,
            modelId: previous.modelId,
            thinkingLevel: previous.thinkingLevel,
          },
        });
      } else
        await calibrationRpc({ session, procedure: "models/clearCategory", body: { category } });
    }
    await calibrationRpc({
      session,
      procedure: "models/setAuto",
      body: { enabled: member.modelAuto },
    });
  };
  try {
    for (const category of ["fast", "everyday", "complex"] as const) {
      const candidate = findCandidate(input.profile.categories[category]);
      await calibrationRpc({
        session,
        procedure: "models/setCategory",
        body: {
          category,
          provider: candidate.provider,
          modelId: candidate.modelId,
          thinkingLevel: candidate.thinkingLevel,
        },
      });
    }
    await calibrationRpc({ session, procedure: "models/setAuto", body: { enabled: true } });
  } catch {
    await restore();
    throw new Error("Cannot configure isolated benchmark routing");
  }
  return restore;
}

export function liveCalibrationDriver(input: {
  prisma: PrismaClient;
  session: CalibrationSession;
  limits: CalibrationLimits;
  signal?: AbortSignal;
}): CalibrationDriver {
  const { prisma, session, limits } = input;
  const scope = { spaceId: session.spaceId, userId: session.userId };
  const rpc = (procedure: string, body?: unknown) => calibrationRpc({ session, procedure, body });
  return {
    async run(job: CalibrationJob, remainingTokens: number): Promise<CalibrationTrial> {
      let botId: string | null = null;
      let failure: string | null = null;
      let status: CalibrationTrial["status"] = "completed";
      const turnIds: string[] = [];
      const turnLatenciesMs: number[] = [];
      const deadline = Date.now() + limits.timeoutMs;
      const budgetFailure = async () => {
        if (input.signal?.aborted) return "interrupted";
        if (Date.now() >= deadline) return "timeout";
        if (!botId) return null;
        const [usage, calls] = await Promise.all([
          prisma.usageRecord.aggregate({
            where: { botId, ...scope },
            _sum: { inputTokens: true, outputTokens: true },
          }),
          prisma.sessionEntry.count({ where: { botId, type: "tool.call" } }),
        ]);
        const used = (usage._sum.inputTokens ?? 0) + (usage._sum.outputTokens ?? 0);
        return used >= remainingTokens
          ? "token-budget"
          : calls >= limits.maxToolCalls
            ? "tool-budget"
            : null;
      };
      try {
        botId = CreatedBot.parse(
          await rpc("bots/create", {
            name: "Calibration",
            notifyOnFinish: false,
          }),
        ).id;
        await rpc("bots/update", {
          botId,
          instructions,
          notifyOnFinish: false,
          modelProvider: job.auto ? null : job.candidate.provider,
          modelId: job.auto ? null : job.candidate.modelId,
          thinkingLevel: job.candidate.thinkingLevel,
        });
        for (const text of job.scenario.turns) {
          const exceeded = await budgetFailure();
          if (exceeded) {
            failure = exceeded;
            status = "cancelled";
            break;
          }
          const sent = SentRun.parse(
            await rpc("threads/send", { botId, text, linkPreview: false }),
          );
          turnIds.push(sent.runId);
          while (true) {
            const run = await prisma.run.findFirstOrThrow({
              where: { id: sent.runId, botId, ...scope },
            });
            if (terminal.has(run.status)) {
              if (run.completedAt)
                turnLatenciesMs.push(run.completedAt.getTime() - run.createdAt.getTime());
              if (run.status !== "completed") {
                status = run.status === "cancelled" ? "cancelled" : "failed";
                failure = `run-${run.status}`;
              }
              break;
            }
            const exceeded = await budgetFailure();
            if (exceeded) {
              failure = exceeded;
              status = "cancelled";
              await rpc("threads/stop", { botId });
              break;
            }
            if (!["queued", "leased", "running"].includes(run.status)) {
              failure = "unexpected-wait";
              status = "failed";
              await rpc("threads/stop", { botId });
              break;
            }
            await sleep(500);
          }
          if (status !== "completed") break;
        }
      } catch {
        failure = "execution-unavailable";
        status = "failed";
      } finally {
        if (botId) {
          try {
            await rpc("bots/archive", { botId });
            const until = Date.now() + 90_000;
            while (true) {
              const [active, workers] = await Promise.all([
                prisma.run.count({ where: { botId, ...scope, status: { notIn: [...terminal] } } }),
                prisma.attempt.count({
                  where: {
                    run: { botId, ...scope },
                    AND: [{ workerState: { not: null } }, { workerState: { not: "released" } }],
                  },
                }),
              ]);
              if (!active && !workers) break;
              if (Date.now() >= until) {
                failure = "cleanup-failed";
                status = "failed";
                break;
              }
              await sleep(250);
            }
          } catch {
            failure = "cleanup-failed";
            status = "failed";
          }
        }
      }
      const runs = botId ? await prisma.run.findMany({ where: { botId, ...scope } }) : [];
      turnLatenciesMs.splice(0);
      for (const id of turnIds) {
        const run = runs.find((item) => item.id === id);
        if (run?.completedAt)
          turnLatenciesMs.push(run.completedAt.getTime() - run.createdAt.getTime());
      }
      const runIds = runs.map((run) => run.id);
      const [entries, usage] = runIds.length
        ? await Promise.all([
            prisma.sessionEntry.findMany({
              where: { runId: { in: runIds } },
              orderBy: { createdAt: "asc" },
            }),
            prisma.usageRecord.findMany({ where: { runId: { in: runIds }, ...scope } }),
          ])
        : [[], []];
      const actualModels = runs.flatMap((run) =>
        run.modelProvider && run.modelId
          ? [
              {
                provider: run.modelProvider,
                modelId: run.modelId,
                thinkingLevel: run.thinkingLevel,
              },
            ]
          : [],
      );
      const routing = entries
        .filter((entry) => entry.type === "run.started")
        .map((entry) => {
          const value = Started.parse(entry.payload).routing;
          return {
            mode: value?.mode ?? "unknown",
            category: value?.category ?? null,
            fallback: value?.fallback ?? null,
          };
        });
      if (
        status === "completed" &&
        (job.auto
          ? routing.length === 0 || routing.some((route) => route.mode !== "auto")
          : actualModels.length === 0 ||
            actualModels.some(
              (model) =>
                model.provider !== job.candidate.provider ||
                model.modelId !== job.candidate.modelId ||
                model.thinkingLevel !== job.candidate.thinkingLevel,
            ))
      ) {
        failure = "model-selection-mismatch";
        status = "failed";
      }
      const lastRunId = turnIds.at(-1);
      const texts = entries
        .filter((entry) => entry.runId === lastRunId && entry.type === "assistant.text")
        .map((entry) => TextPayload.parse(entry.payload));
      const final = texts.filter((payload) => !payload.midTurn);
      const response = (
        final.length ? final : texts.filter((payload) => payload.toPerson).slice(-1)
      )
        .flatMap((payload) =>
          payload.blocks.flatMap((block) => {
            const parsed = TextBlock.safeParse(block);
            return parsed.success ? [parsed.data.text] : [];
          }),
        )
        .join("\n");
      const results = new Map(
        entries
          .filter((entry) => entry.type === "tool.result")
          .map((entry) => ToolResult.parse(entry.payload))
          .map((result) => [result.callId, result]),
      );
      const tools = entries
        .filter((entry) => entry.type === "tool.call")
        .map((entry) => {
          const call = ToolCall.parse(entry.payload);
          return { name: call.name, success: results.get(call.callId)?.isError === false };
        });
      return {
        caseId: job.scenario.id,
        category: job.scenario.category,
        configurationId: job.candidate.id,
        repeat: job.repeat,
        status,
        grade:
          status === "completed"
            ? job.scenario.grade({ text: response, tools })
            : {
                contentPass: false,
                formatPass: false,
                criticalFailure: false,
                reasons: [failure ?? "execution-failed"],
              },
        latencyMs:
          turnIds.length > 0 && turnLatenciesMs.length === turnIds.length
            ? turnLatenciesMs.reduce((sum, ms) => sum + ms, 0)
            : null,
        turnLatenciesMs,
        modelCalls: usage.length,
        toolCalls: tools.length,
        inputTokens: usage.length ? usage.reduce((sum, row) => sum + row.inputTokens, 0) : null,
        outputTokens: usage.length ? usage.reduce((sum, row) => sum + row.outputTokens, 0) : null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        costUsd: null,
        actualModels,
        routing,
        response: redact(response, [
          session.token,
          session.userId,
          session.spaceId,
          ...Object.values(session.connections),
        ]).slice(0, 20_000),
        failure,
      };
    },
  };
}
