# Production bot vault

The production Compose stack starts OpenBao on its internal data network.
OpenBao initializes Transit and AppRole on first boot and stores their state
in the production Postgres database in `openbao_kv_store`. The API and worker
start after the OpenBao container starts. They can serve other features while
the vault is unavailable. OpenBao has no published port.

The production install and upgrade commands in [Self-host Tangow](./self-host.md)
create the three vault files together in `infra/compose/openbao-private/`. If
a file is missing later, restore all three originals. The directory has mode
`0700`. The files have mode `0444` so non-root containers can read them through
individual read-only mounts. Only OpenBao receives `unseal.key`. The API and
worker read `role-id` and `secret-id` from their mounts through
`VAULT_ENGINE_CREDENTIAL_DIR`. Keep all three original files for restarts.
Host administrators can access both the files and the database.

The production vault stores saved bot keys. Other Tangow secrets continue to
use `ENCRYPTION_KEY`. Source Compose, desktop and development without Docker
use local encryption by default.

## Back up and restore

Keep an encrypted off-host copy of the full production Postgres dump and a
separate protected copy of the three original vault files. The scheduled
production database backup includes `openbao_kv_store`. It leaves out the
vault files so the dump does not carry its own unseal key. The development
`scripts/backup.sh` and `scripts/restore.sh` use the source stack.

Run from the production checkout. These commands replace the target database.
Restore the three original files to `infra/compose/openbao-private/` with the
permissions above before starting OpenBao.

```bash
set -e
compose=(docker compose --env-file .env -f infra/compose/docker-compose.prod.yml)
"${compose[@]}" stop api worker web openbao
"${compose[@]}" up -d --wait postgres
"${compose[@]}" exec -T postgres sh -ec '
  dropdb --if-exists --force -U "$POSTGRES_USER" "$POSTGRES_DB"
  createdb -U "$POSTGRES_USER" "$POSTGRES_DB"
'
"${compose[@]}" exec -T postgres sh -c \
  'pg_restore --exit-on-error --no-owner -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  < tangow.dump
"${compose[@]}" up -d --wait openbao
"${compose[@]}" exec -T openbao bao status
"${compose[@]}" up -d --wait api worker web
```

### Reset a vault whose files are lost

If the original files cannot be recovered, reset the vault. This permanently
deletes saved bot keys. Save them again after the restart. Other Tangow data
and secrets are preserved.

```bash
set -e
compose=(docker compose --env-file .env -f infra/compose/docker-compose.prod.yml)
"${compose[@]}" stop api worker openbao
"${compose[@]}" exec -T postgres sh -c '
  psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -c "DROP TABLE IF EXISTS openbao_kv_store; DELETE FROM bot_secrets;"
'
rm -f infra/compose/openbao-private/{unseal.key,role-id,secret-id}
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/checkout" -w /checkout node:22-bookworm@sha256:0557ac14e0d45d02ed563067b82856ca5e7aa3437fa28d98d4350ea9c3d9494a node scripts/tangow-vault.mjs
"${compose[@]}" up -d --wait --force-recreate openbao api worker
```

## Outages

When OpenBao is unreachable or sealed, saving a bot key fails and bots cannot
use saved keys. The vault never falls back to local encryption.
