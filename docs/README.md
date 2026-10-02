# QYVRA documentation

**Phase 1 / v1.0.0 is released; Phase 2 / v1.1.0 has a locally verified release tag.**
Start with [getting started](development/getting-started.md). These guides describe
the checked-in implementation; the [specification](specification.md) is a broader
product plan. See the [v1.1.0 snapshot](releases/v1.1.0.md) for release scope.

New to the codebase? Read the [developer documentation](developer/README.md)
for architecture, source navigation, authentication/document walkthroughs, the API
route map, configuration, testing, debugging and extension guidance. It records the
exact inspected commits and known differences between source descriptions and behavior.
The [v1.1.0 delta guide](developer/versions/v1.1.0.md) extends the preserved
v1.0.0 baseline with document metadata/discovery changes. The
[v1.2.0 developer guide](developer/versions/v1.2.0.md) adds the processing
walkthrough, source navigation, independent runtimes and lifecycle changes.
The [v1.2.0 Phase 3 processing foundation](phase-3-processing.md) has
implemented persistence, job rules, RabbitMQ transport, outbox dispatcher,
worker consumer, upload-triggered scheduling, stored-file integrity verification,
PostgreSQL-backed processing retry/recovery, the owned processing-status API,
optional disposable Redis progress, and the frontend processing view;
T13 full-stack verification is recorded in the
[verification matrix](phase-3-verification.md). The
[T14 acceptance review](phase-3-acceptance.md) records release readiness and
remaining limitations; v1.2.0 is not yet a tagged release.

## Architecture

- [Overview, backend, frontend and storage boundaries](architecture.md)
- [Database models, ownership and migration constraints](database.md)
- [Authentication/session flow](features/authentication.md)
- [Infrastructure, Nginx and persistence](compose.md)
- [API conventions and generated OpenAPI](api.md)
- [v1.2.0 processing persistence, outbox delivery, and worker boundary](phase-3-processing.md)
- [v1.2.0 Phase 3 end-to-end verification matrix (T13)](phase-3-verification.md)
- [v1.2.0 final acceptance, release readiness and upgrade/rollback guidance (T14)](phase-3-acceptance.md)

## Features

- [Authentication and account settings](features/authentication.md)
- [Documents, uploads, downloads and lifecycle](features/documents.md)
- [Categories and tags](features/organization.md)
- [Document versioning](features/document-versioning.md)

## Development

- [Getting started: Docker or host development](development/getting-started.md)
- [Testing and verification commands](development/testing.md)
- [Conventions and versioning](development/conventions.md)
- [Contributing](../CONTRIBUTING.md)
- [API package](../apps/api/README.md), [web package](../apps/web/README.md),
  [database package](../packages/database/README.md), [storage package](../packages/storage/README.md)

## Deployment

- [Docker namespace migration to QYVRA and preserved development data](docker-rename.md)
- [QYVRA rename, retained identifiers and repository follow-up](qyvra-rename.md)
- [Docker Compose, Nginx, migrations, backups and troubleshooting](compose.md)
- [Environment variables](deployment/environment-variables.md)

## Architecture Decisions

- [ADR convention and index](decisions/README.md)

## Releases

- [Changelog](../CHANGELOG.md)
- [v1.0.0: Phase 1 snapshot](releases/v1.0.0.md)
- [v1.1.0: Phase 2 snapshot](releases/v1.1.0.md)
- [Roadmap and deferred scope](roadmap.md)
- [Documentation audit and retained evidence](documentation-audit.md)

The existing flat architecture/database/Compose guides remain canonical to preserve
links. Closely related topics are consolidated instead of repeated across directories.
