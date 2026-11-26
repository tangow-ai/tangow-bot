import { execFile, execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { serve } from "@hono/node-server";
import type { SessionEntryDraft } from "@tangow/adapter-kit";
import {
  ComposioEmulator,
  EmailEmulator,
  LocalArtifactStore,
  ThirdPartyConnectorEmulator,
} from "@tangow/adapters";
import type { EntryId, MessageBlock, SessionEntry, SessionId } from "@tangow/contracts";
import { messageBlockForArtifact } from "@tangow/core";
import {
  appendRunFinishedInTransaction,
  appendSessionEntryInTransaction,
  createBotMessageInTransaction,
  createThreadMessage,
  openRoutineSessionInTransaction,
  type PrismaClient,
} from "@tangow/db";
import { sessionCookieHeader } from "../index.js";
import { runProcess } from "./process.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const REPORT_DIR = path.join(ROOT, "test-report", "mobile-screenshots");
const DATA_DIR = path.join(ROOT, ".tmp", "mobile-screenshots-data");
const FLOW_DIR = path.join(ROOT, "apps", "mobile", ".maestro");
const EMAIL = "mobile-screenshots@example.test";
const PASSWORD = "test-password-123";
const API_PORT = 3110;
const DEVICE_CONTROL_PORT = 3111;
const HOST_API_URL = `http://127.0.0.1:${API_PORT}`;
const DEVICE_CONTROL_URL = `http://127.0.0.1:${DEVICE_CONTROL_PORT}`;
const EXPAND_NOTIFICATIONS_URL = `${DEVICE_CONTROL_URL}/expand-notifications`;
const WEB_ORIGIN = "http://127.0.0.1:5180";

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };

/** Capture app screenshots and the notification demo against an isolated, disposable backend. */
async function main() {
  process.chdir(ROOT);
  configureEnvironment();
  await rm(REPORT_DIR, { recursive: true, force: true });
  await rm(DATA_DIR, { recursive: true, force: true });
  await mkdir(REPORT_DIR, { recursive: true });
  await mkdir(DATA_DIR, { recursive: true });

  execFileSync("pnpm", ["--filter", "@tangow/db", "exec", "prisma", "migrate", "deploy"], {
    cwd: path.join(ROOT, "packages", "db"),
    env: process.env,
    stdio: "inherit",
  });
  const thirdParties = new ThirdPartyConnectorEmulator();
  const { createApp } = await import("../../../../apps/api/src/app.ts");
  const handles = await createApp({
    databaseUrl: process.env.DATABASE_URL!,
    dataDir: DATA_DIR,
    apiHost: "0.0.0.0",
    apiUrl: HOST_API_URL,
    composio: new ComposioEmulator(),
    email: new EmailEmulator(),
    remoteConnectors: {
      fetch: thirdParties.fetch,
      resolveHostname: thirdParties.resolveHostname,
    },
  });

  const fixture = await seedFixture(handles.app, handles.prisma);
  const server = serve({
    fetch: handles.app.fetch,
    hostname: "0.0.0.0",
    port: API_PORT,
  });
  const deviceControl = startDeviceControlServer();
  disableIosPasswordSaving();

  try {
    await waitForHealth(`${HOST_API_URL}/health`, 15_000);
    for (const flow of ["screenshots", "notification-demo"]) {
      await runProcess(
        "maestro",
        [
          "test",
          "--no-ansi",
          "--flatten-debug-output",
          "--debug-output",
          path.join(REPORT_DIR, "debug", flow),
          "--test-output-dir",
          REPORT_DIR,
          "--format",
          "HTML",
          "--output",
          path.join(REPORT_DIR, `${flow}.html`),
          "-e",
          `TANGOW_SCREENSHOT_EMAIL=${EMAIL}`,
          "-e",
          `TANGOW_SCREENSHOT_PASSWORD=${PASSWORD}`,
          "-e",
          `TANGOW_SCREENSHOT_BOT_ID=${fixture.botId}`,
          "-e",
          `TANGOW_SCREENSHOT_FAILED_BOT_ID=${fixture.failedBotId}`,
          "-e",
          `TANGOW_SCREENSHOT_GROUP_ID=${fixture.groupId}`,
          "-e",
          `TANGOW_SCREENSHOT_MEMBER_GROUP_ID=${fixture.memberGroupId}`,
          "-e",
          `TANGOW_SCREENSHOT_ROUTINE_ID=${fixture.routineId}`,
          "-e",
          `TANGOW_SCREENSHOT_SHARED_BOT_ID=${fixture.sharedBotId}`,
          "-e",
          `TANGOW_SCREENSHOT_SHARE_BOT_ID=${fixture.shareBotId}`,
          "-e",
          `TANGOW_NOTIFICATION_VIDEO=${path.join(REPORT_DIR, "notification-demo")}`,
          "-e",
          `TANGOW_EXPAND_NOTIFICATIONS_URL=${EXPAND_NOTIFICATIONS_URL}`,
          path.join(FLOW_DIR, `${flow}.yaml`),
        ],
        process.env,
      );
    }
    await writeFile(
      path.join(REPORT_DIR, "summary.json"),
      `${JSON.stringify({ ok: true }, null, 2)}\n`,
    );
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await new Promise<void>((resolve, reject) => {
      deviceControl.close((error) => (error ? reject(error) : resolve()));
    }).catch(() => undefined);
    await handles.stop().catch(() => undefined);
    await rm(DATA_DIR, { recursive: true, force: true });
  }
}

/**
 * iOS offers to save the fixture password after sign-in, in an alert Maestro often cannot see,
 * so its "Not Now" tap went through to the inbox. Without a booted simulator this is an Android run.
 */
function disableIosPasswordSaving() {
  if (process.platform !== "darwin") return;
  const setting = ["com.apple.WebUI", "AutoFillPasswords", "-bool", "NO"];
  try {
    execFileSync("xcrun", ["simctl", "spawn", "booted", "defaults", "write", ...setting], {
      stdio: "ignore",
    });
  } catch {}
}

/** Maestro host-side helper: expand the Android shade without flaky status-bar swipes. */
function startDeviceControlServer(): Server {
  const server = createServer((req, res) => {
    if (req.method !== "GET" || req.url !== "/expand-notifications") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    execFile(
      "adb",
      ["shell", "cmd", "statusbar", "expand-notifications"],
      { timeout: 5_000 },
      (error) => {
        res.writeHead(error ? 500 : 200, { "content-type": "text/plain; charset=utf-8" });
        res.end(error ? "Could not expand notifications" : "ok");
      },
    );
  });
  server.listen(DEVICE_CONTROL_PORT, "127.0.0.1");
  return server;
}

function configureEnvironment() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for the isolated mobile screenshot fixture");
  }
  Object.assign(process.env, {
    NODE_ENV: "test",
    WAKEUP_DRIVER: "memory",
    SANDBOX_PROVIDER: "fake",
    AGENT_RUNTIME: "scripted",
    COMPOSIO_API_KEY: "",
    BETTER_AUTH_SECRET: "mobile-screenshot-auth-secret-32chars",
    ENCRYPTION_KEY: "mobile-screenshot-encryption-key-32chars",
    SCREEN_PROXY_SECRET: "mobile-screenshot-screen-secret-32chars",
    BETTER_AUTH_URL: HOST_API_URL,
    WEB_ORIGIN,
    API_HOST: "0.0.0.0",
    API_PORT: String(API_PORT),
    API_URL: HOST_API_URL,
    DATA_DIR,
    SIGNUPS_ENABLED: "true",
    SIGNUP_ALLOWLIST: "",
    CI: "1",
  });
}

async function seedFixture(app: App, prisma: PrismaClient) {
  const cookie = await signup(app);
  // A connected model, so the models screen can switch from Auto to a fixed model.
  await rpc(app, cookie, "models/connect", {
    provider: "scripted",
    apiKey: "fake-scripted-key",
    modelId: "scripted",
    label: "Scripted",
  });
  const researcher = await rpc<{ id: string }>(app, cookie, "bots/create", {
    name: "Researcher",
    title: "Product research",
    description: "Finds evidence and keeps fixture notes organized.",
    instructions: "Find evidence and summarize it clearly.",
    notifyOnFinish: true,
  });
  // Up already: on iOS, booting it from a link opened over the avatar sheet leaves its screen blank.
  await rpc(app, cookie, "computer/boot", { botId: researcher.id });
  await prisma.volumeSkill.create({
    data: {
      botId: researcher.id,
      source: "shared",
      name: "team-review",
      description: "Review shared work before publishing.",
      path: "/workspace/shared/skills/team-review/SKILL.md",
      content: "",
      contentHash: "0".repeat(64),
    },
  });
  const writer = await rpc<{ id: string }>(app, cookie, "bots/create", {
    name: "Writer",
    title: "Clear writing",
    description: "Turns research into concise drafts.",
    instructions: "Write concise drafts from the available evidence.",
    notifyOnFinish: true,
  });
  const support = await rpc<{ id: string }>(app, cookie, "bots/create", {
    name: "Support",
    title: "Customer support",
    description: "Prepares friendly customer replies.",
    instructions: "Prepare accurate and friendly customer replies.",
    notifyOnFinish: false,
  });
  const archived = await rpc<{ id: string }>(app, cookie, "bots/create", {
    name: "Archived fixture",
    title: "Archived",
    description: "A recoverable archived bot for account screenshots.",
    instructions: "Remain archived.",
    notifyOnFinish: true,
  });
  await rpc(app, cookie, "bots/archive", { botId: archived.id });
  await rpc(app, cookie, "vault/put", {
    name: "example_api",
    origin: "https://api.example.test",
    auth: { type: "bearer" },
    value: "fake-fixture-api-key",
  });

  const group = await rpc<{ id: string }>(app, cookie, "groups/create", {
    name: "Launch team",
    botIds: [researcher.id, writer.id, support.id],
  });
  const routine = await rpc<{ id: string }>(app, cookie, "routines/create", {
    botId: researcher.id,
    name: "Weekly fixture review",
    prompt: "Review the fixture launch notes and summarize the open questions.",
    crons: ["0 9 * * 1"],
    timezone: "UTC",
    active: true,
    notify: true,
  });

  const botThread = await prisma.thread.findUniqueOrThrow({ where: { botId: researcher.id } });
  const groupThread = await prisma.thread.findUniqueOrThrow({ where: { groupId: group.id } });
  await seedExchange(prisma, botThread, {
    botId: researcher.id,
    question: "Summarize the fixture launch checklist.",
    ask: { text: "Which checklist should I use?", answer: "The launch checklist." },
    reply: "The fixture workspace is ready.",
  });
  await seedRoutineResult(prisma, botThread, researcher.id, routine.id);
  const supportThread = await prisma.thread.findUniqueOrThrow({ where: { botId: support.id } });
  await seedFailedRun(prisma, supportThread, support.id);
  const sharing = await seedSharedBots(app, cookie, prisma, writer.id);
  const { teammate, teammateId, ...shared } = sharing;
  // The teammate joins the group and asks Writer, shared with her, before the user's own exchange.
  await rpc(app, cookie, "groups/update", { groupId: group.id, userIds: [teammateId] });
  await seedExchange(prisma, groupThread, {
    botId: writer.id,
    authorId: teammateId,
    question: "I'll take the press quote.",
    reply: "Here's a tighter quote for the release.",
  });
  await seedExchange(prisma, groupThread, {
    botId: writer.id,
    question: "Coordinate the fixture launch plan.",
    reply: "The fixture launch plan is ready.",
    widget: true,
  });
  await seedImageStacks(app, cookie, prisma, botThread, researcher.id);
  // A group the teammate created with the user: its settings are hers to change.
  const { userId } = await rpc<{ userId: string }>(app, cookie, "me");
  const memberGroup = await rpc<{ id: string }>(
    app,
    teammate,
    "groups/create",
    { name: "Release crew", botIds: [shared.sharedBotId], userIds: [userId] },
    sharing.spaceId,
  );

  return {
    botId: researcher.id,
    failedBotId: support.id,
    groupId: group.id,
    memberGroupId: memberGroup.id,
    routineId: routine.id,
    ...shared,
  };
}

/** A message whose run failed with a long error, the newest outcome of the thread. */
async function seedFailedRun(prisma: PrismaClient, thread: FixtureThread, botId: string) {
  const question = await createThreadMessage(prisma, {
    threadId: thread.id,
    role: "user",
    feedBotId: botId,
    blocks: [{ kind: "text", text: "Draft the reply to the refund request." }],
  });
  const task = await prisma.task.create({
    data: {
      spaceId: thread.spaceId,
      userId: thread.userId,
      botId,
      threadId: thread.id,
      prompt: "Draft the reply to the refund request.",
      status: "failed",
    },
  });
  await prisma.run.create({
    data: {
      spaceId: thread.spaceId,
      userId: thread.userId,
      botId,
      threadId: thread.id,
      taskId: task.id,
      status: "failed",
      trigger: "user",
      modelProvider: "scripted",
      modelId: "scripted",
      sourceMessageId: question.id,
      error:
        "The model provider rejected the request: the conversation exceeds the context window of the selected model, so the reply could not be generated. Shorten the conversation or choose a model with a larger context window and try again.",
      startedAt: new Date(Date.now() - 2_000),
      completedAt: new Date(),
    },
  });
}

/** A completed run of "Weekly fixture review", its final words shown in the bot's thread. */
async function seedRoutineResult(
  prisma: PrismaClient,
  thread: FixtureThread,
  botId: string,
  routineId: string,
) {
  const task = await prisma.task.create({
    data: {
      spaceId: thread.spaceId,
      userId: thread.userId,
      botId,
      threadId: thread.id,
      prompt: "Review the fixture launch notes and summarize the open questions.",
      status: "completed",
    },
  });
  const run = await prisma.run.create({
    data: {
      spaceId: thread.spaceId,
      userId: thread.userId,
      botId,
      threadId: thread.id,
      taskId: task.id,
      routineId,
      status: "completed",
      trigger: "routine",
      modelProvider: "scripted",
      modelId: "scripted",
      startedAt: new Date(Date.now() - 2_000),
      completedAt: new Date(),
    },
  });
  const model = { provider: "scripted", id: "scripted" };
  const started = {
    routineId,
    name: "Weekly fixture review",
    scheduledAt: new Date().toISOString(),
  };
  await prisma.$transaction(async (tx) => {
    const sessionId = await openRoutineSessionInTransaction(
      tx,
      { id: run.id, spaceId: thread.spaceId, threadId: thread.id, botId },
      { ...started, trigger: "routine", model, notify: true },
    );
    await appendSessionEntryInTransaction(tx, {
      type: "run.started",
      sessionId,
      botId,
      runId: run.id,
      payload: { trigger: { kind: "routine", ...started }, model, effort: null },
    });
    await appendRunFinishedInTransaction(
      tx,
      run.id,
      { status: "completed" },
      {
        usage: { inputTokens: 1520, outputTokens: 96 },
        result: "Two open questions remain on the fixture launch.",
      },
    );
  });
}

/**
 * A teammate joins the Space and shares "Release notes" with everyone in it: the screenshot user
 * then has their own thread with it, where a run saved for the team and a declared MCP server
 * asks to be added. The screenshot user shares Writer with the teammate in turn, with a skill and
 * an app, and Writer keeps a team memory. Each shares a key with the other.
 */
async function seedSharedBots(app: App, cookie: string, prisma: PrismaClient, writerId: string) {
  const { spaceId, userId } = await rpc<{ spaceId: string; userId: string }>(app, cookie, "me");
  const teammateEmail = "mobile-screenshots-teammate@example.test";
  const { invitations } = await rpc<{ invitations: Array<{ id: string }> }>(
    app,
    cookie,
    "spaces/createInvite",
    { spaceId, emails: [teammateEmail] },
  );
  const teammate = await signup(app, teammateEmail, "Grace Hopper");
  await rpc(app, teammate, "spaces/acceptInvite", { token: invitations[0]!.id });
  const releaseNotes = await rpc<{ id: string }>(
    app,
    teammate,
    "bots/create",
    {
      name: "Release notes",
      title: "Weekly release notes",
      description: "Drafts the release notes from merged work.",
      instructions: "Draft clear release notes.",
      notifyOnFinish: true,
    },
    spaceId,
  );
  await rpc(
    app,
    teammate,
    "bots/share",
    { botId: releaseNotes.id, visibility: "space", userIds: [] },
    spaceId,
  );
  // Its dedicated computer is up, as when the screenshot user's run uses it.
  await rpc(app, teammate, "computer/boot", { botId: releaseNotes.id }, spaceId);
  // Listing the roster gives the screenshot user their own thread with the shared bot.
  await rpc(app, cookie, "bots/list");
  const memberThread = await prisma.thread.findFirstOrThrow({
    where: { memberBotId: releaseNotes.id, userId },
  });
  await seedExchange(prisma, memberThread, {
    botId: releaseNotes.id,
    question: "When do release notes go out?",
    cards: [
      {
        kind: "app_connect",
        connectorId: "mcp",
        provider: "mcp-linear",
        name: "Linear",
        description: "Issues and projects for the release.",
        logo: null,
        status: "pending",
      },
    ],
    reply: "On Thursdays. I'll remember that for the team.",
    teamFacts: ["Release notes go out on Thursdays"],
  });

  const { userId: teammateId } = await rpc<{ userId: string }>(app, teammate, "me");
  const skill = await rpc<{ id: string }>(app, cookie, "agentSkills/create", {
    name: "changelog",
    description: "Write the changelog from merged work.",
    body: "Steps",
  });
  const gmail = await rpc<{ connectionId: string }>(app, cookie, "connections/begin", {
    connectorId: "composio",
    provider: "GMAIL",
    displayName: "Gmail",
  });
  await rpc(app, cookie, "connections/complete", { connectionId: gmail.connectionId });
  await rpc(app, cookie, "bots/share", {
    botId: writerId,
    visibility: "people",
    userIds: [teammateId],
    connectors: [{ kind: "app", connectorId: "composio", provider: "GMAIL" }],
  });
  await rpc(app, cookie, "agentSkills/setAccess", {
    skillId: skill.id,
    bots: [{ botId: writerId, enabled: true }],
  });
  // Writer saved the screenshot user's key, shared with the teammate; the teammate shares one back.
  await prisma.botSecret.updateMany({ where: { userId, spaceId }, data: { botId: writerId } });
  await rpc(app, cookie, "vault/share", {
    name: "example_api",
    userIds: [teammateId],
    space: false,
  });
  await rpc(
    app,
    teammate,
    "vault/put",
    {
      name: "release_api",
      origin: "https://releases.example.test",
      auth: { type: "bearer" },
      value: "fake-fixture-teammate-key",
    },
    spaceId,
  );
  await rpc(
    app,
    teammate,
    "vault/share",
    { name: "release_api", userIds: [userId], space: false },
    spaceId,
  );
  await prisma.memoryDocument.create({
    data: {
      spaceId,
      userId,
      botId: writerId,
      scope: "team",
      path: "MEMORY.md",
      content: "- Drafts go to the launch channel before noon.",
    },
  });
  return { sharedBotId: releaseNotes.id, shareBotId: writerId, teammate, teammateId, spaceId };
}

type FixtureThread = {
  id: string;
  spaceId: string;
  userId: string;
  sessionId: string;
  groupId: string | null;
};

async function seedExchange(
  prisma: PrismaClient,
  thread: FixtureThread,
  exchange: {
    botId: string;
    /** Another person of a group who asks, the run then answering them. */
    authorId?: string;
    question: string;
    ask?: { text: string; answer: string };
    reply: string;
    widget?: boolean;
    /** Cards the thread shows before the reply, such as an app the bot needs. */
    cards?: MessageBlock[];
    /** Saved for the team after the reply, as a shared bot's `remember` does. */
    teamFacts?: string[];
  },
) {
  const question = await createThreadMessage(prisma, {
    threadId: thread.id,
    role: "user",
    feedBotId: exchange.botId,
    blocks: [{ kind: "text", text: exchange.question }],
    authorId: exchange.authorId,
  });
  const userId = exchange.authorId ?? thread.userId;
  const task = await prisma.task.create({
    data: {
      spaceId: thread.spaceId,
      userId,
      botId: exchange.botId,
      threadId: thread.id,
      prompt: exchange.question,
      status: "completed",
    },
  });
  const run = await prisma.run.create({
    data: {
      spaceId: thread.spaceId,
      userId,
      botId: exchange.botId,
      threadId: thread.id,
      taskId: task.id,
      status: "completed",
      trigger: "user",
      modelProvider: "scripted",
      modelId: "scripted",
      sourceMessageId: question.id,
      startedAt: new Date(Date.now() - 2_000),
      completedAt: new Date(),
    },
  });
  const append = (entry: Pick<SessionEntry, "type" | "payload">) =>
    prisma.$transaction((tx) =>
      appendSessionEntryInTransaction(tx, {
        ...entry,
        sessionId: thread.sessionId as SessionId,
        botId: exchange.botId,
        runId: run.id,
      } as SessionEntryDraft),
    );
  await append({
    type: "run.started",
    payload: {
      trigger: { kind: "message", entryId: question.id as EntryId },
      model: { provider: "scripted", id: "scripted" },
      effort: null,
    },
  });
  const publish = (blocks: MessageBlock[]) =>
    prisma.$transaction((tx) =>
      createBotMessageInTransaction(tx, {
        threadId: thread.id,
        botId: exchange.botId,
        runId: run.id,
        blocks,
      }),
    );
  if (exchange.ask) {
    const askId = await publish([{ kind: "ask", text: exchange.ask.text }]);
    await createThreadMessage(prisma, {
      threadId: thread.id,
      role: "user",
      feedBotId: exchange.botId,
      blocks: [{ kind: "text", text: exchange.ask.answer }],
      replyToMessageId: askId,
      replyQuote: exchange.ask.text,
    });
  }
  if (exchange.widget) {
    const bytes = new TextEncoder().encode(
      `<div class="stack"><h1>Launch checklist</h1><div class="grid"><div class="card stat"><div class="value">3</div><div class="label">Ready to launch</div></div><div class="card"><span class="badge">On track</span><p>Research, writing and support are ready.</p></div></div><button class="button" onclick="this.textContent='Reviewed'">Review checklist</button></div>`,
    );
    const store = new LocalArtifactStore(DATA_DIR);
    const stored = await store.put(
      { name: "launch-checklist.html", mimeType: "text/html", bytes },
      {
        operationId: run.id,
        traceId: run.id,
        spaceId: thread.spaceId,
        userId: thread.userId,
        botId: exchange.botId,
        signal: new AbortController().signal,
      },
    );
    const artifact = await prisma.artifact.create({
      data: {
        spaceId: thread.spaceId,
        userId: thread.userId,
        botId: exchange.botId,
        groupId: thread.groupId,
        runId: run.id,
        name: "launch-checklist.html",
        mimeType: "text/html",
        size: bytes.byteLength,
        hash: stored.hash,
        storageKey: stored.id,
        isWidget: true,
      },
    });
    await publish([{ kind: "widget", title: "Launch checklist", artifactId: artifact.id }]);
  }
  for (const card of exchange.cards ?? []) await publish([card]);
  await publish([{ kind: "text", text: exchange.reply }]);
  if (exchange.teamFacts) {
    await append({ type: "memory.revised", payload: { facts: exchange.teamFacts, team: true } });
  }
  await append({
    type: "run.finished",
    payload: { status: "completed", usage: { inputTokens: 1840, outputTokens: 212 } },
  });
}

/** Screenshots and a road trip's photos as the stacks the mobile thread draws, a few seconds apart. */
async function seedImageStacks(
  app: App,
  cookie: string,
  prisma: PrismaClient,
  thread: FixtureThread,
  botId: string,
) {
  const start = Date.now() - 40 * 60_000;
  await prisma.sessionEntry.updateMany({
    where: { sessionId: thread.sessionId },
    data: { createdAt: new Date(start - 60_000) },
  });
  const stamp = (id: string, seconds: number) =>
    prisma.sessionEntry.update({
      where: { id },
      data: { createdAt: new Date(start + seconds * 1000) },
    });
  const user = async (seconds: number, blocks: MessageBlock[]) => {
    const entry = await createThreadMessage(prisma, {
      threadId: thread.id,
      role: "user",
      feedBotId: botId,
      blocks,
    });
    await stamp(entry.id, seconds);
  };
  const bot = async (seconds: number, blocks: MessageBlock[]) => {
    const id = await prisma.$transaction((tx) =>
      createBotMessageInTransaction(tx, { threadId: thread.id, botId, blocks }),
    );
    await stamp(id!, seconds);
  };
  const upload = async (name: string, bytes: Buffer) =>
    messageBlockForArtifact(
      await rpc<{ id: string; name: string; mimeType: string; size: number }>(
        app,
        cookie,
        "artifacts/create",
        { botId, name, mimeType: "image/png", contentBase64: bytes.toString("base64") },
      ),
    );
  const screenshots = await Promise.all(
    [0, 1, 2, 3].map((n) => upload(`screenshot-${n + 1}.png`, fakeScreenshot(n))),
  );
  const photos = await Promise.all(
    Array.from({ length: 15 }, (_, n) => upload(`photo-${n + 1}.png`, fakePhoto(n))),
  );

  await user(0, [{ kind: "text", text: "Find me a good deal on an official MagSafe charger" }]);
  await bot(5, [{ kind: "text", text: "Comparing prices at Apple and two retailers." }]);
  for (const [n, block] of screenshots.slice(0, 3).entries()) await bot(15 + n * 7, [block]);
  await bot(40, [{ kind: "text", text: "The cheapest is €26.81, instead of €49." }]);

  await user(900, [
    { kind: "text", text: "Our road trip, pick the 10 best" },
    ...photos.slice(0, 4),
  ]);
  await user(908, photos.slice(4, 8));
  await user(915, photos.slice(8, 12));
  await user(922, photos.slice(12));

  await bot(1800, [screenshots[3]!]);
}

/** A 1280x900 web page: grey bars and blocks on a neutral background, no brand. */
function fakeScreenshot(n: number) {
  const blocks = [
    [0, 0, 1280, 72, 226],
    [96, 140, 560, 520, 214],
    [680, 140, 1184, 190, 200],
    [680, 220, 1000, 262, 232],
    [680, 330, 1184, 600, 238 - n * 6],
    [96, 700, 1184, 760, 220],
  ];
  return png(1280, 900, (x, y) => {
    const grey = blocks.find(([x0, y0, x1, y1]) => x >= x0! && x < x1! && y >= y0! && y < y1!);
    const v = grey ? grey[4]! : 246;
    return [v, v, v + 2];
  });
}

/** A 1600x1200 landscape (a couple of portraits): a hue-shifted gradient with a simple sun. */
function fakePhoto(n: number) {
  const [width, height] = n === 3 || n === 9 ? [1200, 1600] : [1600, 1200];
  const hue = (n * 47) % 360;
  const channel = (offset: number, level: number) => {
    const k = (offset + hue / 60) % 6;
    return Math.round(255 * level * (1 - Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return png(width, height, (x, y) => {
    const t = y / height;
    const sun = (x - width * 0.7) ** 2 + (y - height * 0.3) ** 2 < (width * 0.1) ** 2;
    if (sun) return [255, 244, 214];
    const level = 1 - 0.55 * t;
    return [channel(5, level), channel(3, level), channel(1, level)];
  });
}

function png(width: number, height: number, pixel: (x: number, y: number) => number[]) {
  const stride = width * 3 + 1;
  const rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) rows.set(pixel(x, y), y * stride + 1 + x * 3);
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function signup(app: App, email = EMAIL, name = "Screenshot User") {
  const response = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: WEB_ORIGIN },
    body: JSON.stringify({ email, password: PASSWORD, name }),
  });
  if (!response.ok) throw new Error(`Fixture signup failed with ${response.status}`);
  const cookie = sessionCookieHeader(response);
  if (!cookie) throw new Error("Fixture signup did not return a session cookie");
  return cookie;
}

async function rpc<T>(
  app: App,
  cookie: string,
  procedure: string,
  body: unknown = {},
  spaceId?: string,
): Promise<T> {
  const response = await app.request(`/rpc/${procedure}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      origin: WEB_ORIGIN,
      ...(spaceId ? { "x-tangow-space-id": spaceId } : {}),
    },
    body: JSON.stringify({ json: body }),
  });
  const text = await response.text();
  const parsed = JSON.parse(text) as { json?: T; error?: { message?: string } };
  if (!response.ok || parsed.error) {
    throw new Error(`${procedure} ${response.status}: ${parsed.error?.message ?? text}`);
  }
  return parsed.json as T;
}

async function waitForHealth(url: string, timeoutMs: number) {
  const startedAt = Date.now();
  let lastError = "no response";
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Mobile screenshot API did not become ready: ${lastError}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
