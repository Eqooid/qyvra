# Documentation audit - 24 September 2026

[Documentation index](README.md) | [Release snapshot](releases/v1.0.0.md)

## Scope and findings

Inspected root/application AGENTS and READMEs, all existing docs, four package
manifests/lockfiles, environment examples, Compose/Dockerfiles/Nginx, NestJS
configuration/modules/controllers/services, Next.js routes/clients/features, Prisma
schema and migration constraints, storage/authentication code and test configurations.
The repository has no checked-in CI/CD workflow and no root package.json.

| Existing material                      | Problem found                                                                                                                                                       | Resolution                                                                                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Root README                            | Planned workspace and processing/search/discussion language confused shipped scope; commands and release navigation were incomplete.                                | Current entry point, real directory tree and links to focused guides.                                                                                  |
| architecture.md / database.md / api.md | Implemented sections mixed with repeated target architecture/entity/endpoint catalogs from specification.md. Stale optional-Compose wording and broken image paths. | Current architecture/database guides; API conventions point to generated Swagger. Planned material remains in specification, whose images now resolve. |
| roadmap.md                             | Completed checklist followed by contradictory current-status paragraphs saying Phase 1/UI/deployment were missing.                                                  | Current release scope and explicitly Planned future phases; historical counts stay in original reports.                                                |
| API/database/storage READMEs           | Stale claims about missing document joins, uploads, versions and Docker verification; API environment table incomplete.                                             | Corrected current package boundaries; centralized setup/configuration and retained database/storage rationale.                                         |
| Web README                             | Useful flow detail mixed with old test counts and pending Docker smoke status.                                                                                      | Retained detail, marked historical checkpoints and linked current evidence/setup.                                                                      |
| Dated implementation reports           | Useful tests/limitations, but task-local pending work read as current status.                                                                                       | Preserved with historical notices and current-release links.                                                                                           |
| Agent instructions                     | Future directories/services could be mistaken for implemented components.                                                                                           | Small scope labels and guide/OpenAPI links; engineering/security rules retained.                                                                       |
| Root/release navigation                | No docs index, contribution guide, changelog, version policy, ADR convention or release snapshot.                                                                   | Added linked guides; combined categories/tags and kept existing flat canonical guides to avoid duplication.                                            |

The existing .env.example is comprehensive for implemented API settings. It remains
unchanged, as do Compose/Nginx and all application/configuration/schema files. Four
pre-existing untracked root support files (.dockerignore, .env.example, .gitattributes,
.gitignore) were preserved.

## Sources that should be generated or reused

- Swagger already generates `/api/v1/docs-json` from controllers/DTOs and serves a UI.
  Use it for endpoint detail. Standalone export/client generation is not implemented.
- Prisma schema and migration SQL own entities/constraints; migrations contain
  expression indexes, checks and immutability triggers absent from a simple generated ERD.
- Package scripts/lockfiles own commands and dependency versions. Dockerfiles own
  runtime image majors; this audit does not claim registry-latest versions.
- Typed configuration plus environment examples/Compose mappings own defaults.
  A future generated environment-reference check could detect drift.
- Test runners produce results; release docs cite dated checked-in evidence rather
  than treating historical counts as a new run.

## Retained historical evidence

These reports remain at their original paths. Pending scope and test counts are
local to each checkpoint; use the release snapshot for current scope.

- [Categories](categories-implementation.md), [tags](tags-implementation.md),
  [metadata](document-metadata-implementation.md)
- [Storage](storage-implementation.md), [upload](upload-implementation.md),
  [download](download-implementation.md), [versioning](versioning-implementation.md)
- [Document list](documents-list-implementation.md), [upload UI](web-upload-implementation.md),
  [detail UI](web-detail-implementation.md), [organization UI](web-organization-implementation.md),
  [version UI](web-versioning-implementation.md)
- [Branding compatibility](branding-rename.md), [UI standardization](../apps/web/UI-STANDARDIZATION.md)
- [Acceptance review](phase-1-review.md), [final browser verification](phase-1-browser-verification.md)

## Gaps and follow-up

- Release v1.0.0 and its date are the supplied project baseline. No local Git tags
  were listed during this audit; remote release/tag publication was not verified or changed.
  Private package versions remain 0.0.1; no release automation is checked in.
- Historical reasons for ORM/vendor selections are not established. Only the explicit
  create-only storage publication rationale is promoted to an ADR.
- Production TLS, edge rate limiting, CI/CD and automated recovery/backup verification
  have no completed implementation to document as shipped.
- Future v1.1.0 work should update the owning architecture/features/environment guide,
  Swagger and migration invariants as code lands. Add ADRs for new worker/message/
  retry boundaries if selected, and a release snapshot with fresh verification.
- A lightweight Markdown link/anchor check and generated OpenAPI/environment drift
  checks are recommendations, not newly implemented CI features.

This audit does not start Phase 2. See [conventions](development/conventions.md) for
ongoing documentation ownership and [testing](development/testing.md) for verification scope.

## Audit verification performed

- Checked 297 relative Markdown/image links and heading anchors across 45 Markdown
  files; no broken targets. Inline repository paths in current guides also resolved.
- Validated 99 explicit npm-prefix command references against actual package manifests.
  Reviewed unprefixed commands in their stated working directories and Docker commands
  against the existing Compose files/runbook; no application workflows were executed.
- Confirmed all validated API environment setting names appear in the reference,
  reviewed defaults/Compose mappings, and confirmed ten SQL migration directories.
- Prettier passed for the 20 new or substantially rewritten guides. Existing historical
  bodies and minimally changed agent/package guides were preserved rather than reformatted.
- Git diff whitespace checks passed. An added-text scan found no private keys, service
  keys, credential-bearing database URLs or literal credential assignments; examples
  were also reviewed for placeholder-only credentials.
- File hashes against the pre-edit manifest confirmed no non-Markdown repository/support
  file changed. The pre-existing untracked root support files remain unchanged.
- No dependency installation, application build/test, migration, Docker runtime,
  database/volume operation, Git tag or release publication was performed. Runtime
  evidence is reused and explicitly attributed in the release snapshot.
