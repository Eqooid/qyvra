# QYVRA Docker namespace migration

The default Compose project is now `qyvra`, set once by top-level `name:` in
`docker-compose.yml`. The checkout directory no longer determines its default.
Generic services and DNS names (`api`, `web`, `postgres`, `rabbitmq`, `redis`)
remain unchanged, as do Nginx routing, ports, application contracts and migrations.
All three persistent mounts retain their volume-root layout; only the container
storage mount target changes from `/data/brainless` to `/data/qyvra`. Stored keys
are relative, so this requires no file relocation or database rewrite.

## Resource names

| Resource | Fresh default | This migrated development checkout |
| --- | --- | --- |
| Containers | `qyvra-api-1`, `qyvra-web-1`, `qyvra-worker-1`, `qyvra-outbox-1`, `qyvra-migrate-1`, `qyvra-postgres-1`, `qyvra-rabbitmq-1`, `qyvra-redis-1`, `qyvra-nginx-1` | Same |
| Built images | `qyvra-api:latest`, `qyvra-web:latest`, `qyvra-worker:latest`, `qyvra-outbox:latest`, `qyvra-migrate:latest`, `qyvra-nginx:latest` | Same |
| Network | `qyvra_default` | Same |
| PostgreSQL volume | `qyvra_postgres_data` | Existing `brainless_postgres_data` |
| Uploaded files volume | `qyvra_storage_data` | Existing `brainless_storage_data` |
| RabbitMQ volume | `qyvra_rabbitmq_data` | Existing `brainless_rabbitmq_data` |
| File mount / worker readiness | `/data/qyvra` / `/tmp/qyvra-worker-ready` | Same |
| E2E namespace | `qyvra-e2e*`, `.tools/qyvra-e2e.env`, database/user `qyvra_e2e` | Fresh isolated fixtures; old test volumes retained |

Third-party image names are unchanged. No explicit `container_name` or image tag
is necessary: Compose generates these names from the project and existing services.
`COMPOSE_PROJECT_NAME` or `-p` still overrides the default for deliberate isolation;
avoid an unintended old override in a shell, `.env`, or deployment environment.

## Existing data: map before switching

**Changing only the project name would create new empty volumes.** For an existing
installation, first inspect the old container mounts and broker hostname:

```sh
docker inspect brainless-postgres-1 brainless-api-1 brainless-rabbitmq-1 --format '{{.Name}} hostname={{.Config.Hostname}} {{range .Mounts}}{{.Name}}:{{.Destination}} {{end}}'
```

Keep the existing `POSTGRES_*` values and RabbitMQ user/password. Add mappings to
the existing private `.env`, using the actual inspected names:

```dotenv
POSTGRES_VOLUME_NAME=brainless_postgres_data
STORAGE_VOLUME_NAME=brainless_storage_data
RABBITMQ_VOLUME_NAME=brainless_rabbitmq_data
PERSISTENT_VOLUMES_EXTERNAL=true
RABBITMQ_USER=brainless
RABBITMQ_HOSTNAME=<existing-broker-hostname>
```

These mappings were applied to this checkout without changing any credentials.
The preserved broker hostname is `e055a4cd4809`; RabbitMQ's persisted Erlang node
identity is `rabbit@e055a4cd4809`. A new hostname would select different persisted
node data. Fresh stacks instead use stable hostname `rabbitmq` and user `qyvra`.
External volume mode fails if a mapped volume is absent and protects those volumes
from Compose volume removal. Fresh stacks leave it false and need no mappings.

Build first, then stop the old project before starting the new one. Never run two
PostgreSQL or RabbitMQ instances against the same volumes:

```sh
docker compose config --quiet
docker compose build
docker compose -p brainless stop
docker compose up -d --wait --wait-timeout 240
```

Use the actual old project if it was different. Stopped old containers, images and
the old network remain available; no old volume is deleted or recreated. Redis
progress is disposable and may disappear on restart. Durable processing jobs,
broker queue names and Redis key prefixes retain their existing application
identifiers (`brainless.processing.*`, `brainless:processing:progress:*`).

The E2E runner now uses a **new, empty isolated** QYVRA test namespace and generates
new credentials in `.tools/qyvra-e2e.env`. It does not migrate or delete old
`brainless-e2e*` volumes or `.tools/brainless-e2e.env`. Tests must not use the
development volume mappings. See [testing](development/testing.md).

## Optional physical volume rename

Keeping the old physical volume names is the recommended data-preserving migration.
If physical QYVRA names are required later, stop both stacks, take a PostgreSQL
backup, verify that destination volumes are empty, then copy each complete volume.
Do not merge into an existing destination. Example for uploaded files, executed
only after those checks (the destination is intentionally new):

```sh
docker volume create qyvra_storage_data
docker run --rm --user root --entrypoint sh -v brainless_storage_data:/source:ro -v qyvra_storage_data:/target qyvra-api:latest -c 'cd /source && tar cpf - . | tar xpf - -C /target'
```

For PostgreSQL and RabbitMQ, use the same offline copy procedure with their respective
source/destination volumes, preserving owners, permissions and the broker hostname.
Then change the three `.env` mappings to the copied QYVRA volumes, retain external
mode, start QYVRA and verify database counts, file checksums and broker state.
Keep original volumes for rollback; no physical copy or deletion is automated.

## Remaining old names and manual cleanup

Remaining Docker-related old names are intentional migration mappings/credentials,
legacy leak-check assertions, historical release/verification records, and generated
old Docker resources. Old repository URLs and host storage paths are unchanged.
No current Docker name or storage-path rename is missing. No CI/CD workflows or
additional environment templates exist in this repository.

After successful verification, optional non-volume cleanup is:

```sh
docker compose -p brainless down
# Review images before removing only the obsolete tags:
docker image ls --filter 'reference=brainless*'
docker image rm brainless-api:latest brainless-web:latest brainless-worker:latest brainless-outbox:latest brainless-migrate:latest brainless-nginx:latest
```

Do not add `--volumes` or run volume pruning: the migrated stack still uses the
three old development volumes. Old E2E volumes are also retained. The actual
remaining-resource inventory and validation results are recorded below.

### Retained resource inventory (2 October 2026)

Stopped containers: `brainless-api-1`, `brainless-web-1`, `brainless-worker-1`,
`brainless-outbox-1`, `brainless-migrate-1`, `brainless-postgres-1`,
`brainless-rabbitmq-1`, `brainless-redis-1`, `brainless-nginx-1`.
The retained network is `brainless_default`.

The three development volumes are still **in use by QYVRA**:
`brainless_postgres_data`, `brainless_storage_data`, `brainless_rabbitmq_data`.
Do not remove them. Retained old test volumes are:

```text
brainless-e2e_postgres_data
brainless-e2e_storage_data
brainless-e2e_rabbitmq_data
brainless-e2e-v11_postgres_data
brainless-e2e-v11_storage_data
brainless-e2e-t13_postgres_data
brainless-e2e-t13_storage_data
brainless-e2e-t13_rabbitmq_data
```

Retained old image tags (all `:latest`) are:

```text
brainless-api                 brainless-web
brainless-worker              brainless-outbox
brainless-migrate             brainless-nginx
brainless-e2e-api             brainless-e2e-web
brainless-e2e-worker          brainless-e2e-outbox
brainless-e2e-migrate         brainless-e2e-nginx
brainless-e2e-v11-api         brainless-e2e-v11-web
brainless-e2e-v11-migrate     brainless-e2e-v11-nginx
brainless-e2e-t13-api         brainless-e2e-t13-web
brainless-e2e-t13-worker      brainless-e2e-t13-outbox
brainless-e2e-t13-migrate     brainless-e2e-t13-nginx
brainless-t13-test            brainless-t14-test
brainless-api-upload-verification
brainless-api-storage-verification
```

Old test volumes may be removed manually only if their fixtures are no longer
needed and inspection confirms they are unused. For example, discard the default
old test fixture set (not development data) with:

```sh
docker volume rm brainless-e2e_postgres_data brainless-e2e_storage_data brainless-e2e_rabbitmq_data
```

No cleanup commands above were executed. New `qyvra-e2e_*_data` test volumes also
remain after the E2E runner stops its isolated stack.

## Verification (2 October 2026)

- Base Compose configuration with the private `.env`, fresh `.env.example`, and
  base + development override all passed `docker compose ... config --quiet`.
  The E2E runner also validated its isolated base + E2E override.
- `docker compose build` passed for all six project images. API build includes
  worker/outbox entry points; the E2E web image also rebuilt successfully.
- `docker compose -p brainless stop` followed by
  `docker compose up -d --wait --wait-timeout 240` passed. Seven QYVRA services
  are healthy; outbox runs and migrations exited 0.
- `node --test infrastructure/docker/database-command.test.cjs`: six tests
  passed, including fresh naming, external legacy-volume mapping, worker mount,
  broker hostname and isolated E2E namespace assertions.
- PostgreSQL query counts remained `1|1|1|1|13` for users/documents/versions/jobs/
  migration-history rows. The one existing uploaded file retained the same relative
  storage key and SHA-256. No database reset, volume copy or schema migration change.
- RabbitMQ retained `rabbit@e055a4cd4809`, the two existing queues and zero queued
  messages; the primary queue has one active worker consumer. Redis returned `PONG`.
- `docker compose exec -T nginx nginx -t` passed; `/api/v1/health/ready` and
  `/login` at `http://localhost:8080` returned HTTP 200 with the QYVRA browser title.
- Web `run lint` and `run typecheck` passed. Infrastructure CJS syntax and targeted
  formatting checks passed. `git diff --check` passed.
- `npm --prefix apps/web run test:e2e -- phase-one.spec.ts phase-three.spec.ts`:
  three browser tests passed against the fresh isolated QYVRA E2E stack, including
  secure download, persistence after container recreation and worker integrity
  completion for initial/additional uploads. The runner removed only its own test
  containers/network and retained all test volumes.

The exact configuration commands were `docker compose config --quiet`,
`docker compose --env-file .env.example config --quiet`, and
`docker compose --env-file .env.example -f docker-compose.yml -f docker-compose.dev.yml config --quiet`.
Final case-insensitive repository audit found only legacy/migration compatibility,
historical documentation, unchanged application infrastructure identifiers and
generated artifacts. No safe Docker rename is left outstanding.
