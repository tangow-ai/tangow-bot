import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  desktopOAuthCode,
  oauthStateOf,
  onDesktopOAuthCallback,
  readPageHeadOnDesktop,
  type TangowDesktop,
  type TangowDesktopOAuthCallback,
  windowChromeKind,
} from "./desktop.js";

function desktop(platform: string): TangowDesktop {
  const updateState = {
    phase: "unsupported" as const,
    currentVersion: "0.1.0",
    availableVersion: null,
    percent: null,
    message: "Automatic updates only run in an installed build.",
    checkedAt: null,
  };
  return {
    platform,
    window: {
      close: async () => undefined,
      minimize: async () => undefined,
      toggleMaximize: async () => undefined,
      state: async () => ({ minimized: false, maximized: false, fullScreen: false }),
    },
    update: {
      state: async () => updateState,
      check: async () => updateState,
      download: async () => updateState,
      install: async () => updateState,
    },
    oauth: { onCallback: () => () => undefined },
  };
}

describe("window chrome", () => {
  it("does not paint fake traffic lights in the browser", () => {
    expect(windowChromeKind(undefined)).toBe("spacer");
  });

  it("leaves macOS traffic lights to Electron", () => {
    expect(windowChromeKind(desktop("darwin"))).toBe("darwin");
  });

  it("uses real window-control buttons on Windows and Linux", () => {
    expect(windowChromeKind(desktop("win32"))).toBe("controls");
    expect(windowChromeKind(desktop("linux"))).toBe("controls");
  });

  it("does not paint fake traffic lights into the browser shell or welcome page", () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../pages");
    for (const file of [
      "Shell.tsx",
      "shell/sidebar.tsx",
      "shell/thread-header.tsx",
      "Welcome.tsx",
    ]) {
      expect(readFileSync(path.join(root, file), "utf8"), file).not.toContain("FF5F57");
    }
  });

  it("reserves room for window controls in the peer chat view", () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../pages");
    const overlay = readFileSync(path.join(root, "PeerMessagesOverlay.tsx"), "utf8");
    expect(overlay).toContain("{desktopBridge() ? <WindowChrome /> : null}");
    expect(overlay).toContain('className="app-drag flex items-center justify-between');
    expect(overlay).not.toContain("FF5F57");
  });

  it("gives every step before an account the window controls", () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../pages");
    const screen = readFileSync(path.join(root, "onboarding-screen.tsx"), "utf8");
    expect(screen).toContain("chrome={desktopBridge() ? <WindowChrome /> : null}");
    for (const file of ["Auth.tsx", "Welcome.tsx"]) {
      expect(readFileSync(path.join(root, file), "utf8"), file).not.toContain("<OnboardingFrame");
    }
  });

  it("keeps computer overlay controls clickable under the window titlebar", () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../pages");
    const panel = readFileSync(path.join(root, "shell/side-panel.tsx"), "utf8");
    expect(panel).toContain("{desktopBridge() ? <WindowChrome /> : null}");
    expect(panel).toContain(
      'className="app-drag flex items-center justify-between gap-4 border-b border-sidebar-border px-4.5 py-3.5"',
    );
    expect(panel).toContain(
      '<div className="app-no-drag relative flex shrink-0 items-center gap-2 sm:gap-3">',
    );
  });

  it("keeps conversation header controls clickable", () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../pages");
    const shell = readFileSync(path.join(root, "shell/thread-header.tsx"), "utf8");
    expect(shell).toContain('className="app-drag relative z-10 -mb-header flex h-header shrink-0');
    // The mobile-nav toggle is a round glass button that stays out of the drag region.
    expect(shell).toContain(
      'className="rk-glass-control rk-press-round app-no-drag grid size-capsule shrink-0 place-items-center rounded-full text-foreground md:hidden"',
    );
    // The bot-name trigger stays clickable (and out of the drag region) while
    // carrying its hover affordance.
    expect(shell).toContain(
      'className="app-no-drag -mx-2 flex min-w-0 items-center gap-3 rounded-lg px-2 py-1 transition-colors enabled:hover:bg-muted"',
    );
    // One computer button and one settings button in the capsule, each out of the drag region.
    expect(shell).toContain('const CAPSULE_BUTTON = "app-no-drag ');
    expect(shell.match(/data-testid="open-computer-panel"/g)).toHaveLength(1);
    expect(shell.match(/data-testid="open-settings-panel"/g)).toHaveLength(1);
    // No `<` in between: both attributes belong to the same element.
    expect(shell).toMatch(/data-testid="open-computer-panel"[^<]*?className=\{CAPSULE_BUTTON\}/);
    expect(shell).toMatch(/data-testid="open-settings-panel"[^<]*?className=\{CAPSULE_BUTTON\}/);
  });

  it("moves window chrome into the conversation header when the bots sidebar is collapsed", () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../pages");
    const shell = readFileSync(path.join(root, "shell/thread-header.tsx"), "utf8");
    expect(shell).toContain("{botsSidebarCollapsed && desktopBridge() ? <WindowChrome /> : null}");
  });
});

describe("captured OAuth callbacks", () => {
  it("sends the code and state as the compact form the paste flow accepts", () => {
    expect(desktopOAuthCode({ code: "ac_123", state: "verifier_456" })).toBe("ac_123#verifier_456");
  });

  it("sends a bare code when the provider redirects without state", () => {
    expect(desktopOAuthCode({ code: "ac_123" })).toBe("ac_123");
  });
});

describe("attempt correlation", () => {
  afterEach(() => vi.unstubAllGlobals());

  function bridgeEmitting() {
    let emit: (callback: TangowDesktopOAuthCallback) => void = () => undefined;
    const unsubscribe = vi.fn();
    vi.stubGlobal("window", {
      tangowDesktop: {
        ...desktop("linux"),
        oauth: {
          onCallback: (listener: (callback: TangowDesktopOAuthCallback) => void) => {
            emit = listener;
            return unsubscribe;
          },
        },
      },
    });
    return { emit: (c: TangowDesktopOAuthCallback) => emit(c), unsubscribe };
  }

  it("reads the attempt state out of the authorize URL", () => {
    expect(oauthStateOf("https://claude.ai/oauth/authorize?code=true&state=verifier_456")).toBe(
      "verifier_456",
    );
    expect(oauthStateOf("https://claude.ai/oauth/authorize?code=true")).toBeUndefined();
    expect(oauthStateOf("not a url")).toBeUndefined();
  });

  it("ignores a code captured for a different attempt", () => {
    const { emit } = bridgeEmitting();
    const received: string[] = [];
    onDesktopOAuthCallback((code) => received.push(code), "verifier_456");

    emit({ code: "stale", state: "verifier_000" });
    expect(received).toEqual([]);

    emit({ code: "ac_123", state: "verifier_456" });
    expect(received).toEqual(["ac_123#verifier_456"]);
  });

  it("accepts any code when the provider carries no state to correlate on", () => {
    const { emit } = bridgeEmitting();
    const received: string[] = [];
    onDesktopOAuthCallback((code) => received.push(code));

    emit({ code: "ac_123" });
    expect(received).toEqual(["ac_123"]);
  });

  it("no-ops in a browser without the desktop bridge", () => {
    vi.stubGlobal("window", {});
    const received: string[] = [];
    expect(() => onDesktopOAuthCallback((code) => received.push(code))()).not.toThrow();
    expect(received).toEqual([]);
  });
});

describe("page head reader for link previews", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("goes through the desktop bridge when there is one", async () => {
    const page = { head: "<head><title>T</title></head", contentType: "text/html" };
    const read = vi.fn(async () => page);
    vi.stubGlobal("window", { tangowDesktop: { ...desktop("darwin"), pageHead: { read } } });
    await expect(
      readPageHeadOnDesktop("https://news.example.com/a", new AbortController().signal),
    ).resolves.toEqual(page);
    expect(read).toHaveBeenCalledWith("https://news.example.com/a", expect.any(String));
  });

  it("cancels the desktop read it started when the composer drops the link", async () => {
    const reads = new Map<string, () => void>();
    const read = vi.fn(
      (_url: string, id: string) =>
        new Promise<null>((resolve) => reads.set(id, () => resolve(null))),
    );
    const cancel = vi.fn(async (id: string) => reads.get(id)?.());
    vi.stubGlobal("window", {
      tangowDesktop: { ...desktop("darwin"), pageHead: { read, cancel } },
    });
    const first = new AbortController();
    const second = new AbortController();
    const a = readPageHeadOnDesktop("https://news.example.com/a", first.signal);
    const b = readPageHeadOnDesktop("https://news.example.com/b", second.signal);
    const [idA, idB] = [...reads.keys()];

    first.abort();
    await expect(a).resolves.toBeNull();
    expect(cancel.mock.calls).toEqual([[idA]]);
    expect(idA).not.toBe(idB);

    reads.get(idB as string)?.();
    await b;
    second.abort();
    expect(cancel.mock.calls).toEqual([[idA]]);
  });

  it("gives nothing in a plain browser or on a desktop that predates it", async () => {
    const signal = new AbortController().signal;
    vi.stubGlobal("window", {});
    await expect(readPageHeadOnDesktop("https://news.example.com/a", signal)).resolves.toBeNull();
    vi.stubGlobal("window", { tangowDesktop: desktop("darwin") });
    await expect(readPageHeadOnDesktop("https://news.example.com/a", signal)).resolves.toBeNull();
  });
});
