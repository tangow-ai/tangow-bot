import type http from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { boundedSandboxCommandTimeoutMs, resolveSupervisorToken } from "@tangow/core";
import { loadRootEnv } from "@tangow/core/node/load-root-env";
import { getLogger, redactSensitiveText, SERVICE_NAMES } from "@tangow/logging";
import { createRootLogger } from "@tangow/logging/axiom";
import { requestLogging } from "@tangow/logging/hono";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { ComputerRuntime, ComputerSpec } from "./computer-runtime.js";
import {
  ComputerIdentityError,
  ComputerLimitError,
  ComputerNotFoundError,
} from "./computer-runtime.js";
import { createComputerSession } from "./computer-session.js";
import {
  COMPUTER_IMAGE,
  computerResourceLimits,
  resolveSpaceComputerLimit,
  resolveSupervisorBackend,
  screenPorts,
} from "./computer-spec.js";
import { createDockerComputerRuntime } from "./docker-runtime.js";
import { createKubernetesComputerRuntime } from "./kubernetes-runtime.js";
import { syncManagedSkills } from "./managed-skills.js";
import { registerScreenRoutes } from "./screen-routes.js";
import {
  assertRequestIdentity,
  clearComputerScreenRegistry,
  commandWorkingDir,
  hasValidBearerToken,
  normalizeWorkspaceRelative,
  stopScreensCommand,
  withKeyedLock,
  workspaceTarget,
} from "./supervisor-logic.js";

loadRootEnv();

const computerContext =
  process.env.TANGOW_COMPUTER_CONTEXT ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../computer");
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const dataDir = path.resolve(repositoryRoot, process.env.DATA_DIR ?? "./data");
const supervisorToken = resolveSupervisorToken(process.env);

export const MAX_SUPERVISOR_REQUEST_BYTES = 1024 * 1024;
export const MAX_SUPERVISOR_FILE_REQUEST_BYTES = 16 * 1024 * 1024 + 64 * 1024;

/** Keep normal control requests small while allowing the existing 16 MiB file payload. */
export function supervisorRequestBodyLimit(method: string, pathname: string): number {
  return method === "POST" && /^\/computers\/[^/]+\/files\/?$/.test(pathname)
    ? MAX_SUPERVISOR_FILE_REQUEST_BYTES
    : MAX_SUPERVISOR_REQUEST_BYTES;
}

const limitSupervisorRequestBody: MiddlewareHandler = async (c, next) => {
  return bodyLimit({
    maxSize: supervisorRequestBodyLimit(c.req.method, c.req.path),
    onError: (context) => context.json({ error: "Request body is too large." }, 413),
  })(c, next);
};

const PathSegment = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const MAX_ERROR_LOG_LENGTH = 200;

async function responseErrorDetail(response: Response): Promise<string> {
  const body = await response.clone().text();
  let detail = body;
  try {
    const payload: unknown = JSON.parse(body);
    detail =
      payload &&
      typeof payload === "object" &&
      "error" in payload &&
      typeof payload.error === "string"
        ? payload.error
        : "";
  } catch {
    // Hono can return plain-text errors.
  }
  return redactSensitiveText(detail).slice(0, MAX_ERROR_LOG_LENGTH);
}

/** The HTTP routes over one backend. Lifecycle decisions and locks live here, above it. */
export function createSupervisor(runtime: ComputerRuntime) {
  const botLifecycleLocks = new Map<string, Promise<unknown>>();
  const spaceComputerLocks = new Map<string, Promise<unknown>>();

  // Serialize create/delete for one bot so DELETE cannot remove a per-bot network
  // while POST still needs it between ensureBotNetwork and container attach.
  const withBotLifecycleLock = <T>(botId: string, task: () => Promise<T>) =>
    withKeyedLock(botLifecycleLocks, botId, task);
  // Serialize per-space create admission (count + create) so different bots cannot
  // race past SANDBOX_MAX_COMPUTERS_PER_SPACE. Callers must already hold the bot
  // lifecycle lock; never acquire a bot lock while holding this lock.
  const withSpaceComputerLock = <T>(spaceId: string, task: () => Promise<T>) =>
    withKeyedLock(spaceComputerLocks, spaceId, task);

  const session = createComputerSession(runtime);
  const {
    computerScreens,
    withComputerScreenLock,
    managedComputer,
    runCommand,
    writeComputerFile,
  } = session;

  const app = new Hono();

  app.use("*", requestLogging());
  app.use("*", async (c, next) => {
    await next();
    if (c.res.status < 500) return;
    const detail = await responseErrorDetail(c.res).catch(() => undefined);
    getLogger().error("http.response.failed", {
      "http.method": c.req.method,
      "http.route": c.req.routePath,
      "http.status": c.res.status,
      "http.response.detail": detail,
    });
  });

  app.get("/health", (c) => c.json({ ok: true, image: COMPUTER_IMAGE }));

  app.use("/computers", async (c, next) => {
    if (!hasValidBearerToken(c.req.header("authorization"), supervisorToken)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });
  app.use("/computers/*", async (c, next) => {
    if (!hasValidBearerToken(c.req.header("authorization"), supervisorToken)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });
  app.use("/computers", limitSupervisorRequestBody);
  app.use("/computers/*", limitSupervisorRequestBody);

  app.get("/computers/release", async (c) => c.json({ releaseRef: await runtime.release() }));

  app.post("/computers", async (c) => {
    const body = z
      .object({
        botId: z.string().min(1),
        homePath: z.string().min(1),
        spaceId: PathSegment,
        userId: PathSegment,
        skillsBotId: PathSegment.optional(),
        volumeHome: z
          .object({
            root: z.string(),
            mounts: z
              .array(z.object({ volume: z.string(), path: z.string() }))
              .min(1)
              .max(64),
          })
          .optional(),
      })
      .parse(await c.req.json());
    try {
      assertRequestIdentity(c.req.header("x-tangow-bot-id"), c.req.header("x-tangow-space-id"), {
        botId: body.botId,
        spaceId: body.spaceId,
      });
      return await withBotLifecycleLock(body.botId, async () => {
        const spec: ComputerSpec = { ...body, homePath: path.resolve(body.homePath) };
        assertBotHomePath(spec.homePath, body.botId);
        const existing = await runtime.getComputer({ spec });
        // A computer from another release or spec is replaced; anything else is resumed.
        if (existing?.matchesSpec && existing.releaseRef === (await runtime.release())) {
          const resumed = await runtime.ensureComputer(spec, { ...existing, replace: false });
          return c.json({ ...resumed, image: COMPUTER_IMAGE });
        }

        // Under a space cap, serialize count+create and incompatible replace (remove+create)
        // per space inside the bot lock. Replacements skip the admission check but still
        // take the lock so a temporary free slot cannot be stolen by another bot's create.
        // Lock order is always bot → space; never take a bot lock while holding a space lock.
        const createComputer = async () => {
          try {
            const created = await runtime.ensureComputer(
              spec,
              existing && { ...existing, replace: true },
            );
            return c.json({ ...created, image: COMPUTER_IMAGE });
          } catch (error) {
            if (error instanceof ComputerLimitError) return c.json({ error: error.message }, 429);
            throw error;
          }
        };
        if (resolveSpaceComputerLimit() > 0) {
          return await withSpaceComputerLock(body.spaceId, createComputer);
        }
        return await createComputer();
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message }, 500);
    }
  });

  app.get("/computers/:id", async (c) => {
    const id = c.req.param("id");
    try {
      const computer = await managedComputer(
        id,
        c.req.header("x-tangow-bot-id"),
        c.req.header("x-tangow-space-id"),
      );
      return c.json({ id, running: computer.running, image: computer.image });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message }, 404);
    }
  });

  app.post("/computers/:id/exec", async (c) => {
    const id = c.req.param("id");
    const body = z
      .object({
        argv: z.array(z.string()),
        cwd: z.string().optional(),
        env: z.record(z.string(), z.string()).optional(),
        timeoutMs: z.number().int().positive().optional(),
      })
      .parse(await c.req.json());
    try {
      const computer = await managedComputer(
        id,
        c.req.header("x-tangow-bot-id"),
        c.req.header("x-tangow-space-id"),
      );
      const screenId = c.req.header("x-tangow-screen-id") || c.req.header("x-tangow-bot-id") || id;
      const screenIndex = computerScreens.get(id)?.get(screenId)?.index ?? 0;
      const layout = screenPorts(screenIndex);
      const result = await runCommand(id, body.argv.length ? body.argv : ["/bin/echo", "ready"], {
        workingDir: commandWorkingDir(body.cwd, computer.workspace),
        env: [
          `DISPLAY=${layout.display}`,
          "HOME=/home/tangow",
          "PATH=/home/tangow/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          "NPM_CONFIG_PREFIX=/home/tangow/.local",
          "PIP_USER=1",
          ...Object.entries(body.env ?? {}).map(([k, v]) => `${k}=${v}`),
        ],
        timeoutMs: boundedSandboxCommandTimeoutMs(body.timeoutMs),
      });
      return c.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ stdout: "", stderr: message, code: 1 }, 200);
    }
  });

  app.get("/computers/:id/files", async (c) => {
    try {
      const id = c.req.param("id");
      const computer = await managedComputer(
        id,
        c.req.header("x-tangow-bot-id"),
        c.req.header("x-tangow-space-id"),
      );
      const relative = normalizeWorkspaceRelative(c.req.query("path") ?? "");
      const target = workspaceTarget(relative, computer.workspace);
      if (c.req.query("mode") === "read") {
        const maxBytesRaw = c.req.query("maxBytes");
        const maxBytes = maxBytesRaw === undefined ? undefined : Number(maxBytesRaw);
        if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
          return c.json({ error: "invalid maxBytes" }, 400);
        }
        const script = [
          "import base64, sys",
          "target, limit = sys.argv[1], int(sys.argv[2])",
          "with open(target, 'rb') as source:",
          "  content = source.read() if limit < 0 else source.read(limit + 1)",
          "if limit >= 0 and len(content) > limit: sys.exit(42)",
          "sys.stdout.write(base64.b64encode(content).decode())",
        ].join("\n");
        const result = await runCommand(id, [
          "python3",
          "-c",
          script,
          target,
          String(maxBytes ?? -1),
        ]);
        if (result.code === 42) {
          return c.json({ error: `computer file exceeds ${maxBytes} bytes` }, 413);
        }
        if (result.code !== 0) return c.json({ error: result.stderr || "file not found" }, 404);
        return c.json({ content: result.stdout.trim() });
      }
      const script = [
        "import json, os, stat, sys",
        "root, rel = sys.argv[1], sys.argv[2]",
        "out = []",
        "for item in os.scandir(root):",
        "  if item.is_symlink(): continue",
        "  info = item.stat(follow_symlinks=False)",
        "  child = '/'.join(x for x in (rel, item.name) if x)",
        "  out.append({'path': child, 'kind': 'dir' if item.is_dir(follow_symlinks=False) else 'file', 'size': info.st_size, **({'executable': True} if item.is_file(follow_symlinks=False) and bool(info.st_mode & stat.S_IXUSR) else {})})",
        "print(json.dumps(sorted(out, key=lambda x: x['path'])))",
      ].join("\n");
      const result = await runCommand(id, ["python3", "-c", script, target, relative]);
      if (result.code !== 0) return c.json({ error: result.stderr || "directory not found" }, 404);
      return c.json(JSON.parse(result.stdout));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message }, 400);
    }
  });

  app.post("/computers/:id/files", async (c) => {
    const body = z
      .object({
        path: z.string(),
        content: z.string().max(16 * 1024 * 1024),
        executable: z.boolean().optional(),
      })
      .parse(await c.req.json());
    try {
      const id = c.req.param("id");
      const computer = await managedComputer(
        id,
        c.req.header("x-tangow-bot-id"),
        c.req.header("x-tangow-space-id"),
      );
      const target = workspaceTarget(normalizeWorkspaceRelative(body.path), computer.workspace);
      await writeComputerFile(id, target, Buffer.from(body.content, "base64"), body.executable);
      return c.json({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message }, 400);
    }
  });

  registerScreenRoutes(app, session);

  app.post("/computers/:id/stop", async (c) => {
    const id = c.req.param("id");
    const botId = c.req.header("x-tangow-bot-id");
    const spaceId = c.req.header("x-tangow-space-id");
    try {
      await managedComputer(id, botId, spaceId);
      // Under the bot's lifecycle lock, no start reuses the pod name while this stop waits for it
      // to go: the wait cannot time out on the new pod, and no retried stop then kills it.
      await withBotLifecycleLock(botId!, () =>
        withComputerScreenLock(id, async () => {
          // A concurrent stop may have finished while this one waited for the lock.
          if ((await managedComputer(id, botId, spaceId)).running) {
            const screens = [...(computerScreens.get(id) ?? [])].map(([screenId, slot]) => ({
              screenId,
              index: slot.index,
            }));
            try {
              const checkpoint = await runCommand(id, ["bash", "-c", stopScreensCommand(screens)]);
              if (checkpoint.code !== 0)
                throw new Error(checkpoint.stderr || "bot browsers failed to stop");
            } finally {
              // Failed profiles remain on the durable home for recovery after restart.
              await runtime.stopComputer(id);
              clearComputerScreenRegistry(computerScreens, id);
            }
          }
          clearComputerScreenRegistry(computerScreens, id);
        }),
      );
      return c.json({ ok: true });
    } catch (error) {
      if (error instanceof ComputerIdentityError)
        return c.json({ error: "invalid computer identity" }, 403);
      if (error instanceof ComputerNotFoundError)
        return c.json({ error: "computer not found" }, 404);
      return c.json({ error: "computer failed to stop" }, 500);
    }
  });

  app.delete("/computers/:id", async (c) => {
    const id = c.req.param("id");
    const botId = c.req.header("x-tangow-bot-id");
    try {
      if (!botId) throw new Error("missing computer identity");
      return await withBotLifecycleLock(botId, async () => {
        await managedComputer(id, botId, c.req.header("x-tangow-space-id"));
        await withComputerScreenLock(id, async () => {
          await runtime.removeComputer(id, botId);
          clearComputerScreenRegistry(computerScreens, id);
        });
        return c.json({ ok: true });
      });
    } catch {
      return c.json({ error: "computer not found" }, 404);
    }
  });

  app.use("/workers", async (c, next) => {
    if (!hasValidBearerToken(c.req.header("authorization"), supervisorToken)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });
  app.use("/workers", limitSupervisorRequestBody);

  app.post("/workers", async (c) => {
    try {
      const body = z
        .object({
          attemptId: PathSegment,
          ttlSeconds: z.number().int().min(1).max(86_400),
          mounts: z.array(
            z.object({ volume: z.string(), path: z.string(), readOnly: z.boolean() }),
          ),
        })
        .parse(await c.req.json());
      return c.json(await runtime.workers.ensure(body));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.delete("/workers", async (c) => {
    const attemptId = PathSegment.safeParse(c.req.query("attempt"));
    if (!attemptId.success) return c.json({ error: "invalid attempt" }, 400);
    try {
      // The controller frees the volumes' writer leases on this answer: it means nothing is left.
      return c.json(await runtime.workers.destroy(attemptId.data));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  /**
   * `GET /workers/:id/guest` as an HTTP upgrade: the guest runs inside the worker with the
   * attempt's capability, and the socket carries its stdin and stdout, raw. The Node `upgrade`
   * event bypasses Hono, so the token is checked here.
   */
  async function upgradeWorkerGuest(
    request: http.IncomingMessage,
    socket: Duplex,
    head: Buffer = Buffer.alloc(0),
  ) {
    // Node drops its own error listener on upgrade: an unhandled reset would kill the supervisor.
    socket.on("error", () => socket.destroy());
    const refuse = (status: string) => {
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    if (!hasValidBearerToken(request.headers.authorization, supervisorToken)) {
      return refuse("401 Unauthorized");
    }
    const match = /^\/workers\/([A-Za-z0-9]{1,64})\/guest$/.exec(request.url ?? "");
    if (!match) return refuse("404 Not Found");
    const capability = request.headers["x-tangow-worker-capability"];
    if (typeof capability !== "string" || capability.length === 0) return refuse("400 Bad Request");
    try {
      const guest = await runtime.workers.openGuest(match[1]!, capability);
      if (!guest) return refuse("404 Not Found");
      // The client left while the guest was starting: closing stdin ends it.
      if (socket.destroyed) return guest.close();
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tangow-guest\r\n\r\n",
      );
      guest.attach(socket, head);
    } catch {
      refuse("404 Not Found");
    }
  }

  return { app, upgradeWorkerGuest };
}

function assertBotHomePath(homePath: string, botId: string) {
  const expected = path.join(dataDir, "homes", botId);
  if (homePath !== expected) {
    throw new Error("computer home must be the bot's home directory");
  }
}

function requiredSetting(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required with SUPERVISOR_BACKEND=kubernetes`);
  return value;
}

/** Docker by default; Kubernetes reaches its cluster from inside it, through its ServiceAccount. */
function createComputerRuntime(): ComputerRuntime {
  if (resolveSupervisorBackend(process.env.SUPERVISOR_BACKEND) === "docker") {
    return createDockerComputerRuntime({ dataDir, computerContext });
  }
  return createKubernetesComputerRuntime({
    namespace: requiredSetting("SUPERVISOR_KUBERNETES_NAMESPACE"),
    dataClaim: requiredSetting("SUPERVISOR_KUBERNETES_DATA_CLAIM"),
    dataDir,
  });
}

const supervisor = createSupervisor(createComputerRuntime());
export const supervisorApp = supervisor.app;
export const upgradeWorkerGuest = supervisor.upgradeWorkerGuest;

async function startSupervisor() {
  const logger = createRootLogger(SERVICE_NAMES.supervisor);
  // Repo skills are published to DATA_DIR so computers see them via the /managed-skills bind.
  await syncManagedSkills(repositoryRoot, dataDir, logger);
  // Resolve the ceilings before binding the port. They are otherwise parsed inside
  // containerCreateOptions, so a malformed TANGOW_COMPUTER_* value would let the supervisor start
  // and pass its healthcheck, then fail the first POST /computers with a 500 that reads like a
  // Docker problem. Failing here names the variable while the deployment is still coming up.
  computerResourceLimits();
  const port = Number(process.env.SUPERVISOR_PORT ?? 7091);
  const hostname = process.env.SUPERVISOR_HOST ?? "127.0.0.1";
  const server = serve({ fetch: supervisorApp.fetch, hostname, port }, () => {
    logger.info("supervisor listening", { "http.host": hostname, "http.port": port });
  });
  server.on("upgrade", (request, socket, head) => void upgradeWorkerGuest(request, socket, head));
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await closeListeningServer(server);
    await logger.flush({ timeoutMs: 2_000 });
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
  return server;
}

function closeListeningServer(server: {
  close(callback?: (err?: Error) => void): void;
  closeIdleConnections?: () => void;
}): Promise<void> {
  server.closeIdleConnections?.();
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  void startSupervisor();
}
