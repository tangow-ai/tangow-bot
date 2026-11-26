# Vault architecture: third-party key custody and site sign-in

Status: proposal for review. No code beyond the existing site sign-in draft (PR #540) is written before the document is agreed.

Facts about the vault code were read at commit `a488311d6` of the vault branch (PR #536) and facts about `sign_in` at commit `556ea78d0` of the site sign-in branch (PR #540). Facts about OpenBao come from its public documentation; nothing was installed or tested. Two independent reviews (security, then site sign-in) are folded in.

An interactive walkthrough of the flows below is in [`docs/assets/vault-architecture.html`](../assets/vault-architecture.html) (in French; download the file and open it in a browser).

## Why

Tangow encrypts every stored secret itself, with one key (`ENCRYPTION_KEY`) held in the deployment's environment. Whoever operates Tangow therefore maintains the cryptography and the key, cannot cut access without re-encrypting, and has no outside record of decryptions.

The goal is that an operator can hand key custody, cryptography, rotation, the ability to cut future access, and a log of decryptions to a dedicated tool, and that Tangow depends on an interface, not on that tool.

A second goal comes with the site sign-in slice (PR #540): a bot can sign in to a website with a saved login when nobody is at the screen.

Out of scope:

- Who may use which key. Ownership, sharing and the allowed site are product rules and stay in Tangow.
- Agent secrets (values passed as environment variables to a bot's shell commands). Already shipped and accepted; unchanged.
- Moving existing data. Rows already stored stay readable as they are.
- Entering secrets in the third-party tool's own screens. People enter keys in Tangow.

## The rule

> The controller authorizes every release of a vault credential. An API key never leaves the controller: the controller makes the request to the origin saved with the key, and that origin is trusted with it. A site login may be filled into the bot's browser on the exact saved origin; the bot's computer and that page can then read the password, and the website controls the session that follows.

Four cases put a credential in the bot's machine. The first is new with the site sign-in slice (PR #540); the others exist today and are unchanged.

| Case | Where it is documented |
| --- | --- |
| A saved site login filled by `sign_in` | This document, "Site sign-in" |
| Agent secrets, such as `GH_TOKEN`, reach every shell command on the computer | `docs/computer-runtime.md` |
| A person takes over the bot's screen and types a password | `request_takeover` |
| The OpenCode token created by `opencode auth login` lives in the bot's home | `docs/computer-runtime.md` |

`docs/bot-secrets.md` says shell and environment paths "are not exposed". That sentence is true of vault keys and should say so, since agent secrets are exposed that way.

## What exists today

The trust boundary is already where it should be:

- The agent loop runs in a sandboxed worker and holds no key. Model calls go through a relay that adds the controller's key.
- The worker proves its attempt with a signed capability (run, attempt, fence, expiry) whose signing key lives in controller memory.
- `secret_request`, `list_secrets` and `request_secret` execute on the controller.
- The controller checks the bot's right on every use, opens the value, adds it to one HTTPS request to the origin fixed when the key was saved, and redacts the value from the response. MCP calls follow the same shape: the controller re-checks the assignment and makes the call. It keeps the MCP session and its opened material in memory until the server's revision changes.

What is missing is the interface:

- The `SecretStore` port exists in `packages/adapter-kit/src/interfaces.ts` but is bypassed. `EncryptedSecretStore.get()` throws, nobody calls it, and 19 call sites in 14 files call `.load(ciphertext, id)` on the concrete class.
- `redact` on the port and the `rotate` capability have no readers.
- Ciphertext lives in four columns (`secrets`, `mcp_oauth_sessions`, `bot_secrets`, `integration_provider_configs`). The `secrets` table also backs model credentials, MCP material, voice keys, webhook secrets and agent secrets.

## The model

| Object | What it is | Where it lives |
| --- | --- | --- |
| Key record | Name, allowed origin, authentication type, owner, space, shares. Never the value. | Tangow database |
| Sealed value | An opaque token in the same row, tagged with the driver that sealed it. | Tangow database |
| Store | The interface: seal and open. One driver per tool. | Default: Tangow. Third party: OpenBao. |
| Usage rule | Who may use which key, on which bot, towards which origin. Checked on every use. | Tangow |
| Exit paths | The closed list of ways a stored value leaves the controller. | This document |

## The interface

```ts
export interface SecretStore {
  describe(): AdapterDescriptor;
  /** Seal. recordId binds the sealed value to the row that stores it. */
  put(plaintext: string, context: AdapterContext, recordId?: string): Promise<SecretRecord>;
  /** Open. Replaces get(id) and the off-port load(ciphertext, id). */
  open(record: SecretRecord, context: AdapterContext): Promise<string>;
}
```

- `put` keeps its name and signature. `open` is asynchronous, because a remote store answers over the network.
- There is no `remove`, no listing and no persistence in the port. Tangow's row stays the only place a sealed value is stored, so deleting the row leaves nothing behind in the third party.
- `redact` and the `rotate` capability are removed, since nothing reads them.
- A driver accepts every value size Tangow accepts today (vault values go up to 16,384 characters).

### Failures

`open` fails in two distinct ways: the value does not decrypt (wrong record, corrupted row), or the store is unavailable (unreachable, sealed, access denied, deadline passed).

With the local driver a failed open can only mean a damaged row, and several callers rely on that: they catch every error and continue with an empty value. With a remote store the same code turns an outage into data loss. Verified cases:

- `McpOAuthService.read` returns `{}` on any error. `replaceMaterial` then merges the new OAuth state into that empty object, stores it, and deletes the previous secret. An outage during a token refresh would erase the server's static headers, credentials and environment entries.
- The MCP settings update in `apps/api/src/router.ts` has the same shape.
- The `secret_request` tool handler reports every error as "Invalid authenticated request", which would hide an outage from the bot and the person.

The rule for the interface change: **any write that keeps or merges existing material aborts before changing anything when `open` fails as unavailable.** The audit covers the catch blocks around the callers, not only the 19 `.load` expressions, and an unavailable store surfaces as such through the API and tool handlers. A test covers a failed read followed by a write that would otherwise succeed.

### Formats and switching driver

- Each driver tags what it seals. The local driver writes `v2:`.
- A deployment has one driver that writes and an explicit list of drivers that read. An unknown tag is rejected; there is no fallback and no rewrite.
- Every process (API and worker) must be able to read a format before any process starts writing it. Switching driver is therefore two deployments: readers first, then the writer.
- The key that sealed a row has to stay available for as long as that row, or a backup containing it, may be read. A second OpenBao installation with the same key name holds different key material and opens nothing.
- `resealLegacySecrets` stays a local-driver concern. It runs at every start, selects every row not starting with `v2:`, and requires the concrete local store. It must select only untagged rows and must not be handed the remote driver. How a deployment with only the remote driver starts, given that both processes resolve the local key at start today, is specified with the driver.

## First third-party driver: OpenBao transit

OpenBao's transit engine encrypts and decrypts on request and stores no data. The caller keeps the ciphertext.

- **Key.** The operator creates one named, non-exportable AEAD key before enabling the driver. Tangow never creates it.
- **Policy.** The controller's policy grants `update` on the exact encrypt and decrypt paths of that key and nothing else. Without `create`, a missing key is an error instead of being silently created as a new, unrelated key.
- **Binding.** `put` calls `transit/encrypt/<key>` with the record identity as `associated_data`; `open` calls `transit/decrypt/<key>` with the same bytes, so a sealed value copied to another row does not open. The documentation lists the parameter on both endpoints. The driver uses the same per-table identity the local driver uses today (including the `integration-provider:` prefix), in one fixed encoding.
- **Authentication.** The controller logs in with AppRole and holds a short-lived token it renews. The driver's pull request specifies how the SecretID reaches each process, where it may be read, its lifetime and use limit, and how a process recovers when its token reaches its maximum lifetime. The SecretID stays out of the bot's machine and out of any backup readable by whoever can read the database.
- **Transport.** OpenBao receives the plaintext on every seal and returns it on every open. The connection is authenticated TLS to a trusted endpoint, with no request or response body logging on the way and no raw audit logging.
- **Audit.** An audit device records every transit request. Sensitive fields are hashed by default. If every audit device is blocked, OpenBao stops answering.
- **Rotation.** The operator rotates the key; new seals use the new version and earlier versions keep opening. Raising the minimum decryption version, or rewrapping, is a separate operation that must be tested against a restored backup first.
- **Outage.** If OpenBao is unreachable or sealed, `open` fails as unavailable. There is no fallback to the local key and no cache of opened values added by this work. After a restart OpenBao is sealed until it is unsealed.
- **Deadlines.** Every call has a deadline. Two writes (saving a vault key, persisting MCP OAuth material) seal inside a database transaction that holds a lock; the remote call is bounded by the transaction's remaining time, is not retried while the lock is held, and a failure rolls the transaction back intact.

One driver ships beside the local one. There is no driver registry and no batch operation in the port. The deployment setting that selects the writer and the readers, and a deterministic offline conformance test shared by both drivers (including a large multi-byte value), arrive with this driver. An offline test proves Tangow's reactions, not the server's behaviour: wrong-binding rejection, expiry recovery and restore are also checked once against a real OpenBao.

## Site sign-in

A bot that meets a sign-in page today can only ask a person to take over and type the password; the session then stays in the bot's persistent browser profile. With `sign_in`, the bot asks Tangow to fill a login the person saved.

What the draft does today, verified in the code:

- The run must be the owner's own bot, started by the owner; webhook, messaging, bot-initiated and steered runs are refused.
- The helper on the computer fills only in the top frame, when `location.origin` equals the saved origin exactly, into a real password field.
- The password travels on the helper's stdin, never in argv or the environment, and is never a model tool argument.
- The controller masks the password's direct and JSON-escaped forms in the tool result and the stored receipt.

Accepted risks, decided:

- **Shared computers.** Bots sharing a computer is a core product notion, and on a team computer they share the OS user, the shell and access to the browser profiles. `sign_in` is not refused there. A session opened on a team computer is reachable by the other bots of that computer, as is already true after a takeover.
- **Pages that show the password back.** The tool result keeps its page snapshot. A site that renders a password in a form Tangow does not recognise is that site's responsibility. The promise is worded accordingly: Tangow never puts the password in the model's tool arguments, the chat, the logs or a trace, and masks its direct and common encoded echoes. It does not promise that the model can never see it.
- **A bot that reads the field.** A bot that deliberately reads the filled field from its own computer can see the password, as with a password typed during a takeover.

Changes still to make before the site sign-in slice (PR #540) merges:

1. Check the origin and the field before the password leaves the controller. Today the password is opened and sent to the computer first, and a rejected page has already received it.
2. Re-check the field immediately before the value is written, and refuse a form whose declared target is another origin.
3. Disable browser password saving on bot profiles.
4. Report "outcome uncertain" instead of a failure when the fill may have happened, so the bot inspects the page before asking again.
5. Tell the owner, when a login is saved, that the bot's computer receives the password.
6. Document incident response: cutting store access does not close a website session; the owner revokes sessions and rotates the password on the site.

A dedicated site account with the fewest rights the site allows is the recommended practice and belongs in the user documentation.

## Who authenticates to whom

| From | To | Proof |
| --- | --- | --- |
| Bot's machine | Controller | Per-attempt capability (exists today) |
| Controller | OpenBao | AppRole token, short-lived, renewable, revocable |
| Controller | Destination service | The opened value, on one request |

The bot never receives a credential for the store. Nothing in this design calls for the store to issue credentials per run.

## Exit paths

| Path | The value goes to | Enters the bot's machine |
| --- | --- | --- |
| Seal and open | The store (OpenBao), over TLS | No |
| Model call through the relay | The model provider | No |
| MCP call | The MCP server | No |
| `secret_request` | The one origin saved with the key | No |
| Voice, webhook, memory and integration providers | That provider | No |
| Webhook secret shown to its owner | The signed-in owner's client | No |
| MCP server over stdio (off unless enabled by the operator) | A process started on the controller | No |
| `sign_in` | The supervisor or execution provider, the helper, the bot's browser, then the saved site | Yes, listed exception |
| Agent secrets | Every shell command on the computer | Yes, known case, unchanged |

Adding a row to this table is an architecture decision and needs its own review.

## What this buys and what it does not

It buys:

- The encryption key is not in Tangow's environment for values sealed by the OpenBao driver. A copy of the database alone opens nothing.
- Cutting the controller's access blocks every future open of such values.
- Every decryption by the controller is logged outside Tangow.
- Cryptography and rotation are maintained by the third party.
- A bot can sign in to a site without a person at the screen.

It does not buy:

- **Instant revocation of credentials in use.** Cutting access blocks future opens. A running run keeps the model credential and agent secrets it already resolved, a cached MCP session keeps working until it is evicted, a website session opened by `sign_in` or a takeover stays open, and a credential already sent to a destination stays valid until that service invalidates it. An incident response is therefore: stop new logins (destroy the SecretID), revoke the tokens already issued, restart the controller to drop what is in memory, and revoke sessions and rotate passwords on the sites concerned.
- **Who used which key.** The log shows that the controller decrypted something, not which person or bot used which credential. The shared-skill check opens every key of a space, and a cached MCP session makes calls with no new decryption. Attribution, if wanted, is a Tangow log and is not part of this work.
- **Protection from a compromised controller.** While it runs, the controller holds a live token and can open any row it can read.
- **Protection from someone who can write to the database.** The binding covers the row's identity, not its content. Whoever can edit rows can change the origin saved beside a key, and the controller would then send that credential to the new origin; they can also put back an older sealed value for the same row. The design assumes the database's integrity. See open question 2.
- **Cryptographic erasure.** A deleted or replaced value stays decryptable from a backup for as long as the key version exists.
- **Protection of values in transit.** A value passes through controller memory, and through OpenBao, when it is saved and each time it is used.
- **Independence on a single server.** OpenBao's unseal material sits on the same host unless another machine or a cloud key service unseals it.
- **Anything for rows sealed by the local driver.** They stay under `ENCRYPTION_KEY`, which must stay configured for as long as such rows exist.

## Known costs

- If OpenBao is down, every operation that has to open a stored value fails: vault keys, a password step of `sign_in`, MCP calls that need a new session, per-space model credentials. A run that uses the deployment's own model key and opens nothing else still runs.
- The shared-skill leak check (`packages/adapters/src/worker-skills.ts`) opens every key of a space for each report. With a remote store that is one request per key.

## Order of work

1. This document, agreed.
2. One pull request that makes the interface real: `open` on the port, call sites typed on the port and awaited, the two failure kinds, the abort-before-write rule and its test, the catch-block audit, the reseal selection fixed, unused members removed. The local driver's behaviour and format do not change and no data moves.
3. The OpenBao transit driver, the writer and readers setting, the AppRole delivery, the shared conformance test, the checks against a real OpenBao, and a self-host tutorial that covers policy, audit, unseal after restart, rotation and restore.
4. Site sign-in (PR #540), after the vault feature (PR #536), with the six changes listed under "Site sign-in".

All four ship as one feature. Each step is a slice that merges into the `feature/vault` branch, and a single pull request carries the feature to `main` once every slice is in and the whole works together.

Steps 2 and 3 are independent of the vault feature and of step 4: the vault feature touches the store at three call sites, and `sign_in` adds one. Whichever lands second adapts its call sites to `open` and must fail closed when the store is unavailable.

## Open questions

1. "Leasing". Is the per-attempt capability between bot and controller what is expected? The security review found no reason for the store to issue credentials per run.
2. Should the saved origin and authentication type of a vault key be part of what is bound to its sealed value, so that editing the row no longer redirects the credential? It costs a change in how vault keys are sealed (PR #536, where no stored row exists yet) and protects against someone who can already write to the database.
3. Should values sealed by the local driver be re-sealed when they are next saved, so that `ENCRYPTION_KEY` can eventually be retired? Not planned.
4. Single-server deployments: is an unseal key on the same host acceptable as the documented default?
5. Which of the owner's bots may use a saved login? Today every bot the owner has in the space can. Reusing the per-bot sharing of vault keys would let the owner choose, and would limit what a bot misled by content it reads can sign in to.
