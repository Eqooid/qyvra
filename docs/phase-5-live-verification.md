# Phase 5 - Live verification continuation

Recorded 16 October 2026. **Local acceptance incomplete / NOT READY.**
Target v1.4.0 remains unreleased; VERSION remains 1.3.1.
This supplements the dated [T11 review](phase-5-verification.md) and
[T12 handoff](phase-5-manual-git-handoff.md); it does not erase earlier failures.

## Recovered evidence - do not repeat

The completed isolated runtime run is recorded in ignored local artifact
`.tools/phase5-live-attempt8.log`, project `qyvra-search-test-268bb00ec031`.
It used the pinned Elasticsearch 9.4.6 image, authenticated private API/worker
connectivity and the existing isolated PostgreSQL 17 test database with 18 applied
migrations. No historical migrations were edited or replayed for continuation.

Command: `node infrastructure/test/search-runtime.cjs` with disposable
`TEST_DATABASE_URL`. Its four selected Jest suites were elasticsearch,
search-maintenance-live, keyword-search and search-publication integration specs:
**4 suites / 45 tests passed, zero skipped**. These include real Elasticsearch
adapter and maintenance cases, plus PostgreSQL-backed cases using infrastructure
doubles; all 45 must not be described as complete live end-to-end workflows.
API write and worker read probes passed. Elasticsearch restart, health recovery
and worker read of persisted test content passed. Only the harness's own guarded
random-project resources were cleaned up; the existing qyvra stack was untouched.

The passed runtime image `qyvra-search-test-268bb00ec031-api` and successfully
built `qyvra-phase5-search-web-test` can be reused. The web build log is
`.tools/phase5-search-web-image.log`. Do not rebuild unchanged images or repeat
backfill/rebuild operations merely to recover this evidence.

## Defects corrected during live verification

- Windows Docker secrets were mounted mode 0777, rejected by Elasticsearch.
  A narrow entrypoint copies the bootstrap password into private tmpfs with
  mode 0600 before invoking the official entrypoint. Authentication stays on.
- The setup shell script had CRLF; normalized to LF and added a static guard.
- Elasticsearch omits default mapping options and returns copy_to as an array.
  Compatibility inspection now normalizes those equivalent representations;
  explicit disabled authorization keyword indexes/doc-values, disabled source,
  and different copy targets still fail compatibility tests.
- The outbox previously inferred search delivery from Elasticsearch enablement,
  although the private Compose relay intentionally has no ES credentials.
  SEARCH_OUTBOX_DELIVERY_ENABLED now advertises installed worker capability;
  search Compose enables it on outbox only. Outside Compose, an absent flag
  retains the former Elasticsearch-enabled default. No fake handler was added.
- The isolated runtime harness adds a test-only host bridge for Docker Desktop
  loopback publication and sanitized startup diagnostics. Production search
  networking remains internal and unpublished.

Earlier attempts failed during startup, mapping probing or host-port discovery;
the final successful run supersedes those failures for the corrected paths.
These fixes do not prove full broker delivery or every lifecycle race.

## Focused verification

| Check                                                             | Actual result                                                         |
| ----------------------------------------------------------------- | --------------------------------------------------------------------- |
| Adapter focused Jest spec                                         | 32 passed                                                             |
| Configuration/outbox focused Jest selection                       | 32 passed                                                             |
| Environment spec after adding delivery default to expected object | 93 passed; earlier missing-field expectation failed and was corrected |
| API TypeScript, tsc --noEmit --incremental false                  | PASS after current configuration changes                              |
| node --test infrastructure/test/search-compose.test.cjs           | 2 passed                                                              |
| API production npm audit --omit=dev --audit-level=high            | Exit 0, 5 moderate findings; no claim of zero findings                |
| Frontend production Docker image                                  | Built successfully; live browser behavior remains unverified          |
| Existing T11 mocked browser/component evidence                    | Reused only for unchanged frontend behavior; not a live Nginx pass    |
| Repository-wide frontend formatting                               | Prior 47-file failure retained; unrelated files not reformatted       |

## Remaining gates and exact checkpoint

**Browser: previously BLOCKED, now executed successfully (see update below).** Docker was available for the successful runtime run, then
its engine pipe became unavailable after interruption. The next isolated browser
attempt failed before startup/build execution; no browser test ran.
Ignored checkpoint: `.tools/qyvra-e2e-search-13fed34ec2/checkpoint.json`;
log: `.tools/phase5-browser-live.log`. The prepared local runner is
`.tools/phase5-browser-run.cjs`. Owner next action: start Docker Desktop's Linux
engine, then resume that runner with PHASE5_RUNTIME_IMAGE set to the passed image
above. Reuse built images; never reset existing databases/volumes/indexes.

The unfinished browser flow must prove PDF upload, automatic enrollment, outbox,
RabbitMQ, real worker publication, authorized search, highlights, autocomplete,
source navigation and lifecycle exclusion through Nginx. Separate broker outage,
redelivery, concurrent worker and restart scenarios remain unverified where not
covered by the selected suites. Direct handler delivery is not broker evidence.

**Live hybrid: BLOCKED by explicit owner direction.** The configured Ollama
endpoint was unavailable; do not download a model or change embedding profiles.
Real Qdrant/provider hybrid and full RAG compatibility acceptance is not claimed.

**Quality/resources: NOT VERIFIED.** A [30-query proposed corpus](phase-5-search-quality.md)
is prepared with proposed labels and null budgets. Owner approval covers preparing
labels only. Gold judgments, latency/memory thresholds and measured evaluations
remain pending. No relevance or performance acceptance has been inferred.

**Remote CI: PENDING owner's manual push** of the final reviewed candidate.
Earlier connector results did not establish a passing run for that candidate.
No staging, commit, push, tag, PR, release or deployment was performed.

Complete these gates before marking Phase 5 complete. Preserve prior accepted
release snapshots and the existing manual Git restrictions.

Continuation-only final checks: focused changed-file API Prettier and ESLint passed;
Node syntax and the two static Compose tests passed. Read-only Git whitespace
check passed and the staging index remains empty. Documentation file targets
were checked; fragment anchors were not automatically validated.

## Browser gate closed in the next continuation

Docker 27.4.0 became available again. The isolated Chromium/Nginx fixture
`apps/web/e2e/phase-five-search.spec.ts` passed: **1 test, 15.5 seconds**,
real authenticated services, with no mocked backend responses. It verified
upload, durable lexical publication through outbox/RabbitMQ/worker, keyword UI,
safe highlights, exact page-two source, private title suggestions, second-user
exclusion and archive filtering. This certifies that scenario, not every browser
filter/pagination/hybrid/recovery permutation.

Project: `qyvra-e2e-search-2dec3eb3e4`; log:
`.tools/phase5-browser-resume4.log`. The local checkpoint records PASSED and
generation `4bfb5617-6240-4359-a286-7901ec0130d4`. Existing images were reused.
Only new isolated test resources were created; all test volumes were preserved.

Initial harness attempts failed on broker startup timing and incorrect bootstrap
ordering/CLI invocation. The local runner now stages infrastructure, provisions
the generation through the existing database environment wrapper, and then enables
application enrollment. Subsequent resumes reused migrations, credentials and the
existing generation instead of repeating completed setup. No application source
change was required for these harness corrections.

The owner delegated routine evaluation choices during this continuation. Keyword
measurements use agent-selected local reference limits (p95 1500 ms keyword,
1000 ms suggestions), not an agreed production SLO or human relevance gold.
Live hybrid remains blocked under the earlier explicit instruction.

## Real recovery continuation

The isolated additional runner completed its executed functional scope, recorded
in `.tools/qyvra-e2e-search-2dec3eb3e4/additional-results.json` and
`.tools/phase5-additional5.log`. The following checks passed:

- All 14 synthetic corpus PDFs reached verified text publication through the real
  outbox, RabbitMQ and worker infrastructure.
- Upload during broker downtime persisted work; publication recovered after restart.
- Upload with the worker stopped remained pending and published after restart.
- Archive while cleanup workers were stopped excluded physically stale indexed
  content; restore/restart republished and soft deletion immediately excluded it.
- Elasticsearch downtime returned HTTP 503 for search while the document-list
  API remained available. Restart restored keyword results.

These are real services, not mocked transport tests. A graceful worker stop with
pending work is not proof of a hard crash at every publication boundary. Earlier
SQL lease-expiry and fault-injection results retain their separately stated scope.
No production volume, stored document, active index or model was changed.

The first quality pass executed 30 queries / 90 keyword requests and detected no
foreign-owner result IDs. Four designated exact-reference cases ranked first.
Rate limiting returned 429; the runner honored bounded retry waits rather than
raising production quotas. Local fixture/session recovery resumed completed work.

Those initial relevance measurements are **exploratory, not acceptance evidence**:
some generated PDFs placed long lines outside the page, clipping extraction. A
separate corrected run wraps text and uses new immutable versions only for affected
synthetic fixtures. It checks complete normalized extraction before scoring.
A Thai compound-query miss also needs to remain visible in the final results; do
not silently change analyzers or labels to obtain a pass.

## Evidence reuse and limitations

Fourteen source/configuration/fixture hashes still match the separate continuation
manifest; no application code changed during this verification continuation.
Previously passing builds, unit tests and targeted security checks were reused
within that unchanged scope. The remaining full-stack work used existing images.
A resource sample from the initial 14-document run covered all ten isolated
services (Elasticsearch approximately 909 MiB, API 218.8 MiB, worker 155.2 MiB).
It is a steady-state sample, not a peak-memory/load qualification.

Browser/recovery passes do not close the explicit provider block, human relevance
review requirement, sustained resource scenarios or final-candidate remote CI.
Remote CI remains pending the owner's manual push; no Git write action is allowed
by this task. The previous unrelated 47-file frontend formatting failure remains
disclosed. There is no claim of release readiness or zero residual risk.

## Corrected keyword measurements and duplicate delivery

The corrected run completed 30 queries with two requests each, paced 2.1 seconds
apart, after all 14 canonical extracted texts matched their logical fixture
content under NFC/whitespace normalization. Ten clipped synthetic PDFs received
new immutable versions; original versions/files were preserved. No analyzer or
ranking behavior changed.

[Machine-readable results](phase-5-keyword-quality-results.json) record warm p95
**156.949 ms** from 30 second-request samples. Agent-proposed labels yield
Recall@10 **0.733974**, MRR **0.769231**, nDCG@10 **0.748547**, each over 26
queries with applicable relevance denominators. Four no-relevant-label cases
are excluded from those averages. All four designated exact-reference queries
ranked first; both designated phrase queries met top-five expectations.
All 30 corrected-run rankings were checked against foreign-owner IDs.

These are keyword-only, small-corpus measurements, not proof of hybrid improvement
or an agreed production budget. Thai Q10 still returned no match despite complete
canonical text. That miss is retained, with no relabeling or analyzer tuning.
The initial clipped-fixture scores are superseded only for quality evaluation.

Two real worker consumers then drained duplicate completed-job envelopes without
changing the ready publication. Evidence: local `corrected-quality-results.json`
and `.tools/phase5-quality-corrected.log`. Both isolated runners recorded
PASSED_EXECUTED_SCOPE. PowerShell redirected native Docker stderr as error records
and reported wrapper exit 1; these are not recorded as exit-0 commands. A separate
artifact assertion verified completed functional outcomes, fidelity, query count,
reference/phrase checks and the duplicate-delivery result.

The provider availability recheck now returns the existing certified Nomic
model/digest and Qwen model. No model was downloaded, no profile was switched,
and no inference request was made: the earlier explicit instruction to keep
live hybrid blocked was preserved. That gate is no longer described as currently
unreachable; it remains unrun.

**Current decision: NOT READY / local acceptance incomplete.** Browser, the stated
outage/recovery scenarios, corrected keyword measurements and two-consumer
duplicate delivery are now evidenced. Hybrid/provider comparison, human gold
judgments, agreed non-regression/resource acceptance, dense/peak scenarios and
remaining hard-crash/rebuild races are not certified. Remote CI on the final
candidate remains pending the owner's manual push. No Git write operation occurred.
