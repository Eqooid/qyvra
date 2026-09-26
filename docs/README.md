# Brainless documentation

**v1.0.0 / Phase 1 is complete.** Start with [getting started](development/getting-started.md).
These guides describe the checked-in implementation; the [specification](specification.md)
is a broader product plan. Later functionality is **Planned**, not shipped.

New to the codebase? Read the [complete v1.0.0 developer guide](developer/README.md)
for architecture, source navigation, authentication/document walkthroughs, the API
route map, configuration, testing, debugging and extension guidance. It records the
exact inspected commit and known differences between source descriptions and behavior.

## Architecture

- [Overview, backend, frontend and storage boundaries](architecture.md)
- [Database models, ownership and migration constraints](database.md)
- [Authentication/session flow](features/authentication.md)
- [Infrastructure, Nginx and persistence](compose.md)
- [API conventions and generated OpenAPI](api.md)

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

- [Docker Compose, Nginx, migrations, backups and troubleshooting](compose.md)
- [Environment variables](deployment/environment-variables.md)

## Architecture Decisions

- [ADR convention and index](decisions/README.md)

## Releases

- [Changelog](../CHANGELOG.md)
- [v1.0.0: Phase 1 snapshot](releases/v1.0.0.md)
- [Roadmap and deferred scope](roadmap.md)
- [Documentation audit and retained evidence](documentation-audit.md)

The existing flat architecture/database/Compose guides remain canonical to preserve
links. Closely related topics are consolidated instead of repeated across directories.
