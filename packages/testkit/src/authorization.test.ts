import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioEmulator, ScriptedVoiceProvider } from "@tangow/adapters";
import type { appContract, Space, SpaceNavigation } from "@tangow/contracts";
import { resolveScreenProxySecret } from "@tangow/core";
import { SCREEN_TARGET_ENDPOINT } from "@tangow/core/node/screen-capability";
import {
  claimEmptySpaceDeletionForMember,
  deleteEmptySpaceForMember,
  pauseRunForTakeover,
  releaseSpaceDeletionClaim,
  renewSpaceDeletionClaim,
} from "@tangow/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { createApp } from "../../../apps/api/src/app.ts";
import { addScreenProxyCapability } from "../../../apps/api/src/screen-proxy.ts";
import { sessionCookieHeader } from "./index.js";

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };
type AppHandles = Awaited<ReturnType<typeof createApp>>;
type RpcPath<T, Prefix extends string = ""> = T extends { "~orpc": unknown }
  ? Prefix
  : T extends object
    ? {
        [Key in keyof T & string]: RpcPath<T[Key], Prefix extends "" ? Key : `${Prefix}/${Key}`>;
      }[keyof T & string]
    : never;
type ProtectedRpcPath = Exclude<RpcPath<typeof appContract>, "health">;

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeWithDatabase = hasDb ? describe : describe.skip;

describeWithDatabase("API authorization and resource isolation", () => {
  let handles: AppHandles;
  let app: App;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dataDir = mkdtempSync(path.join(tmpdir(), "tangow-authz-"));

  beforeAll(async () => {
    const { createApp } = await import("../../../apps/api/src/app.ts");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      composio: new ComposioEmulator(),
      mcpStdioEnabled: true,
      mcpStdioAllowedCommands: ["/opt/notes-mcp"],
    });
    app = handles.app;
  });

  afterAll(async () => {
    await handles?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("rejects unauthenticated calls to every protected RPC family", async () => {
    const calls = exhaustiveProtectedCalls([
      ["me"],
      ["deployment/get"],
      ["deployment/update", { signupsEnabled: true }],
      ["updater/status"],
      ["updater/check", {}],
      ["updater/apply", {}],
      ["models/list"],
      ["models/credentials"],
      ["models/connect", { provider: "test", apiKey: "not-a-real-key" }],
      ["models/beginOAuth", { provider: "openai-codex" }],
      ["models/submitOAuthCode", { loginId: "missing-login", code: "fake-code" }],
      ["models/completeOAuth", { loginId: "missing-login" }],
      ["models/finishOAuth", { loginId: "missing-login" }],
      ["models/cancelOAuth", { loginId: "missing-login" }],
      ["models/setDefault", { provider: "test", modelId: "test/model" }],
      ["spaces/list"],
      ["spaces/create", { name: "Nope" }],
      ["spaces/rename", { spaceId: "missing-space", name: "Nope" }],
      ["spaces/remove", { spaceId: "missing-space" }],
      ["spaces/members", { spaceId: "missing-space" }],
      ["spaces/createInvite", { spaceId: "missing-space", emails: ["nobody@tangow.test"] }],
      ["spaces/revokeInvite", { spaceId: "missing-space", invitationId: "missing-invite" }],
      ["spaces/removeMember", { spaceId: "missing-space", userId: "missing-user" }],
      ["spaces/invitation", { token: "missing-token" }],
      ["spaces/acceptInvite", { token: "missing-token" }],
      ["bots/list"],
      ["bots/listArchived"],
      ["bots/get", { botId: "missing-bot" }],
      ["bots/create", botInput("Unauthenticated")],
      ["bots/duplicate", { botId: "missing-bot" }],
      ["bots/update", { botId: "missing-bot", name: "Nope" }],
      ["bots/archive", { botId: "missing-bot" }],
      ["bots/restore", { botId: "missing-bot" }],
      ["bots/remove", { botId: "missing-bot" }],
      ["bots/webhookSecret", { botId: "missing-bot" }],
      ["bots/rotateWebhookSecret", { botId: "missing-bot" }],
      ["bots/sharing", { botId: "missing-bot" }],
      ["bots/share", { botId: "missing-bot", visibility: "space", userIds: [] }],
      ["bots/declaredMcp", { botId: "missing-bot", serverId: "missing-server" }],
      ["bots/addDeclaredMcp", { botId: "missing-bot", serverId: "missing-server" }],
      ["groups/create", { name: "Nope", botIds: ["missing-a", "missing-b"] }],
      ["groups/list"],
      ["groups/get", { groupId: "missing-group" }],
      ["groups/update", { groupId: "missing-group", name: "Nope" }],
      ["groups/remove", { groupId: "missing-group" }],
      ["botSections/list"],
      ["botSections/create", { botId: "missing-bot", name: "Planning" }],
      ["botSections/update", { sectionId: "missing-section", name: "Planning" }],
      ["threads/get", { botId: "missing-bot" }],
      ["threads/get", { groupId: "missing-group" }],
      ["threads/messages", { botId: "missing-bot", before: 1 }],
      ["threads/subscribe", { botId: "missing-bot", cursor: -1 }],
      ["threads/send", { botId: "missing-bot", text: "Nope" }],
      ["threads/send", { groupId: "missing-group", text: "Nope" }],
      ["threads/stop", { botId: "missing-bot" }],
      ["threads/clear", { botId: "missing-bot" }],
      ["threads/followUp", { botId: "missing-bot", text: "Nope" }],
      [
        "threads/answer",
        {
          botId: "missing-bot",
          runId: "missing-run",
          messageId: "missing-message",
          answer: "Nope",
        },
      ],
      ["threads/markRead", { botId: "missing-bot" }],
      ["threads/markUnread", { botId: "missing-bot" }],
      ["computer/status", { botId: "missing-bot" }],
      ["computer/boot", { botId: "missing-bot" }],
      ["computer/stop", { botId: "missing-bot" }],
      ["computer/takeover", { botId: "missing-bot" }],
      ["computer/release", { botId: "missing-bot" }],
      ["computer/input", { botId: "missing-bot", kind: "key", payload: { key: "A" } }],
      ["computer/files", { botId: "missing-bot", path: "/" }],
      ["computer/readFile", { botId: "missing-bot", path: "MEMORY.md" }],
      ["computer/screenUrl", { botId: "missing-bot" }],
      ["computer/heartbeat", { botId: "missing-bot" }],
      ["memory/list", {}],
      ["memory/update", { documentId: "missing-memory", content: "Nope" }],
      ["memory/exportMarkdown", {}],
      ["routines/list", { botId: "missing-bot" }],
      ["routines/create", routineInput("missing-bot")],
      ["routines/update", { routineId: "missing-routine", name: "Nope" }],
      ["routines/remove", { routineId: "missing-routine" }],
      ["routines/testRun", { routineId: "missing-routine" }],
      ["scratchpad/list", { botId: "missing-bot" }],
      ["scratchpad/create", { botId: "missing-bot", title: "Nope" }],
      ["scratchpad/update", { itemId: "missing-item", title: "Nope" }],
      ["scratchpad/remove", { itemId: "missing-item" }],
      ["skills/list", { botId: "missing-bot" }],
      ["skills/get", { skillId: "missing-skill" }],
      ["skills/start", { botId: "missing-bot", goal: "Demonstrate export" }],
      [
        "skills/appendEvent",
        {
          skillId: "missing-skill",
          event: { at: new Date().toISOString(), kind: "key", key: "a" },
        },
      ],
      ["skills/snapshot", { skillId: "missing-skill" }],
      ["skills/stop", { skillId: "missing-skill" }],
      ["skills/updateDraft", { skillId: "missing-skill", playbook: skillPlaybookInput() }],
      ["skills/save", { skillId: "missing-skill" }],
      ["skills/testRun", { skillId: "missing-skill" }],
      ["skills/remove", { skillId: "missing-skill" }],
      ["agentSkills/list"],
      ["agentSkills/get", { skillId: "missing-skill" }],
      ["agentSkills/create", { name: "Unauthenticated", description: "Nope", body: "Steps" }],
      ["agentSkills/update", { skillId: "missing-skill", description: "Nope" }],
      ["agentSkills/remove", { skillId: "missing-skill" }],
      ["capabilities/list"],
      ["capabilities/install", capabilityInput("Unauthenticated")],
      ["capabilities/remove", { id: "missing-capability" }],
      ["connections/catalog", {}],
      ["connections/list"],
      ["connections/begin", connectionInput("Unauthenticated")],
      ["connections/complete", { connectionId: "missing-connection" }],
      ["connections/revoke", { connectionId: "missing-connection" }],
      ["approvalRules/list"],
      [
        "approvalRules/set",
        { effect: "require_approval", matchKind: "category", matchValue: "email" },
      ],
      ["approvalRules/remove", { id: "missing-rule" }],
      ["artifacts/list", { botId: "missing-bot" }],
      ["usage/breakdown", { period: "30d" }],
      ["export/bot", { botId: "missing-bot" }],
      ["notifications/registerPush", { token: "ExponentPushToken[not-real]" }],
      ["search/query", { q: "anything" }],
      ["voice/catalog"],
      ["voice/status"],
      ["voice/credentials"],
      ["voice/connect", { provider: "elevenlabs", apiKey: "not-a-real-key" }],
      ["voice/disconnect", { provider: "elevenlabs" }],
      ["voice/setVoice", { voiceId: "missing-voice" }],
      ["voice/voices", {}],
      ["voice/prepare", { text: "Nope" }],
    ]);

    const results = await Promise.all(
      calls.map(async ([procedure, input]) => ({
        procedure,
        response: await raw(app, "", procedure, input),
      })),
    );

    for (const { procedure, response } of results) {
      expect(response.status, procedure).toBe(401);
    }
  });

  it("prevents one user from reading or mutating another user's resources", async () => {
    const owner = await signup(app, `owner-authz-${stamp}@tangow.test`, "Authorization Owner");
    const intruder = await signup(
      app,
      `intruder-authz-${stamp}@tangow.test`,
      "Authorization Intruder",
    );
    const ownerActor = await rpc<Actor>(app, owner, "me");
    const intruderActor = await rpc<Actor>(app, intruder, "me");
    expect(ownerActor.spaceId).not.toBe(intruderActor.spaceId);

    const ownerBot = await rpc<Bot>(app, owner, "bots/create", botInput("Owner Bot"));
    const intruderBot = await rpc<Bot>(app, intruder, "bots/create", botInput("Intruder Bot"));
    const ownerRoutine = await rpc<{ id: string }>(
      app,
      owner,
      "routines/create",
      routineInput(ownerBot.id),
    );
    const ownerScratchpad = await rpc<{ id: string }>(app, owner, "scratchpad/create", {
      botId: ownerBot.id,
      title: "Owner open work",
      notes: "private",
    });
    const ownerSkill = await handles.prisma.taughtSkill.create({
      data: {
        spaceId: ownerActor.spaceId,
        botId: ownerBot.id,
        userId: ownerActor.userId,
        name: "Owner Skill",
        goal: "Owner-only skill",
        status: "saved",
        playbook: skillPlaybookInput(),
        recording: { events: [], snapshots: [] },
      },
    });
    const ownerAgentSkill = await rpc<{ id: string }>(app, owner, "agentSkills/create", {
      name: "Owner Recipe",
      description: "Owner-only shared skill",
      body: "1. Do the private thing.",
    });
    const ownerCapability = await rpc<{ id: string }>(
      app,
      owner,
      "capabilities/install",
      capabilityInput("Owner Capability"),
    );
    const ownerConnection = await rpc<{ connectionId: string }>(
      app,
      owner,
      "connections/begin",
      connectionInput("Owner Connection"),
    );
    const ownerMemory = await handles.prisma.memoryDocument.create({
      data: {
        spaceId: ownerActor.spaceId,
        userId: ownerActor.userId,
        botId: ownerBot.id,
        scope: "bot",
        path: "PRIVATE.md",
        content: "owner-only-memory",
      },
    });
    const ownerArtifact = await handles.prisma.artifact.create({
      data: {
        spaceId: ownerActor.spaceId,
        userId: ownerActor.userId,
        botId: ownerBot.id,
        name: "owner-secret.txt",
        mimeType: "text/plain",
        size: 17,
        hash: "sha256:not-a-real-hash",
        storageKey: "test/owner-secret.txt",
      },
    });
    const ownerThread = await handles.prisma.thread.findUniqueOrThrow({
      where: { botId: ownerBot.id },
    });
    const ownerTask = await handles.prisma.task.create({
      data: {
        spaceId: ownerActor.spaceId,
        userId: ownerActor.userId,
        botId: ownerBot.id,
        threadId: ownerThread.id,
        prompt: "owner prompt",
        status: "waiting_input",
      },
    });
    const ownerRun = await handles.prisma.run.create({
      data: {
        spaceId: ownerActor.spaceId,
        userId: ownerActor.userId,
        botId: ownerBot.id,
        threadId: ownerThread.id,
        taskId: ownerTask.id,
        status: "waiting_input",
        trigger: "user",
      },
    });

    const botIdCalls: Array<[string, unknown]> = [
      ["bots/get", { botId: ownerBot.id }],
      ["bots/duplicate", { botId: ownerBot.id }],
      ["bots/update", { botId: ownerBot.id, name: "Stolen Bot" }],
      ["bots/archive", { botId: ownerBot.id }],
      ["bots/restore", { botId: ownerBot.id }],
      ["bots/webhookSecret", { botId: ownerBot.id }],
      ["bots/rotateWebhookSecret", { botId: ownerBot.id }],
      ["threads/get", { botId: ownerBot.id }],
      ["threads/messages", { botId: ownerBot.id, before: 1 }],
      ["threads/subscribe", { botId: ownerBot.id, cursor: -1 }],
      ["threads/send", { botId: ownerBot.id, text: "intruder message" }],
      ["threads/send", { botId: ownerBot.id, artifactIds: [ownerArtifact.id] }],
      ["threads/stop", { botId: ownerBot.id }],
      ["threads/clear", { botId: ownerBot.id }],
      ["threads/followUp", { botId: ownerBot.id, text: "intruder follow-up" }],
      [
        "threads/answer",
        {
          botId: ownerBot.id,
          runId: ownerRun.id,
          messageId: "missing-message",
          answer: "intruder answer",
        },
      ],
      ["threads/markRead", { botId: ownerBot.id }],
      ["threads/markUnread", { botId: ownerBot.id }],
      ["computer/status", { botId: ownerBot.id }],
      ["computer/boot", { botId: ownerBot.id }],
      ["computer/stop", { botId: ownerBot.id }],
      ["computer/takeover", { botId: ownerBot.id }],
      ["computer/release", { botId: ownerBot.id }],
      ["computer/input", { botId: ownerBot.id, kind: "key", payload: { key: "A" } }],
      ["computer/files", { botId: ownerBot.id, path: "/" }],
      ["computer/readFile", { botId: ownerBot.id, path: "PRIVATE.md" }],
      ["computer/screenUrl", { botId: ownerBot.id }],
      ["computer/heartbeat", { botId: ownerBot.id }],
      ["routines/list", { botId: ownerBot.id }],
      ["routines/create", routineInput(ownerBot.id)],
      ["scratchpad/list", { botId: ownerBot.id }],
      ["scratchpad/create", { botId: ownerBot.id, title: "Stolen item" }],
      ["skills/list", { botId: ownerBot.id }],
      ["skills/start", { botId: ownerBot.id, goal: "Intruder demo" }],
      ["artifacts/list", { botId: ownerBot.id }],
      [
        "artifacts/create",
        {
          botId: ownerBot.id,
          name: "intruder.txt",
          mimeType: "text/plain",
          contentBase64: Buffer.from("nope").toString("base64"),
        },
      ],
      ["artifacts/get", { botId: ownerBot.id, artifactId: ownerArtifact.id }],
      ["export/bot", { botId: ownerBot.id }],
      ["voice/prepare", { text: "stolen speech", botId: ownerBot.id }],
    ];
    await Promise.all(
      botIdCalls.map(([procedure, input]) => expectDenied(app, intruder, procedure, input)),
    );

    const ownerBot2 = await rpc<Bot>(app, owner, "bots/create", botInput("Owner Bot Two"));
    const ownerGroup = await rpc<{ id: string }>(app, owner, "groups/create", {
      name: "Owner Group",
      botIds: [ownerBot.id, ownerBot2.id],
    });
    const groupCalls: Array<[string, unknown]> = [
      ["groups/get", { groupId: ownerGroup.id }],
      ["groups/update", { groupId: ownerGroup.id, name: "Stolen Group" }],
      ["groups/remove", { groupId: ownerGroup.id }],
      ["threads/get", { groupId: ownerGroup.id }],
      ["threads/messages", { groupId: ownerGroup.id, before: 1 }],
      ["threads/subscribe", { groupId: ownerGroup.id, cursor: -1 }],
      ["threads/send", { groupId: ownerGroup.id, text: "intruder group message" }],
      ["threads/stop", { groupId: ownerGroup.id }],
      ["threads/followUp", { groupId: ownerGroup.id, text: "intruder follow-up" }],
      ["threads/markRead", { groupId: ownerGroup.id }],
      ["threads/markUnread", { groupId: ownerGroup.id }],
    ];
    await Promise.all(
      groupCalls.map(([procedure, input]) => expectDenied(app, intruder, procedure, input)),
    );

    // A caller cannot pair their own bot with another workspace's run ID.
    await expectDenied(app, intruder, "threads/answer", {
      botId: intruderBot.id,
      runId: ownerRun.id,
      messageId: "missing-message",
      answer: "mixed-resource attack",
    });

    const resourceIdCalls = [
      ["routines/update", { routineId: ownerRoutine.id, name: "Stolen Routine" }],
      ["routines/remove", { routineId: ownerRoutine.id }],
      ["routines/testRun", { routineId: ownerRoutine.id }],
      ["scratchpad/update", { itemId: ownerScratchpad.id, title: "Stolen item" }],
      ["scratchpad/remove", { itemId: ownerScratchpad.id }],
      ["skills/get", { skillId: ownerSkill.id }],
      [
        "skills/appendEvent",
        { skillId: ownerSkill.id, event: { at: new Date().toISOString(), kind: "key", key: "x" } },
      ],
      ["skills/snapshot", { skillId: ownerSkill.id }],
      ["skills/stop", { skillId: ownerSkill.id }],
      ["skills/updateDraft", { skillId: ownerSkill.id, playbook: skillPlaybookInput() }],
      ["skills/save", { skillId: ownerSkill.id }],
      ["skills/testRun", { skillId: ownerSkill.id }],
      ["skills/remove", { skillId: ownerSkill.id }],
      ["agentSkills/get", { skillId: ownerAgentSkill.id }],
      ["agentSkills/update", { skillId: ownerAgentSkill.id, description: "Stolen" }],
      ["agentSkills/remove", { skillId: ownerAgentSkill.id }],
      ["memory/update", { documentId: ownerMemory.id, content: "stolen" }],
      ["connections/complete", { connectionId: ownerConnection.connectionId }],
    ] satisfies Array<[string, unknown]>;
    await Promise.all(
      resourceIdCalls.map(([procedure, input]) => expectDenied(app, intruder, procedure, input)),
    );

    expect(await rpc<unknown[]>(app, intruder, "memory/list", { botId: ownerBot.id })).toEqual([]);
    expect(await rpc<string>(app, intruder, "memory/exportMarkdown", { botId: ownerBot.id })).toBe(
      "",
    );
    expect(await rpc<Array<{ id: string }>>(app, intruder, "capabilities/list")).not.toContainEqual(
      expect.objectContaining({ id: ownerCapability.id }),
    );
    expect(await rpc<Array<{ id: string }>>(app, intruder, "agentSkills/list")).not.toContainEqual(
      expect.objectContaining({ id: ownerAgentSkill.id }),
    );
    expect(await rpc<Array<{ id: string }>>(app, intruder, "connections/list")).not.toContainEqual(
      expect.objectContaining({ id: ownerConnection.connectionId }),
    );
    expect(
      await rpc<{ hits: unknown[] }>(app, intruder, "search/query", { q: ownerBot.name }),
    ).toEqual({ hits: [] });

    // These endpoints are deliberately idempotent for unknown IDs. Success must not mutate
    // a row in a different workspace or disclose whether it exists.
    await rpc(app, intruder, "capabilities/remove", { id: ownerCapability.id });
    await rpc(app, intruder, "connections/revoke", {
      connectionId: ownerConnection.connectionId,
    });
    expect(
      await handles.prisma.capabilityInstall.findUnique({ where: { id: ownerCapability.id } }),
    ).not.toBeNull();
    expect(
      await handles.prisma.connection.findUniqueOrThrow({
        where: { id: ownerConnection.connectionId },
      }),
    ).toMatchObject({ status: "connected", userId: ownerActor.userId });

    const ownerBotAfter = await handles.prisma.bot.findUniqueOrThrow({
      where: { id: ownerBot.id },
    });
    expect(ownerBotAfter.name).toBe("Owner Bot");
    expect(
      await handles.prisma.routine.findUniqueOrThrow({ where: { id: ownerRoutine.id } }),
    ).toMatchObject({ name: "Owner Routine" });
    expect(
      await handles.prisma.scratchpadItem.findUniqueOrThrow({ where: { id: ownerScratchpad.id } }),
    ).toMatchObject({ title: "Owner open work", notes: "private" });
    expect(
      await handles.prisma.memoryDocument.findUniqueOrThrow({ where: { id: ownerMemory.id } }),
    ).toMatchObject({ content: "owner-only-memory" });

    // Destructive bot removal is checked last so an authorization regression is unmistakable.
    await expectDenied(app, intruder, "bots/remove", {
      botId: ownerBot.id,
      deleteMemories: true,
    });
    expect(await handles.prisma.bot.findUnique({ where: { id: ownerBot.id } })).not.toBeNull();
  });

  it("keeps approval rules private to each user in a shared Space", async () => {
    const owner = await signup(app, `approval-owner-${stamp}@tangow.test`, "Approval Owner");
    const member = await signup(app, `approval-member-${stamp}@tangow.test`, "Approval Member");
    const ownerActor = await rpc<Actor>(app, owner, "me");
    const memberActor = await rpc<Actor>(app, member, "me");

    await handles.prisma.member.deleteMany({ where: { userId: memberActor.userId } });
    await handles.prisma.member.create({
      data: {
        id: `approval-member-${stamp}`,
        organizationId: ownerActor.spaceId,
        userId: memberActor.userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    await handles.prisma.spaceMember.create({
      data: {
        id: `approval-space-member-${stamp}`,
        spaceId: ownerActor.spaceId,
        organizationId: ownerActor.spaceId,
        userId: memberActor.userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    const ownerRule = await rpc<{ id: string }>(app, owner, "approvalRules/set", {
      effect: "always_allow",
      matchKind: "tool",
      matchValue: "destination.write",
    });
    expect(await rpc<unknown[]>(app, member, "approvalRules/list")).toEqual([]);

    const memberRule = await rpc<{ id: string }>(app, member, "approvalRules/set", {
      effect: "require_approval",
      matchKind: "category",
      matchValue: "email",
    });
    expect(await rpc<Array<{ id: string }>>(app, owner, "approvalRules/list")).toEqual([
      expect.objectContaining({ id: ownerRule.id }),
    ]);
    expect(await rpc<Array<{ id: string }>>(app, member, "approvalRules/list")).toEqual([
      expect.objectContaining({ id: memberRule.id }),
    ]);

    await rpc(app, member, "approvalRules/remove", { id: ownerRule.id });
    expect(
      await handles.prisma.actionApprovalRule.findUnique({ where: { id: ownerRule.id } }),
    ).not.toBeNull();
  });

  it("keeps space data and computers behind the selected space boundary", async () => {
    const cookie = await signup(app, `spaces-${stamp}@tangow.test`, "Space Owner");
    const original = await rpc<Actor>(app, cookie, "me");
    const originalBot = await rpc<Bot>(app, cookie, "bots/create", botInput("Open source"));
    const support = await rpc<Space>(app, cookie, "spaces/create", {
      name: "Customer support",
    });
    const storedSpaces = await handles.prisma.space.findMany({
      where: { id: { in: [original.spaceId, support.id] } },
      select: { id: true, organizationId: true },
    });
    expect(new Set(storedSpaces.map((space) => space.organizationId))).toEqual(
      new Set([original.spaceId]),
    );
    const otherOrganizationId = `spaces-other-org-${stamp}`;
    const otherWorkspaceId = `spaces-other-workspace-${stamp}`;
    await handles.prisma.$transaction([
      handles.prisma.organization.create({
        data: {
          id: otherOrganizationId,
          name: "Other company",
          slug: otherOrganizationId,
          createdAt: new Date(),
        },
      }),
      handles.prisma.member.create({
        data: {
          id: `spaces-other-member-${stamp}`,
          organizationId: otherOrganizationId,
          userId: original.userId,
          role: "owner",
          createdAt: new Date(),
        },
      }),
      handles.prisma.space.create({
        data: {
          id: otherWorkspaceId,
          organizationId: otherOrganizationId,
          name: "Other company space",
        },
      }),
      handles.prisma.spaceMember.create({
        data: {
          id: `spaces-other-space-member-${stamp}`,
          spaceId: otherWorkspaceId,
          organizationId: otherOrganizationId,
          userId: original.userId,
          createdAt: new Date(),
        },
      }),
    ]);

    const supportMe = await rpc<Actor>(app, cookie, "me", {}, support.id);
    expect(supportMe.spaceId).toBe(support.id);
    const supportBot = await rpc<Bot>(app, cookie, "bots/create", botInput("Support"), support.id);

    expect(await rpc<Array<{ id: string }>>(app, cookie, "bots/list")).toEqual([
      expect.objectContaining({ id: originalBot.id }),
    ]);
    expect(await rpc<Array<{ id: string }>>(app, cookie, "bots/list", {}, support.id)).toEqual([
      expect.objectContaining({ id: supportBot.id }),
    ]);
    await expectDenied(app, cookie, "bots/get", { botId: supportBot.id });
    await expectDenied(app, cookie, "bots/get", { botId: originalBot.id }, support.id);

    const navigation = await rpc<SpaceNavigation>(app, cookie, "spaces/list");
    expect(navigation.current).toEqual(
      expect.objectContaining({
        id: original.spaceId,
        bots: [expect.objectContaining({ id: originalBot.id })],
      }),
    );
    expect(navigation.spaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: original.spaceId,
          bots: [expect.objectContaining({ id: originalBot.id, notifyOnFinish: false })],
        }),
        expect.objectContaining({
          id: support.id,
          name: "Customer support",
          bots: [expect.objectContaining({ id: supportBot.id, notifyOnFinish: false })],
        }),
      ]),
    );
    const supportNavigation = await rpc<SpaceNavigation>(
      app,
      cookie,
      "spaces/list",
      {},
      support.id,
    );
    expect(supportNavigation.current).toEqual(
      expect.objectContaining({
        id: support.id,
        bots: [expect.objectContaining({ id: supportBot.id })],
      }),
    );
    const otherOrganizationNavigation = await rpc<SpaceNavigation>(
      app,
      cookie,
      "spaces/list",
      {},
      otherWorkspaceId,
    );
    expect(otherOrganizationNavigation.spaces.map((space) => space.id)).toEqual(
      navigation.spaces.map((space) => space.id),
    );
    expect(otherOrganizationNavigation.spaces.map((space) => space.id)).toContain(otherWorkspaceId);

    const storedBots = await handles.prisma.bot.findMany({
      where: { id: { in: [originalBot.id, supportBot.id] } },
      select: { id: true, spaceId: true, computerId: true },
    });
    const storedOriginal = storedBots.find((bot) => bot.id === originalBot.id);
    const storedSupport = storedBots.find((bot) => bot.id === supportBot.id);
    expect(storedOriginal?.spaceId).toBe(original.spaceId);
    expect(storedSupport?.spaceId).toBe(support.id);
    expect(storedOriginal?.computerId).not.toBe(storedSupport?.computerId);

    const intruder = await signup(app, `spaces-intruder-${stamp}@tangow.test`, "Intruder");
    // A Space the caller doesn't belong to resolves to their own Space, never to the requested one.
    const intruderActor = await rpc<Actor>(app, intruder, "me", {}, support.id);
    expect(intruderActor.spaceId).not.toBe(support.id);
    expect(await rpc<Array<{ id: string }>>(app, intruder, "bots/list", {}, support.id)).toEqual(
      [],
    );
  });

  it("enforces the space limit across concurrent creation requests", async () => {
    const cookie = await signup(app, `space-limit-${stamp}@tangow.test`, "Space Limit");
    const actor = await rpc<Actor>(app, cookie, "me");
    const currentSpace = await handles.prisma.space.findUniqueOrThrow({
      where: { id: actor.spaceId },
      select: { organizationId: true },
    });
    const extraSpaces = Array.from({ length: 30 }, (_, index) => ({
      id: `limit-space-${stamp}-${index}`,
      organizationId: currentSpace.organizationId,
      name: `Limit space ${index}`,
      createdAt: new Date(),
    }));
    await handles.prisma.space.createMany({ data: extraSpaces });
    await handles.prisma.spaceMember.createMany({
      data: extraSpaces.map((space, index) => ({
        id: `limit-member-${stamp}-${index}`,
        spaceId: space.id,
        organizationId: space.organizationId,
        userId: actor.userId,
        createdAt: space.createdAt,
      })),
    });

    const results = await Promise.allSettled([
      rpc<Space>(app, cookie, "spaces/create", { name: "Concurrent A" }),
      rpc<Space>(app, cookie, "spaces/create", { name: "Concurrent B" }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(
      handles.prisma.spaceMember.count({
        where: { userId: actor.userId, organizationId: currentSpace.organizationId },
      }),
    ).resolves.toBe(32);
  });

  it("reuses provider credentials and copies their selections into a new Space", async () => {
    const cookie = await signup(app, `space-provider-copy-${stamp}@tangow.test`, "Provider Copy");
    const actor = await rpc<Actor>(app, cookie, "me");
    const model = await rpc<ModelCredential>(app, cookie, "models/connect", {
      provider: "copy-provider",
      apiKey: "fake-copy-model-key",
      label: "Copy provider",
      modelId: "copy/model",
    });
    const voice = await rpc<{ id: string; voiceId: string }>(app, cookie, "voice/connect", {
      provider: "scripted",
      apiKey: "fake-copy-voice-key",
    });

    const created = await rpc<Space>(app, cookie, "spaces/create", { name: "Copied defaults" });
    const [modelPreference, voicePreference] = await Promise.all([
      handles.prisma.spaceModelPreference.findUnique({
        where: {
          spaceId_userId_credentialId: {
            spaceId: created.id,
            userId: actor.userId,
            credentialId: model.id,
          },
        },
      }),
      handles.prisma.spaceVoicePreference.findUnique({
        where: {
          spaceId_userId_credentialId: {
            spaceId: created.id,
            userId: actor.userId,
            credentialId: voice.id,
          },
        },
      }),
    ]);

    expect(modelPreference).toMatchObject({ modelId: "copy/model", isDefault: true });
    expect(voicePreference).toMatchObject({ voiceId: voice.voiceId, isDefault: true });
    await rpc(
      app,
      cookie,
      "voice/setVoice",
      { provider: "scripted", voiceId: "space-specific-voice" },
      created.id,
    );
    await expect(
      handles.prisma.spaceVoicePreference.findUniqueOrThrow({
        where: {
          spaceId_userId_credentialId: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            credentialId: voice.id,
          },
        },
      }),
    ).resolves.toMatchObject({ voiceId: voice.voiceId, isDefault: true });
    await expect(
      handles.prisma.spaceVoicePreference.findUniqueOrThrow({
        where: {
          spaceId_userId_credentialId: {
            spaceId: created.id,
            userId: actor.userId,
            credentialId: voice.id,
          },
        },
      }),
    ).resolves.toMatchObject({ voiceId: "space-specific-voice", isDefault: true });
    await expect(
      handles.prisma.userModelCredential.count({ where: { userId: actor.userId } }),
    ).resolves.toBe(1);
    await expect(
      handles.prisma.userVoiceCredential.count({ where: { userId: actor.userId } }),
    ).resolves.toBe(1);
  });

  it("shares model credentials while keeping defaults private to each space", async () => {
    const cookie = await signup(app, `model-defaults-${stamp}@tangow.test`, "Model Defaults");
    const actor = await rpc<Actor>(app, cookie, "me");
    const support = await rpc<Space>(app, cookie, "spaces/create", { name: "Support models" });
    const expectSpaceModelDefault = async (spaceId: string, provider: string, modelId: string) => {
      const preference = await handles.prisma.spaceModelPreference.findFirst({
        where: { userId: actor.userId, spaceId, isDefault: true },
        include: { credential: true },
      });
      expect(preference).toMatchObject({ modelId, credential: { provider } });
    };

    const connectedA = await rpc<ModelCredential>(app, cookie, "models/connect", {
      provider: "provider-a",
      apiKey: "fake-provider-a-key",
      label: "Provider A",
      modelId: "a/one",
    });
    expect(connectedA.isDefault).toBe(true);
    const providerABeforeRotation = await handles.prisma.userModelCredential.findUniqueOrThrow({
      where: { id: connectedA.id },
    });

    const rotatedA = await rpc<ModelCredential>(app, cookie, "models/connect", {
      provider: "provider-a",
      apiKey: "fake-provider-a-replacement-key",
      label: "Provider A rotated",
      modelId: "a/rotated",
    });
    const providerAAfterRotation = await handles.prisma.userModelCredential.findUniqueOrThrow({
      where: { id: connectedA.id },
    });
    expect(rotatedA.id).toBe(connectedA.id);
    expect(providerAAfterRotation.secretId).not.toBe(providerABeforeRotation.secretId);
    expect(
      await handles.prisma.secret.findUnique({ where: { id: providerABeforeRotation.secretId } }),
    ).toBeNull();
    await expect(
      handles.prisma.secret.findUniqueOrThrow({ where: { id: providerAAfterRotation.secretId } }),
    ).resolves.toMatchObject({ userId: actor.userId, spaceId: null, kind: "model" });
    expect(
      await handles.prisma.userModelCredential.count({
        where: { userId: actor.userId, provider: "provider-a" },
      }),
    ).toBe(1);

    const supportCredentials = await rpc<ModelCredential[]>(
      app,
      cookie,
      "models/credentials",
      {},
      support.id,
    );
    expect(supportCredentials).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: connectedA.id, provider: "provider-a", isDefault: false }),
      ]),
    );
    await rpc(
      app,
      cookie,
      "models/setDefault",
      { provider: "provider-a", modelId: "a/support" },
      support.id,
    );
    await expectSpaceModelDefault(support.id, "provider-a", "a/support");
    await expectSpaceModelDefault(actor.spaceId, "provider-a", "a/rotated");

    const connectedB = await rpc<ModelCredential>(app, cookie, "models/connect", {
      provider: "provider-b",
      apiKey: "fake-provider-b-key",
      label: "Provider B",
      modelId: "b/one",
    });
    expect(connectedB.isDefault).toBe(true);
    await expectSpaceModelDefault(actor.spaceId, "provider-b", "b/one");

    await rpc(app, cookie, "models/setDefault", { provider: "provider-a", modelId: "a/two" });
    await expectSpaceModelDefault(actor.spaceId, "provider-a", "a/two");

    await rpc(app, cookie, "models/setDefault", { provider: "provider-b", modelId: "b/two" });
    await expectSpaceModelDefault(actor.spaceId, "provider-b", "b/two");

    await rpc(app, cookie, "models/setDefault", { provider: "provider-a", modelId: "a/three" });
    await expectSpaceModelDefault(actor.spaceId, "provider-a", "a/three");
    await expectSpaceModelDefault(support.id, "provider-a", "a/support");
    const listed = await rpc<ModelCredential[]>(app, cookie, "models/credentials");
    expect(JSON.stringify(listed)).not.toContain("fake-provider-a-key");
    expect(JSON.stringify(listed)).not.toContain("fake-provider-b-key");

    const missing = await raw(app, cookie, "models/setDefault", {
      provider: "missing-provider",
      modelId: "missing/model",
    });
    expect(missing.status).toBeGreaterThanOrEqual(400);
    expect(await missing.text()).toMatch(/credential/i);
  });

  it("deletes only empty, non-default spaces", async () => {
    const cookie = await signup(app, `space-delete-${stamp}@tangow.test`, "Space Delete");
    const actor = await rpc<Actor>(app, cookie, "me");
    const empty = await rpc<Space>(app, cookie, "spaces/create", { name: "Temporary" });
    const busy = await rpc<Space>(app, cookie, "spaces/create", { name: "Busy" });
    const busyBot = await rpc<Bot>(app, cookie, "bots/create", botInput("Busy bot"), busy.id);

    await expect(raw(app, cookie, "spaces/remove", { spaceId: busy.id })).resolves.toMatchObject({
      status: 400,
    });
    await expect(
      handles.prisma.space.findUnique({ where: { id: busy.id } }),
    ).resolves.not.toBeNull();
    await rpc(app, cookie, "bots/archive", { botId: busyBot.id }, busy.id);
    expect(
      (await rpc<SpaceNavigation>(app, cookie, "spaces/list", {}, busy.id)).spaces.find(
        (space) => space.id === busy.id,
      ),
    ).toMatchObject({ hasContent: true, canDelete: false });
    await expect(raw(app, cookie, "spaces/remove", { spaceId: busy.id })).resolves.toMatchObject({
      status: 400,
    });
    await expect(
      raw(app, cookie, "spaces/remove", { spaceId: actor.spaceId }),
    ).resolves.toMatchObject({ status: 400 });
    await expect(
      raw(app, cookie, "spaces/remove", { spaceId: "missing-space" }),
    ).resolves.toMatchObject({ status: 404 });

    const removed = await rpc<{ ok: true; activeSpaceId: string }>(app, cookie, "spaces/remove", {
      spaceId: empty.id,
    });
    expect(removed).toEqual({ ok: true, activeSpaceId: actor.spaceId });
    await expect(handles.prisma.space.findUnique({ where: { id: empty.id } })).resolves.toBeNull();
    const navigation = await rpc<SpaceNavigation>(app, cookie, "spaces/list");
    expect(navigation.spaces.map((space) => space.id)).not.toContain(empty.id);

    const intruder = await signup(app, `space-delete-intruder-${stamp}@tangow.test`, "Intruder");
    await expect(raw(app, intruder, "spaces/remove", { spaceId: busy.id })).resolves.toMatchObject({
      status: 404,
    });

    // Shared-space members must not delete; only the SpaceMember owner may.
    const shared = await rpc<Space>(app, cookie, "spaces/create", { name: "Shared empty" });
    expect(shared.canDelete).toBe(true);
    const sharedRow = await handles.prisma.space.findUniqueOrThrow({
      where: { id: shared.id },
      select: { organizationId: true },
    });
    const memberCookie = await signup(
      app,
      `space-delete-member-${stamp}@tangow.test`,
      "Space Member",
    );
    const memberActor = await rpc<Actor>(app, memberCookie, "me");
    await handles.prisma.member.deleteMany({ where: { userId: memberActor.userId } });
    await handles.prisma.member.create({
      data: {
        id: `space-delete-org-member-${stamp}`,
        organizationId: sharedRow.organizationId,
        userId: memberActor.userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    await handles.prisma.spaceMember.create({
      data: {
        id: `space-delete-space-member-${stamp}`,
        spaceId: shared.id,
        organizationId: sharedRow.organizationId,
        userId: memberActor.userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    await expect(
      raw(app, memberCookie, "spaces/remove", { spaceId: shared.id }, shared.id),
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      handles.prisma.space.findUnique({ where: { id: shared.id } }),
    ).resolves.not.toBeNull();

    // Another member's bot still counts as content for onboarding emptiness.
    const ownerBot = await rpc<Bot>(
      app,
      cookie,
      "bots/create",
      botInput("Owner shared bot"),
      shared.id,
    );
    const ownerNavigation = await rpc<SpaceNavigation>(app, cookie, "spaces/list", {}, shared.id);
    expect(ownerNavigation.spaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: shared.id, hasContent: true, canDelete: false }),
      ]),
    );
    const memberNavigation = await rpc<SpaceNavigation>(
      app,
      memberCookie,
      "spaces/list",
      {},
      shared.id,
    );
    expect(memberNavigation.spaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: shared.id, hasContent: true, canDelete: false }),
      ]),
    );

    await rpc(app, cookie, "bots/remove", { botId: ownerBot.id, deleteMemories: true }, shared.id);
    expect(
      (await rpc<SpaceNavigation>(app, cookie, "spaces/list", {}, shared.id)).spaces.find(
        (space) => space.id === shared.id,
      )?.canDelete,
    ).toBe(true);
    const ownerRemoved = await rpc<{ ok: true; activeSpaceId: string }>(
      app,
      cookie,
      "spaces/remove",
      {
        spaceId: shared.id,
      },
    );
    expect(ownerRemoved.ok).toBe(true);
    await expect(handles.prisma.space.findUnique({ where: { id: shared.id } })).resolves.toBeNull();
  });

  it("lists a Space joined by invite link in the guest's switcher, owner-only management", async () => {
    const owner = await signup(app, `space-invite-owner-${stamp}@tangow.test`, "Ada");
    const shared = await rpc<Space>(app, owner, "spaces/create", { name: "Family" });
    const guestEmail = `space-invite-guest-${stamp}@tangow.test`;
    const guest = await signup(app, guestEmail, "Grace");
    const guestActor = await rpc<Actor>(app, guest, "me");
    const intruder = await signup(app, `space-invite-intruder-${stamp}@tangow.test`, "Sam");

    const { invitations } = await rpc<{ invitations: Array<{ url: string }> }>(
      app,
      owner,
      "spaces/createInvite",
      { spaceId: shared.id, emails: [guestEmail] },
    );
    const token = new URL(invitations[0]!.url).pathname.replace("/invite/", "");
    await expect(raw(app, intruder, "spaces/acceptInvite", { token })).resolves.toMatchObject({
      status: 403,
    });
    await expect(rpc(app, guest, "spaces/invitation", { token })).resolves.toEqual({
      spaceName: "Family",
      inviterName: "Ada",
      email: guestEmail,
      forYou: true,
    });
    await expect(rpc(app, guest, "spaces/acceptInvite", { token })).resolves.toEqual({
      spaceId: shared.id,
    });

    const navigation = await rpc<SpaceNavigation>(app, guest, "spaces/list");
    expect(navigation.spaces.map((space) => [space.id, space.canRename, space.canDelete])).toEqual([
      [guestActor.spaceId, true, false],
      [shared.id, false, false],
    ]);
    await expect(
      raw(
        app,
        guest,
        "spaces/createInvite",
        { spaceId: shared.id, emails: ["someone@tangow.test"] },
        shared.id,
      ),
    ).resolves.toMatchObject({ status: 403 });
    await expect(raw(app, guest, "spaces/acceptInvite", { token })).resolves.toMatchObject({
      status: 404,
    });
    await expect(
      raw(app, intruder, "spaces/members", { spaceId: shared.id }),
    ).resolves.toMatchObject({ status: 404 });
  });

  /** An owner's Space with two members, Dana and Sam, and a bot of the owner's in it. */
  /** The caller's own thread with the bot: the apps its connect cards offer, and those answered. */
  async function appCards(cookie: string, botId: string, space: string) {
    const { threadId } = await rpc<{ threadId: string }>(
      app,
      cookie,
      "threads/get",
      { botId },
      space,
    );
    const { sessionId } = await handles.prisma.thread.findUniqueOrThrow({
      where: { id: threadId },
    });
    const entries = await handles.prisma.sessionEntry.findMany({
      where: { sessionId, type: { in: ["bot.text", "card.answered"] } },
      orderBy: { seq: "asc" },
    });
    const payload = (entry: (typeof entries)[number]) =>
      entry.payload as { blocks?: Array<{ kind: string; provider?: string }>; answerId?: string };
    return {
      offered: entries.flatMap((entry) =>
        (payload(entry).blocks ?? [])
          .filter((block) => block.kind === "app_connect")
          .map((block) => block.provider),
      ),
      answered: entries.flatMap((entry) =>
        entry.type === "card.answered" ? [payload(entry).answerId] : [],
      ),
    };
  }

  async function sharedBotSpace(prefix: string) {
    const owner = await signup(app, `${prefix}-owner-${stamp}@tangow.test`, "Ada");
    const space = (await rpc<Space>(app, owner, "spaces/create", { name: "Studio" })).id;
    const join = async (name: string) => {
      const email = `${prefix}-${name}-${stamp}@tangow.test`;
      const cookie = await signup(app, email, name);
      const { invitations } = await rpc<{ invitations: Array<{ id: string }> }>(
        app,
        owner,
        "spaces/createInvite",
        { spaceId: space, emails: [email] },
      );
      await rpc(app, cookie, "spaces/acceptInvite", { token: invitations[0]!.id });
      return { cookie, userId: (await rpc<Actor>(app, cookie, "me", {}, space)).userId };
    };
    const dana = await join("Dana");
    const sam = await join("Sam");
    const bot = await rpc<SharedBot>(app, owner, "bots/create", botInput("Notes"), space);
    const listed = async (cookie: string) =>
      (await rpc<SharedBot[]>(app, cookie, "bots/list", {}, space)).find(
        (row) => row.id === bot.id,
      );
    return { owner, space, dana, sam, bot, listed };
  }

  it("speaks a shared bot's messages in its own voice for a member, and for nobody else", async () => {
    const { owner, space, dana, sam, bot } = await sharedBotSpace("bot-voice");
    await rpc(app, owner, "bots/update", { botId: bot.id, voiceId: "owner-picked-voice" }, space);
    await rpc(
      app,
      owner,
      "bots/share",
      {
        botId: bot.id,
        visibility: "people",
        userIds: [dana.userId],
      },
      space,
    );
    for (const cookie of [dana.cookie, sam.cookie]) {
      await rpc(
        app,
        cookie,
        "voice/connect",
        { provider: "scripted", apiKey: "fake-voice-key" },
        space,
      );
    }
    const synthesize = vi.spyOn(ScriptedVoiceProvider.prototype, "synthesize");
    try {
      const speak = (cookie: string) =>
        app.request("/api/voice/speak", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie,
            "x-tangow-space-id": space,
            origin: "http://127.0.0.1:5173",
          },
          body: JSON.stringify({ text: "Release notes go out on Thursdays.", botId: bot.id }),
        });

      await expect(
        rpc(app, dana.cookie, "voice/prepare", { text: "Hello.", botId: bot.id }, space),
      ).resolves.toMatchObject({ ready: true });
      expect((await speak(dana.cookie)).status).toBe(200);
      expect(synthesize).toHaveBeenCalledWith(
        expect.objectContaining({ voiceId: "owner-picked-voice" }),
        expect.anything(),
      );

      // In the Space but not shared with: the bot stays out of reach, as before.
      await expect(
        raw(app, sam.cookie, "voice/prepare", { text: "Hello.", botId: bot.id }, space),
      ).resolves.toMatchObject({ status: 404 });
      expect((await speak(sam.cookie)).status).toBeGreaterThanOrEqual(400);
      expect(synthesize).toHaveBeenCalledOnce();
    } finally {
      synthesize.mockRestore();
    }
  });

  it("shares a bot only by its owner and only with members of its Space", async () => {
    const { owner, space, dana, sam, bot, listed } = await sharedBotSpace("bot-share");
    const stranger = await signup(app, `bot-share-stranger-${stamp}@tangow.test`, "Lee");
    const strangerId = (await rpc<Actor>(app, stranger, "me")).userId;
    const share = { botId: bot.id, visibility: "people", userIds: [dana.userId] };

    await expect(raw(app, dana.cookie, "bots/share", share, space)).resolves.toMatchObject({
      status: 404,
    });
    await expect(rpc(app, owner, "bots/share", share, space)).resolves.toEqual({
      visibility: "people",
      userIds: [dana.userId],
      connectors: [],
    });
    expect(await listed(dana.cookie)).toMatchObject({ isOwner: false });
    expect(await listed(sam.cookie)).toBeUndefined();
    await rpc(app, owner, "bots/update", { botId: bot.id, instructions: "Owner's recipe" }, space);
    await handles.prisma.bot.update({
      where: { id: bot.id },
      data: { modelProvider: "test", modelId: "test/model", teamChatRules: "Owner's rules" },
    });
    expect(await listed(owner)).toMatchObject({
      instructions: "Owner's recipe",
      modelId: "test/model",
    });
    expect(await listed(dana.cookie)).toMatchObject({
      instructions: "",
      modelProvider: null,
      modelId: null,
      teamChatRules: "",
    });

    const gmail = { kind: "app", connectorId: "composio", provider: "gmail" };
    await expect(
      raw(app, dana.cookie, "bots/share", { ...share, connectors: [gmail] }, space),
    ).resolves.toMatchObject({ status: 403 });
    await expect(rpc(app, owner, "bots/sharing", { botId: bot.id }, space)).resolves.toMatchObject({
      connectors: [],
    });
    await expect(
      raw(app, dana.cookie, "bots/sharing", { botId: bot.id }, space),
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      raw(app, dana.cookie, "bots/update", { botId: bot.id, name: "Mine" }, space),
    ).resolves.toMatchObject({ status: 404 });
    await expect(
      raw(app, owner, "bots/share", { ...share, userIds: [strangerId] }, space),
    ).resolves.toMatchObject({ status: 400 });

    const thread = (cookie: string) =>
      rpc<{ threadId: string }>(app, cookie, "threads/get", { botId: bot.id }, space);
    const danaThread = (await thread(dana.cookie)).threadId;
    expect(danaThread).not.toBe(bot.threadId);
    expect(danaThread).toBe((await listed(dana.cookie))?.threadId);
    expect((await thread(owner)).threadId).toBe(bot.threadId);
    expect((await listed(owner))?.threadId).toBe(bot.threadId);
    await expect(
      raw(app, sam.cookie, "threads/get", { botId: bot.id }, space),
    ).resolves.toMatchObject({ status: 404 });
    await expect(rpc(app, dana.cookie, "threads/clear", { botId: bot.id }, space)).resolves.toEqual(
      { ok: true },
    );

    await rpc(app, owner, "bots/share", { ...share, visibility: "private" }, space);
    await expect(
      raw(app, dana.cookie, "threads/get", { botId: bot.id }, space),
    ).resolves.toMatchObject({ status: 404 });
    expect(await listed(dana.cookie)).toBeUndefined();
  });

  it("gives a member the files of their own thread with a shared bot, never anyone else's", async () => {
    const { owner, space, dana, sam, bot } = await sharedBotSpace("bot-share-files");
    await rpc(
      app,
      owner,
      "bots/share",
      { botId: bot.id, visibility: "people", userIds: [dana.userId, sam.userId] },
      space,
    );
    const attach = (cookie: string, text: string) =>
      rpc<{ id: string }>(
        app,
        cookie,
        "artifacts/create",
        {
          botId: bot.id,
          name: "note.txt",
          mimeType: "text/plain",
          contentBase64: Buffer.from(text).toString("base64"),
        },
        space,
      );
    const read = (cookie: string, artifactId: string) =>
      raw(app, cookie, "artifacts/get", { botId: bot.id, artifactId }, space);

    const danaFile = await attach(dana.cookie, "dana's note");
    const ownerFile = await attach(owner, "owner's note");
    const own = await rpc<{ contentBase64: string }>(
      app,
      dana.cookie,
      "artifacts/get",
      { botId: bot.id, artifactId: danaFile.id },
      space,
    );
    expect(Buffer.from(own.contentBase64, "base64").toString()).toBe("dana's note");
    await expect(read(dana.cookie, ownerFile.id)).resolves.toMatchObject({ status: 404 });
    await expect(read(sam.cookie, danaFile.id)).resolves.toMatchObject({ status: 404 });
    await expect(read(owner, danaFile.id)).resolves.toMatchObject({ status: 404 });
  });

  it("lets a member preview links and remove a preview in their own thread only", async () => {
    const { owner, space, dana, sam, bot } = await sharedBotSpace("bot-share-links");
    await rpc(app, owner, "bots/share", { botId: bot.id, visibility: "space", userIds: [] }, space);
    const { threadId } = await rpc<{ threadId: string }>(
      app,
      dana.cookie,
      "threads/get",
      { botId: bot.id },
      space,
    );
    await rpc(app, dana.cookie, "threads/send", { botId: bot.id, text: "Hello" }, space);
    const message = await handles.prisma.sessionEntry.findFirstOrThrow({
      where: { session: { threadId }, type: "user.message" },
      select: { id: true },
    });
    const preview = { threadId, url: "http://127.0.0.1/" };

    await expect(raw(app, dana.cookie, "links/preview", preview, space)).resolves.toMatchObject({
      status: 200,
    });
    await expect(
      rpc(app, dana.cookie, "messages/removeLinkPreview", { messageId: message.id }, space),
    ).resolves.toEqual({ ok: true });
    await expect(raw(app, sam.cookie, "links/preview", preview, space)).resolves.toMatchObject({
      status: 404,
    });
    await expect(
      raw(app, sam.cookie, "messages/removeLinkPreview", { messageId: message.id }, space),
    ).resolves.toMatchObject({ status: 404 });
  });

  it("lets only a group message's author remove its link preview", async () => {
    const { owner, space, dana, bot } = await sharedBotSpace("group-links");
    const group = await rpc<{ id: string }>(
      app,
      owner,
      "groups/create",
      { name: "Crew", botIds: [bot.id], userIds: [dana.userId] },
      space,
    );
    await rpc(app, dana.cookie, "threads/send", { groupId: group.id, text: "Hello" }, space);
    const message = await handles.prisma.sessionEntry.findFirstOrThrow({
      where: { session: { thread: { groupId: group.id } }, type: "user.message" },
      select: { id: true },
    });

    await expect(
      raw(app, owner, "messages/removeLinkPreview", { messageId: message.id }, space),
    ).resolves.toMatchObject({ status: 404 });
    await expect(
      rpc(app, dana.cookie, "messages/removeLinkPreview", { messageId: message.id }, space),
    ).resolves.toEqual({ ok: true });
  });

  it("searches a member's own thread with a shared bot, never anyone else's", async () => {
    const { owner, space, dana, sam, bot } = await sharedBotSpace("bot-share-search");
    const share = { botId: bot.id, visibility: "space", userIds: [] };
    await rpc(app, owner, "bots/share", share, space);
    const word = `nebula${Date.now()}`;
    const send = (cookie: string, body: object) =>
      rpc(app, cookie, "threads/send", { botId: bot.id, ...body }, space);
    const file = await rpc<{ id: string }>(
      app,
      dana.cookie,
      "artifacts/create",
      {
        botId: bot.id,
        name: `${word}.txt`,
        mimeType: "text/plain",
        contentBase64: Buffer.from("notes").toString("base64"),
      },
      space,
    );
    await send(dana.cookie, { text: `Dana's ${word} plan`, artifactIds: [file.id] });
    await send(owner, { text: `Owner's ${word} plan` });
    await handles.prisma.routine.create({
      data: {
        spaceId: space,
        botId: bot.id,
        userId: dana.userId,
        name: `Dana's ${word} check`,
        prompt: "Check in",
        crons: ["0 9 * * *"],
        timezone: "UTC",
      },
    });
    const search = async (cookie: string) =>
      (
        await rpc<{ hits: Array<{ kind: string; snippet: string; botId?: string }> }>(
          app,
          cookie,
          "search/query",
          { q: word },
          space,
        )
      ).hits;

    const found = await search(dana.cookie);
    expect(found.map((hit) => hit.kind).sort()).toEqual(["file", "message", "routine"]);
    expect(found.every((hit) => hit.botId === bot.id)).toBe(true);
    expect(found.find((hit) => hit.kind === "message")?.snippet).toContain("Dana's");
    expect(await search(sam.cookie)).toEqual([]);
    expect((await search(owner)).map((hit) => hit.snippet)).toEqual([
      expect.stringContaining("Owner's"),
    ]);

    await rpc(app, owner, "bots/share", { ...share, visibility: "private" }, space);
    expect(await search(dana.cookie)).toEqual([]);
  });

  /** A finished routine run of `userId` in `threadId`, with its own session under the thread's. */
  async function finishedRun(space: string, botId: string, userId: string, threadId: string) {
    const thread = await handles.prisma.thread.findUniqueOrThrow({ where: { id: threadId } });
    const session = await handles.prisma.conversationSession.create({
      data: {
        id: crypto.randomUUID(),
        spaceId: space,
        kind: "routine",
        parentSessionId: thread.sessionId,
      },
    });
    const task = await handles.prisma.task.create({
      data: { spaceId: space, userId, botId, threadId, prompt: "private prompt", status: "done" },
    });
    return handles.prisma.run.create({
      data: {
        spaceId: space,
        userId,
        botId,
        threadId,
        taskId: task.id,
        sessionId: session.id,
        status: "completed",
        trigger: "routine",
        completedAt: new Date(),
      },
    });
  }

  it("reads a session only from the person's own thread with a shared bot", async () => {
    const { owner, space, dana, sam, bot } = await sharedBotSpace("bot-share-sessions");
    await rpc(app, owner, "bots/share", { botId: bot.id, visibility: "space", userIds: [] }, space);
    const danaThread = (
      await rpc<{ threadId: string }>(app, dana.cookie, "threads/get", { botId: bot.id }, space)
    ).threadId;
    const ownerActor = await rpc<Actor>(app, owner, "me", {}, space);
    const ownerRun = await finishedRun(space, bot.id, ownerActor.userId, bot.threadId);
    const danaRun = await finishedRun(space, bot.id, dana.userId, danaThread);
    const read = (cookie: string, sessionId: string) =>
      raw(app, cookie, "sessions/entries", { sessionId }, space);

    await expect(read(dana.cookie, danaRun.sessionId)).resolves.toMatchObject({ status: 200 });
    await expect(read(owner, ownerRun.sessionId)).resolves.toMatchObject({ status: 200 });
    await expect(read(dana.cookie, ownerRun.sessionId)).resolves.toMatchObject({ status: 404 });
    await expect(read(owner, danaRun.sessionId)).resolves.toMatchObject({ status: 404 });
    await expect(read(sam.cookie, danaRun.sessionId)).resolves.toMatchObject({ status: 404 });
  });

  it("reads a run's session in a group only for the person it ran as", async () => {
    const { owner, space, dana, bot } = await sharedBotSpace("group-sessions");
    await rpc(app, owner, "bots/share", { botId: bot.id, visibility: "space", userIds: [] }, space);
    const group = await rpc<{ id: string; threadId: string }>(
      app,
      owner,
      "groups/create",
      { name: "Crew", botIds: [bot.id], userIds: [dana.userId] },
      space,
    );
    const danaRun = await finishedRun(space, bot.id, dana.userId, group.threadId);
    const read = (cookie: string) =>
      raw(app, cookie, "sessions/entries", { sessionId: danaRun.sessionId }, space);

    await expect(read(dana.cookie)).resolves.toMatchObject({ status: 200 });
    await expect(read(owner)).resolves.toMatchObject({ status: 404 });
  });

  it("keeps a member's scratchpad on a shared bot out of the owner's", async () => {
    const { owner, space, dana, bot } = await sharedBotSpace("bot-share-scratchpad");
    await rpc(app, owner, "bots/share", { botId: bot.id, visibility: "space", userIds: [] }, space);
    await rpc(app, owner, "scratchpad/create", { botId: bot.id, title: "Owner's todo" }, space);
    // A member's run adds to the scratchpad of the bot it runs on.
    await handles.prisma.scratchpadItem.create({
      data: { spaceId: space, botId: bot.id, userId: dana.userId, title: "Dana's todo" },
    });

    const listed = await rpc<Array<{ title: string }>>(
      app,
      owner,
      "scratchpad/list",
      { botId: bot.id },
      space,
    );
    expect(listed.map((item) => item.title)).toEqual(["Owner's todo"]);
  });

  it("lists and exports only the owner's routines and thread of a shared bot", async () => {
    const { owner, space, dana, bot } = await sharedBotSpace("bot-share-routines");
    await rpc(app, owner, "bots/share", { botId: bot.id, visibility: "space", userIds: [] }, space);
    await rpc(app, owner, "routines/create", { ...routineInput(bot.id), name: "Owner's" }, space);
    // A member's run sets up a routine on the bot it runs on.
    await handles.prisma.routine.create({
      data: {
        spaceId: space,
        botId: bot.id,
        userId: dana.userId,
        name: "Dana's",
        prompt: "Dana's private prompt",
        crons: ["0 9 * * *"],
        timezone: "UTC",
      },
    });
    await rpc(app, dana.cookie, "threads/send", { botId: bot.id, text: "Dana's secret" }, space);

    const listed = await rpc<Array<{ name: string }>>(
      app,
      owner,
      "routines/list",
      { botId: bot.id },
      space,
    );
    expect(listed.map((routine) => routine.name)).toEqual(["Owner's"]);
    const exported = await rpc<{ routines: Array<{ name: string }> }>(
      app,
      owner,
      "export/bot",
      { botId: bot.id },
      space,
    );
    expect(exported.routines.map((routine) => routine.name)).toEqual(["Owner's"]);
    expect(JSON.stringify(exported)).not.toContain("Dana's");
  });

  it("keeps each person's memory of a shared bot their own, and exports the owner's and the team's", async () => {
    const { owner, space, dana, bot } = await sharedBotSpace("bot-share-memory");
    await rpc(app, owner, "bots/share", { botId: bot.id, visibility: "space", userIds: [] }, space);
    const ownerId = (await rpc<Actor>(app, owner, "me", {}, space)).userId;
    const row = (userId: string, scope: string, content: string) =>
      handles.prisma.memoryDocument.create({
        data: { spaceId: space, botId: bot.id, userId, scope, path: "MEMORY.md", content },
      });
    // What runs on the bot saved: the team's under the owner, and Dana's own.
    const team = await row(ownerId, "team", "- Team fact");
    await row(dana.userId, "bot", "- Dana's private fact");
    const ownerBot = await handles.prisma.memoryDocument.findFirstOrThrow({
      where: { botId: bot.id, userId: ownerId, scope: "bot" },
    });

    const listed = async (cookie: string) =>
      (
        await rpc<Array<{ content: string }>>(app, cookie, "memory/list", { botId: bot.id }, space)
      ).map((doc) => doc.content);
    expect(await listed(dana.cookie)).toEqual(["- Dana's private fact"]);
    expect(await listed(owner)).not.toContain("- Dana's private fact");
    for (const documentId of [ownerBot.id, team.id]) {
      await expect(
        raw(app, dana.cookie, "memory/update", { documentId, content: "overwritten" }, space),
      ).resolves.toMatchObject({ status: 404 });
    }

    const exported = await rpc<{ memory: Array<{ path: string; content: string }> }>(
      app,
      owner,
      "export/bot",
      { botId: bot.id },
      space,
    );
    expect(exported.memory).toEqual(
      expect.arrayContaining([
        { path: "MEMORY.md", content: ownerBot.content },
        { path: "team/MEMORY.md", content: "- Team fact" },
      ]),
    );
    expect(exported.memory).toHaveLength(2);
  });

  it("shows each person the status of their own thread with a shared bot", async () => {
    const { owner, space, dana, bot, listed } = await sharedBotSpace("bot-share-status");
    await rpc(app, owner, "bots/share", { botId: bot.id, visibility: "space", userIds: [] }, space);
    const other = await rpc<SharedBot>(app, owner, "bots/create", botInput("Other"), space);
    await rpc(app, owner, "groups/create", { name: "Crew", botIds: [bot.id, other.id] }, space);
    const danaThread = (
      await rpc<{ threadId: string }>(app, dana.cookie, "threads/get", { botId: bot.id }, space)
    ).threadId;
    const task = await handles.prisma.task.create({
      data: {
        spaceId: space,
        userId: dana.userId,
        botId: bot.id,
        threadId: danaThread,
        prompt: "Dana's question",
        status: "waiting_input",
      },
    });
    await handles.prisma.run.create({
      data: {
        spaceId: space,
        userId: dana.userId,
        botId: bot.id,
        threadId: danaThread,
        taskId: task.id,
        status: "waiting_input",
        trigger: "user",
      },
    });

    expect((await listed(dana.cookie))?.status).toBe("waiting_input");
    expect((await listed(owner))?.status).toBe("idle");
    const [group] = await rpc<Array<{ members: Array<{ botId: string; status: string }> }>>(
      app,
      owner,
      "groups/list",
      {},
      space,
    );
    expect(group?.members.find((member) => member.botId === bot.id)?.status).toBe("idle");
  });

  it("hides a member's runs and their traces once the bot is unshared", async () => {
    const { owner, space, dana, bot } = await sharedBotSpace("bot-share-runs");
    const share = { botId: bot.id, visibility: "space", userIds: [] };
    await rpc(app, owner, "bots/share", share, space);
    const danaThread = (
      await rpc<{ threadId: string }>(app, dana.cookie, "threads/get", { botId: bot.id }, space)
    ).threadId;
    const run = await finishedRun(space, bot.id, dana.userId, danaThread);
    const recent = async () =>
      (
        await rpc<{ runs: Array<{ runId: string }> }>(
          app,
          dana.cookie,
          "runs/list",
          { filter: "recent" },
          space,
        )
      ).runs.map((row) => row.runId);
    const read = (procedure: string) => raw(app, dana.cookie, procedure, { runId: run.id }, space);

    expect(await recent()).toEqual([run.id]);
    await expect(read("runs/entries")).resolves.toMatchObject({ status: 200 });
    await expect(read("runs/recap")).resolves.toMatchObject({ status: 200 });

    await rpc(app, owner, "bots/share", { ...share, visibility: "private" }, space);
    expect(await recent()).toEqual([]);
    await expect(read("runs/entries")).resolves.toMatchObject({ status: 404 });
    await expect(read("runs/recap")).resolves.toMatchObject({ status: 404 });
  });

  it("moves a bot onto a computer of its own when it is first shared, never mid-run", async () => {
    const { owner, space, bot, listed } = await sharedBotSpace("bot-share-computer");
    const ownerId = (await rpc<Actor>(app, owner, "me", {}, space)).userId;
    const share = { botId: bot.id, visibility: "space", userIds: [] };
    const task = await handles.prisma.task.create({
      data: {
        spaceId: space,
        userId: ownerId,
        botId: bot.id,
        threadId: bot.threadId,
        prompt: "",
        status: "waiting_input",
      },
    });
    const run = await handles.prisma.run.create({
      data: {
        spaceId: space,
        userId: ownerId,
        botId: bot.id,
        threadId: bot.threadId,
        taskId: task.id,
        status: "waiting_input",
        trigger: "user",
      },
    });
    expect(await listed(owner)).toMatchObject({ computerMode: "team" });

    await expect(rpc(app, owner, "bots/share", share, space)).rejects.toThrow("Stop the bot first");
    expect(await listed(owner)).toMatchObject({ computerMode: "team" });
    await expect(rpc(app, owner, "bots/sharing", { botId: bot.id }, space)).resolves.toMatchObject({
      visibility: "private",
    });

    await handles.prisma.run.update({ where: { id: run.id }, data: { status: "cancelled" } });
    await rpc(app, owner, "bots/share", share, space);
    expect(await listed(owner)).toMatchObject({ computerMode: "dedicated" });
  });

  it("lists for a shared bot only the skills its owner turned on for it", async () => {
    const { owner, space, bot } = await sharedBotSpace("bot-share-skills");
    const skill = await rpc<{ id: string }>(
      app,
      owner,
      "agentSkills/create",
      { name: "Release steps", description: "How we ship", body: "Steps" },
      space,
    );
    const visibleTo = async () =>
      (
        await rpc<Array<{ id: string; visibleBotIds: string[] }>>(
          app,
          owner,
          "agentSkills/list",
          {},
          space,
        )
      ).find((entry) => entry.id === skill.id)?.visibleBotIds;
    expect(await visibleTo()).toContain(bot.id);

    await rpc(app, owner, "bots/share", { botId: bot.id, visibility: "space", userIds: [] }, space);
    expect(await visibleTo()).not.toContain(bot.id);

    const on = { skillId: skill.id, bots: [{ botId: bot.id, enabled: true }] };
    await rpc(app, owner, "agentSkills/setAccess", on, space);
    expect(await visibleTo()).toContain(bot.id);
  });

  it("offers a member each declared app they lack once, in their own thread", async () => {
    const { owner, space, dana, bot } = await sharedBotSpace("bot-share-apps");
    const need = (provider: string) => ({ kind: "app", connectorId: "composio", provider });
    await rpc(
      app,
      owner,
      "bots/share",
      {
        botId: bot.id,
        visibility: "space",
        userIds: [],
        connectors: [need("GMAIL"), need("SLACK")],
      },
      space,
    );
    await rpc(
      app,
      dana.cookie,
      "connections/begin",
      { connectorId: "composio", provider: "SLACK", displayName: "Slack" },
      space,
    );
    const cards = async (cookie: string) => (await appCards(cookie, bot.id, space)).offered;
    const say = (text: string) =>
      rpc(app, dana.cookie, "threads/send", { botId: bot.id, text }, space);

    await say("Draft the notes for this week.");
    await vi.waitFor(async () => expect(await cards(dana.cookie)).toEqual(["GMAIL"]));
    await say("And the week after.");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await cards(dana.cookie)).toEqual(["GMAIL"]);
    expect(await cards(owner)).toEqual([]);
    await expect(
      rpc(
        app,
        dana.cookie,
        "onboarding/appConnected",
        { botId: bot.id, provider: "GMAIL", connectorId: "composio" },
        space,
      ),
    ).resolves.toEqual({ ok: true });
  });

  it("gives a member a declared MCP server's public half and their own copy of it", async () => {
    const { owner, space, dana, bot } = await sharedBotSpace("bot-share-mcp");
    const create = (config: Record<string, unknown>) =>
      rpc<{ id: string }>(app, owner, "mcp/servers/create", { enabled: true, ...config }, space);
    const linear = await create({
      slug: "linear",
      name: "Linear",
      transport: "streamable_http",
      endpoint: "https://mcp.linear.example/mcp",
      headers: { "X-Api-Key": "owner-header-value" },
      secret: "owner-token-value",
    });
    const notes = await create({
      slug: "notes",
      name: "Notes",
      transport: "stdio",
      command: "/opt/notes-mcp",
      args: ["--stdio"],
      env: { NOTES_TOKEN: "owner-env-value" },
    });
    const elsewhere = await create({
      slug: "elsewhere",
      name: "Elsewhere",
      transport: "stdio",
      command: "/bin/other",
    });
    const undeclared = await create({
      slug: "wiki",
      name: "Wiki",
      transport: "streamable_http",
      endpoint: "https://mcp.wiki.example/mcp",
    });
    await rpc(
      app,
      owner,
      "mcp/assignments/replace",
      {
        botId: bot.id,
        assignments: [
          { serverId: linear.id, allowAllTools: false, allowedTools: ["list_issues"] },
          { serverId: notes.id },
          { serverId: elsewhere.id },
          { serverId: undeclared.id },
        ],
      },
      space,
    );
    await rpc(
      app,
      owner,
      "bots/share",
      {
        botId: bot.id,
        visibility: "space",
        userIds: [],
        connectors: [linear, notes, elsewhere].map(({ id }) => ({ kind: "mcp", serverId: id })),
      },
      space,
    );
    const declared = (serverId: string) =>
      raw(app, dana.cookie, "bots/declaredMcp", { botId: bot.id, serverId }, space);

    const linearHalf = await (await declared(linear.id)).text();
    const notesHalf = await (await declared(notes.id)).text();
    for (const secret of ["owner-header-value", "owner-token-value", "owner-env-value"]) {
      expect(linearHalf + notesHalf).not.toContain(secret);
    }
    expect(JSON.parse(linearHalf).json).toMatchObject({
      endpoint: "https://mcp.linear.example/mcp",
      headerKeys: ["X-Api-Key"],
      allowedTools: ["list_issues"],
    });
    expect(JSON.parse(notesHalf).json).toMatchObject({
      command: "/opt/notes-mcp",
      args: ["--stdio"],
      envKeys: ["NOTES_TOKEN"],
      allowedTools: null,
    });
    // Not declared, or a stdio command this deployment doesn't run: nothing to add.
    for (const server of [undeclared, elsewhere]) {
      await expect(declared(server.id)).resolves.toMatchObject({ status: 404 });
    }

    await rpc(app, dana.cookie, "threads/send", { botId: bot.id, text: "Plan the week." }, space);
    await vi.waitFor(async () =>
      expect((await appCards(dana.cookie, bot.id, space)).offered.sort()).toEqual(
        [linear.id, notes.id].sort(),
      ),
    );

    const mine = await rpc<{ id: string; headerKeys: string[] }>(
      app,
      dana.cookie,
      "bots/addDeclaredMcp",
      { botId: bot.id, serverId: linear.id, headers: { "X-Api-Key": "dana-key", "X-Extra": "x" } },
      space,
    );
    expect(mine.headerKeys).toEqual(["X-Api-Key"]);
    expect(
      await handles.prisma.botMcpServer.findFirst({ where: { serverId: mine.id } }),
    ).toMatchObject({
      botId: bot.id,
      userId: dana.userId,
      declaredServerId: linear.id,
      allowAllTools: false,
      allowedTools: ["list_issues"],
    });
    expect((await appCards(dana.cookie, bot.id, space)).answered).toEqual([`mcp:${linear.id}`]);
    // Adding it again, say after a failed response, gives back the same copy.
    await expect(
      rpc(app, dana.cookie, "bots/addDeclaredMcp", { botId: bot.id, serverId: linear.id }, space),
    ).resolves.toMatchObject({ id: mine.id });
    expect(
      await handles.prisma.botMcpServer.count({
        where: { botId: bot.id, userId: dana.userId, declaredServerId: linear.id },
      }),
    ).toBe(1);

    // The existing assignment endpoints stay the owner's: a member attaches nothing through them.
    await expect(
      raw(app, dana.cookie, "mcp/assignments/approve", { botId: bot.id, serverId: mine.id }, space),
    ).resolves.toMatchObject({ status: 404 });
    await expect(
      raw(
        app,
        dana.cookie,
        "mcp/assignments/replace",
        { botId: bot.id, assignments: [{ serverId: mine.id }] },
        space,
      ),
    ).resolves.toMatchObject({ status: 404 });

    // Their copy keeps the owner's endpoint: only its credentials change. The owner's server
    // stays theirs to edit.
    const repoint = (cookie: string, id: string) =>
      raw(
        app,
        cookie,
        "mcp/servers/update",
        {
          id,
          config: {
            slug: "linear",
            name: "Linear",
            transport: "streamable_http",
            endpoint: "https://mcp.elsewhere.example/mcp",
          },
        },
        space,
      );
    await expect(repoint(dana.cookie, mine.id)).resolves.toMatchObject({ status: 400 });
    expect(await handles.prisma.mcpServer.findUnique({ where: { id: mine.id } })).toMatchObject({
      endpoint: "https://mcp.linear.example/mcp",
    });
    await expect(
      rpc(app, dana.cookie, "mcp/servers/update", { id: mine.id, secret: "dana-token" }, space),
    ).resolves.toMatchObject({ hasSecret: true });
    await expect(repoint(owner, linear.id)).resolves.toMatchObject({ status: 200 });

    await rpc(app, owner, "mcp/servers/remove", { id: linear.id }, space);
    await expect(
      raw(app, dana.cookie, "bots/addDeclaredMcp", { botId: bot.id, serverId: linear.id }, space),
    ).resolves.toMatchObject({ status: 404 });
  });

  it("never shares an MCP server whose address may hold a secret", async () => {
    const { owner, space, dana, bot } = await sharedBotSpace("bot-share-mcp-secret");
    const create = (config: Record<string, unknown>) =>
      rpc<{ id: string }>(app, owner, "mcp/servers/create", { enabled: true, ...config }, space);
    const remote = (slug: string, endpoint: string) => ({
      slug,
      name: slug,
      transport: "streamable_http",
      endpoint,
    });
    const keyed = await create(remote("keyed", "https://mcp.keyed.example/mcp?key=abc"));
    const flagged = await create({
      slug: "flagged",
      name: "Flagged",
      transport: "stdio",
      command: "/opt/notes-mcp",
      args: ["--token=abc"],
    });
    const clean = await create(remote("clean", "https://mcp.clean.example/mcp"));
    await rpc(
      app,
      owner,
      "mcp/assignments/replace",
      { botId: bot.id, assignments: [keyed, flagged, clean].map(({ id }) => ({ serverId: id })) },
      space,
    );
    const declare = (...servers: Array<{ id: string }>) =>
      raw(
        app,
        owner,
        "bots/share",
        {
          botId: bot.id,
          visibility: "space",
          userIds: [],
          connectors: servers.map(({ id }) => ({ kind: "mcp", serverId: id })),
        },
        space,
      );

    for (const server of [keyed, flagged]) {
      const refused = await declare(server);
      expect(refused.status).toBe(400);
      expect(await refused.text()).toContain(
        "This server's address holds a secret, so it can't be shared",
      );
    }
    await expect(declare(clean)).resolves.toMatchObject({ status: 200 });

    // An address the owner edits to hold a secret after declaring it is gone for members.
    await rpc(
      app,
      owner,
      "mcp/servers/update",
      { id: clean.id, config: remote("clean", "https://mcp.clean.example/mcp?key=abc") },
      space,
    );
    await expect(
      raw(app, dana.cookie, "bots/declaredMcp", { botId: bot.id, serverId: clean.id }, space),
    ).resolves.toMatchObject({ status: 404 });
    await rpc(app, dana.cookie, "threads/send", { botId: bot.id, text: "Plan the week." }, space);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await appCards(dana.cookie, bot.id, space)).offered).toEqual([]);
  });

  it("keeps a shared bot off the team computer until it is unshared", async () => {
    const { owner, space, bot, listed } = await sharedBotSpace("bot-share-team");
    const share = { botId: bot.id, visibility: "space", userIds: [] };
    const toTeam = { botId: bot.id, mode: "team" };
    await rpc(app, owner, "bots/share", share, space);

    await expect(rpc(app, owner, "bots/setComputer", toTeam, space)).rejects.toThrow(
      "Stop sharing this bot first",
    );
    expect(await listed(owner)).toMatchObject({ computerMode: "dedicated" });

    await rpc(app, owner, "bots/share", { ...share, visibility: "private" }, space);
    await rpc(app, owner, "bots/setComputer", toTeam, space);
    expect(await listed(owner)).toMatchObject({ computerMode: "team" });
  });

  /** A bot shared with Dana and Sam, its dedicated computer running, and Dana's run on it. */
  async function sharedBotComputer(prefix: string) {
    const spaceFixture = await sharedBotSpace(prefix);
    const { owner, space, dana, sam, bot } = spaceFixture;
    const share = { botId: bot.id, visibility: "people", userIds: [dana.userId, sam.userId] };
    await rpc(app, owner, "bots/share", share, space);
    await rpc(app, owner, "computer/boot", { botId: bot.id }, space);
    const { computer } = await handles.prisma.bot.findUniqueOrThrow({
      where: { id: bot.id },
      select: { computer: { select: { id: true } } },
    });
    const computerId = computer!.id;
    const danaThread = (
      await rpc<{ threadId: string }>(app, dana.cookie, "threads/get", { botId: bot.id }, space)
    ).threadId;
    await rpc(app, sam.cookie, "threads/get", { botId: bot.id }, space);
    /** Dana's run holding the bot's computer: running for a worker, or paused for her. */
    const danaRun = async (status: "running" | "waiting_takeover", threadId = danaThread) => {
      const task = await handles.prisma.task.create({
        data: {
          spaceId: space,
          userId: dana.userId,
          botId: bot.id,
          threadId,
          prompt: "Sign in",
          status: "running",
        },
      });
      const run = await handles.prisma.run.create({
        data: {
          spaceId: space,
          userId: dana.userId,
          botId: bot.id,
          threadId,
          taskId: task.id,
          status,
          trigger: "user",
          ...(status === "running" ? { leaseOwner: "worker", leaseFence: 1 } : {}),
        },
      });
      const lease = { runId: run.id, fence: 1, expiresAt: new Date(Date.now() + 60_000) };
      await handles.prisma.computerExecutionLease.upsert({
        where: { computerId_botId: { computerId, botId: bot.id } },
        create: { computerId, botId: bot.id, ...lease },
        update: lease,
      });
      return run;
    };
    const call = (cookie: string, procedure: string, body: object = {}) =>
      raw(app, cookie, procedure, { botId: bot.id, ...body }, space);
    const status = (cookie: string) =>
      rpc<{
        controlHolder: string;
        busyBotName: string | null;
        takeoverRequested: boolean;
        updateAvailable: boolean;
      }>(app, cookie, "computer/status", { botId: bot.id }, space);
    const screen = (cookie: string) =>
      rpc<{ url: string | null }>(app, cookie, "computer/screenUrl", { botId: bot.id }, space);
    const takeover = (cookie: string) =>
      rpc<{ leaseId: string }>(app, cookie, "computer/takeover", { botId: bot.id }, space);
    const release = (cookie: string) =>
      rpc(app, cookie, "computer/release", { botId: bot.id, reason: "done" }, space);
    return {
      ...spaceFixture,
      share,
      computerId,
      danaThread,
      danaRun,
      call,
      status,
      screen,
      takeover,
      release,
    };
  }

  it("lets a member take over only their own run's screen on a shared bot", async () => {
    const fixture = await sharedBotComputer("bot-share-takeover");
    const { owner, space, dana, sam, bot, listed, share, computerId, danaThread } = fixture;
    const { call, status, screen } = fixture;
    const stranger = await signup(app, `bot-share-takeover-stranger-${stamp}@tangow.test`, "Lee");
    // Dana's run asked for her on the screen and holds the bot's computer, as a paused run does.
    const run = await fixture.danaRun("waiting_takeover");
    await handles.prisma.computer.update({
      where: { id: computerId },
      data: { controlRunId: run.id },
    });

    // Neither the owner nor another member takes over Dana's run.
    await expect(call(owner, "computer/takeover")).resolves.toMatchObject({ status: 409 });
    expect(await status(owner)).toMatchObject({ busyBotName: "Notes" });
    await expect(call(sam.cookie, "computer/takeover")).resolves.toMatchObject({ status: 403 });
    expect(await screen(sam.cookie)).toEqual({ url: null });
    expect(await status(sam.cookie)).toMatchObject({ busyBotName: "Notes" });
    await expect(call(stranger, "computer/takeover")).resolves.toMatchObject({ status: 404 });
    await expect(call(stranger, "computer/status")).resolves.toMatchObject({ status: 404 });

    expect(await status(dana.cookie)).toMatchObject({ busyBotName: null, updateAvailable: false });
    await expect(call(dana.cookie, "computer/boot")).resolves.toMatchObject({ status: 200 });
    const granted = await rpc<{ leaseId: string }>(
      app,
      dana.cookie,
      "computer/takeover",
      { botId: bot.id },
      space,
    );
    expect(await status(dana.cookie)).toMatchObject({ controlHolder: "user" });
    expect(await status(owner)).toMatchObject({ controlHolder: "none", busyBotName: "Notes" });
    // Her own screen and browser profile, under her control.
    expect((await screen(dana.cookie)).url?.split("/").at(-1)).toBe(
      `${bot.id}:${dana.userId}?view_only=false`,
    );
    await expect(call(dana.cookie, "computer/heartbeat")).resolves.toMatchObject({ status: 200 });

    // The computer itself stays the owner's.
    for (const [procedure, body] of [
      ["computer/stop", {}],
      ["computer/recover", {}],
      ["computer/reset", {}],
      ["computer/update", {}],
      ["computer/input", { kind: "key", payload: { key: "A" } }],
      ["computer/files", { path: "/" }],
      ["computer/readFile", { path: "MEMORY.md" }],
      ["bots/setComputer", { mode: "team" }],
    ] as const) {
      await expect(call(dana.cookie, procedure, body), procedure).resolves.toMatchObject({
        status: 404,
      });
    }

    // The owner's release leaves Dana's takeover alone; hers resumes her run in her thread.
    await rpc(app, owner, "computer/release", { botId: bot.id, reason: "done" }, space);
    expect(await status(dana.cookie)).toMatchObject({ controlHolder: "user" });
    await rpc(app, dana.cookie, "computer/release", { botId: bot.id, reason: "done" }, space);
    await expect(
      handles.prisma.run.findUniqueOrThrow({ where: { id: run.id } }),
    ).resolves.toMatchObject({ status: "queued", checkpoint: "takeover" });
    const takeoverEvents = await handles.prisma.event.findMany({
      where: { botId: bot.id, type: { startsWith: "computer.takeover" } },
      select: { threadId: true, type: true, payload: true },
      orderBy: { seq: "asc" },
    });
    expect(takeoverEvents).toEqual([
      expect.objectContaining({ threadId: danaThread, type: "computer.takeover.granted" }),
      expect.objectContaining({ threadId: danaThread, type: "computer.takeover.released" }),
    ]);
    expect(takeoverEvents[0]?.payload).toMatchObject({ leaseId: granted.leaseId });
    await expect(call(dana.cookie, "computer/takeover")).resolves.toMatchObject({ status: 403 });

    await rpc(app, owner, "bots/share", { ...share, userIds: [sam.userId] }, space);
    expect(await listed(dana.cookie)).toBeUndefined();
    for (const procedure of ["computer/status", "computer/takeover", "computer/screenUrl"]) {
      await expect(call(dana.cookie, procedure), procedure).resolves.toMatchObject({
        status: 404,
      });
    }
  });

  it("lets a member take over their own run's screen in a group, and nobody else's", async () => {
    const fixture = await sharedBotComputer("group-takeover");
    const { owner, space, dana, sam, bot, computerId, call } = fixture;
    const group = await rpc<{ threadId: string }>(
      app,
      owner,
      "groups/create",
      { name: "Crew", botIds: [bot.id], userIds: [dana.userId] },
      space,
    );
    const run = await fixture.danaRun("waiting_takeover", group.threadId);
    await handles.prisma.computer.update({
      where: { id: computerId },
      data: { controlRunId: run.id },
    });

    await expect(call(sam.cookie, "computer/takeover")).resolves.toMatchObject({ status: 403 });
    await expect(call(dana.cookie, "computer/takeover")).resolves.toMatchObject({ status: 200 });
  });

  it("keeps a group's history once it has several people: nobody clears or rewinds it", async () => {
    const { owner, space, dana, bot } = await sharedBotSpace("group-history");
    const group = await rpc<{ id: string }>(
      app,
      owner,
      "groups/create",
      { name: "Crew", botIds: [bot.id], userIds: [dana.userId] },
      space,
    );
    await rpc(app, owner, "threads/send", { groupId: group.id, text: "Plan the week" }, space);
    const message = await handles.prisma.sessionEntry.findFirstOrThrow({
      where: { session: { thread: { groupId: group.id } }, type: "user.message" },
      select: { id: true },
    });

    for (const cookie of [owner, dana.cookie]) {
      await expect(
        raw(app, cookie, "threads/clear", { groupId: group.id }, space),
      ).resolves.toMatchObject({ status: 403 });
      await expect(
        raw(app, cookie, "threads/rewind", { groupId: group.id, messageId: message.id }, space),
      ).resolves.toMatchObject({ status: 403 });
    }
    await rpc(app, owner, "groups/update", { groupId: group.id, userIds: [] }, space);
    await expect(rpc(app, owner, "threads/clear", { groupId: group.id }, space)).resolves.toEqual({
      ok: true,
    });
  });

  it("lets only a run's person answer its cards in a group", async () => {
    const { owner, space, dana, bot } = await sharedBotSpace("group-answer");
    const group = await rpc<{ id: string }>(
      app,
      owner,
      "groups/create",
      { name: "Crew", botIds: [bot.id], userIds: [dana.userId] },
      space,
    );
    const sent = await rpc<{ runId: string }>(
      app,
      owner,
      "threads/send",
      { groupId: group.id, text: "Plan the week" },
      space,
    );
    const answer = { groupId: group.id, runId: sent.runId, messageId: sent.runId, answer: "yes" };

    await expect(raw(app, dana.cookie, "threads/answer", answer, space)).resolves.toMatchObject({
      status: 403,
    });
    await expect(raw(app, owner, "threads/answer", answer, space)).resolves.toMatchObject({
      status: 409,
    });
  });

  it("keeps the owner's screen when a member's run asks for a takeover while the owner holds it", async () => {
    const fixture = await sharedBotComputer("bot-share-owner-control");
    const { owner, space, dana, bot, computerId, danaThread } = fixture;
    const { call, status, screen, takeover, release } = fixture;
    const owners = await takeover(owner);
    const run = await fixture.danaRun("running");
    const attempt = await handles.prisma.attempt.create({
      data: { runId: run.id, fence: 1, status: "running" },
    });
    await expect(
      pauseRunForTakeover(handles.prisma, {
        spaceId: space,
        threadId: danaThread,
        botId: bot.id,
        runId: run.id,
        attemptId: attempt.id,
        leaseOwner: "worker",
        leaseFence: 1,
        reason: "Sign in",
        computerId,
      }),
    ).resolves.toBe(true);

    // The owner's control is never Dana's: she can't take it, learn its lease or end it.
    const refused = await call(dana.cookie, "computer/takeover");
    expect(refused.status).toBe(409);
    expect(await refused.text()).not.toContain(owners.leaseId);
    expect(await status(dana.cookie)).toMatchObject({
      controlHolder: "none",
      busyBotName: "Notes",
    });
    await release(dana.cookie);
    expect(await status(owner)).toMatchObject({ controlHolder: "user" });

    // Once the owner hands back, the screen waits for Dana, and her thread hears of it.
    await release(owner);
    expect(await status(dana.cookie)).toMatchObject({
      busyBotName: null,
      takeoverRequested: true,
    });
    await expect(
      handles.prisma.event.count({ where: { threadId: danaThread, type: "computer.status" } }),
    ).resolves.toBe(1);
    expect((await takeover(dana.cookie)).leaseId).not.toBe(owners.leaseId);
    expect((await screen(dana.cookie)).url?.split("/").at(-1)).toBe(
      `${bot.id}:${dana.userId}?view_only=false`,
    );
  });

  it("ends an unshared member's takeover at once, screen included", async () => {
    const fixture = await sharedBotComputer("bot-share-unshared-control");
    const { owner, space, dana, sam, bot, share, computerId } = fixture;
    const run = await fixture.danaRun("waiting_takeover");
    await handles.prisma.computer.update({
      where: { id: computerId },
      data: { controlRunId: run.id },
    });
    const { leaseId } = await fixture.takeover(dana.cookie);
    const generations = await handles.prisma.bot.findUniqueOrThrow({
      where: { id: bot.id },
      select: { screenGeneration: true, computer: { select: { screenGeneration: true } } },
    });
    const secret = resolveScreenProxySecret();
    const capability = new URL(
      addScreenProxyCapability(
        "http://127.0.0.1:49152/embed.html?view_only=false",
        secret,
        "http://127.0.0.1:5173",
        {
          botId: bot.id,
          computerId,
          botGeneration: generations.screenGeneration,
          computerGeneration: generations.computer!.screenGeneration,
          controlLeaseId: leaseId,
        },
      ),
    ).pathname;
    const target = () =>
      app.request(SCREEN_TARGET_ENDPOINT, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify({ path: capability }),
      });
    expect((await target()).status).toBe(200);

    await rpc(app, owner, "bots/share", { ...share, userIds: [sam.userId] }, space);
    expect((await target()).status).toBe(403);
    expect(await fixture.status(owner)).toMatchObject({ controlHolder: "none", busyBotName: null });
    await expect(fixture.takeover(owner)).resolves.toMatchObject({
      leaseId: expect.any(String),
    });
  });

  it("renames a space only for its owner", async () => {
    const cookie = await signup(app, `space-rename-${stamp}@tangow.test`, "Space Rename");
    const actor = await rpc<Actor>(app, cookie, "me");
    const renamedDefault = await rpc<Space>(app, cookie, "spaces/rename", {
      spaceId: actor.spaceId,
      name: "  Home  ",
    });
    expect(renamedDefault).toMatchObject({ id: actor.spaceId, name: "Home", canRename: true });
    for (const name of ["   ", "x".repeat(61)]) {
      await expect(
        raw(app, cookie, "spaces/rename", { spaceId: actor.spaceId, name }),
      ).resolves.toMatchObject({ status: 400 });
    }

    const shared = await rpc<Space>(app, cookie, "spaces/create", { name: "Shared" });
    const { organizationId } = await handles.prisma.space.findUniqueOrThrow({
      where: { id: shared.id },
      select: { organizationId: true },
    });
    const memberCookie = await signup(app, `space-rename-member-${stamp}@tangow.test`, "Member");
    const member = await rpc<Actor>(app, memberCookie, "me");
    await handles.prisma.member.deleteMany({ where: { userId: member.userId } });
    await handles.prisma.member.create({
      data: {
        id: `space-rename-org-member-${stamp}`,
        organizationId,
        userId: member.userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    await handles.prisma.spaceMember.create({
      data: {
        id: `space-rename-space-member-${stamp}`,
        spaceId: shared.id,
        organizationId,
        userId: member.userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    const memberNavigation = await rpc<SpaceNavigation>(
      app,
      memberCookie,
      "spaces/list",
      {},
      shared.id,
    );
    expect(memberNavigation.spaces.find((space) => space.id === shared.id)?.canRename).toBe(false);
    await expect(
      raw(app, memberCookie, "spaces/rename", { spaceId: shared.id, name: "Taken" }, shared.id),
    ).resolves.toMatchObject({ status: 403 });

    const intruder = await signup(app, `space-rename-intruder-${stamp}@tangow.test`, "Intruder");
    await expect(
      raw(app, intruder, "spaces/rename", { spaceId: shared.id, name: "Taken" }),
    ).resolves.toMatchObject({ status: 404 });

    await handles.prisma.space.update({
      where: { id: shared.id },
      data: { deletingAt: new Date() },
    });
    await expect(
      raw(app, cookie, "spaces/rename", { spaceId: shared.id, name: "Late" }),
    ).resolves.toMatchObject({ status: 409 });
    await handles.prisma.space.update({ where: { id: shared.id }, data: { deletingAt: null } });

    await expect(
      rpc<Space>(app, cookie, "spaces/rename", { spaceId: shared.id, name: "Team" }),
    ).resolves.toMatchObject({ id: shared.id, name: "Team", canRename: true });
  });

  it("blocks bot creation after empty space deletion is claimed", async () => {
    const cookie = await signup(app, `space-race-${stamp}@tangow.test`, "Space Race");
    const actor = await rpc<Actor>(app, cookie, "me");
    const space = await rpc<Space>(app, cookie, "spaces/create", { name: "Concurrent" });
    await handles.prisma.computer.create({
      data: {
        spaceId: space.id,
        userId: actor.userId,
        scopeKey: `space-race-scope-${stamp}`,
        homeKey: `space-race-home-${stamp}`,
        kind: "fake",
        providerRef: `space-race-provider-${stamp}`,
      },
    });
    const deleteInput = {
      currentSpaceId: space.id,
      userId: actor.userId,
      spaceId: space.id,
    };

    const firstClaim = await claimEmptySpaceDeletionForMember(handles.prisma, deleteInput);
    expect(firstClaim.recovered).toBe(false);
    expect(firstClaim.computers).toEqual([
      expect.objectContaining({ providerRef: `space-race-provider-${stamp}` }),
    ]);
    await expect(
      renewSpaceDeletionClaim(handles.prisma, { ...deleteInput, claimId: firstClaim.claimId }),
    ).resolves.toBe(true);
    const claimedNavigation = await rpc<SpaceNavigation>(app, cookie, "spaces/list", {}, space.id);
    expect(claimedNavigation.spaces.find((item) => item.id === space.id)?.canDelete).toBe(false);
    const blockedCreate = await raw(app, cookie, "bots/create", botInput("Racing bot"), space.id);
    expect(blockedCreate.ok).toBe(false);
    expect(blockedCreate.status).toBe(409);
    expect(await handles.prisma.bot.count({ where: { spaceId: space.id } })).toBe(0);
    expect(
      await handles.prisma.computer.findFirst({
        where: { spaceId: space.id },
        select: { providerRef: true },
      }),
    ).toEqual({ providerRef: `space-race-provider-${stamp}` });

    await handles.prisma.space.update({
      where: { id: space.id },
      data: { deletingAt: new Date(Date.now() - 6 * 60_000) },
    });
    const replacementClaim = await claimEmptySpaceDeletionForMember(handles.prisma, deleteInput);
    expect(replacementClaim.recovered).toBe(true);
    await expect(
      deleteEmptySpaceForMember(handles.prisma, { ...deleteInput, claimId: firstClaim.claimId }),
    ).rejects.toThrow("Space deletion is already in progress");
    await releaseSpaceDeletionClaim(handles.prisma, {
      ...deleteInput,
      claimId: firstClaim.claimId,
    });
    expect(
      await handles.prisma.space.findUnique({
        where: { id: space.id },
        select: { deletionClaimId: true },
      }),
    ).toEqual({ deletionClaimId: replacementClaim.claimId });
    await releaseSpaceDeletionClaim(handles.prisma, {
      ...deleteInput,
      claimId: replacementClaim.claimId,
    });
    const created = await raw(app, cookie, "bots/create", botInput("After retry"), space.id);
    expect(created.ok).toBe(true);
  });

  it("keeps a space claimed after ambiguous sandbox teardown failure", async () => {
    const cookie = await signup(app, `space-teardown-${stamp}@tangow.test`, "Teardown");
    const actor = await rpc<Actor>(app, cookie, "me");
    const space = await rpc<Space>(app, cookie, "spaces/create", { name: "Teardown" });
    await handles.prisma.computer.create({
      data: {
        spaceId: space.id,
        userId: actor.userId,
        scopeKey: `space-teardown-scope-${stamp}`,
        homeKey: `space-teardown-home-${stamp}`,
        kind: "fake",
        providerRef: `space-teardown-provider-${stamp}`,
      },
    });
    const destroy = vi
      .spyOn(handles.sandbox, "destroy")
      .mockRejectedValueOnce(new Error("ambiguous provider failure"));

    try {
      const removed = await raw(app, cookie, "spaces/remove", { spaceId: space.id }, space.id);
      expect(removed.status).toBe(500);
      const lifecycle = await handles.prisma.space.findUnique({
        where: { id: space.id },
        select: { deletingAt: true, deletionClaimId: true },
      });
      expect(lifecycle?.deletingAt).toBeInstanceOf(Date);
      expect(lifecycle?.deletionClaimId).toBeTruthy();
      expect(
        await handles.prisma.computer.findFirst({
          where: { spaceId: space.id },
          select: { providerRef: true },
        }),
      ).toEqual({ providerRef: `space-teardown-provider-${stamp}` });
      const blockedCreate = await raw(
        app,
        cookie,
        "bots/create",
        botInput("Blocked after teardown"),
        space.id,
      );
      expect(blockedCreate.ok).toBe(false);
    } finally {
      destroy.mockRestore();
      const lifecycle = await handles.prisma.space.findUnique({
        where: { id: space.id },
        select: { deletionClaimId: true },
      });
      if (lifecycle?.deletionClaimId) {
        await releaseSpaceDeletionClaim(handles.prisma, {
          currentSpaceId: space.id,
          spaceId: space.id,
          userId: actor.userId,
          claimId: lifecycle.deletionClaimId,
        });
      }
    }
  });

  it("times out a hung sandbox teardown without unblocking the space", async () => {
    const cookie = await signup(app, `space-deadline-${stamp}@tangow.test`, "Deadline");
    const actor = await rpc<Actor>(app, cookie, "me");
    const space = await rpc<Space>(app, cookie, "spaces/create", { name: "Deadline" });
    await handles.prisma.computer.create({
      data: {
        spaceId: space.id,
        userId: actor.userId,
        scopeKey: `space-deadline-scope-${stamp}`,
        homeKey: `space-deadline-home-${stamp}`,
        kind: "fake",
        providerRef: `space-deadline-provider-${stamp}`,
      },
    });
    process.env.SPACE_TEARDOWN_TIMEOUT_MS = "50";
    const destroy = vi
      .spyOn(handles.sandbox, "destroy")
      .mockImplementation(() => new Promise(() => undefined));

    try {
      const removed = await raw(app, cookie, "spaces/remove", { spaceId: space.id }, space.id);
      expect(removed.status).toBe(500);
      const lifecycle = await handles.prisma.space.findUnique({
        where: { id: space.id },
        select: { deletingAt: true, deletionClaimId: true },
      });
      expect(lifecycle?.deletingAt).toBeInstanceOf(Date);
      expect(lifecycle?.deletionClaimId).toBeTruthy();
      const blockedCreate = await raw(
        app,
        cookie,
        "bots/create",
        botInput("Blocked during teardown"),
        space.id,
      );
      expect(blockedCreate.status).toBe(409);
    } finally {
      destroy.mockRestore();
      delete process.env.SPACE_TEARDOWN_TIMEOUT_MS;
      const lifecycle = await handles.prisma.space.findUnique({
        where: { id: space.id },
        select: { deletionClaimId: true },
      });
      if (lifecycle?.deletionClaimId) {
        await releaseSpaceDeletionClaim(handles.prisma, {
          currentSpaceId: space.id,
          spaceId: space.id,
          userId: actor.userId,
          claimId: lifecycle.deletionClaimId,
        });
      }
    }
  });

  it("validates custom thinking against the saved connection capability", async () => {
    const cookie = await signup(app, `custom-thinking-${stamp}@tangow.test`, "Custom Thinking");
    const bot = await rpc<Bot>(app, cookie, "bots/create", botInput("Thinking Bot"));
    const connection = {
      provider: "openai-compatible",
      modelId: "arbitrary-model",
      baseUrl: "http://localhost:8000/v1",
    };
    await rpc(app, cookie, "models/connect", {
      ...connection,
      apiKey: "fake-saved-key",
      reasoning: false,
    });
    await rpc(app, cookie, "models/connect", { ...connection, reasoning: true });
    const actor = await rpc<Actor>(app, cookie, "me");
    expect(
      await handles.executor.resolveModel({
        userId: actor.userId,
        spaceId: actor.spaceId,
        botId: bot.id,
      }),
    ).toMatchObject({ apiKey: "fake-saved-key", reasoning: true });
    const update = {
      botId: bot.id,
      modelProvider: connection.provider,
      modelId: connection.modelId,
    };
    expect(
      await rpc(app, cookie, "bots/update", { ...update, thinkingLevel: "low" }),
    ).toMatchObject({ thinkingLevel: "low" });
    expect(
      (await raw(app, cookie, "bots/update", { ...update, thinkingLevel: "xhigh" })).status,
    ).toBe(400);
    await rpc(app, cookie, "models/connect", { ...connection, reasoning: false });
    expect(
      (await raw(app, cookie, "bots/update", { ...update, thinkingLevel: "low" })).status,
    ).toBe(400);
    expect(
      await rpc(app, cookie, "bots/update", { ...update, thinkingLevel: "off" }),
    ).toMatchObject({ thinkingLevel: "off" });
  });

  it("validates per-bot model overrides against connected providers and catalog", async () => {
    const cookie = await signup(app, `bot-model-${stamp}@tangow.test`, "Bot Model");
    const bot = await rpc<
      Bot & {
        modelProvider: string | null;
        modelId: string | null;
        thinkingLevel: string | null;
      }
    >(app, cookie, "bots/create", botInput("Model Bot"));
    await rpc(app, cookie, "models/connect", {
      provider: "xai",
      apiKey: "fake-xai-key-not-real",
      label: "xAI",
      modelId: "grok-4.6",
    });

    const updated = await rpc<
      Bot & {
        modelProvider: string | null;
        modelId: string | null;
        thinkingLevel: string | null;
      }
    >(app, cookie, "bots/update", {
      botId: bot.id,
      modelProvider: "xai",
      modelId: "grok-4.6",
      thinkingLevel: "high",
    });
    expect(updated).toMatchObject({
      modelProvider: "xai",
      modelId: "grok-4.6",
      thinkingLevel: "high",
    });

    const unknown = await raw(app, cookie, "bots/update", {
      botId: bot.id,
      modelProvider: "xai",
      modelId: "not-a-real-grok",
    });
    expect(unknown.status).toBeGreaterThanOrEqual(400);
    expect(await unknown.text()).toMatch(/unknown model/i);

    const disconnected = await raw(app, cookie, "bots/update", {
      botId: bot.id,
      modelProvider: "anthropic",
      modelId: "claude-opus-4-6",
    });
    expect(disconnected.status).toBeGreaterThanOrEqual(400);
    expect(await disconnected.text()).toMatch(/connect/i);

    const partialClear = await raw(app, cookie, "bots/update", {
      botId: bot.id,
      modelId: null,
    });
    expect(partialClear.status).toBeGreaterThanOrEqual(400);
    expect(await partialClear.text()).toMatch(/both be set or both cleared/i);
  });

  it("chooses the newest duplicate provider credential when selecting a default", async () => {
    const cookie = await signup(app, `model-duplicates-${stamp}@tangow.test`, "Model Duplicates");
    const actor = await rpc<Actor>(app, cookie, "me");
    const olderSecret = await handles.prisma.secret.create({
      data: {
        userId: actor.userId,
        spaceId: null,
        kind: "model",
        ciphertext: "encrypted-older-key",
      },
    });
    const newerSecret = await handles.prisma.secret.create({
      data: {
        userId: actor.userId,
        spaceId: null,
        kind: "model",
        ciphertext: "encrypted-newer-key",
      },
    });
    const older = await handles.prisma.userModelCredential.create({
      data: {
        userId: actor.userId,
        provider: "duplicate-provider",
        label: "Older",
        secretId: olderSecret.id,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-02T00:00:00.000Z"),
      },
    });
    const newer = await handles.prisma.userModelCredential.create({
      data: {
        userId: actor.userId,
        provider: "duplicate-provider",
        label: "Newer",
        secretId: newerSecret.id,
        createdAt: new Date("2026-02-01T00:00:00.000Z"),
        updatedAt: new Date("2026-02-02T00:00:00.000Z"),
      },
    });
    await handles.prisma.spaceModelPreference.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        credentialId: older.id,
        modelId: "older/model",
        isDefault: true,
      },
    });

    await rpc(app, cookie, "models/setDefault", {
      provider: "duplicate-provider",
      modelId: "newer/selected",
    });

    const preferences = await handles.prisma.spaceModelPreference.findMany({
      where: { userId: actor.userId, spaceId: actor.spaceId },
    });
    expect(preferences.filter((row) => row.isDefault).map((row) => row.credentialId)).toEqual([
      newer.id,
    ]);
    expect(preferences.find((row) => row.credentialId === newer.id)).toMatchObject({
      isDefault: true,
      modelId: "newer/selected",
    });
    expect(preferences.find((row) => row.credentialId === older.id)).toMatchObject({
      isDefault: false,
      modelId: "older/model",
    });
    const listed = await rpc<ModelCredential[]>(app, cookie, "models/credentials");
    expect(
      listed.filter((row) => row.provider === "duplicate-provider").map((row) => row.id),
    ).toEqual([newer.id, older.id]);
  });

  it("restricts deployment settings to the deployment owner", async () => {
    const owner = await signup(app, `deployment-owner-${stamp}@tangow.test`, "Deployment Owner");
    const other = await signup(app, `deployment-other-${stamp}@tangow.test`, "Deployment Other");
    const ownerActor = await rpc<Actor>(app, owner, "me");
    const otherActor = await rpc<Actor>(app, other, "me");
    // This test changes a live allowlist; the operator has already proved
    // ownership of the mailbox. Endpoint verification has offline auth tests.
    await handles.prisma.user.update({
      where: { id: ownerActor.userId },
      data: { emailVerified: true },
    });
    await handles.prisma.deploymentSettings.update({
      where: { id: "default" },
      data: {
        ownerUserId: ownerActor.userId,
        signupsEnabled: true,
        signupAllowlist: "",
      },
    });

    expect(otherActor.userId).not.toBe(ownerActor.userId);

    await rpc(app, owner, "deployment/get");
    await expectDenied(app, other, "deployment/get", {});
    await expectDenied(app, other, "deployment/update", {
      signupsEnabled: false,
      signupAllowlist: ["attacker@example.test"],
    });
    await expectForbidden(app, other, "updater/status", {});
    await expectForbidden(app, other, "updater/check", {});
    await expectForbidden(app, other, "updater/apply", {});
    expect(
      await handles.prisma.deploymentSettings.findUniqueOrThrow({ where: { id: "default" } }),
    ).toMatchObject({ signupsEnabled: true, signupAllowlist: "" });

    try {
      await rpc(app, owner, "deployment/update", { signupsEnabled: false });
      const closedSignup = await app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: `closed-${stamp}@tangow.test`,
          password: "password123",
          name: "Closed Signup",
        }),
      });
      expect(closedSignup.status).toBe(400);
      expect(await closedSignup.json()).toEqual({
        code: "REGISTRATION_CLOSED",
        message: "Registration is closed",
      });

      const approvedEmail = `approved-${stamp}@example.test`;
      await rpc(app, owner, "deployment/update", {
        signupsEnabled: true,
        signupAllowlist: [approvedEmail],
      });
      const disallowedSignup = await app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: `not-approved-${stamp}@tangow.test`,
          password: "password123",
          name: "Disallowed Signup",
        }),
      });
      expect(disallowedSignup.status).toBe(400);
      expect(await disallowedSignup.json()).toEqual({
        code: "EMAIL_NOT_ALLOWED",
        message: "Email is not allowed to register",
      });
      const unverifiedSignup = await app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: approvedEmail,
          password: "password123",
          name: "Approved Signup",
        }),
      });
      expect(unverifiedSignup.status).toBe(400);
      expect(await unverifiedSignup.json()).toEqual({
        code: "EMAIL_DELIVERY_REQUIRED",
        message: "Registration requires email delivery",
      });
    } finally {
      await rpc(app, owner, "deployment/update", {
        signupsEnabled: true,
        signupAllowlist: [],
      });
    }
  });
});

function botInput(name: string) {
  return {
    name,
    title: "",
    description: "",
    instructions: "",
    notifyOnFinish: false,
  };
}

function routineInput(botId: string) {
  return {
    botId,
    name: "Owner Routine",
    prompt: "owner-only prompt",
    crons: ["0 9 * * 1"],
    timezone: "UTC",
    notify: false,
    active: false,
  };
}

function skillPlaybookInput() {
  return {
    whenToUse: "When needed",
    inputs: ["example"],
    steps: ["Do the thing"],
    howToCheck: "Verify result",
    whatToReturn: "Summary",
    approvalBoundaries: "Ask first",
    failureHandling: "Stop and ask",
  };
}

function capabilityInput(name: string) {
  return { kind: "skill", name, source: "test://authorization", config: {} };
}

function connectionInput(displayName: string) {
  return { provider: "test-provider", displayName };
}

async function signup(app: App, email: string, name: string) {
  const response = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ email, password: "password12", name }),
  });
  if (response.status >= 400) {
    throw new Error(`signup failed ${response.status}: ${await response.text()}`);
  }
  return sessionCookieHeader(response);
}

async function raw(
  app: App,
  cookie: string,
  procedure: string,
  body: unknown = {},
  spaceId?: string,
) {
  return app.request(`/rpc/${procedure}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...(spaceId ? { "x-tangow-space-id": spaceId } : {}),
      origin: "http://127.0.0.1:5173",
    },
    body: JSON.stringify({ json: body ?? {} }),
  });
}

async function rpc<T>(
  app: App,
  cookie: string,
  procedure: string,
  body: unknown = {},
  spaceId?: string,
): Promise<T> {
  const response = await raw(app, cookie, procedure, body, spaceId);
  const text = await response.text();
  const payload = JSON.parse(text) as { json?: T; error?: { message?: string } };
  if (response.status >= 400 || payload.error) {
    throw new Error(`${procedure} ${response.status}: ${payload.error?.message ?? text}`);
  }
  return payload.json as T;
}

async function expectDenied(
  app: App,
  cookie: string,
  procedure: string,
  body: unknown,
  spaceId?: string,
) {
  const response = await raw(app, cookie, procedure, body, spaceId);
  if (procedure === "threads/subscribe" && response.status === 200) {
    // Streaming transports commit the HTTP 200 before advancing the async iterator. The
    // ownership error is therefore encoded in the iterator response instead of the status.
    expect(await response.text(), procedure).toMatch(/error|forbidden|not.found|unauthorized/i);
    return;
  }
  expect(response.status, procedure).toBeGreaterThanOrEqual(400);
}

async function expectForbidden(app: App, cookie: string, procedure: string, body: unknown) {
  const response = await raw(app, cookie, procedure, body);
  expect(response.status, procedure).toBe(403);
  expect(await response.text(), procedure).toMatch(/forbidden/i);
}

interface Actor {
  userId: string;
  spaceId: string;
}

interface ModelCredential {
  id: string;
  provider: string;
  label: string;
  hasKey: boolean;
  isDefault: boolean;
}

interface Bot {
  id: string;
}

interface SharedBot {
  id: string;
  threadId: string;
  isOwner: boolean;
  status: string;
  instructions: string;
  modelId: string | null;
}

function exhaustiveProtectedCalls<
  const Calls extends ReadonlyArray<readonly [ProtectedRpcPath, unknown?]>,
>(calls: Calls & (ProtectedRpcPath extends Calls[number][0] ? unknown : never)): Calls {
  return calls;
}
