import { MIGRATION_WAIT_TIMEOUT_S } from "@tangow/contracts";
import { DEFAULT_UPDATE_REMOTE, normalizeRepoUrl, normalizeUpdateBranch } from "./self-update.js";

/** The server image every deployment builds from its own checkout. One image runs api, worker, and web. */
export const DEFAULT_SERVER_IMAGE = "tangow/app";

/**
 * The tag a deployment that has never run an update is on. `docker compose up --build` builds it
 * from the checkout; each update then builds and pins `local-<commit>`.
 */
export const LOCAL_IMAGE_TAG = "local";
export const DEFAULT_IMAGE_TAG = LOCAL_IMAGE_TAG;
export const IMAGE_TAG_ENV = "TANGOW_IMAGE_TAG";
export const PREVIOUS_IMAGE_TAG_ENV = "TANGOW_IMAGE_TAG_PREVIOUS";

/**
 * Matches the `name:` pinned in `infra/compose/docker-compose.prod.yml`. Used when Compose has not
 * injected `COMPOSE_PROJECT_NAME` (it does, into running services) and no dedicated override is set.
 */
export const DEFAULT_COMPOSE_PROJECT_NAME = "tangow-prod";
export const COMPOSE_PROJECT_NAME_ENV = "COMPOSE_PROJECT_NAME";
export const COMPOSE_PROJECT_NAME_OVERRIDE_ENV = "TANGOW_COMPOSE_PROJECT_NAME";

/**
 * The services a recreate replaces. `updater` is deliberately absent: it is the process running
 * the update, and recreating it would kill the run half way through. `postgres` and `caddy` are
 * absent because neither uses the Tangow image.
 */
export const RECREATED_SERVICES = ["api", "worker", "web"] as const;

const IMAGE_TAG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const IMAGE_NAME_SEGMENT = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const IMAGE_HOST = /^[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{1,5})?$/;
const COMMIT = /^[0-9a-f]{40,64}$/;
const ENV_KEY = /^[A-Z][A-Z0-9_]*$/;
const ENV_VALUE = /^[A-Za-z0-9._:/@+-]{0,256}$/;
/** Compose project names must not start with `-`, or `-p` would treat them as a second flag. */
const COMPOSE_PROJECT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export function isValidImageTag(tag: string): boolean {
  return IMAGE_TAG.test(tag);
}

/** An image reference the updater is willing to hand to `docker compose` as one env value. */
export function isValidImageName(name: string): boolean {
  if (name.length === 0 || name.length > 200) return false;
  const segments = name.split("/");
  const first = segments[0] ?? "";
  const hasHost = segments.length > 1 && (first.includes(".") || first.includes(":"));
  if (hasHost && !IMAGE_HOST.test(first)) return false;
  return segments.slice(hasHost ? 1 : 0).every((segment) => IMAGE_NAME_SEGMENT.test(segment));
}

export function isValidComposeProjectName(name: string): boolean {
  return COMPOSE_PROJECT_NAME.test(name);
}

/**
 * The project `-p` must name. Compose injects `COMPOSE_PROJECT_NAME` into running services, which
 * is the stack the operator actually started (including `docker compose -p something-else`). A
 * dedicated override exists for running the sidecar outside Compose. Unset falls back to the name
 * pinned in the compose file, never to guessing from the working directory.
 */
export function resolveComposeProjectName(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const injected = env[COMPOSE_PROJECT_NAME_ENV]?.trim() ?? "";
  const override = env[COMPOSE_PROJECT_NAME_OVERRIDE_ENV]?.trim() ?? "";
  const candidate = injected || override;
  if (candidate === "") return DEFAULT_COMPOSE_PROJECT_NAME;
  if (!isValidComposeProjectName(candidate)) {
    throw new Error(`Refusing an unusable Compose project name: ${candidate}`);
  }
  return candidate;
}

export function imageRef(name: string, tag: string): string {
  if (!isValidImageName(name)) throw new Error(`Refusing an unusable image name: ${name}`);
  if (!isValidImageTag(tag)) throw new Error(`Refusing an unusable image tag: ${tag}`);
  return `${name}:${tag}`;
}

/** The tag an update's build is stored under, one per source commit. */
export function forkImageTag(commit: string): string {
  if (!COMMIT.test(commit)) throw new Error("A build needs a resolved commit to tag.");
  return `local-${commit}`;
}

export type ExecutionMode = "sidecar" | "checkout" | "unavailable";

export interface ExecutionModeDecision {
  mode: ExecutionMode;
  reason: string | null;
}

/**
 * Which of the two engines can actually apply an update here. The sidecar wins whenever it is
 * configured: a Compose deployment's own container has no `.git` and nothing to restart it, so its
 * only route is the container that outlives it.
 */
export function resolveExecutionMode(input: {
  hasUpdater?: boolean;
  hasCheckout?: boolean;
  disabled?: boolean;
}): ExecutionModeDecision {
  if (input.disabled === true) {
    return { mode: "unavailable", reason: "Self-update is switched off for this deployment." };
  }
  if (input.hasUpdater === true) return { mode: "sidecar", reason: null };
  if (input.hasCheckout === true) return { mode: "checkout", reason: null };
  return {
    mode: "unavailable",
    reason:
      "This deployment has neither an updater sidecar nor a git checkout, so it cannot update itself. Add the `updater` service from infra/compose/docker-compose.prod.yml.",
  };
}

/**
 * What the deployment-owner Settings UI should show. Distinct from {@link resolveExecutionMode}:
 * Compose without the opt-in sidecar is still a Compose install, and source checkouts must never
 * look like they can one-click apply from the API process (no `.git` in the app image; no Docker
 * socket either).
 */
export type InstallKind = "sidecar" | "compose" | "source";

export interface InstallKindDecision {
  kind: InstallKind;
  /** Maps onto ServerUpdateMode for contracts that already use that enum. */
  mode: ExecutionMode;
  reason: string | null;
}

/**
 * `updaterUrlConfigured` means the API was given `TANGOW_UPDATER_URL` (Compose prod always sets
 * this). Reachability requires both URL and token and a live sidecar. A source checkout is only
 * claimed when there is no Compose updater wiring and `.git` is present on disk.
 */
export function resolveInstallKind(input: {
  updaterUrlConfigured?: boolean;
  updaterReachable?: boolean;
  hasCheckout?: boolean;
  disabled?: boolean;
}): InstallKindDecision {
  if (input.disabled === true) {
    return {
      kind:
        input.updaterUrlConfigured === true
          ? "compose"
          : input.hasCheckout === true
            ? "source"
            : "compose",
      mode: "unavailable",
      reason: "Self-update is switched off for this deployment.",
    };
  }
  if (input.updaterReachable === true) {
    return { kind: "sidecar", mode: "sidecar", reason: null };
  }
  if (input.updaterUrlConfigured === true) {
    return {
      kind: "compose",
      mode: "unavailable",
      reason:
        "The updater sidecar is not reachable. Start the opt-in `updater` profile, or upgrade from the host with the Compose commands below.",
    };
  }
  if (input.hasCheckout === true) {
    return {
      kind: "source",
      mode: "checkout",
      reason: "This is a source checkout. Upgrade from a terminal; Settings cannot apply it.",
    };
  }
  return {
    kind: "compose",
    mode: "unavailable",
    reason:
      "This deployment has no updater sidecar. Upgrade from the host with the Compose commands below, or enable the `updater` profile.",
  };
}

/** Exact host commands from docs/self-host.md for a Compose install: rebuild from the checkout. */
export const COMPOSE_UPGRADE_COMMANDS = [
  "git pull",
  'docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/checkout" -w /checkout node:22-bookworm@sha256:0557ac14e0d45d02ed563067b82856ca5e7aa3437fa28d98d4350ea9c3d9494a node scripts/tangow-vault.mjs',
  "docker compose --env-file .env -f infra/compose/docker-compose.prod.yml pull --policy missing openbao",
  "GIT_SHA=$(git rev-parse HEAD) docker compose --env-file .env -f infra/compose/docker-compose.prod.yml up -d --wait --pull never --build api worker web",
] as const;

/** Exact host commands from docs/self-host.md for source / `pnpm dev` installs. */
export const SOURCE_MANUAL_UPGRADE_COMMANDS = [
  "# Stop the API and worker processes",
  "./scripts/backup.sh",
  "git pull",
  "pnpm install --frozen-lockfile",
  "pnpm exec tsx scripts/backfill-session-log.ts",
  "pnpm exec tsx scripts/migrate-docker-homes.ts",
  "# Start the API and worker processes",
] as const;

/** Host commands Settings should show when the sidecar cannot apply. */
export function manualUpgradeCommands(kind: InstallKind): readonly string[] {
  if (kind === "source") return SOURCE_MANUAL_UPGRADE_COMMANDS;
  if (kind === "compose") return COMPOSE_UPGRADE_COMMANDS;
  return [];
}

export interface ComposeInvocation {
  command: string;
  args: string[];
}

export interface ComposeTarget {
  /**
   * Compose files in overlay order, each passed as its own `--file`. A deployment that layers an
   * overlay on the base file has to be reconciled with the same file list the operator uses, or an
   * update recreates services without the overlay's wiring.
   */
  composeFiles: readonly string[];
  envFiles?: readonly string[];
  /** Passed as `docker compose -p <name>`. Defaults to {@link DEFAULT_COMPOSE_PROJECT_NAME}. */
  projectName?: string;
  /**
   * Services to recreate and roll back. Defaults to {@link RECREATED_SERVICES}. A deployment
   * whose overlay adds an app-image service has to recreate that one too, or the update leaves it
   * running the old code.
   */
  services?: readonly string[];
}

function composeBase(target: ComposeTarget): string[] {
  const projectName = target.projectName ?? DEFAULT_COMPOSE_PROJECT_NAME;
  if (!isValidComposeProjectName(projectName)) {
    throw new Error(`Refusing an unusable Compose project name: ${projectName}`);
  }
  if (target.composeFiles.length === 0) {
    throw new Error("Refusing a Compose target with no Compose file.");
  }
  const args = ["compose", "-p", projectName];
  for (const envFile of target.envFiles ?? []) args.push("--env-file", envFile);
  for (const composeFile of target.composeFiles) args.push("--file", composeFile);
  return args;
}

function targetServices(target: ComposeTarget): readonly string[] {
  const services = target.services ?? [];
  return services.length > 0 ? services : RECREATED_SERVICES;
}

const RESTORE_WAIT_TIMEOUT_S = 300;

export function composePullArgv(target: ComposeTarget, service: string): ComposeInvocation {
  return {
    command: "docker",
    args: [...composeBase(target), "pull", "--policy", "missing", service],
  };
}

/**
 * `restore` brings back a previous image without its dependencies: a release older than the
 * `migrate` service has nothing to run there, and an older schema is never migrated back to.
 */
export function composeUpArgv(
  target: ComposeTarget,
  options: { build?: boolean; services?: readonly string[]; restore?: boolean } = {},
): ComposeInvocation {
  const args = [
    ...composeBase(target),
    "up",
    "--detach",
    "--wait",
    "--wait-timeout",
    String(options.restore ? RESTORE_WAIT_TIMEOUT_S : MIGRATION_WAIT_TIMEOUT_S),
    "--pull",
    "never",
  ];
  if (options.restore) args.push("--no-deps");
  args.push(options.build === true ? "--build" : "--no-build");
  args.push(...(options.services ?? targetServices(target)));
  return { command: "docker", args };
}

/** The one-shot service that migrates the database before the API and the worker start. */
export const MIGRATE_SERVICE = "migrate";
/** The migration that drops the legacy messages table: a release without it predates the log. */
export const MESSAGES_DROP_MIGRATION = "20261012000000_drop_messages";

/** Stops and removes the migrate service, so a migration still running ends before a restore. */
export function composeStopMigrateArgv(target: ComposeTarget): ComposeInvocation {
  return {
    command: "docker",
    args: [...composeBase(target), "rm", "--stop", "--force", MIGRATE_SERVICE],
  };
}

/** Prints `t` once the database has dropped the legacy messages table, `f` while it has it. */
export function composeMessagesDroppedArgv(target: ComposeTarget): ComposeInvocation {
  return {
    command: "docker",
    args: [
      ...composeBase(target),
      "exec",
      "-T",
      "postgres",
      "sh",
      "-c",
      `psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT to_regclass('public.messages') IS NULL"`,
    ],
  };
}

/**
 * Succeeds when the local image carries the migration that drops the messages, so it runs on the
 * log. An image the host does not have fails, like one that predates the log.
 */
export function imageKnowsSessionLogArgv(image: string): ComposeInvocation {
  return {
    command: "docker",
    args: [
      "run",
      "--rm",
      "--pull",
      "never",
      "--network",
      "none",
      "--entrypoint",
      "test",
      image,
      "-d",
      `/app/packages/db/prisma/migrations/${MESSAGES_DROP_MIGRATION}`,
    ],
  };
}

export function composePsArgv(target: ComposeTarget): ComposeInvocation {
  return { command: "docker", args: [...composeBase(target), "ps", "--format", "json"] };
}

/**
 * `git status` as seen inside the Linux sidecar against a Windows checkout. `core.autocrlf=true`
 * makes CR-only worktree noise match what the host already considers clean. The `-c` is argv, not a
 * shell fragment.
 */
export function gitStatusArgv(): string[] {
  return [
    "--no-optional-locks",
    "-c",
    "core.autocrlf=true",
    "status",
    "--porcelain",
    "--untracked-files=no",
  ];
}

/** Worktree vs index, ignoring CR at EOL so a CRLF-only file does not count as dirty. */
export function gitWorktreeContentDiffArgv(): string[] {
  return [
    "--no-optional-locks",
    "-c",
    "core.autocrlf=true",
    "diff",
    "--name-only",
    "--ignore-cr-at-eol",
  ];
}

/** Index vs HEAD, same CR rule, so a staged content change cannot hide behind the worktree check. */
export function gitIndexContentDiffArgv(): string[] {
  return [
    "--no-optional-locks",
    "-c",
    "core.autocrlf=true",
    "diff",
    "--cached",
    "--name-only",
    "--ignore-cr-at-eol",
  ];
}

/** Untracked source can enter `COPY . .`, so a build must not silently include it. */
export function gitUntrackedFilesArgv(): string[] {
  return ["--no-optional-locks", "ls-files", "--others", "--exclude-standard"];
}

export function parseGitNameOnly(stdout: string): string[] {
  const paths: string[] = [];
  for (const line of stdout.split("\n")) {
    const path = line.trim();
    if (path !== "") paths.push(path);
  }
  return paths;
}

export interface TrackedDirtyDecision {
  dirty: boolean;
  dirtyPaths: string[];
}

/**
 * Porcelain lists every tracked path git considers dirty, including CRLF-only noise when a Windows
 * `core.autocrlf=true` checkout is bind-mounted into Linux. `contentChanged` is the same comparison
 * after `--ignore-cr-at-eol`. Porcelain-only paths are dropped; a path that still has a content
 * diff stays dirty. If the content diffs could not be read, porcelain is the last word — the guard
 * is not weakened for a failed filter.
 */
export function resolveTrackedDirtyPaths(input: {
  porcelainChanged: readonly string[];
  contentChanged: readonly string[];
  contentDiffOk: boolean;
  untrackedPaths?: readonly string[];
}): TrackedDirtyDecision {
  const untrackedPaths = input.untrackedPaths ?? [];
  if (!input.contentDiffOk) {
    const dirtyPaths = uniquePaths([...input.porcelainChanged, ...untrackedPaths]);
    return { dirty: dirtyPaths.length > 0, dirtyPaths };
  }
  const dirtyPaths = uniquePaths([...input.contentChanged, ...untrackedPaths]);
  return { dirty: dirtyPaths.length > 0, dirtyPaths };
}

function uniquePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const path of paths) {
    if (path === "" || seen.has(path)) continue;
    seen.add(path);
    unique.push(path);
  }
  return unique;
}

export interface ComposeUpdateStep {
  id: string;
  label: string;
  command: string;
  args: string[];
}

export interface ComposeUpdatePlanInput {
  target: ComposeTarget;
  /** Only used when the checkout's remote has to be re-pointed. */
  repoUrl?: string;
  branch?: string;
  repointRemote?: boolean;
  remote?: string;
}

/**
 * Ordered work for one Compose update.
 *
 * Migrations are absent on purpose. The `api` and `worker` services wait on the one-shot `migrate`
 * service, so a recreate already orders them correctly: Compose stops the old containers, the new
 * image migrates, then they start. Running migrations from here would instead apply the new schema
 * while the old processes are still answering requests, which is the window this ordering exists
 * to close.
 */
export function composeUpdatePlan(input: ComposeUpdatePlanInput): ComposeUpdateStep[] {
  const steps: ComposeUpdateStep[] = [];
  const remote = input.remote ?? DEFAULT_UPDATE_REMOTE;
  const branch = input.branch ?? "main";
  if (input.repointRemote === true && input.repoUrl) {
    steps.push({
      id: "remote",
      label: "Point the checkout at the chosen repository",
      command: "git",
      args: ["remote", "set-url", remote, input.repoUrl],
    });
  }
  steps.push(
    {
      id: "fetch",
      label: "Fetch the latest commits",
      command: "git",
      args: ["fetch", remote, branch],
    },
    {
      id: "checkout",
      label: `Check out ${branch}`,
      command: "git",
      args: ["checkout", branch],
    },
    {
      id: "merge",
      label: "Fast-forward to the fetched commit",
      command: "git",
      args: ["merge", "--ff-only", `${remote}/${branch}`],
    },
  );
  const up = composeUpArgv(input.target, { build: true });
  steps.push({
    id: "recreate",
    label: "Build the new images and recreate the services",
    command: up.command,
    args: up.args,
  });
  return steps;
}

export type RollbackDecision = { tag: string } | { error: string };

/**
 * Rollback is "deploy the tag that was running before the last update", reusing the image already
 * built on this host.
 */
export function rollbackTarget(input: {
  currentTag: string | null;
  previousTag: string | null;
}): RollbackDecision {
  if (!input.previousTag) {
    return { error: "No previous image tag was recorded, so there is nothing to roll back to." };
  }
  if (!isValidImageTag(input.previousTag)) {
    return { error: "The recorded previous image tag is not a usable tag." };
  }
  if (input.previousTag === input.currentTag) {
    return { error: "The previous image tag is the one already running." };
  }
  return { tag: input.previousTag };
}

/**
 * Rewrites managed assignments in the deployment's `.env` without disturbing anything else in it,
 * so the operator's own `docker compose --env-file .env … up -d` keeps using the pinned tag.
 * Values are checked against a conservative grammar first: this file is read by Compose as
 * interpolation input, and it is the last place a repository URL or ref could leak into a build
 * argument or a service definition.
 */
export function upsertEnvAssignments(
  contents: string,
  assignments: Readonly<Record<string, string>>,
): string {
  for (const [key, value] of Object.entries(assignments)) {
    if (!ENV_KEY.test(key)) throw new Error(`Refusing to write the env key ${key}.`);
    if (!ENV_VALUE.test(value)) throw new Error(`Refusing to write the value of ${key}.`);
  }
  const newline = contents.includes("\r\n") ? "\r\n" : "\n";
  const lines = contents.split(/\r?\n/);
  const pending = new Map(Object.entries(assignments));
  const next = lines.map((line) => {
    const key = line.match(/^([A-Z][A-Z0-9_]*)=/)?.[1];
    if (key === undefined || !Object.hasOwn(assignments, key)) return line;
    const value = assignments[key] as string;
    pending.delete(key);
    return `${key}=${value}`;
  });
  if (pending.size > 0) {
    while (next.length > 0 && next[next.length - 1] === "") next.pop();
    if (next.length > 0) next.push("");
    for (const [key, value] of pending) next.push(`${key}=${value}`);
  }
  const rendered = next.join(newline);
  return rendered.endsWith(newline) ? rendered : `${rendered}${newline}`;
}

export interface UpdateRequest {
  repoUrl: string;
  branch: string;
}

export type UpdateRequestResult = { request: UpdateRequest } | { error: string };

/**
 * The sidecar's own front door. It holds the Docker socket, so it is a separate trust boundary and
 * re-runs every check the API already ran rather than trusting that the caller sanitized anything.
 */
export function validateUpdateRequest(input: {
  repoUrl?: unknown;
  branch?: unknown;
}): UpdateRequestResult {
  if (typeof input.repoUrl !== "string") return { error: "A repository URL is required." };
  if (typeof input.branch !== "string") return { error: "A branch is required." };
  const url = normalizeRepoUrl(input.repoUrl);
  if ("error" in url) return { error: url.error };
  const branch = normalizeUpdateBranch(input.branch);
  if ("error" in branch) return { error: branch.error };
  return { request: { repoUrl: url.url, branch: branch.branch } };
}
