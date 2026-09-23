# Shared PostgreSQL client

This package owns the Prisma schema, generated client, and future migrations.
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

The schema contains authentication tables, `categories`, `tags`, `documents` and
`document_tags`. Apply pending migrations
using `npm run migrate:deploy`. Migration `20260914010000_categories` adds owned
categories and a SQL expression unique index on `(user_id, lower(name))`. Prisma
does not represent that expression index; preserve the migration SQL and its CHECK
constraints during subsequent schema evolution. See `docs/database.md` at the root
for normalization, permanent deletion and future restrictive document relationships.
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
categories are restricted. Existing migrations and data are preserved. Public document
creation, storage and versions are not included. See `docs/database.md` for constraints.
Generation requires no database or credentials. Migration commands use an injected
`DATABASE_URL`; this package does not automatically load a root `.env`.
Create subsequent reviewed migrations here without rewriting applied migration
history. Do not use database reset or
schema push as part of application startup. All runtime timeouts are supplied by
the API's validated settings. The adapter owns its pool and closes it on
`PrismaClient.$disconnect()`.
