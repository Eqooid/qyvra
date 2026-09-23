# Storage foundation implementation — 14 September 2026

Only the provider-neutral file-storage layer and local filesystem adapter were
implemented. Existing authentication, profile, Categories, Tags and document
metadata behavior are preserved. There was no shared storage package or API Docker
image at inspection; the independent npm package layout remains unchanged.

## Contract and decisions

`packages/storage` exports `Storage`, a single `STORAGE` runtime token,
`LocalFileStorage`, neutral errors, metadata and trusted key utilities. Operations:
save a binary readable stream, open a readable stream, exists, metadata and delete.
Metadata contains only key, byte size and last-modified time. It is an internal
contract; use cases must authorize ownership and omit keys from public responses.

Writes stream to an exclusive temporary file, then atomically publish with a hard
link and remove the temporary name. This intentionally replaces a rename approach:
portable rename would overwrite an existing object. Replacement is not supported;
concurrent creates produce one winner and ALREADY_EXISTS. All handled failures and
stream interruptions clean up temporary files. Delete is idempotent (true removed,
false absent); missing reads return NOT_FOUND. Raw filesystem/source errors and
configured roots never appear in returned messages or metadata.

Keys are lowercase, bounded ASCII path segments. Absolute/drive paths, traversal,
empty segments, backslashes, null/control bytes, encoded paths, Windows device
names/alternate streams and trailing dots/spaces are rejected. The trusted UUID
generator produces `documents/{userId}/{documentId}/{versionId}/original.{extension}`.
User filenames never supply paths. Ancestors and files reject symlinks/junctions;
reads use O_NOFOLLOW where available and compare file identity after opening.

`StorageModule` selects local storage using typed, frozen configuration. The provider
defaults to local; unsupported providers fail startup. `LOCAL_STORAGE_ROOT` is now
required and must be an absolute private directory outside, and not containing,
the repository. Construction performs no disk IO; no current HTTP route uses storage.
Existing tests received a shared configuration fixture so they never use real
developer upload roots. No business/authentication code was rewritten.

## Files and packages changed

- New `packages/storage`: package.json/lockfile, tsconfig.json, ESLint/Prettier
  configuration, .gitignore, README, `src/storage.ts`, `src/storage-key.ts`,
  `src/local-storage.ts`, `src/index.ts`, `test/keys.test.cjs`, `test/local.test.cjs`.
- API package.json/lockfile: local package dependency and shared build hooks.
- API `src/app.module.ts`, `src/configuration/{settings,environment,configuration.module}.ts`.
- New API `src/infrastructure/storage/{storage.module,storage.module.spec}.ts`.
- API configuration specs and new `test/configuration.fixture.ts`.
- Existing API HTTP/integration specs that construct settings now import that
  fixture (app, auth-schema, categories, database, documents, health, login,
  observability, profile, registration, security, session, session-lifecycle,
  session-management and tags). Auth login/registration/session-lifecycle unit
  specs use the same configuration helper. Their business assertions are preserved.
- New `infrastructure/docker/api.Dockerfile`, root `.dockerignore`.
- `docker-compose.yml`, `.env.example`, root/API READMEs.
- `docs/architecture.md`, `docs/database.md`, `docs/specification.md`,
  `docs/roadmap.md` and this report.

No database models, migrations, frontend files, populated .env files or existing
PostgreSQL volume names were changed. Generated/compiled outputs are rebuilt.

## Verification commands and results

Commands used npm.cmd on Windows. Each directory retains its own npm lockfile.

| Directory               | Command/check                                                                                  | Result                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| packages/storage        | `npm run format`, `npm run lint`, `npm run typecheck`, `npm run build`                         | Passed                                                      |
| packages/storage        | `npm test`                                                                                     | 3 unit tests passed                                         |
| packages/storage        | `npm run test:integration`                                                                     | Windows: 11 passed, 1 file-symlink privilege skip           |
| Linux Node 24, UID 1000 | `node --test test/keys.test.cjs test/local.test.cjs`                                           | All 15 passed, no skips; also passed inside built API image |
| apps/api                | `npm run format`, `npm run lint`, `npm run typecheck`                                          | Passed                                                      |
| apps/api                | `npm test -- --runInBand`                                                                      | 178 tests in 16 suites passed                               |
| apps/api                | `npm run test:e2e -- --runInBand`                                                              | 232 tests in 12 suites passed                               |
| apps/api                | `npm run test:integration` with isolated TEST_DATABASE_URL                                     | 76 tests in 11 suites passed                                |
| apps/api                | `npm run build`                                                                                | Passed, including shared storage/database builds            |
| root                    | `docker build -f infrastructure/docker/api.Dockerfile -t brainless-api-storage-verification .` | Passed after adding required OpenSSL runtime support        |
| root                    | `docker compose --profile api config --quiet`                                                  | Passed                                                      |
| Container smoke         | API readiness + private tmpfs streamed save/delete                                             | HTTP 200 and passed                                         |

The final configuration/DI cleanup checks were rerun (82 targeted unit tests passed).
Formatting also covered changed manifests and documentation. Linux symlink tests
resolve the Windows account's file-symlink limitation; Windows junction tests pass.
Docker was initially stopped and started for verification. A transient first image
build failed; retry and the final OpenSSL-equipped build passed.

Storage coverage includes nested directories, streamed read/write, safe metadata,
existence/deletion/missing objects, concurrent no-overwrite publication, early and
late stream failures, interrupted-write cleanup, 32 MiB streaming/backpressure,
path escape/malformed keys, symlinks/junctions and error sanitization. Configuration
and NestJS provider tests cover required roots, supported environments, invalid
provider selection and actual isolated streaming through the shared token.

The seven existing migrations were applied only to an isolated PostgreSQL 17
tmpfs container for regressions. Storage tests used mkdtemp directories; container
smoke storage used tmpfs. No tests wrote to persistent upload/database volumes.

## Docker and setup

Compose's `api` profile mounts new `storage_data` at `/data/brainless` only in the
API. PostgreSQL still uses `postgres_data:/var/lib/postgresql/data`, its original
service settings and Compose project name. No web mount, static serving or Nginx
route was added. The API image runs as node (UID 1000) and initializes its storage
directory ownership accordingly. It is a local development image, not a complete
production deployment. See [storage setup](../packages/storage/README.md).

Install/build `packages/storage` before installing `apps/api`. For host development,
add `LOCAL_STORAGE_ROOT` to root `.env` pointing to a dedicated external directory.
Keep your current DATABASE_URL. For the optional container profile provide
API_DATABASE_URL using PostgreSQL host `postgres`, port 5432, and existing credentials;
Compose supplies the container storage root. Apply existing migrations before
startup. There are no new migrations. Do not change the Compose project or delete
volumes when updating code.

## Limitations and next task

Root and ancestors must be writable only by trusted local processes; portable
Node APIs do not provide race-proof openat-style directory capabilities against
a privileged attacker replacing directories concurrently. POSIX permissions and
Windows ACLs must protect the mounted directory. Filesystems must support hard links.
Force-kill/power-loss can leave private, inaccessible `.pending-*` files; inspect
them with writers stopped rather than deleting potentially active work. Atomic
visibility is not a guarantee of power-loss durability or PostgreSQL atomicity.

There are no HTTP upload/download endpoints, file validation, checksums, version
records, public creation, S3 adapter or automatic stale-file scavenger. Storage
availability is checked on use, not as a dependency of current metadata readiness.
Future cloud adapters replace the provider binding and implement the same stream
and error contract without modifying use cases.

Next: **validated streaming document upload with the first immutable document
version**. This task did not begin that work. Phase 1 remains incomplete.
