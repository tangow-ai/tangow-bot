import { once } from "node:events";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { calibrationRpc } from "./live.js";

it("selects the benchmark space and returns the real API envelope", async () => {
  const server = createServer((request, response) => {
    if (request.headers["x-rakazo-space-id"] !== "synthetic-benchmark-space") {
      response.writeHead(403).end();
      return;
    }
    if (request.headers.authorization !== "Bearer synthetic-session") {
      response.writeHead(401).end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ json: { auto: true, categories: [] } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test HTTP address");
  try {
    const value = await calibrationRpc({
      procedure: "models/routing",
      session: {
        userId: "synthetic-user",
        spaceId: "synthetic-benchmark-space",
        token: "synthetic-session",
        baseUrl: `http://127.0.0.1:${address.port}`,
        origin: "http://example.test",
        connections: {},
      },
    });
    expect(value).toEqual({ auto: true, categories: [] });
  } finally {
    server.close();
    await once(server, "close");
  }
});

describe("calibration RPC privacy", () => {
  it("keeps a provider error body out of the thrown diagnostic", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ private: "SYNTHETIC-SECRET-CANARY" }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test HTTP address");
    try {
      await expect(
        calibrationRpc({
          procedure: "models/list",
          session: {
            userId: "synthetic-user",
            spaceId: "synthetic-space",
            token: "synthetic-session",
            baseUrl: `http://127.0.0.1:${address.port}`,
            origin: "http://example.test",
            connections: {},
          },
        }),
      ).rejects.toThrow(/^RPC models\/list failed \(500\)$/);
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});
