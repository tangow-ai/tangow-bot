import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@tangow/chat-ui/web";
import type { AskDraftEdits, ThreadMessage } from "@tangow/contracts";
import { BOT_NAME_MAX_LENGTH, SPAWN_BOT_INSTRUCTIONS_MAX_LENGTH } from "@tangow/contracts";
import {
  askFormOf,
  canEditSpawnBotCard,
  isApprovalAskBlock,
  isSecretAskBlock,
  routineCardSettlement,
  spawnBotEdits,
  spawnBotReadOnlyDetail,
} from "@tangow/core";
import { Button, FramedBlock, Input, Textarea } from "@tangow/ui-web";
import { ChevronRight, Repeat } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { Fragment, useId, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { approvalActionLabel } from "../lib/approval-labels";
import { QuestionCard } from "./ask/QuestionCard";
import { DraftCard } from "./DraftCard";

const DETAIL_CLASS =
  "max-h-72 overflow-auto rounded-card bg-well px-4 py-3 font-mono text-mono whitespace-pre-wrap break-words text-muted-foreground";
// A field inside the card sits in its well, not on a second card.
const FIELD_CLASS = "rounded-card border-border bg-well px-3 dark:bg-well";

export type AskBlock = Extract<ThreadMessage["blocks"][number], { kind: "ask" }>;
/** What a card's owner changed before Send: a Create bot card's fields, or a mail draft's message. */
export type CardEdits = NonNullable<ReturnType<typeof spawnBotEdits>> | AskDraftEdits;

/** The field a server refusal is about, from its text; both when it cannot be told. */
function invalidBotFields(error: string | null): { name: boolean; instructions: boolean } {
  const name = /^(name\b|A bot named)/.test(error ?? "");
  const instructions = /^instructions\b/.test(error ?? "");
  const unknown = error !== null && !name && !instructions;
  return { name: name || unknown, instructions: instructions || unknown };
}

function formatAnsweredState(
  answer: string | undefined,
  secret: boolean,
  outcome?: "created" | "cancelled",
): string {
  if (secret) return t`Saved`;
  if (!answer) return t`Answered`;
  if (outcome === "created") return t`Created`;
  if (outcome === "cancelled") return t`Cancelled`;
  if (answer === "allow") return t`Allowed once`;
  if (answer === "always") return t`Always allowed`;
  if (answer === "deny") return t`Denied`;
  return t`Answered: ${answer}`;
}

function VaultSaved() {
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  params.set("settings", "vault");
  return (
    <Trans>
      Saved in{" "}
      <Link
        className="text-foreground underline underline-offset-2"
        to={{ search: params.toString() }}
        replace
      >
        Vault
      </Link>
    </Trans>
  );
}

/** What became of a routine card: a link to the routine, or why there is none. */
function RoutineSettled({ block, botId }: { block: AskBlock; botId?: string }) {
  if (!block.created || !botId) {
    switch (routineCardSettlement(block)) {
      case "failed":
        return t`Couldn't create`;
      case "not_now":
        return t`Not now`;
      case "creating":
        return t`Creating…`;
      default:
        return t`Answered`;
    }
  }
  return (
    <Link
      to={{
        pathname: `/app/${botId}`,
        search: `?routine=${encodeURIComponent(block.created.id)}`,
      }}
      className="inline-flex items-center gap-1 duration-(--duration-hover) ease-quiet hover:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      {block.confirms === "updated" ? t`Routine updated` : t`Routine created`} ·{" "}
      <span className="font-medium text-foreground">{block.created.label}</span>
      <ChevronRight className="size-3 shrink-0" aria-hidden />
    </Link>
  );
}

/** What a routine card creates, as plain text: the name, when it runs, what it does. */
function RoutinePreview({ routine }: { routine: NonNullable<AskBlock["routine"]> }) {
  return (
    <div
      data-testid="routine-preview"
      className="flex flex-col gap-1 rounded-card bg-well px-4 py-3"
    >
      <span className="flex items-center gap-1.5 text-label text-foreground">
        <Repeat className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 break-words">{routine.name}</span>
      </span>
      <span className="text-meta text-muted-foreground">{routine.schedule}</span>
      <p className="mt-1 whitespace-pre-wrap break-words text-meta text-foreground">
        {routine.prompt}
      </p>
      {routine.notify ? (
        <span className="mt-1 text-meta text-muted-foreground">{t`Notifies you each run`}</span>
      ) : null}
    </div>
  );
}

function approvalActionVariant(id: string): "capsule" | "capsuleSecondary" | "tertiary" {
  if (id === "allow") return "capsule";
  if (id === "always") return "capsuleSecondary";
  return "tertiary";
}

// Left to right: dismiss, Edit, the secondary approval, the primary one.
const EDIT_RANK = 1;
function approvalActionRank(id: string): number {
  if (id === "allow") return 3;
  if (id === "always") return 2;
  return 0;
}

function secretFieldLabel(purpose: AskBlock["purpose"]): string {
  if (purpose === "password") return t`Password`;
  if (purpose === "api_key") return t`API key`;
  return t`Code`;
}

/** A free-text field styled with tokens, optionally submitting on Enter. */
function AnswerInput({
  className,
  onSubmit,
  ...props
}: Omit<ComponentProps<typeof Input>, "onKeyDown"> & { onSubmit?: () => void }) {
  return (
    <Input
      className={`h-11 ${FIELD_CLASS} text-body ${className ?? ""}`.trim()}
      onKeyDown={
        onSubmit
          ? (event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                onSubmit();
              }
            }
          : undefined
      }
      {...props}
    />
  );
}

export function AskCard({
  block,
  canAnswer,
  waitingOn,
  viewerUserId,
  onAnswer,
  messageId,
  botId,
  onReconnect,
}: {
  block: AskBlock;
  canAnswer: boolean;
  /** The person who answers it instead, when it waits on someone else's run in a group. */
  waitingOn?: string;
  /** Only the run's owner may edit a Create bot card. */
  viewerUserId?: string;
  onAnswer: (text: string, edits?: CardEdits) => Promise<void>;
  messageId: string;
  /** The bot that posted the card, whose page a routine card links to. */
  botId?: string;
  /** Opens where a disconnected app is reconnected, for a mail draft that could not leave. */
  onReconnect?: () => void;
}) {
  const { t } = useLingui();
  const fieldId = useId();
  // Keyed by message: a card that changes (another thread, another ask) drops the edit.
  const [botDraft, setBotDraft] = useState<{
    messageId: string;
    name: string;
    instructions: string;
  } | null>(null);
  const [answer, setAnswer] = useState("");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submitting = pendingAction !== null;
  const approval = isApprovalAskBlock(block);
  const approvalActions = approval ? block.actions : undefined;
  const secretInput = isSecretAskBlock(block);
  const secretLabel = secretFieldLabel(block.purpose);

  async function submitAnswer(value: string, edits?: CardEdits) {
    if (submitting) return;
    if (secretInput ? value.length === 0 : !value.trim()) return;
    const submitValue = secretInput ? value : value.trim();
    setPendingAction(secretInput ? "submit" : submitValue);
    setError(null);
    if (secretInput) setAnswer("");
    try {
      await (edits ? onAnswer(submitValue, edits) : onAnswer(submitValue));
    } catch (err) {
      setError(
        !secretInput && err instanceof Error ? err.message : t`Could not submit this answer`,
      );
    } finally {
      setPendingAction(null);
    }
  }

  if (block.draft) {
    return (
      <DraftCard
        key={messageId}
        block={{ ...block, draft: block.draft }}
        canAnswer={canAnswer}
        waitingOn={waitingOn}
        viewerUserId={viewerUserId}
        onAnswer={onAnswer}
        onReconnect={onReconnect}
        messageId={messageId}
      />
    );
  }

  const form = askFormOf(block);
  if (form) {
    return (
      <QuestionCard
        key={messageId}
        block={block}
        form={form}
        messageId={messageId}
        canAnswer={canAnswer}
        waitingOn={waitingOn}
        onAnswer={onAnswer}
      />
    );
  }

  // A routine card, proposed by the bot or confirming one set up, shows what it creates instead
  // of the plain-text detail.
  const routineCard = approval ? block.routine : undefined;
  // The row above already names the bot; the card only repeats itself for a consequential
  // approval, name-less. A plain question or a routine card opens with no header.
  const header = approval && !routineCard ? { who: t`Needs your call` } : undefined;
  const consequence = routineCard ? undefined : secretInput ? (
    block.credential?.origin ? (
      <span className="break-all">{block.credential.origin}</span>
    ) : undefined
  ) : block.detail ? (
    <pre className={DETAIL_CLASS}>{block.detail}</pre>
  ) : undefined;

  const answered: ReactNode =
    block.status === "answered" ? (
      routineCard ? (
        <RoutineSettled block={block} botId={botId} />
      ) : secretInput && block.credential ? (
        <VaultSaved />
      ) : (
        formatAnsweredState(
          block.answer,
          secretInput,
          approvalActions?.find((action) => action.id === block.answer)?.outcome,
        )
      )
    ) : waitingOn !== undefined ? (
      t`Waiting for ${waitingOn}`
    ) : !canAnswer ? (
      t`No longer active`
    ) : undefined;

  let children: ReactNode = null;
  let actions: ReactNode = null;

  // Only a pending spawn_bot card that carries its fields can be edited, and only by the run's
  // owner. A card from an older server has no `spawnBot`: it stays read-only, approve or cancel.
  const spawnBot =
    approval &&
    answered === undefined &&
    block.spawnBot &&
    canEditSpawnBotCard(block.spawnBot, viewerUserId)
      ? block.spawnBot
      : undefined;
  const draft = botDraft?.messageId === messageId ? botDraft : null;
  const botEditing = spawnBot !== undefined && draft !== null;

  if (answered === undefined) {
    if (approvalActions?.length) {
      const submitApproval = (id: string) => {
        // While editing, Cancel leaves the edit; the card's own Cancel refuses the bot.
        if (id === "deny" && botEditing) {
          setBotDraft(null);
          setError(null);
          return;
        }
        if (id === "allow" && spawnBot && draft) {
          const edits = spawnBotEdits(spawnBot, draft);
          return void submitAnswer("allow", edits);
        }
        return void submitAnswer(id);
      };
      const ranked = approvalActions.map((action) => ({
        key: action.id,
        rank: approvalActionRank(action.id),
        node: (
          <Button
            variant={approvalActionVariant(action.id)}
            size="capsule"
            consequential={action.id === "allow" && !routineCard}
            disabled={submitting || (action.id === "allow" && botEditing && !draft?.name.trim())}
            onClick={() => submitApproval(action.id)}
          >
            {pendingAction === action.id ? <Trans>Sending…</Trans> : approvalActionLabel(action)}
          </Button>
        ),
      }));
      if (spawnBot && !botEditing) {
        ranked.push({
          key: "edit",
          rank: EDIT_RANK,
          node: (
            <Button
              variant="tertiary"
              size="capsule"
              disabled={submitting}
              onClick={() =>
                setBotDraft({
                  messageId,
                  name: spawnBot.name,
                  instructions: spawnBot.instructions,
                })
              }
            >
              <Trans>Edit</Trans>
            </Button>
          ),
        });
      }
      actions = ranked
        .sort((a, b) => a.rank - b.rank)
        .map(({ key, node }) => <Fragment key={key}>{node}</Fragment>);
      if (routineCard) children = <RoutinePreview routine={routineCard} />;
      if (spawnBot && draft) {
        const readOnly = spawnBotReadOnlyDetail(spawnBot);
        const invalid = invalidBotFields(error);
        children = (
          <div className="flex flex-col gap-2.5">
            <div>
              <label
                htmlFor={`${fieldId}-name`}
                className="mb-1.5 block text-meta text-muted-foreground"
              >
                <Trans>Name</Trans>
              </label>
              <Input
                id={`${fieldId}-name`}
                className={`h-11 ${FIELD_CLASS}`}
                autoFocus
                autoComplete="off"
                maxLength={BOT_NAME_MAX_LENGTH}
                disabled={submitting}
                aria-invalid={invalid.name ? true : undefined}
                value={draft.name}
                onChange={(event) => setBotDraft({ ...draft, name: event.target.value })}
              />
            </div>
            <div>
              <label
                htmlFor={`${fieldId}-instructions`}
                className="mb-1.5 block text-meta text-muted-foreground"
              >
                <Trans>Instructions</Trans>
              </label>
              <Textarea
                id={`${fieldId}-instructions`}
                className={`max-h-72 overflow-auto ${FIELD_CLASS}`}
                maxLength={SPAWN_BOT_INSTRUCTIONS_MAX_LENGTH}
                disabled={submitting}
                aria-invalid={invalid.instructions ? true : undefined}
                value={draft.instructions}
                onChange={(event) => setBotDraft({ ...draft, instructions: event.target.value })}
              />
            </div>
            {readOnly ? <pre className={DETAIL_CLASS}>{readOnly}</pre> : null}
            {error ? (
              <p role="alert" className="text-meta text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        );
      }
    } else if (secretInput) {
      children = (
        <AnswerInput
          aria-label={secretLabel}
          type="password"
          autoComplete="off"
          spellCheck={false}
          disabled={submitting}
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          onSubmit={() => void submitAnswer(answer)}
          placeholder={secretLabel}
        />
      );
      actions = (
        <Button
          variant="capsule"
          size="capsule"
          disabled={answer.length === 0 || submitting}
          onClick={() => void submitAnswer(answer)}
        >
          {submitting ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
        </Button>
      );
    }
  }

  return (
    <FramedBlock
      data-testid={secretInput ? "secret-ask-card" : undefined}
      header={header ? { ...header, dot: answered === undefined } : undefined}
      // An approval question can carry model-written text (a bot's name): never fetch an image for it.
      question={
        routineCard ? (
          block.text
        ) : (
          <ChatMarkdown allowImages={!approval}>
            {botEditing ? t`Create bot?` : block.text}
          </ChatMarkdown>
        )
      }
      consequence={botEditing ? undefined : consequence}
      answered={answered}
      actions={actions}
    >
      {children || (error && !botEditing) ? (
        <>
          {children}
          {error && !botEditing ? (
            <p role="alert" className="text-meta text-destructive">
              {error}
            </p>
          ) : null}
        </>
      ) : null}
    </FramedBlock>
  );
}
