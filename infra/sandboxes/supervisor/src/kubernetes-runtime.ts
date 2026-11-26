import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import type { V1Pod, V1Status } from "@kubernetes/client-node";
import { ApiException, CoreV1Api, Exec, KubeConfig } from "@kubernetes/client-node";
import { SANDBOX_SKILL_MOUNTS } from "@tangow/core";
import { getLogger } from "@tangow/logging";
import type {
  Computer,
  ComputerOwner,
  ComputerRuntime,
  ComputerSpec,
  ExecOptions,
  ExecResult,
  WorkerAttempt,
  WorkerGuest,
} from "./computer-runtime.js";
import {
  ComputerIdentityError,
  ComputerLimitError,
  ComputerNotFoundError,
} from "./computer-runtime.js";
import { SCREEN_READY_TIMEOUT_MS } from "./computer-session.js";
import {
  COMPUTER_CONTROL_PORT,
  COMPUTER_GID,
  COMPUTER_IMAGE,
  COMPUTER_UID,
  computerResourceLimits,
  computerVolumeHome,
  computerWorkspace,
  resolveSpaceComputerLimit,
  volumeHomeLabels,
  volumeHomeMatches,
  WORKER_GUEST_ENTRY,
  WORKER_IMAGE,
  WORKER_LIMITS,
  workerMounts,
} from "./computer-spec.js";
import { assertComputerHomeWritable } from "./home-ownership.js";
import { hasComputerIdentity } from "./supervisor-logic.js";

const CONTAINER = "computer";
/** Docker's stop timeout, so a stopping computer gets the same time to save its browsers. */
const STOP_GRACE_SECONDS = 10;
/** How long a deleted pod may take to disappear before its name can be used again. */
const DELETE_TIMEOUT_MS = 30_000;
const POLL_MS = 500;
const WORKER_CONTAINER = "worker";
/** Attempt ids are cuids (`schema.prisma`), which make a DNS label and pass the guest route as is. */
const ATTEMPT_ID = /^c[a-z0-9]{24}$/;
/** How much of a guest's stderr is kept for the log, as the Docker backend does. */
const GUEST_STDERR_TAIL_CHARS = 2048;
/** A computer's fixed requests: without them they default to the limits, which the quota refuses. */
const COMPUTER_REQUESTS = { memory: "2Gi", cpu: "1" };
const COMPUTER_REQUEST_BYTES = 2 * 1024 ** 3;
const COMPUTER_REQUEST_NANO_CPUS = 1e9;

/**
 * `pods/exec` has no cwd or env, and puts its command in the URL, which the API server and any proxy
 * may log. So one fixed script takes the cwd and the command as argv, and the env, secrets included,
 * from stdin: one entry per line, backslashes and newlines escaped for `printf %b`, then an empty
 * line. The rest of stdin is the command's.
 */
export const EXEC_ENVELOPE = [
  'cd "$1" && shift || exit',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell expansion, run by the pod's sh.
  'while IFS= read -r entry && [ -n "$entry" ]; do entry=$(printf "%bx" "$entry") && export "${entry%x}" || exit; done',
  'exec "$@"',
].join("\n");

export function execInEnvelope(cwd: string, argv: string[]) {
  return ["sh", "-c", EXEC_ENVELOPE, "sh", cwd, ...argv];
}

/** The env as the envelope reads it from stdin. */
export function envPreamble(env: string[]) {
  const lines = env.map((entry) => `${entry.replaceAll("\\", "\\\\").replaceAll("\n", "\\n")}\n`);
  return `${lines.join("")}\n`;
}

/**
 * The guest reads its capability from the first line of stdin, never from argv or the exec URL,
 * then gets the rest of stdin as its channel.
 */
export const GUEST_COMMAND = [
  "sh",
  "-c",
  'IFS= read -r TANGOW_WORKER_CAPABILITY && export TANGOW_WORKER_CAPABILITY && exec node "$1"',
  "sh",
  WORKER_GUEST_ENTRY,
];

const HARDENED_POD = {
  automountServiceAccountToken: false,
  // Services in the namespace would otherwise inject `<NAME>_PORT` variables into the pod, and one
  // of them has already broken a real computer by shadowing a variable it reads.
  enableServiceLinks: false,
  restartPolicy: "Never",
  securityContext: {
    runAsUser: COMPUTER_UID,
    runAsGroup: COMPUTER_GID,
    runAsNonRoot: true,
    seccompProfile: { type: "RuntimeDefault" },
  },
} as const;

const HARDENED_CONTAINER = {
  allowPrivilegeEscalation: false,
  capabilities: { drop: ["ALL"] },
};

export interface PodMount {
  mountPath: string;
  /** Under `DATA_DIR`, which the data claim holds. */
  subPath: string;
  readOnly: boolean;
}

/**
 * Identities are mixed case and of any length, while pod names and label values are short, and
 * names lowercase: both carry this hash instead, since folding the case could give two computers
 * one pod. The identity itself is kept in annotations.
 */
function identityHash(botId: string) {
  return createHash("sha256").update(botId).digest("hex").slice(0, 40);
}

export function computerPodName(botId: string) {
  return `tangow-bot-${identityHash(botId)}`;
}

/** A computer pod. The UID, the hardening and the requests are fixed; the rest comes from its spec. */
export function computerPod(input: {
  name: string;
  image: string;
  owner: ComputerOwner;
  controlToken: string;
  dataClaim: string;
  mounts: PodMount[];
  limits: Record<string, string>;
  workingDir: string;
  annotations: Record<string, string>;
}): V1Pod {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: input.name,
      labels: { "tangow.managed": "true", "tangow.bot": identityHash(input.owner.botId) },
      annotations: {
        ...input.annotations,
        "tangow.botId": input.owner.botId,
        "tangow.spaceId": input.owner.spaceId,
      },
    },
    spec: {
      ...HARDENED_POD,
      terminationGracePeriodSeconds: STOP_GRACE_SECONDS,
      containers: [
        {
          name: CONTAINER,
          image: input.image,
          // Images are imported on the node by digest; the backend never pulls or builds one.
          imagePullPolicy: "Never",
          tty: true,
          workingDir: input.workingDir,
          env: [
            { name: "DISPLAY", value: ":1" },
            { name: "HOME", value: "/home/tangow" },
            {
              name: "PATH",
              value:
                "/home/tangow/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            },
            { name: "NPM_CONFIG_PREFIX", value: "/home/tangow/.local" },
            { name: "PIP_USER", value: "1" },
            { name: "TANGOW_COMPUTER_CONTROL_TOKEN", value: input.controlToken },
          ],
          resources: {
            requests: COMPUTER_REQUESTS,
            limits: input.limits,
          },
          securityContext: HARDENED_CONTAINER,
          volumeMounts: [
            ...input.mounts.map((mount) => ({ name: "data", ...mount })),
            { name: "shm", mountPath: "/dev/shm" },
          ],
        },
      ],
      volumes: [
        { name: "data", persistentVolumeClaim: { claimName: input.dataClaim } },
        { name: "shm", emptyDir: { medium: "Memory", sizeLimit: "256Mi" } },
      ],
    },
  };
}

/**
 * A worker pod: `sleep` until its TTL, with the guest started in it by exec. The pause container
 * reaps the zombies, its exec's included, since the pod shares one process namespace.
 */
export function workerPod(input: {
  name: string;
  image: string;
  attemptId: string;
  ttlSeconds: number;
  dataClaim: string;
  mounts: PodMount[];
}): V1Pod {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: input.name,
      labels: {
        "tangow.managed": "true",
        "tangow.worker": "true",
        "tangow.attempt": input.attemptId,
      },
    },
    spec: {
      ...HARDENED_POD,
      shareProcessNamespace: true,
      containers: [
        {
          name: WORKER_CONTAINER,
          image: input.image,
          imagePullPolicy: "Never",
          command: ["sleep", String(input.ttlSeconds)],
          workingDir: "/workspace",
          env: [{ name: "HOME", value: "/home/user" }],
          resources: {
            requests: { memory: "512Mi", cpu: "250m" },
            limits: {
              memory: String(WORKER_LIMITS.Memory),
              cpu: `${WORKER_LIMITS.NanoCpus / 1e6}m`,
            },
          },
          securityContext: HARDENED_CONTAINER,
          volumeMounts: input.mounts.map((mount) => ({ name: "data", ...mount })),
        },
      ],
      volumes: [{ name: "data", persistentVolumeClaim: { claimName: input.dataClaim } }],
    },
  };
}

/** What the backend reads from the cluster, so a fake can stand in for it. */
export interface KubernetesClient {
  pods: Pick<CoreV1Api, "createNamespacedPod" | "readNamespacedPod" | "deleteNamespacedPod">;
  podExec: {
    exec(...args: Parameters<Exec["exec"]>): Promise<{
      close(): void;
      addEventListener(type: "close", listener: () => void): void;
    }>;
  };
  /** True once the computer's control service answers its token. */
  probeControl(control: { url: string; token: string }): Promise<boolean>;
}

function inClusterClient(): KubernetesClient {
  const config = new KubeConfig();
  config.loadFromCluster();
  return {
    pods: config.makeApiClient(CoreV1Api),
    podExec: new Exec(config),
    probeControl: async ({ url, token }) => {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ steps: [], observe: false }),
          signal: AbortSignal.timeout(1_500),
        });
        return response.ok;
      } catch {
        return false;
      }
    },
  };
}

function isNotFound(error: unknown) {
  return error instanceof ApiException && error.code === 404;
}

function isConflict(error: unknown) {
  return error instanceof ApiException && error.code === 409;
}

function hasExited(pod: V1Pod) {
  const phase = pod.status?.phase;
  return phase === "Succeeded" || phase === "Failed" || Boolean(pod.metadata?.deletionTimestamp);
}

function apiMessage(error: unknown) {
  if (!(error instanceof ApiException)) return error instanceof Error ? error.message : `${error}`;
  const body: unknown = error.body;
  if (typeof body !== "string" || !body) return `HTTP ${error.code}`;
  try {
    const status: unknown = JSON.parse(body);
    if (
      status &&
      typeof status === "object" &&
      "message" in status &&
      typeof status.message === "string" &&
      status.message
    ) {
      return status.message;
    }
  } catch {
    // The API can also return plain text.
  }
  return body;
}

/** Why a pod is not running yet: its container's waiting reason, or why it is not scheduled. */
function podReason(pod: V1Pod) {
  const state = pod.status?.containerStatuses?.[0]?.state;
  const container = state?.waiting ?? state?.terminated;
  const unscheduled = pod.status?.conditions?.find(
    (condition) => condition.type === "PodScheduled" && condition.status === "False",
  );
  const reason = container ?? unscheduled;
  if (!reason?.reason) return pod.status?.phase;
  return reason.message ? `${reason.reason}: ${reason.message}` : reason.reason;
}

function controlOf(pod: V1Pod) {
  const token = pod.spec?.containers[0]?.env?.find(
    (variable) => variable.name === "TANGOW_COMPUTER_CONTROL_TOKEN",
  )?.value;
  const address = pod.status?.podIP;
  if (!token || !address) return undefined;
  return { url: `http://${address}:${COMPUTER_CONTROL_PORT}/v1/desktop`, token };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The Kubernetes backend: a `tangow-bot-<id>` pod per computer, deleted on stop and created again
 * on resume, so a computer is running exactly while its pod is. A worker is a `tangowworker<attempt>`
 * pod, so a second ensure of the same attempt finds the first.
 */
export function createKubernetesComputerRuntime(options: {
  namespace: string;
  dataClaim: string;
  dataDir: string;
  client?: KubernetesClient;
}): ComputerRuntime {
  const { namespace, dataClaim, dataDir } = options;
  // The namespace's ResourceQuota bounds computers; a per-space count would need every pod listed.
  if (resolveSpaceComputerLimit() > 0) {
    throw new Error(
      "SANDBOX_MAX_COMPUTERS_PER_SPACE is not supported with SUPERVISOR_BACKEND=kubernetes: leave it at 0",
    );
  }
  // A limit below the fixed request would have every computer pod refused at create.
  const { Memory, NanoCpus } = computerResourceLimits();
  if (Memory && Memory < COMPUTER_REQUEST_BYTES) {
    throw new Error(
      `TANGOW_COMPUTER_MEMORY must be at least ${COMPUTER_REQUESTS.memory} with SUPERVISOR_BACKEND=kubernetes`,
    );
  }
  if (NanoCpus && NanoCpus < COMPUTER_REQUEST_NANO_CPUS) {
    throw new Error(
      `TANGOW_COMPUTER_CPUS must be at least ${COMPUTER_REQUESTS.cpu} with SUPERVISOR_BACKEND=kubernetes`,
    );
  }
  const limits = {
    ...(Memory ? { memory: String(Memory) } : {}),
    ...(NanoCpus ? { cpu: `${NanoCpus / 1e6}m` } : {}),
  };
  const { pods, podExec, probeControl } = options.client ?? inClusterClient();

  function podName(owner: ComputerOwner) {
    if (!owner.botId || !owner.spaceId) throw new Error("computer identity is empty");
    return computerPodName(owner.botId);
  }

  function podMounts(spec: ComputerSpec): PodMount[] {
    const under = (absolute: string) => path.relative(dataDir, absolute);
    const skills = spec.skillsBotId
      ? path.join("skills", "bot", spec.spaceId, spec.skillsBotId)
      : path.join("skills", "user", spec.spaceId, spec.userId);
    const volumes = spec.volumeHome
      ? computerVolumeHome(spec.volumeHome, dataDir, undefined).mounts.map((mount) => ({
          mountPath: mount.target,
          subPath: "bind" in mount.source ? under(mount.source.bind) : mount.source.subpath,
          readOnly: false,
        }))
      : [];
    return [
      { mountPath: "/home/tangow", subPath: under(spec.homePath), readOnly: false },
      { mountPath: SANDBOX_SKILL_MOUNTS.user, subPath: skills, readOnly: true },
      { mountPath: SANDBOX_SKILL_MOUNTS.managed, subPath: "managed-skills", readOnly: true },
      ...volumes,
    ];
  }

  async function readPod(name: string) {
    try {
      return await pods.readNamespacedPod({ name, namespace });
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error instanceof ApiException ? new Error(apiMessage(error)) : error;
    }
  }

  /** Deletes the pod and waits until its name is free, so a resume cannot hit a 409. */
  async function deletePod(name: string, gracePeriodSeconds: number, missing: () => void) {
    try {
      await pods.deleteNamespacedPod({ name, namespace, gracePeriodSeconds });
    } catch (error) {
      if (!isNotFound(error)) {
        throw error instanceof ApiException ? new Error(apiMessage(error)) : error;
      }
      missing();
    }
    const deadline = Date.now() + DELETE_TIMEOUT_MS;
    while (await readPod(name)) {
      if (Date.now() >= deadline) throw new Error(`pod ${name} is still terminating`);
      await delay(POLL_MS);
    }
  }

  function toComputer(pod: V1Pod): Computer {
    return {
      id: pod.metadata!.name!,
      running: pod.status?.phase === "Running" && !pod.metadata?.deletionTimestamp,
      image: pod.spec!.containers[0]!.image!,
      releaseRef: pod.spec!.containers[0]!.image!,
      matchesSpec: true,
      workspace: computerWorkspace(pod.metadata?.annotations),
      control: controlOf(pod),
    };
  }

  /**
   * Running, then for a computer answering on its control port, within the readiness delay. On
   * failure the pod is deleted, best effort: its deterministic name repairs it on the next call.
   */
  async function waitUntilReady(name: string, kind: "computer" | "worker") {
    const deadline = Date.now() + SCREEN_READY_TIMEOUT_MS;
    let reason: string | undefined;
    try {
      for (;;) {
        const pod = await readPod(name);
        if (!pod) throw new Error(`${kind} pod ${name} disappeared while starting`);
        const phase = pod.status?.phase;
        reason = podReason(pod) ?? reason;
        if (phase === "Failed" || phase === "Succeeded") {
          throw new Error(`${kind} pod ${name} exited while starting (${reason})`);
        }
        if (phase === "Running" && kind === "worker") return;
        const control = controlOf(pod);
        if (phase === "Running" && control) {
          if (await probeControl(control)) return;
          reason = "the control service did not answer";
        }
        if (Date.now() >= deadline) {
          throw new Error(`${kind} pod ${name} did not become ready in time (${reason})`);
        }
        await delay(POLL_MS);
      }
    } catch (error) {
      await pods
        .deleteNamespacedPod({ name, namespace, gracePeriodSeconds: 0 })
        .catch(() => undefined);
      throw error;
    }
  }

  async function getComputer(query: {
    id: string;
    owner: ComputerOwner;
    screenPort?: string;
  }): Promise<Computer>;
  async function getComputer(query: { spec: ComputerSpec }): Promise<Computer | undefined>;
  async function getComputer(
    query: { id: string; owner: ComputerOwner; screenPort?: string } | { spec: ComputerSpec },
  ): Promise<Computer | undefined> {
    if ("spec" in query) {
      const pod = await readPod(podName(query.spec));
      if (
        !pod ||
        !hasComputerIdentity(pod.metadata?.annotations, query.spec.botId, query.spec.spaceId)
      )
        return undefined;
      const mounted = (pod.spec?.containers[0]?.volumeMounts ?? [])
        .filter((mount) => mount.name === "data")
        .map((mount) => ({
          mountPath: mount.mountPath,
          subPath: mount.subPath ?? "",
          readOnly: Boolean(mount.readOnly),
        }));
      const volumeHome = query.spec.volumeHome
        ? computerVolumeHome(query.spec.volumeHome, dataDir, undefined)
        : undefined;
      return {
        ...toComputer(pod),
        // The digest covers the workspace root, which no mount shows.
        matchesSpec:
          JSON.stringify(mounted) === JSON.stringify(podMounts(query.spec)) &&
          volumeHomeMatches(pod.metadata?.annotations, volumeHome),
      };
    }
    const pod = await readPod(query.id);
    if (!pod) throw new ComputerNotFoundError(`computer ${query.id} not found`);
    if (
      pod.metadata?.labels?.["tangow.managed"] !== "true" ||
      !hasComputerIdentity(pod.metadata.annotations, query.owner.botId, query.owner.spaceId)
    )
      throw new ComputerIdentityError("computer identity mismatch");
    const computer = toComputer(pod);
    // Read on every call: a resumed computer is a new pod with a new address.
    if (query.screenPort && pod.status?.podIP) {
      computer.screen = { host: pod.status.podIP, port: query.screenPort };
    }
    return computer;
  }

  async function ensureComputer(
    spec: ComputerSpec,
    existing?: Pick<Computer, "id" | "running" | "releaseRef"> & { replace: boolean },
  ) {
    if (existing?.running && !existing.replace) {
      return { id: existing.id, releaseRef: existing.releaseRef, resumed: true };
    }
    const name = podName(spec);
    // The API creates the home; a missing one is an error, never created here.
    await assertComputerHomeWritable(spec.homePath, COMPUTER_UID, COMPUTER_GID);
    const volumeHome = spec.volumeHome
      ? computerVolumeHome(spec.volumeHome, dataDir, undefined)
      : undefined;
    if (existing) await deletePod(existing.id, 0, () => undefined);
    const body = computerPod({
      name,
      image: COMPUTER_IMAGE,
      owner: spec,
      controlToken: randomUUID(),
      dataClaim,
      mounts: podMounts(spec),
      limits,
      workingDir: volumeHome?.root ?? "/home/tangow",
      annotations: volumeHomeLabels(volumeHome),
    });
    try {
      await pods.createNamespacedPod({ namespace, body });
    } catch (error) {
      const detail = apiMessage(error);
      if (
        error instanceof ApiException &&
        error.code === 403 &&
        detail.includes("exceeded quota")
      ) {
        getLogger().warn("Kubernetes computer pod exceeded quota", { errorDetail: detail });
        throw new ComputerLimitError();
      }
      throw new Error(`computer pod was refused: ${detail}`);
    }
    await waitUntilReady(name, "computer");
    return { id: name, releaseRef: COMPUTER_IMAGE, resumed: false };
  }

  async function exec(id: string, argv: string[], options: ExecOptions): Promise<ExecResult> {
    const { signal } = options;
    signal?.throwIfAborted();
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const collect = (chunks: Buffer[]) =>
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          chunks.push(chunk);
          callback();
        },
      });
    // v5.channel.k8s.io carries the end of stdin, which the file write and the page helper need.
    const stdin = new PassThrough();
    stdin.write(envPreamble(options.env));
    let status: V1Status | undefined;
    const socket = await podExec
      .exec(
        namespace,
        id,
        CONTAINER,
        execInEnvelope(options.cwd, argv),
        collect(stdout),
        collect(stderr),
        stdin,
        false,
        (received) => {
          status = received;
        },
      )
      .catch((error: unknown) => {
        // A failed connect rejects with the socket's error, which may hold the exec URL: only the
        // API server's HTTP status is kept.
        const http = `${(error as { message?: unknown })?.message}`.match(/response: (\d{3})/);
        throw new Error(`computer command could not start${http ? ` (HTTP ${http[1]})` : ""}`);
      });
    if (options.stdin !== undefined) stdin.write(options.stdin);
    if (!signal) stdin.end();
    let onAbort: (() => void) | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("close", () => resolve());
        onAbort = () => {
          // Settle first: closing the socket may report `close` at once.
          reject(signal?.reason ?? new Error("command cancelled"));
          // The client sends stdin's v5 close frame on `end`; the socket closes after it.
          stdin.once("end", () => socket.close());
          stdin.end();
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
    } finally {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
    if (!status) throw new Error("computer command ended without a status");
    const exitCode = status.details?.causes?.find((cause) => cause.reason === "ExitCode")?.message;
    if (status.status !== "Success" && exitCode === undefined) {
      throw new Error(status.message || "computer command failed");
    }
    return {
      stdout: Buffer.concat(stdout).toString(),
      stderr: Buffer.concat(stderr).toString(),
      code: exitCode === undefined ? 0 : Number(exitCode),
    };
  }

  function workerName(attemptId: string) {
    if (!ATTEMPT_ID.test(attemptId)) throw new Error("worker attempt id must be a cuid");
    return `tangowworker${attemptId}`;
  }

  async function ensureWorker(attempt: WorkerAttempt) {
    const name = workerName(attempt.attemptId);
    const body = workerPod({
      name,
      image: WORKER_IMAGE,
      attemptId: attempt.attemptId,
      ttlSeconds: attempt.ttlSeconds,
      dataClaim,
      mounts: workerMounts(attempt.mounts, dataDir, undefined).map((mount) => ({
        mountPath: mount.target,
        subPath:
          "bind" in mount.source ? path.relative(dataDir, mount.source.bind) : mount.source.subpath,
        readOnly: mount.readOnly,
      })),
    });
    const create = () =>
      pods.createNamespacedPod({ namespace, body }).catch((error: unknown) => {
        if (isConflict(error)) return undefined;
        throw new Error(`worker pod was refused: ${apiMessage(error)}`);
      });
    // A conflict is the attempt's pod: a live one is the answer, an exited one is replaced.
    if (!(await create())) {
      const existing = await readPod(name);
      if (!existing || hasExited(existing)) {
        await deletePod(name, 0, () => undefined);
        if (!(await create())) throw new Error(`worker pod ${name} is being created elsewhere`);
      }
    }
    await waitUntilReady(name, "worker");
    return { id: name };
  }

  async function destroyWorker(attemptId: string) {
    let destroyed = true;
    // The controller frees the volumes' writer leases on this answer: it waits for the pod to go.
    await deletePod(workerName(attemptId), 0, () => {
      destroyed = false;
    });
    return { destroyed };
  }

  async function openGuest(id: string, capability: string): Promise<WorkerGuest | undefined> {
    const pod = await readPod(id);
    if (pod?.metadata?.labels?.["tangow.worker"] !== "true") return undefined;
    const attemptId = pod.metadata.labels["tangow.attempt"];
    const stdin = new PassThrough();
    stdin.write(`${capability}\n`);
    const stdout = new PassThrough();
    let stderr = "";
    const stderrTail = new Writable({
      write(chunk: Buffer, _encoding, done) {
        stderr = (stderr + chunk.toString("utf8")).slice(-GUEST_STDERR_TAIL_CHARS);
        done();
      },
    });
    let status: V1Status | undefined;
    const connection = await podExec.exec(
      namespace,
      id,
      WORKER_CONTAINER,
      GUEST_COMMAND,
      stdout,
      stderrTail,
      stdin,
      false,
      (received) => {
        status = received;
      },
    );
    connection.addEventListener("close", () => {
      if (!stdout.writableEnded) stdout.end();
      if (status?.status === "Success") return;
      getLogger().info("kubernetes worker guest exited with an error", {
        attemptId,
        errorText: status?.message ?? "the exec ended without a status",
        stderrTail: stderr,
      });
    });
    return {
      attach: (socket, head) => {
        if (head.length > 0) stdin.write(head);
        stdout.pipe(socket);
        // The end of the socket is the guest's EOF: v5 carries it as stdin's close.
        socket.pipe(stdin);
        socket.on("error", () => stdin.end());
        socket.on("close", () => stdin.end());
      },
      close: () => stdin.end(),
    };
  }

  return {
    release: async () => COMPUTER_IMAGE,
    getComputer,
    ensureComputer,
    stopComputer: (id) =>
      deletePod(id, STOP_GRACE_SECONDS, () => {
        throw new ComputerNotFoundError(`computer ${id} not found`);
      }),
    removeComputer: (id) => deletePod(id, 0, () => undefined),
    exec,
    workers: { ensure: ensureWorker, destroy: destroyWorker, openGuest },
  };
}
