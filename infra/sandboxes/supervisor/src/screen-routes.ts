import { readBoundedJsonResponse } from "@tangow/core";
import type { Hono } from "hono";
import { z } from "zod";
import type { ComputerSession } from "./computer-session.js";
import {
  screenPorts,
  screenUrlWithToken,
  XDOTOOL_TYPE_STDIN,
  xdotoolCommand,
} from "./computer-spec.js";
import {
  attemptComputerControl,
  ComputerControlUnavailableError,
  computerActionSchema,
  computerControlTimeoutMs,
  containerActionSteps,
  interactiveScreenCommand,
  isComputerControlUnavailable,
  keepReleasedScreen,
  preferComputerControl,
  releaseAssignedScreen,
  screenReleaseStopCommand,
  shouldReplayComputerActions,
  teardownReleasedScreen,
  toSandboxInput,
} from "./supervisor-logic.js";

/** The routes that drive a computer's screens: browser, desktop control, viewer and input. */
export function registerScreenRoutes(app: Hono, session: ComputerSession) {
  const {
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
  } = session;

  app.post("/computers/:id/browser", async (c) => {
    // Read eagerly so the Node HTTP adapter observes disconnects during screen setup too.
    const signal = c.req.raw.signal;
    signal.throwIfAborted();
    const body = z
      .discriminatedUnion("command", [
        z.object({
          command: z.literal("navigate"),
          url: z
            .string()
            .url()
            .max(8192)
            .refine((value) => {
              if (!URL.canParse(value)) return false;
              const url = new URL(value);
              return /^https?:$/.test(url.protocol) && !url.username && !url.password;
            }),
        }),
        z.object({ command: z.literal("snapshot") }),
        z.object({
          command: z.literal("act"),
          actions: z
            .array(
              z.discriminatedUnion("kind", [
                z.object({ kind: z.literal("click"), ref: z.string().min(1).max(200) }),
                z.object({
                  kind: z.enum(["fill", "type"]),
                  ref: z.string().min(1).max(200),
                  text: z.string().max(32_000),
                }),
              ]),
            )
            .min(1)
            .max(24),
        }),
      ])
      .parse(await c.req.json());
    try {
      const id = c.req.param("id");
      const { layout } = await managedScreen(
        id,
        c.req.header("x-tangow-bot-id"),
        c.req.header("x-tangow-space-id"),
        c.req.header("x-tangow-screen-id"),
        c.req.header("x-tangow-screen-lease-id"),
      );
      const result = await runCommand(id, ["/usr/local/bin/tangow-page-browser", body.command], {
        // Typed text may be a password: the request is the first stdin line, never argv.
        stdin: Buffer.from(`${JSON.stringify(body)}\n`),
        env: [
          `DISPLAY=${layout.display}`,
          `TANGOW_CDP_PORT=${layout.debugPort}`,
          "HOME=/home/tangow",
          "TANGOW_BROWSER_WATCH_STDIN=1",
        ],
        timeoutMs: 25_000,
        signal,
      });
      // A nonzero exit or malformed output cannot establish which mutations ran.
      if (result.code !== 0 || Buffer.byteLength(result.stdout) > 512 * 1024) {
        throw new Error("Page browser unavailable or interrupted");
      }
      return c.json(JSON.parse(result.stdout));
    } catch {
      return c.json({
        ok: false,
        fallback: "computer_act",
        uncertain: body.command === "act",
        error: "Page browser unavailable or interrupted. Inspect the screen before continuing.",
      });
    }
  });

  app.post("/computers/:id/observe", async (c) => {
    try {
      const id = c.req.param("id");
      const { computer, layout, browserProfile } = await managedScreen(
        id,
        c.req.header("x-tangow-bot-id"),
        c.req.header("x-tangow-space-id"),
        c.req.header("x-tangow-screen-id"),
        c.req.header("x-tangow-screen-lease-id"),
      );
      const control = computer.control;
      const observation = await preferComputerControl(
        control
          ? async () => {
              const result = await controlDesktop(
                control,
                [],
                layout.display,
                browserProfile,
                true,
                0,
              );
              if (!result.observation) throw new Error("computer control returned no observation");
              return result.observation;
            }
          : undefined,
        () => observeComputer(id, layout.display),
      );
      return c.json(observation);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message }, 500);
    }
  });

  app.post("/computers/:id/actions", async (c) => {
    const body = z
      .object({
        actions: z.array(computerActionSchema).max(24),
        observe: z.boolean().optional(),
        settleMs: z.number().min(0).max(5_000).optional(),
      })
      .parse(await c.req.json());
    try {
      const id = c.req.param("id");
      const { computer, layout, browserProfile } = await managedScreen(
        id,
        c.req.header("x-tangow-bot-id"),
        c.req.header("x-tangow-space-id"),
        c.req.header("x-tangow-screen-id"),
        c.req.header("x-tangow-screen-lease-id"),
      );
      const { control, workspace } = computer;
      const attempt = await attemptComputerControl(
        control
          ? () =>
              controlDesktop(
                control,
                body.actions,
                layout.display,
                browserProfile,
                body.observe !== false,
                body.settleMs ?? 0,
                workspace,
              )
          : undefined,
      );
      if (attempt.status === "failed") throw attempt.error;
      const controlResult = attempt.status === "ok" ? attempt.value : undefined;
      if (shouldReplayComputerActions(attempt) && body.actions.length)
        await applyComputerActions(id, body.actions, layout.display, browserProfile, workspace);
      if (shouldReplayComputerActions(attempt) && body.settleMs)
        await new Promise((resolve) => setTimeout(resolve, body.settleMs));
      return c.json({
        completed: controlResult?.completed ?? body.actions.length,
        ...(body.observe === false
          ? {}
          : {
              observation:
                controlResult?.observation ?? (await observeComputer(id, layout.display)),
            }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message }, 500);
    }
  });

  app.get("/computers/:id/screen", async (c) => {
    const id = c.req.param("id");
    const botId = c.req.header("x-tangow-bot-id");
    const spaceId = c.req.header("x-tangow-space-id");
    try {
      const { layout, viewToken } = await managedScreen(
        id,
        botId,
        spaceId,
        c.req.header("x-tangow-screen-id"),
        c.req.header("x-tangow-screen-lease-id"),
      );
      const screenUrl = await publishedScreenUrl(id, { botId, spaceId }, layout.viewPort);
      return c.redirect(screenUrlWithToken(screenUrl, viewToken));
    } catch {
      return c.json({ error: "computer not found" }, 404);
    }
  });

  app.post("/computers/:id/screen-mode", async (c) => {
    const body = z
      .object({
        interactive: z.boolean(),
        controlToken: z
          .string()
          .regex(/^[A-Za-z0-9_-]{1,128}$/)
          .optional(),
        revokeControl: z.boolean().optional(),
      })
      .refine((value) => !value.interactive || value.controlToken, {
        message: "interactive screen requires a control token",
      })
      .parse(await c.req.json());
    try {
      const id = c.req.param("id");
      const botId = c.req.header("x-tangow-bot-id");
      const spaceId = c.req.header("x-tangow-space-id");
      const screenId = c.req.header("x-tangow-screen-id");
      const screenLeaseId = c.req.header("x-tangow-screen-lease-id");
      const computer = await managedComputer(id, botId, spaceId);
      const { layout, viewToken } = await withComputerScreenLock(id, async () => {
        const screen = await ensureManagedScreen(id, computer, botId, screenId, screenLeaseId);
        if (body.interactive || body.revokeControl !== false) {
          await setInteractiveScreen(id, body.interactive, body.controlToken, screen.layout);
        }
        return screen;
      });
      const screenUrl = await publishedScreenUrl(
        id,
        { botId, spaceId },
        body.interactive ? layout.controlPort : layout.viewPort,
      );
      return c.json({
        screenUrl: screenUrlWithToken(screenUrl, body.interactive ? body.controlToken! : viewToken),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message }, 400);
    }
  });

  app.post("/computers/:id/input", async (c) => {
    const id = c.req.param("id");
    const body = z
      .object({
        input: z.object({
          kind: z.enum(["key", "pointer", "clipboard"]),
          key: z.string().optional(),
          modifiers: z.array(z.string()).optional(),
          x: z.number().optional(),
          y: z.number().optional(),
          button: z.enum(["left", "right"]).optional(),
          type: z.enum(["move", "down", "up", "click"]).optional(),
          text: z.string().optional(),
        }),
        leaseId: z.string().optional(),
      })
      .parse(await c.req.json());
    const input = toSandboxInput(body.input);
    try {
      const { layout } = await managedScreen(
        id,
        c.req.header("x-tangow-bot-id"),
        c.req.header("x-tangow-space-id"),
        c.req.header("x-tangow-screen-id"),
        c.req.header("x-tangow-screen-lease-id"),
      );
      // Typed text may be a password: xdotool types it from stdin, never argv.
      const result = await runCommand(
        id,
        [
          "env",
          `DISPLAY=${layout.display}`,
          ...(input.kind === "clipboard" ? XDOTOOL_TYPE_STDIN : xdotoolCommand(input)),
        ],
        input.kind === "clipboard" ? { stdin: Buffer.from(input.text) } : {},
      );
      if (result.code !== 0) {
        return c.json({ ok: false, error: "input failed" }, 500);
      }
      return c.json({ ok: true, leaseId: body.leaseId ?? null });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ ok: false, error: message }, 500);
    }
  });

  app.delete("/computers/:id/screen", async (c) => {
    try {
      const id = c.req.param("id");
      await managedComputer(id, c.req.header("x-tangow-bot-id"), c.req.header("x-tangow-space-id"));
      const screenId = c.req.header("x-tangow-screen-id") || c.req.header("x-tangow-bot-id") || id;
      const cancelRunWork = c.req.header("x-tangow-cancel-run-work") === "1";
      const screenLeaseId = c.req.header("x-tangow-screen-lease-id");
      // Only a leased release can be kept: a bot's deletion or archive has none and must close it.
      const preserve =
        c.req.header("x-tangow-preserve-screen") === "1" &&
        !cancelRunWork &&
        Boolean(screenLeaseId);
      let kept = false;
      let refused = false;
      await withComputerScreenLock(id, async () => {
        const assigned = computerScreens.get(id);
        const index = assigned
          ? releaseAssignedScreen(assigned, screenId, screenLeaseId)
          : undefined;
        // A newer run owns the slot: the caller must not treat its screen as released.
        refused = Boolean(screenLeaseId && assigned?.has(screenId) && index === undefined);
        if (preserve && assigned && index !== undefined) {
          // Revoking control disconnects the run's input while the display and browser stay up.
          // A revoke that fails or throws falls through to the normal teardown.
          const revoked = await runCommand(id, [
            "bash",
            "-c",
            interactiveScreenCommand(false, undefined, screenPorts(index)),
          ]).catch(() => undefined);
          if (revoked?.code === 0) {
            keepReleasedScreen(assigned, screenId, index);
            kept = true;
            return;
          }
        }
        const stop = screenReleaseStopCommand(index, {
          hasRegistry: Boolean(assigned),
          cancelRunWork,
          screenId,
        });
        if (assigned && index !== undefined) {
          await teardownReleasedScreen(assigned, screenId, index, () =>
            runCommand(id, ["bash", "-c", stop]),
          );
        } else if (stop) {
          const result = await runCommand(id, ["bash", "-c", stop]);
          if (result.code !== 0) {
            throw new Error(result.stderr || "computer screen failed to stop");
          }
        }
        if (assigned?.size === 0) computerScreens.delete(id);
      });
      if (kept) return c.json({ ok: true, kept });
      return c.json(refused ? { ok: true, released: false } : { ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message }, 404);
    }
  });
}

export const MAX_COMPUTER_CONTROL_RESPONSE_BYTES = 16 * 1024 * 1024;

export async function controlDesktop(
  endpoint: { url: string; token: string },
  actions: Array<z.infer<typeof computerActionSchema>>,
  display: string,
  browserProfile: string,
  observe: boolean,
  settleMs: number,
  workspace?: string,
) {
  const signal = AbortSignal.timeout(computerControlTimeoutMs(actions, settleMs));
  let response: Response;
  try {
    response = await fetch(endpoint.url, {
      method: "POST",
      // The computer can replace its listener; keep requests on the inspected
      // computer's fixed endpoint instead of following it across sandbox networks.
      redirect: "error",
      headers: {
        authorization: `Bearer ${endpoint.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        steps: containerActionSteps(actions, display, browserProfile, workspace),
        display,
        observe,
        settleMs,
      }),
      signal,
    });
  } catch (error) {
    if (isComputerControlUnavailable(error)) {
      throw new ComputerControlUnavailableError(
        error instanceof Error ? error.message : "computer control unavailable",
      );
    }
    throw error;
  }
  const payload = await readBoundedJsonResponse<{
    completed?: unknown;
    observation?: unknown;
    error?: unknown;
  }>(response, MAX_COMPUTER_CONTROL_RESPONSE_BYTES, signal);
  if (!response.ok) throw new Error(String(payload.error ?? "computer control failed"));
  if (typeof payload.completed !== "number")
    throw new Error("computer control returned no completion count");
  return {
    completed: payload.completed,
    ...(payload.observation ? { observation: payload.observation } : {}),
  };
}
