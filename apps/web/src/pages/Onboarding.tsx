import { Trans, useLingui } from "@lingui/react/macro";
import {
  DEFAULT_MODEL_CONTEXT_WINDOW,
  DEFAULT_MODEL_MAX_TOKENS,
  type IntegrationSetupState,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  openAiCompatibleConnectReady,
} from "@tangow/contracts";
import { createModelProbe, initialModelProbeState } from "@tangow/core";
import { Button, FloatingField, FloatingSelect, Shimmer } from "@tangow/ui-web";
import type { FormEvent, ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { IntegrationSetup } from "../components/integrations/IntegrationSetup";
import type { ModelCatalogEntry } from "../lib/model-auth";
import { rpc } from "../lib/rpc";
import { useModelOAuthSignIn } from "../lib/use-model-oauth-signin";
import { OnboardingScreen, PlateScene } from "./onboarding-screen";

const CUSTOM_MODEL_OPTION = "__tangow_custom_model__";
const FIRST_BOT_NAME = "Chief";
const FIRST_BOT_SPAWN_KEY = "onboarding:first";
const FIRST_BOT_LOCK = "tangow:onboarding-first-bot";

/** Survives StrictMode remounts; concurrent first-bot creates share one in-flight attempt. */
let firstBotEnsure: Promise<{ id: string }> | null = null;

function findFirstBot(
  bots: Array<{ id: string; name: string; spawnKey: string | null }>,
): { id: string } | undefined {
  const bySpawnKey = bots.find((bot) => bot.spawnKey === FIRST_BOT_SPAWN_KEY);
  if (bySpawnKey) return { id: bySpawnKey.id };
  // Legacy first-run Chief created before spawnKey was set.
  const byName = bots.find((bot) => bot.name === FIRST_BOT_NAME);
  return byName ? { id: byName.id } : undefined;
}

async function createOrReuseFirstBot(): Promise<{ id: string }> {
  const existing = await rpc.bots.list();
  const reuse = findFirstBot(existing);
  if (reuse) return reuse;
  try {
    const created = await rpc.bots.create({
      name: FIRST_BOT_NAME,
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
      spawnKey: FIRST_BOT_SPAWN_KEY,
    });
    return { id: created.id };
  } catch (error) {
    // Another tab won the unique (spaceId, spawnKey) race; reuse that bot only.
    const afterConflict = await rpc.bots.list();
    const winner = afterConflict.find((bot) => bot.spawnKey === FIRST_BOT_SPAWN_KEY);
    if (winner) return { id: winner.id };
    throw error;
  }
}

async function withFirstBotLock<T>(run: () => Promise<T>): Promise<T> {
  const locks = globalThis.navigator?.locks;
  if (!locks?.request) return run();
  return locks.request(FIRST_BOT_LOCK, run);
}

async function ensureFirstBot(): Promise<{ id: string }> {
  if (firstBotEnsure) return firstBotEnsure;
  // Web Lock serializes cross-tab creates; module promise covers same-tab StrictMode.
  // spawnKey makes create idempotent when locks are unavailable.
  // Clear after settle so a later empty-space visit re-lists instead of reusing a deleted id.
  firstBotEnsure = withFirstBotLock(createOrReuseFirstBot).finally(() => {
    firstBotEnsure = null;
  });
  return firstBotEnsure;
}

function providerLabel(entry: ModelCatalogEntry): string {
  return entry.provider === "openai-codex" ? "ChatGPT" : (entry.providerName ?? entry.provider);
}

function nextStepAfterModel(needsIntegrationSetup: boolean): "integrations" | "bot" {
  return needsIntegrationSetup ? "integrations" : "bot";
}

/** What the model step asks for: a key, a subscription sign-in, its wait, or a server of one's own. */
type ModelView = "key" | "subscription" | "waiting" | "server";
type StepError = { text: string; field?: "key" | "url" | "code" };

export function OnboardingPage() {
  const { t } = useLingui();
  const navigate = useNavigate();
  const [step, setStep] = useState<"loading" | "model" | "integrations" | "bot">("loading");
  const [integrationSetup, setIntegrationSetup] = useState<IntegrationSetupState | null>(null);
  const needsIntegrationSetup = integrationSetup?.needsSetup ?? false;
  const [integrationServers, setIntegrationServers] = useState<string[]>([]);
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([]);
  const [provider, setProvider] = useState("openrouter");
  const [modelId, setModelId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [manualModelId, setManualModelId] = useState(false);
  /** The key field a subscription or a server keeps behind a link, once asked for. */
  const [keyChosen, setKeyChosen] = useState(false);
  const [{ models: probeModels, probing }, setProbe] = useState(initialModelProbeState);
  const [modelProbe] = useState(() => createModelProbe(setProbe));
  const resetOpenAiCompatibleProbe = modelProbe.reset;
  const createStartedRef = useRef(false);
  /** `awake` plays the connected frames, the button held, before the next step. */
  const [phase, setPhase] = useState<"idle" | "connecting" | "awake">("idle");
  const [error, setError] = useState<StepError | null>(null);

  const {
    oauth,
    pasteCode,
    setPasteCode,
    oauthPending,
    cancelOAuthAttempt,
    startSubscriptionSignIn,
    submitOAuthCode,
  } = useModelOAuthSignIn({
    onClearError: () => setError(null),
    onError: (text) => setError({ text, field: "code" }),
    onFinished: () => setPhase("awake"),
  });

  useEffect(() => {
    void Promise.all([
      rpc.me(),
      rpc.models.list().catch(() => []),
      rpc.integrationSetup.get().catch(() => null),
    ])
      .then(([me, models, integrations]) => {
        setIntegrationSetup(integrations);
        setCatalog(models);
        const preferred =
          models.find(
            (entry) => entry.provider === me.defaultProvider && entry.id === me.defaultModel,
          ) ??
          models.find((entry) => entry.provider === me.defaultProvider) ??
          models[0];
        if (preferred) {
          setProvider(preferred.provider);
          setModelId(preferred.provider === OPENAI_COMPATIBLE_PROVIDER_ID ? "" : preferred.id);
        }
        setStep(me.needsModel ? "model" : integrations?.needsSetup ? "integrations" : "bot");
      })
      .catch(() => setStep("bot"));
    return () => {
      modelProbe.invalidate();
    };
  }, []);

  const providers = useMemo(() => {
    const seen = new Map<string, ModelCatalogEntry>();
    for (const entry of catalog) {
      if (!seen.has(entry.provider)) seen.set(entry.provider, entry);
    }
    return [...seen.values()];
  }, [catalog]);

  const modelsForProvider = useMemo(
    () => catalog.filter((entry) => entry.provider === provider),
    [catalog, provider],
  );

  const selected = modelsForProvider.find((entry) => entry.id === modelId) ?? modelsForProvider[0];
  const isOpenAiCompatible = provider === OPENAI_COMPATIBLE_PROVIDER_ID;
  const subscriptionSignIn = selected?.signIn !== undefined;
  const acceptsKey = selected?.auth !== "oauth";
  const signInLabel = selected?.oauthLabel ?? t`Sign in`;
  const view: ModelView = isOpenAiCompatible
    ? "server"
    : oauth
      ? "waiting"
      : subscriptionSignIn && !(acceptsKey && keyChosen)
        ? "subscription"
        : "key";
  const busy = phase !== "idle";
  const canSaveModel = Boolean(
    selected &&
      modelId.trim() &&
      !oauthPending &&
      !busy &&
      (isOpenAiCompatible
        ? openAiCompatibleConnectReady({ baseUrl, modelId })
        : acceptsKey && apiKey.trim()),
  );

  function updateBaseUrl(nextBaseUrl: string) {
    setBaseUrl(nextBaseUrl);
    // Keep Other model… mode across URL edits; only provider change clears it.
    resetOpenAiCompatibleProbe();
    setError(null);
  }

  function updateApiKey(nextApiKey: string) {
    setApiKey(nextApiKey);
    resetOpenAiCompatibleProbe();
  }

  function selectProvider(nextProvider: string) {
    if (nextProvider === provider) return;
    cancelOAuthAttempt();
    setProvider(nextProvider);
    setApiKey("");
    setModelId(
      nextProvider === OPENAI_COMPATIBLE_PROVIDER_ID
        ? ""
        : (catalog.find((item) => item.provider === nextProvider)?.id ?? ""),
    );
    setBaseUrl("");
    setManualModelId(false);
    setKeyChosen(false);
    resetOpenAiCompatibleProbe();
    setError(null);
  }

  async function probeServerModels() {
    if (!baseUrl.trim()) return;
    setError(null);
    await modelProbe.probe({
      baseUrl,
      apiKey,
      request: rpc.models.probeOpenAiCompatible,
      onSuccess: (models) => {
        setModelId((current) => {
          const trimmed = current.trim();
          const next = trimmed || models[0] || "";
          // Stay in manual entry across re-probes so a typed id that matches a
          // discovered model cannot yank the freeform field back to the Select.
          setManualModelId(
            (wasManual) => wasManual || (Boolean(trimmed) && !models.includes(trimmed)),
          );
          return next;
        });
      },
      onError: (err) =>
        setError({
          text: err instanceof Error ? err.message : t`Could not reach this model server`,
          field: "url",
        }),
    });
  }

  async function saveModel() {
    if (!canSaveModel) return;
    setError(null);
    setPhase("connecting");
    const label = selected?.providerName ?? provider;
    try {
      await rpc.models.connect(
        isOpenAiCompatible
          ? {
              provider,
              baseUrl: baseUrl.trim(),
              modelId: modelId.trim(),
              reasoning: false,
              thinkingLevel: null,
              maxTokens: DEFAULT_MODEL_MAX_TOKENS,
              contextWindow: DEFAULT_MODEL_CONTEXT_WINDOW,
              supportsImages: false,
              apiKey: apiKey.trim() || undefined,
              label,
            }
          : { provider, apiKey, modelId, label },
      );
      setPhase("awake");
    } catch (err) {
      setPhase("idle");
      setError({
        text: err instanceof Error ? err.message : t`Could not save model`,
        field: isOpenAiCompatible ? "url" : "key",
      });
    }
  }

  function submitModel(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (view === "subscription") {
      void startSubscriptionSignIn({
        provider,
        modelId,
        label: selected?.providerName ?? provider,
      });
    } else if (view === "waiting") {
      void submitOAuthCode();
    } else {
      void saveModel();
    }
  }

  async function createFirstBot() {
    if (createStartedRef.current) return;
    createStartedRef.current = true;
    setError(null);
    try {
      const bot = await ensureFirstBot();
      for (const serverId of integrationServers) {
        await rpc.mcp.assignments.approve({ botId: bot.id, serverId });
      }
      // Onboarding continues conversationally in the thread: greeting first,
      // then the focus choice (immediate for the first bot).
      const started = await rpc.onboarding
        .start({ botId: bot.id })
        .then(() => true)
        .catch(() => false);
      if (started) {
        await rpc.onboarding.promptFocus({ botId: bot.id }).catch(() => undefined);
      }
      navigate(`/app/${bot.id}`);
    } catch (err) {
      createStartedRef.current = false;
      setError({ text: err instanceof Error ? err.message : t`Could not create your bot` });
    }
  }

  useEffect(() => {
    if (step !== "bot") return;
    void createFirstBot();
  }, [step]);

  if (step === "model") {
    const link = (label: ReactNode, onClick: () => void) => (
      <button type="button" className="rk-onboarding-link" disabled={busy} onClick={onClick}>
        {label}
      </button>
    );
    const keyField = (
      <FloatingField
        id="api-key"
        label={<Trans>API key</Trans>}
        type="password"
        autoComplete="new-password"
        value={apiKey}
        onChange={(e) => updateApiKey(e.target.value)}
        invalid={error?.field === "key"}
      />
    );
    // A fourth field lands below the scroll fold, so it takes the focus as it appears.
    const chooseKey = () => {
      cancelOAuthAttempt();
      setKeyChosen(true);
      requestAnimationFrame(() => document.getElementById("api-key")?.focus());
    };
    return (
      <OnboardingScreen
        scroll
        onSubmit={submitModel}
        title={<Trans>Plug in a brain.</Trans>}
        scene={
          <PlateScene
            step="model"
            awake={phase === "awake"}
            onAwake={() => setStep(nextStepAfterModel(needsIntegrationSetup))}
          />
        }
        status={
          error ? (
            error.text
          ) : phase === "connecting" ? (
            <Shimmer>
              <Trans>Connecting…</Trans>
            </Shimmer>
          ) : view === "waiting" ? (
            <Shimmer>
              <Trans>Waiting for sign-in…</Trans>
            </Shimmer>
          ) : null
        }
        actions={
          <>
            {view === "subscription" ? (
              <Button
                type="submit"
                size="full"
                disabled={oauthPending || busy}
                aria-busy={oauthPending}
              >
                {signInLabel}
              </Button>
            ) : view === "waiting" ? (
              <Button
                type="submit"
                size="full"
                disabled={oauth?.mode !== "auth-url" || !pasteCode.trim()}
              >
                <Trans>Submit</Trans>
              </Button>
            ) : (
              <Button
                type="submit"
                size="full"
                disabled={!canSaveModel}
                aria-busy={phase === "connecting"}
              >
                <Trans>Continue</Trans>
              </Button>
            )}
            {(view === "subscription" || view === "waiting") && acceptsKey
              ? link(<Trans>Or paste an API key</Trans>, chooseKey)
              : null}
            {view === "key" && subscriptionSignIn
              ? link(signInLabel, () => setKeyChosen(false))
              : null}
            {view === "server" && !keyChosen ? link(<Trans>Add API key</Trans>, chooseKey) : null}
            {view === "server" && probeModels.length && manualModelId
              ? link(<Trans>Use a found model</Trans>, () => {
                  setManualModelId(false);
                  setModelId(probeModels[0] ?? "");
                })
              : null}
          </>
        }
      >
        <FloatingSelect
          id="provider"
          label={<Trans>Provider</Trans>}
          value={provider}
          disabled={busy}
          onChange={(e) => selectProvider(e.target.value)}
        >
          {providers.map((entry) => (
            <option key={entry.provider} value={entry.provider}>
              {providerLabel(entry)}
            </option>
          ))}
        </FloatingSelect>
        {view === "waiting" && oauth?.mode === "auth-url" ? (
          <>
            <p>
              <Trans>
                Finish signing in at{" "}
                <a
                  href={oauth.verificationUri}
                  target="_blank"
                  rel="noreferrer"
                  className="text-foreground underline"
                >
                  {new URL(oauth.verificationUri).hostname}
                </a>
                , then paste the code or the page’s address here.
              </Trans>
            </p>
            <FloatingField
              id="oauth-code"
              label={<Trans>Code or URL</Trans>}
              autoComplete="off"
              spellCheck={false}
              value={pasteCode}
              onChange={(e) => setPasteCode(e.target.value)}
              invalid={error?.field === "code"}
            />
          </>
        ) : view === "waiting" && oauth?.mode === "device-code" ? (
          <>
            <p>
              <Trans>
                Enter this code at{" "}
                <a
                  href={oauth.verificationUri}
                  target="_blank"
                  rel="noreferrer"
                  className="text-foreground underline"
                >
                  {oauth.verificationUri.replace(/^https:\/\//, "")}
                </a>
              </Trans>
            </p>
            <p className="font-mono text-[22px] tracking-[0.2em] text-foreground">
              {oauth.userCode}
            </p>
          </>
        ) : view === "server" ? (
          <>
            <FloatingField
              id="server-url"
              label={<Trans>Server URL</Trans>}
              autoComplete="off"
              value={baseUrl}
              onChange={(e) => updateBaseUrl(e.target.value)}
              invalid={error?.field === "url"}
              action={
                <button
                  type="button"
                  className="rk-field-action"
                  disabled={probing || !baseUrl.trim()}
                  onClick={() => void probeServerModels()}
                >
                  {probing ? (
                    <Shimmer>
                      <Trans>Finding…</Trans>
                    </Shimmer>
                  ) : (
                    <Trans>Find models</Trans>
                  )}
                </button>
              }
            />
            {probeModels.length && !manualModelId ? (
              <FloatingSelect
                id="model"
                label={<Trans>Model</Trans>}
                value={modelId}
                onChange={(e) => {
                  const next = e.target.value;
                  setManualModelId(next === CUSTOM_MODEL_OPTION);
                  setModelId(next === CUSTOM_MODEL_OPTION ? "" : next);
                }}
              >
                {probeModels.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
                <option value={CUSTOM_MODEL_OPTION}>{t`Other model…`}</option>
              </FloatingSelect>
            ) : (
              <FloatingField
                id="model"
                label={<Trans>Model</Trans>}
                autoComplete="off"
                value={modelId}
                onChange={(e) => {
                  setManualModelId(true);
                  setModelId(e.target.value);
                }}
              />
            )}
            {keyChosen ? keyField : null}
          </>
        ) : (
          <>
            <FloatingSelect
              id="model"
              label={<Trans>Model</Trans>}
              value={selected?.id ?? modelId}
              disabled={busy}
              onChange={(e) => {
                if (e.target.value === modelId) return;
                cancelOAuthAttempt();
                setModelId(e.target.value);
              }}
            >
              {modelsForProvider.map((entry) => (
                <option key={`${entry.provider}:${entry.id}`} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </FloatingSelect>
            {view === "key" && acceptsKey ? keyField : null}
          </>
        )}
      </OnboardingScreen>
    );
  }

  return (
    <div className="min-h-full bg-background px-6 py-12">
      <div className="mx-auto w-full max-w-[560px]">
        {step === "loading" ? (
          <p className="text-muted-foreground">
            <Trans>Loading…</Trans>
          </p>
        ) : null}
        {step === "integrations" ? (
          <IntegrationSetup
            initialState={integrationSetup}
            onDone={() => setStep("bot")}
            onServerConnected={(id) =>
              setIntegrationServers((current) => [...new Set([...current, id])])
            }
          />
        ) : null}
        {step === "bot" ? (
          <div>
            {error ? (
              <div>
                <p className="text-sm text-destructive">{error.text}</p>
                <Button className="mt-4" onClick={() => void createFirstBot()}>
                  <Trans>Try again</Trans>
                </Button>
              </div>
            ) : (
              <p className="text-muted-foreground">
                <Trans>Opening chat…</Trans>
              </p>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
