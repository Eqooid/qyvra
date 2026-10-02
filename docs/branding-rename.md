# Brainless branding rename

> This earlier checkpoint is preserved as historical evidence. The current product
> is **QYVRA**; see [the QYVRA rename](qyvra-rename.md) for current identifiers.

> Historical branding checkpoint (13 September 2026). Infrastructure and verification
> gaps below describe that time. For current status and retained compatibility names,
> see the [v1.0.0 snapshot](releases/v1.0.0.md).

The product name is **Brainless**, the slug is `brainless`, and npm packages use
`@brainless/*`. Document-domain names, routes, roadmap phases and implementation
scope are unchanged. See the [root README](../README.md) for the product description and the
[release snapshot](releases/v1.0.0.md#deployment-and-upgrade-notes) for compatibility.

## Source files changed

```text
.env.example
AGENTS.md
README.md
docker-compose.yml
docs/api.md
docs/architecture.md
docs/database.md
docs/roadmap.md
docs/specification.md
docs/branding-rename.md
packages/database/package.json
packages/database/package-lock.json
apps/api/AGENTS.md
apps/api/README.md
apps/api/package.json
apps/api/package-lock.json
apps/api/src/app.controller.spec.ts
apps/api/src/configuration/environment.ts
apps/api/src/configuration/environment.spec.ts
apps/api/src/configure-swagger.ts
apps/api/src/database/database.module.ts
apps/api/src/database/prisma.service.ts
apps/api/src/modules/auth/registration.repository.ts
apps/api/test/app.e2e-spec.ts
apps/api/test/auth-schema.integration-spec.ts
apps/api/test/database.integration-spec.ts
apps/api/test/security.e2e-spec.ts
apps/web/AGENTS.md
apps/web/README.md
apps/web/package.json
apps/web/package-lock.json
apps/web/app/layout.tsx
apps/web/app/(auth)/layout.tsx
apps/web/app/(auth)/login/page.tsx
apps/web/app/(auth)/register/page.tsx
apps/web/app/dashboard/layout.tsx
apps/web/components/layout/dashboard-shell.tsx
apps/web/features/auth/auth-form.tsx
```

There is no root package manifest, active workspace, Nginx configuration, or
branded monitoring/logging service identifier to rename. Existing independent npm
packages and file-based database dependency are preserved. Generated Prisma and
production build artifacts were regenerated.

## Remaining old-name references

The final case-insensitive source search for the spaced, compact, hyphenated and
underscored old name found only intentional compatibility references:

- Existing cookie defaults, associated tests, and configuration documentation.
- The browser authentication BroadcastChannel and Web Lock shared with older tabs.
- The compatibility explanation in the root README.
- Private root `.env` database initialization/connection settings, left untouched.

Dependency installations, generated artifacts, Git history and build caches are
excluded from the source inventory. Generic references to a document tracker or
the usable-tracker roadmap phase describe the document domain, not a product name.

No database migration is needed. Existing identities (issuer `local`), sessions,
tables, database names, cookies and persistent volumes are unchanged. Do not change
the Compose project name or database connection settings as part of this rename.

## Verification (13 September 2026)

Commands were run with `npm.cmd` on Windows from the indicated directory.

| Directory | Command | Result |
| --- | --- | --- |
| `packages/database` | `npm run validate`, `npm run format`, `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm run build` | Passed; build includes Prisma generation |
| `apps/api` | `npm install --ignore-scripts --offline --no-audit --no-fund` | Passed; renamed local dependency linked |
| `apps/api` | `npm ls @brainless/database --depth=0` | Resolves to `packages/database` |
| `apps/api` | `npm run format`, `npm run format:check`, `npm run lint`, `npm run typecheck` | Passed |
| `apps/api` | `npm test -- --runInBand` | 140 tests passed |
| `apps/api` | `npm run test:e2e -- --runInBand` | 79 tests passed, including the Brainless OpenAPI title assertion |
| `apps/api` | `npm run build` | Production build passed, including shared Prisma client generation/build |
| `apps/api` | `npm run test:integration` | Failed: isolated `TEST_DATABASE_URL` missing; 42 failed, 1 passed |
| `apps/web` | `npm run format`, `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` | Passed; 24 tests |
| Root | `docker compose --env-file .env.example config --quiet` | Passed with safe temporary PostgreSQL initialization/port values; Docker config access warning |

Docker's Linux engine was unavailable, so an isolated PostgreSQL test container
could not be provisioned. Start Docker, provision a separate test database, deploy
the existing migrations there, inject `TEST_DATABASE_URL`, and rerun integration
tests using the API README instructions. No existing database was used for tests.
Verification is not fully green until that integration run passes.
