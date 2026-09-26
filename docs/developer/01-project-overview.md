# 01 · Project overview

[Guide index](README.md) · [Next: Architecture](02-architecture.md)

Brainless stores private personal documents and the metadata used to find and organize them. A logical document has a title and optional category, tags, issuer, reference number, and dates. Its uploaded originals are immutable versions. Developers should distinguish metadata changes from adding new file bytes: editing a title does not create a file version.

## What v1.0.0 does

- Register and log in with local credentials; edit profile and password; log out or revoke sessions.
- Create, rename, and delete owned categories/tags.
- Upload PDF, JPEG, and PNG files with bounded streaming validation and duplicate protection.
- Browse/filter documents, search title/issuer/reference substrings, and edit metadata.
- Archive, restore, and soft-delete documents; download the latest original.
- Append immutable file versions and inspect their paginated metadata history.
- Run the complete application locally through Docker Compose and Nginx, or run source watchers against PostgreSQL.

Uploads return document status `UPLOADED` and extraction status `PENDING`. Nothing consumes that pending status in this release. There is no historical-version download, permanent purge, Trash UI, email reset/verification, external login, OCR, processing queue, AI, chat, or reminder delivery. The [specification](../specification.md) describes a broader planned product; [the release snapshot](../releases/v1.0.0.md) defines shipped scope.

## Runtime responsibilities

| Boundary             | Responsibility in Brainless                                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser / Next.js    | Render routes, collect input, validate for usability, manage query state, and call the API with cookies.                                       |
| NestJS               | Authenticate each private request, enforce ownership and lifecycle rules, validate files/input, coordinate SQL and storage, return safe views. |
| PostgreSQL           | Authoritative accounts, session hashes, metadata, associations, version records, and upload receipts. Enforce relational integrity.            |
| Private file storage | Store original bytes under generated keys. It is accessed by the API, never exposed as a public directory.                                     |
| Nginx                | Provide one local browser origin; route `/api/` to NestJS and other requests to Next.js; stream uploads/downloads.                             |
| Docker Compose       | Build and connect services, persist database/files in volumes, run migrations, and order startup using health checks.                          |

See [AppModule](../../apps/api/src/app.module.ts), [web routes](../../apps/web/app), and [Compose](../../docker-compose.yml).

## Technology map

Versions below are declared dependency/image majors, not a claim that the minimum versions are installed. Four `package-lock.json` files pin JavaScript dependencies.

| Technology                                                           | Use and configuration                                                                                  | Where developers encounter it                                                                                                           |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js 24+, TypeScript                                              | Runtime and typed application/shared packages; package engines, `tsconfig.json`, Node 24 Docker images | All four packages; API emits CommonJS, web uses ESM package configuration                                                               |
| NestJS 10 / Express 4                                                | Dependency injection, controllers, guards, request/response transport                                  | [API bootstrap](../../apps/api/src/main.ts), [application configuration](../../apps/api/src/configure-application.ts), modules          |
| class-validator / class-transformer                                  | Strict DTO allowlists, type transformation, field validation                                           | API `*.dto.ts` and global `ValidationPipe`                                                                                              |
| Nest Swagger 7                                                       | Generate endpoint schemas and interactive reference from code                                          | [configure-swagger.ts](../../apps/api/src/configure-swagger.ts), controller decorators                                                  |
| Prisma 7 / pg / PostgreSQL 17                                        | Typed persistence through the PostgreSQL driver adapter, migrations, transactions and SQL constraints  | [schema](../../packages/database/prisma/schema.prisma), [client factory](../../packages/database/src/index.ts), `PrismaService`         |
| Argon2                                                               | Argon2id password hashing and verification                                                             | [PasswordService](../../apps/api/src/modules/auth/password.service.ts); no JWT signing library is needed                                |
| Busboy                                                               | Bounded multipart parsing and streamed file input                                                      | [upload-multipart.ts](../../apps/api/src/modules/documents/upload-multipart.ts)                                                         |
| qpdf / Sharp                                                         | PDF structural/encryption/page checks and image metadata/resource checks                               | [UploadInspector](../../apps/api/src/infrastructure/storage/upload-inspector.ts), API Dockerfile; host qpdf installation                |
| Helmet / RxJS                                                        | HTTP security headers and Nest response-interceptor mapping                                            | [configure-application.ts](../../apps/api/src/configure-application.ts), [http-envelope.ts](../../apps/api/src/common/http-envelope.ts) |
| Next.js 16 / React 19                                                | App Router pages and interactive feature components; standalone server build                           | [next.config.ts](../../apps/web/next.config.ts), `app`, `features`                                                                      |
| TanStack Query 5 / Table 9                                           | In-memory server state and document table rendering                                                    | [auth provider](../../apps/web/features/auth/provider.tsx), [document table](../../apps/web/features/documents/documents-table.tsx)     |
| React Hook Form / Zod 4                                              | Form validation and runtime checking of API responses                                                  | Feature validation files, [HTTP client](../../apps/web/lib/api/client.ts)                                                               |
| Tailwind 4 / shadcn / Base UI                                        | Utility styling, theme tokens, accessible reusable primitives                                          | [components.json](../../apps/web/components.json), [globals.css](../../apps/web/app/globals.css), `components/ui`                       |
| next-themes / Lucide / date-fns / react-day-picker                   | Light/dark/system themes, icons, date controls and formatting                                          | [theme provider](../../apps/web/components/theme-provider.tsx), shared date picker, feature components                                  |
| Nginx 1.28 / Compose v2                                              | Reverse proxy and local multi-service deployment                                                       | [infrastructure](../../infrastructure), root Compose files                                                                              |
| Jest / Supertest / Vitest / Testing Library / Playwright / node:test | API, browser-component, real-browser and shared-package verification                                   | [Testing](13-testing.md) maps each suite to its actual boundary                                                                         |

There is no active root npm workspace or build orchestrator. Install the four packages separately as described in [development workflow](14-development-workflow.md).
