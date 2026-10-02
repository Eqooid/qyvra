# QYVRA API

NestJS REST API for **v1.0.0 / completed Phase 1**. Implemented business modules are
Auth, Categories, Tags and Documents, with Health, Configuration, Observability,
Database and Storage infrastructure. Node.js 24+ is required.

- [Host onboarding and migrations](../../docs/development/getting-started.md)
- [Architecture](../../docs/architecture.md#backend) and [database invariants](../../docs/database.md)
- [Feature workflows](../../docs/README.md#features)
- [API conventions and Swagger/OpenAPI](../../docs/api.md)
- [Complete environment reference](../../docs/deployment/environment-variables.md)
- [Testing and build commands](../../docs/development/testing.md)
- [Compose operations](../../docs/compose.md) and [release evidence](../../docs/releases/v1.0.0.md)

After root onboarding, from this directory:

```sh
npm run start:dev
npm run format:check
npm run lint
npm run typecheck
npm test -- --runInBand
npm run test:e2e -- --runInBand
npm run build
```

`test:integration` additionally needs an isolated migrated `TEST_DATABASE_URL` and
qpdf for upload inspection. The HTTP e2e suite uses a database double. Shared package
builds run through lifecycle hooks; install their independent dependencies first.

`start:prod` runs compiled output; it does not set NODE_ENV. The API reads root `.env`,
while Prisma CLI requires injected DATABASE_URL. Always apply migrations before
startup: readiness tests connectivity, not schema history. Do not reset a database
or use volume deletion to apply changes.

Agent-specific rules are in [AGENTS.md](AGENTS.md); human guidance starts at the
[documentation index](../../docs/README.md).
