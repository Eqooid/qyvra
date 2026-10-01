# Shared PostgreSQL client

This package owns the Prisma schema, generated client, and migrations.
It uses Prisma 7's PostgreSQL driver adapter, generates CommonJS-compatible client
code, and exports `createPrismaClient` and `PrismaClient`. Node 24+ is required.
Generated files and build output are ignored; regenerate after every schema change.

From this directory:

```sh
npm ci
npm run generate
npm run build
npm run format
npm run format:check
npm run lint
npm run typecheck
```

The schema contains authentication tables, `categories`, `tags`, `documents`,
`document_tags`, `document_versions`, `document_uploads`, `processing_jobs` and
`processing_outbox`. Apply pending migrations
using `npm run migrate:deploy`. Migration `20260914010000_categories` adds owned
categories and a SQL expression unique index on `(user_id, lower(name))`. Prisma
does not represent that expression index; preserve the migration SQL and its CHECK
constraints during subsequent schema evolution. See `docs/database.md` at the root
for normalization, permanent category/tag deletion and restrictive document relationships.
The login metadata migration adds `users.last_login_at` and the session's
`authentication_method` without changing earlier migration history.
The session activity migration renames `last_used_at` to `last_seen_at`, preserving
existing values and the timestamp constraint. Apply it before running the updated API.
Refresh rotation adds `consumed_refresh_tokens` for hashed-token reuse detection.
Apply the pending migration before serving refresh or logout requests.
Tags migration `20260914030000_tags` adds only tags, owner and CHECK
constraints, and the Categories-style unique expression index on `(user_id, lower(name))`.
Document metadata migration `20260914050000_document_metadata` adds documents and
owner-composite DocumentTag joins. Tag deletion cascades only join rows; referenced
categories are restricted. Existing migrations and data are preserved. Later upload migrations add immutable document versions, upload receipts, completed
receipt checks and operation/target scope. Public upload and versions are implemented.
See [database constraints](../../docs/database.md) and [onboarding](../../docs/development/getting-started.md).
Generation requires no database or credentials. Migration commands use an injected
`DATABASE_URL`; this package does not automatically load a root `.env`.
Create subsequent reviewed migrations here without rewriting applied migration
history. Do not use database reset or
schema push as part of application startup. All runtime timeouts are supplied by
the API's validated settings. The adapter owns its pool and closes it on
`PrismaClient.$disconnect()`.

Migration `20260927010000_processing_persistence` adds version-scoped jobs and
outbox intents with owner-composite foreign keys, status/retry constraints, and a
SQL-only partial index permitting at most one active job per version/type.
Migration `20260927020000_processing_index_names` shortens two index names to
match Prisma without PostgreSQL identifier truncation.
`createStoredFileVerificationIntent(tx, input)` creates the first job and outbox
message in an existing Prisma transaction; the caller controls commit or rollback.
It is not called by uploads yet. RabbitMQ publishing and workers remain planned.
`ProcessingRepository` adds owned lookups, idempotent creation, conditional job
transitions and leases, bounded retry calculation, due/stale queries, and outbox
claim/publication-state operations. It does not run a scheduler or publisher.
Run `node --test test/processing-rules.test.cjs test/processing-repository.test.cjs`
for the T03 rules and real-PostgreSQL repository checks.
Run `node --test test/processing-migration.test.cjs` against an empty disposable
`TEST_MIGRATION_DATABASE_URL`, then `node --test test/processing-persistence.test.cjs`
with `TEST_DATABASE_URL` pointing at the migrated test database.
