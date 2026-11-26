import path from "node:path";
import type { Duplex } from "node:stream";
import { Writable } from "node:stream";
import { SANDBOX_SKILL_MOUNTS } from "@tangow/core";
import { getLogger } from "@tangow/logging";
import Docker from "dockerode";
import { ComputerNotFoundError } from "./computer-runtime.js";
import {
  COMPUTER_IMAGE,
  COMPUTER_USER,
  computerNetworkNameFor,
  computerNetworkNamesForCleanup,
  hostComputerUser,
  legacyNetworkOwnedSolelyBy,
  publishedLoopbackControlHostPort,
  resolveComputerControlEndpoint,
  resolveScreenNetworkMode,
} from "./computer-spec.js";
import { hasComputerIdentity } from "./supervisor-logic.js";

export function resolveDockerSocketPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
) {
  if (env.DOCKER_HOST) return undefined;
  return (
    env.DOCKER_SOCKET ?? (platform === "win32" ? "//./pipe/docker_engine" : "/var/run/docker.sock")
  );
}

const dockerSocketPath = resolveDockerSocketPath();
export const docker = dockerSocketPath
  ? new Docker({ socketPath: dockerSocketPath })
  : new Docker();
export const screenNetworkMode = resolveScreenNetworkMode(process.env.SANDBOX_SCREEN_NETWORK);
// Host-run supervisors on Docker Desktop (macOS/Windows) cannot reach container
// IPs, so computer control must use a published loopback port instead.
export const controlViaLoopback = process.env.SANDBOX_CONTROL_VIA_LOOPBACK === "true";
let supervisorInfo: Docker.ContainerInspectInfo | undefined;

/** Computers and workers write the same volumes, so both run as this user. */
export function sandboxUser(supervisorContainer: unknown): string {
  return supervisorContainer ? COMPUTER_USER : hostComputerUser();
}

/**
 * Skills mounts are derived from ids + dataDir, never from client paths (design Q10). A shared
 * bot's computer mounts the bot's copy, the same whoever runs it; any other the person's library.
 */
export function skillsBindsFor(
  dataDir: string,
  owner: { spaceId: string; userId: string; skillsBotId?: string },
  translate: (p: string) => string,
): string[] {
  const skills = owner.skillsBotId
    ? path.join(dataDir, "skills", "bot", owner.spaceId, owner.skillsBotId)
    : path.join(dataDir, "skills", "user", owner.spaceId, owner.userId);
  return [
    `${translate(skills)}:${SANDBOX_SKILL_MOUNTS.user}:ro`,
    `${translate(path.join(dataDir, "managed-skills"))}:${SANDBOX_SKILL_MOUNTS.managed}:ro`,
  ];
}

/** Docker's 404 means the computer is gone; the routes only know the neutral error. */
export function computerNotFound(error: unknown): never {
  if (error && typeof error === "object" && "statusCode" in error && error.statusCode === 404)
    throw new ComputerNotFoundError(error instanceof Error ? error.message : String(error));
  throw error;
}

export function isTangowContainer(
  info: Docker.ContainerInspectInfo,
  botId: string,
  spaceId: string,
) {
  const labels = info.Config.Labels ?? {};
  const managed = labels["tangow.managed"] === "true" || info.Config.Image === COMPUTER_IMAGE;
  return managed && hasComputerIdentity(labels, botId, spaceId);
}

export function computerControlEndpoint(info: Docker.ContainerInspectInfo) {
  const token = info.Config.Env?.find((value) =>
    value.startsWith("TANGOW_COMPUTER_CONTROL_TOKEN="),
  )?.slice("TANGOW_COMPUTER_CONTROL_TOKEN=".length);
  const publishedHostPort = controlViaLoopback
    ? publishedLoopbackControlHostPort(info.NetworkSettings?.Ports)
    : undefined;
  return resolveComputerControlEndpoint({
    token,
    networkMode: info.HostConfig.NetworkMode,
    networks: info.NetworkSettings?.Networks,
    publishedHostPort,
    requirePublishedHostPort: controlViaLoopback,
  });
}

// Each bot's computer gets its own Docker network so containers cannot reach
// one another (Docker's default "bridge" network allows any container to
// dial any other container's exposed ports, which would let one bot's
// computer reach another bot's desktop/VNC endpoint with no authentication).
export function computerNetworkName(botId: string, info: Docker.ContainerInspectInfo | undefined) {
  if (screenNetworkMode === "internal") {
    // The supervisor itself runs in this shared network in that topology and
    // needs to address child containers by their in-network IP, so children
    // stay on the supervisor's network rather than an isolated one.
    return info ? Object.keys(info.NetworkSettings.Networks)[0] : undefined;
  }
  if (screenNetworkMode === "isolated" && !info) {
    throw new Error("isolated Compose screens require a containerized supervisor");
  }
  return computerNetworkNameFor(botId);
}

export async function connectComposeScreenPeers(
  networkName: string,
  info: Docker.ContainerInspectInfo,
) {
  const peerIds = new Set([info.Id]);
  const project = info.Config.Labels?.["com.docker.compose.project"];
  if (project) {
    const webContainers = await docker.listContainers({
      all: true,
      filters: {
        label: [`com.docker.compose.project=${project}`, "com.docker.compose.service=web"],
      },
    });
    for (const container of webContainers) peerIds.add(container.Id);
  }
  const network = docker.getNetwork(networkName);
  const networkInfo = await network.inspect();
  const connectedIds = new Set(Object.keys(networkInfo.Containers ?? {}));
  await Promise.all(
    [...peerIds]
      .filter((containerId) => !connectedIds.has(containerId))
      .map((containerId) =>
        network.connect({ Container: containerId }).catch((error) => {
          if (!/already exists|already connected/i.test(String(error))) throw error;
        }),
      ),
  );
}

export async function ensureBotNetwork(botId: string) {
  const name = computerNetworkNameFor(botId);
  return docker
    .createNetwork({ Name: name, Driver: "bridge", CheckDuplicate: true })
    .catch((error) => {
      // Existing networks and concurrent provision requests are both safe.
      if (!/already exists/i.test(String(error))) throw error;
    });
}

export async function removeBotNetwork(botId: string) {
  const currentName = computerNetworkNameFor(botId);
  for (const name of computerNetworkNamesForCleanup(botId)) {
    const network = docker.getNetwork(name);
    const info = await network.inspect().catch(() => undefined);
    if (!info) continue;
    const containerIds = Object.keys(info.Containers ?? {});
    if (name !== currentName) {
      const owners: Array<string | undefined> = [];
      for (const containerId of containerIds) {
        const labels =
          (
            await docker
              .getContainer(containerId)
              .inspect()
              .catch(() => undefined)
          )?.Config.Labels ?? {};
        const owner = labels["tangow.botId"];
        owners.push(owner);
        if (owner === botId) {
          await network.disconnect({ Container: containerId, Force: true }).catch(() => undefined);
        }
      }
      if (!legacyNetworkOwnedSolelyBy(botId, owners)) continue;
    }
    const remaining = await network.inspect().catch(() => undefined);
    for (const containerId of Object.keys(remaining?.Containers ?? {})) {
      await network.disconnect({ Container: containerId, Force: true }).catch(() => undefined);
    }
    await network.remove().catch(() => undefined);
  }
}

export async function inspectSupervisorContainer() {
  if (supervisorInfo || !process.env.HOSTNAME) return supervisorInfo;
  try {
    supervisorInfo = await docker.getContainer(process.env.HOSTNAME).inspect();
    return supervisorInfo;
  } catch {
    return undefined;
  }
}

/** How much of a guest's stderr is kept for the log, as `e2b-worker.ts` does. */
const GUEST_STDERR_TAIL_CHARS = 2048;

/**
 * Pipes the socket into the exec's stdin and its demuxed stdout back. Stderr is kept as a tail and
 * logged with the exit code when the guest fails.
 */
export function relayWorkerGuest(input: {
  socket: Duplex;
  stream: Duplex;
  attemptId: string | undefined;
  exitCode: () => Promise<number | null>;
}) {
  const { socket, stream } = input;
  let stderr = "";
  const stderrTail = new Writable({
    write: (chunk: Buffer, _encoding, done) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-GUEST_STDERR_TAIL_CHARS);
      done();
    },
  });
  docker.modem.demuxStream(stream, socket, stderrTail);
  socket.pipe(stream);
  stream.on("end", () => {
    socket.end();
    input.exitCode().then(
      (exitCode) => {
        if (exitCode === 0) return;
        getLogger().info("docker worker guest exited with an error", {
          attemptId: input.attemptId,
          exitCode,
          stderrTail: stderr,
        });
      },
      (error: unknown) => {
        getLogger().info("docker worker guest exit code unavailable", {
          attemptId: input.attemptId,
          errorText: error instanceof Error ? error.message : String(error),
          stderrTail: stderr,
        });
      },
    );
  });
  stream.on("error", () => socket.destroy());
  socket.on("error", () => stream.destroy());
  socket.on("close", () => stream.end());
}

/** The exec's stream can end a moment before Docker records the exit. */
export async function guestExitCode(exec: Docker.Exec): Promise<number | null> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const state = await exec.inspect();
    if (!state.Running) return state.ExitCode;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}
