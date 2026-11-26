import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRuntimeEvent } from "@tangow/adapter-kit";
import { ScriptedAgentRuntime } from "@tangow/adapters";
import { answerRunInput } from "@tangow/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { createApp } from "../../../apps/api/src/app.ts";
import { latestCard } from "./index.js";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeIntegration = hasDb ? describe : describe.skip;
const destination = {
  name: "example_api",
  origin: "https://api.example.test",
  auth: { type: "bearer" },
};
const key = "fake-reusable-api-key";

describeIntegration("reusable credential lifecycle", () => {
  let handles: Awaited<ReturnType<typeof createApp>>;
  const dataDir = mkdtempSync(path.join(tmpdir(), "tangow-secret-lifecycle-"));
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const auth = new Headers(init?.headers).get("Authorization");
    return Response.json({
      authenticated: auth === `Bearer ${key}` || auth === `Bearer ${key}-rotated`,
      echo: auth,
    });
  });

  beforeAll(async () => {
    const { createApp } = await import("../../../apps/api/src/app.ts");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      defaultProvider: "scripted",
      defaultModel: "scripted",
      remoteConnectors: {
        fetch,
        resolveHostname: async () => [{ address: "8.8.8.8", family: 4 }],
      },
    });
  });
  afterAll(async () => {
    await handles?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it.each([false, true])(
    "saves, reuses, rotates and revokes without model-visible plaintext (approval rule: %s)",
    async (requireApproval) => {
      fetch.mockClear();
      const seen: string[] = [];
      let calls: Array<{ name: string; args: Record<string, unknown> }> = [
        {
          name: "request_secret",
          args: { label: "API key", purpose: "api_key", credential: destination },
        },
      ];
      const runtime = vi
        .spyOn(ScriptedAgentRuntime.prototype, "run")
        .mockImplementation(async function* (request): AsyncIterable<AgentRuntimeEvent> {
          seen.push(
            JSON.stringify({
              prompt: request.prompt,
              history: request.history,
              tools: request.tools,
            }),
          );
          for (const [index, call] of calls.entries()) {
            yield { type: "tool", ...call, executionId: `${request.runId}:${index}` };
          }
          yield { type: "done", text: "Done" };
        });
      try {
        const seeded = await seedRun(`reusable-${requireApproval}`, "Save the API credential");
        if (requireApproval) {
          await handles.prisma.actionApprovalRule.create({
            data: {
              spaceId: seeded.me.spaceId,
              createdByUserId: seeded.me.userId,
              effect: "require_approval",
              matchKind: "tool",
              matchValue: "request_secret",
            },
          });
        }
        await handles.executor.continueRun(seeded.run.id, "test-worker");
        const approve = async (runId: string, interruptBeforeCard = false) => {
          if (!requireApproval) return;
          const message = await latestCard(handles.prisma, runId);
          expect(message.block).toMatchObject({ approvalEffectId: expect.any(String) });
          if (interruptBeforeCard) {
            // Reproduce a worker stopping after releasing the approved effect to intended,
            // before the protected card transaction commits. No background job is enqueued.
            expect(
              await answerRunInput(handles.prisma, {
                spaceId: seeded.me.spaceId,
                threadId: seeded.thread.id,
                runId,
                messageId: message.id,
                answeredByUserId: seeded.me.userId,
                answer: "allow",
              }),
            ).toBe(true);
            await handles.prisma.externalEffect.updateMany({
              where: { runId, kind: "request_secret", status: "approved" },
              data: { status: "intended" },
            });
            await handles.prisma.run.update({
              where: { id: runId },
              data: {
                status: "running",
                leaseOwner: "interrupted-worker",
                leaseExpiresAt: new Date(Date.now() - 60_000),
              },
            });
            await handles.executor.continueRun(runId, "recovery-worker");
          } else {
            await rpc(seeded.cookie, "threads/answer", {
              botId: seeded.bot.id,
              runId,
              messageId: message.id,
              answer: "allow",
            });
          }
          await vi.waitFor(
            async () => {
              const run = await handles.prisma.run.findUniqueOrThrow({ where: { id: runId } });
              expect(["completed", "waiting_input"]).toContain(run.status);
            },
            { timeout: 15_000 },
          );
        };
        await approve(seeded.run.id);
        const answer = async (runId: string, value: string) => {
          const message = await latestCard(handles.prisma, runId);
          expect(message.block).toMatchObject({ input: "secret", credential: destination });
          await rpc(seeded.cookie, "threads/answer", {
            botId: seeded.bot.id,
            runId,
            messageId: message.id,
            answer: value,
          });
          await vi.waitFor(
            async () => {
              expect(
                await handles.prisma.run.findUniqueOrThrow({ where: { id: runId } }),
              ).toMatchObject({ status: "completed", error: null });
            },
            { timeout: 15_000 },
          );
        };
        expect(
          await handles.prisma.run.findUniqueOrThrow({ where: { id: seeded.run.id } }),
        ).toMatchObject({ status: "waiting_input", error: null });
        // An invalid value rolls back the run transition and leaves the card pending.
        const pending = await latestCard(handles.prisma, seeded.run.id);
        expect(pending.block).toMatchObject({
          kind: "ask",
          input: "secret",
          status: "pending",
          credential: destination,
        });
        for (const invalid of ["x".repeat(16_385), "key\r\nX-Evil: injected", "key "]) {
          await expect(
            rpc(seeded.cookie, "threads/answer", {
              botId: seeded.bot.id,
              runId: seeded.run.id,
              messageId: pending.id,
              answer: invalid,
            }),
          ).rejects.toThrow();
        }
        expect(
          await handles.prisma.run.findUniqueOrThrow({ where: { id: seeded.run.id } }),
        ).toMatchObject({ status: "waiting_input" });
        expect(await handles.prisma.botSecret.count({ where: { botId: seeded.bot.id } })).toBe(0);
        await answer(seeded.run.id, key);
        const stored = await handles.prisma.botSecret.findFirstOrThrow({
          where: { botId: seeded.bot.id },
        });
        expect(stored).toMatchObject({
          ...destination,
          userId: seeded.me.userId,
          spaceId: seeded.me.spaceId,
        });
        expect(stored.ciphertext).toMatch(/^v2:/);
        expect(stored.ciphertext).not.toContain(key);
        expect(
          await handles.prisma.secret.count({ where: { kind: `run-secret:${seeded.run.id}` } }),
        ).toBe(0);

        const nextRun = async (nextCalls: typeof calls) => {
          calls = nextCalls;
          const task = await handles.prisma.task.create({
            data: {
              userId: seeded.me.userId,
              spaceId: seeded.me.spaceId,
              botId: seeded.bot.id,
              threadId: seeded.thread.id,
              prompt: "Use the saved credential",
              status: "queued",
            },
          });
          const run = await handles.prisma.run.create({
            data: {
              userId: seeded.me.userId,
              spaceId: seeded.me.spaceId,
              botId: seeded.bot.id,
              threadId: seeded.thread.id,
              taskId: task.id,
              trigger: "user",
              status: "queued",
            },
          });
          await handles.executor.continueRun(run.id, "test-worker");
          return run.id;
        };
        const request = {
          name: "secret_request",
          args: { name: destination.name, url: `${destination.origin}/v1/items` },
        };
        const useRun = await nextRun([
          { name: "list_secrets", args: {} },
          {
            name: "request_secret",
            args: { label: "API key", purpose: "api_key", credential: destination },
          },
          request,
        ]);
        await approve(useRun);
        expect(await handles.prisma.run.findUniqueOrThrow({ where: { id: useRun } })).toMatchObject(
          {
            status: "completed",
            error: null,
          },
        );
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(
          await handles.prisma.externalEffect.findFirstOrThrow({
            where: { runId: useRun, kind: "secret_request" },
          }),
        ).toMatchObject({
          status: "completed",
          result: {
            status: 200,
            body: { authenticated: true, echo: expect.stringContaining("[redacted]") },
          },
        });

        const rotateRun = await nextRun([
          {
            name: "request_secret",
            args: { label: "API key", purpose: "api_key", credential: destination, replace: true },
          },
        ]);
        expect(
          await handles.prisma.run.findUniqueOrThrow({ where: { id: rotateRun } }),
        ).toMatchObject({ status: "waiting_input" });
        await approve(rotateRun, true);
        expect(
          await handles.prisma.run.findUniqueOrThrow({ where: { id: rotateRun } }),
        ).toMatchObject({ status: "waiting_input" });
        expect(
          await handles.prisma.botSecret.findUniqueOrThrow({ where: { id: stored.id } }),
        ).toMatchObject({ ciphertext: stored.ciphertext });
        await answer(rotateRun, `${key}-rotated`);
        expect(
          await handles.prisma.botSecret.findUniqueOrThrow({ where: { id: stored.id } }),
        ).not.toMatchObject({ ciphertext: stored.ciphertext });
        await nextRun([request]);
        expect(new Headers(fetch.mock.calls.at(-1)?.[1]?.headers).get("Authorization")).toBe(
          `Bearer ${key}-rotated`,
        );
        const count = fetch.mock.calls.length;
        await rpc(seeded.cookie, "vault/remove", { name: destination.name });
        await nextRun([request]);
        expect(
          await handles.prisma.botSecret.count({
            where: { userId: seeded.me.userId, spaceId: seeded.me.spaceId, name: destination.name },
          }),
        ).toBe(0);
        expect(fetch).toHaveBeenCalledTimes(count);
        const [messages, events, effects, tasks] = await Promise.all([
          handles.prisma.sessionEntry.findMany({
            where: { session: { threadId: seeded.thread.id } },
          }),
          handles.prisma.event.findMany({ where: { threadId: seeded.thread.id } }),
          handles.prisma.externalEffect.findMany({ where: { spaceId: seeded.me.spaceId } }),
          handles.prisma.task.findMany({ where: { botId: seeded.bot.id } }),
        ]);
        expect(JSON.stringify({ seen, messages, events, effects, tasks })).not.toContain(key);
      } finally {
        runtime.mockRestore();
      }
    },
  );

  it("keeps the vault to its person and space, never returns values, and serves every bot", async () => {
    fetch.mockClear();
    const owner = await seedRun("vault-owner", "Use the vault key");
    const vaultKey = "fake-vault-api-key";
    const saved = await rpc(owner.cookie, "vault/put", { ...destination, value: vaultKey });
    const listed = await rpc(owner.cookie, "vault/list");
    expect(listed).toEqual({
      mine: [{ ...destination, botId: null, userIds: [], space: false }],
      shared: [],
    });
    expect(JSON.stringify({ saved, listed })).not.toContain(vaultKey);

    const stranger = await seedRun("vault-stranger", "Use someone else's key");
    expect(await rpc(stranger.cookie, "vault/list")).toEqual({ mine: [], shared: [] });
    const otherSpace = await rpc<{ id: string }>(owner.cookie, "spaces/create", { name: "Other" });
    expect(await rpc(owner.cookie, "vault/list", {}, otherSpace.id)).toEqual({
      mine: [],
      shared: [],
    });

    // Saved from the screen, not by a bot: any bot of the person in the space can use it.
    const runtime = vi
      .spyOn(ScriptedAgentRuntime.prototype, "run")
      .mockImplementation(async function* (request): AsyncIterable<AgentRuntimeEvent> {
        yield {
          type: "tool",
          name: "secret_request",
          args: { name: destination.name, url: `${destination.origin}/v1/items` },
          executionId: `${request.runId}:0`,
        };
        yield { type: "done", text: "Done" };
      });
    try {
      await handles.executor.continueRun(stranger.run.id, "test-worker");
      expect(fetch).not.toHaveBeenCalled();
      await handles.executor.continueRun(owner.run.id, "test-worker");
      expect(new Headers(fetch.mock.calls.at(-1)?.[1]?.headers).get("Authorization")).toBe(
        `Bearer ${vaultKey}`,
      );
    } finally {
      runtime.mockRestore();
    }

    // The limit counts the person's keys in this space, across every bot.
    await handles.prisma.botSecret.createMany({
      data: Array.from({ length: 99 }, (_, index) => ({
        id: `vault-limit-${stamp}-${index}`,
        userId: owner.me.userId,
        spaceId: owner.me.spaceId,
        name: `limit_${index}`,
        origin: destination.origin,
        auth: destination.auth,
        ciphertext: "v2:unused",
      })),
    });
    await expect(
      rpc(owner.cookie, "vault/put", { ...destination, name: "one_too_many", value: vaultKey }),
    ).rejects.toThrow("Credential limit reached");
    await rpc(owner.cookie, "vault/put", { ...destination, value: vaultKey }, otherSpace.id);
  });

  describe("keys shared between people", () => {
    type Person = { cookie: string; userId: string; email: string };
    // A owns the Space, bot X (shared with B and C) and bot Z (shared with the whole Space).
    let a: Person;
    let b: Person;
    let c: Person;
    let spaceId: string;
    let x: string;
    let z: string;
    let calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    let runtime: { mockRestore(): void } | undefined;
    const values = new Set<string>();

    beforeAll(async () => {
      const owner = await seedRun("share-a", "Unused");
      await handles.prisma.run.update({
        where: { id: owner.run.id },
        data: { status: "completed", completedAt: new Date() },
      });
      spaceId = owner.me.spaceId;
      a = { cookie: owner.cookie, userId: owner.me.userId, email: "" };
      b = await join("share-b");
      c = await join("share-c");
      x = owner.bot.id;
      z = (
        await rpc<{ id: string }>(
          a.cookie,
          "bots/create",
          { name: "Z", title: "", description: "", instructions: "", notifyOnFinish: false },
          spaceId,
        )
      ).id;
      await rpc(a.cookie, "bots/share", {
        botId: x,
        visibility: "people",
        userIds: [b.userId, c.userId],
      });
      await rpc(a.cookie, "bots/share", { botId: z, visibility: "space", userIds: [] });
      runtime = vi
        .spyOn(ScriptedAgentRuntime.prototype, "run")
        .mockImplementation(async function* (request): AsyncIterable<AgentRuntimeEvent> {
          for (const [index, call] of calls.entries()) {
            yield { type: "tool", ...call, executionId: `${request.runId}:${index}` };
          }
          yield { type: "done", text: "Done" };
        });
    });
    afterAll(() => runtime?.mockRestore());

    async function join(label: string, email = `vault-${label}-${stamp}@tangow.test`) {
      const { invitations } = await rpc<{ invitations: Array<{ id: string }> }>(
        a.cookie,
        "spaces/createInvite",
        { spaceId, emails: [email] },
      );
      const cookie = await signup(email, `Share ${label}`).catch(() => signin(email));
      await rpc(cookie, "spaces/acceptInvite", { token: invitations[0]!.id });
      const me = await rpc<{ userId: string }>(cookie, "me", {}, spaceId);
      return { cookie, userId: me.userId, email };
    }

    async function put(person: Person, name: string, value: string, origin = destination.origin) {
      values.add(value);
      await rpc(person.cookie, "vault/put", { ...destination, name, origin, value }, spaceId);
    }

    const share = (person: Person, name: string, userIds: string[], space = false) =>
      rpc(person.cookie, "vault/share", { name, userIds, space }, spaceId);

    const vault = (person: Person) =>
      rpc<{
        mine: Array<{ name: string; userIds: string[]; space: boolean }>;
        shared: unknown[];
      }>(person.cookie, "vault/list", {}, spaceId);

    /** Runs `botId` as `person`, listing keys then sending `name` to `url`. */
    async function use(
      person: Person,
      botId: string,
      name: string,
      url = `${destination.origin}/v1/items`,
      extra: typeof calls = [],
    ) {
      fetch.mockClear();
      calls = [
        { name: "list_secrets", args: {} },
        { name: "secret_request", args: { name, url } },
        ...extra,
      ];
      // Creates the member's thread with a bot shared with them; a removed member cannot list.
      await rpc(person.cookie, "bots/list", {}, spaceId).catch(() => undefined);
      const bot = await handles.prisma.bot.findUniqueOrThrow({ where: { id: botId } });
      const thread =
        bot.userId === person.userId
          ? await handles.prisma.thread.findUniqueOrThrow({ where: { botId } })
          : await handles.prisma.thread.findFirstOrThrow({
              where: { memberBotId: botId, userId: person.userId },
            });
      const task = await handles.prisma.task.create({
        data: {
          spaceId,
          botId,
          threadId: thread.id,
          userId: person.userId,
          prompt: "Use it",
          status: "queued",
        },
      });
      const run = await handles.prisma.run.create({
        data: {
          spaceId,
          botId,
          threadId: thread.id,
          taskId: task.id,
          userId: person.userId,
          status: "queued",
          trigger: "user",
        },
      });
      await handles.executor.continueRun(run.id, "test-worker");
      const outputs = (
        await handles.prisma.sessionEntry.findMany({
          where: { runId: run.id, type: "tool.result" },
          orderBy: { seq: "asc" },
        })
      ).map((entry) => (entry.payload as { output: string }).output);
      for (const output of outputs) {
        for (const value of values) expect(output).not.toContain(value);
      }
      const sent = fetch.mock.calls.at(-1);
      return {
        runId: run.id,
        listed: outputs[0] ?? "",
        answer: outputs[1] ?? "",
        outputs,
        sent: sent ? new Headers(sent[1]?.headers).get("Authorization") : null,
        sentTo: sent ? new URL(String(sent[0])).origin : null,
      };
    }

    it("serves a key only by the rule, with one refusal for every key outside it", async () => {
      await put(a, "a_private", "fake-a-private");
      await put(b, "b_private", "fake-b-private");
      await put(a, "a_shared", "fake-a-shared");
      await share(a, "a_shared", [b.userId]);
      await put(b, "b_shared", "fake-b-shared");
      await share(b, "b_shared", [a.userId]);
      await put(a, "a_with_c", "fake-a-with-c");
      await share(a, "a_with_c", [c.userId]);

      // B's run on A's bot: keys shared between A and B, from either side.
      const used = await use(b, x, "a_shared");
      expect(used.sent).toBe("Bearer fake-a-shared");
      for (const name of ["a_shared", "b_shared"]) expect(used.listed).toContain(name);
      for (const name of ["a_private", "b_private", "a_with_c"]) {
        expect(used.listed).not.toContain(name);
      }
      expect((await use(b, x, "b_shared")).sent).toBe("Bearer fake-b-shared");
      // Missing, someone's private key, a key shared with someone else: the same answer, no owner.
      const refusals = new Set<string>();
      for (const name of ["not_saved", "a_private", "b_private", "a_with_c"]) {
        const refused = await use(b, x, name);
        expect(refused.sent).toBeNull();
        refusals.add(refused.answer);
      }
      expect(refusals.size).toBe(1);
      expect([...refusals][0]).not.toMatch(/Executor|Share /);

      // A key of the same person in another Space never serves this one.
      const elsewhere = await rpc<{ id: string }>(a.cookie, "spaces/create", { name: "Elsewhere" });
      values.add("fake-elsewhere");
      await rpc(
        a.cookie,
        "vault/put",
        { ...destination, name: "elsewhere_only", value: "fake-elsewhere" },
        elsewhere.id,
      );
      expect((await use(a, x, "elsewhere_only")).sent).toBeNull();

      // B's own bot is private: A cannot see it, so A's key does not serve it.
      const hidden = await rpc<{ id: string }>(
        b.cookie,
        "bots/create",
        { name: "W", title: "", description: "", instructions: "", notifyOnFinish: false },
        spaceId,
      );
      expect((await use(b, hidden.id, "a_shared")).sent).toBeNull();

      // A's own run on A's bot can use B's key shared with A (documented widening), not B's private one.
      expect((await use(a, x, "b_shared")).sent).toBe("Bearer fake-b-shared");
      expect((await use(a, x, "b_private")).sent).toBeNull();
    });

    it("marks a key someone else owns as shared when listing, without naming them", async () => {
      // B's run on A's bot: A's key shared with B, and B's own key shared with A.
      const { listed } = await use(b, x, "a_shared");
      const keys = JSON.parse(listed) as Array<{ name: string; shared: boolean }>;
      expect(keys.find((key) => key.name === "a_shared")?.shared).toBe(true);
      expect(keys.find((key) => key.name === "b_shared")?.shared).toBe(false);
      for (const owner of [a.userId, "Executor share-a", "executor-share-a"]) {
        expect(listed).not.toContain(owner);
      }
    });

    it("never saves a key from a bot someone else owns, even when keys are shared", async () => {
      const before = await handles.prisma.botSecret.count({ where: { userId: b.userId } });
      const result = await use(b, x, "a_shared", undefined, [
        {
          name: "request_secret",
          args: {
            label: "API key",
            purpose: "api_key",
            credential: { ...destination, name: "a_shared" },
          },
        },
      ]);
      expect(result.outputs[2]).toContain("Saved API keys can only be added on your own bots.");
      expect(
        await handles.prisma.externalEffect.count({
          where: { runId: result.runId, kind: "request_secret" },
        }),
      ).toBe(0);
      expect(await handles.prisma.botSecret.count({ where: { userId: b.userId } })).toBe(before);
    });

    it("resolves a name the same way every time and sends only to the chosen key's site", async () => {
      const elsewhere = "https://other.example.test";
      await put(a, "dup", "fake-a-dup");
      await put(b, "dup", "fake-b-dup", elsewhere);
      await share(b, "dup", [a.userId]);
      // A's own key is never shadowed by B's, and never goes to B's site.
      expect(await use(a, x, "dup")).toMatchObject({
        sent: "Bearer fake-a-dup",
        sentTo: destination.origin,
      });
      expect((await use(a, x, "dup", `${elsewhere}/v1`)).sent).toBeNull();
      // B's run picks B's own key, at B's site.
      expect(await use(b, x, "dup", `${elsewhere}/v1`)).toMatchObject({
        sent: "Bearer fake-b-dup",
        sentTo: elsewhere,
      });
      // The same name shared by two others: the oldest, every time.
      await put(b, "twin", "fake-b-twin");
      await share(b, "twin", [a.userId]);
      await put(c, "twin", "fake-c-twin");
      await share(c, "twin", [a.userId]);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect((await use(a, x, "twin")).sent).toBe("Bearer fake-b-twin");
      }
    });

    it("lets only the key's owner choose who it is shared with", async () => {
      await expect(share(b, "a_shared", [c.userId])).rejects.toThrow("(404)");
      await expect(share(a, "a_shared", ["not-a-member"])).rejects.toThrow("(400)");
      expect((await vault(a)).mine.find((key) => key.name === "a_shared")).toMatchObject({
        userIds: [b.userId],
        space: false,
      });
      expect(JSON.stringify([await vault(a), await vault(b)])).not.toMatch(/fake-/);
    });

    it("shares with the whole Space only when the owner ticks it, future members included", async () => {
      await put(a, "everyone", "fake-everyone");
      // Sharing bot Z with the Space ticked no key.
      expect((await vault(a)).mine.every((key) => !key.space)).toBe(true);
      expect((await use(b, z, "everyone")).sent).toBeNull();

      await share(a, "everyone", [], true);
      expect((await use(b, z, "everyone")).sent).toBe("Bearer fake-everyone");
      const later = await join("share-d");
      expect((await use(later, z, "everyone")).sent).toBe("Bearer fake-everyone");
      expect((await vault(later)).shared).toEqual([
        { ...destination, name: "everyone", ownerName: "Executor share-a" },
      ]);

      await rpc(a.cookie, "spaces/removeMember", { spaceId, userId: later.userId }, spaceId);
      expect((await use(later, z, "everyone")).sent).toBeNull();

      await share(a, "everyone", [], false);
      expect((await use(b, z, "everyone")).sent).toBeNull();
    });

    it("stops serving a key whose owner left the Space, and resumes when they rejoin", async () => {
      // Z is shared with the whole Space, so only B's membership decides here.
      expect((await use(a, z, "b_shared")).sent).toBe("Bearer fake-b-shared");
      await rpc(a.cookie, "spaces/removeMember", { spaceId, userId: b.userId }, spaceId);
      // Shares to B went with B's membership.
      expect(await handles.prisma.botSecretShare.count({ where: { userId: b.userId } })).toBe(0);
      expect((await use(a, z, "b_shared")).sent).toBeNull();
      b = await join("share-b", b.email);
      expect((await use(a, z, "b_shared")).sent).toBe("Bearer fake-b-shared");
    });
  });

  describe("webhook key", () => {
    async function keyedBot(label: string) {
      const cookie = await signup(`webhook-${label}-${stamp}@tangow.test`, `Webhook ${label}`);
      const me = await rpc<{ userId: string }>(cookie, "me");
      const bot = await rpc<{ id: string }>(cookie, "bots/create", {
        name: `Webhook ${label}`,
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: false,
      });
      const read = (as = cookie) =>
        rpc<{ secret: string }>(as, "bots/webhookSecret", { botId: bot.id });
      const rotate = (input: { ifAbsent?: boolean } = {}) =>
        rpc<{ secret: string | null }>(cookie, "bots/rotateWebhookSecret", {
          botId: bot.id,
          ...input,
        });
      const accepts = async (secret: string) => {
        const body = JSON.stringify({ zen: "Keep it logically awesome." });
        const response = await handles.app.request(`/api/v1/bots/${bot.id}/github`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
          },
          body,
        });
        return response.status;
      };
      const stored = () =>
        handles.prisma.secret.count({ where: { userId: me.userId, kind: "webhook" } });
      const configured = async () =>
        (await rpc<{ webhookConfigured: boolean }>(cookie, "bots/get", { botId: bot.id }))
          .webhookConfigured;
      return { read, rotate, accepts, stored, configured };
    }

    it("gives the owner the bot's live key on every read, creating it on the first", async () => {
      const bot = await keyedBot("read");
      expect(await bot.configured()).toBe(false);

      const first = await bot.read();
      expect(first.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(await bot.read()).toEqual(first);
      expect(await bot.accepts(first.secret)).toBe(200);
      expect(await bot.configured()).toBe(true);
      expect(await bot.stored()).toBe(1);
    });

    it("creates exactly one key when two first reads race", async () => {
      const bot = await keyedBot("race");
      const [one, two] = await Promise.all([bot.read(), bot.read()]);
      expect(one.secret).toBe(two.secret);
      expect(await bot.accepts(one.secret)).toBe(200);
      expect(await bot.stored()).toBe(1);
    });

    it("refuses the key to anyone but the bot's owner", async () => {
      const bot = await keyedBot("owner");
      const { secret } = await bot.read();
      const stranger = await signup(`webhook-stranger-${stamp}@tangow.test`, "Webhook stranger");

      await expect(bot.read(stranger)).rejects.toThrow("bots/webhookSecret failed (404)");
      expect(await bot.read()).toEqual({ secret });
      expect(await bot.stored()).toBe(1);
    });

    it("reads the new key after a rotation, and the old one stops working", async () => {
      const bot = await keyedBot("rotate");
      const before = await bot.read();
      const rotated = await bot.rotate();

      expect(rotated.secret).not.toBe(before.secret);
      expect(await bot.read()).toEqual({ secret: rotated.secret });
      expect(await bot.accepts(before.secret)).toBe(401);
      expect(await bot.accepts(rotated.secret!)).toBe(200);
      expect(await bot.stored()).toBe(1);
    });

    it("still leaves a live key alone for app builds that rotate with ifAbsent", async () => {
      const bot = await keyedBot("if-absent");
      const { secret } = await bot.read();

      expect(await bot.rotate({ ifAbsent: true })).toMatchObject({ secret: null });
      expect(await bot.accepts(secret)).toBe(200);
      expect(await bot.stored()).toBe(1);
    });
  });

  async function seedRun(
    label: string,
    prompt: string,
    runState: {
      status?: string;
      leaseOwner?: string;
      leaseFence?: number;
      leaseExpiresAt?: Date;
      startedAt?: Date;
      completedAt?: Date;
    } = {},
  ) {
    const cookie = await signup(`executor-${label}-${stamp}@tangow.test`, `Executor ${label}`);
    const me = await rpc<{ userId: string; spaceId: string }>(cookie, "me");
    const bot = await rpc<{ id: string }>(cookie, "bots/create", {
      name: `Executor ${label}`,
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    const thread = await handles.prisma.thread.findUniqueOrThrow({ where: { botId: bot.id } });
    const task = await handles.prisma.task.create({
      data: {
        spaceId: me.spaceId,
        botId: bot.id,
        threadId: thread.id,
        userId: me.userId,
        prompt,
        status: "queued",
      },
    });
    const run = await handles.prisma.run.create({
      data: {
        spaceId: me.spaceId,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        userId: me.userId,
        status: runState.status ?? "queued",
        trigger: "user",
        leaseOwner: runState.leaseOwner,
        leaseFence: runState.leaseFence,
        leaseExpiresAt: runState.leaseExpiresAt,
        startedAt: runState.startedAt,
        completedAt: runState.completedAt,
      },
    });
    return { cookie, me, bot, thread, task, run };
  }

  async function signup(email: string, name: string) {
    const response = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
      body: JSON.stringify({ email, password: "password12", name }),
    });
    expect(response.status).toBeLessThan(400);
    const raw = response.headers.get("set-cookie") ?? "";
    const match = raw.match(/better-auth\.session_token=([^;]+)/);
    expect(match?.[1]).toBeTruthy();
    return `better-auth.session_token=${match![1]}`;
  }

  async function signin(email: string) {
    const response = await handles.app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
      body: JSON.stringify({ email, password: "password12" }),
    });
    expect(response.status).toBeLessThan(400);
    const match = (response.headers.get("set-cookie") ?? "").match(
      /better-auth\.session_token=([^;]+)/,
    );
    return `better-auth.session_token=${match![1]}`;
  }

  async function rpc<T>(
    cookie: string,
    procedure: string,
    body: unknown = {},
    spaceId?: string,
  ): Promise<T> {
    const response = await handles.app.request(`/rpc/${procedure}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://127.0.0.1:5173",
        cookie,
        ...(spaceId ? { "x-tangow-space-id": spaceId } : {}),
      },
      body: JSON.stringify({ json: body }),
    });
    const payload = (await response.json()) as { json?: T; error?: { message?: string } };
    if (!response.ok || payload.error) {
      const message = payload.error?.message ?? (payload.json as { message?: string })?.message;
      throw new Error(`${procedure} failed (${response.status}): ${message}`);
    }
    return payload.json as T;
  }
});
