// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const linear = { kind: "mcp", serverId: "server-linear" } as const;
vi.mock("../lib/rpc", () => ({
  rpc: {
    bots: {
      sharing: async () => ({ visibility: "space", userIds: [], connectors: [linear] }),
    },
    spaces: { members: async () => ({ members: [], invitations: [] }) },
    agentSkills: { list: async () => [] },
    vault: { list: async () => ({ mine: [], shared: [] }) },
    connections: { list: async () => [], catalog: async () => [] },
    mcp: {
      servers: { list: async () => Promise.reject(new Error("offline")) },
      assignments: { list: async () => [{ serverId: "server-linear" }] },
    },
  },
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + part + (values[index] ?? ""), "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@tangow/ui-web", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Checkbox: ({ "aria-label": label }: { "aria-label": string }) => (
      <input type="checkbox" aria-label={label} />
    ),
    Dialog: Container,
    DialogContent: Container,
    DialogHeader: Container,
    DialogTitle: Container,
    SettingRow: ({ label, children }: { label: ReactNode; children?: ReactNode }) => (
      <div>
        {label}
        {children}
      </div>
    ),
    Switch: () => <input type="checkbox" />,
    UserAvatar: () => null,
  };
});

import { ShareBotDialog } from "./ShareBotDialog";

it("lists no apps when the MCP servers can't be read, rather than calling a declared one deleted", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <ShareBotDialog
          bot={{ id: "bot-1", name: "Writer", spaceId: "space-1" }}
          spaceName="Studio"
          userId="owner"
          onClose={() => {}}
        />,
      ),
    );
    // The sheet itself still opens on a shared bot.
    expect(container.textContent).toContain("Everyone who uses this bot can see its files");
    expect(container.textContent).not.toContain("Deleted");
    expect(container.textContent).not.toContain("Apps this bot can use");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
