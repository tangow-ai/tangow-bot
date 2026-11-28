import { createRunSecretWriter, EncryptedSecretStore } from "@tangow/adapters";
import type { GuestHarness } from "@tangow/agent-run-worker";
import { createThreadEvents } from "@tangow/db";
import { afterEach, describe, expect, it } from "vitest";
import { startWorkerRun } from "./worker-run-fixture.js";

type Call = { name: string; args: Record<string, unknown> };

/**
 * A guest whose harness leaves ask_user, request_takeover and request_secret to the controller,
 * as a native loop does: each attempt makes its calls in turn and keeps what the controller said.
 */
function handGuest(attempts: Call[][]) {
  const seen: Array<{ prompt: string; replies: unknown[] }> = [];
  const harness: GuestHarness = {
    declaration: { name: "hand", capabilities: [] },
    async run({ run }, host) {
      const attempt = { prompt: run.prompt, replies: [] as unknown[] };
      seen.push(attempt);
      for (const [index, call] of (attempts[seen.length - 1] ?? []).entries()) {
        const callId = `call-${seen.length}-${index + 1}`;
        await host.emit({ type: "tool", name: call.name, args: call.args, executionId: callId });
        attempt.replies.push(await host.callTool("root", call.name, call.args, callId));
      }
      return { type: "done", text: "Done." };
    },
  };
  return { harness, seen };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function guestRun(attempts: Call[][]) {
  const guest = handGuest(attempts);
  const run = await startWorkerRun({ steps: [], computerScope: "team", harness: guest.harness });
  cleanups.push(() => run.close());
  const status = async (runId: string) =>
    (await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status;
  const cards = async (runId: string) =>
    (await run.runEntries(runId)).flatMap((entry) => {
      if (entry.type === "assistant.ask") return [{ id: entry.id, blocks: [entry.payload.block] }];
      if (entry.type === "assistant.text") return [{ id: entry.id, blocks: entry.payload.blocks }];
      return [];
    });
  const toolEntries = async (runId: string) =>
    (await run.runEntries(runId)).flatMap((entry) =>
      entry.type === "tool.call" || entry.type === "tool.result"
        ? [{ type: entry.type, callId: entry.payload.callId }]
        : [],
    );
  return { run, seen: guest.seen, status, cards, toolEntries };
}

const city = { question: "Which city?", options: ["Paris", "Lyon"] };
const takeover = { reason: "Log in to the bank" };
const credential = {
  name: "weather_api",
  origin: "https://api.weather.test",
  auth: { type: "bearer" },
};

describe("pausing tools a worker harness leaves to the controller", () => {
  it("pauses the parent once for a helper's ask and closes the helper's run and task", async () => {
    let reply: unknown;
    const harness: GuestHarness = {
      ...handGuest([]).harness,
      declaration: { name: "hand", capabilities: ["subagents"] },
      async run({ run }, host) {
        const args = { name: "Planner", task: "Choose a city" };
        await host.emit({ type: "tool", name: "run_subagent", args, executionId: "helper" });
        const helper = await host.decide(
          {
            type: "subagent.open",
            callId: "helper",
            ...args,
            args,
            category: "everyday",
          },
          "subagent.opened",
        );
        await host.emit({ type: "tool", name: "ask_user", args: city, executionId: "question" });
        reply = await host.callTool(helper.agent, "ask_user", city, "question");
        await host.decide(
          {
            type: "subagent.finish",
            agent: helper.agent,
            status: "completed",
            result: "Stopped: the run is waiting for the user.",
          },
          "recorded",
        );
        return { type: "done" };
      },
    };
    const run = await startWorkerRun({ steps: [], computerScope: "team", harness });
    cleanups.push(() => run.close());
    const runId = await run.send("Plan my trip.");
    await run.continueRun(runId);

    expect(reply).toMatchObject({ details: { ask: "paused" }, terminate: true });
    expect(await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
      status: "waiting_input",
    });
    expect(
      (await run.runEntries(runId)).filter((entry) => entry.type === "assistant.ask"),
    ).toHaveLength(1);
    expect(
      await run.prisma.run.findMany({
        where: { parentRunId: runId },
        select: { status: true, task: { select: { status: true } } },
      }),
    ).toEqual([{ status: "completed", task: { status: "completed" } }]);
  });

  it("refuses a malformed ask_user, pauses once on a valid one, and resumes with the choice", async () => {
    const g = await guestRun([
      [
        { name: "ask_user", args: { question: "Which?", options: ["Only"] } },
        { name: "ask_user", args: city },
        { name: "ask_user", args: city },
      ],
      [],
    ]);
    const runId = await g.run.send("Plan my trip.");
    await g.run.continueRun(runId);

    expect(g.seen[0]!.replies.slice(0, 2)).toEqual([
      { error: "ask_user requires two to four unique, non-empty options" },
      {
        kind: "agent_tool_result",
        content: [{ type: "text", text: "Waiting for the user's choice." }],
        details: { ask: "paused" },
        terminate: true,
      },
    ]);
    expect(await g.status(runId)).toBe("waiting_input");
    const [card, ...others] = await g.cards(runId);
    expect(others).toEqual([]);
    expect(card!.blocks).toEqual([
      {
        kind: "ask",
        text: "Which city?",
        status: "pending",
        actions: [
          { id: "choice-1", label: "Paris" },
          { id: "choice-2", label: "Lyon" },
        ],
      },
    ]);
    expect(await g.toolEntries(runId)).toEqual([
      { type: "tool.call", callId: "call-1-1" },
      { type: "tool.result", callId: "call-1-1" },
    ]);

    expect(
      await g.run.events.answerRunInput({
        spaceId: g.run.spaceId,
        threadId: g.run.thread.id,
        runId,
        messageId: card!.id,
        answeredByUserId: g.run.userId,
        answer: "choice-1",
      }),
    ).toBe(true);
    await g.run.continueRun(runId);

    expect(g.seen[1]!.prompt).toContain("Selected choice choice-1: Paris");
    expect(await g.status(runId)).toBe("completed");
  });

  it("pauses on request_takeover with the computer held, and resumes once the person hands back", async () => {
    const g = await guestRun([[{ name: "request_takeover", args: takeover }], []]);
    const runId = await g.run.send("Pay my bill.");
    await g.run.continueRun(runId);

    expect(g.seen[0]!.replies).toEqual([
      {
        kind: "agent_tool_result",
        content: [{ type: "text", text: "Takeover requested." }],
        details: { takeover: "paused" },
        terminate: true,
      },
    ]);
    expect(await g.status(runId)).toBe("waiting_takeover");
    expect((await g.cards(runId)).map((card) => card.blocks)).toEqual([
      [{ kind: "computer", state: "Needs you", text: "Log in to the bank" }],
    ]);
    expect(await g.toolEntries(runId)).toEqual([]);

    const computerId = g.run.bot.computerId!;
    await g.run.prisma.computer.update({
      where: { id: computerId },
      data: {
        controlHolder: "user",
        controlLeaseId: "lease-hand",
        controlLeaseExpiresAt: new Date(Date.now() + 60_000),
        controlBotId: g.run.bot.id,
        controlRunId: runId,
      },
    });
    expect(
      await g.run.events.finalizeComputerControlRelease({
        spaceId: g.run.spaceId,
        computerId,
        botId: g.run.bot.id,
        runId,
        leaseId: "lease-hand",
        holder: "bot",
        reason: "done",
      }),
    ).toEqual({ runId });
    await g.run.continueRun(runId);

    expect(g.seen[1]!.prompt).toContain("The user finished the login.");
    expect(await g.status(runId)).toBe("completed");
  });

  it("pauses on request_secret, and the resumed call finds the saved credential", async () => {
    const g = await guestRun([
      [{ name: "request_secret", args: { label: "Weather key", purpose: "api_key", credential } }],
      [{ name: "request_secret", args: { label: "Weather key", purpose: "api_key", credential } }],
    ]);
    const runId = await g.run.send("Check the weather.");
    await g.run.continueRun(runId);

    expect(g.seen[0]!.replies).toEqual([
      {
        kind: "agent_tool_result",
        content: [{ type: "text", text: "Waiting for protected input." }],
        details: { secret: "paused", effectId: expect.any(String) },
        terminate: true,
      },
    ]);
    expect(await g.status(runId)).toBe("waiting_input");
    const [card] = await g.cards(runId);

    const secrets = new EncryptedSecretStore("worker-fixture-encryption-key");
    const events = createThreadEvents(g.run.prisma, undefined, {
      runSecretWriter: createRunSecretWriter(secrets, secrets),
    });
    expect(
      await events.answerRunInput({
        spaceId: g.run.spaceId,
        threadId: g.run.thread.id,
        runId,
        messageId: card!.id,
        answeredByUserId: g.run.userId,
        answer: "sk-weather-fixture",
      }),
    ).toBe(true);
    await g.run.continueRun(runId);

    expect(g.seen[1]!.replies).toEqual([{ saved: true, ...credential }]);
    expect(JSON.stringify(g.seen)).not.toContain("sk-weather-fixture");
    expect(await g.status(runId)).toBe("completed");
  });
});
