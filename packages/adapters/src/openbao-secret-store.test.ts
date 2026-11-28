import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenBaoSecretStore } from "./openbao-secret-store.js";
import { testSecretStore } from "./secret-store-conformance.test-support.js";
import { createVaultSecretStore } from "./secret-store-factory.js";
import { EncryptedSecretStore } from "./secrets.js";

const baseUrl = "https://vault.example";
const roleId = "fixture-role";
const secretId = "fixture-secret";

function fixture() {
  let generation = 0;
  let tokenExpiresAt = 0;
  let decryptStatus = 200;
  let rejectedRequests = 0;
  const records = new Map<string, { plaintext: string; associatedData: string }>();
  const fakeFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const body: Record<string, string> = await request.json();
    const path = new URL(request.url).pathname;
    switch (path) {
      case "/v1/auth/approle/login":
        if (body.role_id !== roleId || body.secret_id !== secretId) {
          return new Response(null, { status: 400 });
        }
        tokenExpiresAt = Date.now() + 300_000;
        generation++;
        return Response.json({
          auth: { client_token: `token-${generation}`, lease_duration: 300 },
        });
      case "/v1/transit/encrypt/vault":
      case "/v1/transit/decrypt/vault": {
        if (
          request.headers.get("X-Vault-Token") !== `token-${generation}` ||
          Date.now() >= tokenExpiresAt
        ) {
          rejectedRequests++;
          return new Response(null, { status: 403 });
        }
        if (path === "/v1/transit/encrypt/vault") {
          if (body.plaintext === undefined || body.associated_data === undefined) {
            return new Response(null, { status: 400 });
          }
          const ciphertext = `vault:v1:fixture-${records.size}`;
          records.set(ciphertext, {
            plaintext: body.plaintext,
            associatedData: body.associated_data,
          });
          return Response.json({ data: { ciphertext } });
        }
        if (decryptStatus !== 200) return new Response(null, { status: decryptStatus });
        const record = records.get(body.ciphertext ?? "");
        if (!record || record.associatedData !== body.associated_data) {
          return new Response(null, { status: 400 });
        }
        return Response.json({ data: { plaintext: record.plaintext } });
      }
      default:
        return new Response(null, { status: 404 });
    }
  };

  return {
    fetch: fakeFetch,
    rejectedRequests: () => rejectedRequests,
    store: new OpenBaoSecretStore({ baseUrl, roleId, secretId, fetch: fakeFetch }),
    expireToken: () => {
      tokenExpiresAt = 0;
    },
    failDecrypt: (status: number) => {
      decryptStatus = status;
    },
  };
}

testSecretStore(() => fixture().store);

describe("OpenBao transport", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each(["expiry", "rejection"])("logs in again after token %s", async (failure) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { store, expireToken, rejectedRequests } = fixture();
    const sealed = await store.seal("secret", "record");
    if (failure === "expiry") vi.setSystemTime(Date.now() + 300_000);
    else expireToken();

    await expect(store.open(sealed, "record")).resolves.toEqual({ ok: true, plaintext: "secret" });
    expect(rejectedRequests()).toBe(failure === "expiry" ? 0 : 1);
  });

  it("reports a server error as unavailable", async () => {
    const { store, failDecrypt } = fixture();
    const sealed = await store.seal("secret", "record");
    failDecrypt(503);
    await expect(store.open(sealed, "record")).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it("reports a timed-out request as unavailable", async () => {
    const store = new OpenBaoSecretStore({
      baseUrl,
      roleId,
      secretId,
      timeoutMs: 1,
      fetch: async (_input, init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    });
    await expect(store.open("vault:v1:fixture", "record")).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it("selects the local store by default and uses the configured engine when selected", async () => {
    const local = createVaultSecretStore("fixture-key", {});
    const sealed = await local.seal("secret", "record");
    await expect(new EncryptedSecretStore("fixture-key").open(sealed, "record")).resolves.toEqual({
      ok: true,
      plaintext: "secret",
    });

    vi.stubGlobal("fetch", fixture().fetch);
    const remote = createVaultSecretStore("fixture-key", {
      VAULT_ENGINE: "openbao",
      VAULT_ENGINE_URL: baseUrl,
      VAULT_ENGINE_CREDENTIAL: JSON.stringify({ roleId, secretId }),
    });
    await expect(remote.seal("secret", "record")).resolves.toMatch(/^vault:v1:/);
  });
});
