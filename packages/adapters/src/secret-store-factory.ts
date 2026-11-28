import type { SecretStore } from "@tangow/adapter-kit";
import { z } from "zod";
import { OpenBaoSecretStore } from "./openbao-secret-store.js";
import { EncryptedSecretStore } from "./secrets.js";

const engineUrl = z.url({ protocol: /^https?$/ });
const engineCredential = z.object({ roleId: z.string().min(1), secretId: z.string().min(1) });

export function createVaultSecretStore(encryptionKey: string, env: NodeJS.ProcessEnv): SecretStore {
  switch (env.VAULT_ENGINE?.trim() || "local") {
    case "local":
      return new EncryptedSecretStore(encryptionKey);
    case "openbao": {
      const baseUrl = engineUrl.safeParse(env.VAULT_ENGINE_URL);
      if (!baseUrl.success)
        throw new Error("VAULT_ENGINE=openbao requires a valid VAULT_ENGINE_URL");
      try {
        const credential = engineCredential.parse(JSON.parse(env.VAULT_ENGINE_CREDENTIAL ?? ""));
        return new OpenBaoSecretStore({ baseUrl: baseUrl.data, ...credential });
      } catch {
        // The parse error can quote the credential, so it is not rethrown.
        throw new Error(
          "VAULT_ENGINE=openbao requires VAULT_ENGINE_CREDENTIAL as JSON with roleId and secretId",
        );
      }
    }
    default:
      throw new Error("VAULT_ENGINE must be local or openbao");
  }
}
