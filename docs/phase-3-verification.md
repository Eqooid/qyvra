# v1.2.0 Phase 3 verification (T13)

[Documentation index](README.md) | [Processing architecture](phase-3-processing.md) |
[Roadmap](roadmap.md)

**Status: verification completed for T13; v1.2.0 release acceptance remains
planned for T14.** This record covers the Phase 3 working-tree implementation
through T12 and the focused T13 verification work performed on 30 September–
1 October 2026. It is not a release snapshot or a claim of exactly-once delivery.

## Environment and scope

The full stack ran behind Nginx at `http://localhost:18080` in an isolated
Compose project, `brainless-e2e-t13`: PostgreSQL 17, RabbitMQ 4.1, Redis 7.4,
one-shot migrations, API, outbox dispatcher/recovery coordinator, worker, web,
and Nginx. PostgreSQL integration tests used a separate disposable database;
RabbitMQ integration tests used an isolated virtual host. Browser reliability
tests were guarded to run only against the T13 project. No existing development
database or broker volume was reset. A retained volume in the default E2E
project had mismatched database credentials, so verification used the fresh
isolated project rather than deleting that volume.

The new browser scenarios live in
[`phase-three.spec.ts`](../apps/web/e2e/phase-three.spec.ts) and
[`phase-three-reliability.spec.ts`](../apps/web/e2e/phase-three-reliability.spec.ts).
They create their own users/documents and generated files. Existing v1.0.0 and
v1.1.0 browser suites were also exercised. The v1.1.0 catalog test was updated
to use the current Filters dialog and URL-backed date filters; no catalog
application behavior was changed by that fix.

## Verification matrix

| Scenario                                | Expected result                                                                                          | Observed result         | Evidence                                                                                                                             |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Fresh full-stack startup and migration  | All required services become healthy and schema applies                                                  | Pass                    | Isolated Compose startup; migration job exited successfully; Nginx configuration validation passed                                   |
| Initial upload through Nginx            | First version, job, and outbox intent persist; processing completes                                      | Pass                    | Phase 3 browser journey and upload-scheduling PostgreSQL integration tests                                                           |
| Additional version                      | A new version has its own job and status                                                                 | Pass                    | Phase 3 browser journey and upload-scheduling integration tests                                                                      |
| Owned status and UI                     | Authorized client sees the current/per-version status and completion                                     | Pass                    | Phase 3 browser journey, processing-status API integration tests                                                                     |
| Download after verification             | Downloaded bytes match uploaded bytes                                                                    | Pass                    | Phase 3 browser journey checksum comparison                                                                                          |
| Authentication and ownership            | Unauthenticated and other-user status requests cannot read the job                                       | Pass                    | Phase 3 browser journey (401/404), processing-status integration tests                                                               |
| Worker unavailable                      | Committed work remains available and completes after worker restart                                      | Pass                    | Isolated browser reliability test                                                                                                    |
| RabbitMQ unavailable                    | Outbox intent remains durable and dispatch resumes after broker recovery                                 | Pass                    | Isolated browser reliability test and outbox integration tests                                                                       |
| Redis unavailable or keys lost          | Durable processing and status survive; progress can disappear                                            | Pass                    | Isolated browser reliability test; `FLUSHDB` in isolated Redis left document/job/outbox/completed/failed PostgreSQL counts unchanged |
| Corrupt or missing stored bytes         | Job fails terminally with a client-safe error                                                            | Pass                    | Two isolated browser reliability tests                                                                                               |
| Transient storage access failure        | Same job retries through a new outbox delivery and completes                                             | Pass                    | Isolated browser reliability test and processing repository tests                                                                    |
| Persistent storage access failure       | Maximum attempts cause terminal failure; no unbounded redelivery loop                                    | Pass                    | Isolated browser reliability test                                                                                                    |
| Expired processing lease                | One recovery delivery is created and work completes                                                      | Pass                    | Isolated browser reliability test and processing repository tests                                                                    |
| Full-stack stop/start with pending work | Durable pending work survives and completes after restart                                                | Pass                    | Isolated browser reliability test                                                                                                    |
| Duplicate confirmed RabbitMQ message    | Completed job is not restarted or charged another attempt                                                | Pass                    | Isolated browser reliability test                                                                                                    |
| Two workers                             | Concurrent consumers produce one durable processing attempt                                              | Pass                    | Isolated browser reliability test; repository concurrent-claim test                                                                  |
| Near-limit file                         | Generated ~1.8 MiB PNG processes successfully under the 2 MiB test limit                                 | Pass                    | Isolated browser reliability test; no large binary fixture committed                                                                 |
| Malformed message and redelivery        | Invalid delivery is dead-lettered; interrupted valid delivery is recoverable                             | Pass                    | Worker/RabbitMQ integration tests                                                                                                    |
| Database atomicity and upgrade          | Jobs/outbox obey constraints and old data survives additive migration                                    | Pass                    | 13 processing persistence/repository tests and isolated v1.1-to-v1.2 migration test                                                  |
| Existing document workflows             | Authentication, metadata, versions, archive/restore, delete, categories/tags and discovery remain usable | Pass in exercised flows | Existing Phase 1/2, cancellation and UI browser tests; targeted catalog rerun after test-selector update                             |

The browser reliability scenarios above each passed individually. A combined
regression run initially found only the stale v1.1.0 catalog test selectors;
the updated catalog scenario passed in a targeted rerun. The broader browser
suite was not rerun after that test-only change. This distinction matters when
interpreting the regression result.

## Other checks executed

- API unit suite: **28 suites passed; 253 tests passed, 1 skipped**.
- Web unit suite: **18 files passed; 201 tests passed**.
- API PostgreSQL/RabbitMQ integration: worker suite **5 passed**; outbox,
  processing-status, messaging, and upload-scheduling suites **17 passed** in
  four suites.
- Database processing persistence/repository tests: **13 passed**; isolated
  migration-upgrade test: **1 passed**. Processing-rule unit tests: **2 passed**.
- Phase 3 browser journey passed before and after a Docker service restart.
  Nginx configuration validation passed.
- API and web type checks passed. Web lint, targeted E2E Prettier and ESLint,
  and formatting of this verification record passed. Final diff/scope review
  is recorded in the T13 completion report.
- Full API lint did **not** pass: ESLint reported 3,489 Prettier errors, mostly
  CRLF line-ending differences across source and test files outside T13, plus
  some formatting issues in Phase 3 files. T13 did not reformat unrelated
  application files. This remains a verification limitation for T14.

Tests requiring Docker used only the isolated T13 project. The browser tests
restore stopped services in `finally` blocks. PostgreSQL remains the source of
truth when RabbitMQ or Redis is interrupted; the tested duplicate publication
window retains at-least-once semantics.

## Limits and follow-up

The production verification task is still **Planned (T14)**. These tests did not
prove exactly-once delivery, global message ordering, or exhaustive behavior
under every infrastructure fault. The integrity task usually finishes too
quickly for a stable intermediate progress percentage to be observed through
the browser; Redis progress integration and outage behavior were exercised in
API/worker tests and the isolated outage scenario. An archive-versus-running-job
race was not separately forced in browser E2E; existing archive access and
repository eligibility were exercised. There is no tenant feature in the current
application, so cross-tenant testing is not applicable. Historical versions were
not bulk enqueued.

No application behavior was changed to make a verification scenario pass. The
only T13 corrections were the stale v1.1.0 browser test and outdated Compose
documentation about scheduling. T14 should perform the final acceptance and
release-readiness review using this matrix and the canonical processing guide.
