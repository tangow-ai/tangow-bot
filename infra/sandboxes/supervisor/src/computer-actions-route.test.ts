import { Readable } from "node:stream";
import { resolveSupervisorToken } from "@tangow/core";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("dockerode", () => ({
  default: class {
    getContainer() {
      return {
        inspect: async () => ({
          Config: {
            Labels: { "tangow.managed": "true", "tangow.botId": "home", "tangow.spaceId": "space" },
            Env: ["TANGOW_COMPUTER_CONTROL_TOKEN=test-control-token"],
          },
          HostConfig: { NetworkMode: "bridge" },
          NetworkSettings: {
            Networks: { bridge: { IPAddress: "127.0.0.1" } },
            Ports: { "7070/tcp": [{ HostIp: "127.0.0.1", HostPort: "7070" }] },
          },
        }),
        exec: async () => ({
          start: async () => Readable.from([Buffer.from("")]),
          inspect: async () => ({ ExitCode: 0 }),
        }),
      };
    }
  },
}));

import { supervisorApp } from "./index.js";

function launch(application: string) {
  return supervisorApp.request("/computers/test-computer/actions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
      "content-type": "application/json",
      "x-tangow-bot-id": "home",
      "x-tangow-space-id": "space",
    },
    body: JSON.stringify({ actions: [{ kind: "launch", application }], observe: false }),
  });
}

afterEach(() => vi.unstubAllGlobals());

it("returns 400 and the available applications for an unknown launch name", async () => {
  const control = vi.fn();
  vi.stubGlobal("fetch", control);

  const response = await launch("xterm");

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: 'unknown application "xterm". Available: browser, files, libreoffice, terminal',
  });
  expect(control).not.toHaveBeenCalled();
});

it("keeps a control service refusal at 500", async () => {
  vi.stubGlobal("fetch", async () =>
    Response.json({ error: "unsupported computer action" }, { status: 400 }),
  );

  const response = await launch("terminal");

  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: "unsupported computer action" });
});

it("keeps the available names within the adapter's error body limit", async () => {
  vi.stubGlobal("fetch", async () => Response.json({ completed: 1 }));

  const response = await launch(String.fromCharCode(92).repeat(200));
  const body = await response.text();

  expect(response.status).toBe(400);
  expect(body.length).toBeLessThanOrEqual(200);
  expect(body).toContain("Available: browser, files, libreoffice, terminal");
});
