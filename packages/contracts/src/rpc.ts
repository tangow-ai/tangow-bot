import { eventIterator, oc } from "@orpc/contract";
import * as z from "zod";
import { ATTACHMENT_MAX_BASE64_LENGTH, ATTACHMENT_MAX_COUNT } from "./attachments.js";
import {
  BotSecretDestination,
  BotSecretName,
  VaultList,
  VaultPutInput,
  VaultShareInput,
} from "./bot-secrets.js";
import {
  ActionApprovalRuleSchema,
  ActionAutoReviewSettingsSchema,
  AgentSecretInputSchema,
  AgentSecretSchema,
  AgentSkillCatalogEntrySchema,
  AgentSkillSchema,
  AppBootstrapSchema,
  ArtifactSchema,
  ArtifactWithContentSchema,
  AvatarStyleSchema,
  BotMcpServerSchema,
  BotSchema,
  BotSectionSchema,
  BotSharingSchema,
  CapabilityInstallSchema,
  ComputerListItemSchema,
  ComputerModeSchema,
  ComputerReleaseReasonSchema,
  ComputerStatusSchema,
  ComputerUpdateAllResultSchema,
  ComputerUpdateSchema,
  ConnectionCatalogItemSchema,
  ConnectionSchema,
  CreateAgentSkillInput,
  CreateBotInput,
  CreateGroupInput,
  CreateRoutineInput,
  CreateScratchpadItemInput,
  DeclaredMcpSchema,
  DeploymentSettingsSchema,
  ExportManifestSchema,
  ExternalConversationPolicySchema,
  GroupSchema,
  ImportAgentSkillInput,
  McpServerConfigInput,
  McpServerSchema,
  MemoryDocumentSchema,
  MemoryScopeSchema,
  MeSchema,
  MessagingAgentConnectionSchema,
  MessagingChannelMembershipSchema,
  MessagingLinkedIdentitySchema,
  MessagingStatusSchema,
  ModelCatalogEntrySchema,
  ModelConnectInputSchema,
  ModelCredentialSchema,
  ModelOAuthBeginSchema,
  REPLY_QUOTE_MAX_LENGTH,
  ReorderBotsInput,
  RoutineSchema,
  ScratchpadItemSchema,
  ScratchpadItemStatusSchema,
  ServerUpdateCheckSchema,
  ServerUpdateRequestSchema,
  ServerUpdateRunSchema,
  ServerUpdateStatusSchema,
  SkillAvailabilitySchema,
  SkillPlaybookSchema,
  SpaceDecisionConfigSchema,
  SpaceInvitationSchema,
  SpaceMembersSchema,
  SpaceMemoryConfigSchema,
  SpaceNavigationSchema,
  SpaceSchema,
  TaughtSkillSchema,
  TeachRecordingEventSchema,
  ThreadMessagePageSchema,
  ThreadSnapshotSchema,
  UpdateAgentSkillInput,
  UpdateBotInput,
  UpdateExternalConversationPolicyInput,
  UpdateGroupInput,
  UsageCellSchema,
  UsagePeriodSchema,
  VoiceCatalogEntrySchema,
  VoiceCredentialSchema,
  VoiceInfoSchema,
  VoiceStatusSchema,
} from "./domain.js";
import {
  ASK_ANSWER_MAX_LENGTH,
  ASK_DRAFT_TEXT_MAX_LENGTH,
  AskDraftEdits,
  ProductEventSchema,
} from "./events.js";
import { Id, IsoDate, MemoryScope } from "./ids.js";
import {
  IntegrationProviderConfigSchema,
  IntegrationSetupStateSchema,
} from "./integration-settings.js";
import {
  LINK_PREVIEW_PAGE_HEAD_MAX_LENGTH,
  LINK_PREVIEW_PAGE_HEAD_TYPE_MAX_LENGTH,
  LINK_PREVIEW_URL_MAX_LENGTH,
  LinkPreviewDraftSchema,
} from "./link-preview.js";
import { McpHeadersSchema } from "./mcp.js";
import { ModelCategoryAssignmentSchema, ModelCategorySchema } from "./model-routing.js";
import { MessageReactionSchema } from "./reactions.js";
import {
  BotActivityInputSchema,
  BotActivityOutputSchema,
  RunRecapSchema,
  RunsListOutputSchema,
} from "./runs.js";
import { SearchQueryOutputSchema } from "./search.js";
import { EntryId, SessionEntrySchema, SessionId } from "./session-log.js";

const botId = z.object({ botId: Id });
const groupId = z.object({ groupId: Id });

const threadTarget = z
  .object({
    botId: Id.optional(),
    groupId: Id.optional(),
  })
  .superRefine((input, ctx) => {
    const hasBot = Boolean(input.botId);
    const hasGroup = Boolean(input.groupId);
    if (hasBot === hasGroup) {
      ctx.addIssue({
        code: "custom",
        message: "Provide exactly one of botId or groupId",
        path: ["botId"],
      });
    }
  });

const structuredMentionTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("bot"), id: Id }),
  z.object({ kind: z.literal("group"), id: Id }),
  z.object({ kind: z.literal("routine"), id: Id }),
  z.object({ kind: z.literal("connector"), id: Id }),
]);

export const SessionEntriesSchema = z.object({
  entries: z.array(SessionEntrySchema),
  /** The read stopped at its cap, so the oldest entries are missing. */
  truncated: z.literal(true).optional(),
});
export type SessionEntries = z.infer<typeof SessionEntriesSchema>;

const threadSendInput = threadTarget
  .safeExtend({
    text: z.string().optional(),
    artifactIds: z.array(Id).max(ATTACHMENT_MAX_COUNT).optional(),
    /** Bare bot ids (legacy) or typed mention chips from the composer. */
    mentions: z
      .array(z.union([Id, structuredMentionTarget]))
      .max(64)
      .optional(),
    replyToMessageId: Id.optional(),
    replyQuote: z.string().trim().min(1).max(REPLY_QUOTE_MAX_LENGTH).optional(),
    clientNonce: z.string().min(1).max(200).optional(),
    /** `false` opts this message out of any link preview, whatever its first link. */
    linkPreview: z.literal(false).optional(),
    /** The waiting mail draft this message replaces, as the user left it. */
    draft: AskDraftEdits.extend({ messageId: Id, text: z.string().max(ASK_DRAFT_TEXT_MAX_LENGTH) })
      .strict()
      .optional(),
  })
  .superRefine((input, ctx) => {
    const text = input.text?.trim() ?? "";
    const artifactIds = input.artifactIds ?? [];
    if (!text && artifactIds.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "Provide text or at least one attachment",
        path: ["text"],
      });
    }
    if (input.replyQuote && !input.replyToMessageId) {
      ctx.addIssue({
        code: "custom",
        message: "replyQuote requires replyToMessageId",
        path: ["replyQuote"],
      });
    }
  });

const SpaceNameSchema = z.string().trim().min(1).max(60);
const SpaceInviteTokenSchema = z.string().min(1).max(128);

export const appContract = {
  // Mobile 2026.11.0 and earlier ask this before every send and block on a 404. Remove once they are gone.
  aiConsent: {
    status: oc.input(z.unknown()).output(z.object({ recipients: z.tuple([]) })),
  },
  health: oc.output(z.object({ ok: z.literal(true), version: z.string() })),
  me: oc.output(MeSchema),
  preferences: {
    update: oc.input(z.object({ avatarStyle: AvatarStyleSchema })).output(MeSchema),
  },
  spaces: {
    list: oc.output(SpaceNavigationSchema),
    create: oc.input(z.object({ name: SpaceNameSchema })).output(SpaceSchema),
    rename: oc.input(z.object({ spaceId: Id, name: SpaceNameSchema })).output(SpaceSchema),
    remove: oc
      .input(z.object({ spaceId: Id }))
      .output(z.object({ ok: z.literal(true), activeSpaceId: Id })),
    members: oc.input(z.object({ spaceId: Id })).output(SpaceMembersSchema),
    /** Owner only. Skips people already in the space; inviting an email again extends its invite. */
    createInvite: oc
      .input(z.object({ spaceId: Id, emails: z.array(z.email()).min(1).max(20) }))
      .output(z.object({ invitations: z.array(SpaceInvitationSchema) })),
    revokeInvite: oc
      .input(z.object({ spaceId: Id, invitationId: Id }))
      .output(z.object({ ok: z.literal(true) })),
    removeMember: oc
      .input(z.object({ spaceId: Id, userId: Id }))
      .output(z.object({ ok: z.literal(true) })),
    /** Null once the link has expired, been used or been revoked. */
    invitation: oc.input(z.object({ token: SpaceInviteTokenSchema })).output(
      z
        .object({
          spaceName: z.string(),
          inviterName: z.string(),
          email: z.string(),
          /** False when the caller's account has another email: they can't accept. */
          forYou: z.boolean(),
        })
        .nullable(),
    ),
    acceptInvite: oc
      .input(z.object({ token: SpaceInviteTokenSchema }))
      .output(z.object({ spaceId: Id })),
  },
  bootstrap: oc.input(z.object({ botId: Id.optional() })).output(AppBootstrapSchema),
  deployment: {
    get: oc.output(DeploymentSettingsSchema),
    update: oc
      .input(
        z.object({
          signupsEnabled: z.boolean().optional(),
          signupAllowlist: z.array(z.string()).optional(),
        }),
      )
      .output(DeploymentSettingsSchema),
  },
  /**
   * Deployment-owner product updates. When the Compose updater sidecar is reachable, these proxy
   * to its `/state` `/plan` `/apply` contract. Rollback stays on the sidecar for ops only and is
   * not exposed here. Never git-fetch from the API process.
   */
  updater: {
    status: oc.output(ServerUpdateStatusSchema),
    check: oc.input(ServerUpdateRequestSchema).output(ServerUpdateCheckSchema),
    apply: oc.input(ServerUpdateRequestSchema).output(ServerUpdateRunSchema),
  },
  models: {
    list: oc.output(z.array(ModelCatalogEntrySchema)),
    routing: oc.output(
      z.object({ auto: z.boolean(), categories: z.array(ModelCategoryAssignmentSchema) }),
    ),
    credentials: oc.output(z.array(ModelCredentialSchema)),
    connect: oc.input(ModelConnectInputSchema).output(ModelCredentialSchema),
    probeOpenAiCompatible: oc
      .input(
        z.object({
          baseUrl: z.string(),
          apiKey: z.string().optional(),
        }),
      )
      .output(z.object({ models: z.array(z.string()) })),
    beginOAuth: oc
      .input(
        z.object({
          provider: z.string(),
          label: z.string().optional(),
          modelId: z.string().optional(),
        }),
      )
      .output(ModelOAuthBeginSchema),
    submitOAuthCode: oc
      .input(z.object({ loginId: z.string(), code: z.string().trim().min(1).max(8_192) }))
      .output(z.object({ ok: z.literal(true) })),
    completeOAuth: oc
      .input(z.object({ loginId: z.string() }))
      .output(
        z.discriminatedUnion("status", [
          z.object({ status: z.literal("pending") }),
          z.object({ status: z.literal("ready") }),
          z.object({ status: z.literal("error"), error: z.string() }),
        ]),
      ),
    finishOAuth: oc.input(z.object({ loginId: z.string() })).output(ModelCredentialSchema),
    cancelOAuth: oc
      .input(z.object({ loginId: z.string() }))
      .output(z.object({ ok: z.literal(true) })),
    setCategory: oc.input(ModelCategoryAssignmentSchema).output(z.object({ ok: z.literal(true) })),
    clearCategory: oc
      .input(z.object({ category: ModelCategorySchema }))
      .output(z.object({ ok: z.literal(true) })),
    setAuto: oc.input(z.object({ enabled: z.boolean() })).output(z.object({ ok: z.literal(true) })),
    setDefault: oc
      .input(z.object({ provider: z.string(), modelId: z.string() }))
      .output(z.object({ ok: z.literal(true) })),
  },
  bots: {
    list: oc.output(z.array(BotSchema)),
    listArchived: oc.output(z.array(BotSchema)),
    get: oc.input(botId).output(BotSchema),
    activity: oc.input(BotActivityInputSchema).output(BotActivityOutputSchema),
    create: oc.input(CreateBotInput).output(BotSchema),
    duplicate: oc.input(botId).output(BotSchema),
    reorder: oc.input(ReorderBotsInput).output(z.object({ ok: z.literal(true) })),
    update: oc.input(UpdateBotInput).output(BotSchema),
    setComputer: oc.input(z.object({ botId: Id, mode: ComputerModeSchema })).output(BotSchema),
    archive: oc.input(botId).output(z.object({ ok: z.literal(true) })),
    restore: oc.input(botId).output(z.object({ ok: z.literal(true) })),
    remove: oc
      .input(z.object({ botId: Id, deleteMemories: z.boolean().default(false) }))
      .output(z.object({ ok: z.literal(true) })),
    /** The bot's webhook key for its owner, created on the first read; a read never replaces a key. */
    webhookSecret: oc.input(botId).output(z.object({ secret: z.string() })),
    /**
     * Replaces the bot's webhook key. `ifAbsent` serves app builds that predate `webhookSecret`:
     * it stores a key only when the bot has none and answers `secret: null` otherwise.
     */
    rotateWebhookSecret: oc.input(botId.extend({ ifAbsent: z.boolean().optional() })).output(
      z.object({
        secret: z.string().nullable(),
        path: z.string(),
        webhookConfigured: z.literal(true),
      }),
    ),
    /** Who the bot is shared with; its owner only. */
    sharing: oc.input(botId).output(BotSharingSchema),
    /** Owner only. People must be members of the bot's Space. */
    share: oc
      .input(
        botId.extend({
          ...BotSharingSchema.shape,
          /** Left out: the declared apps stay as they are. */
          connectors: BotSharingSchema.shape.connectors.optional(),
        }),
      )
      .output(BotSharingSchema),
    /** An MCP server declared on a bot shared with the caller, without its credentials. */
    declaredMcp: oc.input(botId.extend({ serverId: Id })).output(DeclaredMcpSchema),
    /**
     * Adds a declared MCP server to the caller's own servers with their own credentials, keyed by
     * the declared names, and gives it to the shared bot for the caller only.
     */
    addDeclaredMcp: oc
      .input(
        botId.extend({
          serverId: Id,
          headers: McpHeadersSchema.default({}),
          env: z.record(z.string(), z.string().max(4096)).default({}),
          secret: z.string().max(16384).optional(),
        }),
      )
      .output(McpServerSchema),
  },
  groups: {
    create: oc.input(CreateGroupInput).output(GroupSchema),
    list: oc.output(z.array(GroupSchema)),
    listArchived: oc.output(z.array(GroupSchema)),
    get: oc.input(groupId).output(GroupSchema),
    duplicate: oc.input(groupId).output(GroupSchema),
    update: oc.input(UpdateGroupInput).output(GroupSchema),
    archive: oc.input(groupId).output(z.object({ ok: z.literal(true) })),
    restore: oc.input(groupId).output(z.object({ ok: z.literal(true) })),
    remove: oc.input(groupId).output(z.object({ ok: z.literal(true) })),
    /** Someone other than its creator leaves a group. */
    leave: oc.input(groupId).output(z.object({ ok: z.literal(true) })),
  },
  botSections: {
    list: oc.output(z.array(BotSectionSchema)),
    create: oc
      .input(threadTarget.safeExtend({ name: z.string().trim().min(1).max(60) }))
      .output(BotSectionSchema),
    update: oc
      .input(z.object({ sectionId: Id, name: z.string().trim().min(1).max(60) }))
      .output(BotSectionSchema),
  },
  threads: {
    head: oc.input(threadTarget).output(
      z.object({
        threadId: Id,
        cursor: z.number().int().min(-1),
      }),
    ),
    get: oc.input(threadTarget).output(ThreadSnapshotSchema),
    messages: oc
      .input(
        threadTarget.safeExtend({
          before: EntryId.optional(),
          includePeerRuns: z.boolean().optional(),
          around: z.object({ entryId: EntryId }).optional(),
        }),
      )
      .output(ThreadMessagePageSchema),
    /** What the bot and one peer, a bot or a connected agent, said to each other, newest page first. */
    peerMessages: oc
      .input(botId.extend({ peerBotId: z.string().min(1), before: EntryId.optional() }))
      .output(ThreadMessagePageSchema),
    subscribe: oc
      .input(threadTarget.safeExtend({ cursor: z.number().int().min(-1) }))
      .output(eventIterator(ProductEventSchema)),
    send: oc.input(threadSendInput).output(
      z.object({
        /** Absent when no bot answers: a group message naming no bot its sender can use. */
        taskId: Id.optional(),
        runId: Id.optional(),
        seq: z.number().int(),
        runIds: z.array(Id).optional(),
      }),
    ),
    react: oc
      .input(
        threadTarget.safeExtend({
          messageId: Id,
          reaction: MessageReactionSchema,
          clientNonce: z.string().min(1).max(200),
        }),
      )
      .output(z.object({ ok: z.literal(true) })),
    stop: oc.input(threadTarget).output(z.object({ ok: z.literal(true) })),
    followUp: oc
      .input(
        threadTarget.safeExtend({
          text: z.string().min(1),
          linkPreview: z.literal(false).optional(),
        }),
      )
      .output(z.object({ ok: z.literal(true) })),
    clear: oc.input(threadTarget).output(z.object({ ok: z.literal(true) })),
    /** Drops the target user message and everything after it, before resending an edit. */
    rewind: oc
      .input(threadTarget.safeExtend({ messageId: Id }))
      .output(z.object({ ok: z.literal(true) })),
    answer: oc
      .input(
        threadTarget.safeExtend({
          runId: Id,
          messageId: Id,
          /** Room for a card's JSON answers, each typed text capped by `ASK_ANSWER_MAX_LENGTH`. */
          answer: z
            .string()
            .min(1)
            .max(16 * ASK_ANSWER_MAX_LENGTH),
          /**
           * Changes to a Create bot card or a mail draft, only with "allow". The bounds sit above
           * the product limits so an enormous body is refused before any lock; the limits
           * themselves are applied by validateSpawnBotArgs and the draft's own checks.
           */
          edits: AskDraftEdits.extend({
            name: z.string().max(200).optional(),
            instructions: z.string().max(4000).optional(),
          })
            .strict()
            .optional(),
        }),
      )
      .output(z.object({ ok: z.literal(true) })),
    markRead: oc.input(threadTarget).output(z.object({ ok: z.literal(true) })),
    markUnread: oc.input(threadTarget).output(z.object({ ok: z.literal(true) })),
  },
  computer: {
    list: oc.output(z.array(ComputerListItemSchema)),
    updateAll: oc.output(ComputerUpdateAllResultSchema),
    status: oc.input(botId).output(ComputerStatusSchema),
    boot: oc.input(botId).output(ComputerStatusSchema),
    stop: oc.input(botId).output(ComputerStatusSchema),
    recover: oc.input(botId).output(ComputerUpdateSchema),
    reset: oc.input(botId).output(ComputerStatusSchema),
    update: oc.input(botId).output(ComputerUpdateSchema),
    updates: oc
      .input(z.object({ ids: z.array(Id).optional() }).nullish())
      .output(z.array(ComputerUpdateSchema)),
    releaseInterrupted: oc
      .input(z.object({ id: Id, workersStopped: z.literal(true) }))
      .output(z.object({ ok: z.literal(true) })),
    dismissUpdate: oc.input(z.object({ id: Id })).output(z.object({ ok: z.literal(true) })),
    takeover: oc.input(botId).output(z.object({ leaseId: Id, expiresAt: z.string() })),
    release: oc
      .input(
        z.object({
          botId: Id,
          reason: ComputerReleaseReasonSchema.optional(),
        }),
      )
      .output(z.object({ ok: z.literal(true) })),
    input: oc
      .input(
        z.object({
          botId: Id,
          kind: z.enum(["key", "pointer", "clipboard", "scroll"]),
          payload: z.record(z.string(), z.unknown()),
        }),
      )
      .output(z.object({ ok: z.literal(true) })),
    files: oc
      .input(z.object({ botId: Id, path: z.string().default("/") }))
      .output(
        z.array(z.object({ path: z.string(), kind: z.enum(["file", "dir"]), size: z.number() })),
      ),
    readFile: oc
      .input(z.object({ botId: Id, path: z.string() }))
      .output(z.object({ path: z.string(), content: z.string() })),
    screenUrl: oc.input(botId).output(z.object({ url: z.string().nullable() })),
    heartbeat: oc.input(botId).output(z.object({ ok: z.literal(true) })),
  },
  memory: {
    list: oc
      .input(z.object({ botId: Id.optional(), scope: MemoryScope.optional() }))
      .output(z.array(MemoryDocumentSchema)),
    update: oc
      .input(z.object({ documentId: Id, content: z.string() }))
      .output(MemoryDocumentSchema),
    exportMarkdown: oc.input(z.object({ botId: Id.optional() })).output(z.string()),
    providerConfig: oc.output(SpaceMemoryConfigSchema.nullable()),
    connectProvider: oc
      .input(
        z.object({
          provider: z.string().min(1),
          settings: z.record(z.string(), z.string()),
          credentials: z.record(z.string(), z.string()),
          defaultMemoryScope: MemoryScopeSchema.default("isolated"),
        }),
      )
      .output(SpaceMemoryConfigSchema),
    setDefaultScope: oc
      .input(z.object({ defaultMemoryScope: MemoryScopeSchema }))
      .output(SpaceMemoryConfigSchema),
    disconnectProvider: oc.output(z.object({ ok: z.literal(true) })),
  },
  decision: {
    providerConfig: oc.output(SpaceDecisionConfigSchema.nullable()),
    connectProvider: oc
      .input(
        z.object({
          provider: z.string().min(1),
          settings: z.record(z.string(), z.string()),
          credentials: z.record(z.string(), z.string()),
        }),
      )
      .output(SpaceDecisionConfigSchema),
    disconnectProvider: oc.output(z.object({ ok: z.literal(true) })),
  },
  routines: {
    list: oc.input(botId).output(z.array(RoutineSchema)),
    create: oc.input(CreateRoutineInput).output(RoutineSchema),
    update: oc
      .input(
        z
          .object({
            routineId: Id,
            name: z.string().optional(),
            prompt: z.string().optional(),
            crons: z.array(z.string().min(1)).optional(),
            timezone: z.string().optional(),
            active: z.boolean().optional(),
            notify: z.boolean().optional(),
            webhookEnabled: z.boolean().optional(),
            githubEnabled: z.boolean().optional(),
            messageProvider: z
              .string()
              .min(1)
              .max(50)
              .regex(/^[a-z0-9._-]+$/i)
              .nullable()
              .optional(),
            requireToolApproval: z.boolean().optional(),
            /** ISO datetime to arm a never-run one-shot. */
            runAt: IsoDate.optional(),
          })
          .superRefine((value, ctx) => {
            if (
              value.crons &&
              value.crons.length === 0 &&
              value.webhookEnabled === false &&
              value.githubEnabled === false &&
              value.messageProvider === null
            ) {
              ctx.addIssue({
                code: "custom",
                message: "Add a schedule, webhook, GitHub, or message trigger",
                path: ["crons"],
              });
            }
          }),
      )
      .output(RoutineSchema),
    remove: oc.input(z.object({ routineId: Id })).output(z.object({ ok: z.literal(true) })),
    testRun: oc
      .input(
        z.object({
          routineId: Id,
          clientNonce: z.string().min(1).max(200).optional(),
        }),
      )
      .output(z.object({ runId: Id })),
  },
  scratchpad: {
    list: oc
      .input(
        z.object({
          botId: Id,
          status: ScratchpadItemStatusSchema.optional(),
          includeDone: z.boolean().optional(),
        }),
      )
      .output(z.array(ScratchpadItemSchema)),
    create: oc.input(CreateScratchpadItemInput).output(ScratchpadItemSchema),
    update: oc
      .input(
        z.object({
          itemId: Id,
          title: z.string().min(1).max(200).optional(),
          status: ScratchpadItemStatusSchema.optional(),
          notes: z.string().max(4_000).optional(),
        }),
      )
      .output(ScratchpadItemSchema),
    remove: oc.input(z.object({ itemId: Id })).output(z.object({ ok: z.literal(true) })),
  },
  skills: {
    list: oc.input(botId).output(z.array(TaughtSkillSchema)),
    get: oc.input(z.object({ skillId: Id })).output(TaughtSkillSchema),
    start: oc
      .input(z.object({ botId: Id, goal: z.string().min(1).max(4000) }))
      .output(TaughtSkillSchema),
    appendEvent: oc
      .input(z.object({ skillId: Id, event: TeachRecordingEventSchema }))
      .output(TaughtSkillSchema),
    snapshot: oc.input(z.object({ skillId: Id })).output(TaughtSkillSchema),
    stop: oc.input(z.object({ skillId: Id })).output(TaughtSkillSchema),
    updateDraft: oc
      .input(
        z.object({
          skillId: Id,
          name: z.string().optional(),
          playbook: SkillPlaybookSchema,
        }),
      )
      .output(TaughtSkillSchema),
    save: oc
      .input(z.object({ skillId: Id, name: z.string().optional() }))
      .output(TaughtSkillSchema),
    testRun: oc
      .input(z.object({ skillId: Id, prompt: z.string().optional() }))
      .output(z.object({ runId: Id })),
    remove: oc.input(z.object({ skillId: Id })).output(z.object({ ok: z.literal(true) })),
  },
  /** Claude Agent Skills (SKILL.md recipes) shared across assistants (not taught/demo skills). Pi already understands this format; we persist and inject them. */
  agentSkills: {
    /** botId: only skills visible to that bot (slash picker, runtime parity). */
    list: oc
      .input(z.object({ botId: Id.optional() }).optional())
      .output(z.array(AgentSkillCatalogEntrySchema)),
    get: oc
      .input(
        z
          .object({ skillId: Id.optional(), name: z.string().min(1).max(80).optional() })
          .superRefine((input, ctx) => {
            if (!input.skillId && !input.name?.trim()) {
              ctx.addIssue({
                code: "custom",
                message: "Provide skillId or name",
                path: ["skillId"],
              });
            }
          }),
      )
      .output(AgentSkillSchema),
    create: oc.input(CreateAgentSkillInput).output(AgentSkillSchema),
    /** Base64 `.skill` file: SKILL.md text, or a gzip tar or zip bundle with SKILL.md at its root. */
    import: oc.input(ImportAgentSkillInput).output(AgentSkillSchema),
    update: oc.input(UpdateAgentSkillInput).output(AgentSkillSchema),
    remove: oc.input(z.object({ skillId: Id })).output(z.object({ ok: z.literal(true) })),
    /**
     * One write path for the global state and the per-bot overrides, applied together so
     * `all → selected` can seed the include list in the same transaction.
     */
    setAccess: oc
      .input(
        z.object({
          skillId: Id,
          availability: SkillAvailabilitySchema.optional(),
          bots: z
            .array(z.object({ botId: Id, enabled: z.boolean() }))
            .max(200)
            .optional(),
        }),
      )
      .output(AgentSkillCatalogEntrySchema),
  },
  /** Removed feature. Kept so installed mobile builds that still call it get an empty list. */
  marketplaces: {
    list: oc.input(z.object({})).output(z.array(z.never())),
  },
  capabilities: {
    list: oc.output(z.array(CapabilityInstallSchema)),
    install: oc
      .input(
        z.object({
          kind: z.enum(["skill", "plugin"]),
          name: z.string().min(1).max(120),
          source: z.string().min(1).max(2048),
          config: z.record(z.string(), z.unknown()).default({}),
        }),
      )
      .output(CapabilityInstallSchema),
    remove: oc.input(z.object({ id: Id })).output(z.object({ ok: z.literal(true) })),
  },
  mcp: {
    servers: {
      list: oc.output(z.array(McpServerSchema)),
      create: oc
        .input(McpServerConfigInput.and(z.object({ botIds: z.array(Id).optional() })))
        .output(McpServerSchema),
      update: oc
        .input(
          z.union([
            z.object({ id: Id, config: McpServerConfigInput }),
            z.object({ id: Id, secret: z.string().min(1).max(16384) }),
          ]),
        )
        .output(McpServerSchema),
      remove: oc.input(z.object({ id: Id })).output(z.object({ ok: z.literal(true) })),
    },
    assignments: {
      list: oc.input(botId).output(z.array(BotMcpServerSchema)),
      all: oc.output(z.array(BotMcpServerSchema)),
      approve: oc.input(z.object({ botId: Id, serverId: Id })).output(BotMcpServerSchema),
      replace: oc
        .input(
          z.object({
            botId: Id,
            assignments: z.array(
              z.object({
                serverId: Id,
                allowAllTools: z.boolean().default(true),
                allowedTools: z.array(z.string().min(1).max(200)).max(500).default([]),
              }),
            ),
          }),
        )
        .output(z.array(BotMcpServerSchema)),
    },
    oauth: {
      begin: oc.input(z.object({ serverId: Id, redirectUri: z.string().url() })).output(
        z.discriminatedUnion("status", [
          z.object({
            status: z.literal("authorization_required"),
            sessionId: Id,
            authorizationUrl: z.string().url(),
          }),
          z.object({
            status: z.enum(["already_connected", "authorization_not_requested", "token_required"]),
          }),
        ]),
      ),
      complete: oc
        .input(z.object({ sessionId: Id, code: z.string().min(1), state: z.string().min(1) }))
        .output(z.object({ ok: z.literal(true) })),
      disconnect: oc.input(z.object({ serverId: Id })).output(z.object({ ok: z.literal(true) })),
    },
  },
  onboarding: {
    /** Seed the first-run greeting into the bot's thread (focus card is separate). */
    start: oc.input(z.object({ botId: Id })).output(z.object({ ok: z.literal(true) })),
    /** Post the focus choice card when the thread is still idle. */
    promptFocus: oc.input(z.object({ botId: Id })).output(z.object({ ok: z.literal(true) })),
    /** Answer the focus choice; posts the app cards. Does not rename the bot. */
    choose: oc
      .input(z.object({ botId: Id, optionId: z.string() }))
      .output(z.object({ ok: z.literal(true) })),
    /** Dismiss the unanswered focus card without choosing an option. */
    dismissFocus: oc.input(z.object({ botId: Id })).output(z.object({ ok: z.literal(true) })),
    /** Flip an app_connect card to connected after authorization completes. */
    appConnected: oc
      .input(
        z.object({ botId: Id, provider: z.string(), connectorId: z.string().default("composio") }),
      )
      .output(z.object({ ok: z.literal(true) })),
  },
  integrationSetup: {
    get: oc.output(IntegrationSetupStateSchema),
    save: oc.input(IntegrationProviderConfigSchema).output(z.object({ ok: z.literal(true) })),
  },
  connections: {
    catalog: oc
      .input(z.object({ query: z.string().optional(), connectorId: z.string().optional() }))
      .output(z.array(ConnectionCatalogItemSchema)),
    list: oc.output(z.array(ConnectionSchema)),
    begin: oc
      .input(
        z.object({
          connectorId: z.string().default("composio"),
          provider: z.string(),
          displayName: z.string(),
        }),
      )
      .output(z.object({ connectionId: Id, authorizationUrl: z.string().nullable() })),
    complete: oc
      .input(z.object({ connectionId: Id, code: z.string().optional() }))
      .output(ConnectionSchema),
    rename: oc
      .input(z.object({ connectionId: Id, displayName: z.string().trim().min(1).max(80) }))
      .output(ConnectionSchema),
    revoke: oc.input(z.object({ connectionId: Id })).output(z.object({ ok: z.literal(true) })),
    /** Tools the connected provider exposes. Read-only; no per-tool allowlist yet. */
    tools: oc.input(z.object({ connectorId: z.string(), provider: z.string() })).output(
      z.array(
        z.object({
          name: z.string(),
          description: z.string(),
        }),
      ),
    ),
  },
  /** External messaging surface: link state, group channels, agent connections. */
  messaging: {
    status: oc.output(MessagingStatusSchema),
    link: {
      /** Issue a short-lived code the user sends to the line from a chat app. */
      start: oc
        .input(z.object({ botId: Id }))
        .output(z.object({ code: z.string(), expiresAt: z.string() })),
    },
    identities: {
      setBot: oc
        .input(z.object({ identityId: Id, botId: Id }))
        .output(MessagingLinkedIdentitySchema),
      unlink: oc.input(z.object({ identityId: Id })).output(z.object({ ok: z.literal(true) })),
    },
    channels: {
      list: oc.output(z.array(MessagingChannelMembershipSchema)),
      // Addressed by membership, not channel: one user can have two linked
      // chat apps in the same group, and each answers for its own agent.
      respond: oc
        .input(z.object({ membershipId: Id, accept: z.boolean() }))
        .output(MessagingChannelMembershipSchema),
      leave: oc.input(z.object({ membershipId: Id })).output(z.object({ ok: z.literal(true) })),
    },
    connections: {
      list: oc.output(z.array(MessagingAgentConnectionSchema)),
      respond: oc
        .input(z.object({ connectionId: Id, accept: z.boolean() }))
        .output(MessagingAgentConnectionSchema),
      revoke: oc.input(z.object({ connectionId: Id })).output(z.object({ ok: z.literal(true) })),
    },
  },
  approvalRules: {
    list: oc.output(z.array(ActionApprovalRuleSchema)),
    set: oc
      .input(
        z.object({
          effect: z.enum(["always_allow", "require_approval"]),
          matchKind: z.enum(["tool", "connector", "category"]),
          matchValue: z.string().min(1),
        }),
      )
      .output(ActionApprovalRuleSchema),
    remove: oc.input(z.object({ id: Id })).output(z.object({ ok: z.literal(true) })),
  },
  autoReview: {
    get: oc.output(ActionAutoReviewSettingsSchema),
    set: oc.input(z.object({ enabled: z.boolean() })).output(ActionAutoReviewSettingsSchema),
  },
  artifacts: {
    list: oc.input(botId).output(z.array(ArtifactSchema)),
    create: oc
      .input(
        threadTarget.and(
          z.object({
            name: z.string().min(1).max(255),
            mimeType: z.string().min(1),
            contentBase64: z.string().min(1).max(ATTACHMENT_MAX_BASE64_LENGTH),
          }),
        ),
      )
      .output(ArtifactSchema),
    get: oc.input(threadTarget.and(z.object({ artifactId: Id }))).output(ArtifactWithContentSchema),
  },
  usage: {
    breakdown: oc.input(z.object({ period: UsagePeriodSchema })).output(z.array(UsageCellSchema)),
  },
  export: {
    bot: oc.input(botId).output(ExportManifestSchema),
  },
  notifications: {
    registerPush: oc
      .input(z.object({ token: z.string().min(8).max(512) }))
      .output(z.object({ ok: z.literal(true) })),
    unregisterPush: oc.output(z.object({ ok: z.literal(true) })),
  },
  search: {
    query: oc.input(z.object({ q: z.string().max(200) })).output(SearchQueryOutputSchema),
  },
  links: {
    /**
     * Composer preview of a link about to be sent; null when there is nothing to show.
     * `pageHead` is the start of the page as the sender's device read it, one character per byte
     * (`latin1`), sent only after a draft said `deviceReadable`: the server uses it only if the site
     * still refuses the server for this link, and otherwise ignores it.
     */
    preview: oc
      .input(
        z.object({
          threadId: Id,
          url: z.string().max(LINK_PREVIEW_URL_MAX_LENGTH),
          pageHead: z.string().max(LINK_PREVIEW_PAGE_HEAD_MAX_LENGTH).optional(),
          /** The Content-Type the device got the head with: its charset is honored like a fetched page's. */
          pageHeadType: z.string().max(LINK_PREVIEW_PAGE_HEAD_TYPE_MAX_LENGTH).optional(),
        }),
      )
      .output(LinkPreviewDraftSchema.nullable()),
  },
  messages: {
    removeLinkPreview: oc
      .input(z.object({ messageId: Id }))
      .output(z.object({ ok: z.literal(true) })),
  },
  runs: {
    list: oc.input(z.object({ filter: z.enum(["active", "recent"]) })).output(RunsListOutputSchema),
    recap: oc.input(z.object({ runId: Id })).output(RunRecapSchema),
    /** A run's entries from every session it wrote to, joined with the person's answers. */
    entries: oc.input(z.object({ runId: Id })).output(SessionEntriesSchema),
  },
  sessions: {
    entries: oc.input(z.object({ sessionId: SessionId })).output(SessionEntriesSchema),
  },
  voice: {
    catalog: oc.output(z.array(VoiceCatalogEntrySchema)),
    status: oc.output(VoiceStatusSchema),
    credentials: oc.output(z.array(VoiceCredentialSchema)),
    connect: oc
      .input(
        z.object({
          provider: z.string(),
          apiKey: z.string().min(8),
          voiceId: z.string().max(120).optional(),
        }),
      )
      .output(VoiceCredentialSchema),
    disconnect: oc
      .input(z.object({ provider: z.string().min(1) }))
      .output(z.object({ ok: z.literal(true) })),
    setVoice: oc
      .input(z.object({ voiceId: z.string().min(1).max(120), provider: z.string().optional() }))
      .output(VoiceStatusSchema),
    voices: oc
      .input(z.object({ provider: z.string().optional() }))
      .output(z.array(VoiceInfoSchema)),
    prepare: oc
      .input(
        z.object({
          text: z.string().max(20000),
          voiceId: z.string().max(120).optional(),
          botId: Id.optional(),
        }),
      )
      .output(z.object({ ready: z.boolean(), utterances: z.array(z.string()) })),
  },
  externalConversations: {
    updatePolicy: oc
      .input(UpdateExternalConversationPolicyInput)
      .output(ExternalConversationPolicySchema),
  },
  agentSecrets: {
    list: oc.output(z.array(AgentSecretSchema)),
    put: oc.input(AgentSecretInputSchema).output(AgentSecretSchema),
    remove: oc.input(z.object({ id: Id })).output(z.object({ ok: z.literal(true) })),
  },
  vault: {
    list: oc.output(VaultList),
    put: oc.input(VaultPutInput).output(BotSecretDestination),
    remove: oc.input(z.object({ name: BotSecretName })).output(z.object({ ok: z.literal(true) })),
    share: oc.input(VaultShareInput).output(z.object({ ok: z.literal(true) })),
  },
};

export type AppContract = typeof appContract;
