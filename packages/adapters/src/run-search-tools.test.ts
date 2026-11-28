import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AgentRunRequest,
  AgentRuntimeEvent,
  MemoryStore,
  SessionEntryDraft,
} from "@tangow/adapter-kit";
import { EntrySeq, RunSearchPage, SessionId } from "@tangow/contracts";
import { redactSecrets, unattendedTriggerToolRequiresApproval } from "@tangow/core";
import { createThreadEvents } from "@tangow/db";
import type { PgliteDatabase } from "@tangow/db/pglite.test-support";
import { openPgliteDatabase } from "@tangow/db/pglite.test-support";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycle from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { FakeWebProvider } from "./fake-web.js";
import { LocalAgentHomeStore } from "./home.js";
import { searchRunsFromTool } from "./run-search-tools.js";
import { EncryptedSecretStore } from "./secrets.js";
import { PostgresSessionLog } from "./session-log/postgres.js";
import { createInMemorySkillLock } from "./skill-lock.js";
import { InMemoryJobQueue } from "./wakeup.js";

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycle>()),
  acquireComputerExecutionLease: async () => null,
  provisionComputer: async () => ({ id: "search-computer", kind: "docker" }),
}));

const unmasked = { redact: (text: string) => text };

describe("search_runs authorization and archive discovery", () => {
  let database: PgliteDatabase;
  let log: PostgresSessionLog;
  beforeAll(async () => {
    database = await openPgliteDatabase();
    log = new PostgresSessionLog(database.prisma);
    await database.prisma.user.create({
      data: { id: "search-user", name: "Search", email: "search@tangow.test" },
    });
    await database.prisma.organization.create({
      data: { id: "search-org", name: "Search", slug: "search-org", createdAt: new Date() },
    });
    for (const id of ["search-space", "foreign-space"])
      await database.prisma.space.create({
        data: { id, organizationId: "search-org", name: "Test" },
      });
  });
  afterAll(() => database.close());

  function append(draft: SessionEntryDraft) {
    return database.prisma.$transaction((tx) =>
      log.append(tx, { feedBotId: draft.botId ?? "feed", ...draft }),
    );
  }
  async function conversation() {
    const bot = await database.prisma.bot.create({
      data: { spaceId: "search-space", userId: "search-user", name: "Search", color: "#000000" },
    });
    const thread = await database.prisma.thread.create({
      data: { spaceId: bot.spaceId, userId: bot.userId, botId: bot.id },
    });
    return { bot, thread, sessionId: SessionId.parse(thread.sessionId) };
  }
  async function runOf(
    c: Awaited<ReturnType<typeof conversation>>,
    prompt: string,
    options: {
      sessionId?: string;
      parentRunId?: string;
      sourceMessageId?: string;
      trigger?: string;
      createdAt?: Date;
      userId?: string;
      spaceId?: string;
      botId?: string;
    } = {},
  ) {
    const task = await database.prisma.task.create({
      data: {
        spaceId: c.bot.spaceId,
        userId: c.bot.userId,
        botId: c.bot.id,
        threadId: c.thread.id,
        prompt,
        status: "running",
      },
    });
    return database.prisma.run.create({
      data: {
        spaceId: c.bot.spaceId,
        userId: c.bot.userId,
        botId: c.bot.id,
        threadId: c.thread.id,
        taskId: task.id,
        status: "running",
        trigger: "user",
        ...options,
      },
    });
  }
  async function text(
    run: Awaited<ReturnType<typeof runOf>>,
    value: string,
    sessionId = run.sessionId,
  ) {
    return append({
      sessionId: SessionId.parse(sessionId),
      runId: run.id,
      botId: run.botId,
      type: "assistant.text",
      payload: { blocks: [{ kind: "text", text: value }] },
    });
  }
  async function caller(c: Awaited<ReturnType<typeof conversation>>) {
    const run = await runOf(c, "Find the archived receipt");
    await text(run, "Ready");
    return run;
  }
  function search(callerId: string, args: unknown, redaction = unmasked) {
    return searchRunsFromTool(
      { prisma: database.prisma, sessionLog: log },
      callerId,
      args,
      redaction,
    );
  }

  it("finds a run older than twenty after compaction and retrieves its exact retained reference without a refetch", async () => {
    const c = await conversation();
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) {
      const run = await runOf(c, `Archive job ${i}`, {
        createdAt: new Date(Date.UTC(2026, 8, 1, 0, 0, i)),
      });
      ids.push(run.id);
      await text(run, i === 0 ? "Stored receipt K731" : "Other result");
    }
    const current = await caller(c);
    const [head] = await log.readPage(c.sessionId, { limit: 1 });
    await append({
      sessionId: c.sessionId,
      botId: c.bot.id,
      type: "compaction",
      parentId: head!.id,
      payload: { summary: "Jobs finished", coveredUpToSeq: EntrySeq.parse(head!.seq) },
    });
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await search(current.id, { cursor });
      if (!("items" in page) || !page.items) throw new Error(JSON.stringify(page));
      seen.push(...page.items.map((item) => item.runId));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen.length).toBe(25);
    expect(new Set(seen).size).toBe(25);
    expect(seen.at(-1)).toBe(ids[0]);
    const found = await search(current.id, { runId: ids[0], query: "K731" });
    expect(found).toMatchObject({
      status: "ok",
      hits: [{ runId: ids[0], excerpt: "Stored receipt K731" }],
      nextCursor: null,
      incomplete: false,
    });
    expect(await search(current.id, { query: "Archive job 0" })).toMatchObject({
      items: [{ runId: ids[0], excerpt: "Archive job 0" }],
    });
    expect(await search(current.id, { runId: ids[0], query: "not retained" })).toEqual({
      status: "ok",
      hits: [],
      nextCursor: null,
      incomplete: false,
      limitations: [],
    });
    expect(
      unattendedTriggerToolRequiresApproval(
        { trigger: "webhook", requireToolApproval: true },
        "search_runs",
        false,
      ),
    ).toBe(false);
  });

  it("the executor retrieves a retained receipt after compaction, posts it, and performs zero follow-up fetches", async () => {
    const c = await conversation();
    const root = await mkdtemp(path.join(tmpdir(), "tangow-search-executor-"));
    try {
      const computer = await database.prisma.computer.create({
        data: {
          id: "search-computer",
          spaceId: c.bot.spaceId,
          userId: c.bot.userId,
          scope: "dedicated",
          scopeKey: "search-computer",
          homeKey: "search-computer",
          kind: "docker",
        },
      });
      await database.prisma.bot.update({
        where: { id: c.bot.id },
        data: { computerId: computer.id },
      });
      await database.prisma.deploymentSettings.upsert({
        where: { id: "default" },
        create: { id: "default", defaultModelProvider: "scripted", defaultModelId: "scripted" },
        update: { defaultModelProvider: "scripted", defaultModelId: "scripted" },
      });
      const old = await runOf(c, "Fetch the receipt");
      await database.prisma.run.update({ where: { id: old.id }, data: { status: "queued" } });
      const web = new FakeWebProvider();
      const secret = 'fake-line-one"\\\nfake-line-two';
      web.fetchResult = {
        url: "https://example.test/receipt",
        title: "Receipt",
        text: JSON.stringify({ receipt: "receipt K731", credential: secret }),
        truncated: false,
      };
      const fetch = vi.spyOn(web, "fetch");
      const memory: MemoryStore = {
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
      let currentId = old.id;
      const requests: AgentRunRequest[] = [];
      const secretStore = new EncryptedSecretStore("fixture-only-key");
      const executor = createRunExecutor({
        prisma: database.prisma,
        sessionLog: log,
        events: createThreadEvents(database.prisma),
        sandbox: new FakeSandboxProvider(),
        home: new LocalAgentHomeStore(root),
        dataDir: root,
        memory,
        memoryProviders: { resolve: async () => null },
        secretStore,
        vaultSecretStore: secretStore,
        jobs: new InMemoryJobQueue(),
        skillLock: createInMemorySkillLock(),
        skillLearning: "off",
        secrets: [secret],
        web,
        runtime: {
          describe: () => ({
            id: "offline",
            contractVersion: "1",
            adapterVersion: "1",
            capabilities: { scripted: false, streaming: false, tools: true, compaction: false },
          }),
          abort: async () => {},
          async *run(request): AsyncIterable<AgentRuntimeEvent> {
            requests.push(request);
            if (!request.executeTool) throw new Error("Missing executor dispatch");
            if (currentId === old.id) {
              await request.executeTool(
                "web_fetch",
                { url: "https://example.test/receipt" },
                "fetch-1",
              );
            } else {
              const catalog = await request.executeTool(
                "search_runs",
                { query: "K731" },
                "catalog-1",
              );
              expect(catalog).toMatchObject({ items: [{ runId: old.id }] });
              const found = RunSearchPage.parse(
                await request.executeTool(
                  "search_runs",
                  { runId: old.id, query: "K731" },
                  "search-1",
                ),
              );
              expect(found).toMatchObject({ hits: [{ runId: old.id }] });
              if (found.status !== "ok" || !found.hits[0]) throw new Error("Missing receipt");
              expect(found.hits[0].excerpt).toContain("receipt K731");
              expect(found.hits[0].excerpt).toContain("[redacted]");
              expect(found.hits[0].excerpt).not.toContain("fake-line");
              for (const query of ["fake-line-one", "fake-line-two"]) {
                let cursor: string | undefined;
                do {
                  const page = RunSearchPage.parse(
                    await request.executeTool(
                      "search_runs",
                      { runId: old.id, query, ...(cursor ? { cursor } : {}) },
                      query,
                    ),
                  );
                  expect(page).toMatchObject({ status: "ok", hits: [] });
                  if (page.status !== "ok") throw new Error("Archive search unavailable");
                  cursor = page.nextCursor ?? undefined;
                } while (cursor);
              }
              await request.executeTool(
                "message_user",
                { message: "The retained receipt is K731." },
                "reply-1",
              );
              expect(
                await request.executeTool(
                  "search_runs",
                  { runId: old.id, query: "missing-id" },
                  "search-2",
                ),
              ).toMatchObject({ status: "ok", hits: [] });
            }
            yield {
              type: "done",
              text: "",
              ...(currentId === old.id
                ? {
                    privateFinalText: JSON.stringify({
                      version: 1,
                      results: ["The retained receipt is K731."],
                      references: [{ callId: "fetch-1" }],
                    }),
                  }
                : {}),
            };
          },
        },
      });
      await executor.continueRun(old.id, "offline-worker");
      expect(
        await database.prisma.run.findUnique({
          where: { id: old.id },
          select: { status: true, error: true },
        }),
      ).toEqual({ status: "completed", error: null });
      const stored = await log.readRun(old.id);
      const result = stored.find((entry) => entry.type === "tool.result");
      if (result?.type !== "tool.result") throw new Error("Missing tool result");
      expect(JSON.parse(JSON.parse(result.payload.output).text)).toEqual({
        receipt: "receipt K731",
        credential: "[redacted]",
      });
      expect(JSON.stringify(stored)).not.toContain("fake-line");
      const [head] = await log.readPage(c.sessionId, { limit: 1 });
      await append({
        sessionId: c.sessionId,
        botId: c.bot.id,
        type: "compaction",
        parentId: head!.id,
        payload: { summary: "Retrieved a receipt.", coveredUpToSeq: EntrySeq.parse(head!.seq) },
      });
      const [compactedHead] = await log.readPage(c.sessionId, { limit: 1 });
      await append({
        sessionId: c.sessionId,
        botId: c.bot.id,
        type: "compaction",
        parentId: compactedHead!.id,
        payload: {
          summary: "Earlier work finished.",
          coveredUpToSeq: EntrySeq.parse(compactedHead!.seq),
        },
      });
      const current = await runOf(c, "What was the receipt?");
      currentId = current.id;
      await database.prisma.run.update({ where: { id: current.id }, data: { status: "queued" } });
      await executor.continueRun(current.id, "offline-worker");
      expect(
        await database.prisma.run.findUnique({
          where: { id: current.id },
          select: { status: true, error: true },
        }),
      ).toEqual({ status: "completed", error: null });
      expect(fetch.mock.calls.length).toBe(1);
      const reply = (await log.readRun(current.id)).filter(
        (entry) => entry.type === "assistant.text" && entry.payload.toPerson,
      );
      expect(
        reply.map((entry) => (entry.type === "assistant.text" ? entry.payload.blocks : [])),
      ).toEqual([[{ kind: "text", text: "The retained receipt is K731." }]]);
      expect(
        await database.prisma.externalEffect.count({
          where: { runId: current.id, kind: "search_runs" },
        }),
      ).toBe(0);
      expect(
        requests[1]?.history.some(
          (turn) => typeof turn.content === "string" && turn.content.includes("K731"),
        ),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([false, true])(
    "authorizes a fresh interactive child through its %s source-less anchor and revokes it on rewind and clear",
    async (sourceLess) => {
      const c = await conversation();
      const current = await caller(c);
      const keep = (await log.readTail(c.sessionId)).at(-1)!;
      const allowed = await runOf(c, "Find retained receipt");
      await text(allowed, "receipt K731");
      const fresh = await runOf(c, "Find earlier receipt");
      const childId = SessionId.parse(crypto.randomUUID());
      const anchor = await append(
        sourceLess
          ? {
              sessionId: c.sessionId,
              botId: c.bot.id,
              runId: fresh.id,
              type: "run.opened",
              payload: { sessionId: childId },
            }
          : {
              sessionId: c.sessionId,
              type: "user.message",
              payload: { source: "app", blocks: [{ kind: "text", text: "Find earlier receipt" }] },
            },
      );
      await database.prisma.$transaction((tx) =>
        log.createSession(tx, {
          kind: "interactive",
          id: childId,
          spaceId: c.bot.spaceId,
          parentSessionId: c.sessionId,
          parentEntryId: anchor.id,
        }),
      );
      await database.prisma.run.update({
        where: { id: fresh.id },
        data: {
          sessionId: childId,
          sourceMessageId: sourceLess ? null : anchor.id,
        },
      });
      expect(await search(fresh.id, { query: "Find retained receipt" })).toMatchObject({
        status: "ok",
        items: [{ runId: allowed.id }],
      });
      await text({ ...fresh, sessionId: childId }, "receipt child");
      await text(fresh, "receipt published", c.sessionId);
      await database.prisma.run.update({ where: { id: fresh.id }, data: { status: "completed" } });
      await append({
        sessionId: c.sessionId,
        botId: c.bot.id,
        runId: fresh.id,
        type: "run.recap",
        payload: {
          version: 1,
          sessionId: childId,
          outcome: { status: "completed", usage: { inputTokens: 0, outputTokens: 0 } },
          recap: { state: "missing", reason: sourceLess ? "absent" : "invalid" },
        },
      });
      const page = await search(current.id, { runId: fresh.id, query: "receipt" });
      expect(page).toMatchObject({ hits: [{ excerpt: "receipt child" }], incomplete: true });
      if (!("nextCursor" in page) || !page.nextCursor) throw new Error("Missing raised phase");
      expect(
        await search(current.id, { runId: fresh.id, query: "receipt", cursor: page.nextCursor }),
      ).toMatchObject({
        hits: [{ excerpt: "receipt published" }],
        nextCursor: null,
      });
      await append({ sessionId: c.sessionId, type: "rewind", parentId: keep.id, payload: {} });
      expect(await search(current.id, { runId: fresh.id, query: "receipt" })).toEqual({
        status: "unavailable",
        reason: "not_found_or_denied",
      });
      await append({ sessionId: c.sessionId, type: "clear", payload: {} });
      expect(await search(fresh.id, {})).toEqual({
        status: "unavailable",
        reason: "not_found_or_denied",
      });
    },
  );

  it("matches only authorized bounded recap facts after compaction and redacts them before discovery", async () => {
    const c = await conversation();
    const current = await caller(c);
    const target = await runOf(c, "Investigate stored artifact");
    await text(target, "private text never searched by the catalog");
    const secret = 'fake-key-quote"line\nend';
    await append({
      sessionId: c.sessionId,
      botId: c.bot.id,
      runId: target.id,
      type: "run.recap",
      payload: {
        version: 1,
        sessionId: c.sessionId,
        outcome: { status: "completed", usage: { inputTokens: 0, outputTokens: 0 } },
        recap: {
          state: "available",
          facts: { version: 1, results: ["Zebra731 receipt", secret], references: [] },
        },
      },
    });
    await append({
      sessionId: c.sessionId,
      botId: c.bot.id,
      runId: target.id,
      type: "assistant.reasoning",
      payload: { text: "forbidden-private-reasoning" },
    });
    const [head] = await log.readPage(c.sessionId, { limit: 1 });
    await append({
      sessionId: c.sessionId,
      type: "compaction",
      parentId: head!.id,
      payload: { summary: "Previous work", coveredUpToSeq: EntrySeq.parse(head!.seq) },
    });
    const redaction = { redact: (value: string) => redactSecrets(value, [secret]) };
    expect(await search(current.id, { query: "Zebra731" }, redaction)).toMatchObject({
      items: [{ runId: target.id, excerpt: expect.stringContaining("Zebra731 receipt") }],
    });
    expect(await search(current.id, { query: "fake-key-quote" }, redaction)).toMatchObject({
      items: [],
    });
    expect(await search(current.id, { query: "forbidden-private-reasoning" })).toMatchObject({
      items: [],
    });
  });

  it("discovers an active old source beyond the journal scan bound without misreporting an access denial", async () => {
    const c = await conversation();
    const current = await caller(c);
    const source = await append({
      sessionId: c.sessionId,
      type: "user.message",
      payload: { source: "app", blocks: [{ kind: "text", text: "Old question" }] },
    });
    const old = await runOf(c, "old catalog receipt", { sourceMessageId: source.id });
    const receipt = await text(old, "receipt old retained");
    const prefix = `${c.thread.id}-filler-`;
    await database.prisma.$executeRaw`
      INSERT INTO session_entries (id, "sessionId", seq, "parentId", type, payload)
      SELECT ${prefix} || n, ${c.sessionId}, ${receipt.seq} + n,
        CASE WHEN n = 1 THEN ${receipt.id} ELSE ${prefix} || (n - 1) END,
        'system.note', '{"text":"filler"}'::jsonb FROM generate_series(1, 20010) n`;
    await database.prisma.conversationSession.update({
      where: { id: c.sessionId },
      data: { nextEntrySeq: receipt.seq + 20011, headEntryId: `${prefix}20010` },
    });
    expect(await search(current.id, { query: "old catalog receipt" })).toMatchObject({
      status: "ok",
      items: [{ runId: old.id, excerpt: "old catalog receipt" }],
    });
    expect(await search(current.id, { runId: old.id, query: "receipt" })).toMatchObject({
      status: "ok",
      hits: [],
      incomplete: true,
      limitations: ["scan_limit"],
    });
  });

  it("bounds multibyte discovery pages and finishes without duplicate references", async () => {
    const c = await conversation();
    const current = await caller(c);
    for (let i = 0; i < 12; i++) {
      const run = await runOf(c, `${"字".repeat(100)} archive ${i} ${"字".repeat(100)}`);
      await text(run, "Retained");
    }
    let cursor: string | undefined;
    const seen: string[] = [];
    do {
      const result = await search(current.id, { query: "archive", cursor });
      if (!("items" in result) || !result.items) throw new Error(JSON.stringify(result));
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(4000);
      seen.push(...result.items.map((item) => item.runId));
      cursor = result.nextCursor ?? undefined;
    } while (cursor);
    expect(seen.length).toBe(12);
    expect(new Set(seen).size).toBe(12);
  });

  it("denies unknown, foreign owner/space/bot/conversation targets before invoking the text reader", async () => {
    const c = await conversation();
    const current = await caller(c);
    const allowed = await runOf(c, "Allowed");
    await text(allowed, "receipt allowed");
    const read = vi.spyOn(log, "searchRun");
    expect(await search(current.id, { runId: allowed.id, query: "receipt" })).toMatchObject({
      hits: [{ excerpt: "receipt allowed" }],
    });
    read.mockClear();
    const foreign = await conversation();
    const group = await database.prisma.chatGroup.create({
      data: {
        spaceId: c.bot.spaceId,
        userId: c.bot.userId,
        name: "Other conversation",
        members: { create: { botId: c.bot.id } },
      },
    });
    const otherThread = await database.prisma.thread.create({
      data: { spaceId: c.bot.spaceId, userId: c.bot.userId, groupId: group.id },
    });
    const elsewhere = {
      ...c,
      thread: otherThread,
      sessionId: SessionId.parse(otherThread.sessionId),
    };
    const denied = [
      await runOf(c, "Wrong owner", { userId: "other-user" }),
      await runOf(c, "Wrong space", { spaceId: "foreign-space" }),
      await runOf(c, "Wrong bot", { botId: foreign.bot.id }),
      await runOf(elsewhere, "Wrong conversation"),
    ];
    for (const run of denied) await text(run, "receipt private");
    for (const id of ["unknown", ...denied.map((run) => run.id)]) {
      expect(await search(current.id, { runId: id, query: "receipt" })).toEqual({
        status: "unavailable",
        reason: "not_found_or_denied",
      });
    }
    expect(read.mock.calls.length).toBe(0);
    expect(await search(current.id, { query: "Wrong" })).toMatchObject({ status: "ok", items: [] });
    read.mockRestore();
  });

  it("searches a person's runs of a bot shared with them in a group", async () => {
    const c = await conversation();
    await database.prisma.user.create({
      data: { id: "group-person", name: "Person", email: "person@tangow.test" },
    });
    await database.prisma.bot.update({ where: { id: c.bot.id }, data: { visibility: "space" } });
    const group = await database.prisma.chatGroup.create({
      data: {
        spaceId: c.bot.spaceId,
        userId: c.bot.userId,
        name: "Crew",
        members: { create: { botId: c.bot.id } },
        people: { create: [{ userId: c.bot.userId }, { userId: "group-person" }] },
      },
    });
    const thread = await database.prisma.thread.create({
      data: { spaceId: c.bot.spaceId, userId: c.bot.userId, groupId: group.id },
    });
    const inGroup = { ...c, thread, sessionId: SessionId.parse(thread.sessionId) };
    const current = await runOf(inGroup, "Now", { userId: "group-person" });
    await text(current, "Ready");
    const earlier = await runOf(inGroup, "Earlier receipt", { userId: "group-person" });
    await text(earlier, "receipt found");

    expect(await search(current.id, { runId: earlier.id, query: "receipt" })).toMatchObject({
      hits: [{ excerpt: "receipt found" }],
    });
  });

  it("revokes a source removed by rewind even when the run has new active text", async () => {
    const c = await conversation();
    const current = await caller(c);
    const keep = await text(current, "Before source");
    const source = await append({
      sessionId: c.sessionId,
      type: "user.message",
      payload: { source: "app", blocks: [{ kind: "text", text: "Question" }] },
    });
    const target = await runOf(c, "Source anchored", { sourceMessageId: source.id });
    await text(target, "receipt authorized");
    expect(await search(current.id, { runId: target.id, query: "receipt" })).toMatchObject({
      hits: [{ excerpt: "receipt authorized" }],
    });
    await append({ sessionId: c.sessionId, type: "rewind", parentId: keep.id, payload: {} });
    await text(target, "receipt on new branch");
    expect(await search(current.id, { runId: target.id, query: "receipt" })).toEqual({
      status: "unavailable",
      reason: "not_found_or_denied",
    });
  });

  it("retrieves a child trace and raised parent text, snapshots both phases, then denies a removed launch", async () => {
    const c = await conversation();
    const current = await caller(c);
    const keep = await text(current, "Before launch");
    const launch = await append({
      sessionId: c.sessionId,
      runId: current.id,
      botId: c.bot.id,
      type: "tool.call",
      payload: { callId: "helper", name: "run_subagent", input: "{}" },
    });
    const childId = SessionId.parse(crypto.randomUUID());
    await database.prisma.$transaction((tx) =>
      log.createSession(tx, {
        kind: "subagent",
        id: childId,
        spaceId: c.bot.spaceId,
        parentSessionId: c.sessionId,
        parentEntryId: launch.id,
      }),
    );
    const child = await runOf(c, "Helper", {
      sessionId: childId,
      parentRunId: current.id,
      trigger: "subagent",
    });
    await text(child, "receipt in child trace");
    await text(child, "receipt raised to parent", c.sessionId);
    const first = await search(current.id, { runId: child.id, query: "receipt" });
    expect(first).toMatchObject({
      hits: [{ excerpt: "receipt in child trace" }],
      incomplete: true,
    });
    if (!("nextCursor" in first) || !first.nextCursor) throw new Error("Expected parent phase");
    await text(child, "receipt appended later", c.sessionId);
    const parent = await search(current.id, {
      runId: child.id,
      query: "receipt",
      cursor: first.nextCursor,
    });
    expect(parent).toMatchObject({
      hits: [{ excerpt: "receipt raised to parent" }],
      nextCursor: null,
      incomplete: false,
    });
    await append({ sessionId: c.sessionId, type: "rewind", parentId: keep.id, payload: {} });
    expect(
      await search(current.id, { runId: child.id, query: "receipt", cursor: first.nextCursor }),
    ).toEqual({ status: "unavailable", reason: "not_found_or_denied" });
  });

  it("denies channel provenance and reauthorizes discovery cursors after a clear", async () => {
    const c = await conversation();
    const current = await caller(c);
    const channel = await runOf(c, "Channel", { trigger: "messaging" });
    await text(channel, "receipt channel");
    expect(await search(channel.id, {})).toEqual({
      status: "unavailable",
      reason: "not_found_or_denied",
    });
    expect(await search(current.id, { runId: channel.id, query: "receipt" })).toEqual({
      status: "unavailable",
      reason: "not_found_or_denied",
    });
    const source = await append({
      sessionId: c.sessionId,
      type: "user.message",
      payload: {
        source: "channel",
        blocks: [
          {
            kind: "channel_message",
            provider: "imessage",
            channelId: "fake-channel",
            fromAddress: "+10000000000",
            fromLabel: "Test",
            text: "Channel post",
          },
        ],
      },
    });
    const follow = await runOf(c, "Follow channel", {
      sourceMessageId: source.id,
      trigger: "follow_up",
    });
    await text(follow, "receipt channel followup");
    expect(await search(follow.id, {})).toEqual({
      status: "unavailable",
      reason: "not_found_or_denied",
    });
    for (let i = 0; i < 12; i++) await text(await runOf(c, `Job ${i}`), "Result");
    const page = await search(current.id, {});
    if (!("nextCursor" in page) || !page.nextCursor) throw new Error("Expected cursor");
    expect(await search(current.id, { query: "changed", cursor: page.nextCursor })).toEqual({
      status: "unavailable",
      reason: "invalid_cursor",
    });
    await append({ sessionId: c.sessionId, type: "clear", payload: {} });
    await text(current, "Current run after clear");
    expect(await search(current.id, { cursor: page.nextCursor })).toEqual({
      status: "unavailable",
      reason: "invalid_cursor",
    });
  });

  it.each([
    { gap: 398, tail: "needle fake-credential-BBBBBBBBBBBBBBBB", expected: "needle [redacted]" },
    { gap: 1000, tail: "needle public", expected: "needle public" },
  ])(
    "catalog masks complete prompt text before matching with a $gap-character gap",
    async ({ gap, tail, expected }) => {
      const c = await conversation();
      const current = await caller(c);
      const secrets = ["needleAAAAAAAAAAAAAAAAAAAAAAAAAA", "fake-credential-BBBBBBBBBBBBBBBB"];
      const target = await runOf(c, `${secrets[0]}${"x".repeat(gap)}${tail}`);
      await text(target, "Receipt");
      const result = await search(
        current.id,
        { query: "needle" },
        { redact: (value) => redactSecrets(value, secrets) },
      );
      expect(result).toMatchObject({
        items: [{ runId: target.id, excerpt: expect.stringContaining(expected) }],
      });
      expect(JSON.stringify(result).includes("fake-credential")).toBe(false);
    },
  );

  it("redacts known secrets from discovery before exposing excerpts or query hits", async () => {
    const c = await conversation();
    const current = await caller(c);
    const secret = `fake-credential-${"s".repeat(200)}`;
    const target = await runOf(c, `archive receipt ${"a".repeat(100)} ${secret}`);
    await text(target, "receipt safe");
    const redaction = {
      redact: (value: string) => redactSecrets(value, [secret]),
    };
    const found = await search(current.id, { query: "receipt" }, redaction);
    expect(found).toMatchObject({ items: [{ runId: target.id }] });
    expect(JSON.stringify(found).includes("fake-credential")).toBe(false);
    expect(await search(current.id, { query: "fake-credential" }, redaction)).toMatchObject({
      items: [],
      nextCursor: null,
    });
  });
});
