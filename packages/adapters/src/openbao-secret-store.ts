import type { SecretOpenResult, SecretStore } from "@tangow/adapter-kit";
import { z } from "zod";

type OpenBaoSecretStoreOptions = {
  baseUrl: string;
  roleId: string;
  secretId: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
};

const loginResponse = z.object({
  auth: z.object({
    client_token: z.string().min(1),
    lease_duration: z.number().positive(),
  }),
});
const encryptResponse = z.object({ data: z.object({ ciphertext: z.string().min(1) }) });
const decryptResponse = z.object({ data: z.object({ plaintext: z.string() }) });

export class OpenBaoSecretStore implements SecretStore {
  private token?: { value: string; expiresAt: number };
  private readonly fetchRequest: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: OpenBaoSecretStoreOptions) {
    this.fetchRequest = options.fetch ?? fetch;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
  }

  async seal(plaintext: string, recordId: string): Promise<string> {
    try {
      const response = await this.transit("encrypt", {
        plaintext: Buffer.from(plaintext).toString("base64"),
        associated_data: Buffer.from(recordId).toString("base64"),
      });
      if (response.ok) {
        return encryptResponse.parse(await response.json()).data.ciphertext;
      }
    } catch {
      // Keep upstream errors and response bodies out of the caller's logs.
    }
    throw new Error("Vault engine could not seal the secret");
  }

  async open(sealedValue: string, recordId: string): Promise<SecretOpenResult> {
    try {
      const response = await this.transit("decrypt", {
        ciphertext: sealedValue,
        associated_data: Buffer.from(recordId).toString("base64"),
      });
      if (response.status === 400) return { ok: false, reason: "cannot_open" };
      if (response.ok) {
        const { plaintext } = decryptResponse.parse(await response.json()).data;
        return { ok: true, plaintext: Buffer.from(plaintext, "base64").toString("utf8") };
      }
    } catch {
      // Transport, login and invalid upstream responses are availability failures.
    }
    return { ok: false, reason: "unavailable" };
  }

  private async login(signal: AbortSignal): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value;

    const startedAt = Date.now();
    const response = await this.post(
      "auth/approle/login",
      {
        role_id: this.options.roleId,
        secret_id: this.options.secretId,
      },
      signal,
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Vault engine login failed");
    }

    const { auth } = loginResponse.parse(await response.json());
    this.token = { value: auth.client_token, expiresAt: startedAt + auth.lease_duration * 1000 };
    return this.token.value;
  }

  private async transit(operation: "encrypt" | "decrypt", body: Record<string, string>) {
    const signal = AbortSignal.timeout(this.options.timeoutMs ?? 2_000);
    const path = `transit/${operation}/vault`;
    const token = await this.login(signal);
    let response = await this.post(path, body, signal, token);
    if (response.status === 403) {
      if (this.token?.value === token) this.token = undefined;
      await response.body?.cancel();
      response = await this.post(path, body, signal, await this.login(signal));
    }
    if (!response.ok) await response.body?.cancel();
    return response;
  }

  private post(path: string, body: Record<string, string>, signal: AbortSignal, token?: string) {
    const headers = new Headers({ "content-type": "application/json" });
    if (token) headers.set("X-Vault-Token", token);
    return this.fetchRequest(`${this.baseUrl}/v1/${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      redirect: "error",
      signal,
    });
  }
}
