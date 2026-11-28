import type { GridNode, NativeLinkMentions, TableActions } from "@tangow/chat-ui/native";
import {
  ChatMarkdown,
  hasMarkdownTable,
  LinkifiedText,
  truncateMarkdownForRender,
} from "@tangow/chat-ui/native";
import type {
  AgentSkillCatalogEntry,
  Connection,
  ConnectionCatalogItem,
  EntryId,
  GroupPerson,
  MessageBlock,
  Routine,
  SessionEntry,
  SessionId,
  ThreadItem,
  ThreadMessagePage,
} from "@tangow/contracts";
import {
  canReactToThreadMessage,
  MESSAGE_REACTIONS,
  type MessageReaction,
} from "@tangow/contracts";
import type { ImageStack as ImageStackModel } from "@tangow/core";
import {
  ACTIVE_RUN_STATUSES,
  abortableDelay,
  answersPendingQuestion,
  appendedEntries,
  attachmentsForThread,
  botWordsOf,
  buildComposerMentionOptions,
  type ComposerMention,
  canEditSpawnBotCard,
  caretAfterEdit,
  composerSegments,
  drawsNothing,
  editedWaitingDraft,
  failureSinceLabel,
  groupLeadBotId,
  imagesOf,
  insertMentionToken,
  isApprovalAskBlock,
  isAsideOnlyMessage,
  isRunTerminalEvent,
  isSecretAskBlock,
  isWorkingStatus,
  latestTakeoverItemId,
  linkMentionsKey,
  linkMentionsOf,
  mentionChipKey,
  mentionQueryAt,
  mentionsInDraft,
  projectThreadView,
  type RoutineItem,
  resolveComposerSendPlan,
  routineCardSettlement,
  routineResultMessage,
  SLASH_ACTIONS,
  type SlashActionId,
  selectedAskActionLabel,
  serializeComposerPrompt,
  skillInDraft,
  skillSourcesOf,
  slashSkillOptions as slashSkills,
  type ThreadRow,
  type ThreadView,
  textWithoutPreviewedLinkLine,
  threadEntriesOf,
  threadTimeMarkerLabel,
  truncateSlashDescription,
  unshownRunReport,
  waitingAnswerTarget,
} from "@tangow/core";
import { ambientFloor, botAccentOn, motion, radii, sizes } from "@tangow/ui-tokens";
import * as Clipboard from "expo-clipboard";
import { useFocusEffect, useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import type { ReactNode } from "react";
import {
  cloneElement,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  AppState,
  FlatList,
  Modal,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type TextProps,
  View,
} from "react-native";
import { KeyboardAvoidingView, useKeyboardState } from "react-native-keyboard-controller";
import Animated, {
  Easing,
  FadeIn,
  FadeInDown,
  Keyframe,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppConnectCard } from "../components/AppConnectCard";
import { AskActions, CapsuleButton } from "../components/AskActions";
import { AgentSteps } from "../components/agent-steps";
import { AmbientBackground, ThreadScrollEdge } from "../components/ambient-background";
import { AnimatedMessageBubble, MessageArrival } from "../components/animated-message-bubble";
import { BotAvatar } from "../components/bot-avatar";
import type { BotBubbleMeta } from "../components/bot-bubble";
import { BotBubble, BubbleMeta } from "../components/bot-bubble";
import { ComposerAttachment } from "../components/composer-attachment";
import { ComposerLinkPreview } from "../components/composer-link-preview";
import { ComposerAttachBubble, ComposerShell } from "../components/composer-shell";
import { ComputerCard } from "../components/computer-card";
import { DictationPreview } from "../components/dictation-preview";
import { DraftCard } from "../components/draft-card";
import { FramedBlock } from "../components/framed-block";
import { useReduceTransparency } from "../components/glass";
import { GroupAvatar } from "../components/group-avatar";
import { ImageStack } from "../components/image-stack";
import { HandoffDivider, Interstitial } from "../components/interstitial";
import { LinkMentionIcon } from "../components/link-mention-icon";
import { LinkPreviewCard } from "../components/link-preview-card";
import {
  MarkdownArtifactPreview,
  type MarkdownArtifactPreviewTarget,
} from "../components/markdown-artifact-preview";
import type { MessageSheetAction } from "../components/message-actions-sheet";
import { MessageActionsSheet } from "../components/message-actions-sheet";
import { MessageRow } from "../components/message-row";
import { NativeMenu } from "../components/native-menu";
import { NativeSymbol } from "../components/native-symbol";
import { PreviewSheet } from "../components/preview-sheet";
import { QuestionCard } from "../components/question-card";
import { ReactionPill } from "../components/reaction-pill";
import { RoutineCardPreview } from "../components/routine-card-preview";
import { StackedAvatars } from "../components/stacked-avatars";
import { StopContour } from "../components/stop-contour";
import { Surface } from "../components/surface";
import { TablePreview } from "../components/table-preview";
import { ThreadProviders } from "../components/thread-providers";
import { TypingBubble } from "../components/typing-bubble";
import { UserAvatar } from "../components/user-avatar";
import { UserBubble } from "../components/user-bubble";
import { WidgetCard } from "../components/widget-card";
import {
  applyMobileThreadEvent,
  blockText,
  copyableMobileMessageText,
  currentApiBase,
  keepUnchangedRows,
  listGroups,
  loadSessionToken,
  type MobileBot,
  type MobileGroup,
  type MobileMe,
  type MobileMessage,
  type MobileSnapshot,
  type MobileSpaceNavigation,
  type MobileThreadResponse,
  mergeMobileSnapshot,
  messagingProviderLabel,
  rpc,
  selectedSpaceId,
  selectSpace,
  shouldApplyMobileThreadRefresh,
  subscribeThread,
  withOlderPage,
} from "../lib/api";
import { mobileTokens, resolveMobileAppearance } from "../lib/appearance";
import { type MobileArtifactTarget, openMobileArtifact } from "../lib/artifact-open";
import { composerName, questionCardOf } from "../lib/ask-card";
import { presentAttachSheet } from "../lib/attach-sheet";
import { failureReason } from "../lib/bot-activity";
import {
  archiveBot,
  clearConversation,
  confirmClearConversation,
  confirmDeleteBot,
} from "../lib/bot-lifecycle";
import { botMessageCard } from "../lib/bot-message-card";
import { noteBotRunEnded, subscribeBotSaved, withSavedAvatar } from "../lib/bot-page-state";
import { CHAT_MOTION } from "../lib/chat-motion";
import { useDebugMode } from "../lib/debug-mode";
import type { CardEdits } from "../lib/draft-edit";
import { draftEdit, dropDraftEdit, syncDraftEdit } from "../lib/draft-edit";
import { cancelFocusPrompt, focusPromptThreadActive } from "../lib/focus-prompt";
import { commitHaptic, selectionHaptic, sendHaptic, successHaptic } from "../lib/haptics";
import { dateLocaleForUi, t, useI18n } from "../lib/i18n";
import {
  IMAGE_VIEWER_HREF,
  type ImageViewerPayload,
  setImageViewerPayload,
  useThreadHeldByImageViewer,
} from "../lib/image-viewer";
import { userInitials } from "../lib/inbox";
import { unreadConversationCount } from "../lib/inbox-spaces";
import { useKeyboardSlide } from "../lib/keyboard-slide";
import { saveLastBotId } from "../lib/last-bot";
import {
  blocksWithoutPreviewedLinkLine,
  cardReplacesBubble,
  linkPreviewCardOf,
} from "../lib/link-preview";
import {
  dismissThreadNotifications,
  resumeLiveNotifications,
  setOpenNotificationThread,
  syncAppBadge,
} from "../lib/live-notifications";
import { messageArrivalStaggerMs, useMessageArrivals } from "../lib/message-arrivals";
import {
  hasVisibleMessagePresentation,
  memoryNoteLine,
  messagePresentationSegments,
  skillLineRoute,
  skillLineSegment,
  visibleMessageBlocks,
} from "../lib/message-presentation";
import { native, useMobileTokens, useResolvedAppearance } from "../lib/native";
import type { MenuAction } from "../lib/native-menu";
import {
  type PickedAttachment,
  pickDocuments,
  pickFromLibrary,
  takePhoto,
} from "../lib/pick-attachments";
import { reactionPopKey, useReactionPops } from "../lib/reaction-pop";
import { threadRefreshDelayMs } from "../lib/refresh";
import { isViewedRunLine, originSession } from "../lib/session-sheet";
import { rosterMuted, sharedWithMe, threadBotActions } from "../lib/shared-bot";
import { closeSheet, openSheet } from "../lib/sheet";
import { openSpawnBotEdit, syncSpawnBotEdit } from "../lib/spawn-bot-edit";
import { hexWithAlpha } from "../lib/stop-contour-math";
import { shadowsForAppearance } from "../lib/theme";
import {
  type ThreadScrollAction,
  ThreadScrollBehavior,
  type ThreadScrollState,
} from "../lib/thread-scroll";
import { nativeTextStyle } from "../lib/typography";
import { useComposerDictation } from "../lib/use-composer-dictation";
import { useComposerLinkPreview } from "../lib/use-composer-link-preview";
import { speakText } from "../lib/voice";

type PendingAttachment = PickedAttachment & { threadKey: string };
type ReplyTarget = { message: MobileMessage; messageId: EntryId };
type NoteItem = Extract<ThreadItem, { kind: "note" }>;
type CardTarget = { runId: string; entryId: string };
type AskAction = NonNullable<Extract<MessageBlock, { kind: "ask" }>["actions"]>[number];

/**
 * How the thread frames a message, derived from the blocks it is about to draw
 * — same two shapes as the web transcript. `row` is something a bot or the
 * person said (a bot's question or approval is a normal row too, its
 * FramedBlock card is just the row's body), `aside` a quiet note between
 * messages.
 */
type MessageChrome = "row" | "aside";

const CARD_ONLY_BLOCK_KINDS = new Set<string>([
  "ask",
  "channel_message",
  "computer",
  "meta",
  "child_bot",
  "image",
  "file",
  "widget",
]);

/** Gaps from design contract § Grouping: 3 within a group, 14 between groups
 * (replaces the old `MESSAGE_GAP` / `ASIDE_GAP` for both rows and asides), 0
 * between two consecutive asides. */
const GROUP_GAP = 14;
const WITHIN_GROUP_GAP = 3;
/** Avatar column (`sizes.message`, 32) plus its gap (8): a bot row's
 * reactions, and a card's indent, line up under its group's prose in multi.
 * 0 in mono, which has no avatar column. */
const FRAMED_INDENT = sizes.message + 8;

function newClientNonce(): string {
  const webCrypto = globalThis.crypto;
  if (webCrypto && typeof webCrypto.randomUUID === "function") {
    return webCrypto.randomUUID();
  }
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function formatApprovalAnswer(
  answer: string | undefined,
  actions: AskAction[] | undefined,
  approval: boolean,
): string {
  if (!answer) return t("Answered");
  const selectedAction = actions?.find((action) => action.id === answer);
  const outcome = selectedAction?.outcome;
  if (approval && outcome === "created") return t("Created");
  if (approval && outcome === "cancelled") return t("Cancelled");
  if (approval && answer === "allow") return t("Allowed once");
  if (approval && answer === "always") return t("Always allowed");
  if (approval && answer === "deny") return t("Denied");
  return t("Answered: {answer}", {
    answer: selectedAskActionLabel(answer, actions),
  });
}

function formatAttachmentSkip(item: { name: string; reason: string }): string {
  const name = item.name === "camera" ? t("Camera") : item.name;
  if (item.reason === "permission denied") return t("{name} (permission denied)", { name });
  if (item.reason === "over 10 MiB") return t("{name} (over 10 MiB)", { name });
  if (item.reason === "unsupported type") return t("{name} (unsupported type)", { name });
  const maxMatch = /^max (\d+) attachments$/.exec(item.reason);
  if (maxMatch) {
    return t("{name} (max {count} attachments)", {
      name,
      count: maxMatch[1] ?? "",
    });
  }
  return `${name} (${item.reason})`;
}

function isLiveMessage(item: ThreadItem): item is Extract<MobileMessage, { role: "bot" }> {
  return item.kind === "message" && item.role === "bot" && item.live === true;
}

function isAsideItem(item: ThreadItem, showSteps: boolean): boolean {
  switch (item.kind) {
    case "message":
      return isAsideOnlyMessage(visibleMessageBlocks(item.blocks, showSteps));
    case "handoff":
    case "botMessage":
    case "note":
      return true;
    default:
      return false;
  }
}

function isActiveStatus(status: string | undefined): boolean {
  return ACTIVE_RUN_STATUSES.some((active) => active === status);
}

type NotificationRouteState = "loading" | "ready" | "failed";

const KEEP_VISIBLE_POSITION = { minIndexForVisible: 0 };
const AnimatedKeyboardAvoidingView = Animated.createAnimatedComponent(KeyboardAvoidingView);
/** Between the thread and the composer row. The thread draws into it under a fade, so a question card's shadow dies out there instead of ending on the list's edge. */
const COMPOSER_GAP = 16;
/** The thread column's side margin. The thread draws into it too, for the same shadow. */
const THREAD_GUTTER = 14;
/** Where the thread draws past its column, and the room it gives back inside. */
const BLEED_STYLE = { marginHorizontal: -THREAD_GUTTER };
/** The composer row's height before its first layout: one line, the home indicator below. */
const COMPOSER_ROW_ESTIMATE = 100;

export default function ThreadRoute() {
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const router = useRouter();
  const { spaceId } = useLocalSearchParams<{ spaceId?: string | string[] }>();
  const requestedSpaceId = typeof spaceId === "string" && spaceId ? spaceId : null;
  const invalidSpaceId = spaceId !== undefined && requestedSpaceId === null;
  const routeMatchesSelectedSpace =
    requestedSpaceId === null || selectedSpaceId() === requestedSpaceId;
  const [routeState, setRouteState] = useState<NotificationRouteState>(() => {
    if (invalidSpaceId) return "failed";
    return routeMatchesSelectedSpace ? "ready" : "loading";
  });

  useEffect(() => {
    let cancelled = false;
    if (invalidSpaceId) {
      setRouteState("failed");
      return () => {
        cancelled = true;
      };
    }
    if (!requestedSpaceId || selectedSpaceId() === requestedSpaceId) {
      setRouteState("ready");
      return () => {
        cancelled = true;
      };
    }
    setRouteState("loading");
    void selectSpace(requestedSpaceId).then((selected) => {
      if (!cancelled) setRouteState(selected ? "ready" : "failed");
    });
    return () => {
      cancelled = true;
    };
  }, [invalidSpaceId, requestedSpaceId]);

  if (routeState === "ready" && !invalidSpaceId && routeMatchesSelectedSpace) return <Thread />;
  return (
    <View
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: tokens.background,
      }}
    >
      {routeState === "loading" ? (
        <ActivityIndicator color={tokens.foreground} />
      ) : (
        <Pressable accessibilityRole="button" onPress={() => router.replace("/")}>
          <Text style={{ color: tokens.foreground, fontSize: 16 }}>{t("Return to inbox")}</Text>
        </Pressable>
      )}
    </View>
  );
}

function Thread() {
  const colorScheme = useResolvedAppearance();
  const tokens = mobileTokens();
  const [botActionsOpen, setBotActionsOpen] = useState(false);
  const { locale, t } = useI18n();
  const navigation = useNavigation();
  const router = useRouter();
  const headerHeight = useHeaderHeight();
  const insets = useSafeAreaInsets();
  // The composer floats over the thread's end; the thread keeps its last message above it.
  const [composerHeight, setComposerHeight] = useState(COMPOSER_ROW_ESTIMATE);
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const barTransparent = !useReduceTransparency();
  // Under an opaque bar, iOS left a band painted over the thread after the slide: that case resizes.
  const keyboardSlides = Platform.OS === "ios" && barTransparent;
  const closedBottomInset = Math.max(insets.bottom + 8, 20);
  // The slide keeps the closed inset and stops 12 pt above the keyboard: swapping the inset only
  // once the keyboard had hidden dropped the composer to the bottom, then bumped it back up.
  const composerBottomInset = keyboardVisible && !keyboardSlides ? 8 : closedBottomInset;
  const keyboardSlide = useKeyboardSlide(keyboardSlides, closedBottomInset - 12);
  // What of the thread's top sits under the bar.
  const underBar = barTransparent ? headerHeight : 0;
  const { botId, groupId, name, messageId } = useLocalSearchParams<{
    botId?: string;
    groupId?: string;
    name?: string;
    messageId?: string;
  }>();
  const inGroup = Boolean(groupId);
  const scroll = useRef<FlatList<ThreadRow>>(null);
  const pinnedScroll = useRef<ScrollView>(null);
  const scrollBehavior = useRef(new ThreadScrollBehavior());
  const userDragging = useRef(false);
  const loadingOlderContent = useRef(false);
  const expandedHistoryThread = useRef<string | null>(null);
  const historyEpoch = useRef(0);
  const jumpGeneration = useRef(0);
  const pinnedAroundRef = useRef<{
    botId?: string;
    groupId?: string;
    messageId: string;
  } | null>(null);
  const jumpScrollTarget = useRef<string | null>(null);
  const activeBotId = useRef(botId);
  activeBotId.current = botId;
  const activeGroupId = useRef(groupId);
  activeGroupId.current = groupId;
  const routeName = useRef(name);
  routeName.current = name;
  const mentionBotsRefreshGeneration = useRef(0);
  const mentionBotsAppliedGeneration = useRef(0);
  const readVisibleTarget = useRef<string | null>(null);
  const threadKey = groupId ?? botId;
  const [threadScrollState, setThreadScrollState] = useState<ThreadScrollState>(() =>
    scrollBehavior.current.state(),
  );
  useLayoutEffect(() => {
    scrollBehavior.current.openThread(threadKey ?? "");
    expandedHistoryThread.current = null;
    pinnedAroundRef.current = null;
    jumpScrollTarget.current = null;
    loadingOlderContent.current = false;
    setThreadScrollState(scrollBehavior.current.state());
  }, [threadKey]);
  const reducedMotion = useReducedMotion();
  const artifactTarget: MobileArtifactTarget | undefined = groupId
    ? { groupId }
    : botId
      ? { botId }
      : undefined;
  const [snap, setSnap] = useState<MobileSnapshot | null>(null);
  const activeThreadId = useRef<string | undefined>(undefined);
  const [draft, setDraft] = useState("");
  /** The draft as the field holds it, which a selection event may report before a re-render. */
  const latestDraft = useRef(draft);
  latestDraft.current = draft;
  const [composerFocused, setComposerFocused] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  /** The `@query` being typed: where its `@` sits, and the caret after it. */
  const [mentionRange, setMentionRange] = useState<{ start: number; caret: number } | null>(null);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [agentSkills, setAgentSkills] = useState<AgentSkillCatalogEntry[]>([]);
  const [mentionBots, setMentionBots] = useState<MobileBot[]>([]);
  const [mentionGroups, setMentionGroups] = useState<MobileGroup[]>([]);
  const [mentionRoutines, setMentionRoutines] = useState<Array<Routine & { botName?: string }>>([]);
  const [mentionConnectors, setMentionConnectors] = useState<
    Array<{
      id: string;
      name: string;
      authStatus: "connected" | "needs_auth";
      connectionId?: string;
    }>
  >([]);
  const [selectedMentions, setSelectedMentions] = useState<ComposerMention[]>([]);
  const [selectedSkill, setSelectedSkill] = useState<AgentSkillCatalogEntry | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  // Android only: the attach dialog's open state, closed by `presentAttachSheet` on every path
  // out, and as a safety net below when the app returns to the foreground.
  const [attachSheetOpen, setAttachSheetOpen] = useState(false);
  const textInputRef = useRef<TextInput>(null);
  const [replyTarget, setReplyTarget] = useState<ReplyTarget | null>(null);
  const [rewindTarget, setRewindTarget] = useState<MobileMessage | null>(null);
  // ponytail: artifact ids ride along invisibly — mobile has no attachment chips to restore into.
  const [rewindArtifactIds, setRewindArtifactIds] = useState<string[]>([]);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissedRunErrorId, setDismissedRunErrorId] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // The sheet a long press opened, closed if the screen moves to another thread.
  const messageSheetOwner = useRef<string | null>(null);
  const [markdownPreview, setMarkdownPreview] = useState<MarkdownArtifactPreviewTarget | null>(
    null,
  );
  const [stepSession, setStepSession] = useState<OpenedSession | null>(null);
  const openStepSession = useCallback(
    (sessionId: SessionId, title: string) =>
      setStepSession({ title, load: () => sessionEntries(sessionId) }),
    [],
  );
  // A tapped markdown table opens whole, as records, in `TablePreview`.
  const [tablePreview, setTablePreview] = useState<GridNode | null>(null);
  // The live list's scroll offset, and whether the pinned page (a plain
  // ScrollView, not inverted) is showing instead of it.
  const listOffset = useRef(0);
  const pinnedPageShowing = useRef(false);
  const contentChanged = useRef(() => {});
  const tableActions = useMemo<TableActions>(
    () => ({ open: setTablePreview, label: () => t("Table"), hint: t("Opens the full table") }),
    [t],
  );
  // Only the run's owner may edit a Create bot card; until this loads, nobody gets Edit.
  const [viewerUserId, setViewerUserId] = useState<string>();
  useEffect(() => {
    rpc<MobileMe>("me")
      .then((me) => setViewerUserId(me.userId))
      .catch(() => undefined);
  }, []);
  const showSteps = useDebugMode();
  const currentGroup = groupId ? mentionGroups.find((group) => group.id === groupId) : undefined;
  // A message carrying no author is the creator's.
  const creatorId = currentGroup?.creatorId;
  // Several people share a group's history: nobody rewinds it under the others.
  const sharedHistory = (currentGroup?.people.length ?? 0) > 1;
  const threadRuns = useMemo(
    () => snap?.activeRuns ?? (snap?.run ? [snap.run] : []),
    [snap?.activeRuns, snap?.run],
  );
  // Another person's run waits on them alone: its card shows, with nothing to answer here. A run
  // that does not say whose it is (an older server, or one seen only starting) stays answerable,
  // and the server decides.
  const othersRuns = useMemo(
    () =>
      new Set(
        threadRuns.flatMap((run) =>
          run.userId && viewerUserId && run.userId !== viewerUserId ? [run.id] : [],
        ),
      ),
    [threadRuns, viewerUserId],
  );
  const drawnRows = useRef<ReadonlyMap<string, ThreadRow>>(new Map());
  const liveView = useMemo((): ThreadView => {
    const projected = projectThreadView(snap?.entries ?? [], {
      rendersNothing: (item) =>
        drawsNothing(item, (blocks) => hasVisibleMessagePresentation(blocks, showSteps)),
      progress: snap?.layer,
      imageStacks: true,
      othersRun: (runId) => othersRuns.has(runId),
    });
    const rows = keepUnchangedRows(drawnRows.current, projected.rows);
    drawnRows.current = new Map(rows.map((row) => [row.item.id, row]));
    return { ...projected, rows };
  }, [snap?.entries, snap?.layer, showSteps, othersRuns]);
  // The image viewer zooms out of a stack in the list. A run adding images, a helper's report or a
  // recap while it is open can fold that stack's row away, and the list would recycle the very view
  // the system hid as the zoom's source, leaving a hole. So the thread keeps the view it had until
  // the viewer is gone; what arrived meanwhile then comes in as new.
  const viewerHoldsThread = useThreadHeldByImageViewer();
  const heldView = useRef<ThreadView | null>(null);
  if (!viewerHoldsThread) heldView.current = null;
  else heldView.current ??= liveView;
  const view = heldView.current ?? liveView;
  const rows = view.rows;
  const waiting = view.waiting;
  const waitingRef = useRef(waiting);
  waitingRef.current = waiting;
  const lastRow = rows.at(-1);
  // An image joining the last stack is the thread's newest message, though it draws no row.
  const latestMessageId = lastRow ? (lastRow.imageStack?.front.item.id ?? lastRow.item.id) : null;
  const rowIndex = useMemo(() => new Map(rows.map((row, index) => [row.item.id, index])), [rows]);
  const rewindIndex = rewindTarget
    ? (rowIndex.get(view.rowOf.get(rewindTarget.id) ?? rewindTarget.id) ?? -1)
    : -1;
  const rewindRemovedCount = rewindIndex >= 0 ? rows.length - rewindIndex - 1 : 0;
  const activePendingAttachments = attachmentsForThread(pendingAttachments, threadKey);
  const composerMentionTargets = useMemo(
    () =>
      buildComposerMentionOptions({
        query: "",
        includeEveryone: inGroup,
        currentGroupId: groupId,
        currentBotId: groupId ? null : botId,
        bots: mentionBots.map((bot) => ({
          id: bot.id,
          name: bot.name,
          color: bot.color,
          avatarCharacter: bot.avatarCharacter,
        })),
        groups: mentionGroups.map((group) => ({
          id: group.id,
          name: group.name,
          botIds: group.members.map((member) => member.botId),
        })),
        routines: mentionRoutines.map((routine) => ({
          id: routine.id,
          name: routine.name,
          crons: routine.crons,
          botId: routine.botId,
          botName: routine.botName,
        })),
        connectors: mentionConnectors,
      }),
    [botId, groupId, inGroup, mentionBots, mentionConnectors, mentionGroups, mentionRoutines],
  );
  const mentionOptions = useMemo(() => {
    if (mentionQuery === null || composerMentionTargets.length === 0) return [];
    const query = mentionQuery.trim().toLowerCase();
    return composerMentionTargets
      .filter((target) => !query || target.name.toLowerCase().startsWith(query))
      .slice(0, 10);
  }, [composerMentionTargets, mentionQuery]);
  const slashQueryNormalized = slashQuery?.trim().toLowerCase() ?? null;
  const slashSkillOptions =
    slashQuery !== null && mentionQuery === null ? slashSkills(agentSkills, slashQuery) : [];
  const currentBot = botId ? mentionBots.find((bot) => bot.id === botId) : undefined;
  // Your own thread with a bot shared with you: nothing here leads to its owner's screens.
  const shared = !inGroup && sharedWithMe(currentBot);
  const slashActionOptions =
    slashQuery !== null && mentionQuery === null
      ? SLASH_ACTIONS.filter((action) => {
          // A shared bot's settings are its owner's.
          if (shared && action.id === "chat-settings") return false;
          if (!slashQueryNormalized) return true;
          const label = t(action.label);
          return (
            action.label.toLowerCase().includes(slashQueryNormalized) ||
            label.toLowerCase().includes(slashQueryNormalized)
          );
        })
      : [];
  const displayName = currentBot?.name ?? name;
  const notificationThreadId = snap?.threadId ?? currentBot?.threadId;
  activeThreadId.current = notificationThreadId;
  const linkPreview = useComposerLinkPreview(draft, notificationThreadId);
  const [attachmentsRowWidth, setAttachmentsRowWidth] = useState<number | undefined>();
  const currentBotStatus = snap ? snap.run?.status : currentBot?.status;
  const liveItems = useMemo(
    () => rows.flatMap((row) => (isLiveMessage(row.item) ? [row.item] : [])),
    [rows],
  );
  const hasLiveProgress = liveItems.length > 0;
  // One bot only: an activity line names one bot's tool, so it would mislabel a group.
  const activityLabel = view.activityLabel;
  // Liveness comes from the run, never from the card's own state.
  const takeoverItemId = useMemo(
    () =>
      latestTakeoverItemId(
        view.rows.map((row) => row.item),
        threadRuns.filter((run) => !othersRuns.has(run.id)),
      ),
    [view.rows, threadRuns, othersRuns],
  );
  // Another person's live computer card, with the name of who it waits on.
  const takeoverWaitingOn = useMemo(() => {
    const items = view.rows.map((row) => row.item);
    return new Map(
      threadRuns.flatMap((run) => {
        const itemId = othersRuns.has(run.id) ? latestTakeoverItemId(items, [run]) : null;
        const name =
          snap?.people?.find((person) => person.userId === run.userId)?.name ??
          currentGroup?.people.find((person) => person.userId === run.userId)?.name ??
          "";
        return itemId ? [[itemId, name] as const] : [];
      }),
    );
  }, [view.rows, threadRuns, othersRuns, snap?.people, currentGroup?.people]);
  const busyRuns = useMemo(
    () => threadRuns.filter((run) => isWorkingStatus(run.status)),
    [threadRuns],
  );
  const workingRuns = useMemo(
    () => busyRuns.filter((run) => run.id !== waiting?.runId),
    [busyRuns, waiting?.runId],
  );
  const workingGroupBots = useMemo(() => {
    if (!inGroup) return [];
    const seen = new Set<string>();
    return workingRuns.flatMap((run) => {
      if (!run.botId || seen.has(run.botId)) return [];
      const member = snap?.members?.find((candidate) => candidate.botId === run.botId);
      if (!member) return [];
      seen.add(run.botId);
      return [{ ...member, status: run.status }];
    });
  }, [inGroup, snap?.members, workingRuns]);
  const botWorking = isWorkingStatus(currentBotStatus) && snap?.run?.id !== waiting?.runId;
  // Stop follows the run, as on web: it stays while a bot waits on the person.
  const stoppable = inGroup
    ? threadRuns.some((run) => isActiveStatus(run.status))
    : isActiveStatus(currentBotStatus);
  // A send without a mention goes to the bot, or to a group's lead.
  const sendsTo = inGroup
    ? groupLeadBotId(
        (snap?.members ?? []).map((member) => ({ id: member.botId })),
        currentGroup?.leadBotId,
      )
    : botId;
  const answerName =
    sendsTo && answersPendingQuestion(view, sendsTo, threadRuns)
      ? (mentionBots.find((bot) => bot.id === sendsTo)?.name ??
        snap?.members?.find((member) => member.botId === sendsTo)?.name)
      : undefined;

  useEffect(() => {
    void rpc<AgentSkillCatalogEntry[]>("agentSkills/list")
      .then(setAgentSkills)
      .catch(() => setAgentSkills([]));
  }, []);

  useEffect(() => {
    setThreadScrollState(scrollBehavior.current.state());
  }, [threadKey]);

  useEffect(
    () => subscribeBotSaved((saved) => setMentionBots((list) => withSavedAvatar(list, saved))),
    [],
  );

  const refreshMentionBots = useCallback(async () => {
    if (!botId && !groupId) return;
    const generation = ++mentionBotsRefreshGeneration.current;
    const targetBotId = botId;
    try {
      const bots = await rpc<MobileBot[]>("bots/list");
      // Apply any successful response that is still the newest applied so far.
      // A later failed refresh must not discard an earlier success.
      if (generation < mentionBotsAppliedGeneration.current) return;
      if (targetBotId !== activeBotId.current) return;
      mentionBotsAppliedGeneration.current = generation;
      setMentionBots(bots);
      if (targetBotId) {
        const next = bots.find((bot) => bot.id === targetBotId);
        // Read the route name from a ref so renaming does not recreate this
        // callback (and restart the SSE subscription that depends on it).
        if (next?.name && next.name !== routeName.current) {
          router.setParams({ name: next.name });
        }
      }
    } catch {
      // Keep the last known roster if refresh fails.
    }
  }, [botId, groupId, router]);

  // Who is in a group, its lead and its creator decide what the thread offers, so they follow
  // the group as it changes, not as it was when the thread opened.
  const groupsRefreshGeneration = useRef(0);
  const refreshGroups = useCallback(async () => {
    const generation = ++groupsRefreshGeneration.current;
    const groups = await listGroups().catch(() => null);
    // Keep the last known groups if a refresh fails or a newer one has started.
    if (groups && generation === groupsRefreshGeneration.current) setMentionGroups(groups);
  }, []);
  const knownPeople = useRef<ReadonlySet<string>>(new Set());
  knownPeople.current = new Set(
    mentionGroups.flatMap((group) => group.people.map((person) => person.userId)),
  );

  useEffect(() => {
    void refreshMentionBots();
  }, [refreshMentionBots]);

  useEffect(() => {
    if (mentionBots.length === 0) {
      setMentionRoutines([]);
      setMentionConnectors([]);
      return;
    }
    let cancelled = false;
    const botNameById = new Map(mentionBots.map((bot) => [bot.id, bot.name]));
    void Promise.all(
      mentionBots.map((bot) =>
        rpc<Routine[]>("routines/list", { botId: bot.id })
          .then((rows) =>
            rows.map((routine) => ({
              ...routine,
              botName: botNameById.get(bot.id) ?? bot.name,
            })),
          )
          .catch(() => [] as Array<Routine & { botName?: string }>),
      ),
    ).then((lists) => {
      if (!cancelled) setMentionRoutines(lists.flat());
    });
    void Promise.all([
      rpc<Connection[]>("connections/list").catch(() => [] as Connection[]),
      rpc<ConnectionCatalogItem[]>("connections/catalog", {}).catch(
        () => [] as ConnectionCatalogItem[],
      ),
    ]).then(([connections, catalog]) => {
      if (cancelled) return;
      const connected = connections.filter((row) => row.status === "connected");
      const options: Array<{
        id: string;
        name: string;
        authStatus: "connected" | "needs_auth";
        connectionId?: string;
      }> = connected.map((row) => ({
        id: row.id,
        name: row.displayName,
        authStatus: "connected" as const,
        connectionId: row.id,
      }));
      for (const item of catalog) {
        if (item.connected || item.noAuth) continue;
        if (
          connected.some(
            (row) =>
              row.provider.toLowerCase() === item.slug.toLowerCase() ||
              row.displayName.toLowerCase() === item.name.toLowerCase(),
          )
        ) {
          continue;
        }
        options.push({
          id: `catalog:${item.connectorId}:${item.slug}`,
          name: item.name,
          authStatus: "needs_auth",
        });
      }
      setMentionConnectors(options);
    });
    return () => {
      cancelled = true;
    };
  }, [mentionBots]);

  function isCurrentTarget(targetBotId: string | undefined, targetGroupId: string | undefined) {
    return activeBotId.current === targetBotId && activeGroupId.current === targetGroupId;
  }

  const workingBotIds = useMemo(
    () => new Set(workingGroupBots.flatMap((bot) => (bot.botId ? [bot.botId] : []))),
    [workingGroupBots],
  );
  const groupAvatarItems = useMemo(
    () =>
      (snap?.members ?? []).map((member) => ({
        identity: member.botId,
        character: member.avatarCharacter,
        working: workingBotIds.has(member.botId),
      })),
    [snap?.members, workingBotIds],
  );
  const groupMemberNames = useMemo(
    () => (snap?.members ?? []).map((member) => member.name).join(", "),
    [snap?.members],
  );

  const botActions = threadBotActions(shared, {
    openSettings: () =>
      router.push({
        pathname: "/bot",
        params: { botId: botId ?? "", tab: "settings" },
      }),
    share: () => router.push({ pathname: "/bot-share", params: { botId: botId ?? "" } }),
    openComputer: () =>
      router.push({
        pathname: "/computer",
        params: { botId: botId ?? "", name: displayName ?? t("Bot") },
      }),
    clear: () => confirmClearConversation(clearThread),
    archive: () => {
      if (botId) archiveBot(botId, leaveBot);
    },
    remove: () => confirmDeleteBot({ id: botId ?? "", name: displayName || t("Bot") }, leaveBot),
  });

  // `botActions` is rebuilt every render; the header menu keeps stable labels and reads the
  // latest handlers through this ref, so the header effect does not re-run on every render.
  const botActionsRef = useRef(botActions);
  botActionsRef.current = botActions;
  const botMenuActions = useMemo(
    () =>
      botActions.map(
        (action, index): MenuAction => ({
          label: action.label,
          destructive: action.destructive,
          onPress: () => botActionsRef.current[index]?.onPress(),
        }),
      ),
    [t, shared],
  );

  useLayoutEffect(() => {
    navigation.setOptions({
      title: displayName || t("Thread"),
      // The thread runs under the bar, whose buttons take glass on iOS 26; ThreadScrollEdge keeps the title legible.
      // Under Reduce Transparency the bar stays opaque: iOS hides a thread laid under a transparent one.
      headerTransparent: barTransparent,
      headerStyle: { backgroundColor: barTransparent ? "transparent" : tokens.background },
      // Bot actions (bot settings, open computer, clear, archive, delete) live in a menu
      // opened by a long press; a short press opens the bot's page.
      headerTitle: () => {
        const title = (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            {!inGroup && currentBot ? (
              <BotAvatar
                character={currentBot.avatarCharacter}
                size={34}
                status={currentBotStatus}
                muted={rosterMuted(currentBot)}
                live
              />
            ) : null}
            {inGroup && groupAvatarItems.length > 0 ? (
              <StackedAvatars
                items={groupAvatarItems}
                size={28}
                pillOverflow
                label={groupMemberNames || undefined}
              />
            ) : null}
            <Text
              numberOfLines={1}
              style={{
                ...nativeTextStyle("title", { size: 17, weight: 600 }),
                color: tokens.foreground,
              }}
            >
              {displayName || t("Thread")}
            </Text>
          </View>
        );
        const titleStyle = { alignItems: "center", maxWidth: 240 } as const;
        // A group has no bot actions: a plain title, so iOS never draws it as a disabled control.
        if (inGroup || !botId) {
          return (
            <View accessible accessibilityLabel={displayName || t("Thread")} style={titleStyle}>
              {title}
            </View>
          );
        }
        return (
          <NativeMenu
            compact
            accessibilityLabel={displayName || t("Thread")}
            actions={botMenuActions}
            onPrimaryAction={
              shared ? undefined : () => router.push({ pathname: "/bot", params: { botId } })
            }
            onAndroidOpen={() => setBotActionsOpen(true)}
            style={titleStyle}
          >
            {title}
          </NativeMenu>
        );
      },
      headerRight: () =>
        shared ? null : inGroup ? (
          <Pressable
            accessibilityLabel={t("Group settings")}
            hitSlop={8}
            onPress={() =>
              router.push({
                pathname: "/group-settings",
                params: { groupId: groupId ?? "" },
              })
            }
          >
            <NativeSymbol
              ios="gearshape"
              android="settings-outline"
              size={21}
              color={tokens.foreground}
            />
          </Pressable>
        ) : (
          <Pressable
            accessibilityLabel={t("Open computer")}
            hitSlop={8}
            onPress={() =>
              router.push({
                pathname: "/computer",
                params: { botId: botId ?? "", name: displayName ?? t("Bot") },
              })
            }
          >
            <NativeSymbol
              ios="desktopcomputer"
              android="desktop-outline"
              size={21}
              color={tokens.foreground}
            />
          </Pressable>
        ),
    });
  }, [
    barTransparent,
    botId,
    currentBot,
    currentBotStatus,
    displayName,
    groupAvatarItems,
    groupId,
    groupMemberNames,
    inGroup,
    shared,
    botMenuActions,
    navigation,
    router,
    t,
    tokens,
    colorScheme,
  ]);

  function leaveBot() {
    router.dismissAll();
    router.replace("/");
  }

  function clearThread() {
    if (!botId) return;
    setError(null);
    clearConversation(botId, () => {
      expandedHistoryThread.current = null;
      pinnedAroundRef.current = null;
      historyEpoch.current += 1;
    });
  }

  async function refresh() {
    if (!botId && !groupId) return;
    const targetBotId = botId;
    const targetGroupId = groupId;
    const epoch = historyEpoch.current;
    const next = threadEntriesOf(
      await rpc<MobileThreadResponse>(
        "threads/get",
        targetGroupId ? { groupId: targetGroupId } : { botId: targetBotId! },
      ),
    );
    if (
      !shouldApplyMobileThreadRefresh({
        requestEpoch: epoch,
        currentEpoch: historyEpoch.current,
        targetBotId,
        targetGroupId,
        activeBotId: activeBotId.current,
        activeGroupId: activeGroupId.current,
      })
    )
      return next;
    setSnap((prev) =>
      mergeMobileSnapshot(prev, next, expandedHistoryThread.current === next.threadId),
    );
    return next;
  }

  async function applyMessageJump(target: { botId?: string; groupId?: string; messageId: string }) {
    const threadTarget = target.groupId ? { groupId: target.groupId } : { botId: target.botId! };
    const epoch = historyEpoch.current;
    jumpGeneration.current += 1;
    const jumpId = jumpGeneration.current;
    const [response, page] = await Promise.all([
      rpc<MobileThreadResponse>("threads/get", threadTarget),
      rpc<ThreadMessagePage>("threads/messages", {
        ...threadTarget,
        around: { entryId: target.messageId },
      }),
    ]);
    const snap = threadEntriesOf(response);
    // The epoch check drops a jump that raced a conversation clear (or a bot switch); the
    // generation check drops an older same-thread jump that finished after a newer one.
    if (epoch !== historyEpoch.current || jumpId !== jumpGeneration.current) return;
    if (target.groupId && activeGroupId.current !== target.groupId) return;
    if (target.botId && activeBotId.current !== target.botId) return;
    const targetInPage = page.entries.some((entry) => entry.id === target.messageId);
    expandedHistoryThread.current = targetInPage ? page.threadId : null;
    pinnedAroundRef.current = targetInPage
      ? { ...threadTarget, messageId: target.messageId }
      : null;
    jumpScrollTarget.current = targetInPage ? target.messageId : null;
    setSnap(
      targetInPage ? { ...snap, entries: page.entries, olderCursor: page.olderCursor } : snap,
    );
  }

  async function loadOlderMessages() {
    if ((!botId && !groupId) || snap?.olderCursor == null || loadingOlder) return;
    loadingOlderContent.current = true;
    setLoadingOlder(true);
    const epoch = historyEpoch.current;
    try {
      const page = await rpc<ThreadMessagePage>("threads/messages", {
        ...(groupId ? { groupId } : { botId: botId! }),
        before: snap.olderCursor,
      });
      if (epoch !== historyEpoch.current) {
        loadingOlderContent.current = false;
        return;
      }
      expandedHistoryThread.current = page.threadId;
      setSnap((prev) => withOlderPage(prev, page));
    } catch (err) {
      loadingOlderContent.current = false;
      setError(err instanceof Error ? err.message : t("Could not load earlier messages"));
    } finally {
      setLoadingOlder(false);
    }
  }

  const markReadIfVisible = useCallback(() => {
    if (AppState.currentState !== "active" || !navigation.isFocused()) return;
    const target = groupId ?? botId;
    if (!target || readVisibleTarget.current === target) return;
    readVisibleTarget.current = target;
    if (activeThreadId.current) {
      void dismissThreadNotifications({
        threadId: activeThreadId.current,
      }).catch(() => undefined);
    }
    void rpc("threads/markRead", groupId ? { groupId } : { botId: botId! }).then(
      () => {
        void rpc<MobileSpaceNavigation>("spaces/list")
          .then((next) => syncAppBadge(unreadConversationCount(next.spaces)))
          .catch(() => undefined);
      },
      () => {
        if (readVisibleTarget.current === target) readVisibleTarget.current = null;
      },
    );
  }, [botId, groupId, navigation]);

  useEffect(() => {
    if (!notificationThreadId || AppState.currentState !== "active" || !navigation.isFocused())
      return;
    void setOpenNotificationThread({
      botId,
      threadId: notificationThreadId,
    }).catch(() => undefined);
    void dismissThreadNotifications({ threadId: notificationThreadId }).catch(() => undefined);
  }, [botId, navigation, notificationThreadId]);

  // Cancel delayed setup only when leaving this bot's thread (unmount or botId
  // change). Blur alone is not leave — settings/computer push must keep the timer.
  useEffect(() => {
    if (!botId) return;
    return () => {
      cancelFocusPrompt(botId);
    };
  }, [botId]);

  // Covers returning from a pushed screen; the AppState listener covers returning from background.
  useFocusEffect(
    useCallback(() => {
      if (botId) {
        focusPromptThreadActive(botId);
        void saveLastBotId(botId).catch(() => undefined);
      } else {
        // Group thread focus: prior bot screen may stay mounted, so clear any delayed setup.
        cancelFocusPrompt();
      }
      if (AppState.currentState === "active" && notificationThreadId) {
        void setOpenNotificationThread({
          botId,
          threadId: notificationThreadId,
        }).catch(() => undefined);
      }
      void refreshMentionBots();
      void refreshGroups();
      markReadIfVisible();
      return () => {
        void setOpenNotificationThread(null).catch(() => undefined);
      };
    }, [botId, markReadIfVisible, notificationThreadId, refreshMentionBots, refreshGroups]),
  );

  useEffect(() => {
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        // Safety net: the attach sheet can only close
        // itself while its host screen is in the foreground.
        setAttachSheetOpen(false);
        if (!navigation.isFocused() || !notificationThreadId) return;
        void setOpenNotificationThread({
          botId,
          threadId: notificationThreadId,
        }).catch(() => undefined);
        markReadIfVisible();
        return;
      }
      void setOpenNotificationThread(null).catch(() => undefined);
    });
    return () => appState.remove();
  }, [botId, markReadIfVisible, navigation, notificationThreadId]);

  useEffect(() => {
    if (!botId && !groupId) return;
    if (!messageId) {
      pinnedAroundRef.current = null;
      jumpScrollTarget.current = null;
    }
    expandedHistoryThread.current = null;
    historyEpoch.current += 1;
    const abort = new AbortController();
    void (async () => {
      // Pending search jumps load the around-page separately; avoid replacing it with latest.
      const next = messageId
        ? await rpc<MobileThreadResponse>(
            "threads/get",
            groupId ? { groupId } : { botId: botId! },
          ).catch((err: Error) => {
            setError(err.message);
            return null;
          })
        : await refresh().catch((err: Error) => {
            setError(err.message);
            return null;
          });
      if (abort.signal.aborted) return;
      let cursor = next?.cursor ?? -1;
      let retryMs = 250;
      while (!abort.signal.aborted) {
        try {
          await subscribeThread(
            groupId ? { groupId } : { botId: botId! },
            cursor,
            (event) => {
              cursor = Math.max(cursor, event.seq);
              retryMs = 250;
              const appended = appendedEntries(event);
              if (appended.some((entry) => entry.type === "clear")) {
                expandedHistoryThread.current = null;
                pinnedAroundRef.current = null;
                historyEpoch.current += 1;
              }
              setSnap((prev) => applyMobileThreadEvent(prev, event));
              if (event.type === "bot.updated") {
                void refreshMentionBots();
                void refreshGroups();
              }
              // Someone writing who was not in the group when it loaded has joined it since.
              if (
                groupId &&
                appended.some(
                  (entry) =>
                    entry.type === "user.message" &&
                    entry.payload.authorId !== undefined &&
                    !knownPeople.current.has(entry.payload.authorId),
                )
              ) {
                void refreshGroups();
              }
              if (botWordsOf(event).length > 0) {
                readVisibleTarget.current = null;
                markReadIfVisible();
              }
              if (isRunTerminalEvent(event)) {
                if (botId) noteBotRunEnded(botId);
                void refreshMentionBots();
                if (groupId) void refreshGroups();
                if (!jumpScrollTarget.current && !expandedHistoryThread.current) {
                  void refresh().catch(() => undefined);
                }
              }
            },
            abort.signal,
          );
        } catch {
          // A full refresh reconciles visible state; the event cursor still resumes without gaps.
        }
        if (abort.signal.aborted) break;
        if (!jumpScrollTarget.current && !expandedHistoryThread.current) {
          await refresh().catch(() => undefined);
        }
        await abortableDelay(retryMs, abort.signal);
        retryMs = Math.min(retryMs * 2, 5_000);
      }
    })();
    return () => {
      abort.abort();
    };
  }, [botId, groupId, markReadIfVisible, refreshMentionBots, refreshGroups]);

  useEffect(() => {
    if (!botId && !groupId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (
        AppState.currentState === "active" &&
        navigation.isFocused() &&
        !jumpScrollTarget.current &&
        !expandedHistoryThread.current
      ) {
        await refresh().catch(() => undefined);
      }
      if (!cancelled) {
        timer = setTimeout(() => void tick(), threadRefreshDelayMs(snap?.run?.status));
      }
    };
    timer = setTimeout(() => void tick(), threadRefreshDelayMs(snap?.run?.status));
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [botId, groupId, navigation, snap?.run?.status]);

  useEffect(() => {
    if ((!botId && !groupId) || !messageId) return;
    void applyMessageJump(groupId ? { groupId, messageId } : { botId: botId!, messageId }).catch(
      (err) => {
        setError(err instanceof Error ? err.message : t("Could not open message"));
      },
    );
  }, [botId, groupId, messageId]);

  useEffect(() => {
    setPendingAttachments((current) => attachmentsForThread(current, threadKey));
    clearDraft();
    setMentionQuery(null);
    setSlashQuery(null);
    setSelectedSkill(null);
    setSelectedMentions([]);
    setReplyTarget(null);
    setRewindTarget(null);
    if (messageSheetOwner.current) closeSheet(messageSheetOwner.current);
    messageSheetOwner.current = null;
    setRewindArtifactIds([]);
    setAttachmentNotice(null);
    setError(null);
  }, [threadKey]);

  function cancelRewind() {
    setRewindTarget(null);
    setRewindArtifactIds([]);
  }

  function startRewind(message: MobileMessage) {
    setReplyTarget(null);
    setRewindTarget(message);
    setRewindArtifactIds(
      message.blocks.flatMap((block) =>
        block.kind === "image" || block.kind === "file" ? [block.artifactId] : [],
      ),
    );
    const text = message.blocks
      .flatMap((block) => (block.kind === "text" && block.text ? [block.text] : []))
      .join("\n");
    setDraft(text);
    // Only what the edited message still names stays picked.
    setSelectedMentions(mentionsInDraft(text, selectedMentions));
    setSelectedSkill(skillInDraft(text, selectedSkill));
    setMentionQuery(null);
    setMentionRange(null);
    setSlashQuery(null);
  }

  // An iOS multiline field set to "" from JS keeps the height of its last text, so a
  // long message left the composer tall after sending; clearing it natively shrinks it.
  function clearDraft() {
    setDraft("");
    textInputRef.current?.clear();
  }

  /**
   * A picked skill or mention lives as long as its token text: editing it away drops it. The
   * caret is read off the edit itself, since iOS reports the selection after the text.
   */
  function updateDraft(value: string) {
    const caret = caretAfterEdit(draft, value);
    setDraft(value);
    latestDraft.current = value;
    const mentions = mentionsInDraft(value, selectedMentions);
    if (mentions.length !== selectedMentions.length) setSelectedMentions(mentions);
    const skill = skillInDraft(value, selectedSkill);
    if (skill !== selectedSkill) setSelectedSkill(skill);
    const mention = mentionQueryAt(value, caret, mentions);
    setMentionQuery(mention?.query ?? null);
    setMentionRange(mention ? { start: mention.start, caret } : null);
    const slashMatch = skill === null ? /^\/([^\n]*)$/.exec(value) : null;
    setSlashQuery(slashMatch ? (slashMatch[1] ?? "") : null);
  }

  /** Moving the caret moves the `@` picker with it: it shows for a query right before the caret. */
  function trackSelection({ start, end }: { start: number; end: number }) {
    const mention =
      start === end ? mentionQueryAt(latestDraft.current, start, selectedMentions) : null;
    setMentionQuery(mention?.query ?? null);
    setMentionRange(mention ? { start: mention.start, caret: start } : null);
  }

  function placeCaret(caret: number) {
    requestAnimationFrame(() => textInputRef.current?.setSelection(caret, caret));
  }

  function insertMention(mention: ComposerMention) {
    const range = mentionRange ?? { start: draft.length, caret: draft.length };
    const next = insertMentionToken(draft, range.start, range.caret, mention.name);
    setDraft(next.draft);
    setMentionQuery(null);
    setMentionRange(null);
    setSelectedMentions((current) =>
      current.some((selected) => mentionChipKey(selected) === mentionChipKey(mention))
        ? current
        : [...current, mention],
    );
    placeCaret(next.caret);
  }

  function insertSkill(skill: AgentSkillCatalogEntry) {
    const next = `/${skill.name} `;
    setSelectedSkill(skill);
    setDraft(next);
    setSlashQuery(null);
    placeCaret(next.length);
  }

  // Entering dictation closes and disables both pickers — a draft starting
  // with "@" or "/" must not stay tappable while the field is read-only.
  const closePickers = useCallback(() => {
    setMentionQuery(null);
    setSlashQuery(null);
  }, []);
  const recentWriting = useCallback(
    () =>
      rows
        .flatMap((row) =>
          row.item.kind === "message" && row.item.role === "user" ? [row.item] : [],
        )
        .slice(-8)
        .map((message) => blockText(message)),
    [rows],
  );
  const dictation = useComposerDictation({
    draft,
    setDraft,
    threadKey,
    closePickers,
    recentWriting,
  });

  useEffect(() => {
    if (dictation.dictating) AccessibilityInfo.announceForAccessibility(t("Dictating"));
  }, [dictation.dictating, t]);

  function insertDictation() {
    const caret = draft.length;
    dictation.insert();
    requestAnimationFrame(() => {
      textInputRef.current?.focus();
      textInputRef.current?.setSelection(caret, caret);
    });
  }

  function serializeComposerPromptText(): string {
    return serializeComposerPrompt(draft, skillInDraft(draft, selectedSkill));
  }

  function runSlashAction(action: SlashActionId) {
    clearDraft();
    setSlashQuery(null);
    if (action === "chat-settings") {
      if (inGroup && groupId) {
        router.push({ pathname: "/group-settings", params: { groupId } });
      } else if (botId) {
        router.push({ pathname: "/bot", params: { botId, tab: "settings" } });
      }
      return;
    }
    router.push(action === "settings-usage" ? "/usage" : "/account");
  }

  const canSend = Boolean(draft.trim()) || activePendingAttachments.length > 0;

  // Stop contour colour: the answering bot's own identity colour in a 1:1
  // thread. A group (several bots may be working), an unknown colour, or one
  // that would vanish into the page (near-black on dark, white on light) dims
  // to `foreground`.
  const stopContourColor =
    (!inGroup && botAccentOn(currentBot?.color, resolveMobileAppearance())) ||
    hexWithAlpha(tokens.foreground, 0.45);

  async function send() {
    const botTarget = botId;
    const groupTarget = groupId;
    if ((!botTarget && !groupTarget) || sending) return;
    const originThreadKey = groupTarget ?? botTarget;
    const attachments = attachmentsForThread(pendingAttachments, originThreadKey);
    const plan = resolveComposerSendPlan({
      text: serializeComposerPromptText(),
      mentions: mentionsInDraft(draft, selectedMentions),
      hasAttachments: attachments.length > 0 || rewindArtifactIds.length > 0,
    });
    if (plan.isNoOp) return;
    const trimmed = plan.trimmed;
    const dropDelayedSetup = () => {
      // Only after successful engagement so a failed upload/send keeps the setup card.
      if (botTarget) cancelFocusPrompt(botTarget);
    };

    // 7a / M2: snapshot the composer as it stands at the tap, then clear it
    // immediately — restored below if the send fails, except a rewind the
    // server already applied (`rewindApplied`), which stays applied, and
    // attachments already uploaded (unchanged behaviour: they upload again on
    // a retry, same as before this feature).
    const withoutLinkPreview = linkPreview.controller.isRemoved();
    linkPreview.controller.reset();
    const composerSnapshot = {
      draft,
      selectedMentions,
      selectedSkill,
      pendingAttachments: attachments,
      replyTarget,
      rewindTarget,
      rewindArtifactIds,
    };
    const clearOriginComposer = () => {
      setPendingAttachments((current) =>
        current.filter((attachment) => attachment.threadKey !== originThreadKey),
      );
      clearDraft();
      setMentionQuery(null);
      setSlashQuery(null);
      setSelectedSkill(null);
      setSelectedMentions([]);
      setReplyTarget(null);
      setRewindTarget(null);
      setRewindArtifactIds([]);
      setAttachmentNotice(null);
    };
    clearOriginComposer();
    let rewindApplied = false;
    // Once the server has the message (or the routine runs), a later failure
    // (a refresh) must not put it back in the composer to be sent twice.
    let delivered = false;

    setSending(true);
    setError(null);
    try {
      if (plan.shouldRunRoutines) {
        const sendNonce = newClientNonce();
        await Promise.all(
          plan.routineIds.map((routineId) =>
            rpc("routines/testRun", {
              routineId,
              clientNonce: `routine-mention:${sendNonce}:${routineId}`,
            }),
          ),
        );
      }
      if (!plan.shouldSend) {
        delivered = true;
        dropDelayedSetup();
        if (isCurrentTarget(botTarget, groupTarget)) {
          await refresh();
        }
        return;
      }
      const artifactIds: string[] = composerSnapshot.rewindTarget
        ? [...composerSnapshot.rewindArtifactIds]
        : [];
      for (const pending of composerSnapshot.pendingAttachments) {
        const artifact = await rpc<{ id: string }>("artifacts/create", {
          ...(groupTarget ? { groupId: groupTarget } : { botId: botTarget! }),
          name: pending.name,
          mimeType: pending.mimeType,
          contentBase64: pending.contentBase64,
        });
        artifactIds.push(artifact.id);
      }
      // Truncation happens here rather than on Edit, so backing out costs nothing.
      if (composerSnapshot.rewindTarget) {
        await rpc("threads/rewind", {
          ...(groupTarget ? { groupId: groupTarget } : { botId: botTarget! }),
          messageId: composerSnapshot.rewindTarget.id,
        });
        rewindApplied = true;
      }
      const clientNonce = newClientNonce();
      const replaced = editedWaitingDraft(view, draftEdit);
      await rpc(
        "threads/send",
        groupTarget
          ? {
              groupId: groupTarget,
              clientNonce,
              text: trimmed || undefined,
              mentions: plan.mentionPayload.length ? plan.mentionPayload : undefined,
              artifactIds: artifactIds.length ? artifactIds : undefined,
              replyToMessageId: composerSnapshot.replyTarget?.messageId,
              linkPreview: withoutLinkPreview ? (false as const) : undefined,
              draft: replaced?.draft,
            }
          : {
              botId: botTarget!,
              clientNonce,
              text: trimmed || undefined,
              mentions: plan.mentionPayload.length ? plan.mentionPayload : undefined,
              artifactIds: artifactIds.length ? artifactIds : undefined,
              replyToMessageId: composerSnapshot.replyTarget?.messageId,
              linkPreview: withoutLinkPreview ? (false as const) : undefined,
              draft: replaced?.draft,
            },
      );
      delivered = true;
      if (replaced) dropDraftEdit(replaced.itemId);
      dropDelayedSetup();
      void loadSessionToken()
        .then((token) => resumeLiveNotifications(currentApiBase(), token, selectedSpaceId() ?? ""))
        .catch(() => undefined);
      if (isCurrentTarget(botTarget, groupTarget)) {
        await refresh();
      }
    } catch (err) {
      // 7a: restore the snapshot — an already-applied rewind stays applied,
      // and a rewind that never reached the server comes back so the person
      // doesn't lose their edit target on a retry. Attachments carry their
      // own thread key; the rest is the screen's single composer, so it only
      // comes back if the person is still on the thread they sent from.
      if (!delivered) {
        if (composerSnapshot.pendingAttachments.length) {
          setPendingAttachments((current) => [...current, ...composerSnapshot.pendingAttachments]);
        }
        if (isCurrentTarget(botTarget, groupTarget)) {
          setDraft(composerSnapshot.draft);
          // The person had taken the link preview off: the draft comes back without it.
          if (withoutLinkPreview) linkPreview.controller.remove();
          setSelectedMentions(composerSnapshot.selectedMentions);
          setSelectedSkill(composerSnapshot.selectedSkill);
          setReplyTarget(composerSnapshot.replyTarget);
          if (!rewindApplied) {
            setRewindTarget(composerSnapshot.rewindTarget);
            setRewindArtifactIds(composerSnapshot.rewindArtifactIds);
          }
        }
      }
      if (isCurrentTarget(botTarget, groupTarget)) {
        setError(err instanceof Error ? err.message : t("Failed to send message"));
      }
    } finally {
      setSending(false);
    }
  }

  async function stop() {
    const targetBotId = botId;
    const targetGroupId = groupId;
    if ((!targetBotId && !targetGroupId) || sending) return;
    setSending(true);
    setError(null);
    try {
      await rpc(
        "threads/stop",
        targetGroupId ? { groupId: targetGroupId } : { botId: targetBotId! },
      );
    } catch (err) {
      if (isCurrentTarget(targetBotId, targetGroupId)) {
        setError(err instanceof Error ? err.message : t("Failed to stop work"));
      }
      setSending(false);
      return;
    }
    try {
      await refresh();
    } catch (err) {
      if (isCurrentTarget(targetBotId, targetGroupId)) {
        const detail = err instanceof Error ? err.message : t("Failed to refresh");
        setError(t("Work stopped, but the thread could not refresh: {detail}", { detail }));
      }
    } finally {
      setSending(false);
    }
  }

  const answerCard = useCallback(
    async (card: CardTarget, answer: string, edits?: CardEdits) => {
      const targetBotId = botId;
      const targetGroupId = groupId;
      if (!targetBotId && !targetGroupId) return;
      try {
        await rpc("threads/answer", {
          ...(targetGroupId ? { groupId: targetGroupId } : { botId: targetBotId! }),
          runId: card.runId,
          messageId: card.entryId,
          answer,
          ...(edits ? { edits } : {}),
        });
      } catch (error) {
        // A refused edit may mean the card was answered meanwhile: reload so the sheet
        // can close on a card that is no longer answerable.
        if (edits && isCurrentTarget(targetBotId, targetGroupId)) {
          await refresh().catch(() => undefined);
        }
        throw error;
      }
      // The answer is accepted: a failed reload must not read as a failed answer.
      if (isCurrentTarget(targetBotId, targetGroupId)) await refresh().catch(() => undefined);
    },
    [botId, groupId],
  );
  const answerMessage = useCallback(
    async (item: { id: string }, answer: string, edits?: CardEdits) => {
      const target = waitingAnswerTarget(waitingRef.current, item.id);
      if (target) await answerCard(target, answer, edits);
    },
    [answerCard],
  );

  const openBot = useCallback(
    (id: string, botName: string) =>
      router.push({
        pathname: "/thread",
        params: { botId: id, name: botName },
      }),
    [router],
  );
  const openComputerFromCard = useCallback(
    (id: string) =>
      router.push({
        pathname: "/computer",
        params: {
          botId: id,
          name:
            snap?.members?.find((member) => member.botId === id)?.name ?? displayName ?? t("Bot"),
          // Your own run's screen on a bot shared with you, here or in a group: the computer
          // stays its owner's.
          ...(sharedWithMe(mentionBots.find((bot) => bot.id === id)) ? { shared: "1" } : {}),
        },
      }),
    [router, snap?.members, displayName, t, mentionBots],
  );

  const speak = useCallback(
    (message: MobileMessage) =>
      void speakMessage(
        (message.role === "bot" ? message.botId : botId) ?? snap?.members?.[0]?.botId ?? "",
        message,
      ).catch((err) =>
        Alert.alert(t("Could not speak"), err instanceof Error ? err.message : t("Try again.")),
      ),
    [botId, snap?.members],
  );

  const attachActions: MenuAction[] = [
    {
      label: t("Photo library"),
      systemImage: "photo.on.rectangle",
      onPress: () => void addAttachments(pickFromLibrary),
    },
    { label: t("Camera"), systemImage: "camera", onPress: () => void addAttachments(takePhoto) },
    { label: t("File"), systemImage: "doc", onPress: () => void addAttachments(pickDocuments) },
  ];

  function showAttachMenu() {
    presentAttachSheet({
      title: t("Attach"),
      cancel: t("Cancel"),
      onOpenChange: setAttachSheetOpen,
      options: attachActions.map(({ label, onPress }) => ({ text: label, onPress })),
    });
  }

  async function addAttachments(
    picker: (existingCount: number) => Promise<{
      attachments: PickedAttachment[];
      skipped: Array<{ name: string; reason: string }>;
    }>,
  ) {
    const targetKey = groupId ?? botId;
    if (!targetKey) return;
    const result = await picker(activePendingAttachments.length);
    if ((groupId ?? botId) !== targetKey) return;
    if (result.attachments.length) {
      setPendingAttachments((current) => [
        ...current,
        ...result.attachments.map((attachment) => ({
          ...attachment,
          threadKey: targetKey,
        })),
      ]);
    }
    setAttachmentNotice(
      result.skipped.length
        ? t("Skipped {items}", {
            items: result.skipped.map((item) => formatAttachmentSkip(item)).join(", "),
          })
        : null,
    );
  }

  const answerableAskMessageId = waiting?.itemId ?? null;
  // The edit sheet lives only while its card can still be answered.
  useEffect(() => {
    syncSpawnBotEdit(answerableAskMessageId);
    if (threadKey) syncDraftEdit(threadKey, answerableAskMessageId);
  }, [threadKey, answerableAskMessageId]);
  const listExtraData = useMemo(
    () => ({ answerableAskMessageId, viewerUserId }),
    [answerableAskMessageId, viewerUserId],
  );
  const runError =
    snap?.run?.status === "failed" && snap.run.id !== dismissedRunErrorId
      ? (snap.run.error ?? null)
      : null;
  const shownError = error ?? runError;
  const liveRows = useMemo(() => [...rows].reverse(), [rows]);
  const pinnedTarget = pinnedAroundRef.current;
  const showPinnedPage = Boolean(
    jumpScrollTarget.current ||
      (pinnedTarget &&
        ((pinnedTarget.botId && pinnedTarget.botId === botId) ||
          (pinnedTarget.groupId && pinnedTarget.groupId === groupId))),
  );
  pinnedPageShowing.current = showPinnedPage;

  // MA-1: only a genuinely new message animates. "Load earlier" and the
  // pinned/jump page (its own ScrollView never reads `newMessageIds`) are
  // folded in as seeded — learned, but never reported as new — so returning
  // to the live list doesn't mistake them for arrivals either. Keyed on the
  // loaded snapshot's thread, not the route: the screen mounts (or switches
  // bot) before that thread's messages load, and seeding then would make
  // every message already there play its entrance.
  const arrivals = useMemo(
    () =>
      rows.flatMap(({ item, imageStack }) => [
        {
          id: item.id,
          createdAt: item.ts,
          ...(item.kind === "message" && item.role === "bot" && item.runId
            ? { runId: item.runId }
            : {}),
        },
        // An image joining a stack draws no row of its own: its arrival is the stack's.
        ...(imageStack && imageStack.front.item.id !== item.id
          ? [{ id: imageStack.front.item.id, createdAt: imageStack.front.item.ts }]
          : []),
      ]),
    [rows],
  );
  const newMessageIds = useMessageArrivals(snap?.threadId, arrivals, {
    seed: loadingOlderContent.current || showPinnedPage,
  });
  const arrivalStaggerMs = useMemo(
    () => messageArrivalStaggerMs(arrivals.filter((arrival) => newMessageIds.has(arrival.id))),
    [arrivals, newMessageIds],
  );
  const reactions = useMemo(
    () =>
      new Map(
        rows.flatMap((row) =>
          row.reactions.length > 0 ? [[row.item.id, new Map(row.reactions)] as const] : [],
        ),
      ),
    [rows],
  );
  // 7d: a reaction pill pops on appearing or its count rising, never on mount alone.
  const poppedReactionKeys = useReactionPops(threadKey, reactions);
  const labelOptions = { locale: dateLocaleForUi(), today: t("Today"), yesterday: t("Yesterday") };
  const jumpRowId = jumpScrollTarget.current ? view.rowOf.get(jumpScrollTarget.current) : undefined;

  function performScroll(action: ThreadScrollAction) {
    if (!action || showPinnedPage) return;
    scroll.current?.scrollToOffset({
      offset: 0,
      animated: action === "smooth" && !reducedMotion,
    });
  }

  // The composer floats over the thread's end: when it grows, keep the latest message above it,
  // as the typing bubble does (the list otherwise holds its visible position).
  useEffect(() => {
    performScroll(scrollBehavior.current.onTailChanged());
  }, [composerHeight]);

  contentChanged.current = () => {
    const blocked = Boolean(
      jumpScrollTarget.current ||
        (pinnedAroundRef.current &&
          ((pinnedAroundRef.current.botId && pinnedAroundRef.current.botId === botId) ||
            (pinnedAroundRef.current.groupId && pinnedAroundRef.current.groupId === groupId))) ||
        expandedHistoryThread.current === snap?.threadId,
    );
    performScroll(scrollBehavior.current.onContentChanged(blocked, latestMessageId));
    setThreadScrollState(scrollBehavior.current.state());
  };

  function updateUserScroll(event: NativeSyntheticEvent<NativeScrollEvent>) {
    listOffset.current = event.nativeEvent.contentOffset.y;
    // Inverted FlatList: contentOffset.y is distance from the latest messages.
    setThreadScrollState(
      scrollBehavior.current.onUserScroll(Math.max(0, event.nativeEvent.contentOffset.y)),
    );
  }

  async function reactToMessage(messageId: EntryId, reaction: MessageReaction) {
    const targetBotId = botId;
    const targetGroupId = groupId;
    if (!targetBotId && !targetGroupId) return;
    try {
      await rpc("threads/react", {
        ...(targetGroupId ? { groupId: targetGroupId } : { botId: targetBotId! }),
        messageId,
        reaction,
        clientNonce: newClientNonce(),
      });
      // 7d: a success haptic for *my* reaction only, never for one received
      // in real time from someone else, and never on a failed call.
      successHaptic();
    } catch (err) {
      if (!isCurrentTarget(targetBotId, targetGroupId)) return;
      setError(err instanceof Error ? err.message : t("Could not update reaction"));
    }
  }

  async function removeLinkPreview(message: MobileMessage) {
    const messageId = view.rows.find((row) => row.item.id === message.id)?.previewMessageId;
    if (!messageId) return;
    const targetBotId = botId;
    const targetGroupId = groupId;
    try {
      await rpc("messages/removeLinkPreview", { messageId });
    } catch (err) {
      if (!isCurrentTarget(targetBotId, targetGroupId)) return;
      setError(err instanceof Error ? err.message : t("Try again."));
    }
  }

  function messageActionGroups(
    message: MobileMessage,
    messageId: EntryId | undefined,
  ): MessageSheetAction[][] {
    const text = copyableMobileMessageText(message);
    return [
      [
        ...(messageId
          ? [
              {
                name: "reply",
                text: t("Reply"),
                icon: { ios: "arrowshape.turn.up.left", android: "arrow-undo-outline" } as const,
                onPress: () => setReplyTarget({ message, messageId }),
              },
            ]
          : []),
        ...(message.role === "user" && !sharedHistory
          ? [
              {
                name: "rewind",
                text: "Edit and resend",
                icon: { ios: "pencil", android: "create-outline" } as const,
                onPress: () => startRewind(message),
              },
            ]
          : []),
        ...(message.role === "bot" && blockText(message)
          ? [
              {
                name: "speak",
                text: t("Speak message"),
                icon: { ios: "speaker.wave.2", android: "volume-high-outline" } as const,
                onPress: () => void speak(message),
              },
            ]
          : []),
      ],
      [
        ...(text
          ? [
              {
                name: "copy",
                text: t("Copy"),
                icon: { ios: "doc.on.doc", android: "copy-outline" } as const,
                onPress: () => void Clipboard.setStringAsync(text).catch(() => undefined),
              },
            ]
          : []),
        // A link's preview is its author's to remove.
        ...(linkPreviewCardOf(message) && !messagePerson(message)
          ? [
              {
                name: "removeLinkPreview",
                text: t("Remove preview"),
                icon: { ios: "eye.slash", android: "eye-off-outline" } as const,
                onPress: () => void removeLinkPreview(message),
              },
            ]
          : []),
      ],
    ];
  }

  /** The same actions for assistive tech, which has no long press. */
  function messageActions(message: MobileMessage, messageId: EntryId | undefined) {
    const [primary = [], rest = []] = messageActionGroups(message, messageId);
    return [
      primary[0],
      ...(messageId && canReactToThreadMessage(message)
        ? [
            {
              name: "react",
              text: t("React"),
              onPress: () => showMessageActions(message, messageId),
            },
          ]
        : []),
      ...primary.slice(1),
      ...rest,
      ...(copyableMobileMessageText(message)
        ? [
            {
              name: "select",
              text: t("Select text"),
              onPress: () => showMessageActions(message, messageId, "text"),
            },
          ]
        : []),
    ].filter((action) => action !== undefined);
  }

  function showMessageActions(
    message: MobileMessage,
    messageId: EntryId | undefined,
    mode: "actions" | "text" = "actions",
  ) {
    if (mode === "actions") selectionHaptic();
    const owner = `thread:${threadKey}`;
    messageSheetOwner.current = owner;
    openSheet(
      router,
      (close) => (
        <MessageActionsSheet
          initialMode={mode}
          reactions={
            messageId && canReactToThreadMessage(message)
              ? MESSAGE_REACTIONS.map((emoji) => ({
                  emoji,
                  onPress: () => void reactToMessage(messageId, emoji),
                }))
              : []
          }
          groups={messageActionGroups(message, messageId)}
          text={copyableMobileMessageText(message)}
          close={close}
        />
      ),
      { owner, background: tokens.popover },
    );
  }

  // One props object per message whose handlers reach the latest render, so
  // `MessageBubble` can skip re-rendering while the thread scrolls or the
  // composer changes. Rebuilt with the language, its labels being translated, and with who reads a
  // group and who is in it, which decide its actions.
  const latestActions = useRef({ messageActions, showMessageActions });
  latestActions.current = { messageActions, showMessageActions };
  const actionPropsCache = useMemo(
    () =>
      new WeakMap<MobileMessage, { messageId: EntryId | undefined; props: MessageActionProps }>(),
    [locale, viewerUserId, creatorId, sharedHistory],
  );
  // One message per routine item, so its action props stay cached and `ItemRow` skips re-renders.
  const routineMessages = useMemo(() => new WeakMap<RoutineItem, MobileMessage>(), []);
  function messageActionProps(
    message: MobileMessage,
    messageId: EntryId | undefined,
  ): MessageActionProps {
    const cached = actionPropsCache.get(message);
    if (cached && cached.messageId === messageId) return cached.props;
    const props: MessageActionProps = {
      onLongPress: () => latestActions.current.showMessageActions(message, messageId),
      accessibilityActions: messageActions(message, messageId).map((action) => ({
        name: action.name,
        label: action.text,
      })),
      onAccessibilityAction: (event) => {
        latestActions.current
          .messageActions(message, messageId)
          .find((action) => action.name === event.nativeEvent.actionName)
          ?.onPress();
      },
    };
    actionPropsCache.set(message, { messageId, props });
    return props;
  }

  /** Name and character of the bot behind a message: the group roster
   * first, the bot list second, the route name last. */
  function messageBot(id: string | undefined) {
    const member = snap?.members?.find((candidate) => candidate.botId === id);
    const bot = mentionBots.find((candidate) => candidate.id === id);
    return {
      name: member?.name ?? bot?.name ?? displayName ?? t("Bot"),
      avatarCharacter: member ? member.avatarCharacter : bot?.avatarCharacter,
    };
  }

  /** Another person of the group behind a message; your own messages and bots' have none. */
  function messagePerson(message: MobileMessage): GroupPerson | undefined {
    const authorId = message.role === "user" ? (message.authorId ?? creatorId) : undefined;
    if (!authorId || !viewerUserId || authorId === viewerUserId) return undefined;
    return (
      snap?.people?.find((candidate) => candidate.userId === authorId) ?? {
        userId: authorId,
        name: "",
        image: null,
      }
    );
  }

  function gapBeforeRow(row: ThreadRow, previous: ThreadRow | undefined): number {
    if (previous && isAsideItem(row.item, showSteps) && isAsideItem(previous.item, showSteps)) {
      return 0;
    }
    if (row.chained) return 0;
    return row.firstOfGroup ? GROUP_GAP : WITHIN_GROUP_GAP;
  }

  function repliedMessage(entryId: EntryId): MobileMessage | undefined {
    const rowId = view.rowOf.get(entryId);
    const row = rowId === undefined ? undefined : rows[rowIndex.get(rowId) ?? -1];
    const item =
      row?.imageStack?.front.messageId === entryId ? row.imageStack.front.item : row?.item;
    if (item?.kind === "message") return item;
    return row ? routineMessage(row) : undefined;
  }

  function renderRow(row: ThreadRow, options?: { enableJump?: boolean; previous?: ThreadRow }) {
    const { item } = row;
    const marker = row.marker
      ? threadTimeMarkerLabel(row.marker.at, { ...labelOptions, withTime: row.marker.withTime })
      : "";
    const isNew = Boolean(!options?.enableJump && newMessageIds.has(item.id));
    const rewound = rewindIndex >= 0 && (rowIndex.get(item.id) ?? -1) >= rewindIndex;
    const origin = originSession(item);
    return (
      <View
        key={item.id}
        onLayout={
          options?.enableJump
            ? (event) => {
                if (jumpRowId !== item.id) return;
                const y = Math.max(0, event.nativeEvent.layout.y - 24);
                requestAnimationFrame(() => {
                  if (!jumpScrollTarget.current) return;
                  pinnedScroll.current?.scrollTo({ y, animated: true });
                  jumpScrollTarget.current = null;
                });
              }
            : undefined
        }
        style={{
          marginTop: Math.max(marker ? GROUP_GAP : 0, gapBeforeRow(row, options?.previous)),
        }}
      >
        {marker ? (
          <Text
            style={{
              alignSelf: "center",
              marginBottom: GROUP_GAP,
              color: tokens.mutedForeground,
              ...nativeTextStyle("label"),
            }}
          >
            {marker}
          </Text>
        ) : null}
        <View style={{ opacity: rewound ? 0.4 : 1 }}>
          {origin ? (
            <OriginLabel
              session={{ title: origin.title, load: () => sessionEntries(origin.sessionId) }}
              alignEnd={item.kind === "message" && item.role === "user"}
              botId={botId ?? snap?.members?.[0]?.botId ?? ""}
              groupId={groupId}
              bots={mentionBots}
              members={snap?.members}
            />
          ) : null}
          {item.kind === "message" ? (
            renderMessage(row, item, isNew, options?.enableJump)
          ) : (
            <>
              <ItemRow
                row={row}
                botId={botId ?? snap?.members?.[0]?.botId ?? ""}
                groupId={groupId}
                botName={displayName}
                bots={mentionBots}
                members={snap?.members}
                isNew={isNew}
                canAnswer={item.id === answerableAskMessageId}
                viewerUserId={viewerUserId}
                onAnswer={answerMessage}
                actionProps={routineActionProps(row)}
              />
              {item.kind === "routine" && row.routine?.kind === "message"
                ? renderReactions(row, inGroup ? FRAMED_INDENT : 0, false)
                : null}
            </>
          )}
        </View>
      </View>
    );
  }

  function renderReactions(row: ThreadRow, marginStart: number, mine: boolean) {
    if (row.reactions.length === 0) return null;
    return (
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 4,
          marginTop: 6,
          marginStart,
          justifyContent: mine ? "flex-end" : "flex-start",
        }}
      >
        {row.reactions.map(([emoji, count]) => (
          <ReactionPill
            key={emoji}
            emoji={emoji}
            count={count}
            pop={poppedReactionKeys.has(reactionPopKey(row.item.id, emoji))}
          />
        ))}
      </View>
    );
  }

  /** A routine's shown result acts as the bot message it reads as: the run's start entry is its target. */
  function routineActionProps(row: ThreadRow): MessageActionProps | undefined {
    const message = routineMessage(row);
    return message && messageActionProps(message, row.messageId ?? message.id);
  }

  function routineMessage(row: ThreadRow): MobileMessage | undefined {
    const { item, routine } = row;
    if (item.kind !== "routine" || routine?.kind !== "message") return undefined;
    let message = routineMessages.get(item);
    if (!message) {
      message = routineResultMessage(item, routine.text);
      routineMessages.set(item, message);
    }
    return message;
  }

  function renderMessage(
    row: ThreadRow,
    message: MobileMessage,
    isNew: boolean,
    enableJump: boolean | undefined,
  ) {
    const actionProps = messageActionProps(message, row.messageId);
    const stack = row.imageStack;
    // An image stack acts on its newest message, the rest of the row on the message that opens it.
    const frontActionProps = stack
      ? messageActionProps(stack.front.item, stack.front.messageId)
      : actionProps;
    const drawnBlocks = visibleMessageBlocks(message.blocks, showSteps);
    const chrome: MessageChrome = isAsideOnlyMessage(drawnBlocks) ? "aside" : "row";
    const authorBotId = message.role === "bot" ? message.botId : botId;
    const author = messageBot(authorBotId);
    const person = messagePerson(message);
    // Your own words sit on the trailing edge; a bot's and another person's on the leading one.
    const mine = message.role === "user" && !person;
    const authorStatus = isLiveMessage(message)
      ? (snap?.activeRuns?.find((run) => run.botId === authorBotId)?.status ??
        (snap?.run?.botId === authorBotId ? snap?.run?.status : currentBotStatus))
      : undefined;
    const isNarrationBotBubble =
      chrome === "row" &&
      message.role === "bot" &&
      drawnBlocks.length > 0 &&
      !drawnBlocks.some((block) => CARD_ONLY_BLOCK_KINDS.has(block.kind));
    const replyTo = message.role === "user" ? message.replyTo : undefined;
    const replyPreviewNode =
      chrome === "row" && replyTo ? repliedMessage(replyTo.entryId) : undefined;
    const previewCard = chrome === "row" ? linkPreviewCardOf(message) : undefined;
    const cardReplacesBubbleView = previewCard
      ? cardReplacesBubble(drawnBlocks, previewCard)
      : false;
    const replyToRow = () => {
      if (row.messageId) setReplyTarget({ message, messageId: row.messageId });
    };
    const bubble = (
      <MessageBubble
        botId={botId ?? snap?.members?.[0]?.botId ?? ""}
        groupId={groupId}
        message={message}
        replyPreview={replyPreviewNode}
        canAnswer={message.id === answerableAskMessageId}
        takeoverLive={message.id === takeoverItemId}
        takeoverWaitingOn={takeoverWaitingOn.get(message.id)}
        viewerUserId={viewerUserId}
        onAnswer={answerMessage}
        onOpenBot={openBot}
        onOpenComputer={openComputerFromCard}
        onPreviewMarkdown={setMarkdownPreview}
        actionProps={actionProps}
        isNew={isNew}
        imageStack={stack}
        imageActionProps={frontActionProps}
        imageArrival={Boolean(
          stack &&
            !enableJump &&
            stack.front.item.id !== message.id &&
            newMessageIds.has(stack.front.item.id),
        )}
        authorName={person?.name ?? (message.role === "user" ? t("You") : author.name)}
        incoming={Boolean(person)}
        // The card shows the link, so the bubble does not repeat the line that is only that link.
        previewedUrl={previewCard && !cardReplacesBubbleView ? previewCard.url : undefined}
        onOpenSession={openStepSession}
        routineLinks={!shared}
      />
    );
    const bubblePart = (imagePart: "words" | "images") => cloneElement(bubble, { imagePart });
    const previewNode = previewCard ? (
      <MessageArrival
        isNew={isNew}
        enterDelayMs={message.role === "bot" ? (arrivalStaggerMs.get(message.id) ?? 0) : 0}
      >
        <LinkPreviewCard
          card={previewCard}
          target={groupId ? { groupId } : { botId: botId ?? snap?.members?.[0]?.botId ?? "" }}
          mono={message.role === "user" || !inGroup}
          align={mine ? "end" : "start"}
          onLongPress={actionProps.onLongPress}
          accessibilityActions={actionProps.accessibilityActions}
          onAccessibilityAction={actionProps.onAccessibilityAction}
        />
      </MessageArrival>
    ) : null;
    const withPreview = (content: ReactNode) =>
      previewNode ? (
        cardReplacesBubbleView ? (
          // The card takes the bubble's place: the quote it carried stays above it, its skill lines under it.
          <View style={{ alignItems: mine ? "flex-end" : "flex-start" }}>
            <ReplyQuote message={message} replyPreview={replyPreviewNode} />
            {previewNode}
            <CardSkillLines message={message} isNew={isNew} />
          </View>
        ) : (
          <View style={{ gap: 4 }}>
            {content}
            {previewNode}
          </View>
        )
      ) : (
        content
      );
    // The person's bubbles: theirs on the trailing edge, another person's under their name.
    const personBubbles =
      chrome === "row" && message.role === "user"
        ? withPreview(
            stack ? (
              // The bubble's hold would race the stack's own long press, so the words and the
              // stack are two bubbles: the words keep the hold on the host's actions, the stack
              // keeps the entrance and its own long press on the newest message's.
              <View style={{ gap: 8, alignItems: mine ? "flex-end" : "flex-start" }}>
                {message.blocks.some((block) => block.kind !== "image") || replyTo ? (
                  <AnimatedMessageBubble
                    variant="user"
                    isNew={isNew}
                    onLongPress={actionProps.onLongPress}
                    accessibilityActions={actionProps.accessibilityActions}
                    onAccessibilityAction={actionProps.onAccessibilityAction}
                  >
                    {bubblePart("words")}
                  </AnimatedMessageBubble>
                ) : null}
                <AnimatedMessageBubble
                  variant="user"
                  isNew={isNew}
                  entranceOnly
                  onLongPress={frontActionProps.onLongPress}
                >
                  {bubblePart("images")}
                </AnimatedMessageBubble>
              </View>
            ) : (
              <AnimatedMessageBubble
                variant="user"
                isNew={isNew}
                onLongPress={actionProps.onLongPress}
                accessibilityActions={actionProps.accessibilityActions}
                onAccessibilityAction={actionProps.onAccessibilityAction}
              >
                {bubble}
              </AnimatedMessageBubble>
            ),
          )
        : null;
    return (
      <>
        {chrome === "row" && message.role === "bot" ? (
          <MessageRow
            avatar={
              <BotAvatar
                character={author.avatarCharacter}
                size={sizes.message}
                status={authorStatus}
              />
            }
            author={author.name}
            showAuthor={inGroup && row.firstOfGroup}
            showAvatar={inGroup && row.lastOfGroup}
            mono={!inGroup}
          >
            {withPreview(
              isNarrationBotBubble ? (
                <AnimatedMessageBubble
                  variant="bot"
                  isNew={isNew}
                  enterDelayMs={arrivalStaggerMs.get(message.id) ?? 0}
                  // A table scrolls sideways inside the bubble; a rightward drag
                  // there must move the table, not start a reply.
                  enableSwipeReply={
                    !enableJump &&
                    Boolean(row.messageId) &&
                    !message.blocks.some(
                      (block) => block.kind === "text" && hasMarkdownTable(block.text),
                    )
                  }
                  onLongPress={actionProps.onLongPress}
                  onSwipeReply={replyToRow}
                  accessibilityActions={actionProps.accessibilityActions}
                  onAccessibilityAction={actionProps.onAccessibilityAction}
                >
                  {bubble}
                </AnimatedMessageBubble>
              ) : (
                <MessageArrival isNew={isNew} enterDelayMs={arrivalStaggerMs.get(message.id) ?? 0}>
                  {drawnBlocks.some((block) => block.kind === "widget") ? (
                    bubble
                  ) : (
                    <Pressable accessible={false} onLongPress={actionProps.onLongPress}>
                      {bubble}
                    </Pressable>
                  )}
                </MessageArrival>
              ),
            )}
          </MessageRow>
        ) : chrome === "row" && person ? (
          <MessageRow
            avatar={
              <UserAvatar
                initials={userInitials(person.name)}
                image={person.image}
                size={sizes.message}
              />
            }
            author={person.name}
            showAuthor={row.firstOfGroup}
            showAvatar={row.lastOfGroup}
          >
            {personBubbles}
          </MessageRow>
        ) : chrome === "row" ? (
          personBubbles
        ) : (
          <View>{bubble}</View>
        )}
        {renderReactions(row, chrome === "row" && !mine && inGroup ? FRAMED_INDENT : 0, mine)}
      </>
    );
  }

  const workingBotsForLine = inGroup
    ? workingGroupBots
    : currentBot && botWorking && !hasLiveProgress
      ? [
          {
            botId: currentBot.id,
            name: currentBot.name,
            avatarCharacter: currentBot.avatarCharacter,
            status: currentBotStatus,
          },
        ]
      : [];
  // One bot only: an activity line names one bot's tool, so it would mislabel a group.
  const workingName =
    workingBotsForLine.length === 1
      ? (workingBotsForLine[0]?.name ?? t("Agent"))
      : t("{count} agents working", { count: workingBotsForLine.length });
  const workingAvatar =
    workingBotsForLine.length === 1 ? (
      <BotAvatar
        character={workingBotsForLine[0]?.avatarCharacter}
        size={sizes.message}
        status="running"
      />
    ) : (
      <GroupAvatar members={workingBotsForLine} size={sizes.message} />
    );
  // The typing bubble (design contract decision D1-b): no elapsed clock, no
  // generic "is working…" copy — three pulsing dots, or, for a single bot
  // whose activity is known, that activity in chatoyant text instead.
  //
  // 7c: it exits with a 120ms fade rather than snapping away the instant work
  // stops. `footerVisible` keeps the row mounted for that fade; `lastWorking`
  // remembers the avatar/name/activity to keep drawing while `workingActive`
  // has already gone false but the fade hasn't finished.
  const workingActive = workingBotsForLine.length > 0;
  const [footerVisible, setFooterVisible] = useState(workingActive);
  const footerOpacity = useSharedValue(workingActive ? 1 : 0);
  const shownActivityLabel = workingBotsForLine.length === 1 ? activityLabel : undefined;
  const lastWorking = useRef({
    avatar: workingAvatar,
    name: workingName,
    activityLabel: shownActivityLabel,
  });
  if (workingActive) {
    lastWorking.current = {
      avatar: workingAvatar,
      name: workingName,
      activityLabel: shownActivityLabel,
    };
  }
  useEffect(() => {
    if (workingActive) {
      setFooterVisible(true);
      footerOpacity.value = 1;
      return;
    }
    if (!footerVisible) return;
    footerOpacity.value = withTiming(0, { duration: CHAT_MOTION.typingExitMs }, (finished) => {
      if (finished) runOnJS(setFooterVisible)(false);
    });
    // footerVisible is read, not a trigger: re-running this branch every time
    // it flips would cancel the very fade it just started.
  }, [workingActive]);
  const footerAnimatedStyle = useAnimatedStyle(() => ({ opacity: footerOpacity.value }));
  const workingFooter = footerVisible ? (
    <Animated.View
      style={[{ marginTop: GROUP_GAP }, footerAnimatedStyle]}
      // The typing bubble grows the thread without a new message; keep it in
      // view above the composer when the reader is at the latest messages.
      onLayout={() => performScroll(scrollBehavior.current.onTailChanged())}
    >
      <MessageRow
        avatar={workingActive ? workingAvatar : lastWorking.current.avatar}
        author={workingActive ? workingName : lastWorking.current.name}
        showAuthor={inGroup}
        showAvatar={inGroup}
        mono={!inGroup}
      >
        <TypingBubble
          activityLabel={workingActive ? shownActivityLabel : lastWorking.current.activityLabel}
        />
      </MessageRow>
    </Animated.View>
  ) : null;

  const loadEarlierControl =
    snap?.olderCursor != null ? (
      <Pressable
        disabled={loadingOlder}
        onPress={() => void loadOlderMessages()}
        style={{
          alignSelf: "center",
          paddingHorizontal: 12,
          paddingVertical: 10,
        }}
      >
        <Text style={{ color: tokens.mutedForeground, fontSize: 13 }}>
          {loadingOlder ? t("Loading…") : t("Load earlier messages")}
        </Text>
      </Pressable>
    ) : null;

  return (
    <ThreadProviders
      tableActions={tableActions}
      mentions={composerMentionTargets}
      skills={agentSkills}
    >
      <AmbientBackground />
      <AnimatedKeyboardAvoidingView
        behavior="height"
        enabled={!keyboardSlides}
        keyboardVerticalOffset={headerHeight - underBar}
        style={[{ flex: 1, paddingHorizontal: THREAD_GUTTER }, keyboardSlide]}
      >
        <View style={{ flex: 1, position: "relative" }}>
          {showPinnedPage ? (
            <ScrollView
              key={jumpScrollTarget.current ?? pinnedTarget?.messageId ?? threadKey}
              ref={pinnedScroll}
              style={[{ flex: 1 }, BLEED_STYLE]}
              contentContainerStyle={{
                paddingHorizontal: THREAD_GUTTER,
                paddingTop: underBar + 8,
                paddingBottom: composerHeight,
              }}
              scrollIndicatorInsets={{ top: underBar, bottom: composerHeight }}
              automaticallyAdjustsScrollIndicatorInsets={false}
              maintainVisibleContentPosition={KEEP_VISIBLE_POSITION}
              keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
              keyboardShouldPersistTaps="handled"
            >
              {loadEarlierControl}
              {rows.map((row, index) =>
                renderRow(row, { enableJump: true, previous: rows[index - 1] }),
              )}
              {workingFooter}
            </ScrollView>
          ) : (
            <FlatList
              key={threadKey}
              ref={scroll}
              data={liveRows}
              inverted
              keyExtractor={(row) => row.item.id}
              extraData={listExtraData}
              style={[{ flex: 1 }, BLEED_STYLE]}
              // Inverted: the top padding is the thread's bottom edge, the bottom one its top, under the
              // bar; the scroll indicator stops below the bar too.
              scrollIndicatorInsets={{ top: composerHeight, bottom: underBar }}
              // iOS would add the safe area on top of these, and on the inverted list its top lands
              // at the visual bottom: the indicator stopped well above the composer.
              automaticallyAdjustsScrollIndicatorInsets={false}
              contentContainerStyle={{
                paddingHorizontal: THREAD_GUTTER,
                paddingTop: composerHeight,
                paddingBottom: underBar + 8,
              }}
              maintainVisibleContentPosition={KEEP_VISIBLE_POSITION}
              scrollEventThrottle={16}
              // dragging the thread down dismisses the keyboard following the
              // finger on iOS (Android has no true interactive equivalent, so it
              // dismisses on the drag instead); a tap that lands on a row's own
              // control still fires that control instead of just closing the keyboard.
              keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
              keyboardShouldPersistTaps="handled"
              onScrollBeginDrag={() => {
                userDragging.current = true;
              }}
              onScroll={(event) => {
                listOffset.current = event.nativeEvent.contentOffset.y;
                if (userDragging.current) updateUserScroll(event);
              }}
              onScrollEndDrag={(event) => {
                updateUserScroll(event);
                userDragging.current = false;
              }}
              onMomentumScrollEnd={updateUserScroll}
              onLayout={() => performScroll(scrollBehavior.current.onLayout(userDragging.current))}
              onContentSizeChange={() => {
                if (loadingOlderContent.current) {
                  loadingOlderContent.current = false;
                  return;
                }
                contentChanged.current();
              }}
              ListFooterComponent={loadEarlierControl}
              ListHeaderComponent={workingFooter}
              renderItem={({ item, index }) => renderRow(item, { previous: liveRows[index + 1] })}
            />
          )}
          {!showPinnedPage && threadScrollState.detached ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                threadScrollState.unread ? t("Jump to latest, new messages") : t("Jump to latest")
              }
              onPress={() => {
                performScroll(scrollBehavior.current.jumpToLatest());
                setThreadScrollState(scrollBehavior.current.state());
              }}
              style={{
                position: "absolute",
                left: "50%",
                marginLeft: -21,
                bottom: composerHeight + 12,
                width: 42,
                height: 42,
                borderRadius: 21,
                borderWidth: 1,
                borderColor: native.fillPressed,
                backgroundColor: native.fill,
                boxShadow: shadowsForAppearance(colorScheme).floating,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <NativeSymbol
                ios="arrow.down"
                android="arrow-down"
                size={18}
                color={tokens.foreground}
              />
              {threadScrollState.unread ? (
                <View
                  style={{
                    position: "absolute",
                    top: 3,
                    right: 3,
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    backgroundColor: tokens.primary,
                  }}
                />
              ) : null}
            </Pressable>
          ) : null}
        </View>
        <View
          onLayout={(event) => setComposerHeight(Math.round(event.nativeEvent.layout.height))}
          style={{
            // Floats over the thread's end, so the bubbles pass under the composer's glass.
            position: "absolute",
            left: THREAD_GUTTER,
            right: THREAD_GUTTER,
            bottom: 0,
            // 8 px above the safe area (floored so devices without a safe-area
            // inset, e.g. Android's 3-button nav, still keep a little breathing
            // room). Where the keyboard resizes the thread instead of sliding it,
            // the inset drops to 8 px above an open keyboard.
            paddingBottom: composerBottomInset,
          }}
        >
          {/* Under the bar, the thread fades into the ambient: nothing reads in that gap. */}
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              left: -THREAD_GUTTER,
              right: -THREAD_GUTTER,
              bottom: 0,
              height: composerBottomInset + 12,
              experimental_backgroundImage: `linear-gradient(to bottom, ${hexWithAlpha(ambientFloor[colorScheme], 0)} 0%, ${hexWithAlpha(ambientFloor[colorScheme], 0.95)} 70%)`,
            }}
          />
          {shownError ? (
            <View
              accessibilityRole="alert"
              style={{
                marginTop: 12,
                minHeight: 44,
                borderRadius: 22,
                backgroundColor: hexWithAlpha(tokens.destructive, 0.08),
                paddingHorizontal: 16,
                paddingVertical: 10,
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
              }}
            >
              <Text style={{ color: tokens.destructive, fontSize: 13, flex: 1 }}>{shownError}</Text>
              <Pressable
                accessibilityLabel={t("Dismiss error")}
                onPress={() => {
                  if (error) setError(null);
                  else if (snap?.run) setDismissedRunErrorId(snap.run.id);
                }}
              >
                <Text style={{ color: tokens.destructive }}>✕</Text>
              </Pressable>
            </View>
          ) : null}
          {replyTarget ? (
            // 7g: rises in on every appearance — the action sheet's "Reply" and
            // a bubble swipe past the threshold both just set `replyTarget`.
            <Animated.View
              entering={
                reducedMotion
                  ? FadeIn.duration(CHAT_MOTION.reducedFadeMs)
                  : FadeInDown.duration(CHAT_MOTION.replyPreviewMs)
              }
              style={{
                marginTop: 12,
                borderRadius: 14,
                borderWidth: 1,
                borderColor: tokens.border,
                backgroundColor: tokens.card,
                paddingHorizontal: 12,
                paddingVertical: 10,
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
              }}
            >
              <View style={{ flex: 1 }}>
                <Text style={{ color: tokens.mutedForeground, fontSize: 12 }}>
                  {t("Replying to")}
                </Text>
                <Text style={{ color: tokens.foreground, fontSize: 13 }} numberOfLines={1}>
                  {previewMessageText(replyTarget.message)}
                </Text>
              </View>
              <Pressable
                accessibilityLabel={t("Cancel reply")}
                onPress={() => setReplyTarget(null)}
              >
                <Text style={{ color: tokens.mutedForeground }}>✕</Text>
              </Pressable>
            </Animated.View>
          ) : null}
          {rewindTarget ? (
            <View
              style={{
                marginTop: 12,
                borderRadius: 14,
                borderWidth: 1,
                borderColor: tokens.border,
                backgroundColor: tokens.sidebar,
                paddingHorizontal: 12,
                paddingVertical: 10,
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
              }}
            >
              <Text
                style={{ color: tokens.mutedForeground, fontSize: 12, flex: 1 }}
                numberOfLines={2}
              >
                {`Editing message · ${rewindRemovedCount} messages after it will be removed`}
              </Text>
              <Pressable accessibilityLabel="Cancel edit" onPress={cancelRewind}>
                <Text style={{ color: tokens.mutedForeground }}>✕</Text>
              </Pressable>
            </View>
          ) : null}
          {attachmentNotice ? (
            <Text style={{ color: tokens.warning, marginTop: 12, fontSize: 13 }}>
              {attachmentNotice}
            </Text>
          ) : null}
          {mentionOptions.length ? (
            <View
              testID="mention-picker"
              style={{
                marginTop: 12,
                borderRadius: 14,
                borderWidth: 1,
                borderColor: tokens.border,
                backgroundColor: tokens.card,
                overflow: "hidden",
              }}
            >
              {mentionOptions.map((mention) => (
                <Pressable
                  key={mentionChipKey(mention)}
                  accessibilityLabel={t("@{name}", { name: mention.name })}
                  onPress={() => insertMention(mention)}
                  style={{
                    flexDirection: "row",
                    alignItems: "flex-start",
                    gap: 10,
                    paddingHorizontal: 14,
                    paddingVertical: 10,
                  }}
                >
                  <MentionOptionIcon mention={mention} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={{ color: tokens.foreground, fontSize: 14 }}>@{mention.name}</Text>
                    {mention.subtitle ? (
                      <Text
                        numberOfLines={1}
                        style={{
                          color: tokens.mutedForeground,
                          fontSize: 12.5,
                          marginTop: 2,
                        }}
                      >
                        {mention.subtitle}
                      </Text>
                    ) : null}
                  </View>
                </Pressable>
              ))}
            </View>
          ) : null}
          {slashSkillOptions.length || slashActionOptions.length ? (
            <View
              testID="slash-picker"
              style={{
                marginTop: 12,
                borderRadius: 14,
                borderWidth: 1,
                borderColor: tokens.border,
                backgroundColor: tokens.card,
                overflow: "hidden",
              }}
            >
              {slashSkillOptions.map((skill) => (
                <Pressable
                  key={skill.id}
                  accessibilityLabel={t("Skill {name}", { name: skill.name })}
                  onPress={() => insertSkill(skill)}
                  style={{
                    flexDirection: "row",
                    alignItems: "flex-start",
                    gap: 10,
                    paddingHorizontal: 14,
                    paddingVertical: 10,
                  }}
                >
                  <NativeSymbol
                    ios="cube"
                    android="cube-outline"
                    size={16}
                    color={tokens.mutedForeground}
                  />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={{ color: tokens.foreground, fontSize: 14 }}>{skill.name}</Text>
                    <Text
                      numberOfLines={1}
                      style={{
                        color: tokens.mutedForeground,
                        fontSize: 12.5,
                        marginTop: 2,
                      }}
                    >
                      {truncateSlashDescription(skill.description)}
                    </Text>
                  </View>
                </Pressable>
              ))}
              {slashActionOptions.map((action) => (
                <Pressable
                  key={action.id}
                  accessibilityLabel={t(action.label)}
                  onPress={() => runSlashAction(action.id)}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 10,
                    paddingHorizontal: 14,
                    paddingVertical: 10,
                  }}
                >
                  <NativeSymbol
                    ios="gearshape"
                    android="settings-outline"
                    size={16}
                    color={tokens.mutedForeground}
                  />
                  <Text style={{ color: tokens.foreground, fontSize: 14 }}>{t(action.label)}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          <View
            style={{
              marginTop: COMPOSER_GAP,
              // 20 pt from the screen's edges: off the bubbles' 14 pt edge, so the
              // composer reads as its own control rather than continuing their line.
              marginHorizontal: 6,
              flexDirection: "row",
              alignItems: "flex-end",
              gap: 8,
            }}
          >
            {dictation.dictating ? null : (
              <ComposerAttachBubble
                open={attachSheetOpen}
                focused={composerFocused}
                actions={attachActions}
                onAndroidOpen={showAttachMenu}
              />
            )}
            <ComposerShell
              style={{ flex: 1 }}
              state={canSend ? "typing" : "idle"}
              focused={composerFocused}
              dictating={dictation.dictating}
              dictationVolume={dictation.volume}
              attachments={
                activePendingAttachments.length || linkPreview.view.status !== "idle" ? (
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    // The link preview takes the row's width, which a horizontal scroll view
                    // never imposes on its children: measure it once and pass it down.
                    onLayout={(event) => setAttachmentsRowWidth(event.nativeEvent.layout.width)}
                  >
                    <View style={{ flexDirection: "row", gap: 8 }}>
                      {activePendingAttachments.map((attachment) => (
                        <ComposerAttachment
                          key={attachment.id}
                          name={attachment.name}
                          previewUri={attachment.previewUri}
                          disabled={dictation.dictating}
                          onRemove={() =>
                            setPendingAttachments((current) =>
                              current.filter((item) => item.id !== attachment.id),
                            )
                          }
                        />
                      ))}
                      {linkPreview.view.status === "idle" ? null : (
                        <ComposerLinkPreview
                          width={attachmentsRowWidth}
                          view={linkPreview.view}
                          disabled={dictation.dictating}
                          onRemove={() => linkPreview.controller.remove()}
                        />
                      )}
                    </View>
                  </ScrollView>
                ) : undefined
              }
              trailing={
                dictation.dictating ? undefined : (
                  <>
                    {dictation.available ? (
                      <ComposerButton
                        label={t("Dictate")}
                        haptic="none"
                        variant="bare"
                        disabled={sending}
                        onPress={dictation.start}
                      >
                        <NativeSymbol
                          ios="mic"
                          android="mic-outline"
                          size={20}
                          color={tokens.foreground}
                        />
                      </ComposerButton>
                    ) : null}
                    {canSend ? (
                      <ComposerButton
                        label={t("Send")}
                        haptic="send"
                        arrive
                        disabled={sending}
                        onPress={() => void send()}
                      >
                        <NativeSymbol
                          ios="arrow.up"
                          android="arrow-up"
                          size={16}
                          color={tokens.primaryForeground}
                        />
                      </ComposerButton>
                    ) : null}
                    {stoppable && !canSend ? (
                      <ComposerButton
                        label={t("Stop")}
                        haptic="commit"
                        disabled={sending}
                        contour={
                          <StopContour size={sizes.composerAction + 4} color={stopContourColor} />
                        }
                        onPress={() => void stop()}
                      >
                        <NativeSymbol
                          ios="stop.fill"
                          android="stop"
                          size={13}
                          color={tokens.primaryForeground}
                        />
                      </ComposerButton>
                    ) : null}
                  </>
                )
              }
              dictationCancel={
                dictation.dictating ? (
                  <ComposerButton
                    label={t("Cancel dictation")}
                    haptic="none"
                    variant="bare"
                    onPress={dictation.cancel}
                  >
                    <NativeSymbol ios="xmark" android="close" size={16} color={tokens.foreground} />
                  </ComposerButton>
                ) : undefined
              }
              dictationConfirm={
                dictation.dictating ? (
                  <>
                    {stoppable ? (
                      <ComposerButton
                        label={t("Stop")}
                        haptic="commit"
                        disabled={sending}
                        contour={
                          <StopContour size={sizes.composerAction + 4} color={stopContourColor} />
                        }
                        onPress={() => void stop()}
                      >
                        <NativeSymbol
                          ios="stop.fill"
                          android="stop"
                          size={13}
                          color={tokens.primaryForeground}
                        />
                      </ComposerButton>
                    ) : null}
                    <ComposerButton
                      label={t("Insert dictation")}
                      haptic="none"
                      onPress={insertDictation}
                    >
                      <NativeSymbol
                        ios="checkmark"
                        android="checkmark"
                        size={16}
                        color={tokens.primaryForeground}
                      />
                    </ComposerButton>
                  </>
                ) : undefined
              }
            >
              {dictation.dictating ? (
                <DictationPreview
                  prefix={dictation.previewPrefix}
                  finalText={dictation.finalText}
                  interimText={dictation.interimText}
                />
              ) : (
                <TextInput
                  ref={textInputRef}
                  onChangeText={updateDraft}
                  onSelectionChange={(event) => trackSelection(event.nativeEvent.selection)}
                  accessibilityLabel={composerName(t, displayName, answerName)}
                  placeholder={
                    displayName || answerName
                      ? composerName(t, displayName, answerName)
                      : t("Message…")
                  }
                  placeholderTextColor={tokens.mutedForeground}
                  selectionColor={tokens.foreground}
                  cursorColor={tokens.foreground}
                  keyboardAppearance={colorScheme}
                  multiline
                  textAlignVertical="center"
                  blurOnSubmit={false}
                  onFocus={() => setComposerFocused(true)}
                  onBlur={() => setComposerFocused(false)}
                  style={{
                    color: tokens.foreground,
                    // 5 lines max, then the field scrolls internally. iOS's
                    // multiline box is border-box (Yoga), so its 11 pt of
                    // vertical padding below counts against this height too —
                    // without adding it back, only about 4 lines actually fit.
                    maxHeight: Platform.OS === "ios" ? 5 * 22 + 2 * 11 : 110,
                    writingDirection: "auto",
                    ...nativeTextStyle("composer"),
                    // A multiline iOS field puts all of a line height's extra
                    // leading above the glyphs, so the text sat low in the
                    // capsule; the font's own line box centres it. The row is
                    // `sizes.composerTarget` (44) tall, and one composer line is
                    // 22, so 11 on each side centres it there.
                    ...(Platform.OS === "ios"
                      ? { lineHeight: undefined, paddingVertical: 11 }
                      : { paddingVertical: 4 }),
                  }}
                >
                  {/* A field cannot hold a view: a picked token is its own styled text. */}
                  {composerSegments(draft, selectedMentions, selectedSkill).map((segment) =>
                    segment.kind === "text" ? (
                      <Text key={segment.start}>{segment.text}</Text>
                    ) : (
                      <Text key={segment.start} style={{ fontWeight: "600" }}>
                        <Text style={{ color: tokens.mutedForeground, fontWeight: "500" }}>
                          {segment.text.slice(0, 1)}
                        </Text>
                        {segment.text.slice(1)}
                      </Text>
                    ),
                  )}
                </TextInput>
              )}
            </ComposerShell>
          </View>
        </View>
        <Modal
          visible={botActionsOpen}
          transparent
          animationType="fade"
          onRequestClose={() => setBotActionsOpen(false)}
        >
          <View
            style={{
              flex: 1,
              justifyContent: "center",
              padding: 24,
              backgroundColor: tokens.overlay,
            }}
          >
            <Pressable
              accessibilityLabel={t("Cancel")}
              onPress={() => setBotActionsOpen(false)}
              style={{
                position: "absolute",
                top: 0,
                right: 0,
                bottom: 0,
                left: 0,
              }}
            />
            <View
              accessibilityViewIsModal
              style={{
                backgroundColor: tokens.popover,
                borderRadius: 24,
                paddingVertical: 12,
              }}
            >
              {botActions.map((action) => (
                <Pressable
                  key={action.label}
                  accessibilityRole="button"
                  onPress={() => {
                    setBotActionsOpen(false);
                    action.onPress();
                  }}
                  style={{
                    minHeight: 56,
                    justifyContent: "center",
                    paddingHorizontal: 24,
                  }}
                >
                  <Text
                    style={{
                      color: action.destructive ? tokens.destructive : tokens.popoverForeground,
                      fontSize: 16,
                    }}
                  >
                    {action.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
        </Modal>
        {markdownPreview && artifactTarget ? (
          <MarkdownArtifactPreview
            threadTarget={artifactTarget}
            target={markdownPreview}
            onClose={() => setMarkdownPreview(null)}
          />
        ) : null}
        {tablePreview ? (
          <TablePreview table={tablePreview} onClose={() => setTablePreview(null)} />
        ) : null}
        {stepSession ? (
          <SessionSheet
            session={stepSession}
            botId={botId ?? snap?.members?.[0]?.botId ?? ""}
            groupId={groupId}
            bots={mentionBots}
            members={snap?.members}
            onClose={() => setStepSession(null)}
          />
        ) : null}
      </AnimatedKeyboardAvoidingView>
      {barTransparent ? <ThreadScrollEdge height={headerHeight + 40} /> : null}
    </ThreadProviders>
  );
}

function MentionOptionIcon({ mention }: { mention: ComposerMention }) {
  const tokens = useMobileTokens();
  if (mention.kind === "routine") {
    return (
      <NativeSymbol ios="clock" android="time-outline" size={16} color={tokens.mutedForeground} />
    );
  }
  if (mention.kind === "connector") {
    return (
      <NativeSymbol
        ios="puzzlepiece.extension"
        android="extension-puzzle-outline"
        size={16}
        color={tokens.mutedForeground}
      />
    );
  }
  if (mention.kind === "group") {
    return (
      <View
        style={{
          width: 16,
          height: 16,
          borderRadius: 8,
          backgroundColor: tokens.muted,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={{ color: tokens.foreground, fontSize: 9 }}>G</Text>
      </View>
    );
  }
  if (mention.kind === "everyone") {
    return (
      <View
        style={{
          width: 16,
          height: 16,
          borderRadius: 8,
          backgroundColor: tokens.muted,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={{ color: tokens.foreground, fontSize: 9 }}>@</Text>
      </View>
    );
  }
  return (
    <View
      style={{
        width: 16,
        height: 16,
        borderRadius: 4,
        backgroundColor: mention.color ?? tokens.mutedForeground,
      }}
    />
  );
}

/** The send arrow pivots in like the web's `animate-arrive`, but rotating —
 * -90° to 0°, scaling up from .6, fading in — over `motion.pivot`. */
const COMPOSER_PIVOT = new Keyframe({
  0: { opacity: 0, transform: [{ rotate: "-90deg" }, { scale: 0.6 }] },
  100: {
    opacity: 1,
    transform: [{ rotate: "0deg" }, { scale: 1 }],
    easing: Easing.bezier(0.32, 0.72, 0, 1),
  },
}).duration(motion.pivot);

/** A composer action disc: a `sizes.composerTarget` (44 pt) touch target
 * around a `sizes.composerAction` (36 pt) `primary` disc — settles to scale
 * .9 while pressed (skipped under reduced motion), the web's `rk-press-round`. */
function ComposerButton({
  label,
  onPress,
  disabled,
  arrive = false,
  haptic,
  contour,
  variant = "disc",
  children,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  /** Animate in with a pivot on mount — the send arrow appearing with the first character. */
  arrive?: boolean;
  /** "none" for a dictation control that already fires its own haptic (mic tap, ✓ insert) or has none (×). */
  haptic: "send" | "commit" | "none";
  /** The Stop button's animated ring, drawn just outside the disc. */
  contour?: ReactNode;
  /** "bare" draws just the icon at full size in the touch target, no ink
   * disc — dictation's × (the design has no disc behind Cancel,
   * unlike Send/Stop/✓). */
  variant?: "disc" | "bare";
  children: ReactNode;
}) {
  const tokens = useMobileTokens();
  const reducedMotion = useReducedMotion();
  const pressed = useSharedValue(0);
  const pressStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 - pressed.value * 0.1 }],
  }));
  const press = (down: boolean) => {
    if (reducedMotion) return;
    pressed.value = withTiming(down ? 1 : 0, {
      duration: motion.press,
      easing: Easing.bezier(0.32, 0.72, 0, 1),
    });
  };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={() => {
        if (haptic === "send") sendHaptic();
        else if (haptic === "commit") commitHaptic();
        onPress();
      }}
      onPressIn={() => press(true)}
      onPressOut={() => press(false)}
      style={{
        width: sizes.composerTarget,
        height: sizes.composerTarget,
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {contour}
      <Animated.View
        entering={arrive && !reducedMotion ? COMPOSER_PIVOT : undefined}
        style={[
          variant === "disc"
            ? {
                width: sizes.composerAction,
                height: sizes.composerAction,
                borderRadius: radii.pill,
                backgroundColor: tokens.primary,
                alignItems: "center",
                justifyContent: "center",
              }
            : { alignItems: "center", justifyContent: "center" },
          pressStyle,
        ]}
      >
        {children}
      </Animated.View>
    </Pressable>
  );
}

function previewMessageText(message: MobileMessage): string {
  const text = message.blocks
    .flatMap((block) => {
      if (block.kind === "channel_message" && block.text) {
        return [
          `${messagingProviderLabel(block.provider, block.transport)} · ${block.fromLabel}: ${block.text}`,
        ];
      }
      if (block.kind === "text" && block.text) return [block.text];
      return [];
    })
    .join(" ")
    .trim();
  if (text) return text;
  if (message.blocks.some((block) => block.kind === "image" || block.kind === "file")) {
    return t("Attachment");
  }
  return t("Message");
}

function memberName(
  members: MobileSnapshot["members"] | undefined,
  botId: string | undefined,
): string | undefined {
  if (!botId || !members) return undefined;
  return members.find((member) => member.botId === botId)?.name;
}

async function speakMessage(botId: string, message: MobileMessage) {
  const text = blockText(message);
  if (!text.trim()) return;
  if (!(await speakText(text, { botId }))) {
    throw new Error(t("Add a voice provider in Voice settings."));
  }
}

type MessageActionProps = Pick<TextProps, "accessibilityActions" | "onAccessibilityAction"> & {
  // Plain `() => void`, not `TextProps["onLongPress"]`'s `(event) => void`:
  // every implementation ignores the event, and this shape assigns cleanly
  // both to a `Pressable`'s `onLongPress` (a card's untouched wrapper) and to
  // `AnimatedMessageBubble`'s RNGH-driven `onLongPress` (a plain callback).
  onLongPress: () => void;
};

const MessageBubble = memo(function MessageBubble({
  botId,
  groupId,
  message,
  replyPreview,
  canAnswer,
  takeoverLive,
  takeoverWaitingOn,
  viewerUserId,
  onAnswer,
  onOpenBot,
  onOpenComputer,
  onPreviewMarkdown,
  actionProps,
  isNew,
  imageStack,
  imageActionProps,
  imageArrival,
  imagePart,
  authorName,
  incoming = false,
  openImageViewer,
  previewedUrl,
  onOpenSession,
  routineLinks = true,
}: {
  botId: string;
  groupId?: string;
  message: MobileMessage;
  replyPreview?: MobileMessage;
  canAnswer: boolean;
  /** This message is the computer card of a run still waiting for the user's screen. */
  takeoverLive?: boolean;
  /** This message is the computer card of another person's run, which waits on them by name. */
  takeoverWaitingOn?: string;
  viewerUserId?: string;
  onAnswer: (message: MobileMessage, answer: string, edits?: CardEdits) => Promise<void>;
  onOpenBot: (botId: string, name: string) => void;
  onOpenComputer?: (botId: string) => void;
  onPreviewMarkdown: (target: MarkdownArtifactPreviewTarget) => void;
  actionProps: MessageActionProps;
  isNew: boolean;
  /** The images of the stack this message opens, when the thread joins consecutive image messages. */
  imageStack?: ImageStackModel;
  /** What a long press on its images does: the actions of the stack's newest message. */
  imageActionProps?: MessageActionProps;
  /** A newer image joined the stack in this render. */
  imageArrival?: boolean;
  /** Draws only the words and files, or only the images, when they sit in bubbles of their own. */
  imagePart?: "words" | "images";
  /** Who sent it, as assistive tech names the images. */
  authorName: string;
  /** Another person's message in a group, drawn on the leading edge under their name. */
  incoming?: boolean;
  /** Opens the image viewer from inside a native modal, where a link would dismiss the modal. */
  openImageViewer?: (payload: ImageViewerPayload) => void;
  /** The link its card shows: a line that is only this link is left out of the text drawn. */
  previewedUrl?: string;
  /** Opens the helper session a step ran. */
  onOpenSession?: (sessionId: SessionId, title: string) => void;
  /** False on a bot shared with you: its routine screens are its owner's. */
  routineLinks?: boolean;
}) {
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const showSteps = useDebugMode();
  const artifactTarget: MobileArtifactTarget = groupId ? { groupId } : { botId };
  const cardBotId = message.role === "bot" ? message.botId : botId;
  // The projection rebuilds the message on every event: keyed on its mentions' content, the
  // resolver stays the same object and the memoized markdown it feeds does not re-parse.
  const mentionsKey = linkMentionsKey(message);
  const mentions = useMemo<NativeLinkMentions | undefined>(() => {
    const lookup = linkMentionsOf(message);
    const target: MobileArtifactTarget = groupId ? { groupId } : { botId };
    return (
      lookup && {
        ...lookup,
        icon: (artifactId, tint) => (
          <LinkMentionIcon target={target} artifactId={artifactId} tint={tint} />
        ),
      }
    );
  }, [mentionsKey, groupId, botId]);
  // Mono-bot grammar (design contract §3b): the narration bubble caps at 82%
  // of the thread instead of 88% of the content column.
  const mono = !groupId;
  const metaLines = useSkillLines(message, isNew);
  // A card draws no bubble to hang the lines under, so they stand alone below it.
  const withSkillLines = (card: ReactNode) =>
    metaLines.length > 0 ? (
      <View style={{ gap: 8, width: "100%" }}>
        {card}
        <BubbleMeta lines={metaLines} standalone />
      </View>
    ) : (
      card
    );
  const computerBlock = message.blocks.find(
    (block): block is Extract<MessageBlock, { kind: "computer" }> => block.kind === "computer",
  );
  if (computerBlock) {
    return withSkillLines(
      <ComputerCard
        block={computerBlock}
        onOpen={takeoverLive && onOpenComputer ? () => onOpenComputer(cardBotId) : undefined}
        waitingOn={takeoverWaitingOn}
        accessibilityActions={actionProps.accessibilityActions}
        onAccessibilityAction={actionProps.onAccessibilityAction}
      />,
    );
  }
  const appConnectBlocks = message.blocks.filter(
    (block): block is Extract<MessageBlock, { kind: "app_connect" }> =>
      block.kind === "app_connect",
  );
  const questionCard = questionCardOf(message.blocks);
  const secretAsk = message.blocks.find(
    (block): block is Extract<MessageBlock, { kind: "ask" }> =>
      block.kind === "ask" && isSecretAskBlock(block),
  );
  if (questionCard || secretAsk) {
    return (
      <View style={{ gap: 8, width: "100%" }}>
        {questionCard ? (
          <QuestionCard
            key={message.id}
            block={questionCard.block}
            form={questionCard.form}
            messageId={message.id}
            canAnswer={canAnswer}
            onAnswer={(answer) => onAnswer(message, answer)}
            questionProps={actionProps}
          />
        ) : secretAsk ? (
          <SecretAskBlock
            ask={secretAsk}
            actionProps={actionProps}
            canAnswer={canAnswer}
            onAnswer={(answer) => onAnswer(message, answer)}
          />
        ) : null}
        {appConnectBlocks.map((block, index) => (
          <AppConnectCard
            key={`${block.provider}-${index}`}
            botId={cardBotId}
            block={block}
            accessibilityActions={actionProps.accessibilityActions}
            onAccessibilityAction={actionProps.onAccessibilityAction}
          />
        ))}
        {metaLines.length > 0 ? <BubbleMeta lines={metaLines} standalone /> : null}
      </View>
    );
  }
  // An aside is a note between messages, not something a bot said: like the
  // web transcript it carries no author, no bubble and no message actions.
  const channelMessage = message.blocks.find(
    (block): block is Extract<MessageBlock, { kind: "channel_message" }> =>
      block.kind === "channel_message",
  );
  if (channelMessage) {
    return withSkillLines(
      <Interstitial avatars={null}>
        {`${messagingProviderLabel(channelMessage.provider, channelMessage.transport)} · ${
          channelMessage.fromLabel
        }: ${channelMessage.text}`}
      </Interstitial>,
    );
  }
  const metaNote = message.blocks.find(
    (block): block is Extract<MessageBlock, { kind: "meta" }> => block.kind === "meta",
  );
  if (metaNote) {
    return withSkillLines(<Interstitial avatars={null}>{metaNote.text}</Interstitial>);
  }
  const special = message.blocks.find(
    (block): block is Extract<MessageBlock, { kind: "child_bot" }> => block.kind === "child_bot",
  );
  if (special) {
    const removed = special.status === "deleted" || special.status === "archived";
    return withSkillLines(
      <Pressable
        {...actionProps}
        onPress={
          removed ? undefined : () => onOpenBot(special.botId ?? "", special.name ?? t("Bot"))
        }
        style={{ width: "90%", opacity: removed ? 0.6 : 1 }}
      >
        <Surface style={{ paddingHorizontal: 16, paddingVertical: 14 }}>
          <View
            style={{
              flexDirection: "row",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            <Text
              style={{
                color: tokens.foreground,
                fontSize: 15,
                fontWeight: "600",
              }}
            >
              {special.name || t("Bot")}
            </Text>
            <Text
              style={{
                color: removed ? tokens.destructive : tokens.success,
                ...nativeTextStyle("label"),
              }}
            >
              {special.status === "archived"
                ? t("archived")
                : special.status === "deleted"
                  ? t("deleted")
                  : t("bot")}
            </Text>
          </View>
          <Text style={{ color: tokens.mutedForeground, marginTop: 8, ...nativeTextStyle("meta") }}>
            {removed
              ? special.status === "archived"
                ? t("Archived. Chat, memory, and files kept.")
                : t("Removed with chat, computer, and memory.")
              : special.title || t("Opened its thread.")}
          </Text>
        </Surface>
      </Pressable>,
    );
  }
  if (appConnectBlocks.length > 0 && appConnectBlocks.length === message.blocks.length) {
    return (
      <View style={{ gap: 8, width: "100%" }}>
        {appConnectBlocks.map((block, index) => (
          <AppConnectCard
            key={`${block.provider}-${index}`}
            botId={cardBotId}
            block={block}
            accessibilityActions={actionProps.accessibilityActions}
            onAccessibilityAction={actionProps.onAccessibilityAction}
          />
        ))}
        {metaLines.length > 0 ? <BubbleMeta lines={metaLines} standalone /> : null}
      </View>
    );
  }
  const widgets = message.blocks.filter((block) => block.kind === "widget");
  if (widgets.length > 0) {
    return (
      <View style={{ gap: 8, width: "100%" }}>
        {widgets.map((block, index) => (
          <WidgetCard key={index} block={block} artifactTarget={artifactTarget} />
        ))}
        {metaLines.length > 0 ? <BubbleMeta lines={metaLines} standalone /> : null}
      </View>
    );
  }
  const askBlock = message.blocks.find(
    (block): block is Extract<MessageBlock, { kind: "ask" }> =>
      block.kind === "ask" && Boolean(block.actions?.length),
  );
  if (askBlock) {
    return (
      <View style={{ gap: 8, width: "100%" }}>
        <ApprovalCard
          threadKey={groupId ?? botId}
          block={askBlock}
          cardId={message.id}
          cardBotId={cardBotId}
          routineLinks={routineLinks}
          canAnswer={canAnswer}
          viewerUserId={viewerUserId}
          actionProps={actionProps}
          onAnswer={(answer, edits) => onAnswer(message, answer, edits)}
        />
        {appConnectBlocks.map((block, index) => (
          <AppConnectCard
            key={`${block.provider}-${index}`}
            botId={cardBotId}
            block={block}
            accessibilityActions={actionProps.accessibilityActions}
            onAccessibilityAction={actionProps.onAccessibilityAction}
          />
        ))}
        {metaLines.length > 0 ? <BubbleMeta lines={metaLines} standalone /> : null}
      </View>
    );
  }
  const attachments = message.blocks.filter(
    (block) => block.kind === "image" || block.kind === "file",
  );
  const shownBlocks = previewedUrl
    ? blocksWithoutPreviewedLinkLine(message.blocks, previewedUrl)
    : message.blocks;
  const caption = shownBlocks
    .flatMap((block) => {
      if (block.kind === "channel_message" && block.text) {
        return [
          `${messagingProviderLabel(block.provider, block.transport)} · ${block.fromLabel}: ${block.text}`,
        ];
      }
      return block.kind === "text" && block.text ? [block.text] : [];
    })
    .join("\n");
  if (attachments.length > 0) {
    const images = imageStack?.images ?? imagesOf(message, message.id);
    const files = attachments.filter((attachment) => attachment.kind === "file");
    const ink = message.role === "user" ? tokens.chatUserForeground : tokens.foreground;
    const surfaceStyle = {
      paddingHorizontal: 14,
      paddingVertical: 12,
      gap: 8,
      ...(message.role === "user" ? { backgroundColor: tokens.chatUser } : null),
    };
    const quote = replyQuote(message, replyPreview);
    const openImage = (zoomed: boolean) => {
      const payload = {
        images: [...images].reverse(),
        author: authorName,
        target: artifactTarget,
        zoomed,
      };
      if (openImageViewer) openImageViewer(payload);
      else setImageViewerPayload(payload);
    };
    const words =
      quote || caption ? (
        <>
          {quote ? (
            <Text
              style={{
                color: message.role === "user" ? tokens.chatUserForeground : tokens.mutedForeground,
                ...nativeTextStyle("meta"),
              }}
              numberOfLines={2}
            >
              {quote}
            </Text>
          ) : null}
          {caption ? (
            <Text style={{ color: ink, ...nativeTextStyle("body") }}>{caption}</Text>
          ) : null}
        </>
      ) : null;
    // The author now lives in the row above (`MessageRow`). With images, the words are a bubble and
    // the images a stack outside it; the files and cards stay in a bubble of their own.
    return (
      <View
        style={{
          maxWidth: "100%",
          gap: 8,
          alignSelf: message.role === "user" && !incoming ? "flex-end" : "flex-start",
          alignItems: message.role === "user" && !incoming ? "flex-end" : "flex-start",
        }}
      >
        {images.length > 0 && words && imagePart !== "images" ? (
          <Surface style={surfaceStyle}>{words}</Surface>
        ) : null}
        {images.length > 0 && imagePart !== "words" ? (
          <ImageStack
            images={images}
            target={artifactTarget}
            align={message.role === "user" && !incoming ? "end" : "start"}
            mono={mono || message.role === "user"}
            author={authorName}
            arrival={imageArrival ?? false}
            onOpen={openImage}
            zoom={!openImageViewer}
            onLongPress={(imageActionProps ?? actionProps).onLongPress}
            accessibilityActions={(imageActionProps ?? actionProps).accessibilityActions}
            onAccessibilityAction={(imageActionProps ?? actionProps).onAccessibilityAction}
          />
        ) : null}
        {imagePart === "images" ? null : files.length > 0 ||
          appConnectBlocks.length > 0 ||
          (images.length === 0 && words) ? (
          <Surface style={surfaceStyle}>
            {images.length === 0 ? words : null}
            {files.map((attachment, index) => (
              <Pressable
                {...actionProps}
                key={`${attachment.artifactId ?? attachment.name ?? "file"}-${index}`}
                onPress={() =>
                  attachment.artifactId
                    ? attachment.mimeType === "text/markdown"
                      ? onPreviewMarkdown({
                          artifactId: attachment.artifactId,
                          name: attachment.name ?? t("Markdown file"),
                          mimeType: attachment.mimeType,
                        })
                      : void openMobileArtifact(
                          artifactTarget,
                          attachment.artifactId,
                          attachment.name ?? t("File"),
                          attachment.mimeType ?? "text/plain",
                        ).catch((err) =>
                          Alert.alert(
                            t("Could not open file"),
                            err instanceof Error ? err.message : t("Try again."),
                          ),
                        )
                    : undefined
                }
              >
                <Text style={{ color: ink, ...nativeTextStyle("body") }}>
                  📎 {attachment.name ?? t("File")}
                </Text>
                {attachment.kind === "file" && attachment.size ? (
                  <Text
                    style={{
                      color:
                        message.role === "user"
                          ? tokens.chatUserForeground
                          : tokens.mutedForeground,
                      marginTop: 4,
                      ...nativeTextStyle("meta"),
                    }}
                  >
                    {attachment.mimeType ?? "file"} · {attachment.size} bytes
                  </Text>
                ) : null}
              </Pressable>
            ))}
            {appConnectBlocks.map((block, index) => (
              <AppConnectCard
                key={`${block.provider}-${index}`}
                botId={cardBotId}
                block={block}
                accessibilityActions={actionProps.accessibilityActions}
                onAccessibilityAction={actionProps.onAccessibilityAction}
              />
            ))}
            {metaLines.length > 0 ? <BubbleMeta lines={metaLines} /> : null}
          </Surface>
        ) : metaLines.length > 0 ? (
          <BubbleMeta lines={metaLines} standalone />
        ) : null}
      </View>
    );
  }
  const segments = messagePresentationSegments(shownBlocks, showSteps);
  const live = isLiveMessage(message);
  const firstContent = segments.findIndex((segment) => segment.kind === "content");
  const lastContent = skillLineSegment(
    segments.map((segment) =>
      segment.kind === "content" ? blockText({ ...message, blocks: segment.blocks }) : "",
    ),
  );
  return (
    <View style={{ gap: 8, width: "100%" }}>
      {segments.map((segment, index) =>
        segment.kind === "steps" ? (
          <AgentSteps
            key={`${message.id}-steps-${index}`}
            block={segment.block}
            live={live}
            onOpenSession={onOpenSession}
          />
        ) : (
          <MessageText
            key={`${message.id}-content-${index}`}
            message={{ ...message, blocks: segment.blocks }}
            replyPreview={index === firstContent ? replyPreview : undefined}
            actionProps={actionProps}
            mono={mono}
            incoming={incoming}
            meta={index === lastContent ? metaLines : undefined}
            mentions={mentions}
          />
        ),
      )}
      {appConnectBlocks.map((block, index) => (
        <AppConnectCard
          key={`${block.provider}-${index}`}
          botId={cardBotId}
          block={block}
          accessibilityActions={actionProps.accessibilityActions}
          onAccessibilityAction={actionProps.onAccessibilityAction}
        />
      ))}
      {lastContent < 0 && metaLines.length > 0 ? <BubbleMeta lines={metaLines} standalone /> : null}
    </View>
  );
});

function ApprovalCard({
  threadKey,
  block,
  cardId,
  cardBotId,
  routineLinks,
  canAnswer,
  viewerUserId,
  actionProps,
  onAnswer,
}: {
  /** The thread the card shows in: a draft's Edit message sheet belongs to it. */
  threadKey: string;
  block: Extract<MessageBlock, { kind: "ask" }>;
  cardId: string;
  cardBotId: string;
  /** False on a bot shared with you: its routine screens are its owner's. */
  routineLinks: boolean;
  canAnswer: boolean;
  viewerUserId?: string;
  actionProps: MessageActionProps;
  onAnswer: (answer: string, edits?: CardEdits) => Promise<void>;
}) {
  const tokens = mobileTokens();
  const { t } = useI18n();
  const router = useRouter();
  if (block.draft) {
    return (
      <DraftCard
        key={cardId}
        threadKey={threadKey}
        block={block}
        draft={block.draft}
        messageId={cardId}
        canAnswer={canAnswer}
        viewerUserId={viewerUserId}
        onAnswer={onAnswer}
        onReconnect={() => router.push("/integrations")}
      />
    );
  }
  const approval = isApprovalAskBlock(block);
  const routineCard = approval ? block.routine : undefined;
  const header = approval && !routineCard ? { who: t("Needs your call") } : undefined;
  const created = block.created;
  const routineSettled = (): ReactNode => {
    if (!created) {
      switch (routineCardSettlement(block)) {
        case "failed":
          return t("Couldn't create");
        case "not_now":
          return t("Not now");
        case "creating":
          return t("Creating…");
        default:
          return t("Answered");
      }
    }
    const line = (
      <Text style={{ color: tokens.mutedForeground, ...nativeTextStyle("meta") }}>
        {block.confirms === "updated" ? t("Routine updated") : t("Routine created")} ·{" "}
        <Text style={{ color: tokens.foreground, fontWeight: "600" }}>{created.label}</Text>
      </Text>
    );
    // A shared bot's routine screen is its owner's: the routine is managed by asking the bot.
    if (!routineLinks) return line;
    return (
      <Pressable
        accessibilityRole="link"
        onPress={() =>
          router.push({
            pathname: "/bot-routine",
            params: { botId: cardBotId, routineId: created.id },
          })
        }
        style={{ flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1 }}
      >
        {line}
        <NativeSymbol
          ios="chevron.right"
          android="chevron-forward"
          size={11}
          color={tokens.mutedForeground}
        />
      </Pressable>
    );
  };
  const answeredLine =
    block.status === "answered"
      ? routineCard
        ? routineSettled()
        : formatApprovalAnswer(block.answer, block.actions, approval)
      : !canAnswer
        ? t("No longer active")
        : undefined;
  return (
    <FramedBlock
      header={header ? { ...header, dot: answeredLine === undefined } : undefined}
      question={<Text {...actionProps}>{block.text}</Text>}
      consequence={routineCard ? undefined : block.detail}
      answered={answeredLine}
      actions={
        answeredLine === undefined && approval ? (
          <AskActions
            actions={block.actions ?? []}
            consequential={!routineCard}
            accessibilityActions={actionProps.accessibilityActions}
            onAccessibilityAction={actionProps.onAccessibilityAction}
            onAnswer={(answer) => onAnswer(answer)}
            onEdit={
              block.spawnBot && canAnswer && canEditSpawnBotCard(block.spawnBot, viewerUserId)
                ? () =>
                    openSpawnBotEdit(router, {
                      messageId: cardId,
                      spawnBot: block.spawnBot!,
                      submit: (edits) => onAnswer("allow", edits),
                    })
                : undefined
            }
          />
        ) : undefined
      }
    >
      {routineCard && answeredLine === undefined ? (
        <RoutineCardPreview routine={routineCard} />
      ) : null}
    </FramedBlock>
  );
}

const NO_ACTIONS: MessageActionProps = { onLongPress: () => {} };

type OpenedSession = { title: string; load: () => Promise<SessionEntry[]>; runId?: string };

const ItemRow = memo(function ItemRow({
  row,
  botId,
  groupId,
  botName,
  bots,
  members,
  isNew,
  canAnswer,
  viewerUserId,
  onAnswer,
  actionProps,
  readOnly = false,
}: {
  row: ThreadRow;
  botId: string;
  groupId?: string;
  botName?: string;
  bots: MobileBot[];
  members?: MobileSnapshot["members"];
  isNew: boolean;
  canAnswer: boolean;
  viewerUserId?: string;
  onAnswer?: (item: { id: string }, answer: string, edits?: CardEdits) => Promise<void>;
  /** The actions of a routine's shown result; a row without them keeps its entrance only. */
  actionProps?: MessageActionProps;
  readOnly?: boolean;
}) {
  const tokens = mobileTokens();
  const { t } = useI18n();
  const router = useRouter();
  const [session, setSession] = useState<OpenedSession | null>(null);
  const { item } = row;
  const avatarOf = (id: string | undefined) => {
    const member = members?.find((candidate) => candidate.botId === id);
    return {
      identity: id,
      character: member
        ? member.avatarCharacter
        : bots.find((bot) => bot.id === id)?.avatarCharacter,
    };
  };
  const openPeerMessages = readOnly
    ? undefined
    : (ownBotId: string, peerBotId: string, peer: string) =>
        router.push({
          pathname: "/peer-messages",
          params: {
            botId: ownBotId,
            botName: memberName(members, ownBotId) ?? botName ?? "",
            botCharacter: avatarOf(ownBotId).character ?? undefined,
            peerBotId,
            peerBotName: peer,
            peerCharacter: avatarOf(peerBotId).character ?? undefined,
          },
        });
  const body = (() => {
    switch (item.kind) {
      case "message":
        return null;
      case "routine": {
        const role = row.routine;
        if (role?.kind === "message") {
          const inGroup = Boolean(groupId);
          const openRun = () => setSession(runSession(item));
          return (
            <>
              {inGroup ? null : <OriginText title={item.name} alignEnd={false} onPress={openRun} />}
              <MessageRow
                avatar={<BotAvatar {...avatarOf(item.botId)} size={sizes.message} />}
                author={
                  <>
                    {memberName(members, item.botId) ?? botName}
                    <Text style={{ color: tokens.mutedForeground }}>
                      {" · "}
                      <Text accessibilityRole="button" onPress={openRun} suppressHighlighting>
                        {item.name}
                      </Text>
                    </Text>
                  </>
                }
                showAuthor={inGroup && row.firstOfGroup}
                showAvatar={inGroup && row.lastOfGroup}
                mono={!inGroup}
              >
                <RoutineBubble
                  item={item}
                  text={role.text}
                  groupId={groupId}
                  botId={botId}
                  isNew={isNew}
                  mono={!inGroup}
                  actionProps={actionProps}
                />
              </MessageRow>
            </>
          );
        }
        return role ? (
          <RoutineFailureLine
            item={item}
            count={role.count}
            since={role.since}
            onOpen={() => setSession(runSession(item))}
          />
        ) : null;
      }
      case "handoff": {
        const from = memberName(members, item.fromBotId) ?? t("bot");
        const to = memberName(members, item.toBotId) ?? t("bot");
        const label = t("{from} messaged {to}", { from, to });
        return <HandoffDivider>{item.text ? `${label} · ${item.text}` : label}</HandoffDivider>;
      }
      case "botMessage": {
        const sent = item.direction === "sent";
        const ownBotId = sent ? item.botId : botId;
        const peerBotId = item.peer.kind === "bot" ? item.peer.botId : undefined;
        const card = botMessageCard(item);
        const peerThread = readOnly ? null : card.peerThread;
        const pair = sent ? [ownBotId, peerBotId] : [peerBotId, ownBotId];
        const pairItems = pair.map(avatarOf);
        return (
          <Interstitial
            accessibilityLabel={card.label}
            avatars={<StackedAvatars items={pairItems} size={sizes.interstitial} />}
            hitSlop={{ top: 5, bottom: 5, left: 8, right: 8 }}
            style={card.muted ? { opacity: 0.6 } : undefined}
            onPress={
              openPeerMessages && peerBotId
                ? () => openPeerMessages(ownBotId, peerBotId, item.peer.name)
                : undefined
            }
          >
            {card.before}
            {peerThread ? (
              <Text accessibilityRole="link" onPress={() => router.push(peerThread)}>
                {card.peer}
              </Text>
            ) : (
              card.peer
            )}
            {card.after}
          </Interstitial>
        );
      }
      case "divider":
        return <DividerRow reason={item.reason} />;
      case "effect": {
        const { card } = item;
        if (!card) return null;
        return (
          <ApprovalCard
            threadKey={groupId ?? botId}
            block={card}
            cardId={item.id}
            cardBotId={item.botId ?? botId}
            routineLinks={!sharedWithMe(bots.find((bot) => bot.id === (item.botId ?? botId)))}
            canAnswer={!readOnly && canAnswer}
            viewerUserId={viewerUserId}
            actionProps={NO_ACTIONS}
            onAnswer={async (answer, edits) => {
              await onAnswer?.(item, answer, edits);
            }}
          />
        );
      }
      case "note":
        return <NoteRow item={item} isNew={isNew} />;
    }
  })();
  return (
    <>
      {body}
      {session ? (
        <SessionSheet
          session={session}
          botId={botId}
          groupId={groupId}
          bots={bots}
          members={members}
          onClose={() => setSession(null)}
        />
      ) : null}
    </>
  );
});

function DividerRow({ reason }: { reason: Extract<ThreadItem, { kind: "divider" }>["reason"] }) {
  const tokens = mobileTokens();
  const { t } = useI18n();
  const rule = (
    <View style={{ flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: tokens.border }} />
  );
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
      {rule}
      <Text style={{ color: tokens.mutedForeground, ...nativeTextStyle("label") }}>
        {reason === "compaction"
          ? t("Earlier messages summarized")
          : reason === "rewind"
            ? t("Message edited")
            : t("Conversation cleared")}
      </Text>
      {rule}
    </View>
  );
}

function NoteRow({ item, isNew }: { item: NoteItem; isNew: boolean }) {
  const router = useRouter();
  if (item.type === "system.note") {
    return <Interstitial avatars={null}>{item.payload.text}</Interstitial>;
  }
  if (item.type === "skill.learnt") {
    const { skillId, name, change } = item.payload;
    return (
      <BubbleMeta lines={[skillLineMeta({ skillId, name, change }, isNew, router)]} standalone />
    );
  }
  const memory = memoryNoteLine(item);
  if (memory) {
    return (
      <BubbleMeta
        lines={[
          {
            id: item.id,
            label: memory,
            icon: { ios: "person.2", android: "people-outline" },
            live: isNew,
          },
        ]}
        standalone
      />
    );
  }
  return null;
}

function OriginLabel({
  session,
  alignEnd,
  botId,
  groupId,
  bots,
  members,
}: {
  session: OpenedSession;
  alignEnd: boolean;
  botId: string;
  groupId?: string;
  bots: MobileBot[];
  members?: MobileSnapshot["members"];
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <OriginText title={session.title} alignEnd={alignEnd} onPress={() => setOpen(true)} />
      {open ? (
        <SessionSheet
          session={session}
          botId={botId}
          groupId={groupId}
          bots={bots}
          members={members}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function OriginText({
  title,
  alignEnd,
  onPress,
}: {
  title: string;
  alignEnd: boolean;
  onPress: () => void;
}) {
  const tokens = mobileTokens();
  return (
    <Text
      accessibilityRole="button"
      onPress={onPress}
      suppressHighlighting
      style={{
        alignSelf: alignEnd ? "flex-end" : "flex-start",
        marginBottom: 4,
        color: tokens.mutedForeground,
        ...nativeTextStyle("label"),
      }}
    >
      {title}
    </Text>
  );
}

function sessionEntries(sessionId: string): Promise<SessionEntry[]> {
  return rpc<{ entries: SessionEntry[] }>("sessions/entries", { sessionId }).then(
    (result) => result.entries,
  );
}

function SessionSheet({
  session,
  botId,
  groupId,
  bots,
  members,
  onClose,
}: {
  session: OpenedSession;
  botId: string;
  groupId?: string;
  bots: MobileBot[];
  members?: MobileSnapshot["members"];
  onClose: () => void;
}) {
  const tokens = mobileTokens();
  const router = useRouter();
  const colorScheme = useResolvedAppearance();
  const { t } = useI18n();
  const showSteps = useDebugMode();
  const [entries, setEntries] = useState<SessionEntry[] | "failed" | null>(null);
  // The sheet is a native modal: it closes first, and the viewer opens once it is gone. Only iOS
  // reports the end of the dismissal.
  const [viewing, setViewing] = useState<ImageViewerPayload | null>(null);
  const openViewer = (payload: ImageViewerPayload) => {
    if (Platform.OS === "ios") {
      setViewing(payload);
      return;
    }
    setImageViewerPayload(payload);
    onClose();
    router.push(IMAGE_VIEWER_HREF);
  };
  useEffect(() => {
    let open = true;
    session.load().then(
      (loaded) => open && setEntries(loaded),
      () => open && setEntries("failed"),
    );
    return () => {
      open = false;
    };
  }, [session]);
  const rows = useMemo(
    () =>
      Array.isArray(entries)
        ? projectThreadView(entries, {
            rendersNothing: (item) =>
              drawsNothing(item, (blocks) => hasVisibleMessagePresentation(blocks, showSteps)) ||
              isViewedRunLine(item, session.runId),
          }).rows
        : [],
    [entries, showSteps, session.runId],
  );
  const report =
    Array.isArray(entries) && session.runId ? unshownRunReport(entries, session.runId) : undefined;
  const botNameOf = (id: string) =>
    members?.find((member) => member.botId === id)?.name ?? t("Bot");
  return (
    <PreviewSheet
      title={session.title}
      onClose={onClose}
      visible={!viewing}
      onDismiss={() => {
        if (!viewing) return;
        setImageViewerPayload(viewing);
        onClose();
        router.push(IMAGE_VIEWER_HREF);
      }}
    >
      <View style={{ paddingTop: 16 }}>
        {entries === null ? <ActivityIndicator color={tokens.mutedForeground} /> : null}
        {entries === "failed" ? (
          <Text style={{ color: tokens.destructive, ...nativeTextStyle("meta") }}>
            {t("Could not load this chat")}
          </Text>
        ) : null}
        {rows.map((row, index) => (
          <View
            key={row.item.id}
            style={{ marginTop: index === 0 ? 0 : row.firstOfGroup ? GROUP_GAP : WITHIN_GROUP_GAP }}
          >
            {row.item.kind === "message" ? (
              <MessageBubble
                botId={botId}
                groupId={groupId}
                message={row.item}
                canAnswer={false}
                onAnswer={async () => {}}
                onOpenBot={() => {}}
                onPreviewMarkdown={() => {}}
                actionProps={NO_ACTIONS}
                isNew={false}
                authorName={row.item.role === "bot" ? botNameOf(row.item.botId) : t("You")}
                openImageViewer={openViewer}
              />
            ) : (
              <ItemRow
                row={row}
                botId={botId}
                groupId={groupId}
                bots={bots}
                members={members}
                isNew={false}
                canAnswer={false}
                readOnly
              />
            )}
          </View>
        ))}
        {report ? (
          <View style={{ marginTop: rows.length > 0 ? GROUP_GAP : 0 }}>
            <ChatMarkdown palette={tokens} colorScheme={colorScheme}>
              {truncateMarkdownForRender(report)}
            </ChatMarkdown>
          </View>
        ) : null}
      </View>
    </PreviewSheet>
  );
}

function useSkillLines(message: MobileMessage, isNew: boolean): BotBubbleMeta[] {
  useI18n();
  const router = useRouter();
  const skillLines = skillSourcesOf(message.blocks);
  const skillsAtMount = useRef(skillLines.length);
  const skillsLive = isNew || skillLines.length > skillsAtMount.current;
  return skillLines.map((line) => skillLineMeta(line, skillsLive, router));
}

function skillLineMeta(
  line: { skillId: string; name: string; change: "learned" | "updated" | "deleted" },
  live: boolean,
  router: ReturnType<typeof useRouter>,
): BotBubbleMeta {
  return {
    id: `${line.skillId}:${line.change}`,
    label:
      line.change === "learned"
        ? t("Skill learned · {name}", { name: line.name })
        : line.change === "updated"
          ? t("Skill updated · {name}", { name: line.name })
          : t("Skill deleted · {name}", { name: line.name }),
    icon: { ios: "book", android: "book-outline" },
    onPress:
      line.change === "deleted"
        ? undefined
        : () =>
            void skillLineRoute(line, () =>
              rpc<AgentSkillCatalogEntry[]>("agentSkills/list").catch(() => []),
            ).then((route) => router.push(route)),
    live,
  };
}

/** The skill lines of a message whose link card took its bubble's place, standing alone under the card. */
function CardSkillLines({ message, isNew }: { message: MobileMessage; isNew: boolean }) {
  const lines = useSkillLines(message, isNew);
  return lines.length > 0 ? <BubbleMeta lines={lines} standalone /> : null;
}

/** The run's state as one symbol: the shape tells it apart without colour, the colour only confirms. */
const ROUTINE_STATE_SYMBOL = {
  failed: { ios: "xmark.circle.fill", android: "close-circle" },
} as const;

function runSession(item: RoutineItem): OpenedSession {
  return {
    title: item.name,
    runId: item.runId,
    load: () =>
      rpc<{ entries: SessionEntry[] }>("runs/entries", { runId: item.runId }).then(
        (result) => result.entries,
      ),
  };
}

function RoutineFailureLine({
  item,
  count: failures,
  since,
  onOpen,
}: {
  item: RoutineItem;
  count: number;
  since: string;
  onOpen: () => void;
}) {
  const tokens = mobileTokens();
  const { t } = useI18n();
  const reason = failureReason(item.finished?.failure ?? null);
  const count =
    failures > 1
      ? t("{count} failures since {time}", {
          count: failures,
          time: failureSinceLabel(since, item.ts, dateLocaleForUi()),
        })
      : null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[item.name, reason ?? t("Failed"), count].filter(Boolean).join(", ")}
      onPress={onOpen}
      unstable_pressDelay={130}
      style={({ pressed }) => ({
        minHeight: 44,
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        marginHorizontal: -8,
        paddingHorizontal: 8,
        borderRadius: radii.row,
        backgroundColor: pressed ? tokens.secondary : "transparent",
      })}
    >
      <NativeSymbol
        ios={ROUTINE_STATE_SYMBOL.failed.ios}
        android={ROUTINE_STATE_SYMBOL.failed.android}
        size={18}
        color={tokens.destructive}
      />
      <Text
        style={{
          flex: 1,
          color: tokens.foreground,
          ...nativeTextStyle("rowName", { weight: 500 }),
        }}
      >
        {item.name}
        {reason ? (
          <Text
            style={{
              color: tokens.mutedForeground,
              ...nativeTextStyle("rowName", { weight: 400 }),
            }}
          >{` · ${reason}`}</Text>
        ) : null}
      </Text>
      {count ? (
        <Text
          style={{
            color: tokens.mutedForeground,
            ...nativeTextStyle("time"),
            fontVariant: ["tabular-nums"],
          }}
        >
          {count}
        </Text>
      ) : null}
    </Pressable>
  );
}

/** The quote of the message a reply answers, above its bubble (or its card), unfilled. */
function ReplyQuote({
  message,
  replyPreview,
}: {
  message: MobileMessage;
  replyPreview?: MobileMessage;
}) {
  const tokens = mobileTokens();
  const quote = replyQuote(message, replyPreview);
  if (!quote) return null;
  return (
    <Text
      numberOfLines={2}
      style={{
        marginBottom: 6,
        color: tokens.mutedForeground,
        ...nativeTextStyle("meta"),
      }}
    >
      {quote}
    </Text>
  );
}

function replyQuote(message: MobileMessage, replyPreview: MobileMessage | undefined): string {
  const replyTo = message.role === "user" ? message.replyTo : undefined;
  if (!replyTo) return "";
  if (replyTo.quote) return `“${replyTo.quote}”`;
  return replyPreview ? previewMessageText(replyPreview) : "";
}

/**
 * What was said: the person's words in the `chatUser` bubble, a bot's in its
 * `muted` narration bubble (design contract § Grouping — "1 message = 1
 * bubble") — never both in the same box. The reply preview stays above the
 * bubble, aligned on its edge, unfilled.
 */
function MessageText({
  message,
  replyPreview,
  actionProps,
  mono = false,
  incoming = false,
  meta,
  mentions,
}: {
  message: MobileMessage;
  replyPreview?: MobileMessage;
  actionProps: MessageActionProps;
  mono?: boolean;
  /** Another person's words: their bubble on the leading edge. */
  incoming?: boolean;
  /** The skill lines under its last bubble. */
  meta?: readonly BotBubbleMeta[];
  /** The whole message's link mentions: a segment's blocks may not carry them. */
  mentions?: NativeLinkMentions;
}) {
  const colorScheme = useResolvedAppearance();
  const tokens = mobileTokens();
  const contentText = blockText(message);
  if (!contentText) return null;
  const parent = <ReplyQuote message={message} replyPreview={replyPreview} />;
  // `onLongPress` is deliberately left out here: the row-level RNGH gesture
  // (`AnimatedMessageBubble`) owns the long press for a plain text bubble,
  // and mixing the RN responder with RNGH on the same view is exactly what
  // the design-motion spec's transverse rules forbid. Accessibility actions
  // still live on the bubble itself.
  if (message.role === "user") {
    return (
      <View style={{ alignItems: incoming ? "flex-start" : "flex-end" }}>
        {parent}
        <UserBubble
          style={incoming ? { alignSelf: "flex-start" } : undefined}
          accessibilityActions={actionProps.accessibilityActions}
          onAccessibilityAction={actionProps.onAccessibilityAction}
        >
          {/* The long press is the row gesture's (AnimatedMessageBubble), not the text's. */}
          <LinkifiedText ink={tokens.chatUserForeground} mentions={mentions}>
            {contentText}
          </LinkifiedText>
        </UserBubble>
      </View>
    );
  }
  return (
    <View style={{ alignItems: "flex-start", minWidth: 0, maxWidth: "100%" }}>
      {parent}
      <BotBubble
        accessibilityActions={actionProps.accessibilityActions}
        onAccessibilityAction={actionProps.onAccessibilityAction}
        mono={mono}
        meta={meta}
      >
        <ChatMarkdown
          palette={tokens}
          colorScheme={colorScheme}
          streaming={isLiveMessage(message)}
          inBubble
          mentions={mentions}
        >
          {contentText}
        </ChatMarkdown>
      </BotBubble>
    </View>
  );
}

/** A routine's shown result, with the link mentions and card the server wrote for it. */
function RoutineBubble({
  item,
  text,
  groupId,
  botId,
  isNew,
  mono,
  actionProps,
}: {
  item: RoutineItem;
  text: string;
  groupId: string | undefined;
  botId: string | undefined;
  isNew: boolean;
  mono: boolean;
  actionProps: MessageActionProps | undefined;
}) {
  const tokens = mobileTokens();
  const colorScheme = useResolvedAppearance();
  const links = item.links ?? [];
  const mentionsKey = linkMentionsKey({ role: "bot", blocks: links });
  const target = useMemo<MobileArtifactTarget>(
    () => (groupId ? { groupId } : { botId: botId ?? item.botId }),
    [groupId, botId, item.botId],
  );
  const mentions = useMemo<NativeLinkMentions | undefined>(() => {
    const lookup = linkMentionsOf({ role: "bot", blocks: links });
    return (
      lookup && {
        ...lookup,
        icon: (artifactId, tint) => (
          <LinkMentionIcon target={target} artifactId={artifactId} tint={tint} />
        ),
      }
    );
  }, [mentionsKey, target]);
  const card = linkPreviewCardOf({ role: "bot", blocks: links });
  // Without the line that is only the card's link, as a message's bubble draws it.
  const shown = card ? textWithoutPreviewedLinkLine(text, card.url) : text;
  const press = actionProps ?? NO_ACTIONS;
  return (
    <View style={{ gap: 4 }}>
      {shown ? (
        <AnimatedMessageBubble
          variant="bot"
          isNew={isNew}
          entranceOnly={!actionProps}
          onLongPress={press.onLongPress}
          accessibilityActions={press.accessibilityActions}
          onAccessibilityAction={press.onAccessibilityAction}
        >
          <BotBubble
            mono={mono}
            accessibilityActions={press.accessibilityActions}
            onAccessibilityAction={press.onAccessibilityAction}
          >
            <ChatMarkdown
              allowImages={false}
              palette={tokens}
              colorScheme={colorScheme}
              inBubble
              mentions={mentions}
            >
              {truncateMarkdownForRender(shown)}
            </ChatMarkdown>
          </BotBubble>
        </AnimatedMessageBubble>
      ) : null}
      {card ? (
        <MessageArrival isNew={isNew}>
          <LinkPreviewCard
            card={card}
            target={target}
            mono={mono}
            align="start"
            onLongPress={press.onLongPress}
            accessibilityActions={press.accessibilityActions}
            onAccessibilityAction={press.onAccessibilityAction}
          />
        </MessageArrival>
      ) : null}
    </View>
  );
}

function SecretAskBlock({
  ask,
  canAnswer,
  onAnswer,
  actionProps,
}: {
  ask: Extract<MobileMessage["blocks"][number], { kind: "ask" }>;
  canAnswer: boolean;
  onAnswer: (answer: string) => Promise<void>;
  actionProps: MessageActionProps;
}) {
  const tokens = useMobileTokens();
  const router = useRouter();
  const { t } = useI18n();
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const secretLabel =
    ask.purpose === "password"
      ? t("Password")
      : ask.purpose === "api_key"
        ? t("API key")
        : t("Code");

  async function submit() {
    if (submitting || answer.length === 0) return;
    const submitValue = answer;
    setSubmitting(true);
    setError(null);
    setAnswer("");
    try {
      await onAnswer(submitValue);
    } catch {
      setError(t("Could not send answer"));
    } finally {
      setSubmitting(false);
    }
  }

  const answeredLine =
    ask.status === "answered" ? (
      ask.credential ? (
        <Text
          accessibilityRole="link"
          onPress={() => router.push("/vault")}
          style={{
            color: tokens.foreground,
            textDecorationLine: "underline",
            ...nativeTextStyle("meta"),
          }}
        >
          {t("Saved in Vault")}
        </Text>
      ) : (
        t("Saved")
      )
    ) : !canAnswer ? (
      t("Waiting for this bot’s response.")
    ) : undefined;

  return (
    <FramedBlock
      question={<Text {...actionProps}>{ask.text}</Text>}
      consequence={ask.credential?.origin}
      answered={answeredLine}
      actions={
        answeredLine === undefined ? (
          <CapsuleButton
            kind="primary"
            height={sizes.mobileStack}
            label={submitting ? t("Saving…") : t("Save")}
            disabled={answer.length === 0 || submitting}
            onPress={() => void submit()}
          />
        ) : undefined
      }
    >
      {answeredLine === undefined ? (
        <View style={{ gap: 10 }}>
          <TextInput
            accessibilityLabel={secretLabel}
            value={answer}
            onChangeText={setAnswer}
            placeholder={secretLabel}
            placeholderTextColor={tokens.mutedForeground}
            secureTextEntry
            autoComplete="off"
            autoCorrect={false}
            autoCapitalize="none"
            editable={!submitting}
            onSubmitEditing={() => void submit()}
            style={{
              minHeight: 44,
              borderRadius: radii.card,
              borderWidth: 1,
              borderColor: tokens.outline,
              backgroundColor: tokens.surface,
              color: tokens.foreground,
              paddingHorizontal: 14,
              paddingVertical: 10,
              ...nativeTextStyle("body"),
            }}
          />
          {error ? (
            <Text style={{ color: tokens.destructive, ...nativeTextStyle("meta") }}>{error}</Text>
          ) : null}
        </View>
      ) : null}
    </FramedBlock>
  );
}
