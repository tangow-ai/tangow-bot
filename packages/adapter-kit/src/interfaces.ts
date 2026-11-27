import type { EntryId, RunSearchPage, SessionEntry, SessionId } from "@tangow/contracts";
import type { NewSession, RunSearchInput, SessionEntryDraft } from "./session-log.js";
import type {
  AdapterContext,
  AdapterDescriptor,
  AgentRunRequest,
  AgentRuntimeCapabilities,
  AgentRuntimeEvent,
  ArtifactPut,
  BackgroundJob,
  BackgroundJobHandlers,
  BrowserActRequest,
  BrowserActResult,
  BrowserCapabilities,
  BrowserNavigateRequest,
  BrowserNavigateResult,
  BrowserSnapshotRequest,
  BrowserSnapshotResult,
  CommandRequest,
  ComputerActionRequest,
  ComputerActionResult,
  ComputerFileEntry,
  ComputerInput,
  ComputerObservation,
  ComputerRef,
  ConnectorCall,
  ConnectorCapabilities,
  ConnectorCatalogItem,
  ConnectorEvent,
  ConnectorTool,
  ControlLeaseRef,
  DecisionCapabilities,
  DecisionRequest,
  DecisionResponse,
  MemoryCapabilities,
  MemoryCommitRequest,
  MemoryExportRequest,
  MemoryReadRequest,
  MemoryRevision,
  MemorySearchRequest,
  MemorySearchResult,
  MemorySnapshot,
  MessagingInboundEvent,
  MessagingPlatformDescriptor,
  MessagingSendRequest,
  MessagingSendResult,
  NotificationMessage,
  PageBrowserCommand,
  PageBrowserResult,
  PortableFile,
  ProcessEvent,
  SandboxCapabilities,
  ScreenRequest,
  ScreenSession,
  SemanticMemoryCapabilities,
  SemanticMemoryForgetRequest,
  SemanticMemoryPurgeHistoryRequest,
  SemanticMemoryRecallRequest,
  SemanticMemoryResponse,
  SemanticMemoryResult,
  SemanticMemorySaveRequest,
  SnapshotRef,
  SpeechClip,
  TransactionalEmail,
  VoiceCapabilities,
  VoiceInfo,
  VoiceSynthesizeRequest,
  VoiceTranscribeRequest,
  VoiceVerifyResult,
  WebFetchCapabilities,
  WebFetchRequest,
  WebFetchResult,
  WebSearchCapabilities,
  WebSearchHit,
  WebSearchRequest,
} from "./types.js";

export interface SandboxProvider {
  describe(): AdapterDescriptor<SandboxCapabilities>;
  /** Latest successfully published computer environment; null when unavailable. */
  currentRelease?(context: AdapterContext): Promise<string | null>;
  /** Optional live browser on the same leased screen as observe/act. */
  pageBrowser?(
    computer: ComputerRef,
    request: PageBrowserCommand,
    context: AdapterContext,
  ): Promise<PageBrowserResult>;
  /** Allocate or reconnect the computer, returning its reference before fallible setup. */
  provision(
    request: {
      botId: string;
      homePath: string;
      providerRef?: string;
      releaseRef?: string | null;
      providerKind?: ComputerRef["kind"];
      /** A shared bot's computer mounts this bot's copy of its skills, whoever runs it. */
      skillsBotId?: string;
      /**
       * A home kept on worker volumes: mount each at its path and serve the workspace from `root`.
       * Only a provider that supports worker volumes receives one. A machine that mounts another
       * set is replaced, after `archive` received its files that are on no volume.
       */
      volumeHome?: {
        root: string;
        mounts: Array<{ volumeRef: string; path: string }>;
        archive(files: AsyncIterable<PortableFile>): Promise<void>;
      };
    },
    context: AdapterContext,
  ): Promise<ComputerRef>;
  /** Perform idempotent provider setup after the lifecycle has captured the reference. */
  prepare(computer: ComputerRef, context: AdapterContext): Promise<void>;
  execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent>;
  inspectBackgroundWork?(
    computer: ComputerRef,
    markerId: string,
    context: AdapterContext,
  ): Promise<"active" | "idle" | "unknown">;
  connectScreen(
    computer: ComputerRef,
    request: ScreenRequest,
    context: AdapterContext,
  ): Promise<ScreenSession>;
  setScreenControl?(
    computer: ComputerRef,
    interactive: boolean,
    context: AdapterContext,
    controlToken?: string,
  ): Promise<void>;
  sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    lease: ControlLeaseRef,
    context: AdapterContext,
  ): Promise<void>;
  observe(computer: ComputerRef, context: AdapterContext): Promise<ComputerObservation>;
  act(
    computer: ComputerRef,
    request: ComputerActionRequest,
    context: AdapterContext,
  ): Promise<ComputerActionResult>;
  listFiles(
    computer: ComputerRef,
    path: string,
    context: AdapterContext,
  ): Promise<ComputerFileEntry[]>;
  readFile(
    computer: ComputerRef,
    path: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ): Promise<Uint8Array>;
  writeFile(computer: ComputerRef, file: PortableFile, context: AdapterContext): Promise<void>;
  exportWorkspace(computer: ComputerRef, context: AdapterContext): AsyncIterable<PortableFile>;
  importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ): Promise<void>;
  snapshot(computer: ComputerRef, context: AdapterContext): Promise<SnapshotRef>;
  keepAlive?(computer: ComputerRef): Promise<void>;
  /**
   * Drop a single-screen graphical claim for this bot so another Team bot can use the display.
   * `keep` asks the provider to leave the display and browser running and only revoke control,
   * and answers `"kept"` when it did. Providers that ignore it tear down. `"refused"` means a
   * newer run owns the screen, so nothing was released.
   */
  releaseScreen?(
    computer: ComputerRef,
    context: AdapterContext,
    release?: "keep" | "teardown",
  ): Promise<"kept" | "refused" | void>;
  /** Keep what lives only on the machine's own disk before a replacement destroys it. */
  preserveBeforeReplace?(computer: ComputerRef, context: AdapterContext): Promise<void>;
  stop(computer: ComputerRef, context: AdapterContext): Promise<void>;
  destroy(computer: ComputerRef, context: AdapterContext): Promise<void>;
}

export interface ConnectorProvider {
  describe(): AdapterDescriptor<ConnectorCapabilities>;
  discoverTools(context: AdapterContext): Promise<ConnectorTool[]>;
  /** Resolve a lazy catalog call to its authoritative authorized tool before approval. */
  resolveCall?(
    call: ConnectorCall,
    context: AdapterContext,
  ): Promise<{ call: ConnectorCall; tool: ConnectorTool } | undefined>;
  execute(call: ConnectorCall, context: AdapterContext): AsyncIterable<ConnectorEvent>;
}

export interface ConnectionAuthProvider {
  describe(): AdapterDescriptor<{ oauth: boolean }>;
  begin(
    request: { provider: string; redirectUrl: string },
    context: AdapterContext,
  ): Promise<{ authorizationUrl: string | null; state: string }>;
  complete(
    request: { state: string; code?: string },
    context: AdapterContext,
  ): Promise<{ connectionRef: string }>;
  revoke(connectionRef: string, context: AdapterContext): Promise<void>;
}

/** A connector that also owns an end-user app catalog and connection lifecycle. */
export interface ManagedConnectorProvider
  extends ConnectorProvider,
    Omit<ConnectionAuthProvider, "describe"> {
  catalog(context: AdapterContext, query?: string): Promise<ConnectorCatalogItem[]>;
  listConnectedExternalIds(context: AdapterContext): Promise<string[]>;
  connectionReady(context: AdapterContext, externalId: string): Promise<boolean>;
  warmDirectory?(): Promise<void>;
}

export interface MemoryStore {
  describe(): AdapterDescriptor<MemoryCapabilities>;
  read(request: MemoryReadRequest, context: AdapterContext): Promise<MemorySnapshot>;
  search(request: MemorySearchRequest, context: AdapterContext): Promise<MemorySearchResult[]>;
  commit(request: MemoryCommitRequest, context: AdapterContext): Promise<MemoryRevision>;
  exportMarkdown(
    request: MemoryExportRequest,
    context: AdapterContext,
  ): AsyncIterable<PortableFile>;
  importMarkdown(
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ): Promise<MemoryRevision>;
}

/** Optional semantic memory. Durable Markdown memory remains owned by MemoryStore. */
export interface SemanticMemoryProvider {
  describe(): AdapterDescriptor<SemanticMemoryCapabilities>;
  recall(
    request: SemanticMemoryRecallRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse<SemanticMemoryResult[]>>;
  save(
    request: SemanticMemorySaveRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse>;
  purgeHistory(
    request: SemanticMemoryPurgeHistoryRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse>;
  /** Optional durable forget. Providers without a forget verb omit this. */
  forget?(
    request: SemanticMemoryForgetRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse<{ id: string; expired: boolean; reason: string | null }>>;
}

export interface AgentRuntime {
  describe(): AdapterDescriptor<AgentRuntimeCapabilities>;
  run(
    request: AgentRunRequest,
    context?: Partial<AdapterContext>,
  ): AsyncIterable<AgentRuntimeEvent>;
  abort(runId: string): Promise<void>;
}

export interface ModelProvider {
  describe(): AdapterDescriptor<{ catalog: boolean; byok: boolean }>;
  listModels(): Promise<Array<{ provider: string; id: string; label: string; billing: string }>>;
}

export interface JobPublisher {
  enqueue(job: BackgroundJob): Promise<void>;
  cancel(key: string): Promise<void>;
  close(): Promise<void>;
}

export interface JobWorkerHost {
  start(handlers: BackgroundJobHandlers): Promise<void>;
  stop(): Promise<void>;
}

export interface HomeTreeEntry {
  path: string;
  kind: "file" | "dir" | "symlink" | "other";
}

export interface AgentHomeStore {
  describe(): AdapterDescriptor<{ revisions: boolean }>;
  checkout(botId: string, dest: string, context: AdapterContext): Promise<string>;
  commit(botId: string, src: string, context: AdapterContext): Promise<string>;
  restore(botId: string, revision: string, dest: string, context: AdapterContext): Promise<void>;
  exportHome(botId: string, context: AdapterContext): AsyncIterable<PortableFile>;
  /**
   * Every entry of the home without following symlinks, where `exportHome` follows them and
   * yields only files.
   */
  listTree(botId: string, context: AdapterContext): Promise<HomeTreeEntry[]>;
  readFile(
    botId: string,
    path: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ): Promise<string>;
  writeFile(botId: string, path: string, content: string, context: AdapterContext): Promise<void>;
  list(
    botId: string,
    path: string,
    context: AdapterContext,
  ): Promise<Array<{ path: string; kind: "file" | "dir"; size: number }>>;
}

export interface ArtifactStore {
  describe(): AdapterDescriptor<{ stream: boolean }>;
  put(artifact: ArtifactPut, context: AdapterContext): Promise<{ id: string; hash: string }>;
  get(id: string, context: AdapterContext): Promise<Uint8Array>;
  remove(id: string, context: AdapterContext): Promise<void>;
}

export type SecretOpenResult =
  | { ok: true; plaintext: string }
  | { ok: false; reason: "cannot_open" | "unavailable" };

export interface SecretStore {
  seal(plaintext: string, recordId: string): Promise<string>;
  open(sealedValue: string, recordId: string): Promise<SecretOpenResult>;
}

export interface RealtimeFanout {
  describe(): AdapterDescriptor<{ distributed: boolean; push: boolean }>;
  publish(topic: string, payload: string): Promise<void>;
  subscribe(topic: string, onMessage: (payload: string) => void): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

/**
 * The append-only log of a conversation, one per session. Appends to a session serialize, and
 * reads return entries validated by `SessionEntrySchema`, oldest first. `Tx` is the backend's
 * transaction, so an append commits together with the caller's other writes.
 */
export interface SessionLog<Tx> {
  /**
   * Create the session, or leave it as it is when it exists. Resolves to the id to append to, which
   * for a thread that already has its main session is that session's id.
   */
  createSession(tx: Tx, session: NewSession): Promise<SessionId>;
  /** Append as the new head. A draft whose clientNonce is already in the session returns that entry. */
  append(tx: Tx, draft: SessionEntryDraft): Promise<SessionEntry>;
  /**
   * What the next run reads: the chain's newest compaction, then the chain entries after the last
   * seq it covers, oldest first. Without a compaction, the whole chain. `maxEntries` keeps only
   * the newest that many entries of the walk back from the head.
   */
  readTail(sessionId: SessionId, options?: { maxEntries?: number }): Promise<SessionEntry[]>;
  /**
   * The newest `limit` chain entries before `before`, or ending at the head when it is left out.
   * Inside `tx` when given, so the page agrees with what the caller read under the same locks.
   */
  readPage(
    sessionId: SessionId,
    page: { before?: EntryId; limit: number },
    tx?: Tx,
  ): Promise<SessionEntry[]>;
  /**
   * The chain entries around `entryId`, oldest first: up to `floor(limit / 2)` older ones, the
   * entry, then newer ones up to `limit` in all. Empty when the entry is not on the chain.
   */
  readAround(
    sessionId: SessionId,
    entryId: EntryId,
    limit: number,
    tx?: Tx,
  ): Promise<SessionEntry[]>;
  /**
   * A run's entries from every session it wrote to, with the person's answers to its asks and
   * choices and the later state of its cards, by `ts` then `seq`, whether or not a rewind left them
   * on the chain. A child session's run reads whole: its trace and what it raised to the thread.
   * With `limit`, only the newest `limit` of them, in the same order.
   */
  readRun(runId: string, options?: { limit?: number }): Promise<SessionEntry[]>;
  /** Bounded inference-safe excerpts on the active chain. The caller authorizes scope first. */
  searchRun(input: RunSearchInput, tx?: Tx): Promise<RunSearchPage>;
  /** One entry of the session, on the chain or not. */
  readEntry(sessionId: SessionId, entryId: EntryId): Promise<SessionEntry | undefined>;
}

export interface NotificationProvider {
  describe(): AdapterDescriptor<{ push: boolean; email: boolean }>;
  send(message: NotificationMessage, context: AdapterContext): Promise<void>;
}

/** Outbound account and security email. Product code owns content; adapters own delivery. */
export interface TransactionalEmailProvider {
  describe(): AdapterDescriptor<{ transactional: boolean }>;
  send(message: TransactionalEmail): Promise<void>;
  /** Wait for accepted in-flight deliveries before a graceful shutdown completes. */
  drain?(): Promise<void>;
}

export interface ExecutionRunner {
  describe(): AdapterDescriptor<{ cloud: boolean; selfHosted: boolean; desktop: boolean }>;
  dispatch(runId: string, target: "cloud" | "self-hosted" | "desktop"): Promise<void>;
}

export interface VoiceProvider {
  describe(): AdapterDescriptor<VoiceCapabilities>;
  verify(apiKey: string, context: AdapterContext): Promise<VoiceVerifyResult>;
  listVoices(apiKey: string, context: AdapterContext): Promise<VoiceInfo[]>;
  synthesize(request: VoiceSynthesizeRequest, context: AdapterContext): Promise<SpeechClip>;
  transcribe?(request: VoiceTranscribeRequest, context: AdapterContext): Promise<{ text: string }>;
}

/**
 * Deployment-wide external chat surface: one bot presence across messaging
 * platforms (iMessage/SMS, Slack, WhatsApp, …). Conversations are addressed
 * by opaque provider-prefixed thread ids ("sendblue:…", "slack:C1:…"), so
 * orchestration never sees platform wire formats. Webhook verification and
 * payload translation live behind handleWebhook, per platform.
 */
export interface MessagingSurface {
  describe(): AdapterDescriptor<{ providers: string[] }>;
  /** Enabled platforms and what each supports. */
  platforms(): MessagingPlatformDescriptor[];
  /**
   * Verify and process one platform webhook request. Parsed events reach the
   * sink registered via onInbound before the returned response resolves.
   * Returns null for a provider this surface does not host.
   */
  handleWebhook(provider: string, request: Request): Promise<Response> | null;
  /** Register the single downstream consumer of inbound events. */
  onInbound(sink: (event: MessagingInboundEvent) => Promise<void>): void;
  sendToThread(
    request: MessagingSendRequest,
    context: AdapterContext,
  ): Promise<MessagingSendResult>;
  /** Resolve (or create) the 1:1 thread for a provider address. */
  openDirectThread(provider: string, address: string, context: AdapterContext): Promise<string>;
  /**
   * Best-effort "…" typing bubbles for 1:1 chats. Cosmetic: never gates
   * message delivery, and silently no-ops on platforms without support.
   */
  sendTyping(threadId: string, context: AdapterContext): Promise<void>;
  /**
   * Start the surface eagerly instead of waiting for the first inbound
   * webhook or outbound send to touch it. Needed for adapters that pull
   * updates themselves (e.g. Telegram in "auto"/"polling" mode, used when
   * no public webhook URL is reachable): without an explicit call here,
   * nothing kicks off that pull loop until something else happens to
   * initialize the adapter first.
   */
  initialize?(): Promise<void>;
  /**
   * Release long-lived inbound resources (Telegram getUpdates polling) so a
   * replacement process can claim them. No-op when the surface never started.
   */
  shutdown?(): Promise<void>;
}

/**
 * Provider-neutral web search. Builtin `web_search` routes here so backends
 * (keyless HTTP, model-native search, future paid APIs) can be swapped without
 * changing tool names or the executor.
 */
export interface WebSearchProvider {
  describe(): AdapterDescriptor<WebSearchCapabilities>;
  search(request: WebSearchRequest, context: AdapterContext): Promise<WebSearchHit[]>;
}

/**
 * Provider-neutral page fetch. Builtin `web_fetch` routes here. Read-only:
 * no JS execution, no headless browser.
 */
export interface WebFetchProvider {
  describe(): AdapterDescriptor<WebFetchCapabilities>;
  fetch(request: WebFetchRequest, context: AdapterContext): Promise<WebFetchResult>;
}

/** Convenience when one adapter owns both search and fetch. */
export interface WebProvider extends WebSearchProvider, WebFetchProvider {
  describe(): AdapterDescriptor<WebSearchCapabilities & WebFetchCapabilities>;
}

/** An issue the builtin `report_issue` tool files with the operator's tracker. */
export interface FeedbackIssue {
  title: string;
  body: string;
  labels: string[];
}

/** Where the operator receives agent feedback. Builtin `report_issue` routes here. */
export interface FeedbackProvider {
  /** Resolves to the created issue's URL; throws when it was not created. */
  deliver(issue: FeedbackIssue, context: AdapterContext): Promise<{ url: string }>;
}

/**
 * Provider-neutral page browser on the bot computer. Builtin browser_* tools
 * route here so backends (in-process page session, CDP against the computer's
 * Chrome, future adapters) can swap without changing tool names. Not a second
 * hosted browser product. Prefer this for web pages; use computer_act when the
 * page tool cannot operate or the task needs the desktop itself.
 */
export interface BrowserProvider {
  describe(): AdapterDescriptor<BrowserCapabilities>;
  navigate(
    computer: ComputerRef,
    request: BrowserNavigateRequest,
    context: AdapterContext,
  ): Promise<BrowserNavigateResult>;
  snapshot(
    computer: ComputerRef,
    request: BrowserSnapshotRequest,
    context: AdapterContext,
  ): Promise<BrowserSnapshotResult>;
  act(
    computer: ComputerRef,
    request: BrowserActRequest,
    context: AdapterContext,
  ): Promise<BrowserActResult>;
}

/**
 * Provider-neutral typed decision over a text state: yes/no, pick-one-of, or a
 * bounded scale, each with probabilities. Not a vendor and not a text generator:
 * it cannot invent an option, write a field value, or plan. Core runs with none
 * configured. `decide` may throw; callers go through `decideWithin`, which never does.
 */
export interface DecisionProvider {
  describe(): AdapterDescriptor<DecisionCapabilities>;
  decide(request: DecisionRequest, context: AdapterContext): Promise<DecisionResponse>;
}
