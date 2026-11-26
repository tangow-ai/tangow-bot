import { createHash } from "node:crypto";
import path from "node:path";
import { MAX_DESKTOP_DISPLAY, screenPorts } from "@tangow/core/node/desktop-runtime";
import type Docker from "dockerode";

export const COMPUTER_IMAGE = process.env.TANGOW_COMPUTER_IMAGE ?? "tangow/computer:local";
export const COMPUTER_UID = 1000;
export const COMPUTER_GID = 1000;
export const COMPUTER_USER = `${COMPUTER_UID}:${COMPUTER_GID}`;

export { screenPorts };
export const COMPUTER_CONTROL_PORT = 7070;
export const SCREEN_HOST = process.env.SANDBOX_SCREEN_HOST ?? "127.0.0.1";
export type ScreenNetworkMode = "published" | "internal" | "isolated";

export function resolveTeamScreenLimit(value = process.env.SANDBOX_TEAM_SCREEN_LIMIT): number {
  if (value === undefined || value.trim() === "" || isUnlimited(value)) return MAX_DESKTOP_DISPLAY;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error(
      "SANDBOX_TEAM_SCREEN_LIMIT must be a positive integer, or 0 for no configured cap",
    );
  }
  return Math.min(limit, MAX_DESKTOP_DISPLAY);
}

export function resolveSpaceComputerLimit(
  value = process.env.SANDBOX_MAX_COMPUTERS_PER_SPACE,
): number {
  if (value === undefined || value.trim() === "" || isUnlimited(value)) return 0;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error(
      "SANDBOX_MAX_COMPUTERS_PER_SPACE must be a positive integer, or 0 for no configured cap",
    );
  }
  return limit;
}

/**
 * Resource ceilings for a bot computer.
 *
 * A computer runs Xvfb, a window manager and a full Chromium on behalf of an
 * agent that decides for itself what to open. #343 gave these containers a
 * pids ceiling, but Memory and NanoCpus are still unset, so one runaway page is
 * a host-wide memory and CPU event that takes every other bot and the Tangow
 * services down with it. Every service in docker-compose.prod.yml already
 * carries mem_limit; this applies the same discipline to the containers that
 * actually run untrusted page content.
 *
 * Defaults are a starting point for the Docker computer topology: generous enough
 * for real browsing, small enough that one computer cannot starve the host or
 * sibling bots. The pids default is #343's existing 2048, unchanged. Set any of
 * these to "0", "none" or "unlimited" to opt out.
 */
const DEFAULT_COMPUTER_MEMORY = "8g";
const DEFAULT_COMPUTER_CPUS = "4";
const DEFAULT_COMPUTER_PIDS_LIMIT = "2048";
/** The daemon refuses HostConfig.Memory below this at container creation. */
const MIN_DOCKER_MEMORY_BYTES = 6 * 1024 ** 2;

const MEMORY_UNITS: Record<string, number> = {
  b: 1,
  k: 1024,
  m: 1024 ** 2,
  g: 1024 ** 3,
};

function isUnlimited(raw: string): boolean {
  const value = raw.trim().toLowerCase();
  return value === "0" || value === "unlimited" || value === "none";
}

/** Bytes from a docker-style size string ("2g", "1536m", "1073741824"). */
export function parseMemoryBytes(name: string, raw: string): number {
  if (isUnlimited(raw)) return 0;
  const match = /^(\d+(?:\.\d+)?)\s*([bkmg])?b?$/i.exec(raw.trim());
  if (!match) {
    throw new Error(`${name} must be a size like "2g", "1536m" or a byte count, received "${raw}"`);
  }
  const scale = MEMORY_UNITS[(match[2] ?? "b").toLowerCase()] ?? 1;
  const bytes = Math.floor(Number(match[1]) * scale);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error(`${name} must resolve to a positive byte count, received "${raw}"`);
  }
  // The daemon rejects a limit under 6 MiB at container creation. Catching it here turns a
  // per-bot 500 at the first `POST /computers` into a startup failure that names the variable.
  if (bytes < MIN_DOCKER_MEMORY_BYTES) {
    throw new Error(`${name} must be at least 6m, Docker's minimum, received "${raw}"`);
  }
  return bytes;
}

/** Docker NanoCpus (1e9 per core) from a CPU count like "1.5". */
export function parseNanoCpus(name: string, raw: string): number {
  if (isUnlimited(raw)) return 0;
  const value = Number(raw.trim());
  // Tiny positives floor to 0 nanocpus (Docker reads as unlimited). Huge values leave the
  // safe-integer range or become Infinity. Validate the converted number either way.
  const nanoCpus = Math.floor(value * 1e9);
  if (!Number.isSafeInteger(nanoCpus) || nanoCpus <= 0) {
    throw new Error(`${name} must be a positive number of CPUs, received "${raw}"`);
  }
  return nanoCpus;
}

function parsePidsLimit(name: string, raw: string): number {
  if (isUnlimited(raw)) return 0;
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, received "${raw}"`);
  }
  return value;
}

/** The host resource ceilings applied to every bot computer. */
export function computerResourceLimits() {
  const memoryBytes = parseMemoryBytes(
    "TANGOW_COMPUTER_MEMORY",
    process.env.TANGOW_COMPUTER_MEMORY ?? DEFAULT_COMPUTER_MEMORY,
  );
  const nanoCpus = parseNanoCpus(
    "TANGOW_COMPUTER_CPUS",
    process.env.TANGOW_COMPUTER_CPUS ?? DEFAULT_COMPUTER_CPUS,
  );
  const pidsLimit = parsePidsLimit(
    "TANGOW_COMPUTER_PIDS_LIMIT",
    process.env.TANGOW_COMPUTER_PIDS_LIMIT ?? DEFAULT_COMPUTER_PIDS_LIMIT,
  );
  return {
    // Memory and MemorySwap are set together: leaving MemorySwap unset lets the
    // container swap to twice Memory, so the ceiling would not hold.
    Memory: memoryBytes,
    MemorySwap: memoryBytes,
    NanoCpus: nanoCpus,
    PidsLimit: pidsLimit,
  };
}

/** Where computers run. Read once at startup: an unknown value stops the supervisor. */
export function resolveSupervisorBackend(value: string | undefined): "docker" | "kubernetes" {
  if (!value || value === "docker") return "docker";
  if (value === "kubernetes") return value;
  throw new Error(`Unsupported SUPERVISOR_BACKEND value: ${value} (use docker or kubernetes)`);
}

export function resolveScreenNetworkMode(value: string | undefined): ScreenNetworkMode {
  if (!value || value === "published") return "published";
  if (value === "internal" || value === "isolated") return value;
  throw new Error(`Unsupported SANDBOX_SCREEN_NETWORK value: ${value}`);
}

export function hostComputerUser(uid = process.getuid?.(), gid = process.getgid?.()): string {
  if (uid === undefined || gid === undefined || uid === 0) return COMPUTER_USER;
  return `${uid}:${gid}`;
}

export function computerPortBindings(publishControlPort = false) {
  const ExposedPorts: Record<string, object> = {};
  const PortBindings: Record<string, Array<{ HostIp: string; HostPort: string }>> = {};
  const port = `${screenPorts(0).viewPort}/tcp`;
  ExposedPorts[port] = {};
  PortBindings[port] = [{ HostIp: "127.0.0.1", HostPort: "0" }];
  // Host-run Docker Desktop supervisors need an opt-in loopback mapping.
  // Otherwise control stays unpublished on the container network.
  if (publishControlPort) {
    ExposedPorts[`${COMPUTER_CONTROL_PORT}/tcp`] = {};
    PortBindings[`${COMPUTER_CONTROL_PORT}/tcp`] = [{ HostIp: "127.0.0.1", HostPort: "0" }];
  }
  return { ExposedPorts, PortBindings };
}

export function computerHomeStorage(
  serviceHomePath: string,
  dataDir: string,
  info: Docker.ContainerInspectInfo | undefined,
): { homePath: string; homeVolume?: { name: string; subpath: string } } {
  const relative = path.relative(dataDir, serviceHomePath);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("computer home must be inside the data directory");
  }
  const mount = info?.Mounts.find((entry) => entry.Destination === dataDir);
  if (mount?.Type === "volume") {
    if (!mount.Name) throw new Error("computer data volume has no name");
    return { homePath: serviceHomePath, homeVolume: { name: mount.Name, subpath: relative } };
  }
  return { homePath: mount?.Source ? path.join(mount.Source, relative) : serviceHomePath };
}

export function assertVolumeSubpathSupport(apiVersion: string) {
  const match = /^(\d+)\.(\d+)$/.exec(apiVersion);
  if (!match || Number(match[1]) < 1 || (Number(match[1]) === 1 && Number(match[2]) < 45)) {
    throw new Error("Docker Engine 26+ (API 1.45+) is required for bot home volume subpaths");
  }
}

export function homeVolumeMatches(
  mounts: Docker.ContainerInspectInfo["HostConfig"]["Mounts"],
  volume: { name: string; subpath: string },
) {
  return (
    mounts?.some(
      (mount) =>
        mount.Target === "/home/tangow" &&
        mount.Type === "volume" &&
        mount.Source === volume.name &&
        mount.VolumeOptions?.Subpath === volume.subpath &&
        !mount.ReadOnly,
    ) ?? false
  );
}

/** A computer whose home is on volumes: what it mounts, where its workspace starts, and their digest. */
export interface ComputerVolumeHome {
  root: string;
  mounts: WorkerMountSource[];
  digest: string;
}

/**
 * The volumes a computer mounts, validated as a worker's are, at the same paths. The workspace
 * root is `/workspace` for a team computer or its bot's volume for a dedicated one. The digest is
 * the computer's identity: a running container cannot mount another volume, so it is replaced.
 */
export function computerVolumeHome(
  input: { root: string; mounts: ReadonlyArray<{ volume: string; path: string }> },
  dataDir: string,
  info: Docker.ContainerInspectInfo | undefined,
): ComputerVolumeHome {
  const mounts = workerMounts(
    input.mounts.map((mount) => ({ ...mount, readOnly: false })),
    dataDir,
    info,
  );
  if (input.root !== "/workspace" && !input.mounts.some((mount) => mount.path === input.root)) {
    throw new Error("the computer workspace must be /workspace or one of its volumes");
  }
  const sorted = input.mounts.map((mount) => [mount.path, mount.volume]).sort();
  const digest = createHash("sha256")
    .update(JSON.stringify({ root: input.root, mounts: sorted }))
    .digest("hex");
  return { root: input.root, mounts, digest };
}

/** The labels that record a computer's volumes. A computer created before its home moved has none. */
export function volumeHomeLabels(
  volumeHome: ComputerVolumeHome | undefined,
): Record<string, string> {
  return volumeHome
    ? {
        "tangow.home": "volumes",
        "tangow.mounts": volumeHome.digest,
        "tangow.workspace": volumeHome.root,
      }
    : {};
}

export function volumeHomeMatches(
  labels: Record<string, string> | undefined,
  volumeHome: ComputerVolumeHome | undefined,
) {
  return (labels?.["tangow.mounts"] ?? null) === (volumeHome?.digest ?? null);
}

/** Where the computer's workspace starts: its home, or the root of its volumes. */
export function computerWorkspace(labels: Record<string, string> | undefined) {
  return labels?.["tangow.workspace"] ?? "/home/tangow";
}

function dockerMount(mount: WorkerMountSource): Docker.MountSettings {
  return "bind" in mount.source
    ? { Type: "bind", Source: mount.source.bind, Target: mount.target, ReadOnly: mount.readOnly }
    : {
        Type: "volume",
        Source: mount.source.volume,
        Target: mount.target,
        ReadOnly: mount.readOnly,
        VolumeOptions: {
          NoCopy: true,
          Subpath: mount.source.subpath,
        } as Docker.MountSettings["VolumeOptions"],
      };
}

export interface ComputerCreateInput {
  name: string;
  image: string;
  botId: string;
  spaceId: string;
  homePath: string;
  homeVolume?: { name: string; subpath: string };
  volumeHome?: ComputerVolumeHome;
  user?: string;
  controlToken?: string;
  networkMode?: string;
  /** Extra `host:container:ro` binds, appended after the home bind. */
  skillsBinds?: string[];
  publishControlPort?: boolean;
}

interface PointerInput {
  kind: "pointer";
  x: number;
  y: number;
  button?: "left" | "right";
  type: "move" | "down" | "up" | "click";
}

export type SandboxInput =
  | { kind: "key"; key: string; modifiers?: string[] }
  | PointerInput
  | { kind: "clipboard"; text: string };

export function containerCreateOptions(input: ComputerCreateInput) {
  const ports = computerPortBindings(input.publishControlPort);
  const volumeMounts = input.volumeHome?.mounts.map(dockerMount) ?? [];
  return {
    Image: input.image,
    name: input.name,
    User: input.user ?? COMPUTER_USER,
    Tty: true,
    Env: [
      "DISPLAY=:1",
      "HOME=/home/tangow",
      "PATH=/home/tangow/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "NPM_CONFIG_PREFIX=/home/tangow/.local",
      "PIP_USER=1",
      ...(input.controlToken ? [`TANGOW_COMPUTER_CONTROL_TOKEN=${input.controlToken}`] : []),
    ],
    Labels: {
      "tangow.managed": "true",
      "tangow.botId": input.botId,
      "tangow.spaceId": input.spaceId,
      ...volumeHomeLabels(input.volumeHome),
    },
    ExposedPorts: ports.ExposedPorts,
    HostConfig: {
      ...(input.homeVolume
        ? {
            Binds: input.skillsBinds?.length ? [...input.skillsBinds] : undefined,
            Mounts: [
              {
                Type: "volume" as const,
                Source: input.homeVolume.name,
                Target: "/home/tangow",
                // Docker makes Labels and DriverConfig optional; dockerode's types do not.
                VolumeOptions: {
                  NoCopy: true,
                  Subpath: input.homeVolume.subpath,
                } as Docker.MountSettings["VolumeOptions"],
              },
              ...volumeMounts,
            ],
          }
        : {
            Binds: [`${input.homePath}:/home/tangow`, ...(input.skillsBinds ?? [])],
            Mounts: volumeMounts.length ? volumeMounts : undefined,
          }),
      PortBindings: ports.PortBindings,
      ShmSize: 256 * 1024 * 1024,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      ...computerResourceLimits(),
      ReadonlyPaths: ["/usr/share/novnc"],
      AutoRemove: false,
      NetworkMode: input.networkMode ?? "bridge",
    },
    WorkingDir: input.volumeHome?.root ?? "/home/tangow",
  };
}

export function sanitizeIdentifier(botId: string) {
  const safe = botId.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 40);
  return safe || "box";
}

export function containerNameFor(botId: string) {
  return `tangow-bot-${sanitizeIdentifier(botId)}`;
}

export function computerNetworkNameFor(botId: string) {
  // Keep distinct botIds on distinct networks even when sanitization collapses
  // characters (e.g. "a/b" and "ab"). Do not change containerNameFor — that
  // name must stay stable so an existing computer can resume.
  const hash = createHash("sha256").update(botId).digest("hex").slice(0, 32);
  return `tangow-computer-${sanitizeIdentifier(botId).slice(0, 32)}-${hash}`;
}

/** Current and prior network names used by this PR, for delete cleanup. */
export function computerNetworkNamesForCleanup(botId: string) {
  const safe = sanitizeIdentifier(botId);
  const digest = createHash("sha256").update(botId).digest("hex");
  return [
    computerNetworkNameFor(botId),
    `tangow-computer-${safe}`,
    `tangow-computer-${safe.slice(0, 32)}-${digest.slice(0, 8)}`,
  ];
}

/**
 * Legacy unsalted network names can collide across botIds. Only remove such a
 * network when no other bot's container is still attached.
 */
export function legacyNetworkOwnedSolelyBy(
  botId: string,
  attachedBotIds: Array<string | undefined>,
): boolean {
  return attachedBotIds.every((owner) => owner === botId);
}

export function screenUrlFor(hostPort: string, host = SCREEN_HOST) {
  return `http://${host}:${hostPort}/embed.html`;
}

export function screenUrlWithToken(screenUrl: string, token: string) {
  const url = new URL(screenUrl);
  url.searchParams.set("path", `websockify?token=${encodeURIComponent(token)}`);
  return url.toString();
}

/**
 * Decide which host:port clients (and readiness probes) should use.
 *
 * Per-bot NetworkMode isolation must not change this: a container always has a
 * docker-internal IP on its network, but browsers cannot load that 172.x
 * address. Compose modes that attach the supervisor/screen proxy to the bot
 * network may return the container IP; host-run supervisors use the published
 * loopback mapping.
 */
export function resolveScreenPublishTarget(input: {
  screenNetwork: ScreenNetworkMode;
  networkMode: string | null | undefined;
  networks: Record<string, { IPAddress?: string } | undefined> | null | undefined;
  hostPort: string | undefined;
  containerPort: string;
  screenHost?: string;
}): { host: string; port: string } | undefined {
  if (input.screenNetwork === "internal" || input.screenNetwork === "isolated") {
    const address = input.networkMode ? input.networks?.[input.networkMode]?.IPAddress : undefined;
    if (address) return { host: address, port: input.containerPort };
    return undefined;
  }
  if (input.hostPort) return { host: input.screenHost ?? SCREEN_HOST, port: input.hostPort };
  return undefined;
}

type ControlPortBindings =
  | Record<string, Array<{ HostIp?: string; HostPort?: string }> | null | undefined>
  | null
  | undefined;

function validHostPort(port: string | undefined): port is string {
  return !!port && /^\d{1,5}$/.test(port) && Number(port) > 0 && Number(port) <= 65535;
}

/** Resolve an assigned runtime port only when every control binding is loopback. */
export function publishedLoopbackControlHostPort(portBindings: ControlPortBindings) {
  const bindings = portBindings?.[`${COMPUTER_CONTROL_PORT}/tcp`];
  if (!bindings?.length || bindings.some((binding) => binding.HostIp !== "127.0.0.1")) {
    return undefined;
  }
  return bindings.find((binding) => validHostPort(binding.HostPort))?.HostPort;
}

/**
 * Reuse only containers whose configured control publication matches the setting.
 * Inspect HostConfig so stopped containers and Docker's automatic port allocation
 * (empty or zero HostPort) work before a runtime port has been assigned.
 */
export function controlPortPublicationMatches(
  portBindings: ControlPortBindings,
  publishControlPort: boolean,
): boolean {
  const bindings = portBindings?.[`${COMPUTER_CONTROL_PORT}/tcp`];
  if (!publishControlPort) return !bindings?.length;
  return (
    !!bindings?.length &&
    bindings.every(
      (binding) =>
        binding.HostIp === "127.0.0.1" &&
        (binding.HostPort === "" || binding.HostPort === "0" || validHostPort(binding.HostPort)),
    )
  );
}

/**
 * Resolve the computer control service. Prefer a published loopback HostPort
 * when provided; otherwise use the Docker network IP. When requirePublishedHostPort
 * is set, never fall back to the container IP (unreachable from Docker Desktop hosts).
 */
export function resolveComputerControlEndpoint(input: {
  token: string | undefined;
  networkMode: string | null | undefined;
  networks: Record<string, { IPAddress?: string } | undefined> | null | undefined;
  publishedHostPort?: string;
  requirePublishedHostPort?: boolean;
}): { url: string; token: string } | undefined {
  if (!input.token) return undefined;
  if (validHostPort(input.publishedHostPort)) {
    return {
      url: `http://127.0.0.1:${input.publishedHostPort}/v1/desktop`,
      token: input.token,
    };
  }
  if (input.requirePublishedHostPort) return undefined;
  const address =
    (input.networkMode ? input.networks?.[input.networkMode]?.IPAddress : undefined) ||
    Object.values(input.networks ?? {}).find((network) => network?.IPAddress)?.IPAddress;
  if (!address) return undefined;
  return { url: `http://${address}:${COMPUTER_CONTROL_PORT}/v1/desktop`, token: input.token };
}

export function xdotoolCommand(input: SandboxInput): string[] {
  if (input.kind === "key") {
    const key = mapKey(input.key);
    const mods = (input.modifiers ?? []).map(mapKey);
    const combo = [...mods, key].join("+");
    return ["xdotool", "key", "--clearmodifiers", combo];
  }
  if (input.kind === "pointer") {
    const btn = input.button === "right" ? "3" : "1";
    if (input.type === "move")
      return ["xdotool", "mousemove", "--", String(input.x), String(input.y)];
    if (input.type === "down") {
      return ["xdotool", "mousemove", "--", String(input.x), String(input.y), "mousedown", btn];
    }
    if (input.type === "up") return ["xdotool", "mouseup", btn];
    return ["xdotool", "mousemove", "--", String(input.x), String(input.y), "click", btn];
  }
  return [...XDOTOOL_TYPE_ARGV, input.text];
}

export const XDOTOOL_TYPE_ARGV = ["xdotool", "type", "--clearmodifiers", "--"];
/** Types its stdin, so the text stays out of every argv and exec URL. */
export const XDOTOOL_TYPE_STDIN = ["xdotool", "type", "--clearmodifiers", "--file", "-"];

function mapKey(key: string) {
  const lower = key.toLowerCase();
  if (lower === "enter" || lower === "return") return "Return";
  if (lower === "esc" || lower === "escape") return "Escape";
  if (lower === "space") return "space";
  if (lower === "tab") return "Tab";
  if (lower === "backspace") return "BackSpace";
  if (lower === "ctrl" || lower === "control") return "ctrl";
  if (lower === "alt") return "alt";
  if (lower === "shift") return "shift";
  if (lower === "meta" || lower === "cmd" || lower === "super") return "super";
  return key;
}

export const WORKER_IMAGE = process.env.TANGOW_WORKER_IMAGE ?? "tangow/worker:local";
export const WORKER_NETWORK = "tangow-workers";
export const WORKER_GUEST_ENTRY = "/opt/tangow/agent-run-worker.mjs";
/** The E2B worker profile (`apps/agent-run-worker/template/template.ts`), and #343's pids ceiling. */
export const WORKER_LIMITS = {
  Memory: 1024 ** 3,
  MemorySwap: 1024 ** 3,
  NanoCpus: 1e9,
  PidsLimit: 2048,
};

const WORKER_VOLUME_NAME = /^tangow-[A-Za-z0-9_-]{1,64}$/;

export interface WorkerMountSource {
  target: string;
  readOnly: boolean;
  /** A host path to bind, or a subpath of the named volume that holds `DATA_DIR`. */
  source: { bind: string } | { volume: string; subpath: string };
}

/**
 * The controller sends only volume names. Each is checked against `tangow-<id>` before it becomes
 * `DATA_DIR/volumes/<name>`, and each target must be a normalized path under /workspace. The
 * directories are the provider's to create: the supervisor never creates or deletes them.
 */
export function workerMounts(
  mounts: ReadonlyArray<{ volume: string; path: string; readOnly: boolean }>,
  dataDir: string,
  info: Docker.ContainerInspectInfo | undefined,
): WorkerMountSource[] {
  return mounts.map((mount) => {
    if (!WORKER_VOLUME_NAME.test(mount.volume)) throw new Error("invalid worker volume name");
    if (!mount.path.startsWith("/workspace/") || path.posix.normalize(mount.path) !== mount.path) {
      throw new Error("worker mounts must be normalized paths under /workspace");
    }
    const storage = computerHomeStorage(path.join(dataDir, "volumes", mount.volume), dataDir, info);
    return {
      target: mount.path,
      readOnly: mount.readOnly,
      source: storage.homeVolume
        ? { volume: storage.homeVolume.name, subpath: storage.homeVolume.subpath }
        : { bind: storage.homePath },
    };
  });
}

/**
 * A worker runs as the user its computer runs as, so both write the volumes they share. A user
 * other than 1000 has no passwd entry in the image, so `HOME` is set explicitly.
 */
export function workerCreateOptions(input: {
  attemptId: string;
  ttlSeconds: number;
  mounts: WorkerMountSource[];
  user: string;
}): Docker.ContainerCreateOptions {
  return {
    Image: WORKER_IMAGE,
    User: input.user,
    Env: ["HOME=/home/user"],
    Cmd: ["sleep", String(input.ttlSeconds)],
    Labels: {
      "tangow.managed": "true",
      "tangow.worker": "true",
      "tangow.attempt": input.attemptId,
    },
    WorkingDir: "/workspace",
    HostConfig: {
      Init: true,
      AutoRemove: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      ...WORKER_LIMITS,
      NetworkMode: WORKER_NETWORK,
      Mounts: input.mounts.map(dockerMount),
    },
  };
}
