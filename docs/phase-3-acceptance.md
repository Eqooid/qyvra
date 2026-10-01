# v1.2.0 Phase 3 final acceptance (T14)

[Documentation index](README.md) | [Processing contract](phase-3-processing.md) |
[T13 verification](phase-3-verification.md) | [Roadmap](roadmap.md)

Acceptance date: 1 October 2026. This record describes the reviewed working tree
on branch `v1.2.0`, not a published release or a newly created tag.
**Decision: v1.2.0 Release Ready.** No unresolved blocker was found for the
approved PostgreSQL-only processing foundation. The nonzero dependency audit
and unexecuted deployment drills remain explicitly recorded below.

## Continuation and evidence provenance

The interrupted T14 run completed the architecture, persistence, transport,
worker, integrity, recovery, progress, API, frontend, ownership, migration,
configuration and documentation review. It fixed portable API lint formatting
and document lifecycle cancellation/restoration. The focused lifecycle test and
all 18 document PostgreSQL integration tests passed before dependency remediation.
The web production build and type check also passed.

The continuation preserved those changes and T13 evidence. It resumed the
unfinished dependency-resolution step, patched compatible API transitive
dependencies, and repeated only checks affected by that lockfile change. Web
builds/tests, database migration tests and the infrastructure outage suite were
not repeated: their source, schema and configuration were unchanged. The final
smoke run uses rebuilt API/outbox/worker images and the retained isolated database,
broker and file volumes. No volume reset or historical-version backfill occurred.

## Phase 3 acceptance matrix

| Task | Result | Accepted capability and evidence                                                                                          |
| ---- | ------ | ------------------------------------------------------------------------------------------------------------------------- |
| T01  | Pass   | Canonical processing contract and ADR-002 distinguish implemented foundation from future work.                            |
| T02  | Pass   | Additive job/outbox persistence; T13 real PostgreSQL constraints, atomic rollback and upgrade tests.                      |
| T03  | Pass   | Conditional claims/outcomes, generation idempotency, leases and bounded job retry; repository tests.                      |
| T04  | Pass   | Durable RabbitMQ topology, versioned identifiers and confirmed transport; broker integration and T13.                     |
| T05  | Pass   | PostgreSQL-coordinated outbox dispatch, capped publication backoff and stable message identity; integration/outage tests. |
| T06  | Pass   | Independent worker, validation, acknowledgement/dead-letter handling and concurrency; worker integration and T13.         |
| T07  | Pass   | Initial/new-version upload schedules version/job/outbox/receipt in one transaction; rollback and replay tests.            |
| T08  | Pass   | Streaming size/SHA-256 verification with no production no-op handler; valid/corrupt/missing-file tests.                   |
| T09  | Pass   | PostgreSQL retry scheduling and expired-lease recovery; transient/exhausted/restart tests.                                |
| T10  | Pass   | Owned read-only version status, safe failure mapping and no infrastructure leakage; HTTP/security tests.                  |
| T11  | Pass   | Attempt-scoped expiring Redis progress; outage/flush does not affect durable jobs.                                        |
| T12  | Pass   | Current/per-version status, bounded polling and optional progress; web tests and Nginx browser journey.                   |
| T13  | Pass   | Recorded end-to-end and reliability evidence, including individually passed outage scenarios.                             |
| T14  | Pass   | Acceptance fixes, affected verification, final real-stack smoke and documentation finalization completed.                 |

## Release-readiness matrix

Results use only **Pass**, **Fail**, **Not Executed**, or **Not Applicable**.
An audit finding is reported separately from whether the affected path is exposed.

| Area                                    | Result         | Evidence / qualification                                                                                                              |
| --------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Builds                                  | Pass           | Final API build/typecheck and shared runtime images pass; unchanged previous web build/typecheck retained.                            |
| Migrations                              | Pass           | T13 fresh 13-migration database and v1.1 upgrade passed; SQL reviewed in T14, no later migration changes.                             |
| Persistence                             | Pass           | T13 job/outbox transaction, relationship, constraint and conditional-claim tests.                                                     |
| Outbox                                  | Pass           | T13 confirmed publication, broker outage, lease recovery and stable duplicate identity.                                               |
| RabbitMQ                                | Pass           | T13 real routing, confirms, malformed-message dead-lettering and redelivery.                                                          |
| Worker                                  | Pass           | Independent runtime, bounded prefetch, durable claims and duplicate/two-worker tests.                                                 |
| Integrity verification                  | Pass           | T13 valid, corrupt, missing and near-limit files; size/SHA-256 streaming review.                                                      |
| Retry/recovery                          | Pass           | Transient and exhausted storage failures, expired lease, stack restart; PostgreSQL is authoritative.                                  |
| Redis                                   | Pass           | T13 optional-progress integration, outage and isolated flush; API still returns durable state.                                        |
| Processing-status API                   | Pass           | Final document/status PostgreSQL regressions: 24 passed, 1 optional Redis case skipped; T13 Redis evidence retained.                  |
| Frontend                                | Pass           | T13 web 201 tests and browser journey; unchanged web production build/typecheck retained.                                             |
| Security boundaries                     | Pass           | Authentication, ownership/IDOR, secure storage and sanitized status checked; no new public mutation API.                              |
| Dependency audit                        | Fail           | Nonzero findings remain; applicability and remediation are detailed below, not hidden as a clean audit.                               |
| Tenant isolation                        | Not Applicable | No tenant/workspace feature exists; user ownership is enforced.                                                                       |
| Docker                                  | Pass           | Rebuilt API/outbox/worker started successfully; remaining healthy services/volumes reused; Compose config valid.                      |
| Nginx                                   | Pass           | Final `nginx -t` and upload/new-version/completion/download browser smoke pass.                                                       |
| Regression                              | Pass           | Final API unit suite: 28 suites, 253 passed, 1 skipped; document/status integration and browser smoke pass.                           |
| Documentation                           | Pass           | Canonical navigation, terminology and planned/implemented labels checked; 158 internal links resolve; historical snapshots unchanged. |
| Backup restore / rollback drill         | Not Executed   | Procedure below is guidance; no production restore or downgrade was exercised.                                                        |
| Global ordering / exactly-once delivery | Not Applicable | Neither is promised by this architecture.                                                                                             |

## Architecture and guarantees

`Document Version → Processing Job + Transactional Outbox → Confirmed RabbitMQ
publication → Worker → Stored-file integrity verification → PostgreSQL outcome
→ optional Redis progress → Owned Processing API → Frontend`

Version/job/outbox/upload-receipt writes share a PostgreSQL transaction. File
storage is outside that transaction and uses upload compensation; it is not
claimed to participate in an atomic distributed transaction. Dispatcher claims
are coordinated by PostgreSQL. A broker acceptance followed by failed database
publication recording may publish the same logical message again. Workers use
lease-fenced repository operations, so duplicate messages cannot restart completed
jobs or spend another attempt merely because they were redelivered. This remains
at-least-once delivery, with possible repeated I/O around a crash.

Job attempts increment on a successful claim and stop at the persisted maximum.
Job retry/recovery and outbox publication retry are distinct. Publication backoff
is capped; the schema intentionally retains pending publication intent rather
than discarding it after an outage. Redis contains only temporary current-attempt
progress and can be flushed without losing durable work.

## Defects resolved in T14

1. API lint on a CRLF checkout reported thousands of line-ending violations.
   `.prettierrc` now accepts the checkout's native line endings, and one actual
   processing-message import formatting defect was corrected. No bulk source
   reformat was performed.
2. Archive/soft-delete handlers did not call the existing cancellation operation,
   leaving unfinished jobs stranded while worker/recovery eligibility excluded
   the document. They now cancel pending/queued/processing/retrying jobs and
   clear their leases inside the document transaction. Restore schedules a new
   generation/outbox for a cancelled current-version job only. Repeated unchanged
   actions, completed work and legacy versions without jobs are unaffected. A real
   PostgreSQL/HTTP regression covers pending cancellation, running cancellation,
   two restorations and generation/outbox counts. No migration was needed.
3. The production API audit exposed high-severity transitive advisories. Compatible
   overrides now select Lodash 4.18.1, Multer 2.4.0, js-yaml 4.3.2, qs 6.16.0 and
   body-parser 1.20.6. Invalid intermediate overrides were removed; the final
   package tree resolves successfully. NestJS/Prisma major versions were not changed.

## Security and remaining dependency findings

Authentication uses existing sessions and trusted internal user IDs. Version/status
queries enforce owned document/version relationships, return 401 when unauthenticated,
and indistinguishable 404 for foreign/missing/deleted resources. Archived status
reads remain authorized; soft-delete visibility is preserved. Queue payloads contain
identifiers, not file contents or credentials. Worker storage is private/read-only.
Public failure categories hide paths, raw diagnostics, broker/outbox/lease details.
No real credential was found in the reviewed source-controlled changes; private
test environment files were neither printed nor committed.

The final API `npm audit --omit=dev` reports **5 moderate, 0 high, 0 critical**,
and exits nonzero. Findings are NestJS meta-advisories and `file-type`.
The [NestJS SSE advisory](https://github.com/advisories/GHSA-36xv-jgw5-4q75)
requires user-influenced SSE event IDs/types; Brainless has no SSE route. Upload
validation uses its own streaming inspector, not NestJS `ParseFilePipe`/`file-type`.
These unused paths remain a dependency maintenance limitation, not proof of
an exposed v1.2.0 endpoint. Do not enable them without remediation.

The independent database lockfile audit reports **4 high and 1 moderate**:
Prisma/config meta-advisories, `deepmerge-ts`, `mysql2`, and `fast-uri`. The CLI
peer remains in that package tree even after production pruning. Application
database access uses the generated client and PostgreSQL adapter, not MySQL,
Prisma dev/Studio services or externally supplied Prisma configuration. The
configuration file is a trusted static `defineConfig` object. The
[deepmerge advisory](https://github.com/advisories/GHSA-ggr8-5vv4-36mx) requires
recursive object graphs (plain JSON alone is insufficient); the
[MySQL authentication](https://github.com/advisories/GHSA-3f6p-5ww8-9rcr) and
[compressed-protocol advisories](https://github.com/advisories/GHSA-rgwj-5xj2-c3m3)
concern a database protocol this deployment does not use. These findings are
explicitly retained as non-blocking for this PostgreSQL-only foundation, not
waived for future MySQL/dev-service use. A compatible upstream/toolchain update
and separate build/migration verification remain maintenance work. No broad
framework upgrade or `npm audit fix --force` was performed during acceptance.

## Verification ledger

### Reused T13 and previous T14 results

See [T13](phase-3-verification.md) for the retained scenario matrix and limits:
28 API suites / 253 passed / 1 skipped; 18 web files / 201 passed; worker
integration 5 passed; four delivery/status/scheduling integration suites 17 passed;
database persistence/repository 13 passed; migration-upgrade 1 passed; rules 2 passed.
All twelve reliability browser scenarios passed individually. The broader browser
run found a stale Phase 2 catalog selector; its corrected targeted rerun passed.
The full browser suite was not subsequently repeated.

Previous T14 commands retained: API `npm.cmd run lint`, `npm.cmd run typecheck`,
`npm.cmd run build`; web `npm.cmd run typecheck`, `npm.cmd run build`; targeted
API Jest document-service/message suites (5 tests); Docker test-stage build and
focused/full document PostgreSQL integration (1 and 18 tests). The API results
preceding the final lockfile change are historical, superseded by continuation
checks below where affected. Web results remain valid and were not rerun.

### Continuation commands and results

Commands use `apps/api` unless a different directory is shown; the isolated Compose prefix is
`docker compose -p brainless-e2e-t13 --env-file .tools/brainless-e2e.env
-f docker-compose.yml -f infrastructure/e2e/compose.yml`.

| Command/check                                                                                                                                 | Result                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `npm.cmd install --no-audit --ignore-scripts`                                                                                                 | Pass; required to finish the interrupted package/lockfile changes, not an unrelated reinstall.                                 |
| `npm.cmd ls js-yaml lodash multer qs body-parser --omit=dev`                                                                                  | Pass; final overrides resolve without the earlier invalid-tree error.                                                          |
| `npm.cmd audit --omit=dev --json` (API and database package, summarized)                                                                      | Fail; API 5 moderate, database 4 high/1 moderate. No clean-audit claim; applicability reviewed above.                          |
| `npm.cmd run lint`                                                                                                                            | Pass.                                                                                                                          |
| `npm.cmd run format:check`                                                                                                                    | Pass across API source/tests.                                                                                                  |
| `npm.cmd run typecheck`                                                                                                                       | Pass, including shared storage/database build.                                                                                 |
| `npm.cmd run build`                                                                                                                           | Pass; includes compiled HTTP, outbox and worker entry points.                                                                  |
| `npm.cmd run test -- --runInBand`                                                                                                             | Pass: 28 suites, 253 passed, 1 skipped. Optional real-Redis unit integration was not enabled; retained T13 evidence covers it. |
| Compose prefix + `up --build -d --no-deps --wait --wait-timeout 180 api outbox worker`                                                        | Pass; only images invalidated by API dependencies were rebuilt/recreated.                                                      |
| `docker build --target build -t brainless-t14-test -f infrastructure/docker/api.Dockerfile .` (root)                                          | Pass; refreshed cached test stage.                                                                                             |
| Docker test container: `node run-t14-test.cjs --runTestsByPath test/documents.integration-spec.ts test/processing-status.integration-spec.ts` | Pass: 2 suites, 24 passed, 1 skipped. Launcher supplies the isolated database URL; optional real Redis was not enabled.        |
| `npx.cmd playwright test e2e/phase-three.spec.ts` (`apps/web`)                                                                                | Pass: one full initial/new-version journey through Nginx on the final affected images.                                         |
| Compose prefix + `config --quiet`                                                                                                             | Pass, no rendered secrets.                                                                                                     |
| Compose prefix + `exec -T nginx nginx -t`                                                                                                     | Pass.                                                                                                                          |
| Compose prefix + `logs --since 5m --tail 35 api outbox worker`                                                                                | Reviewed startup/consumer/topology/integrity and sanitized HTTP logs; no unexpected startup error observed.                    |

The database integration launcher mounted only the existing API tests and an
ignored temporary launcher into the test-stage image; it used
`brainless_t13_integration_test` on the isolated Compose network. It did not reset
or migrate the development database. The launcher is removed after verification.

The final browser smoke verifies registration/login, both version jobs reaching
`COMPLETED`, current/per-version UI, downloaded-byte SHA-256 agreement,
unauthenticated 401 and other-user 404. It asserts no uncaught browser error or
API 5xx during the journey. Intermediate percentage animation is not a required
assertion because small integrity jobs may finish before polling.

Final documentation checks: Prettier across the 12 T14 Markdown files (the three
reported formatting issues were corrected), a targeted local path/heading-anchor
check of 158 internal links, and version/planned-status searches. Final
`git diff --check`, status/diff/staged review and historical snapshot comparison
were performed. Pre-existing T01–T13 work remains intact; no T14 schema,
migration, Compose, frontend or environment edit was introduced. Source/lockfile
changes are limited to the identified acceptance defects. No credential values
were included in this record.

## T14 files changed

- Application/test fixes: `apps/api/src/modules/documents/documents.service.ts`,
  `apps/api/test/documents.integration-spec.ts`, and formatting of
  `apps/api/src/infrastructure/messaging/processing-message.spec.ts`.
- Formatting/dependencies: `apps/api/.prettierrc`, `apps/api/package.json`,
  `apps/api/package-lock.json`. Existing Phase 3 AMQP/Redis dependencies and
  runtime scripts are preserved; T14 adds only the reviewed overrides.
- Current documentation: root `README.md` and `CHANGELOG.md`; `docs/README.md`,
  `docs/architecture.md`, `docs/database.md`, `docs/api.md`, `docs/roadmap.md`,
  `docs/specification.md`, `docs/compose.md`, `docs/phase-3-processing.md`,
  `docs/decisions/ADR-002-durable-processing-outbox-worker.md`, and this new
  acceptance record. Environment-variable and worker configuration guides already
  reflected the implemented contract and were preserved.

There are no unresolved release blockers for the approved scope. The dependency
audit limitations above remain open maintenance findings. No tag, push, deployment,
T15, v1.3.0 or AI implementation was performed.

## Upgrade and rollback guidance

1. Back up PostgreSQL and private document files together and retain the current
   application image/version. Follow [Compose backup guidance](compose.md#persistence-and-manual-backups).
   Never use `down --volumes` to upgrade or troubleshoot.
2. Preserve the existing Compose project name and database credentials. Configure
   private RabbitMQ credentials and the validated settings in the
   [environment reference](deployment/environment-variables.md). Redis is optional;
   it is not part of the required backup set for job correctness.
3. Pause uploads/writers and background processes for the deployment window. Run
   the existing one-shot `migrate` service (`prisma migrate deploy`) against the
   backed-up database. The two Phase 3 migrations are additive; do not edit old
   migrations or enqueue historical versions during deployment.
4. Start the version-matched API/outbox/worker and existing web/Nginx services.
   Check migration exit status, health, private worker storage, upload/new-version
   completion and downloaded bytes. Never mix incompatible message contracts.
5. If rollback is required, stop new writers and Phase 3 background processes
   first. Restore known-good version-matched images. Additive tables may remain
   for an application rollback, but v1.1 will not process pending Phase 3 jobs.
   Preserve those rows and broker messages for controlled reconciliation on
   re-upgrade. A database/file rollback requires a coordinated verified backup;
   do not drop processing tables as an improvised downgrade.

Fresh/upgrade migration tests are retained T13 evidence. Production backup restore,
rollback, mixed-version rollout and an internet-facing deployment were **Not Executed**.

## Limits and scope

There is no tenant model, CI/CD workflow, permanent purge, historical bulk backfill,
automatic dead-letter replay or public manual-retry API. Deployment TLS, real
secrets, operational backups and distributed authentication rate limiting require
deployment-specific work. Intermediate integrity progress can finish too quickly
for browser observation; completion is durable regardless. The archive-versus-I/O
race was not forced in a browser; cancellation of a claimed lease is covered by
the PostgreSQL regression. These limits do not imply exactly-once processing.

Historical v1.0.0/v1.1.0 snapshots remain unchanged. No OCR, extraction, search
provider, embeddings, Qdrant, RAG, LLM, AI agent, MCP, WebSocket or SSE feature was
introduced. T14 does not create a release tag or start another phase.
