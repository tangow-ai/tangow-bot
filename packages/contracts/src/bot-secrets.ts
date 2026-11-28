import { z } from "zod";

export const BotSecretName = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

const SecretHeaderName = z
  .string()
  .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,120}$/)
  .refine(
    (name) =>
      !/^(host|connection|content-length|content-type|transfer-encoding|te|trailer|upgrade|cookie|origin|referer|accept|proxy-.*|sec-.*|.*forwarded.*)$/i.test(
        name,
      ),
    "Unsupported credential header",
  );

export const BotSecretAuth = z.discriminatedUnion("type", [
  z.object({ type: z.literal("bearer") }),
  z.object({ type: z.literal("header"), name: SecretHeaderName }),
  z.object({
    type: z.literal("basic"),
    username: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[^:\r\n]+$/),
  }),
]);

export const BotSecretDestination = z.object({
  name: BotSecretName,
  origin: z
    .string()
    .max(2048)
    .refine((value) => {
      try {
        const url = new URL(value);
        return (
          url.protocol === "https:" &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          url.pathname === "/"
        );
      } catch {
        return false;
      }
    }, "Expected an HTTPS origin without a path, credentials, query, or fragment"),
  auth: BotSecretAuth,
});
export type BotSecretDestination = z.infer<typeof BotSecretDestination>;

/** Saves a credential from the vault screen. The value is write-only: no response returns it. */
export const VaultPutInput = BotSecretDestination.extend({ value: z.string().min(1).max(16_384) });
export type VaultPutInput = z.infer<typeof VaultPutInput>;

/** One of the person's own keys: where it goes, the bot that saved it, and who it is shared with. */
export const VaultItem = BotSecretDestination.extend({
  botId: z.string().nullable(),
  userIds: z.array(z.string()),
  space: z.boolean(),
});
export type VaultItem = z.infer<typeof VaultItem>;

/** A key another member shares with the person. Read-only for them. */
export const SharedVaultItem = BotSecretDestination.extend({ ownerName: z.string() });
export type SharedVaultItem = z.infer<typeof SharedVaultItem>;

export const VaultList = z.object({ mine: z.array(VaultItem), shared: z.array(SharedVaultItem) });
export type VaultList = z.infer<typeof VaultList>;

/** The owner sets who a key is shared with; `space` also covers future members of the space. */
export const VaultShareInput = z.object({
  name: BotSecretName,
  userIds: z.array(z.string().min(1).max(200)).max(1000),
  space: z.boolean(),
});
export type VaultShareInput = z.infer<typeof VaultShareInput>;

/** Written atomically with the protected value, distinct from action approval. */
export const BotSecretSubmission = z.object({ credentialSaved: BotSecretDestination });

export const SecretHttpRequest = z
  .object({
    name: BotSecretName,
    url: z.string().max(8192),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]).default("GET"),
    body: z.string().max(100_000).optional(),
    contentType: z
      .enum(["application/json", "application/x-www-form-urlencoded", "text/plain"])
      .default("application/json"),
  })
  .refine(
    (request) => request.body === undefined || !["GET", "HEAD"].includes(request.method),
    "This method cannot have a body",
  );
