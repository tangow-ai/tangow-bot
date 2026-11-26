import type { CommandHandle, CommandStartOpts } from "@e2b/desktop";
import { CommandExitError } from "@e2b/desktop";
import type { PageBrowserCommand } from "@tangow/adapter-kit";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { fakeE2BMachine } from "./e2b-machine.test-support.js";
import type { E2BSandboxSdk } from "./e2b-sandbox.js";
import { E2BSandboxProvider } from "./e2b-sandbox.js";
import { desktopCommandResponder } from "./linux-desktop.test-support.js";

const computer = { id: "machine", providerRef: "machine", kind: "e2b" as const, botId: "home" };
const context = {
  operationId: "browser-test",
  traceId: "browser-test",
  spaceId: "space",
  userId: "user",
  botId: "bot",
  screenLeaseId: "run:1",
  signal: new AbortController().signal,
};
const act: PageBrowserCommand = {
  command: "act",
  actions: [
    { kind: "click", ref: "e1" },
    { kind: "fill", ref: "e2", text: "value" },
  ],
};
const snapshot = {
  ok: true,
  url: "http://fixture.test",
  title: "Fixture",
  tree: "Form",
  elements: [{ ref: "e1", role: "button", name: "Save" }],
};

function fixture(
  options: {
    output?: string;
    code?: number;
    start?: () => void;
    send?: () => void;
    wait?: (signal: AbortSignal) => Promise<void>;
  } = {},
) {
  const machine = fakeE2BMachine("machine");
  const respond = desktopCommandResponder();
  let execution: CommandStartOpts | undefined;
  const handle = {
    pid: 123,
    sendStdin: vi.fn(async (_input: string) => options.send?.()),
    closeStdin: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    wait: async () => {
      await options.wait?.(execution!.signal!);
      const output = options.output ?? JSON.stringify(snapshot);
      await execution!.onStdout?.(output);
      const result = { stdout: output, stderr: "", exitCode: options.code ?? 0 };
      if (result.exitCode) throw new CommandExitError(result);
      return result;
    },
  };
  machine.sandbox.commands.run = vi.fn(async (command: string, opts?: CommandStartOpts) => {
    if (opts?.background) {
      execution = opts;
      options.start?.();
      return handle as unknown as CommandHandle;
    }
    return respond(command) ?? { stdout: "", stderr: "", exitCode: 0 };
  }) as typeof machine.sandbox.commands.run;
  machine.sandbox.commands.kill = vi.fn(async () => true);
  const sdk = { connect: async () => machine.sandbox } as unknown as E2BSandboxSdk;
  return {
    provider: new E2BSandboxProvider("test-key", sdk),
    handle,
    machine,
    get signal() {
      return execution?.signal;
    },
  };
}

describe("E2B page browser transport boundary", () => {
  it.each([
    { label: "valid snapshot", output: JSON.stringify(snapshot), ok: true },
    { label: "malformed JSON", output: "not JSON", ok: false },
    {
      label: "invalid node",
      output: JSON.stringify({ ...snapshot, elements: [{ ref: "e1" }] }),
      ok: false,
    },
    { label: "oversized stream", output: "x".repeat(512 * 1024 + 1), ok: false },
    { label: "nonzero success payload", output: JSON.stringify(snapshot), code: 1, ok: false },
  ])("validates $label before exposing a result", async ({ output, code, ok }) => {
    const f = fixture({ output, code });
    const result = await f.provider.pageBrowser(computer, { command: "snapshot" }, context);
    expect(result.ok).toBe(ok);
    if (!ok) expect(result.fallback).toBe("computer_act");
    expect(f.handle.sendStdin).toHaveBeenCalledTimes(1);
    expect(f.handle.closeStdin).toHaveBeenCalledTimes(1);
  });

  it("sends the request after the permit on stdin, never in the command line", async () => {
    const f = fixture({ output: JSON.stringify({ ...snapshot, completed: 2 }) });
    await f.provider.pageBrowser(computer, act, context);
    expect(f.handle.sendStdin.mock.calls[0]?.[0]).toBe(
      'TANGOW_DESKTOP_OPERATION\n{"command":"act","actions":[{"kind":"click","ref":"e1"},{"kind":"fill","ref":"e2","text":"value"}]}\n',
    );
    const started = vi
      .mocked(f.machine.sandbox.commands.run)
      .mock.calls.find(([, opts]) => opts?.background);
    expect(started?.[0]).not.toContain('"text"');
  });

  it.each([0, 1])(
    "retains partial progress and ambiguity after a structured action failure with exit %s",
    async (code) => {
      const failure = {
        ok: false,
        completed: 1,
        uncertain: true,
        error: "response lost",
        fallback: "computer_act",
      };
      const f = fixture({ output: JSON.stringify(failure), code });
      expect(await f.provider.pageBrowser(computer, act, context)).toEqual(failure);
    },
  );

  it.each([0, 1, 3])("rejects incomplete or impossible success progress %s", async (completed) => {
    const f = fixture({ output: JSON.stringify({ ...snapshot, completed }) });
    expect(await f.provider.pageBrowser(computer, act, context)).toMatchObject({
      ok: false,
      uncertain: true,
    });
  });

  it("never sends the permit when startup fails before returning a handle", async () => {
    const f = fixture({
      start: () => {
        throw new Error("startup response lost");
      },
    });
    expect(await f.provider.pageBrowser(computer, act, context)).toMatchObject({
      ok: false,
      uncertain: false,
    });
    expect(f.handle.sendStdin).not.toHaveBeenCalled();
  });

  it("cancels pending admission metadata without dispatching a helper", async () => {
    const controller = new AbortController();
    const f = fixture();
    f.machine.sandbox.getInfo = () => new Promise(() => {});
    const pending = f.provider.pageBrowser(computer, act, {
      ...context,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(f.handle.sendStdin).not.toHaveBeenCalled();
  });

  it("refuses a late handle before the abort timer fires, then cleans it without a permit", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now");
    onTestFinished(() => clock.mockRestore());
    const f = fixture({
      output: JSON.stringify({ ...snapshot, completed: 2 }),
      start: () => clock.mockReturnValue(now + 26_000),
    });
    const result = await f.provider.pageBrowser(computer, act, context);
    expect(f.signal?.aborted).toBe(false);
    expect(f.handle.sendStdin).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      uncertain: false,
    });
    expect(f.handle.closeStdin).toHaveBeenCalledTimes(1);
    expect(f.machine.sandbox.commands.kill).toHaveBeenCalledWith(
      123,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("cleans a handle acquired after cancellation without permitting it", async () => {
    const controller = new AbortController();
    const f = fixture({ start: () => controller.abort() });
    await expect(
      f.provider.pageBrowser(computer, act, { ...context, signal: controller.signal }),
    ).rejects.toThrow();
    expect(f.handle.sendStdin).not.toHaveBeenCalled();
    expect(f.handle.closeStdin).toHaveBeenCalledTimes(1);
    expect(f.machine.sandbox.commands.kill).toHaveBeenCalledWith(
      123,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("treats an ambiguous permit send as uncertain and never retries it", async () => {
    const f = fixture({
      send: () => {
        throw new Error("permit acknowledgement lost");
      },
    });
    expect(await f.provider.pageBrowser(computer, act, context)).toMatchObject({
      ok: false,
      uncertain: true,
    });
    expect(f.handle.sendStdin).toHaveBeenCalledTimes(1);
    expect(f.machine.sandbox.commands.kill).not.toHaveBeenCalled();
  });
});
