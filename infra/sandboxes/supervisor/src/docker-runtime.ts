import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type Docker from "dockerode";
import type {
  Computer,
  ComputerRuntime,
  ComputerSpec,
  ExecOptions,
  ExecResult,
  WorkerAttempt,
  WorkerGuest,
} from "./computer-runtime.js";
import { ComputerIdentityError, ComputerLimitError } from "./computer-runtime.js";
import {
  assertVolumeSubpathSupport,
  COMPUTER_GID,
  COMPUTER_IMAGE,
  COMPUTER_UID,
  COMPUTER_USER,
  computerHomeStorage,
  computerVolumeHome,
  computerWorkspace,
  containerCreateOptions,
  containerNameFor,
  controlPortPublicationMatches,
  homeVolumeMatches,
  resolveScreenPublishTarget,
  resolveSpaceComputerLimit,
  SCREEN_HOST,
  volumeHomeMatches,
  WORKER_GUEST_ENTRY,
  WORKER_NETWORK,
  workerCreateOptions,
  workerMounts,
} from "./computer-spec.js";
import {
  computerControlEndpoint,
  computerNetworkName,
  computerNotFound,
  connectComposeScreenPeers,
  controlViaLoopback,
  docker,
  ensureBotNetwork,
  guestExitCode,
  inspectSupervisorContainer,
  isTangowContainer,
  relayWorkerGuest,
  removeBotNetwork,
  sandboxUser,
  screenNetworkMode,
  skillsBindsFor,
} from "./docker-engine.js";
import { assertComputerHomeWritable } from "./home-ownership.js";
import { demuxDockerStream } from "./supervisor-logic.js";

let imageReady: Promise<void> | undefined;

/** The Docker backend: one container per computer and per worker, on per-bot networks. */
export function createDockerComputerRuntime(options: {
  dataDir: string;
  computerContext: string;
}): ComputerRuntime {
  const { dataDir, computerContext } = options;
  /** Both the lookup and the create of one provision request derive the same container settings. */
  const prepared = new WeakMap<ComputerSpec, Promise<Awaited<ReturnType<typeof prepare>>>>();

  async function prepare(spec: ComputerSpec) {
    const runtimeInfo = await inspectSupervisorContainer();
    const networkMode = computerNetworkName(spec.botId, runtimeInfo);
    const hostUid = process.getuid?.();
    const hostGid = process.getgid?.();
    // The API normally creates the home. A non-root standalone supervisor may
    // do so as the same user, but a root supervisor must never create or chown
    // user-controlled paths at runtime; Compose data-init handles legacy data.
    if (hostUid !== 0) await mkdir(spec.homePath, { recursive: true });
    const storage = computerHomeStorage(spec.homePath, dataDir, runtimeInfo);
    // The volume directories are the provider's: the supervisor never creates or deletes them.
    const volumeHome = spec.volumeHome
      ? computerVolumeHome(spec.volumeHome, dataDir, runtimeInfo)
      : undefined;
    if (storage.homeVolume) {
      assertVolumeSubpathSupport((await docker.version()).ApiVersion);
    }
    const computerUser = sandboxUser(runtimeInfo);
    // Bind sources are created by the worker before provision; a root supervisor never mkdirs them.
    const skillsBinds = skillsBindsFor(dataDir, spec, (p) => hostHomePath(p, runtimeInfo));
    return {
      runtimeInfo,
      networkMode,
      hostUid,
      hostGid,
      storage,
      volumeHome,
      computerUser,
      skillsBinds,
    };
  }

  function preparedFor(spec: ComputerSpec) {
    let settings = prepared.get(spec);
    if (!settings) {
      settings = prepare(spec);
      prepared.set(spec, settings);
    }
    return settings;
  }

  async function ensureComputerImage() {
    if (!imageReady) {
      imageReady = (async () => {
        try {
          await docker.getImage(COMPUTER_IMAGE).inspect();
          return;
        } catch {
          // build below
        }
        const dockerfile = path.join(computerContext, "Dockerfile");
        if (!existsSync(dockerfile)) {
          throw new Error(
            `Missing ${COMPUTER_IMAGE}. Build it with: docker build -t ${COMPUTER_IMAGE} infra/sandboxes/computer`,
          );
        }
        const stream = await docker.buildImage(
          {
            context: computerContext,
            src: [
              "Dockerfile",
              "start.sh",
              "control.py",
              "xcapture.c",
              "tangow-browser",
              "tangow-page-browser",
              "tangow-terminal",
              "terminalrc",
              "zshrc",
              "tangow-browser.desktop",
              "fluxbox.init",
              "fluxbox.apps",
              "fluxbox.menu",
              "libreoffice.xcd",
            ],
          },
          { t: COMPUTER_IMAGE },
        );
        await new Promise<void>((resolve, reject) => {
          docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve()));
        });
        await docker.getImage(COMPUTER_IMAGE).inspect();
      })();
    }
    await imageReady;
  }

  // computerHomeStorage covers the bot home; skills binds still need the same
  // service-path -> host-path translation for the data dir bind mount.
  function hostHomePath(serviceHomePath: string, info: Docker.ContainerInspectInfo | undefined) {
    const dataMount = info?.Mounts.find((mount) => mount.Destination === dataDir);
    if (!dataMount?.Source) return serviceHomePath;
    return path.join(dataMount.Source, path.relative(dataDir, serviceHomePath));
  }

  /** Reads the screen's address, waiting a moment for Docker to publish its port. */
  async function screenTarget(
    container: Docker.Container,
    initialInfo: Docker.ContainerInspectInfo,
    containerPort: string,
  ) {
    for (let i = 0; i < 30; i += 1) {
      const info = i === 0 ? initialInfo : await container.inspect();
      if (screenNetworkMode === "isolated") {
        const runtime = await inspectSupervisorContainer();
        const networkName = info.HostConfig.NetworkMode;
        if (runtime && networkName) await connectComposeScreenPeers(networkName, runtime);
      }
      const target = resolveScreenPublishTarget({
        screenNetwork: screenNetworkMode,
        networkMode: info.HostConfig.NetworkMode,
        networks: info.NetworkSettings?.Networks,
        hostPort: info.NetworkSettings?.Ports?.[`${containerPort}/tcp`]?.[0]?.HostPort,
        containerPort,
        screenHost: SCREEN_HOST,
      });
      if (target) return target;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("computer screen port was not published");
  }

  function toComputer(id: string, info: Docker.ContainerInspectInfo): Computer {
    // Older inspect answers may lack sections a given route never read.
    return {
      id,
      running: Boolean(info.State?.Running),
      image: info.Config?.Image,
      releaseRef: info.Image,
      matchesSpec: true,
      workspace: computerWorkspace(info.Config?.Labels),
      control: info.HostConfig ? computerControlEndpoint(info) : undefined,
    };
  }

  async function getComputer(query: {
    id: string;
    owner: { botId: string; spaceId: string };
    screenPort?: string;
  }): Promise<Computer>;
  async function getComputer(query: { spec: ComputerSpec }): Promise<Computer | undefined>;
  async function getComputer(
    query:
      | { id: string; owner: { botId: string; spaceId: string }; screenPort?: string }
      | { spec: ComputerSpec },
  ): Promise<Computer | undefined> {
    if ("spec" in query) {
      const { spec } = query;
      await ensureComputerImage();
      const settings = await preparedFor(spec);
      const existing = await findBotContainer(spec.botId, spec.spaceId);
      if (!existing) return undefined;
      const info = await existing.inspect();
      const { networkMode, computerUser, skillsBinds, storage, volumeHome } = settings;
      return {
        ...toComputer(existing.id, info),
        matchesSpec:
          (!networkMode || info.HostConfig.NetworkMode === networkMode) &&
          info.Config.User === computerUser &&
          skillsBinds.every((bind) => info.HostConfig.Binds?.includes(bind)) &&
          controlPortPublicationMatches(info.HostConfig.PortBindings, controlViaLoopback) &&
          (!storage.homeVolume || homeVolumeMatches(info.HostConfig.Mounts, storage.homeVolume)) &&
          volumeHomeMatches(info.Config.Labels, volumeHome),
      };
    }
    const container = docker.getContainer(query.id);
    const info = await container.inspect().catch(computerNotFound);
    if (!isTangowContainer(info, query.owner.botId, query.owner.spaceId))
      throw new ComputerIdentityError("computer identity mismatch");
    const computer = toComputer(query.id, info);
    if (query.screenPort) computer.screen = await screenTarget(container, info, query.screenPort);
    return computer;
  }

  async function ensureComputer(
    spec: ComputerSpec,
    existing?: Pick<Computer, "id" | "running" | "releaseRef"> & { replace: boolean },
  ) {
    if (existing && !existing.replace) {
      if (!existing.running) await docker.getContainer(existing.id).start();
      return { id: existing.id, releaseRef: existing.releaseRef, resumed: true };
    }
    const settings = await preparedFor(spec);
    const spaceComputerLimit = resolveSpaceComputerLimit();
    if (!existing && spaceComputerLimit > 0) {
      const currentCount = await countSpaceContainers(spec.spaceId);
      if (currentCount >= spaceComputerLimit) throw new ComputerLimitError(spaceComputerLimit);
    }
    const { runtimeInfo, hostUid, hostGid } = settings;
    // Existing containers with the current image already use the selected user.
    // Before replacing or creating a container, validate its home without
    // privileged filesystem mutations that could escape via concurrent renames.
    // Match hostComputerUser(): missing/root host identity falls back to 1000:1000.
    const effectiveUid =
      runtimeInfo || hostUid === undefined || hostGid === undefined || hostUid === 0
        ? COMPUTER_UID
        : hostUid;
    const effectiveGid =
      runtimeInfo || hostUid === undefined || hostGid === undefined || hostUid === 0
        ? COMPUTER_GID
        : hostGid;
    await assertComputerHomeWritable(spec.homePath, effectiveUid, effectiveGid);
    const name = containerNameFor(spec.botId);
    const createdNetwork =
      screenNetworkMode === "internal" ? undefined : await ensureBotNetwork(spec.botId);
    let container: Docker.Container | undefined;
    try {
      if (existing) {
        await docker
          .getContainer(existing.id)
          .remove({ force: true })
          .catch(() => undefined);
      }
      container = await docker.createContainer(
        containerCreateOptions({
          name,
          image: COMPUTER_IMAGE,
          botId: spec.botId,
          spaceId: spec.spaceId,
          ...settings.storage,
          volumeHome: settings.volumeHome,
          user: settings.computerUser,
          networkMode: settings.networkMode,
          controlToken: randomUUID(),
          skillsBinds: settings.skillsBinds,
          publishControlPort: controlViaLoopback,
        }),
      );
      await container.start();
    } catch (error) {
      // Never force removal: a lost start response may hide a running computer.
      // Docker also refuses network removal while any endpoint is attached.
      await container?.remove().catch(() => undefined);
      await createdNetwork?.remove().catch(() => undefined);
      throw error;
    }
    return { id: container.id, releaseRef: (await container.inspect()).Image, resumed: false };
  }

  async function findBotContainer(botId: string, spaceId: string) {
    const listed = await docker.listContainers({
      all: true,
      filters: {
        // Space IDs were preserved when workspaces became Spaces. Search by the
        // stable bot label, then validate either generation of the Space label.
        label: [`tangow.botId=${botId}`],
      },
    });
    for (const item of listed) {
      const container = docker.getContainer(item.Id);
      const info = await container.inspect();
      if (isTangowContainer(info, botId, spaceId)) return container;
    }
    return undefined;
  }

  /** Count managed computers for a space, including legacy workspaceId / unlabeled-managed. */
  async function countSpaceContainers(spaceId: string): Promise<number> {
    // Do not filter by tangow.managed=true: legacy computers are still managed via
    // COMPUTER_IMAGE + tangow.workspaceId (same rule as isTangowContainer).
    const listed = await docker.listContainers({ all: true });
    let count = 0;
    for (const item of listed) {
      if (await isManagedSpaceContainer(item, spaceId)) count++;
    }
    return count;
  }

  async function isManagedSpaceContainer(
    item: Docker.ContainerInfo,
    spaceId: string,
  ): Promise<boolean> {
    const labels = item.Labels;
    if (labels) {
      const listedSpaceId = labels["tangow.spaceId"] ?? labels["tangow.workspaceId"];
      // Labeled for another space (or no space identity) cannot count toward this cap.
      if (listedSpaceId !== spaceId) return false;
      if (labels["tangow.managed"] === "true" || item.Image === COMPUTER_IMAGE) return true;
      // Space matches but Image may be an ID after the tag moved — confirm via inspect.
    }
    // Missing list Labels: inspect with the same managed rule as isTangowContainer.
    try {
      const info = await docker.getContainer(item.Id).inspect();
      const infoLabels = info.Config?.Labels ?? {};
      const managed =
        infoLabels["tangow.managed"] === "true" || info.Config?.Image === COMPUTER_IMAGE;
      const infoSpaceId = infoLabels["tangow.spaceId"] ?? infoLabels["tangow.workspaceId"];
      return managed && infoSpaceId === spaceId;
    } catch {
      // Container might have been removed concurrently
      return false;
    }
  }

  async function exec(id: string, argv: string[], options: ExecOptions): Promise<ExecResult> {
    const { signal, stdin } = options;
    signal?.throwIfAborted();
    const attachStdin = stdin !== undefined || Boolean(signal);
    const command = await docker
      .getContainer(id)
      .exec({
        Cmd: argv,
        AttachStdout: true,
        AttachStderr: true,
        ...(attachStdin ? { AttachStdin: true } : {}),
        WorkingDir: options.cwd,
        Env: options.env,
      })
      .catch(computerNotFound);
    signal?.throwIfAborted();
    const stream = await command.start({ hijack: true, stdin: attachStdin });
    const chunks: Buffer[] = [];
    let onAbort: (() => void) | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        stream.on("data", (data: Buffer) => chunks.push(data));
        stream.on("end", resolve);
        stream.on("error", reject);
        if (stdin !== undefined) {
          if (signal) stream.write(stdin);
          else stream.end(stdin);
        }
        onAbort = () => {
          // The page helper watches stdin EOF and exits even inside a blocked CDP call.
          stream.destroy();
          reject(signal?.reason ?? new Error("command cancelled"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
    } finally {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
    const inspect = await command.inspect();
    return { ...demuxDockerStream(Buffer.concat(chunks)), code: inspect.ExitCode ?? 0 };
  }

  const attemptWorkers = (attemptId: string) =>
    docker.listContainers({
      all: true,
      filters: { label: ["tangow.worker=true", `tangow.attempt=${attemptId}`] },
    });

  let workersNetwork: Promise<unknown> | undefined;
  /** Workers share one bridge, off the Compose network, where they cannot reach each other. */
  function ensureWorkersNetwork() {
    workersNetwork ??= docker
      .createNetwork({
        Name: WORKER_NETWORK,
        Driver: "bridge",
        CheckDuplicate: true,
        Labels: { "tangow.managed": "true" },
        Options: { "com.docker.network.bridge.enable_icc": "false" },
      })
      .catch((error) => {
        if (!/already exists/i.test(String(error))) {
          workersNetwork = undefined;
          throw error;
        }
      });
    return workersNetwork;
  }

  async function ensureWorker(attempt: WorkerAttempt) {
    const runtimeInfo = await inspectSupervisorContainer();
    const mounts = workerMounts(attempt.mounts, dataDir, runtimeInfo);
    const [existing] = await attemptWorkers(attempt.attemptId);
    if (existing) return { id: existing.Id };
    await ensureWorkersNetwork();
    const container = await docker.createContainer(
      workerCreateOptions({
        attemptId: attempt.attemptId,
        ttlSeconds: attempt.ttlSeconds,
        mounts,
        user: sandboxUser(runtimeInfo),
      }),
    );
    await container.start();
    return { id: container.id };
  }

  async function destroyWorker(attemptId: string) {
    const found = await attemptWorkers(attemptId);
    await Promise.all(
      found.map((info) =>
        docker
          .getContainer(info.Id)
          .remove({ force: true })
          .catch((error: unknown) => {
            if ((error as { statusCode?: number }).statusCode !== 404) throw error;
          }),
      ),
    );
    // The controller frees the volumes' writer leases on this answer: confirm nothing is left.
    if ((await attemptWorkers(attemptId)).length > 0) throw new Error("worker still present");
    return { destroyed: found.length > 0 };
  }

  async function openGuest(id: string, capability: string): Promise<WorkerGuest | undefined> {
    const container = docker.getContainer(id);
    const info = await container.inspect();
    if (info.Config.Labels?.["tangow.worker"] !== "true") return undefined;
    const guest = await container.exec({
      Cmd: ["node", WORKER_GUEST_ENTRY],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      User: info.Config.User || COMPUTER_USER,
      WorkingDir: "/workspace",
      Env: [`TANGOW_WORKER_CAPABILITY=${capability}`],
    });
    const stream = await guest.start({ hijack: true, stdin: true });
    return {
      attach: (socket, head) => {
        if (head.length > 0) stream.write(head);
        relayWorkerGuest({
          socket,
          stream,
          attemptId: info.Config.Labels?.["tangow.attempt"],
          exitCode: () => guestExitCode(guest),
        });
      },
      close: () => stream.end(),
    };
  }

  return {
    release: async () => (await docker.getImage(COMPUTER_IMAGE).inspect()).Id,
    getComputer,
    ensureComputer,
    stopComputer: async (id) => {
      await docker.getContainer(id).stop().catch(computerNotFound);
    },
    removeComputer: async (id, botId) => {
      await docker
        .getContainer(id)
        .remove({ force: true })
        .catch(() => undefined);
      if (screenNetworkMode !== "internal") await removeBotNetwork(botId);
    },
    exec,
    workers: { ensure: ensureWorker, destroy: destroyWorker, openGuest },
  };
}
