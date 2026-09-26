# 03 · Repository structure and code navigation

[Guide index](README.md) · [Extending the project](16-extending-brainless.md)

This is a monorepo containing four independently installed npm packages. There is no root `package.json`; [pnpm-workspace.yml](../../pnpm-workspace.yml) is empty. The API references the shared packages with relative `file:` dependencies.

```text
apps/
  api/
    src/
      common/                 HTTP policy, logs, request context, pagination
      configuration/          Validated environment and typed settings
      database/               Injectable Prisma client and lifecycle
      infrastructure/storage/ Local provider wiring and file inspection
      modules/
        auth/                 Credentials, sessions, profile, guards
        categories/           Owned category operations
        tags/                 Owned tag operations
        documents/            Metadata, lifecycle, upload, versions, download
        health/               Liveness and readiness
      main.ts                 Bootstrap
      configure-application.ts
      configure-swagger.ts
    test/                     HTTP and real PostgreSQL suites
  web/
    app/                      App Router pages and layouts
    features/                 Auth, account, organization, documents
    components/               ui, shared, layout, theme, auth visuals
    lib/api/                  Transport clients and response schemas
    hooks/                    Shared use-mobile hook
    tests/                    Vitest/Testing Library suites
    e2e/                      Chromium tests
packages/
  database/
    prisma/schema.prisma
    prisma/migrations/        Ten ordered SQL migrations
    prisma.config.ts
    src/index.ts              pg adapter and generated-client exports
  storage/
    src/                      Contract, key validation, local adapter
    test/                     Node test-runner suites
infrastructure/
  docker/                     API/web/Nginx images and database launcher
  nginx/                      Proxy template and upload-limit entrypoint
  e2e/                        Isolated Compose browser-test runner
docs/                         Guides, release snapshot, ADRs, historical evidence
docker-compose.yml            Complete local stack
docker-compose.dev.yml        Host PostgreSQL port override
.env.example                  API/Compose configuration template
```

## Placement conventions

| Area                 | Put here                                                                    | Keep elsewhere                                                                                                   |
| -------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| API controllers/DTOs | HTTP parsing, transport validation, Swagger, mapping service outcomes       | Database transactions and file inspection belong in services/repositories/infrastructure                         |
| API module services  | Domain operations, owned queries, lifecycle rules, transaction coordination | Generic HTTP policy belongs in `common`; provider SDK/filesystem details belong behind infrastructure boundaries |
| API `database`       | Nest injection and connection lifecycle                                     | Schema and migrations belong in `packages/database`                                                              |
| Shared storage       | Streaming storage contract, generated-key policy, adapter implementation    | HTTP cookies, multipart parsing, document business rules belong in API modules                                   |
| Web `app`            | Route composition, layouts, route parameters                                | Feature workflows belong in `features`; generic transport in `lib/api`                                           |
| Web `features`       | Forms, query keys, loading/error states, domain-specific components         | Reusable UI primitives belong in `components/ui`; no direct database access                                      |
| Web `lib/api`        | Credentials, CSRF, response schemas, domain HTTP functions                  | Rendering and form state belong in feature components                                                            |
| `docs`               | Human onboarding, contracts, operational instructions, evidence             | Agent-specific instructions stay in root/nested `AGENTS.md`                                                      |

Generated Prisma output under `packages/database/src/generated/prisma`, package `dist`, and web `.next` are build products. Change their source inputs, not generated files. Each package has its own manifest, lockfile, TypeScript and lint configuration.

## Where do I change...?

| Change                           | Start here; related work                                                                                                                                                                                                                                                                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add an API endpoint              | Existing domain controller under [API modules](../../apps/api/src/modules), its DTO and service; register a new controller in that module if needed, and update Swagger/tests                                                                                                                                                                      |
| Add a document field             | [schema.prisma](../../packages/database/prisma/schema.prisma), new migration, [documents.dto.ts](../../apps/api/src/modules/documents/documents.dto.ts), [DocumentsService](../../apps/api/src/modules/documents/documents.service.ts), [web documents client](../../apps/web/lib/api/documents.ts); see [full example](16-extending-brainless.md) |
| Modify authentication            | [auth module](../../apps/api/src/modules/auth/auth.module.ts), guards/session services, [AuthApi](../../apps/web/lib/api/client.ts), [auth provider](../../apps/web/features/auth/provider.tsx)                                                                                                                                                    |
| Change upload validation         | [upload-multipart.ts](../../apps/api/src/modules/documents/upload-multipart.ts), [UploadInspector](../../apps/api/src/infrastructure/storage/upload-inspector.ts), [environment.ts](../../apps/api/src/configuration/environment.ts), [upload-validation.ts](../../apps/web/features/documents/upload-validation.ts)                               |
| Change file persistence          | [storage contract](../../packages/storage/src/storage.ts), [local adapter](../../packages/storage/src/local-storage.ts), [StorageModule](../../apps/api/src/infrastructure/storage/storage.module.ts)                                                                                                                                              |
| Change version numbering/retries | [UploadRepository](../../apps/api/src/modules/documents/upload.repository.ts), [versions service](../../apps/api/src/modules/documents/versions.service.ts), SQL constraints, [versions client](../../apps/web/lib/api/versions.ts)                                                                                                                |
| Add a frontend page              | [app](../../apps/web/app), feature component, appropriate layout; protected routes also need the [useCurrentUser route allowlist](../../apps/web/features/auth/provider.tsx) reviewed                                                                                                                                                              |
| Add/reuse a shadcn component     | [components/ui](../../apps/web/components/ui), configured aliases/style in [components.json](../../apps/web/components.json); inspect existing Base UI usage first                                                                                                                                                                                 |
| Change API calls                 | [lib/api/client.ts](../../apps/web/lib/api/client.ts) for shared transport; domain clients beside it for requests and Zod response schemas                                                                                                                                                                                                         |
| Change query/cache behavior      | Feature components such as [documents-list.tsx](../../apps/web/features/documents/documents-list.tsx); shared QueryClient in [provider.tsx](../../apps/web/features/auth/provider.tsx)                                                                                                                                                             |
| Modify database models           | [packages/database/prisma/schema.prisma](../../packages/database/prisma/schema.prisma), preserving SQL-only invariants                                                                                                                                                                                                                             |
| Add a migration                  | New timestamped directory under [prisma/migrations](../../packages/database/prisma/migrations); never rewrite an applied migration                                                                                                                                                                                                                 |
| Change Nginx routing             | [default.conf.template](../../infrastructure/nginx/default.conf.template); rebuild Nginx image                                                                                                                                                                                                                                                     |
| Change environment configuration | [environment.ts](../../apps/api/src/configuration/environment.ts), [settings.ts](../../apps/api/src/configuration/settings.ts), [.env.example](../../.env.example), explicit [Compose mappings](../../docker-compose.yml), and [web example](../../apps/web/.env.example)                                                                          |
| Change themes                    | [globals.css](../../apps/web/app/globals.css), [theme-provider.tsx](../../apps/web/components/theme-provider.tsx), [theme-toggle.tsx](../../apps/web/components/theme-toggle.tsx)                                                                                                                                                                  |
| Change safe API errors/logging   | [http-envelope.ts](../../apps/api/src/common/http-envelope.ts), [structured-logger.ts](../../apps/api/src/common/structured-logger.ts), and [request-context.ts](../../apps/api/src/common/request-context.ts)                                                                                                                                     |

There are no `apps/*-worker` or `packages/contracts` implementations in this baseline. Do not add empty layers merely because the planned architecture mentions them.
