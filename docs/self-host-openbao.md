# Self-host OpenBao

The optional production Compose overlay starts OpenBao 2.7.3 on the internal
database network. OpenBao stores its Transit key and AppRole state in the
existing Postgres database, in `openbao_kv_store`. The API and worker continue
to use the local vault.

## Install

On a fresh OpenBao installation, run from the repository root. The directory
must be new. Keep it accessible only to the operator. The read-only files inside
are mounted individually so the non-root OpenBao container can read them.

```sh
(
  set -eu
  umask 077
  vault_dir=infra/compose/openbao-private
  mkdir "$vault_dir"
  for file in unseal.key role-id secret-id; do
    openssl rand -hex 32 | tr -d '\n' > "$vault_dir/$file"
    test "$(wc -c < "$vault_dir/$file")" -eq 64
    chmod 0444 "$vault_dir/$file"
  done
)
```

Use the same environment file and Compose project as the production stack.

```sh
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  -f infra/compose/docker-compose.openbao.yml up -d --wait openbao
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml \
  -f infra/compose/docker-compose.openbao.yml exec -T openbao bao status
```

On first boot OpenBao reads the static unseal key and provisions Transit and the
application AppRole. Keep the original files for restarts. The adapter selector
accepts `VAULT_ENGINE=openbao`, `VAULT_ENGINE_URL` set to the internal OpenBao
endpoint, and `VAULT_ENGINE_CREDENTIAL` as JSON with `roleId` and `secretId` from
the two credential files. The API and worker do not read these settings yet.
OpenBao listens over plain HTTP, so use that endpoint only on the internal
`data` network.

## Back up and restore

Keep these three items in protected off-host backups.

1. The full Postgres dump, including `openbao_kv_store` and the Tangow records.
2. The original `unseal.key` file.
3. The original application AppRole credential files, `role-id` and `secret-id`.

Stop OpenBao and Tangow. Restore the full dump into an empty database with
`pg_restore --exit-on-error`, following the
[production dump restore example](./self-host.md#session-log-migration). Restore
the three files under `infra/compose/openbao-private/` with the install
permissions. Start OpenBao with the overlay and confirm it reports initialized
and unsealed before starting Tangow.

On a single host, the unseal key and database are both accessible to a host
administrator. Once a deployment switches to OpenBao, reads report the vault
as unavailable and writes fail when the service is unreachable or sealed. The
adapter gives each operation two seconds and never falls back to local encryption.
