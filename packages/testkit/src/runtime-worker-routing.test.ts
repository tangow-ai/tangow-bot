import { runContinueJob, WorkerEnsureSettledError } from "@tangow/adapter-kit";
import { createJobReconciler } from "@tangow/adapters";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelEmulatorRequest, ModelEmulatorStep } from "./model-emulator.js";
import { startWorkerRun } from "./worker-run-fixture.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function fixture(steps: ModelEmulatorStep[]) {
  const run = await startWorkerRun({ steps });
  cleanups.push(() => run.close());
  return run;
}

async function takeoverFixture(steps: ModelEmulatorStep[]) {
  let releaseRunId: string | undefined;
  const run = await startWorkerRun({
    steps,
    workers: (workers) => ({
      ...workers,
      async plan(input) {
        // Routing runs after the first takeover read, before the final pre-runtime check.
        if (releaseRunId) {
          await run.prisma.run.update({
            where: { id: releaseRunId },
            data: { checkpoint: "takeover" },
          });
          releaseRunId = undefined;
        }
        return workers.plan(input);
      },
    }),
  });
  cleanups.push(() => run.close());
  return {
    run,
    releaseDuringRouting(runId: string) {
      releaseRunId = runId;
    },
  };
}

const recap = JSON.stringify({ version: 1, results: ["Answered"], references: [] });
const toolNames = (request: ModelEmulatorRequest) =>
  (request.tools ?? []).map((tool) => tool.function.name);
const shellTools = (request: ModelEmulatorRequest) =>
  toolNames(request).filter((name) =>
    [
      "shell",
      "bash",
      "grep",
      "write_file",
      "read_file",
      "read",
      "write",
      "edit",
      "find",
      "ls",
    ].includes(name),
  );

/** Notes which shell tools the first model call offered, then ends the run. */
function offeredShellTools(seen: string[][]): ModelEmulatorStep[] {
  return [
    {
      expect(request) {
        seen.push(shellTools(request));
      },
      response: { type: "tool", id: "say", name: "message_user", arguments: { message: "Hi." } },
    },
    { expect() {}, response: { type: "text", text: recap } },
  ];
}

async function attemptsOf(run: Awaited<ReturnType<typeof fixture>>, runId: string) {
  return run.prisma.attempt.findMany({ where: { runId }, select: { workerState: true } });
}

describe("where a product run executes", () => {
  it("completes a computerless bot's message without native tools or user file mounts", async () => {
    const seen: string[][] = [];
    const calls: string[] = [];
    const run = await startWorkerRun({
      computerScope: "none",
      tools: {
        describe: () => ({
          id: "fixture",
          contractVersion: "1",
          adapterVersion: "1",
          capabilities: { discover: true, oauth: false, secretsBrokered: true },
        }),
        discoverTools: async () =>
          ["mcp_lookup", "integration_lookup"].map((name) => ({
            name,
            description: "Lookup",
            inputSchema: { type: "object", properties: {} },
            readOnly: true,
          })),
        async *execute(call) {
          calls.push(call.tool);
          yield { type: "result", data: { found: call.tool } };
        },
      },
      steps: [
        {
          expect(request) {
            expect(
              JSON.stringify(request.messages.find((message) => message.role === "system")),
            ).not.toContain("request_takeover");
          },
          response: { type: "tool", id: "mcp", name: "mcp_lookup", arguments: {} },
        },
        {
          expect(request) {
            expect(JSON.stringify(request.messages)).toContain("mcp_lookup");
          },
          response: { type: "tool", id: "integration", name: "integration_lookup", arguments: {} },
        },
        ...offeredShellTools(seen),
      ],
    });
    cleanups.push(() => run.close());
    const ensure = vi.spyOn(run.provider, "ensure");
    const runId = await run.send("Hello.");
    await run.continueRun(runId);

    run.model.assertComplete();
    expect(await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
      status: "completed",
      leaseOwner: null,
    });
    expect(seen[0]).toEqual([]);
    expect(calls).toEqual(["mcp_lookup", "integration_lookup"]);
    expect(run.provider.launches).toHaveLength(1);
    expect(ensure).toHaveBeenCalledWith(expect.objectContaining({ mounts: [] }), expect.anything());
    expect(await run.prisma.computer.count()).toBe(0);
    expect(await attemptsOf(run, runId)).toEqual([{ workerState: "released" }]);
  });

  it("fails a computerless run needing an attached file through the fenced finalizer", async () => {
    const run = await startWorkerRun({ computerScope: "none", steps: [] });
    cleanups.push(() => run.close());
    const sent = await run.events.sendUserMessage({
      spaceId: run.spaceId,
      userId: run.userId,
      botId: run.bot.id,
      threadId: run.thread.id,
      blocks: [
        {
          kind: "file",
          artifactId: "missing-file",
          name: "input.txt",
          mimeType: "text/plain",
          size: 1,
        },
      ],
      prompt: "Read the file.",
      trigger: "user",
    });
    const runId = sent.runId!;
    await run.continueRun(runId);
    expect(await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
      status: "failed",
      leaseOwner: null,
      error: "Run setup failed: This run needs a computer, but the bot has none",
    });
    expect(await attemptsOf(run, runId)).toEqual([{ workerState: null }]);
    expect(run.provider.launches).toEqual([]);
  });

  it("requeues during a home move without charging setup budget, then completes after release", async () => {
    const run = await fixture(offeredShellTools([]));
    const reservation = await run.lifecycle.reserveHomeMove(run.bot.computerId!);
    if (!("marker" in reservation)) throw new Error(reservation.blocker);
    const runId = await run.send("Hello.");
    await run.continueRun(runId);
    expect(await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
      status: "queued",
      error: null,
    });
    expect(await run.prisma.attempt.count({ where: { runId } })).toBe(0);
    await run.lifecycle.releaseHomeMove(reservation.marker);
    await run.continueRun(runId);
    run.model.assertComplete();
    expect(await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
      status: "completed",
    });
  });

  it("requeues a computerless bot's busy plan without attempts, model calls or in-process fallback", async () => {
    const run = await startWorkerRun({ computerScope: "none", steps: offeredShellTools([]) });
    cleanups.push(() => run.close());
    const computer = await run.prisma.computer.create({
      data: {
        spaceId: run.spaceId,
        userId: run.userId,
        scope: "team",
        scopeKey: "move-source",
        homeKey: "move-source",
        kind: "e2b",
      },
    });
    const reservation = await run.lifecycle.reserveHomeMove(computer.id);
    if (!("marker" in reservation)) throw new Error(reservation.blocker);
    const runId = await run.send("Hello.");
    for (let retry = 0; retry < 4; retry++) {
      await run.continueRun(runId);
      expect(await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
        status: "queued",
        error: null,
      });
      expect(await run.prisma.attempt.count({ where: { runId } })).toBe(0);
      expect(run.model.requests).toEqual([]);
      expect(run.provider.launches).toEqual([]);
    }
    await run.lifecycle.releaseHomeMove(reservation.marker);
    await run.continueRun(runId);
    run.model.assertComplete();
    expect((await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
      "completed",
    );
    expect(run.provider.launches).toHaveLength(1);
  });

  it("degrades a file steered to a computerless bot to attachment unavailable and completes", async () => {
    const run = await startWorkerRun({
      computerScope: "none",
      steps: [
        {
          async expect() {
            await run.events.sendUserMessage({
              spaceId: run.spaceId,
              userId: run.userId,
              botId: run.bot.id,
              threadId: run.thread.id,
              blocks: [
                {
                  kind: "file",
                  artifactId: "steered-file",
                  name: "notes.txt",
                  mimeType: "text/plain",
                  size: 1,
                },
              ],
              prompt: "Also read this.",
              trigger: "user",
            });
          },
          response: {
            type: "tool",
            id: "say",
            name: "message_user",
            arguments: { message: "Working." },
          },
        },
        {
          expect(request) {
            expect(JSON.stringify(request.messages)).toContain("unavailable");
          },
          response: {
            type: "tool",
            id: "finish",
            name: "message_user",
            arguments: { message: "File unavailable." },
          },
        },
        { expect() {}, response: { type: "text", text: recap } },
      ],
    });
    cleanups.push(() => run.close());
    const runId = await run.send("Hello.");
    await run.continueRun(runId);
    run.model.assertComplete();
    expect((await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
      "completed",
    );
  });

  it("runs a bot whose home is on volumes in its guest, with bash and grep in place of the computer shell", async () => {
    const seen: string[][] = [];
    const run = await fixture(offeredShellTools(seen));
    const runId = await run.send("Hello.");
    await run.continueRun(runId);

    expect(seen).toEqual([["read", "write", "edit", "bash", "grep", "find", "ls"]]);
    expect(await attemptsOf(run, runId)).toEqual([{ workerState: "released" }]);
  });

  it("fails a run that needs files while its computer's home has yet to move", async () => {
    const run = await fixture([]);
    await run.prisma.computer.update({
      where: { id: run.bot.computerId! },
      data: { homeStorage: "snapshot" },
    });
    const runId = await run.send("Hello.");
    await run.continueRun(runId);

    run.model.assertComplete();
    expect(await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
      status: "failed",
      error: "This computer's home move is pending, so file work can't run yet",
    });
    expect(run.provider.launches).toEqual([]);
  });

  it("creates the volume of a bot attached after its computer moved, on its first run", async () => {
    const seen: string[][] = [];
    const run = await fixture(offeredShellTools(seen));
    await run.prisma.volume.deleteMany({ where: { kind: "bot_private" } });
    const runId = await run.send("Hello.");
    await run.continueRun(runId);

    expect(seen).toEqual([["read", "write", "edit", "bash", "grep", "find", "ls"]]);
    expect(
      await run.prisma.volume.findMany({
        where: { kind: "bot_private" },
        select: { botId: true, providerRef: true },
      }),
    ).toEqual([{ botId: run.bot.id, providerRef: expect.stringMatching(/^tangow-/) }]);
    expect(await attemptsOf(run, runId)).toEqual([{ workerState: "released" }]);
  });

  it("provisions missing shared skills before routing a team bot", async () => {
    const seen: string[][] = [];
    const run = await startWorkerRun({ steps: offeredShellTools(seen), computerScope: "team" });
    cleanups.push(() => run.close());
    await run.prisma.volume.deleteMany({ where: { kind: "space_shared" } });
    const runId = await run.send("Hello.");
    await run.continueRun(runId);
    run.model.assertComplete();
    expect((await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
      "completed",
    );
    expect(
      await run.prisma.volume.findFirst({ where: { kind: "space_shared", spaceId: run.spaceId } }),
    ).toMatchObject({ providerRef: expect.any(String) });
    expect(run.provider.launches).toHaveLength(1);
  });

  it("stops quietly when a newer attempt took the run before it was routed", async () => {
    let fencedRunId = "";
    const run = await startWorkerRun({
      steps: [],
      workers: (workers) => ({
        ...workers,
        async plan(input) {
          await run.prisma.run.update({
            where: { id: fencedRunId },
            data: { leaseFence: { increment: 1 } },
          });
          return workers.plan(input);
        },
      }),
    });
    cleanups.push(() => run.close());
    fencedRunId = await run.send("Hello.");

    await run.continueRun(fencedRunId);

    expect(
      await run.prisma.run.findUniqueOrThrow({
        where: { id: fencedRunId },
        select: { status: true, error: true },
      }),
    ).toEqual({ status: "running", error: null });
    expect(run.provider.launches).toEqual([]);
  });

  it("completes a new run while another run's worker is still releasing", async () => {
    const run = await fixture(offeredShellTools([]));
    const ensure = run.provider.ensure.bind(run.provider);
    run.provider.ensure = async (spec, context) => {
      await ensure(spec, context);
      throw new Error("The controller lost the create response");
    };
    const earlier = await run.send("Earlier run.");
    await expect(run.continueRun(earlier)).rejects.toThrow("Run setup failed; retrying");
    await run.prisma.run.update({
      where: { id: earlier },
      data: { status: "failed", completedAt: new Date() },
    });
    expect(await attemptsOf(run, earlier)).toEqual([{ workerState: "releasing" }]);
    run.provider.ensure = ensure;

    const runId = await run.send("Hello.");
    await run.continueRun(runId);

    expect((await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
      "completed",
    );
    expect(await attemptsOf(run, runId)).toEqual([{ workerState: "released" }]);
    expect(await attemptsOf(run, earlier)).toEqual([{ workerState: "releasing" }]);
    run.model.assertComplete();
  });

  it("fails setup at once with the provider's own error when it refused the create", async () => {
    const run = await fixture([]);
    const refusal = "Supervisor POST /workers failed with 500: invalid worker volume name";
    run.provider.ensure = async () => {
      throw new WorkerEnsureSettledError(refusal);
    };
    const runId = await run.send("Hello.");

    for (let attempt = 1; attempt < 3; attempt++) {
      await expect(run.continueRun(runId)).rejects.toThrow("Run setup failed; retrying");
      expect(await attemptsOf(run, runId)).toEqual(
        Array.from({ length: attempt }, () => ({ workerState: "released" })),
      );
    }
    await run.continueRun(runId);

    expect(await attemptsOf(run, runId)).toEqual(
      Array.from({ length: 3 }, () => ({ workerState: "released" })),
    );
    expect(await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
      status: "failed",
      error: `Run setup failed after 3 attempts: The worker provider failed: ${refusal}`,
    });
  });

  it.each(["volumes", "ensure", "prepare", "ensure-unreleased"] as const)(
    "exhausts a run's setup budget across reconciliation and a restart after %s fails",
    async (step) => {
      const run = await startWorkerRun({ steps: [] });
      cleanups.push(() => run.close());
      const fail = async () => {
        throw new Error("The provider is unavailable");
      };
      const failProvider = () => {
        if (step === "volumes") run.provider.ensureVolume = fail;
        else if (step === "ensure-unreleased") {
          run.provider.ensure = fail;
          run.provider.destroy = fail;
        } else run.provider[step] = fail;
      };
      if (step === "volumes") await run.prisma.volume.deleteMany();
      failProvider();
      const runId = await run.send("Hello.");
      const enqueue = vi.fn(async () => undefined);
      const reconciler = createJobReconciler({
        prisma: run.prisma,
        jobs: { enqueue, cancel: async () => undefined, close: async () => undefined },
      });

      for (let attempt = 1; attempt <= 3; attempt++) {
        enqueue.mockClear();
        await reconciler.reconcileOnce();
        expect(enqueue).toHaveBeenCalledWith(runContinueJob(runId));
        if (attempt < 3) {
          await expect(run.continueRun(runId)).rejects.toThrow("Run setup failed; retrying");
          expect((await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
            "queued",
          );
          if ((step === "ensure" || step === "ensure-unreleased") && attempt === 1) {
            expect(await attemptsOf(run, runId)).toEqual([{ workerState: "releasing" }]);
            for (let wait = 0; wait < 4; wait++) {
              await run.continueRun(runId);
              expect(
                (await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status,
              ).toBe("queued");
            }
          }
          // A failed ensure can still create a worker until its setup deadline has passed.
          await run.prisma.attempt.updateMany({
            where: { runId, workerState: { not: null } },
            data: { workerEnsureAt: new Date(0) },
          });
          const context = {
            operationId: "retry-test",
            traceId: "retry-test",
            spaceId: run.spaceId,
            userId: run.userId,
            signal: new AbortController().signal,
          };
          await run.lifecycle.reconcile({ limit: 10 }, context);
          await run.restart().dispose();
          failProvider();
        } else {
          await run.continueRun(runId);
        }
      }

      expect(await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
        status: "failed",
        error: expect.stringContaining("Run setup failed after 3 attempts"),
      });
      enqueue.mockClear();
      await reconciler.reconcileOnce();
      expect(enqueue).not.toHaveBeenCalledWith(runContinueJob(runId));
      await run.continueRun(runId);
      expect(await run.prisma.attempt.count({ where: { runId } })).toBe(3);
    },
  );

  it("preserves the setup budget when takeover is released after the first checkpoint read", async () => {
    const { run, releaseDuringRouting } = await takeoverFixture(offeredShellTools([]));
    const runId = await run.send("Hello.");
    const prepare = vi
      .spyOn(run.provider, "prepare")
      .mockRejectedValueOnce(new Error("The provider is unavailable"))
      .mockRejectedValueOnce(new Error("The provider is unavailable"));
    for (let failure = 0; failure < 2; failure++) {
      await expect(run.continueRun(runId)).rejects.toThrow("Run setup failed; retrying");
    }
    prepare.mockRestore();
    await run.prisma.run.update({
      where: { id: runId },
      data: { status: "waiting_takeover" },
    });
    releaseDuringRouting(runId);
    await run.continueRun(runId);
    expect(await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
      status: "queued",
      checkpoint: "takeover",
    });

    await run.restart().dispose();
    await run.continueRun(runId);

    expect(await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
      status: "completed",
      error: null,
    });
    run.model.assertComplete();
  });

  it("rolls back a takeover requeue whose attempt outcome cannot be written and counts the crash", async () => {
    const { run, releaseDuringRouting } = await takeoverFixture([]);
    const runId = await run.send("Hello.");
    await run.prisma.run.update({
      where: { id: runId },
      data: { status: "waiting_takeover" },
    });
    const transaction = run.prisma.$transaction.bind(run.prisma);
    // Keep the real rollback without sending a SQL error through PGlite's socket transport.
    const rejectOutcome = vi.spyOn(run.prisma, "$transaction").mockImplementation((work, options) =>
      transaction(async (tx) => {
        const update = tx.attempt.update.bind(tx.attempt);
        vi.spyOn(tx.attempt, "update").mockImplementation((args) => {
          if (args.data.status === "setup_failed") throw new Error("Attempt outcome unavailable");
          return update(args);
        });
        return work(tx);
      }, options),
    );
    releaseDuringRouting(runId);

    await expect(run.continueRun(runId)).rejects.toThrow("Attempt outcome unavailable");

    expect(await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
      status: "running",
      checkpoint: "takeover",
    });
    expect(
      await run.prisma.attempt.findMany({
        where: { runId },
        select: { status: true, error: true, finishedAt: true },
      }),
    ).toEqual([{ status: "setting_up", error: null, finishedAt: null }]);
    rejectOutcome.mockRestore();
    await run.prisma.run.update({
      where: { id: runId },
      data: { leaseExpiresAt: new Date(0) },
    });
    await run.restart().dispose();
    vi.spyOn(run.provider, "prepare").mockRejectedValue(new Error("The provider is unavailable"));
    await expect(run.continueRun(runId)).rejects.toThrow("Run setup failed; retrying");
    await run.continueRun(runId);
    expect(await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
      status: "failed",
      error: expect.stringContaining("Run setup failed after 3 attempts"),
    });
    expect(await run.prisma.attempt.count({ where: { runId } })).toBe(3);
  });

  it("counts setup attempts lost before their outcome was committed, across controller restarts", async () => {
    const run = await fixture([]);
    await run.prisma.volume.deleteMany();
    const runId = await run.send("Hello.");
    const enqueue = vi.fn(async () => undefined);
    const reconciler = createJobReconciler({
      prisma: run.prisma,
      jobs: { enqueue, cancel: async () => undefined, close: async () => undefined },
    });
    for (let crash = 0; crash < 3; crash++) {
      run.provider.ensureVolume = async () => {
        // Lose the transaction that would record the outcome and requeue the run.
        vi.spyOn(run.prisma, "$transaction").mockRejectedValueOnce(new Error("Controller stopped"));
        throw new Error("The provider is unavailable");
      };
      await expect(run.continueRun(runId)).rejects.toThrow("Controller stopped");
      vi.restoreAllMocks();
      await run.prisma.run.update({
        where: { id: runId },
        data: { leaseExpiresAt: new Date(0) },
      });
      enqueue.mockClear();
      await reconciler.reconcileOnce();
      expect(enqueue).toHaveBeenCalledWith(runContinueJob(runId));
      await run.restart().dispose();
    }
    const create = vi
      .spyOn(run.provider, "ensureVolume")
      .mockRejectedValue(new Error("The provider is unavailable"));
    await run.continueRun(runId);

    expect(await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
      status: "failed",
      error: expect.stringContaining("Run setup failed after 3 attempts"),
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("never claims a run of a bot that is being deleted", async () => {
    const run = await fixture([]);
    const runId = await run.send("Hello.");
    await run.prisma.bot.update({ where: { id: run.bot.id }, data: { archivedAt: new Date() } });
    const claim = { select: { status: true, leaseFence: true } } as const;
    const queued = await run.prisma.run.findUniqueOrThrow({ where: { id: runId }, ...claim });

    await run.continueRun(runId);

    expect(await run.prisma.run.findUniqueOrThrow({ where: { id: runId }, ...claim })).toEqual(
      queued,
    );
    expect(await attemptsOf(run, runId)).toEqual([]);
  });

  it("asks the auto-review judge of a worker run in process", async () => {
    const run = await fixture([
      {
        expect() {},
        response: {
          type: "tool",
          id: "request",
          name: "secret_request",
          arguments: { name: "x", url: "https://api.example.test/" },
        },
      },
      {
        expect(request) {
          expect(JSON.stringify(request.messages.at(-1))).toContain("tool: secret_request");
        },
        response: { type: "text", text: '{"decision":"pass","reason":"Harmless."}' },
      },
      ...offeredShellTools([]),
    ]);
    vi.stubEnv("TANGOW_AUTO_REVIEW_PROVIDER", run.model.model.provider);
    vi.stubEnv("TANGOW_AUTO_REVIEW_MODEL", run.model.model.id);
    await run.prisma.actionAutoReviewPreference.create({
      data: { spaceId: run.spaceId, userId: run.userId, enabled: true },
    });
    const runId = await run.send("Call x.");
    await run.continueRun(runId);

    run.model.assertComplete();
    expect(
      await run.prisma.externalEffect.findMany({
        where: { runId, kind: "secret_request" },
        select: { kind: true, reviewDecision: true },
      }),
    ).toEqual([{ kind: "secret_request", reviewDecision: "pass" }]);
    expect(await attemptsOf(run, runId)).toEqual([{ workerState: "released" }]);
  });
});
