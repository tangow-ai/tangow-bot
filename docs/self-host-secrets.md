# Self-host secrets checklist

Required and optional credentials for Compose deploys from a source checkout.

**Never commit `.env`, never paste secret values into issues/PRs, and never
overwrite an existing `.env` without an explicit backup and operator consent.**

## Required keys

Copy `.env.example` to `.env` and fill these before the first `compose up`:

| Key | Generate with | Role |
| --- | --- | --- |
| `POSTGRES_PASSWORD` | `openssl rand -hex 16` | Postgres role password inside Compose |
| `BETTER_AUTH_SECRET` | `openssl rand -hex 32` | Auth/session signing |
| `ENCRYPTION_KEY` | `openssl rand -hex 32` | Encrypts stored credentials at rest |
| `SCREEN_PROXY_SECRET` | `openssl rand -hex 32` | Signs short-lived `/novnc/*` screen capabilities |
| `SANDBOX_SUPERVISOR_TOKEN` | `openssl rand -hex 32` | API ↔ sandbox supervisor auth |

Empty required keys fail closed at Compose validate time (`${VAR:?Set … in .env}`).

Put the same `POSTGRES_PASSWORD` in host-side `DATABASE_URL` when using the optional
`docker-compose.postgres-host.yml` overlay. Keep the password URI-safe: Compose
interpolates it into `DATABASE_URL`. Hex from `openssl rand` is safe; characters such as
`@ : / ? # %` are not.

Existing `pgdata` volumes keep the user, password, and database from first init (often the
former hardcoded `tangow` / `tangow`). Keep those values in `.env`, or change them in place
with `ALTER ROLE` / rename. Recreate the volume only after a backup (or when the data is
disposable); `docker compose down -v` deletes all Postgres state.

## Distinctness rules

These must be **independent** random values (do not copy-paste the same
secret into multiple keys):

- `BETTER_AUTH_SECRET`
- `ENCRYPTION_KEY`
- `SCREEN_PROXY_SECRET`
- `SANDBOX_SUPERVISOR_TOKEN`
- `TANGOW_UPDATER_TOKEN` (only if the updater profile is enabled; ≥32 chars,
  also distinct from the four above)

Rotating `ENCRYPTION_KEY` after credentials were stored makes old ciphertext
unreadable. Keep the original key for an existing deployment unless you
intentionally wipe encrypted material.

## Optional keys (leave blank if unused)

| Key(s) | When needed |
| --- | --- |
| `OPENROUTER_API_KEY` | Deployment-wide OpenRouter models |
| `COMPOSIO_API_KEY` | Composio managed catalog |
| `E2B_API_KEY` | Remote computers and run workers when `SANDBOX_PROVIDER=e2b` ([E2B workers](./self-host-e2b-workers.md)) |
| `SMTP_URL` / `EMAIL_FROM` | Password-recovery email |
| Messaging tokens (Slack, Telegram, …) | Only if you enable those surfaces |
| `FEEDBACK_GITHUB_TOKEN` | Agent feedback issues ([setup](./self-host.md#agent-feedback)) |

If `sandbox` in `/health` is `"none"` or the supervisor never becomes healthy,
check that `SANDBOX_SUPERVISOR_TOKEN` is set and non-empty for the Docker
computer path. A missing token is a setup failure, not an "optional tighten
later" item.

## Production bot keys

Production Compose uses OpenBao for saved bot keys. Keep the original
`unseal.key`, `role-id` and `secret-id` in a protected backup separate from
the database dump. A sealed or unreachable vault blocks both saving and using
bot keys. Other Tangow secrets continue to use `ENCRYPTION_KEY`.

## Recovery without reprinting secrets

- Lost UI password: use SMTP recovery if configured; otherwise operator
  identity recovery is out of band (DB). Prefer not to rotate
  `BETTER_AUTH_SECRET` casually on a live deploy.
- Lost `.env`: from backup only. Recreating random secrets on a volume that
  still holds Postgres data will desynchronize passwords and encryption.
- Moving hosts: copy `.env` and volumes together; treat `.env` as secret
  material in transit.

## Related

- [Self-hosting](./self-host.md)
- [Production OpenBao vault](./self-host-openbao.md)
