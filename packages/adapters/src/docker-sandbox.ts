import path from "node:path";
import type {
  AdapterContext,
  CommandRequest,
  ComputerActionRequest,
  ComputerFileEntry,
  ComputerInput,
  ComputerObservation,
  ComputerRef,
  ControlLeaseRef,
  PageBrowserCommand,
  PageBrowserResult,
  PortableFile,
  ProcessEvent,
  SandboxProvider,
  ScreenRequest,
  ScreenSession,
} from "@tangow/adapter-kit";
import { boundedSandboxCommandTimeoutMs, resolveSupervisorToken } from "@tangow/core";
import { outgoingCorrelationHeaders } from "@tangow/logging";
import { z } from "zod";
import { ComputerCapacityError } from "./computer-lifecycle.js";
import { ComputerScreenUnavailableError, screenSessionKey } from "./computer-screens.js";
import {
  boundedComputerActions,
  clampRounded,
  computerObservation,
  linkWorkspaceCommand,
  normalizeWorkspacePath,
} from "./computer-support.js";
import { readBodyCapped, withAbort } from "./web-ssrf.js";

export const MAX_SANDBOX_ERROR_RESPONSE_BYTES = 8 * 1024;
export const MAX_SANDBOX_SUCCESS_RESPONSE_BYTES = 16 * 1024 * 1024;
export const SCREEN_RELEASE_TIMEOUT_MS = 8_000;
const SANDBOX_ERROR_RESPONSE_TIMEOUT_MS = 1_000;
const SANDBOX_SUCCESS_RESPONSE_TIMEOUT_MS = 30_000;

async function safeBody(res: Response, signal?: AbortSignal): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_SANDBOX_ERROR_RESPONSE_BYTES) {
    cancelResponseBody(res);
    return "";
  }
  try {
    const readSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(SANDBOX_ERROR_RESPONSE_TIMEOUT_MS)])
      : AbortSignal.timeout(SANDBOX_ERROR_RESPONSE_TIMEOUT_MS);
    const bytes = await readBodyCapped(res, MAX_SANDBOX_ERROR_RESPONSE_BYTES, readSignal);
    return new TextDecoder().decode(bytes).slice(0, 200);
  } catch {
    return "";
  }
}

function cancelResponseBody(res: Response): void {
  try {
    void Promise.resolve(res.body?.cancel()).catch(() => undefined);
  } catch {
    // Error diagnostics are best-effort and must not delay the operation failure.
  }
}

async function readSandboxJson<T>(
  res: Response,
  signal: AbortSignal,
  maxBytes = MAX_SANDBOX_SUCCESS_RESPONSE_BYTES,
): Promise<T> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    cancelResponseBody(res);
    throw new Error(`sandbox response exceeds ${maxBytes} bytes`);
  }
  const readSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(SANDBOX_SUCCESS_RESPONSE_TIMEOUT_MS),
  ]);
  let bytes: Uint8Array;
  try {
    bytes = await readBodyCapped(res, maxBytes, readSignal);
  } catch (error) {
    if (error instanceof Error && error.message === "Response is too large") {
      throw new Error(`sandbox response exceeds ${maxBytes} bytes`, { cause: error });
    }
    throw error;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

function encodedFileResponseLimit(maxBytes: number | undefined): number {
  if (maxBytes === undefined) return MAX_SANDBOX_SUCCESS_RESPONSE_BYTES;
  // An explicit file limit is already the caller's memory-safety contract.
  // Account for base64 expansion plus the small JSON envelope without applying
  // the generic response cap, which would reject valid files above ~12 MiB.
  return Math.ceil(maxBytes / 3) * 4 + 1024;
}

export class DockerSandboxProvider implements SandboxProvider {
  private readonly supervisorToken: string;

  constructor(
    private readonly supervisorUrl: string,
    supervisorToken?: string,
  ) {
    this.supervisorToken = supervisorToken ?? resolveSupervisorToken(process.env);
  }

  describe() {
    return {
      id: "docker",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        graphical: true,
        pty: true,
        snapshots: true,
        takeover: true,
        persistentHome: true,
        multiScreen: true,
      },
    };
  }

  private url(path: string) {
    return `${this.supervisorUrl.replace(/\/$/, "")}${path}`;
  }

  private headers(context: AdapterContext, botId?: string) {
    return {
      authorization: `Bearer ${this.supervisorToken}`,
      "x-tangow-space-id": context.spaceId,
      ...outgoingCorrelationHeaders(),
      ...(botId ? { "x-tangow-bot-id": botId } : {}),
      // The supervisor picks the screen and its browser profile by this key.
      ...(context.botId ? { "x-tangow-screen-id": screenSessionKey(context) } : {}),
      ...(context.screenLeaseId ? { "x-tangow-screen-lease-id": context.screenLeaseId } : {}),
      ...(context.cancelRunWork ? { "x-tangow-cancel-run-work": "1" } : {}),
    };
  }

  async currentRelease(context: AdapterContext): Promise<string | null> {
    const response = await fetch(this.url("/computers/release"), {
      headers: this.headers(context),
      signal: context.signal,
    });
    if (!response.ok) throw new Error(`computer release lookup failed: ${response.status}`);
    return z
      .object({ releaseRef: z.string().min(1) })
      .parse(await readSandboxJson(response, context.signal)).releaseRef;
  }

  /**
   * A home on volumes keeps `/home/tangow` on its home directory for dotfiles and browser profiles,
   * and mounts its volumes at the paths workers use. The supervisor replaces a computer created
   * with another set of mounts; nothing it held is lost, since the home directory and the volumes
   * both outlive it.
   */
  async provision(
    request: Parameters<SandboxProvider["provision"]>[0],
    context: AdapterContext,
  ): Promise<ComputerRef> {
    const volumeHome = request.volumeHome;
    const res = await fetch(this.url("/computers"), {
      method: "POST",
      headers: { ...this.headers(context, request.botId), "content-type": "application/json" },
      body: JSON.stringify({
        botId: request.botId,
        homePath: request.homePath,
        spaceId: context.spaceId,
        userId: context.userId,
        ...(request.skillsBotId && { skillsBotId: request.skillsBotId }),
        ...(volumeHome && {
          volumeHome: {
            root: volumeHome.root,
            mounts: volumeHome.mounts.map((mount) => ({
              volume: mount.volumeRef,
              path: mount.path,
            })),
          },
        }),
      }),
      signal: context.signal,
    });
    if (res.status === 429) {
      cancelResponseBody(res);
      throw new ComputerCapacityError();
    }
    if (!res.ok) {
      const detail = await safeBody(res, context.signal);
      throw new Error(`sandbox provision failed: ${res.status} ${detail}`.trim());
    }
    const body = z
      .object({
        id: z.string().min(1),
        resumed: z.boolean().optional(),
        releaseRef: z.string().min(1).optional(),
      })
      .parse(await readSandboxJson(res, context.signal));
    const computer: ComputerRef = {
      id: body.id,
      botId: request.botId,
      kind: "docker",
      providerRef: body.id,
      releaseRef: body.releaseRef ?? null,
      fresh: body.resumed !== true,
    };
    if (volumeHome) {
      // `~/workspace` leads to the same files a worker sees, at their absolute paths.
      let stderr = "";
      let code: number | undefined;
      for await (const event of this.execute(
        computer,
        { argv: ["bash", "-c", linkWorkspaceCommand(volumeHome.root, "/home/tangow/workspace")] },
        context,
      )) {
        if (event.type === "stderr") stderr += event.data;
        if (event.type === "exit") code = event.code;
      }
      if (code !== 0) {
        throw new Error(stderr.trim() || "could not link the computer workspace to its volumes");
      }
    }
    return computer;
  }

  async prepare(_computer: ComputerRef, _context: AdapterContext): Promise<void> {}

  async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    const res = await fetch(this.url(`/computers/${computer.id}/exec`), {
      method: "POST",
      headers: { ...this.headers(context, computer.botId), "content-type": "application/json" },
      body: JSON.stringify({
        ...request,
        cwd: dockerCwd(request.cwd),
        timeoutMs: boundedSandboxCommandTimeoutMs(request.timeoutMs),
      }),
      signal: context.signal,
    });
    if (!res.ok) {
      yield { type: "stderr", data: `exec failed: ${res.status}` };
      yield { type: "exit", code: 1 };
      return;
    }
    const body = await readSandboxJson<{ stdout: string; stderr: string; code: number }>(
      res,
      context.signal,
    );
    if (body.stdout) yield { type: "stdout", data: body.stdout };
    if (body.stderr) yield { type: "stderr", data: body.stderr };
    yield { type: "exit", code: body.code };
  }

  async pageBrowser(
    computer: ComputerRef,
    request: PageBrowserCommand,
    context: AdapterContext,
  ): Promise<PageBrowserResult> {
    const res = await fetch(this.url(`/computers/${computer.id}/browser`), {
      method: "POST",
      headers: { ...this.headers(context, computer.botId), "content-type": "application/json" },
      body: JSON.stringify(request),
      redirect: "error",
      signal: context.signal,
    });
    if (!res.ok) throw new Error(`page browser failed: ${res.status}`);
    return readSandboxJson<PageBrowserResult>(res, context.signal, 512 * 1024);
  }

  async connectScreen(
    computer: ComputerRef,
    request: ScreenRequest,
    context: AdapterContext,
  ): Promise<ScreenSession> {
    const res = await fetch(this.url(`/computers/${computer.id}/screen-mode`), {
      method: "POST",
      headers: { ...this.headers(context, computer.botId), "content-type": "application/json" },
      body: JSON.stringify({
        interactive: request.interactive === true,
        controlToken: request.controlToken,
        revokeControl: false,
      }),
      signal: context.signal,
    });
    if (!res.ok) {
      const detail = await safeBody(res, context.signal);
      if (/cannot allocate another screen/i.test(detail)) {
        throw new Error("This Team Computer cannot allocate another screen.");
      }
      throw new ComputerScreenUnavailableError();
    }
    const body = await readSandboxJson<{ screenUrl?: string }>(res, context.signal);
    return {
      url: body.screenUrl ?? this.url(`/computers/${computer.id}/screen`),
      mimeType: "text/html",
      close: async () => undefined,
    };
  }

  async setScreenControl(
    computer: ComputerRef,
    interactive: boolean,
    context: AdapterContext,
    controlToken?: string,
  ) {
    const res = await fetch(this.url(`/computers/${computer.id}/screen-mode`), {
      method: "POST",
      headers: { ...this.headers(context, computer.botId), "content-type": "application/json" },
      body: JSON.stringify({ interactive, controlToken }),
      signal: context.signal,
    });
    if (!res.ok) throw new Error(`sandbox screen mode failed: ${res.status}`);
  }

  async sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    lease: ControlLeaseRef,
    context: AdapterContext,
  ): Promise<void> {
    const res = await fetch(this.url(`/computers/${computer.id}/input`), {
      method: "POST",
      headers: { ...this.headers(context, computer.botId), "content-type": "application/json" },
      body: JSON.stringify({ input, leaseId: lease.leaseId }),
      signal: context.signal,
    });
    if (!res.ok) {
      const detail = await safeBody(res, context.signal);
      throw new Error(`sandbox input failed: ${res.status} ${detail}`.trim());
    }
  }

  async observe(computer: ComputerRef, context: AdapterContext): Promise<ComputerObservation> {
    const res = await fetch(this.url(`/computers/${computer.id}/observe`), {
      method: "POST",
      headers: this.headers(context, computer.botId),
      signal: context.signal,
    });
    if (!res.ok)
      throw new Error(
        `sandbox observation failed: ${res.status} ${await safeBody(res, context.signal)}`.trim(),
      );
    const body = await readSandboxJson<{
      image: string;
      mimeType: "image/png" | "image/jpeg";
      width: number;
      height: number;
      cursor?: { x: number; y: number };
      activeWindow?: { id: string; title?: string };
    }>(res, context.signal);
    return computerObservation(Uint8Array.from(Buffer.from(body.image, "base64")), {
      mimeType: body.mimeType,
      width: body.width,
      height: body.height,
      cursor: body.cursor,
      activeWindow: body.activeWindow,
    });
  }

  async act(computer: ComputerRef, request: ComputerActionRequest, context: AdapterContext) {
    const actions = boundedComputerActions(request.actions);
    const res = await fetch(this.url(`/computers/${computer.id}/actions`), {
      method: "POST",
      headers: { ...this.headers(context, computer.botId), "content-type": "application/json" },
      body: JSON.stringify({
        actions,
        observe: request.observe,
        settleMs: clampRounded(request.settleMs ?? 0, 0, 5_000),
      }),
      signal: context.signal,
    });
    if (!res.ok)
      throw new Error(
        `sandbox action failed: ${res.status} ${await safeBody(res, context.signal)}`.trim(),
      );
    const body = await readSandboxJson<{
      completed: number;
      observation?: {
        image: string;
        mimeType: "image/png" | "image/jpeg";
        width: number;
        height: number;
        cursor?: { x: number; y: number };
        activeWindow?: { id: string; title?: string };
      };
    }>(res, context.signal);
    return {
      completed: body.completed,
      ...(body.observation
        ? {
            observation: computerObservation(
              Uint8Array.from(Buffer.from(body.observation.image, "base64")),
              body.observation,
            ),
          }
        : {}),
    };
  }

  async listFiles(
    computer: ComputerRef,
    directory: string,
    context: AdapterContext,
  ): Promise<ComputerFileEntry[]> {
    const path = normalizeWorkspacePath(directory);
    const res = await fetch(
      this.url(`/computers/${computer.id}/files?path=${encodeURIComponent(path)}&mode=list`),
      { headers: this.headers(context, computer.botId), signal: context.signal },
    );
    if (!res.ok) throw new Error(`sandbox file listing failed: ${res.status}`);
    return readSandboxJson<ComputerFileEntry[]>(res, context.signal);
  }

  async readFile(
    computer: ComputerRef,
    filePath: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ) {
    const path = normalizeWorkspacePath(filePath);
    const maxBytes = options?.maxBytes;
    const res = await fetch(
      this.url(
        `/computers/${computer.id}/files?path=${encodeURIComponent(path)}&mode=read${maxBytes === undefined ? "" : `&maxBytes=${maxBytes}`}`,
      ),
      { headers: this.headers(context, computer.botId), signal: context.signal },
    );
    if (!res.ok) {
      const detail = await safeBody(res, context.signal);
      throw new Error(`sandbox file read failed: ${res.status} ${detail}`.trim());
    }
    const body = await readSandboxJson<{ content: string }>(
      res,
      context.signal,
      encodedFileResponseLimit(maxBytes),
    );
    return Uint8Array.from(Buffer.from(body.content, "base64"));
  }

  async writeFile(computer: ComputerRef, file: PortableFile, context: AdapterContext) {
    const res = await fetch(this.url(`/computers/${computer.id}/files`), {
      method: "POST",
      headers: { ...this.headers(context, computer.botId), "content-type": "application/json" },
      body: JSON.stringify({
        path: normalizeWorkspacePath(file.path),
        content: Buffer.from(file.content).toString("base64"),
        executable: file.executable === true,
      }),
      signal: context.signal,
    });
    if (!res.ok) throw new Error(`sandbox file write failed: ${res.status}`);
  }

  async *exportWorkspace(computer: ComputerRef, context: AdapterContext) {
    yield* this.walkWorkspace(computer, "", context);
  }

  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ) {
    for await (const file of files) await this.writeFile(computer, file, context);
  }

  async snapshot(computer: ComputerRef, _context: AdapterContext) {
    return { id: `docker-snap-${computer.id}`, createdAt: new Date().toISOString() };
  }

  async releaseScreen(
    computer: ComputerRef,
    context: AdapterContext,
    release: "keep" | "teardown" = "teardown",
  ): Promise<"kept" | "refused" | void> {
    if (!context.botId) return;
    // A cancelled run never leaves a browser behind.
    const keep = release === "keep" && !context.cancelRunWork;
    // Run cancellation must not skip cleanup, but cleanup still needs its own deadline.
    const deadline = requestDeadline(SCREEN_RELEASE_TIMEOUT_MS, "sandbox screen release timed out");
    try {
      const res = await withAbort(
        fetch(this.url(`/computers/${computer.id}/screen`), {
          method: "DELETE",
          headers: {
            ...this.headers(context, computer.botId),
            ...(keep ? { "x-tangow-preserve-screen": "1" } : {}),
          },
          signal: deadline.signal,
        }),
        deadline.signal,
      );
      if (!res.ok && res.status !== 404) {
        throw new Error(`sandbox screen release failed: ${res.status}`);
      }
      const answer = res.ok ? await res.json().catch(() => null) : null;
      if (keep && answer?.kept === true) return "kept";
      if (answer?.released === false) return "refused";
    } finally {
      deadline.dispose();
    }
  }

  async stop(computer: ComputerRef, context: AdapterContext): Promise<void> {
    const res = await fetch(this.url(`/computers/${computer.id}/stop`), {
      method: "POST",
      headers: this.headers(context, computer.botId),
      signal: context.signal,
    });
    // 404 means the supervisor no longer has the container, which is the state we want.
    if (!res.ok && res.status !== 404) {
      throw new Error(
        `sandbox stop failed: ${res.status} ${await safeBody(res, context.signal)}`.trim(),
      );
    }
  }

  async destroy(computer: ComputerRef, context: AdapterContext): Promise<void> {
    const res = await fetch(this.url(`/computers/${computer.id}`), {
      method: "DELETE",
      headers: this.headers(context, computer.botId),
      signal: context.signal,
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(
        `sandbox destroy failed: ${res.status} ${await safeBody(res, context.signal)}`.trim(),
      );
    }
  }

  private async *walkWorkspace(
    computer: ComputerRef,
    directory: string,
    context: AdapterContext,
  ): AsyncIterable<PortableFile> {
    const entries = await this.listFiles(computer, directory, context);
    for (let index = 0; index < entries.length; ) {
      const entry = entries[index]!;
      if (entry.kind === "dir") {
        yield* this.walkWorkspace(computer, entry.path, context);
        index += 1;
        continue;
      }
      const files = [];
      while (index < entries.length && entries[index]?.kind === "file" && files.length < 8) {
        files.push(entries[index]!);
        index += 1;
      }
      const batch = await Promise.all(
        files.map(async (file) => ({
          path: file.path,
          content: await this.readFile(computer, file.path, context),
          executable: file.executable,
        })),
      );
      for (const file of batch) yield file;
    }
  }
}

function requestDeadline(timeoutMs: number, message: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(message)), timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
    },
  };
}

/** A directory under the home, or under `/workspace`; the supervisor maps it onto the workspace. */
function dockerCwd(cwd: string | undefined) {
  if (cwd === "/workspace" || cwd?.startsWith("/workspace/")) {
    return path.posix.join("/workspace", normalizeWorkspacePath(cwd.slice("/workspace".length)));
  }
  if (!cwd || cwd === "." || cwd === "/" || cwd === "/home/tangow") return "/home/tangow";
  const relative = cwd.startsWith("/home/tangow/")
    ? cwd.slice("/home/tangow/".length)
    : normalizeWorkspacePath(cwd);
  return path.posix.join("/home/tangow", relative);
}
