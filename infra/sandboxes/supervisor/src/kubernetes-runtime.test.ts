import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { duplexPair } from "node:stream";
import type { V1Pod, V1Status } from "@kubernetes/client-node";
import { ApiException, Exec, KubeConfig } from "@kubernetes/client-node";
import { resolveSupervisorToken } from "@tangow/core";
import { createLogger, createTestSink, getLogger, installLogger } from "@tangow/logging";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  const tmp = (process.env.TMPDIR ?? "/tmp").replace(/\/+$/, "");
  process.env.DATA_DIR = `${tmp}/tangow-kubernetes-runtime-${process.pid}-${Date.now()}`;
  delete process.env.SANDBOX_MAX_COMPUTERS_PER_SPACE;
});

import { resolveSupervisorBackend } from "./computer-spec.js";
import { createSupervisor } from "./index.js";
import type { KubernetesClient } from "./kubernetes-runtime.js";
import {
  computerPod,
  computerPodName,
  createKubernetesComputerRuntime,
  workerPod,
} from "./kubernetes-runtime.js";

const dataDir = process.env.DATA_DIR!;
const token = resolveSupervisorToken(process.env);
/**
 * Team computers, shaped like `team-<spaceId>-<userId>`: a UUID space and a mixed-case user id,
 * 74 characters here, which neither a pod name nor a label value can hold.
 */
const spaceId = "3f2b8c1e-9d4a-4e7b-a6c5-0f1e2d3c4b5a";
const owner = { botId: `team-${spaceId}-Xk9QwErTyUiOpAsDfGhJkLzXcVbNmQ12`, spaceId };
const shortOwner = { botId: "team-cSpace7-QwErTyU", spaceId: "cSpace7" };
const headersOf = (who: typeof owner) => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
  "x-tangow-bot-id": who.botId,
  "x-tangow-space-id": who.spaceId,
});
const pod = computerPodName(owner.botId);
const headers = headersOf(owner);
/** What the API accepts as a label value. */
const LABEL_VALUE = /^(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?$/;

interface ExecCall {
  pod: string;
  command: string[];
  stdin: Buffer;
  stdinEnded: boolean;
}

function podApiError(code: number, reason: string, message: string) {
  return new ApiException(
    code,
    reason,
    JSON.stringify({ kind: "Status", apiVersion: "v1", status: "Failure", message, reason, code }),
    {},
  );
}

/** The few pod calls the backend makes, kept in memory, plus exec and the control probe. */
function fakeCluster() {
  const pods = new Map<string, V1Pod>();
  const state = {
    quotaExceeded: false,
    /** What a pending pod becomes on its next read. */
    boot: "running" as "running" | "image-missing",
    nextIp: 1,
    deletes: [] as Array<{ name: string; grace: number | undefined }>,
    execs: [] as ExecCall[],
    exitCode: 0,
  };
  const notFound = (name: string) => podApiError(404, "NotFound", `pods "${name}" not found`);
  const client: KubernetesClient = {
    pods: {
      createNamespacedPod: async ({ body }) => {
        const name = body.metadata!.name!;
        if (state.quotaExceeded) {
          throw podApiError(
            403,
            "Forbidden",
            `pods "${name}" is forbidden: exceeded quota: sandboxes`,
          );
        }
        // The API refuses a name that is not a DNS label.
        if (!/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/.test(name)) {
          throw podApiError(422, "Invalid", "invalid name");
        }
        // And a label value longer than 63 characters or with other characters.
        for (const value of Object.values(body.metadata!.labels ?? {})) {
          if (value.length > 63 || !LABEL_VALUE.test(value)) {
            throw podApiError(422, "Invalid", "invalid label");
          }
        }
        if (pods.has(name))
          throw podApiError(409, "AlreadyExists", `pods "${name}" already exists`);
        pods.set(name, { ...structuredClone(body), status: { phase: "Pending" } });
        return structuredClone(pods.get(name)!);
      },
      readNamespacedPod: async ({ name }) => {
        // A deleted pod terminates until its grace period is over, then it is gone.
        const deadline = pods.get(name)?.metadata?.deletionTimestamp;
        if (deadline && Date.now() >= deadline.getTime()) pods.delete(name);
        const pod = pods.get(name);
        if (!pod) throw notFound(name);
        if (pod.status!.phase === "Pending" && state.boot === "running") {
          pod.status = { phase: "Running", podIP: `10.42.0.${state.nextIp++}` };
        } else if (pod.status!.phase === "Pending") {
          pod.status = {
            phase: "Pending",
            containerStatuses: [
              {
                name: "computer",
                image: pod.spec!.containers[0]!.image!,
                imageID: "",
                ready: false,
                restartCount: 0,
                state: {
                  waiting: { reason: "ErrImageNeverPull", message: "image is not present" },
                },
              },
            ],
          };
        }
        return structuredClone(pod);
      },
      deleteNamespacedPod: async ({ name, gracePeriodSeconds }) => {
        const pod = pods.get(name);
        if (!pod) throw notFound(name);
        state.deletes.push({ name, grace: gracePeriodSeconds });
        // A second delete may shorten the grace period, never extend it.
        const deadline = Date.now() + (gracePeriodSeconds ?? 30) * 1000;
        const current = pod.metadata!.deletionTimestamp?.getTime() ?? Number.POSITIVE_INFINITY;
        pod.metadata!.deletionTimestamp = new Date(Math.min(deadline, current));
        return structuredClone(pod);
      },
    },
    podExec: {
      exec: async (
        _namespace,
        pod,
        _container,
        command,
        stdout,
        _stderr,
        stdin,
        _tty,
        onStatus,
      ) => {
        if (!pods.has(pod)) throw new Error(`pods "${pod}" not found`);
        const call: ExecCall = {
          pod,
          command: command as string[],
          stdin: Buffer.alloc(0),
          stdinEnded: false,
        };
        state.execs.push(call);
        const socket = new EventTarget() as EventTarget & { close(): void };
        socket.close = () => socket.dispatchEvent(new Event("close"));
        const finish = () => {
          stdout?.end("done");
          const status: V1Status =
            state.exitCode === 0
              ? { status: "Success" }
              : {
                  status: "Failure",
                  reason: "NonZeroExitCode",
                  details: { causes: [{ reason: "ExitCode", message: String(state.exitCode) }] },
                };
          onStatus?.(status);
          socket.close();
        };
        if (stdin) {
          (stdin as Readable).on("data", (chunk: Buffer) => {
            call.stdin = Buffer.concat([call.stdin, chunk]);
          });
          (stdin as Readable).on("end", () => {
            call.stdinEnded = true;
            finish();
          });
        } else setImmediate(finish);
        return socket;
      },
    },
    probeControl: async () => true,
  };
  return { client, pods, state };
}

function kubernetes(cluster = fakeCluster(), who = owner) {
  const runtime = createKubernetesComputerRuntime({
    namespace: "sandboxes",
    dataClaim: "data",
    dataDir,
    client: cluster.client,
  });
  const { app } = createSupervisor(runtime);
  const startRequest = (spec: object = {}) =>
    app.request("/computers", {
      method: "POST",
      headers: headersOf(who),
      body: JSON.stringify({
        ...who,
        userId: "user1",
        homePath: `${dataDir}/homes/${who.botId}`,
        ...spec,
      }),
    });
  const provision = (spec?: object) => settle(startRequest(spec));
  return { ...cluster, runtime, app, startRequest, provision };
}

/** Lets the backend's waits run on fake time. */
async function settle<T>(request: T | Promise<T>) {
  const pending = Promise.resolve(request);
  let done = false;
  void pending.finally(() => {
    done = true;
  });
  while (!done) await vi.advanceTimersByTimeAsync(500);
  return pending;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
  rmSync(dataDir, { recursive: true, force: true });
  for (const who of [owner, shortOwner]) {
    mkdirSync(`${dataDir}/homes/${who.botId}`, { recursive: true });
    // The home is checked for the computer's user, 1000, which is not the test runner.
    chmodSync(`${dataDir}/homes/${who.botId}`, 0o777);
  }
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("computer pod", () => {
  it("is hardened, mounts the data claim by subPath, and declares fixed requests", () => {
    expect(
      computerPod({
        name: computerPodName("bot1"),
        image: "tangow/computer@sha256:abc",
        owner: { botId: "bot1", spaceId: "space1" },
        controlToken: "token-1",
        dataClaim: "data",
        mounts: [
          { mountPath: "/home/tangow", subPath: "homes/bot1", readOnly: false },
          { mountPath: "/skills/user", subPath: "skills/user/space1/user1", readOnly: true },
          { mountPath: "/managed-skills", subPath: "managed-skills", readOnly: true },
        ],
        limits: { memory: "8589934592", cpu: "4000m" },
        workingDir: "/home/tangow",
        annotations: {},
      }),
    ).toEqual({
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: computerPodName("bot1"),
        // The selector label is the name's hash; the identity is kept as is in annotations.
        labels: {
          "tangow.managed": "true",
          "tangow.bot": computerPodName("bot1").slice("tangow-bot-".length),
        },
        annotations: { "tangow.botId": "bot1", "tangow.spaceId": "space1" },
      },
      spec: {
        automountServiceAccountToken: false,
        enableServiceLinks: false,
        restartPolicy: "Never",
        terminationGracePeriodSeconds: 10,
        securityContext: {
          runAsUser: 1000,
          runAsGroup: 1000,
          runAsNonRoot: true,
          seccompProfile: { type: "RuntimeDefault" },
        },
        containers: [
          {
            name: "computer",
            image: "tangow/computer@sha256:abc",
            imagePullPolicy: "Never",
            tty: true,
            workingDir: "/home/tangow",
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
              { name: "TANGOW_COMPUTER_CONTROL_TOKEN", value: "token-1" },
            ],
            resources: {
              requests: { memory: "2Gi", cpu: "1" },
              limits: { memory: "8589934592", cpu: "4000m" },
            },
            securityContext: {
              allowPrivilegeEscalation: false,
              capabilities: { drop: ["ALL"] },
            },
            volumeMounts: [
              { name: "data", mountPath: "/home/tangow", subPath: "homes/bot1", readOnly: false },
              {
                name: "data",
                mountPath: "/skills/user",
                subPath: "skills/user/space1/user1",
                readOnly: true,
              },
              {
                name: "data",
                mountPath: "/managed-skills",
                subPath: "managed-skills",
                readOnly: true,
              },
              { name: "shm", mountPath: "/dev/shm" },
            ],
          },
        ],
        volumes: [
          { name: "data", persistentVolumeClaim: { claimName: "data" } },
          { name: "shm", emptyDir: { medium: "Memory", sizeLimit: "256Mi" } },
        ],
      },
    });
  });
});

describe("Kubernetes commands", () => {
  const secret = "placeholder-secret-value";
  const env = [`API_KEY=${secret}`, "A=$HOME", "MULTI=one\\n\ntwo\\"];

  it("hands the env, secrets included, to the command on stdin, never in its argv", async () => {
    const { provision, runtime, state } = kubernetes();
    await provision();
    const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "tangow envelope ")));
    try {
      await runtime.exec(pod, ["sh", "-c", 'pwd; printf "%s\\n" "$API_KEY" "$A" "$MULTI"; cat'], {
        cwd,
        env,
        stdin: Buffer.from("rest of stdin"),
      });
      const { command, stdin } = state.execs.at(-1)!;
      expect(command.join(" ")).not.toContain(secret);

      // What the pod would run, with what the exec would send on its stdin.
      const [shell, ...args] = command;
      const ran = spawnSync(shell!, args, { input: stdin, encoding: "utf8" });
      expect(ran.stdout).toBe(`${cwd}\n${secret}\n$HOME\none\\n\ntwo\\\nrest of stdin`);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("keeps the env out of the exec URL and the URL out of a failed exec's error", async () => {
    const paths: string[] = [];
    const exec = new Exec(new KubeConfig(), {
      connect: async (path: string) => {
        paths.push(path);
        // What the socket rejects with: an error event whose target is the socket and its URL.
        throw { message: "Unexpected server response: 403", target: { url: `wss://api${path}` } };
      },
    } as unknown as ConstructorParameters<typeof Exec>[1]);
    const cluster = fakeCluster();
    const runtime = createKubernetesComputerRuntime({
      namespace: "sandboxes",
      dataClaim: "data",
      dataDir,
      client: { ...cluster.client, podExec: exec },
    });

    const failed = await runtime
      .exec(pod, ["printenv"], { cwd: "/home/tangow", env })
      .catch((error: Error) => error);

    expect(decodeURIComponent(paths[0]!)).toContain("printenv");
    expect(decodeURIComponent(paths[0]!)).not.toContain(secret);
    expect(failed).toEqual(new Error("computer command could not start (HTTP 403)"));
  });

  /** The exec URL the real client builds for a command. */
  async function execUrl(command: string[]) {
    let url = "";
    const exec = new Exec(new KubeConfig(), {
      connect: async (path: string) => {
        url = decodeURIComponent(path);
        throw new Error("offline");
      },
    } as unknown as ConstructorParameters<typeof Exec>[1]);
    await exec.exec("sandboxes", pod, "computer", command, null, null, null, false).catch(() => {});
    return url;
  }

  /** What the command reads after the envelope's env preamble. */
  const afterPreamble = (stdin: Buffer) => {
    const text = stdin.toString();
    return text.slice(text.indexOf("\n\n") + 2);
  };

  const typed = 'placeholder-pass "q" \\ end\nnext line';

  it("sends page-browser text on stdin after the env, never in the command or its URL", async () => {
    const { provision, app, state } = kubernetes();
    await provision();
    const body = { command: "act", actions: [{ kind: "fill", ref: "e1", text: typed }] };
    const controller = new AbortController();

    const response = app.request(`/computers/${pod}/browser`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    // The helper's stdin stays open until it ends or the request is cancelled.
    const helper = () =>
      state.execs.find((call) => call.command.includes("/usr/local/bin/tangow-page-browser"));
    while (!helper()?.stdin.toString().endsWith("\n"))
      await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    const failed = await (await response).text();

    for (const call of state.execs) {
      expect(call.command.join(" ")).not.toContain("placeholder-pass");
      expect(await execUrl(call.command)).not.toContain("placeholder-pass");
    }
    expect(await execUrl(helper()!.command)).toContain("tangow-page-browser");
    expect(afterPreamble(helper()!.stdin)).toBe(`${JSON.stringify(body)}\n`);
    expect(failed).not.toContain("placeholder-pass");
  });

  it("types screen input from stdin, never from the command or its URL", async () => {
    const { provision, app, state } = kubernetes();
    await provision();

    const response = await app.request(`/computers/${pod}/input`, {
      method: "POST",
      headers,
      body: JSON.stringify({ input: { kind: "clipboard", text: typed } }),
    });

    expect(await response.json()).toMatchObject({ ok: true });
    const call = state.execs.at(-1)!;
    expect(await execUrl(call.command)).toContain("xdotool");
    expect(call.command.join(" ")).not.toContain("placeholder-pass");
    expect(await execUrl(call.command)).not.toContain("placeholder-pass");
    expect(afterPreamble(call.stdin)).toBe(typed);
  });
});

describe("Kubernetes computers", () => {
  it.each([
    ["a long", owner],
    ["a short", shortOwner],
  ])(
    "creates a named pod for %s identity, deletes it on stop, and creates it again on the new IP",
    async (_, who) => {
      const { provision, app, pods, state, runtime } = kubernetes(undefined, who);
      const pod = computerPodName(who.botId);

      const created = await provision();
      expect(await created.json()).toMatchObject({ id: pod, resumed: false });
      const first = await runtime.getComputer({ id: pod, owner: who, screenPort: "6080" });
      expect(first.screen).toEqual({ host: "10.42.0.1", port: "6080" });
      await expect(
        runtime.getComputer({ id: pod, owner: { ...who, spaceId: "other-space" } }),
      ).rejects.toThrow("computer identity mismatch");

      const stopped = await settle(
        app.request(`/computers/${pod}/stop`, { method: "POST", headers: headersOf(who) }),
      );
      expect(stopped.status).toBe(200);
      expect(state.deletes).toEqual([{ name: pod, grace: 10 }]);
      expect(pods.has(pod)).toBe(false);

      const resumed = await provision();
      expect(await resumed.json()).toMatchObject({ id: pod, resumed: false });
      const second = await runtime.getComputer({ id: pod, owner: who, screenPort: "6080" });
      expect(second.screen).toEqual({ host: "10.42.0.2", port: "6080" });
      expect(second.control?.url).toBe("http://10.42.0.2:7070/v1/desktop");
    },
  );

  it("starts again only once a stop has seen its own pod go", async () => {
    const { provision, startRequest, app, state } = kubernetes();
    await provision();

    const stopping = app.request(`/computers/${pod}/stop`, { method: "POST", headers });
    while (state.deletes.length === 0) await new Promise((resolve) => setImmediate(resolve));
    const [stopped, started] = await settle(Promise.all([stopping, startRequest()]));

    expect(stopped.status).toBe(200);
    expect(started.status).toBe(200);
  });

  it("replaces a computer whose workspace root changed", async () => {
    const { provision, pods, state } = kubernetes();
    const mounts = [
      { volume: "tangow-v1", path: "/workspace/one" },
      { volume: "tangow-v2", path: "/workspace/two" },
    ];
    await provision({ volumeHome: { root: "/workspace/one", mounts } });

    const moved = await provision({ volumeHome: { root: "/workspace/two", mounts } });

    expect(await moved.json()).toMatchObject({ resumed: false });
    expect(state.deletes).toEqual([{ name: pod, grace: 0 }]);
    expect(pods.get(pod)!.spec!.containers[0]!.workingDir).toBe("/workspace/two");
  });

  it("removes a computer without grace and only answers once the pod is gone", async () => {
    const { provision, app, pods, state } = kubernetes();
    await provision();

    const removed = await settle(app.request(`/computers/${pod}`, { method: "DELETE", headers }));

    expect(removed.status).toBe(200);
    expect(state.deletes).toEqual([{ name: pod, grace: 0 }]);
    expect(pods.size).toBe(0);
  });

  it("gives identities that differ only by case their own pods", () => {
    expect(computerPodName(owner.botId.toLowerCase())).not.toBe(pod);
  });

  it("refuses an empty identity before any pod call", async () => {
    const { runtime, pods } = kubernetes();
    const spec = { ...owner, botId: "", userId: "user1", homePath: `${dataDir}/homes/x` };

    await expect(runtime.getComputer({ spec })).rejects.toThrow("computer identity is empty");
    expect(pods.size).toBe(0);
  });

  it("returns the quota refusal from the create", async () => {
    const cluster = fakeCluster();
    cluster.state.quotaExceeded = true;
    const { provision } = kubernetes(cluster);

    const response = await provision();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: `computer pod was refused: pods "${pod}" is forbidden: exceeded quota: sandboxes`,
    });
  });

  it("logs bounded error details for supervisor 5xx responses only", async () => {
    const sink = createTestSink();
    const logger = getLogger();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    try {
      const cluster = fakeCluster();
      const message = `read forbidden {"token":"fixture-json"} token=fixture-assignment ${"x".repeat(240)}`;
      cluster.client.pods.readNamespacedPod = async () => {
        throw podApiError(403, "Forbidden", message);
      };
      const { app, provision } = kubernetes(cluster);
      const response = await provision();
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: message });
      expect((await app.request("/health")).status).toBe(200);
      expect((await app.request("/computers", { method: "POST" })).status).toBe(401);

      const failures = sink.events.filter((event) => event.message === "http.response.failed");
      const redacted = 'read forbidden {"token":"[Redacted]"} token=[Redacted] ';
      expect(failures).toMatchObject([
        {
          "http.route": "/computers",
          "http.status": 500,
          "http.response.detail": redacted + "x".repeat(200 - redacted.length),
        },
      ]);
    } finally {
      installLogger(logger);
    }
  });

  it("gives up at the deadline with the pod's last reason and deletes the pod", async () => {
    const cluster = fakeCluster();
    cluster.state.boot = "image-missing";
    const { provision, pods } = kubernetes(cluster);

    const response = await provision();

    expect(response.status).toBe(500);
    expect(((await response.json()) as { error: string }).error).toContain("ErrImageNeverPull");
    expect(cluster.state.deletes).toEqual([{ name: pod, grace: 0 }]);
    expect([...pods.values()].every((pod) => pod.metadata?.deletionTimestamp)).toBe(true);
  });

  it("writes a file through the command's stdin and reports a command's exit code", async () => {
    const { provision, app, state } = kubernetes();
    await provision();

    const written = await app.request(`/computers/${pod}/files`, {
      method: "POST",
      headers,
      body: JSON.stringify({ path: "notes.txt", content: Buffer.from("hello").toString("base64") }),
    });
    expect(written.status).toBe(200);
    expect(state.execs.at(-1)!.stdin.toString()).toMatch(/\n\nhello$/);

    state.exitCode = 3;
    const ran = await app.request(`/computers/${pod}/exec`, {
      method: "POST",
      headers,
      body: JSON.stringify({ argv: ["false"] }),
    });
    expect(await ran.json()).toMatchObject({ code: 3 });
  });

  it("closes stdin, rejects with the signal's reason, and drops its listener on abort", async () => {
    const { provision, runtime, state } = kubernetes();
    await provision();
    const controller = new AbortController();
    const added = vi.spyOn(controller.signal, "addEventListener");
    const removed = vi.spyOn(controller.signal, "removeEventListener");

    const running = runtime.exec(pod, ["sleep", "60"], {
      cwd: "/home/tangow",
      env: [],
      signal: controller.signal,
    });
    await new Promise((resolve) => setImmediate(resolve));
    const reason = new Error("cancelled by the caller");
    controller.abort(reason);

    await expect(running).rejects.toBe(reason);
    await new Promise((resolve) => setImmediate(resolve));
    expect(state.execs.at(-1)!.stdinEnded).toBe(true);
    const listener = added.mock.calls.find(([type]) => type === "abort")?.[1];
    expect(listener).toBeDefined();
    expect(removed).toHaveBeenCalledWith("abort", listener);
  });

  it.each([
    ["TANGOW_COMPUTER_MEMORY", "1g"],
    ["TANGOW_COMPUTER_CPUS", "0.5"],
  ])("refuses to start when %s is below the computer's request", (name, value) => {
    vi.stubEnv(name, value);
    try {
      expect(() => kubernetes()).toThrow(name);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses to start with a per-space computer cap", () => {
    vi.stubEnv("SANDBOX_MAX_COMPUTERS_PER_SPACE", "2");
    try {
      expect(() => kubernetes()).toThrow(/SANDBOX_MAX_COMPUTERS_PER_SPACE/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("worker pod", () => {
  it("is hardened, shares its process namespace, and mounts the volumes by subPath", () => {
    expect(
      workerPod({
        name: "tangowworkerc1",
        image: "tangow/worker@sha256:abc",
        attemptId: "c1",
        ttlSeconds: 3600,
        dataClaim: "data",
        mounts: [{ mountPath: "/workspace/repo", subPath: "volumes/tangow-v1", readOnly: true }],
      }),
    ).toEqual({
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: "tangowworkerc1",
        labels: { "tangow.managed": "true", "tangow.worker": "true", "tangow.attempt": "c1" },
      },
      spec: {
        automountServiceAccountToken: false,
        enableServiceLinks: false,
        restartPolicy: "Never",
        shareProcessNamespace: true,
        securityContext: {
          runAsUser: 1000,
          runAsGroup: 1000,
          runAsNonRoot: true,
          seccompProfile: { type: "RuntimeDefault" },
        },
        containers: [
          {
            name: "worker",
            image: "tangow/worker@sha256:abc",
            imagePullPolicy: "Never",
            command: ["sleep", "3600"],
            workingDir: "/workspace",
            env: [{ name: "HOME", value: "/home/user" }],
            resources: {
              requests: { memory: "512Mi", cpu: "250m" },
              limits: { memory: "1073741824", cpu: "1000m" },
            },
            securityContext: {
              allowPrivilegeEscalation: false,
              capabilities: { drop: ["ALL"] },
            },
            volumeMounts: [
              {
                name: "data",
                mountPath: "/workspace/repo",
                subPath: "volumes/tangow-v1",
                readOnly: true,
              },
            ],
          },
        ],
        volumes: [{ name: "data", persistentVolumeClaim: { claimName: "data" } }],
      },
    });
  });
});

describe("Kubernetes workers", () => {
  const attemptId = `c${"a1".repeat(12)}`;
  const name = `tangowworker${attemptId}`;
  const ensure = (app: ReturnType<typeof kubernetes>["app"], id = attemptId) =>
    settle(
      app.request("/workers", {
        method: "POST",
        headers,
        body: JSON.stringify({
          attemptId: id,
          ttlSeconds: 600,
          mounts: [{ volume: "tangow-v1", path: "/workspace/repo", readOnly: false }],
        }),
      }),
    );

  it("keeps one pod per attempt, and destroy answers once none is left", async () => {
    const { app, pods, state } = kubernetes();

    expect(await (await ensure(app)).json()).toEqual({ id: name });
    expect(await (await ensure(app)).json()).toEqual({ id: name });
    expect([...pods.keys()]).toEqual([name]);
    expect(pods.get(name)!.spec!.containers[0]!.volumeMounts).toEqual([
      { name: "data", mountPath: "/workspace/repo", subPath: "volumes/tangow-v1", readOnly: false },
    ]);

    const destroyed = await settle(
      app.request(`/workers?attempt=${attemptId}`, { method: "DELETE", headers }),
    );
    expect(await destroyed.json()).toEqual({ destroyed: true });
    expect(state.deletes).toEqual([{ name, grace: 0 }]);
    expect(pods.size).toBe(0);
  });

  it("replaces a pod that has exited", async () => {
    const { app, pods, state } = kubernetes();
    await ensure(app);
    pods.get(name)!.status = { phase: "Succeeded" };

    expect(await (await ensure(app)).json()).toEqual({ id: name });

    expect(state.deletes).toEqual([{ name, grace: 0 }]);
    expect(pods.get(name)!.status!.phase).toBe("Running");
  });

  it("refuses an attempt id that is not a cuid, without creating a pod", async () => {
    const { app, pods } = kubernetes();

    const response = await ensure(app, "Attempt_1");

    expect(response.status).toBe(500);
    expect(((await response.json()) as { error: string }).error).toContain("cuid");
    expect(pods.size).toBe(0);
  });

  it("hands the guest its capability on stdin, relays the socket, and ends it on EOF", async () => {
    const { app, runtime, state } = kubernetes();
    await ensure(app);

    const guest = await runtime.workers.openGuest(name, "rkw1.claims.mac");
    const [client, server] = duplexPair();
    const received: Buffer[] = [];
    client.on("data", (chunk: Buffer) => received.push(chunk));
    const ended = new Promise((resolve) => client.on("end", resolve));
    guest!.attach(server, Buffer.from("head;"));
    client.end("frame");
    await ended;

    const call = state.execs.at(-1)!;
    expect(call.command).toEqual([
      "sh",
      "-c",
      'IFS= read -r TANGOW_WORKER_CAPABILITY && export TANGOW_WORKER_CAPABILITY && exec node "$1"',
      "sh",
      "/opt/tangow/agent-run-worker.mjs",
    ]);
    expect(call.stdin.toString()).toBe("rkw1.claims.mac\nhead;frame");
    expect(call.stdinEnded).toBe(true);
    expect(Buffer.concat(received).toString()).toBe("done");
  });
});

describe("supervisor backend", () => {
  it("defaults to docker, selects kubernetes, and refuses anything else", () => {
    expect(resolveSupervisorBackend(undefined)).toBe("docker");
    expect(resolveSupervisorBackend("kubernetes")).toBe("kubernetes");
    expect(() => resolveSupervisorBackend("k8s")).toThrow(/SUPERVISOR_BACKEND/);
  });
});
