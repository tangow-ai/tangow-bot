# Self-hosting Tangow

The signed-in product is a long-running API, a Graphile Worker, Postgres, and a computer provider (Docker supervisor or E2B). It is not a static site.

## Local (source checkout)

Same as the README quick start: `.env` from `.env.example`, Postgres via Compose, `pnpm sandbox:build`, `pnpm dev`, then [http://127.0.0.1:5173](http://127.0.0.1:5173) (or `http://localhost:5173` — both loopback hosts are trusted). Electron: `pnpm --filter @tangow/desktop dev` while that stack is up, then enter that address in setup.

For source development in WSL, keep the checkout and `data` directory in the Linux filesystem (for example, `~/tangow`), and run `pnpm dev` as your normal user. The host-run supervisor matches bot container UID/GID to that user. If Docker Desktop container IPs are unreachable, set `SANDBOX_CONTROL_VIA_LOOPBACK=true` in `.env`; this publishes the token-protected control service on a random loopback port. Leave this unset for the Compose-hosted supervisor.

Compose bot homes mount only their own subdirectory of the application volume using Docker volume semantics. Docker's internal volume paths are never used as host bind mounts.

## Docker Compose (single machine)

For a guided source deployment, run `./tangow setup` from the checkout. It creates private
configuration, builds the current revision, starts the stack and verifies readiness. See
[the setup guide](tangow.md#first-deployment). The manual steps below remain available.

1. Copy `.env.example` to `.env` and set `POSTGRES_PASSWORD` (`openssl rand -hex 16`), plus `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, and `SCREEN_PROXY_SECRET` to independent long random strings (32+ characters; 64 hex for `ENCRYPTION_KEY`). Docker sandboxes also need a dedicated `SANDBOX_SUPERVISOR_TOKEN`. Keep existing `ENCRYPTION_KEY` values so stored credentials stay decryptable.
2. Set `OPENROUTER_API_KEY` (and `COMPOSIO_API_KEY` if you want Plugins).
3. Build the computer and worker images: `pnpm sandbox:build` (Compose also builds them via the `computer` and `worker-image` services).
4. `docker compose --env-file .env -f infra/compose/docker-compose.yml up --build`
5. Open the web origin (`http://127.0.0.1:5173` by default). The first registered user becomes the deployment owner.

On Windows, if an older clone with `core.autocrlf=true` leaves the computer pane hung on boot (`bash\r` in sandbox logs): from a clean worktree, set `git config core.autocrlf false`, run `git add --renormalize . && git checkout -- .`, then rebuild with `pnpm sandbox:build`.

Compose runs Postgres, the sandbox supervisor (Docker socket), API, worker, and a Vite preview of the web app. Bot computers are sibling containers (`tangow/computer:local`) on separate per-bot networks; only the supervisor and screen proxy join each one. The API process does not get an unrestricted Docker socket; the supervisor owns the lifecycle.

Postgres stays on the Compose network only (not published on the host). Credentials come from `.env` (`POSTGRES_PASSWORD` is required). Prefer a URI-safe value
(`openssl rand -hex 16`); characters such as `@ : / ? # %` break the interpolated `DATABASE_URL`
inside Compose. Official Postgres images set user, password, and database only on first volume
init, so an existing `pgdata` volume keeps its original identity: keep those values in `.env`, or
change them in place with `ALTER ROLE` / rename. Recreate the volume only after a backup (or when
the data is disposable); `docker compose down -v` deletes all Postgres state. For host-side clients
(`pnpm db:migrate`, GUI tools),
add `infra/compose/docker-compose.postgres-host.yml` so Postgres is published on loopback
`127.0.0.1:5433`, or use
`docker compose --env-file .env -f infra/compose/docker-compose.yml exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'`.
Do not publish Postgres on a public interface.

The Docker supervisor is not published as its own image and is not exposed on the host. It runs from
the app image, stays on the internal Compose network, and holds the Docker socket because access to
it is equivalent to control of the Docker host. Docker sandboxes require `SANDBOX_SUPERVISOR_TOKEN`
(API, worker, supervisor). `SCREEN_PROXY_SECRET` signs browser-screen capabilities (API and web
proxy). Keep both distinct from `BETTER_AUTH_SECRET`.

New credentials use versioned AES-GCM with per-record salt and row-bound AAD. Legacy ciphertext stays readable.

On a VPS, put TLS in front of `:5173` (or serve the web build behind your proxy) and set:

```env
BETTER_AUTH_URL=https://app.example.com
WEB_ORIGIN=https://app.example.com
API_URL=https://app.example.com
```

Cookies and CORS follow those origins. `SIGNUPS_ENABLED` / `SIGNUP_ALLOWLIST` seed the signup
policy when the API starts for the first time. They are not reapplied on ordinary restart, so configure
them before that first start. Public `./tangow setup` explicitly applies the policy collected by the
wizard to the database before starting services, including on retries.

With a nonempty signup allowlist, users—including existing accounts—must verify their email to sign
in. Configure SMTP below before enabling an allowlist or upgrading an allowlisted deployment.

For a public deployment, configure SMTP and an allowlist before the API's first start.
Keep an installation without email on a trusted local network.

### Host-specific Compose tweaks

To change the stack for one host without editing tracked files, create `.env.tangow.compose.yml`
at the repository root. It is ignored by Git, and every `./tangow` command and the backup and
restore scripts pass it to Compose as the last `-f` file, so it overrides everything else and
survives `./tangow update`. The [updater sidecar](#updater-sidecar) does not read it; add it to
`TANGOW_COMPOSE_FILE` there. For example, to disable MPTCP inside a service's network namespace:

```yaml
services:
  api:
    sysctls:
      net.mptcp.enabled: "0"
```

### Bot computer resource ceilings

Each Docker computer runs Xvfb, a window manager and a full Chromium driven by an agent that
decides for itself what to open, so it is capped. These defaults provide a starting point for the
Docker computer topology:

| Variable | Default | Accepts |
| --- | --- | --- |
| `TANGOW_COMPUTER_MEMORY` | `8g` | `2g`, `1536m`, a byte count. Minimum `6m`, Docker's own floor. Also caps swap, so the ceiling holds. |
| `TANGOW_COMPUTER_CPUS` | `4` | Whole or fractional cores, e.g. `1.5` |
| `TANGOW_COMPUTER_PIDS_LIMIT` | `2048` | A positive integer |

These are ceilings, not reservations: an idle computer does not hold 8 GB. On a small host running
several computers at once, lower them (for example `TANGOW_COMPUTER_MEMORY=2g`,
`TANGOW_COMPUTER_CPUS=2`). Set any of them to `0`, `none` or `unlimited` to remove that ceiling. A malformed value fails the
supervisor at startup naming the variable, rather than surfacing later as a failed bot.

### Verification and password recovery email

Password changes for signed-in users require no email configuration. Forgotten-password recovery
appears on sign-in only when a transactional email provider is available. Tangow uses a
provider-neutral contract and ships an SMTP adapter, so Amazon SES, Resend, and self-hosted SMTP
servers use the same configuration:

```env
SMTP_URL=smtps://smtp-user:replace-with-password@smtp.example.com:465
EMAIL_FROM=Tangow <no-reply@example.com>
```

For Resend, use `smtp.resend.com`, username `resend`, and an API key as the password. For Amazon
SES, use the regional SMTP endpoint and SES SMTP credentials; these are different from ordinary AWS
access keys. Verify the sender/domain with the provider before testing delivery. Keep credentials in
`.env`, never in tracked files. `smtps://` uses implicit TLS; `smtp://` is also supported but requires
STARTTLS. Tangow rejects configuration that disables TLS or certificate verification.

Local source development can use the offline email emulator instead. It captures email without
contacting a provider:

```env
EMAIL_EMULATOR=true
```

The emulator is forcibly disabled when `NODE_ENV=production` and requires the API to bind to a
loopback host. In `NODE_ENV=development`, captured messages are available from
`http://127.0.0.1:3100/api/dev/emails` with cache disabled; the API logs only delivery
metadata, never reset tokens. The inbox route is not registered in test, staging, or production.

### Logging

Backend services write structured logs to stdout. `LOG_LEVEL` is `debug`, `info`, `warn`, `error`,
or `off` (default `info`). Production defaults to `LOG_FORMAT=json`; development defaults to pretty
unless you set `json` or `pretty`.

Axiom is optional. Set both `AXIOM_TOKEN` and `AXIOM_DATASET` for ingest to one shared dataset.
Services set `service.name` (`tangow-api`, `tangow-worker`, `tangow-sandbox-supervisor`,
`tangow-updater`). A partial Axiom config logs a one-time warning and stays off. `AXIOM_EDGE` is a
regional hostname; `AXIOM_EDGE_URL` must be https and wins when both are set.

Compose passes these into the API, worker, supervisor, and updater. Computer containers and updater
child commands do not receive them.

### Agent traces

Exporting agent traces is optional and off unless configured. Set both `LANGFUSE_PUBLIC_KEY` and
`LANGFUSE_SECRET_KEY` to send each bot run to an OpenTelemetry endpoint as a tree: the run with its
instructions, prompt and final output, one generation per model request with its transcript, response,
model, token counts and latency, and one span per tool call with its arguments, result and status. The controller records this from
what it relays for the worker. Each generation includes the normalized transcript sent to the model
and its response, including thinking and tool calls when provided. Image bytes are omitted. A call
of the worker's own tools (shell, files) is timed by when the worker reports it. A `browser_run` call
nests one generation per decision step under its tool span,
carrying the redacted request, the answers (or why none was usable), the gate, model, tokens and
cost. Tangow's own model calls (history compaction, learned facts, the team-chat judge and
auto-review) are exported too, one trace per call.
`LANGFUSE_BASE_URL` defaults to `https://cloud.langfuse.com` and points a self-hosted instance
or any other OTLP/HTTP backend at the same traces; it must be https unless it is loopback.
`LANGFUSE_ENVIRONMENT` labels the traces (`production`, `staging`). A partial configuration logs a
one-time warning and stays off.

Traces carry full conversation content along with the user, session and bot identifiers. There is no
per-user opt-out: configuring an endpoint exports every run of every user on the deployment, so only
point this at a service you are entitled to disclose your users' conversations to. Run secrets and
the values the log redactor already removes are stripped before anything leaves the process, and an
unreachable endpoint never fails a run.

Optional:

```env
SIGNUPS_ENABLED=true
SIGNUP_ALLOWLIST=you@example.com,@company.com
SANDBOX_PROVIDER=docker   # or e2b. Keep fake only for pnpm test.
WAKEUP_DRIVER=graphile
SANDBOX_IDLE_MS=600000    # pause the bot computer after 10 minutes idle
SANDBOX_COMMAND_TIMEOUT_MS=300000 # stop a shell command after 5 minutes
MAX_TOOL_CALLS_PER_TURN=  # optional Pi turn tool-call fuse; unset/0 = unlimited
E2B_API_KEY=              # when SANDBOX_PROVIDER=e2b
```

To use an operator-controlled OpenAI-compatible server such as Ollama, LM Studio, llama.cpp, or
MLX, list its model IDs and an endpoint that both the API and worker processes can reach:

```env
TANGOW_LOCAL_MODELS=qwen3:4b,llama3.1:8b,qwen3-vl
TANGOW_LOCAL_MODELS_URL=http://127.0.0.1:11434/v1
TANGOW_LOCAL_CONTEXT_WINDOW=32768
TANGOW_LOCAL_MAX_TOKENS=4096
# Optional: model ids on this endpoint that accept images (screenshot computer tools).
TANGOW_LOCAL_VISION_MODELS=qwen3-vl
```

The loopback default is suitable when running Tangow from a source checkout. From containers,
prefer a stable LAN RFC1918 address (not Compose service DNS alone). On Docker Desktop,
`host.docker.internal` also works.
On Docker Desktop, a bot computer shell can often reach services bound to host `127.0.0.1`
through that same hostname. Do not run sensitive unauthenticated services on loopback while
bots run, or firewall / block that path. Linux does not get `host.docker.internal` the same
way by default.
Only configure an endpoint you control: prompts, attachments, and tool results sent to that model
leave Tangow through this URL. Leave `TANGOW_LOCAL_MODELS` blank to disable the provider.

Each user can also connect their own OpenAI-compatible endpoint from **Connect a model** /
**Settings → Models** on web and mobile. Choose **OpenAI-compatible**, enter the server base URL
(for example `http://127.0.0.1:8000/v1`), the exact model id, and an optional API key.
Public hosts and ordinary hostnames need `TANGOW_OPENAI_COMPAT_ALLOW_PUBLIC=1` and HTTPS.
Literal private IP, loopback, and `host.docker.internal` targets do not. If that endpoint's model
accepts images, enable **Supports images** under **Advanced** when connecting so attachments and
screenshot computer tools stay available. Existing connections default to disabled. For centrally
managed endpoints, the deployment-wide fallback remains
`TANGOW_OPENAI_COMPATIBLE_VISION_MODELS=gpt4o-vision,llava`.

For servers that accept standard `reasoning_effort`, enable **Supports thinking** under
**Advanced** when connecting. The setting is saved on the connection (no env var or restart).
Existing connections default to disabled. Reconnect former Qwen-list or deployment-local models
via **Settings → Models** and turn it on; the old environment list is no longer read.

Enabled connections default to medium thinking. Web and desktop expose **Thinking** in a bot's
advanced settings; mobile inherits the same backend policy. Tangow sends standard
`reasoning_effort` (`minimal`, `low`, `medium`, `high`, or `none` when off); the server owns
model-specific translation. Leave **Supports thinking** off when the server lacks standard effort
support. Existing token limits still apply; effort is not a separate reasoning-token budget.

Do not commit `.env`. Never put `COMPOSIO_API_KEY`, OpenRouter keys, or provider tokens in git, logs, or chat.

A Space owner can connect an optional decision provider from **Settings → Decision Model** on web and
desktop. Today the only adapter is OpenRouter's Decisions API, which serves TypeSafe's Jev model: an
OpenRouter API key, and under **Advanced** a base URL for a compatible proxy and a model id (default
`typesafe/jev-1.13`, pinned rather than the `~typesafe/jev-latest` alias). The key is stored
encrypted for the Space and is separate from `OPENROUTER_API_KEY` and model connections; no
environment variable is read. With a connection, bots get `browser_run` and complete multi-step page
tasks without reading the page at every step (see [computer runtime](computer-runtime.md)); page
URLs, titles, bounded page text, element names and field values (never passwords) then go to that
provider. Without one nothing changes. Loopback, private-network, and plain-HTTP base URLs can only
be saved by the deployment owner.

Optional messaging platforms (iMessage, Slack, WhatsApp, Telegram, Feishu/Lark) mount when their env credentials are set — see `.env.example`. Point a Feishu/Lark bot event subscription at `/api/v1/messaging/webhook/lark` (webhook/HTTP inbound only; do not enable long connection). Groups stay iMessage-only.

### Learned skills

`SKILL_LEARNING` decides whether bots keep and improve their methods as skills on their own. The
API and worker read it at start.

- `off`: a bot saves a skill when it judges a task worth repeating, and mentions `/Name` after
  creating or updating one.
- `shadow` (default) and `on`: a bot keeps or improves the skill it followed and no longer mentions
  it, since the line under its message shows the change.

Unset or empty means `shadow`; a value that is not one of the three means `off`.

`shadow` and `on` both stop the bot's announcement, so a client that does not show the skill line
shows nothing when a skill changes. The web app always shows it; the desktop app and the iPhone app
do from the release that added the line. If some clients in use are older, set `SKILL_LEARNING=off`
until the desktop app is rebuilt and the iPhone app updated. To switch, set `SKILL_LEARNING` in
`.env` and recreate the `api` and `worker` services with the `docker compose ... up -d` command you
deploy with.

Live evaluations of this behaviour are described in [agent verification](agent-verification.md).

### Agent feedback

Bots can report problems with Tangow itself, such as a tool that blocked them, something that
malfunctioned or a task that took far too many steps, as issues in a GitHub repository you choose.
The `report_issue` tool is offered only once this is set up. A bot calls it on its own judgment; it does
not pause the run or ask anyone for help.

1. Create a **private** repository for the reports. A report describes what the bot saw, so it can
   quote conversation content.
2. Create the labels `agent-feedback`, `blocked`, `bug` and `friction` in it. Every issue gets
   `agent-feedback`, plus `blocked`, `bug` or `friction` depending on the kind of report. If a
   label is missing, GitHub may create it the first time it is used, when the token allows that.
3. Create a fine-grained personal access token for that repository only, with the **Issues: Read
   and write** repository permission.
4. Set these in `.env`, then recreate the `api` and `worker` services:

   ```sh
   FEEDBACK_PROVIDER=github
   FEEDBACK_GITHUB_REPOSITORY=your-org/your-feedback-repo
   FEEDBACK_GITHUB_TOKEN=
   ```

   An incomplete setup stops both services at start. The token stays on the server: bots never see
   it, and it is masked like the deployment's other keys.

An issue has two parts. The bot's report: the problem, what it expected, the impact, and the tool
and a short reproduction when it gives them. What Tangow observed: run, thread and bot ids, the
model, the runtime, the deployed version (`GIT_SHA`) when known, the time, and counters read while
the run is still going. The counters are not final totals. Model calls include compaction calls,
so they do not count agent steps, and the tool-call audit can miss calls. Issues contain no
transcripts, files, or raw tool arguments and results. Known secrets are masked in the text, but
the bot writes it freely, so masking does not make a report anonymous.

Each report is recorded in the database before delivery, as a `report_issue` row in
`external_effects` that is deleted with its run. That row also stores the outcome: the issue URL,
or why delivery failed. Delivery gives up after 15 seconds. A failed delivery never fails the bot's
task, and the bot is told that the report was recorded but not delivered. Nothing retries it
automatically, including after a restart in the middle of a delivery, so an undelivered report
stays only in that row.

## Choosing a computer provider

The Electron desktop app is a client of the same API, with the same Docker or E2B computers.

- **Docker** is the default for a source checkout and the full local Compose stack. No E2B account
  required. Workspace bots share a persistent Team Computer by default; Private computers are
  optional. Each bot run works in its own short-lived worker container, and bot homes live on
  volumes under `DATA_DIR/volumes`, mounted by the workers and the computer alike. Keep the
  supervisor private, as the included Compose files do. On Docker Desktop (macOS, Windows) a worker
  can reach the host's localhost through `host.docker.internal`; see
  [homes on volumes](./self-host-sandbox-providers.md#homes-on-volumes).
- **E2B** runs bot computers away from the Tangow host and is a good choice for public or multi-user
  production deployments. Each bot run works in its own E2B worker VM, and bot homes live on E2B
  volumes. Set it up with [E2B workers](./self-host-e2b-workers.md).
- **Fake** is only an emulator for verification.
- A missing or incomplete provider setting stops the API and worker at startup with a message
  naming what to set. There is no mode without computers.

For provider configuration and health checks, see the [provider setup guide](./self-host-sandbox-providers.md).
To run Docker computers as Kubernetes pods, see [Kubernetes computers](./self-host-kubernetes.md).

## Backup

```bash
./scripts/backup.sh
```

This dumps Postgres (`pg_dump`) and archives `data/` into `backups/<stamp>/`. A missing
`data/` produces an empty archive; database or archive errors fail the backup. Discard the
output directory of any failed run.

## Public single-VM deployment

`infra/compose/docker-compose.prod.yml` runs the hosted product with Postgres, the API, worker, web app,
and automatic HTTPS through Caddy. It uses E2B for bot computers, so the VM never exposes a Docker
supervisor or browser containers. The root-equivalent updater sidecar is an explicit opt-in profile.

Before deploying to a new Ubuntu host, create and verify a key-only `deploy` account, then apply the
idempotent host-hardening baseline. It disables SSH passwords and root login, rate-limits SSH, allows
only SSH/HTTP/HTTPS through UFW, enables fail2ban, unattended security updates, AppArmor, audit rules,
and conservative kernel/network protections. Keep the provider console open until a fresh SSH login
succeeds after the script reloads SSH.

```bash
sudo DEPLOY_USER=deploy bash infra/compose/harden-host.sh
```

The production host also uses `infra/compose/docker-daemon.json` to enable live restore, bounded local
container logs, default no-new-privileges, and the kernel NAT path instead of Docker's userland proxy.

1. Point an `A`/`AAAA` record such as `app.example.com` at the VM and allow inbound TCP 80/443 and
   UDP 443. If you use Cloudflare, enable the proxy with **Full (strict)** TLS and copy
   `Caddyfile.cloudflare.example` to an operator-controlled path outside the public checkout. Set
   `CADDYFILE_PATH` to that absolute path. The example drops application requests that do not come
   from Cloudflare's [published IP ranges](https://www.cloudflare.com/ips/); reconcile those ranges
   whenever Cloudflare publishes a change. A Cloudflare Tunnel can replace the public web listeners.
2. Clone the repository on the VM and create a root `.env` with production-only values. At minimum set
   `POSTGRES_PASSWORD`, `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, `SCREEN_PROXY_SECRET`,
   `OPENROUTER_API_KEY`, the API key for your selected sandbox provider,
   `TANGOW_HOST`, and the three public origins. Set `TANGOW_DEPLOY_DIR` when the checkout is not at
   the supported Linux default, `/srv/tangow`. Use URL-safe random values for database credentials.
   If you enable the `updater` profile, also set a dedicated `TANGOW_UPDATER_TOKEN` (at least 32
   characters) that differs from `BETTER_AUTH_SECRET`, `SANDBOX_SUPERVISOR_TOKEN`, and
   `SCREEN_PROXY_SECRET`.
3. Keep registration allowlisted while the service is private:

```env
NODE_ENV=production
TANGOW_HOST=app.example.com
# Optional operator-owned override, for example the Cloudflare allowlist file:
# CADDYFILE_PATH=/etc/tangow/Caddyfile.prod
BETTER_AUTH_URL=https://app.example.com
WEB_ORIGIN=https://app.example.com
API_URL=https://app.example.com
SIGNUPS_ENABLED=true
SIGNUP_ALLOWLIST=owner@example.com,reviewer@example.com
# docker or e2b
SANDBOX_PROVIDER=e2b
WAKEUP_DRIVER=graphile
DATA_DIR=/data
# Absolute path of this checkout as the Docker daemon sees it. /srv/tangow is the Linux default;
# set this explicitly for every other layout. See "The deploy directory must be one path" below.
TANGOW_DEPLOY_DIR=/srv/tangow
TANGOW_IMAGE_TAG=local
# Optional: required only with `--profile updater`.
# TANGOW_UPDATER_TOKEN=replace-with-32-plus-character-updater-token
```

4. Build the images from your checkout and start the stack, then verify its public health endpoint:

```bash
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  build --build-arg GIT_SHA=$(git rev-parse HEAD)
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  up -d --wait --pull never
curl --fail https://app.example.com/health
```

**Images are built on the host.** No registry publishes Tangow images: the commands above build
`api`, `worker`, and `web` from the checkout you just cloned, tagged `local`. The opt-in command
under [Updater sidecar](#updater-sidecar) builds `updater` when needed. See
[Images and tags](#images-and-tags) for the tag contract.

Passing `GIT_SHA` is what makes `GET /health` report a `"revision"`; a locally built image has no
other way to know its commit.

The root `.env` is excluded from both Git and the Docker build context. The database, application data,
and Caddy certificates live in named Docker volumes.

The production Compose file pins Postgres and Caddy to multi-architecture manifest digests, and the
application/updater Dockerfiles pin their base-image digests. Refresh those pins deliberately
when taking upstream security updates; changing only the visible major tag does not change the
content while a digest is present.

For the single-VM production layout, install `infra/compose/backup-prod.sh` as
`/usr/local/sbin/tangow-backup` and enable the supplied `tangow-backup.timer`. It creates a verified
Postgres custom-format dump plus an application-data archive under `/var/backups/tangow`, with mode
`0600` and seven-day rotation. These local snapshots help with operator mistakes but are not a
substitute for an encrypted off-host backup or provider snapshot.

## Cloudflare Access

A server published behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/)
answers browsers with a redirect to the team login domain, which the desktop app cannot follow:
it authenticates with a bearer token, not an interactive session. Give the app a **service token**
instead.

1. In Zero Trust, create a service token and copy the client ID and secret. The secret is shown once.
2. Add a policy on the Access application with the **Service Auth** action that matches that token.
   `Bypass` also lets the app through, but it disables Access enforcement *and* logging for everyone
   on the paths it covers.
3. Give the token to the app, as described under **Desktop** or **Mobile** below.

A service token is a single shared identity: per-user, per-group, and device-posture Access policies
no longer distinguish who is connecting, and only the Tangow sign-in tells your users apart. Scope
the policy to that one token, set the shortest workable token duration, and rotate it deliberately.

### Desktop

In the setup screen, paste the client ID and secret into the
Cloudflare Access fields. The app stores the secret with the operating system keychain (Keychain,
DPAPI, or libsecret) and sends it on every request to that server, including the RPC calls, the
event stream, and embedded computer views. Machines without a keychain cannot store the secret, and
the app refuses to save it in cleartext.

### Mobile

Open the server sheet — **Use a custom server** on the sign-in screen, or **Server** in account
settings — enter the server URL, turn on **Cloudflare Access protected**, and paste the client ID and
secret. The app checks the token against the server before saving, stores the secret with
`expo-secure-store` (Keychain on iOS, Keystore on Android), and sends it on every request to that
server: the RPC calls, the event stream, and the Android background notification poller. The stored
secret is never displayed again — re-open the sheet, leave the secret box empty, and saving keeps
the token you already stored. Clearing both fields, or turning the toggle off, removes it.

A token is bound to the server it was entered for, so pointing the app at a different server never
sends it there.

For a fleet build that always talks to one Access-protected server, bake the token in at build time
next to `EXPO_PUBLIC_API_URL`:

```bash
EXPO_PUBLIC_CF_ACCESS_CLIENT_ID=<client-id>
EXPO_PUBLIC_CF_ACCESS_CLIENT_SECRET=<client-secret>
```

Both must be set together or the build fails. The token then applies only to `EXPO_PUBLIC_API_URL`;
a server the user types in still needs its own token.

> **Warning:** `EXPO_PUBLIC_*` values are inlined into the JavaScript bundle at build time, so a
> token passed this way is readable by anyone who unpacks the APK or IPA. Use it only for builds you
> distribute internally, never for a public store release. Enter the token in the app instead when
> it must stay confidential.

The computer view renders the remote screen in a `WebView`, which cannot attach the service token to
the page's subresources or its WebSocket. That view does not work against an Access-protected server
on mobile.
The scheduled backup uses `/srv/tangow` by default. For another deployment directory, set
`TANGOW_DEPLOY_DIR=/absolute/path/to/checkout` in a root-owned `/etc/tangow/backup.env`
(mode `0600`). The service reads this optional file on each run; the script uses the selected
checkout's `.env` and production Compose file. If the stack was started with a custom `-p`,
set the same `COMPOSE_PROJECT_NAME` in that file. For a manual run, export these variables instead.
When updating an existing backup installation, reinstall both the script and service unit,
then run `systemctl daemon-reload`.

## Restore

For backups created by `scripts/backup.sh`, use an empty `tangow` database in the development
Compose stack, with application services stopped. The SQL import runs in one transaction and
stops on the first error, including conflicts with existing tables. Files are restored and
application services started only after the import succeeds. This script does not consume the
production snapshot's custom-format `tangow.dump` or `appdata.tgz`.

```bash
./scripts/restore.sh backups/<stamp>
```

## Upgrade

Take a backup before upgrading (see [Backup](#backup)): an upgrade can move data to a shape the
previous release cannot read, as the [session log migration](#session-log-migration) does.

A Compose deployment upgrades by rebuilding its checkout:

```bash
git pull
GIT_SHA=$(git rev-parse HEAD) docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  up -d --wait --pull never --build api worker web
```

`up --wait` does not report success until the new API is healthy and the worker and web containers
are running. Compose stops the old API and worker, then the one-shot `migrate` service applies the
migrations (`scripts/backfill-session-log.ts`) before the new ones start, so a migration failure
keeps them stopped. A failed CLI recreate does not auto-roll back; recover with the previous
`TANGOW_IMAGE_TAG` (or rebuild `local`) and `up -d --wait --pull never --no-deps api worker web`.

The updater sidecar has its own image and tag so an update never recreates the process performing
it. Move it deliberately by rebuilding it from the checkout:
`docker compose … --profile updater up -d --wait --build updater`.
Sidecar `/apply` and `/rollback` recover a failed recreate by redeploying the previously cached
image when possible; if that also fails, they report a possible mixed-version runtime. Both stop a
`migrate` still running first, and neither restores a release that cannot read the database.

A source checkout (not Compose) upgrades with its API and worker stopped:

```bash
./scripts/backup.sh
git pull
pnpm install --frozen-lockfile
pnpm exec tsx scripts/backfill-session-log.ts
pnpm exec tsx scripts/migrate-docker-homes.ts
```

then starts them again. Product contracts stay compatible across cloud and self-hosted.

### Session log migration

This release moves every conversation into the session log and drops the `messages` table.
`scripts/backfill-session-log.ts`, which the Compose `migrate` service runs before the API and the
worker start, applies the migrations, then moves each thread's messages into its sessions and drops
the table, logging every thread and the total time. It runs as one transaction: when a thread cannot
be moved, nothing is written, the table stays, and the script exits naming every such thread. Once
it has succeeded, running it again changes nothing. On a large database it takes minutes; the
updater waits up to an hour.

The API does the same when it starts, so a deployment still on its previous Compose file, which has
no `migrate` service, can upgrade within these limits:

- `docker-compose.prod.yml` marks the API unhealthy after about 200 s
  (a check every 10 s, 20 retries), and the worker waits for a healthy API. The move has to fit in
  that window: about 500,000 messages at the rate measured here (50,000 messages in 18 s), fewer on
  a slower host. Past it, `up` fails and the worker stays stopped.
- `docker-compose.yml` starts the worker with the API, and a run the worker logs into a thread
  before the move reaches it makes that thread refuse. Stop the worker until the API is up.
- When a thread cannot be moved, the API exits with the same message and Compose restarts it, which
  repeats the whole move until the override runs.

Past these limits, refresh the Compose file first, or run the move before `up` with
`docker compose … run --rm --no-deps api pnpm exec tsx scripts/backfill-session-log.ts`. Migration
`20261012000000_drop_messages` drops the table only once every message is in the log, so a bare
`prisma migrate deploy` never fails on it and leaves the move to the script or the API.

A thread whose log already holds entries takes the messages written after its newest entry at the
end of its log; one written at the same instant counts as newer. Messages older than its entries,
which a database that ran an earlier build of the session log can hold, refuse the thread. Both
times come from the clocks of the processes that wrote them, so a worker and an API whose clocks
disagreed can make a thread refuse too. Rebuild such a thread from its messages, or with `--all` every
thread that still has messages to move:

```bash
pnpm exec tsx scripts/backfill-session-log.ts --rebuild-from-messages <thread-id>[,<thread-id>…]
pnpm exec tsx scripts/backfill-session-log.ts --rebuild-from-messages --all
```

Under Compose, run it through the service: `docker compose … run --rm migrate pnpm exec tsx
scripts/backfill-session-log.ts --rebuild-from-messages <thread-id>`, or through `run --rm --no-deps
api` on the previous Compose file. A rebuild deletes the thread's sessions and every entry in them,
then writes the whole conversation again from its messages: everything that was said stays, and the
run traces written since the session log began (tool calls, helpers' sessions, card answers) are
dropped. A delivery another thread received from it keeps the old session's ids, so following it back
can open the thread at its latest messages rather than at the message it came from.

A thread that cannot be converted stops the move with the error. Read its messages with `psql`:

```sql
SELECT seq, role, jsonb_pretty(blocks) FROM messages WHERE "threadId" = '<thread-id>' ORDER BY seq;
```

To keep that thread's messages outside the database and let the rest move, export them, then
delete them:

```bash
psql "$DATABASE_URL" -At -c "SELECT row_to_json(m) FROM messages m
  WHERE m.\"threadId\" = '<thread-id>' ORDER BY m.seq" > messages-<thread-id>.jsonl
psql "$DATABASE_URL" -c "DELETE FROM messages WHERE \"threadId\" = '<thread-id>'"
```

Once the move has succeeded, a release older than it cannot read the database: the updater refuses
to roll back to one, and after a failed update it leaves the services stopped rather than start one.
Going back means restoring the backup taken before the upgrade into an empty database, then starting
the previous tag. On the single-VM layout, with `TANGOW_IMAGE_TAG` in `.env` set back to that tag:

```bash
compose="docker compose --env-file .env -f infra/compose/docker-compose.prod.yml"
$compose stop api worker web
$compose exec -T postgres sh -c 'dropdb -U "$POSTGRES_USER" --force "$POSTGRES_DB" &&
  createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
$compose exec -T postgres sh -c 'pg_restore --no-owner -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  < /var/backups/tangow/<stamp>/tangow.dump
$compose up -d --wait --pull never --no-deps api worker web
```

A thread can also be kept as files, one JSONL file per session, and imported into another thread
that has none yet:

```bash
pnpm exec tsx scripts/session-log-export.ts <thread-id> <directory>
pnpm exec tsx scripts/session-log-import.ts <directory> <thread-id>
```

### Homes on volumes

On Docker, the `migrate` service then moves each idle computer's home onto its volumes, renaming
its folders inside `DATA_DIR` (`scripts/migrate-docker-homes.ts`). A computer still running moves
the next time it goes to sleep. See [homes on volumes](./self-host-sandbox-providers.md#homes-on-volumes).

On E2B, the API refuses to start while a computer still keeps its home on snapshots, and names
each one. Move them with `scripts/migrate-home-to-volumes.ts` as
[E2B workers](./self-host-e2b-workers.md#move-existing-homes-onto-volumes) describes.

### Space privacy-boundary migration

Before upgrading across migration `20260830200000_space_scope_names_and_user_credentials`, check
that every existing model and voice credential still belongs to a member of its Space. This query
uses the pre-migration `workspaceId` column name and must return no rows:

```sql
SELECT 'model' AS credential_type, credential."id", credential."userId",
       credential."workspaceId" AS "spaceId"
FROM "user_model_credentials" AS credential
LEFT JOIN "space_members" AS membership
  ON membership."spaceId" = credential."workspaceId"
 AND membership."userId" = credential."userId"
WHERE membership."id" IS NULL
UNION ALL
SELECT 'voice', credential."id", credential."userId", credential."workspaceId"
FROM "user_voice_credentials" AS credential
LEFT JOIN "space_members" AS membership
  ON membership."spaceId" = credential."workspaceId"
 AND membership."userId" = credential."userId"
WHERE membership."id" IS NULL;
```

The migration renames columns used by the API and worker and is therefore a coordinated cutover,
not an online rolling migration. Stop the old API and worker, apply the migration, and start the new
versions together. Its lock waits are bounded so contention fails the migration instead of leaving
application traffic queued indefinitely.

### Images and tags

Every image is built on the host from the checkout; no registry publishes them.

| Image | Contents |
| --- | --- |
| `tangow/app` | api, worker, web, and sandbox supervisor — one image, multiple commands |
| `tangow/updater` | the updater sidecar, plus the Docker CLI |
| `tangow/computer` | Linux desktop used as each bot computer with the Docker provider |

`TANGOW_IMAGE` and `TANGOW_UPDATER_IMAGE` name the app and updater images. A deployment whose `.env`
already sets them keeps its value, so the images it built stay usable for rollback.

| Tag | Built by | Moves? |
| --- | --- | --- |
| `local` | the first `up --build` | rebuilt in place |
| `local-<full-commit>` | each update | never |

`docker compose up --build` builds for the host's own architecture, without QEMU.

Rollback redeploys the previous tag from the local Docker cache. Do not prune the previous
application image until the next update has been accepted. If it is missing, rollback fails closed.

### Updater sidecar

Compose production deployments offer an opt-in `updater` profile on a private `control` network.
Normal deployments do not start it or require its credential. To enable it, set a dedicated
`TANGOW_UPDATER_TOKEN` and explicitly start the profile:

```bash
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  --profile updater up -d --build updater
```

It exposes `/health`, `/state`, `/plan`, `/apply`, and `/rollback` at `http://updater:7092` with
`TANGOW_UPDATER_TOKEN`. Operator CLI upgrades above do not need it; the sidecar is for automated
apply/rollback over that private HTTP API.

The API cannot update itself — its image has no `.git`, and nothing inside the container would
restart it — so the work happens in a separate `updater` container that outlives the recreate:

it fast-forwards the checkout in `TANGOW_DEPLOY_DIR`, pins `local-<commit>` in `.env`, keeps the
outgoing tag in `TANGOW_IMAGE_TAG_PREVIOUS`, and runs `up -d --build`. This builds on the server
and takes minutes rather than seconds. Point it only at a repository you control and have reviewed
— the sidecar runs that Compose file through a root-equivalent Docker socket.

Updates and rollbacks run one at a time. A failed recreate restores the previous environment
pin and attempts to redeploy the cached previous image. A failed build also restores the
pre-update branch and commit (including when checkout succeeded but merge did not) so a later
manual `--build` cannot deploy the rejected or unintended revision. Database migrations are not
reversed. The sidecar never recreates itself, never touches Postgres or Caddy, and never runs
migrations itself — that ordering belongs to the `migrate` service, which a recreate waits on for up
to an hour and a recovery or a rollback skips.

Only `https://` and `ssh://` git remotes are accepted. Merges are fast-forward only. A dirty or
untracked source tree fails closed before anything runs (the application Dockerfile uses `COPY . .`).

### The deploy directory must be one path

`TANGOW_DEPLOY_DIR` is bind-mounted into the updater at the same path it is read from
(`${TANGOW_DEPLOY_DIR}:${TANGOW_DEPLOY_DIR}`), and that is load-bearing rather than tidy. Production
Compose defaults both sides to `/srv/tangow`; set the variable for any other layout. When the
updater runs `docker compose -p <project> --file $TANGOW_DEPLOY_DIR/infra/compose/docker-compose.prod.yml up -d`,
the Compose CLI *inside* the container expands this file's relative bind mounts — `../../.env`,
`./Caddyfile.prod` — against that path and hands the results to the daemon. The daemon has to be
able to resolve the same strings, or it silently creates empty directories where your `.env` and
Caddyfile should be. Compose makes the effective `-p` value available for interpolation but does
not automatically put it in a container's environment, so the production file explicitly assigns
`COMPOSE_PROJECT_NAME` to the updater. A standalone sidecar can instead set
`TANGOW_COMPOSE_PROJECT_NAME`; the final fallback is `tangow-prod`. Without that propagation, a
stack started with `-p something-else` would be left alone while a second project with a new empty
Postgres volume came up beside it.

### Deployments that layer a Compose overlay

`TANGOW_COMPOSE_FILE` takes a list, separated the way Compose's own `COMPOSE_FILE` is
(`:` by default, or whatever `COMPOSE_PATH_SEPARATOR` says). Each entry becomes its own `--file`,
in the order given, so the updater reconciles the same stack the operator runs by hand:

```
TANGOW_COMPOSE_FILE=infra/compose/docker-compose.prod.yml:ops/compose/overlay.yml
```

Every entry is validated separately and must stay inside `TANGOW_DEPLOY_DIR`.

If the overlay adds a service built from the application image, name it in
`TANGOW_UPDATE_SERVICES` (comma separated) so it is pulled, recreated and rolled back with the
rest. Otherwise an update leaves that service running the previous code:

```
TANGOW_UPDATE_SERVICES=supervisor
```

These names are appended to the built-in `api`, `worker`, `web`, never substituted for them, so no
value here can drop a core service from an update.

The value therefore has to be the path **the daemon** sees, which is not always the path your shell
sees:

- **Linux.** The daemon shares the host filesystem, so the checkout path is the answer:
  `/srv/tangow` is the default and supported production layout. Set `TANGOW_DEPLOY_DIR` explicitly
  when the checkout is elsewhere.
- **Docker Desktop (Windows/macOS).** The daemon runs in a VM that mounts your drive somewhere else.
  On Windows, `C:` appears at `/run/desktop/mnt/host/c`, so a checkout at `C:\Users\you\tangow` is
  `TANGOW_DEPLOY_DIR=/run/desktop/mnt/host/c/Users/you/tangow`. Host Git may use `core.autocrlf=true`; the updater ignores CR-only diffs so that does not block `/apply`. Verify the mount before deploying:

```bash
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  --profile updater run --rm updater git -C "$TANGOW_DEPLOY_DIR" log --oneline -1
```

  That must print your checkout's HEAD. The two tempting wrong answers both fail: a native Windows
  path is rejected by the daemon (`mount denied: … too many colons`, because the drive letter's
  colon collides with the bind-mount separator), and `/mnt/c/...` fails *silently* — the container
  starts, the mount is an empty directory, and the updater simply reports no checkout.

### The updater's privileges

The updater holds the Docker socket, which is root-equivalent on the host. It is scoped as narrowly
as that allows:

- No `ports`, so nothing is published on the host.
- Only on the dedicated `control` network shared with the API. Caddy is not attached, so the
  reverse proxy has no route to the updater.
- Every route except `/health` requires the shared bearer token, compared in constant time.
- The process environment carries only updater settings (`TANGOW_UPDATER_TOKEN`, deploy path,
  image name, project name). Application secrets stay in the bind-mounted `.env` that Compose
  reads for interpolation; they are not loaded into this container.
- The Docker CLI lives only in the updater image. The api, worker, and web containers keep
  `cap_drop: ALL` and no socket.

Enabling the `updater` profile requires `TANGOW_UPDATER_TOKEN` to be a dedicated random value (at
least 32 characters in production). It must differ from `BETTER_AUTH_SECRET`,
`SANDBOX_SUPERVISOR_TOKEN`, and `SCREEN_PROXY_SECRET`. Leave the profile disabled if you would
rather not grant the capability.

## Other deployment layouts

API and worker need always-on processes; serverless request handlers are not sufficient. Use a
Node.js version supported by the root `package.json`, Postgres 16 and a persistent `DATA_DIR` volume shared by API and worker, with encrypted off-host
backups. The current home store uses a local filesystem, so deployments on separate hosts need a
shared filesystem; an object-storage adapter is not available yet.

Use the same HTTPS origin for the web app, `/api`, and `/rpc`. Preserve the authenticated screen
proxy routes. Choose a [computer provider](#choosing-a-computer-provider) appropriate to the
service's trust boundary, and configure `SIGNUPS_ENABLED` and `SIGNUP_ALLOWLIST` before the API's
first start.

## Connect mobile clients

The iOS and Android app can also point at a self-hosted origin at runtime. On the sign-in screen, tap **Use a custom server**, or open **Server** in account settings, and enter the same HTTPS origin as `WEB_ORIGIN` (for example `https://app.example.com`). Store builds still default to `EXPO_PUBLIC_API_URL`; the in-app setting is an override for people running their own API. Changing the server signs the device out of any previous session.
