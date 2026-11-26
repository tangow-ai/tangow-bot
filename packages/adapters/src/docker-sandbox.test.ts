import type { ProcessEvent } from "@tangow/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputerCapacityError } from "./computer-lifecycle.js";
import { isComputerScreenUnavailable } from "./computer-screens.js";
import {
  DockerSandboxProvider,
  MAX_SANDBOX_ERROR_RESPONSE_BYTES,
  MAX_SANDBOX_SUCCESS_RESPONSE_BYTES,
  SCREEN_RELEASE_TIMEOUT_MS,
} from "./docker-sandbox.js";

const context = {
  operationId: "docker-test",
  traceId: "docker-test",
  spaceId: "workspace",
  userId: "user",
  botId: "bot",
  screenLeaseId: "run-1:1",
  signal: new AbortController().signal,
};

describe("Docker sandbox", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reports the actual provisioned image separately from the desired image", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/computers/release")
          ? Response.json({ releaseRef: "sha256:new-image" })
          : Response.json({ id: "machine", resumed: true, releaseRef: "sha256:old-image" }),
      ),
    );
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    expect(await provider.currentRelease(context)).toBe("sha256:new-image");
    expect(await provider.provision({ botId: "bot", homePath: "/tmp/bot" }, context)).toMatchObject(
      { releaseRef: "sha256:old-image", fresh: false },
    );
  });

  it("sends the bounded timeout to the supervisor and preserves its honest result", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({
        stdout: "partial output\n",
        stderr: "command timed out after 75 ms\n",
        code: 124,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    const events: ProcessEvent[] = [];

    for await (const event of provider.execute(
      { id: "computer", botId: "bot", kind: "docker", providerRef: "computer" },
      { argv: ["sleep", "10"], timeoutMs: 75 },
      context,
    )) {
      events.push(event);
    }

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      argv: ["sleep", "10"],
      cwd: "/home/tangow",
      timeoutMs: 75,
    });
    expect(events).toEqual([
      { type: "stdout", data: "partial output\n" },
      { type: "stderr", data: "command timed out after 75 ms\n" },
      { type: "exit", code: 124 },
    ]);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      "x-tangow-bot-id": "bot",
      "x-tangow-screen-id": "bot",
    });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      "x-request-id": expect.any(String),
      traceparent: expect.stringMatching(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/),
    });
  });

  it("asks for a member's own screen on a shared bot and the bot's for its owner", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({}),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    const computer = { id: "computer", botId: "bot", kind: "docker" as const, providerRef: "c" };

    await provider.releaseScreen(computer, context);
    await provider.releaseScreen(computer, { ...context, memberId: "dana" });

    expect(
      fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get("x-tangow-screen-id")),
    ).toEqual(["bot", "bot:dana"]);
  });

  it("rejects a declared oversized success response without buffering it", async () => {
    const cancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new ReadableStream({ cancel }), {
            headers: { "content-length": String(MAX_SANDBOX_SUCCESS_RESPONSE_BYTES + 1) },
          }),
      ),
    );
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");

    await expect(
      provider.provision({ botId: "bot", homePath: "/tmp/bot" }, context),
    ).rejects.toThrow(`sandbox response exceeds ${MAX_SANDBOX_SUCCESS_RESPONSE_BYTES} bytes`);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });

  it("surfaces a screen the supervisor failed to start as unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: "computer screen did not become ready in time" }, { status: 400 }),
      ),
    );
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");

    const error = await provider
      .connectScreen(
        { id: "computer", botId: "bot", kind: "docker", providerRef: "computer" },
        { view: "stream" },
        context,
      )
      .catch((caught: unknown) => caught);
    expect(isComputerScreenUnavailable(error)).toBe(true);
  });

  it("reports computer capacity for a provision 429 without a supervisor message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 429 })),
    );
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");

    await expect(
      provider.provision({ botId: "bot", homePath: "/tmp/bot" }, context),
    ).rejects.toBeInstanceOf(ComputerCapacityError);
  });

  it("stops a streamed file response at the caller-derived encoded limit", async () => {
    const cancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(1029));
              },
              cancel,
            }),
          ),
      ),
    );
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");

    await expect(
      provider.readFile(
        { id: "computer", botId: "bot", kind: "docker", providerRef: "computer" },
        "small.txt",
        context,
        { maxBytes: 1 },
      ),
    ).rejects.toThrow("sandbox response exceeds 1028 bytes");
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });

  it("accepts a valid encoded envelope above the generic response cap", async () => {
    const maxBytes = 13 * 1024 * 1024;
    const encodedLimit = Math.ceil(maxBytes / 3) * 4 + 1024;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response('{"content":""}', {
            headers: { "content-length": String(encodedLimit) },
          }),
      ),
    );
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");

    await expect(
      provider.readFile(
        { id: "computer", botId: "bot", kind: "docker", providerRef: "computer" },
        "large.bin",
        context,
        { maxBytes },
      ),
    ).resolves.toEqual(new Uint8Array());
  });

  it("releases this bot's screen assignment through the supervisor", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");

    await provider.releaseScreen(
      { id: "computer", botId: "home-bot", kind: "docker", providerRef: "computer" },
      context,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://supervisor.test/computers/computer/screen",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({
          authorization: "Bearer test-token",
          "x-tangow-bot-id": "home-bot",
          "x-tangow-screen-id": "bot",
          "x-tangow-screen-lease-id": "run-1:1",
          "x-tangow-space-id": "workspace",
        }),
      }),
    );
  });

  it("asks the supervisor to keep the screen and reports that it was kept", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ ok: true, kept: true }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    const computer = {
      id: "computer",
      botId: "home-bot",
      kind: "docker",
      providerRef: "computer",
    } as const;

    await expect(provider.releaseScreen(computer, context, "keep")).resolves.toBe("kept");
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      "x-tangow-preserve-screen": "1",
      "x-tangow-screen-lease-id": "run-1:1",
    });

    fetchMock.mockImplementationOnce(async () => Response.json({ ok: true }));
    await expect(provider.releaseScreen(computer, context, "keep")).resolves.toBeUndefined();
  });

  it("asks to keep the screen even once the run's abort signal has fired", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ ok: true, kept: true }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    const computer = {
      id: "computer",
      botId: "home-bot",
      kind: "docker",
      providerRef: "computer",
    } as const;
    const aborted = new AbortController();
    aborted.abort();

    await expect(
      provider.releaseScreen(computer, { ...context, signal: aborted.signal }, "keep"),
    ).resolves.toBe("kept");
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      "x-tangow-preserve-screen": "1",
    });
  });

  it.each(["keep", "teardown"] as const)(
    "reports a %s release the supervisor refused because a newer run owns the screen",
    async (release) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ ok: true, released: false })),
      );
      const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
      const computer = {
        id: "computer",
        botId: "home-bot",
        kind: "docker",
        providerRef: "computer",
      } as const;

      await expect(provider.releaseScreen(computer, context, release)).resolves.toBe("refused");
    },
  );

  it("never asks to keep the screen when tearing down or when the run's work is cancelled", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(null, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    const computer = {
      id: "computer",
      botId: "home-bot",
      kind: "docker",
      providerRef: "computer",
    } as const;

    await provider.releaseScreen(computer, context);
    await provider.releaseScreen(computer, context, "teardown");
    await provider.releaseScreen(computer, { ...context, cancelRunWork: true }, "keep");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.headers).not.toHaveProperty("x-tangow-preserve-screen");
    }
  });

  it("still releases the screen after the run abort signal has fired", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(null, { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    const abort = new AbortController();
    abort.abort();

    await expect(
      provider.releaseScreen(
        { id: "computer", botId: "home-bot", kind: "docker", providerRef: "computer" },
        { ...context, signal: abort.signal },
      ),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.signal).not.toBe(abort.signal);
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
  });

  it("bounds screen release even when fetch ignores cancellation", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Promise<Response>(() => undefined),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");

    const pending = provider.releaseScreen(
      { id: "computer", botId: "home-bot", kind: "docker", providerRef: "computer" },
      context,
    );
    const rejected = expect(pending).rejects.toThrow("sandbox screen release timed out");
    await vi.advanceTimersByTimeAsync(SCREEN_RELEASE_TIMEOUT_MS);

    await rejected;
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("surfaces a supervisor failure from stop and destroy instead of swallowing it", async () => {
    const fetchMock = vi.fn(async () => Response.json({ error: "unauthorized" }, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "stale-token");
    const computer = {
      id: "computer",
      botId: "bot",
      kind: "docker",
      providerRef: "computer",
    } as const;

    await expect(provider.stop(computer, context)).rejects.toThrow(
      'sandbox stop failed: 401 {"error":"unauthorized"}',
    );
    await expect(provider.destroy(computer, context)).rejects.toThrow(
      'sandbox destroy failed: 401 {"error":"unauthorized"}',
    );

    fetchMock.mockImplementation(async () => new Response("boom", { status: 500 }));
    await expect(provider.stop(computer, context)).rejects.toThrow("sandbox stop failed: 500 boom");
    await expect(provider.destroy(computer, context)).rejects.toThrow(
      "sandbox destroy failed: 500 boom",
    );
  });

  it("sends the user id so the supervisor can mount that user's skills", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ id: "computer", resumed: false }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");

    await provider.provision({ botId: "bot", homePath: "/data/homes/bot" }, context);

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      botId: "bot",
      homePath: "/data/homes/bot",
      spaceId: "workspace",
      userId: "user",
    });
  });

  it("passes on which shared bot's skills the supervisor mounts", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ id: "computer", resumed: false }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");

    await provider.provision(
      { botId: "bot", homePath: "/data/homes/bot", skillsBotId: "bot" },
      context,
    );

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      skillsBotId: "bot",
    });
  });

  it("does not buffer an oversized supervisor error body", async () => {
    const cancel = vi.fn();
    const fetchMock = vi.fn(
      async () =>
        new Response(new ReadableStream({ cancel }), {
          status: 500,
          headers: { "content-length": String(MAX_SANDBOX_ERROR_RESPONSE_BYTES + 1) },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    const computer = {
      id: "computer",
      botId: "bot",
      kind: "docker",
      providerRef: "computer",
    } as const;

    await expect(provider.stop(computer, context)).rejects.toThrow("sandbox stop failed: 500");
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });

  it("stops reading a streamed supervisor error at the byte limit", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(MAX_SANDBOX_ERROR_RESPONSE_BYTES + 1));
            },
          }),
          { status: 500 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");

    await expect(
      provider.stop(
        { id: "computer", botId: "bot", kind: "docker", providerRef: "computer" },
        context,
      ),
    ).rejects.toThrow("sandbox stop failed: 500");
  });

  it("treats a computer the supervisor no longer knows as already stopped and destroyed", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ error: "computer not found" }, { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    const computer = {
      id: "computer",
      botId: "bot",
      kind: "docker",
      providerRef: "computer",
    } as const;

    await expect(provider.stop(computer, context)).resolves.toBeUndefined();
    await expect(provider.destroy(computer, context)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("asks the supervisor to cancel orphaned run work when releasing a screen", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    await provider.releaseScreen(
      { id: "computer-1", botId: "bot", kind: "docker", providerRef: "computer-1" },
      { ...context, cancelRunWork: true },
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://supervisor.test/computers/computer-1/screen",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({ "x-tangow-cancel-run-work": "1" }),
      }),
    );
  });
});

describe("Docker page browser", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the owned computer screen and lease instead of the generic exec endpoint", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ ok: true, title: "Fixture", url: "https://example.test" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new DockerSandboxProvider("http://supervisor.test", "test-token");
    await provider.pageBrowser(
      { id: "computer", botId: "team-home", kind: "docker", providerRef: "computer" },
      { command: "snapshot" },
      context,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://supervisor.test/computers/computer/browser",
      expect.objectContaining({
        redirect: "error",
        signal: context.signal,
        body: JSON.stringify({ command: "snapshot" }),
        headers: expect.objectContaining({
          "x-tangow-bot-id": "team-home",
          "x-tangow-screen-lease-id": "run-1:1",
        }),
      }),
    );
  });
});
