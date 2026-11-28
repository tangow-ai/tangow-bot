import type { WorkerProviderConfig } from "@tangow/adapters";
import {
  resolveDeploymentModel,
  resolveSandboxProvider,
  resolveWorkerProvider,
} from "@tangow/adapters";
import type { SkillLearningMode } from "@tangow/core";
import {
  parseSkillLearningMode,
  resolveAuthSecret,
  resolveEncryptionKey,
  resolveScreenProxySecret,
  resolveSupervisorToken,
} from "@tangow/core";

export { resolveSandboxProvider } from "@tangow/adapters";

export interface AppEnv {
  nodeEnv: string;
  databaseUrl: string;
  realtimeDatabaseUrl: string;
  authSecret: string;
  authUrl: string;
  webOrigin: string;
  apiUrl: string;
  apiHost: string;
  signupsEnabled: string | undefined;
  signupAllowlist: string | undefined;
  encryptionKey: string;
  vault: Pick<
    NodeJS.ProcessEnv,
    "VAULT_ENGINE" | "VAULT_ENGINE_URL" | "VAULT_ENGINE_CREDENTIAL" | "VAULT_ENGINE_CREDENTIAL_DIR"
  >;
  dataDir: string;
  /** SKILL_LEARNING: off, shadow (default) or on. */
  skillLearning: SkillLearningMode;
  sandboxSupervisorUrl: string;
  sandboxSupervisorToken: string | undefined;
  screenProxySecret: string;
  sandboxProvider: string;
  /** AGENT_RUNTIME=scripted is the in-process test runtime; every other value runs bots in workers. */
  agentRuntime: "worker" | "scripted";
  deploymentModelKey: string | undefined;
  e2bApiKey: string | undefined;
  /** The workers of the computer provider; null only for the test providers. */
  workerProvider: WorkerProviderConfig | null;
  composioApiKey: string | undefined;
  /** Optional integrations.sh-compatible catalog base URL. */
  sendblueApiKeyId: string | undefined;
  sendblueApiSecret: string | undefined;
  sendblueSigningSecret: string | undefined;
  sendbluePhoneNumber: string | undefined;
  smtpUrl: string | undefined;
  emailFrom: string | undefined;
  emailEmulator: boolean;
  slackBotToken: string | undefined;
  slackSigningSecret: string | undefined;
  whatsappAccessToken: string | undefined;
  whatsappPhoneNumberId: string | undefined;
  whatsappAppSecret: string | undefined;
  whatsappVerifyToken: string | undefined;
  telegramBotToken: string | undefined;
  telegramWebhookSecret: string | undefined;
  larkAppId: string | undefined;
  larkAppSecret: string | undefined;
  larkVerificationToken: string | undefined;
  larkEncryptKey: string | undefined;
  larkDomain: string | undefined;
  /** Unknown chat senders auto-provision their own accounts when true. */
  messagingOpenSignup: boolean;
  /** Bot that owns team/external chat rooms on the messaging surface. */
  teamChatBotId: string | undefined;
  /** Optional model override for ambient engagement judging. */
  teamChatJudgeProvider: string | undefined;
  teamChatJudgeModel: string | undefined;
  defaultProvider: string;
  defaultModel: string;
  wakeupDriver: string;
  mcpStdioEnabled: boolean;
  mcpStdioAllowedCommands: string[];
  port: number;
  gitSha: string | undefined;
  /** Private Compose control-network URL for the opt-in updater sidecar. */
  updaterUrl: string | undefined;
  /** Bearer shared with the updater; never sent to the browser. */
  updaterToken: string | undefined;
  /** Current application image tag; used for compose manual-upgrade command selection. */
  imageTag: string | undefined;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const authSecret = resolveAuthSecret(source);
  const sandboxProvider = resolveSandboxProvider(source);
  const deploymentModel = resolveDeploymentModel(source);
  const updaterUrl = optional(source.TANGOW_UPDATER_URL);
  const updaterToken = optional(source.TANGOW_UPDATER_TOKEN);
  return {
    nodeEnv: source.NODE_ENV ?? "",
    databaseUrl: required(source, "DATABASE_URL"),
    realtimeDatabaseUrl: source.REALTIME_DATABASE_URL ?? required(source, "DATABASE_URL"),
    authSecret,
    authUrl: source.BETTER_AUTH_URL ?? source.WEB_ORIGIN ?? "http://127.0.0.1:5173",
    webOrigin: source.WEB_ORIGIN ?? "http://127.0.0.1:5173",
    apiUrl: source.API_URL ?? "http://127.0.0.1:3100",
    apiHost: source.API_HOST ?? "127.0.0.1",
    signupsEnabled: source.SIGNUPS_ENABLED,
    signupAllowlist: source.SIGNUP_ALLOWLIST,
    encryptionKey: resolveEncryptionKey(source),
    vault: {
      VAULT_ENGINE: source.VAULT_ENGINE,
      VAULT_ENGINE_URL: source.VAULT_ENGINE_URL,
      VAULT_ENGINE_CREDENTIAL: source.VAULT_ENGINE_CREDENTIAL,
      VAULT_ENGINE_CREDENTIAL_DIR: source.VAULT_ENGINE_CREDENTIAL_DIR,
    },
    dataDir: source.DATA_DIR ?? "./data",
    skillLearning: parseSkillLearningMode(source.SKILL_LEARNING),
    sandboxSupervisorUrl: source.SANDBOX_SUPERVISOR_URL ?? "http://127.0.0.1:7091",
    sandboxSupervisorToken:
      sandboxProvider === "docker" ? resolveSupervisorToken(source) : undefined,
    screenProxySecret: resolveScreenProxySecret(source),
    sandboxProvider,
    agentRuntime: source.AGENT_RUNTIME === "scripted" ? "scripted" : "worker",
    // Provider, model and key resolve together: see resolveDeploymentModel.
    deploymentModelKey: deploymentModel.key,
    e2bApiKey: source.E2B_API_KEY,
    workerProvider: resolveWorkerProvider(source),
    composioApiKey: source.COMPOSIO_API_KEY,
    sendblueApiKeyId: optional(source.SENDBLUE_API_KEY_ID),
    sendblueApiSecret: optional(source.SENDBLUE_API_SECRET),
    sendblueSigningSecret: optional(source.SENDBLUE_SIGNING_SECRET),
    sendbluePhoneNumber: optional(source.SENDBLUE_PHONE_NUMBER),
    smtpUrl: optional(source.SMTP_URL),
    emailFrom: optional(source.EMAIL_FROM),
    emailEmulator: source.EMAIL_EMULATOR === "true" && source.NODE_ENV !== "production",
    slackBotToken: optional(source.SLACK_BOT_TOKEN),
    slackSigningSecret: optional(source.SLACK_SIGNING_SECRET),
    whatsappAccessToken: optional(source.WHATSAPP_ACCESS_TOKEN),
    whatsappPhoneNumberId: optional(source.WHATSAPP_PHONE_NUMBER_ID),
    whatsappAppSecret: optional(source.WHATSAPP_APP_SECRET),
    whatsappVerifyToken: optional(source.WHATSAPP_VERIFY_TOKEN),
    telegramBotToken: optional(source.TELEGRAM_BOT_TOKEN),
    telegramWebhookSecret: optional(source.TELEGRAM_WEBHOOK_SECRET_TOKEN),
    larkAppId: optional(source.LARK_APP_ID),
    larkAppSecret: optional(source.LARK_APP_SECRET),
    larkVerificationToken: optional(source.LARK_VERIFICATION_TOKEN),
    larkEncryptKey: optional(source.LARK_ENCRYPT_KEY),
    larkDomain: optional(source.LARK_DOMAIN),
    messagingOpenSignup: source.MESSAGING_OPEN_SIGNUP === "true",
    teamChatBotId: optional(source.TEAM_CHAT_BOT_ID) ?? optional(source.SLACK_TANGOW_BOT_ID),
    teamChatJudgeProvider: optional(source.TEAM_CHAT_JUDGE_PROVIDER),
    teamChatJudgeModel: optional(source.TEAM_CHAT_JUDGE_MODEL),
    defaultProvider: deploymentModel.provider,
    defaultModel: deploymentModel.model,
    wakeupDriver: source.WAKEUP_DRIVER ?? "graphile",
    mcpStdioEnabled: source.MCP_STDIO_ENABLED === "true",
    mcpStdioAllowedCommands: (source.MCP_STDIO_ALLOWED_COMMANDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    port: Number(source.API_PORT ?? 3100),
    gitSha: optional(source.GIT_SHA) ?? optional(source.TANGOW_GIT_SHA),
    updaterUrl,
    updaterToken,
    imageTag: optional(source.TANGOW_IMAGE_TAG),
  };
}

function required(source: NodeJS.ProcessEnv, key: string): string {
  const value = source[key];
  if (!value) throw new Error(`Missing ${key}`);
  return value;
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
