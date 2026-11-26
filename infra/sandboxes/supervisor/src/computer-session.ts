import { randomUUID } from "node:crypto";
import http from "node:http";
import type { z } from "zod";
import type { Computer, ComputerRuntime } from "./computer-runtime.js";
import { ComputerIdentityError } from "./computer-runtime.js";
import {
  resolveTeamScreenLimit,
  screenPorts,
  screenUrlFor,
  XDOTOOL_TYPE_ARGV,
} from "./computer-spec.js";
import type { computerActionSchema, ScreenAssignment } from "./supervisor-logic.js";
import {
  browserProfilePathForScreen,
  containerActionSteps,
  ensureScreenCommand,
  interactiveScreenCommand,
  nextScreenIndex,
  parseObservation,
  releaseAssignedScreen,
  resetManagedScreensCommand,
  sandboxCommandTimedOut,
  sandboxTimeoutCommand,
  stopExtraScreenCommand,
  teardownReleasedScreen,
  withKeyedLock,
} from "./supervisor-logic.js";

const teamScreenLimit = resolveTeamScreenLimit();

type CommandOptions = {
  workingDir?: string;
  env?: string[];
  timeoutMs?: number;
  stdin?: Buffer;
  signal?: AbortSignal;
};

/** What the routes do inside one computer: run commands and keep its screens. */
export function createComputerSession(runtime: ComputerRuntime) {
  const computerScreens = new Map<string, Map<string, ScreenAssignment>>();
  const computerScreenLocks = new Map<string, Promise<unknown>>();
  // Serialize screen claim/release/cancel for one computer so a restart-orphan
  // cancel cannot race a replacement claim and kill the newer Chromium session.
  const withComputerScreenLock = <T>(computerId: string, task: () => Promise<T>) =>
    withKeyedLock(computerScreenLocks, computerId, task);

  async function managedComputer(id: string, botId?: string, spaceId?: string) {
    if (!botId || !spaceId) throw new ComputerIdentityError("missing computer identity");
    return runtime.getComputer({ id, owner: { botId, spaceId } });
  }

  async function runCommand(
    id: string,
    argv: string[],
    options: CommandOptions = {},
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    const timeoutMs = options.timeoutMs;
    const completionMarker = timeoutMs
      ? `/tmp/tangow-command-${randomUUID()}.completed-124`
      : undefined;
    const command =
      completionMarker && timeoutMs !== undefined
        ? sandboxTimeoutCommand(argv, timeoutMs, completionMarker)
        : argv;
    const output = await runtime.exec(id, command, {
      cwd: options.workingDir ?? "/home/tangow",
      env: options.env ?? ["DISPLAY=:1", "HOME=/home/tangow"],
      stdin: options.stdin,
      signal: options.signal,
    });
    const completedWithExit124 =
      output.code === 124 && completionMarker
        ? await consumeCompletionMarker(id, completionMarker)
        : false;
    const timedOut = sandboxCommandTimedOut(output.code, completedWithExit124);
    return {
      stdout: output.stdout,
      stderr: timedOut
        ? `${output.stderr}${output.stderr.endsWith("\n") || output.stderr === "" ? "" : "\n"}command timed out after ${timeoutMs} ms\n`
        : output.stderr,
      code: output.code,
    };
  }

  async function consumeCompletionMarker(id: string, marker: string) {
    const result = await runCommand(id, [
      "sh",
      "-c",
      'if [ -f "$0" ]; then rm -f "$0"; exit 0; fi; exit 1',
      marker,
    ]);
    return result.code === 0;
  }

  async function managedScreen(
    id: string,
    botId: string | undefined,
    spaceId: string | undefined,
    screenId: string | undefined,
    screenLeaseId: string | undefined,
  ) {
    const computer = await managedComputer(id, botId, spaceId);
    return withComputerScreenLock(id, () =>
      ensureManagedScreen(id, computer, botId, screenId, screenLeaseId),
    );
  }

  async function ensureManagedScreen(
    id: string,
    computer: Computer,
    botId: string | undefined,
    screenId: string | undefined,
    screenLeaseId: string | undefined,
  ) {
    let assigned = computerScreens.get(id);
    if (!assigned) {
      const reset = await runCommand(id, ["bash", "-c", resetManagedScreensCommand()]);
      if (reset.code !== 0) throw new Error(reset.stderr || "computer screens failed to reset");
      assigned = new Map();
      computerScreens.set(id, assigned);
    }
    const screenKey = screenId || botId || id;
    const index = nextScreenIndex(assigned, screenKey, screenLeaseId, teamScreenLimit);
    const layout = screenPorts(index);
    const slot = assigned.get(screenKey)!;
    slot.viewToken ??= randomUUID();
    const viewToken = slot.viewToken;
    const ensured = await runCommand(id, [
      "bash",
      "-c",
      ensureScreenCommand(index, screenKey, viewToken),
    ]);
    if (ensured.code !== 0) {
      releaseAssignedScreen(assigned, screenKey);
      await teardownReleasedScreen(assigned, screenKey, index, () =>
        runCommand(id, ["bash", "-c", stopExtraScreenCommand(index, screenKey)]),
      );
      if (assigned.size === 0) computerScreens.delete(id);
      throw new Error(ensured.stderr || `computer screen ${layout.display} failed to start`);
    }
    return {
      computer,
      layout,
      index,
      screenKey,
      browserProfile: browserProfilePathForScreen(screenKey),
      viewToken,
    };
  }

  async function publishedScreenUrl(
    id: string,
    owner: { botId?: string; spaceId?: string },
    containerPort = "6080",
  ) {
    if (!owner.botId || !owner.spaceId)
      throw new ComputerIdentityError("missing computer identity");
    const { screen } = await runtime.getComputer({
      id,
      owner: { botId: owner.botId, spaceId: owner.spaceId },
      screenPort: containerPort,
    });
    if (!screen) throw new Error("computer screen port was not published");
    const ready = await waitForScreenReady(
      screen.host,
      Number(screen.port),
      SCREEN_READY_TIMEOUT_MS,
    );
    if (!ready) throw new Error("computer screen did not become ready in time");
    return screenUrlFor(screen.port, screen.host);
  }

  async function setInteractiveScreen(
    id: string,
    interactive: boolean,
    controlToken: string | undefined,
    layout: ReturnType<typeof screenPorts>,
  ) {
    const result = await runCommand(id, [
      "bash",
      "-c",
      interactiveScreenCommand(interactive, controlToken, layout),
    ]);
    if (result.code !== 0) throw new Error(result.stderr || "control screen failed to start");
    return interactive || !controlToken || result.stdout.includes("TANGOW_CONTROL_RELEASED\n");
  }

  async function applyComputerActions(
    id: string,
    actions: Array<z.infer<typeof computerActionSchema>>,
    display = ":1",
    browserProfile?: string,
    workspace?: string,
  ) {
    // The steps hold typed text: they come on stdin, and xdotool types it from its own stdin.
    const script = [
      "import json, subprocess, sys, time",
      "for step in json.load(sys.stdin):",
      "  if 'waitMs' in step: time.sleep(step['waitMs'] / 1000)",
      "  else:",
      "    argv = step['argv']",
      `    if argv[2:6] == ${JSON.stringify(XDOTOOL_TYPE_ARGV)}:`,
      "      result = subprocess.run(argv[:5] + ['--file', '-'], input=argv[6].encode())",
      "    else: result = subprocess.run(argv)",
      "    if result.returncode: sys.exit(result.returncode)",
    ].join("\n");
    const result = await runCommand(id, ["python3", "-c", script], {
      stdin: Buffer.from(
        JSON.stringify(containerActionSteps(actions, display, browserProfile, workspace)),
      ),
    });
    if (result.code !== 0) throw new Error(result.stderr || "computer action failed");
  }

  async function observeComputer(id: string, display = ":1") {
    const command = [
      "set -e",
      `export DISPLAY=${display}`,
      'printf "GEOM %s\\n" "$(xdotool getdisplaygeometry 2>/dev/null || echo 1280 800)"',
      'printf "CURSOR %s\\n" "$(xdotool getmouselocation --shell 2>/dev/null | tr "\\n" " " || true)"',
      'wid="$(xdotool getactivewindow 2>/dev/null || true)"',
      'printf "WINDOW %s\\n" "$wid"',
      'printf "TITLE %s\\n" "$(test -n "$wid" && xdotool getwindowname "$wid" 2>/dev/null || true)"',
      'printf "IMAGE "',
      "import -window root png:- 2>/dev/null | base64 -w0",
      'printf "\\n"',
    ].join("; ");
    const result = await runCommand(id, ["bash", "-lc", command]);
    if (result.code !== 0) throw new Error(result.stderr || "screen capture failed");
    return parseObservation(result.stdout);
  }

  async function writeComputerFile(
    id: string,
    target: string,
    content: Buffer,
    executable = false,
  ) {
    const script = [
      "import os, sys",
      "target = sys.argv[1]",
      "os.makedirs(os.path.dirname(target), exist_ok=True)",
      "with open(target, 'wb') as f: f.write(sys.stdin.buffer.read())",
      `os.chmod(target, ${executable ? "0o700" : "0o600"})`,
    ].join("\n");
    const result = await runtime.exec(id, ["python3", "-c", script, target], {
      cwd: "/home/tangow",
      env: ["HOME=/home/tangow"],
      stdin: content,
    });
    if (result.code !== 0) throw new Error(result.stderr || result.stdout || "file write failed");
  }

  return {
    computerScreens,
    withComputerScreenLock,
    managedComputer,
    runCommand,
    managedScreen,
    ensureManagedScreen,
    publishedScreenUrl,
    setInteractiveScreen,
    applyComputerActions,
    observeComputer,
    writeComputerFile,
  };
}

export type ComputerSession = ReturnType<typeof createComputerSession>;

export const SCREEN_READY_TIMEOUT_MS = 45_000;

// Docker publishes a container's port mapping (or assigns its internal IP)
// almost immediately on start, well before the process inside the container
// is actually listening on it (Xvfb, the browser, x11vnc, then websockify
// all start in sequence — see infra/sandboxes/computer/start.sh). Returning
// the URL as soon as the mapping exists lets the frontend iframe race the
// container's own boot sequence and hit "socket hang up" on first load.
//
// A bare TCP connect isn't a strong enough signal either: it only proves the
// port is accepting connections, not that websockify is actually up and
// serving — the same race can still slip through between "port open" and
// "websockify ready" (e.g. right after setInteractiveScreen starts a new
// x11vnc/websockify pair on the control port for a takeover). An HTTP GET
// for noVNC's stock page only succeeds once websockify itself is answering
// requests, closing that gap too.
export async function waitForScreenReady(host: string, port: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  do {
    const ready = await new Promise<boolean>((resolve) => {
      const req = http.get({ host, port, path: "/vnc.html", timeout: 1_500 }, (res) => {
        res.resume();
        const status = res.statusCode ?? 0;
        resolve(status >= 200 && status < 300);
      });
      req.once("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.once("error", () => resolve(false));
    });
    if (ready) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  } while (Date.now() < deadline);
  return false;
}
