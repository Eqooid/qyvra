# v1.3.1 T06 — Documentation, candidate version and release readiness

Prepared **13 October 2026** on branch `v1.3.1`. Existing uncommitted T01–T05 work
is preserved. T06 adds documentation and candidate metadata, not AI features.
Status: **CONDITIONALLY READY** for the exact T05-tested pair; unpublished.

## Version ownership

Inspection found no root npm manifest and four independent private packages, all
`0.0.1`, with consistent lock roots. Worker/outbox are API entry points rather than
separate packages. OpenAPI's version `1` describes the HTTP contract `/api/v1`.
Local Compose images derive names from the project; there is no release registry/tag
automation or existing OCI release label. None of those fields is governed by the
product release tag, so no unrelated package/API/lock/image version was changed.

T06 introduces root [VERSION](../VERSION) as explicit candidate product metadata,
`1.3.1`, and updates active documentation/changelog/release notes accordingly.
Git tags/releases remain the authority for publication under the updated
[versioning convention](development/conventions.md#versioning). There is no claim
that an npm version bump or an OpenAPI major version is required for this patch.

## Readiness assessment

| Area                              | Evidence / disposition                                                                                                           |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Runtime compatibility             | Real Ollama native embedding and generation factories, exact tokenizer/digest checks PASS                                        |
| Application E2E                   | Actual multi-page PDF → worker → checkpoints → Qdrant READY → owned retrieval → Qwen → validated citations → browser source PASS |
| Security                          | SQL ownership/hostile payload checks, unknown citations rejected, archive/source fences and safe provider errors PASS            |
| Recovery                          | Native partial checkpoints, controlled provider outage, no-reembedding Qdrant loss/rebuild and 36 real-service cases PASS        |
| OpenAI                            | Retained deterministic adapter/configuration regression PASS; paid smoke NOT RUN                                                 |
| Remaining critical/major blockers | None observed in completed T05 evidence                                                                                          |
| Nonblocking model limitation      | Small pinned Qwen may fail closed on adversarial contexts; general factual quality is not guaranteed                             |
| Environment-specific              | Other models/templates, CPU-only/other GPU/LAN/remote TLS not certified                                                          |
| Remote CI / rollback drill        | NOT RUN; local evidence is not a remote CI or production rollback claim                                                          |

The initial T05 failures were resolved fixture/tooling issues, not concealed product
passes. Historical checkpoint matrices remain in the [T05 ledger](local-provider-verification.md).
T06 does not replay T05 E2E since it changes no provider or processing behavior.

## Deliverables and validation

Created `VERSION`, `docs/development/local-ai.md`, `docs/releases/v1.3.1.md`, and
this file. Expanded `docs/developer/versions/v1.3.1.md` with a current implementation
walkthrough while preserving its T01 audit. Updated root README, documentation/developer
indexes, roadmap, changelog, versioning conventions, environment-reference links and
safe `.env.example` comments. The existing canonical local-provider guides and T05
evidence remain linked rather than copied into a competing hierarchy.

Focused validation executed during T06:

| Check                                   | Result                                                                                                                                                     |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Substantive deliverables                | PASS: versioned walkthrough, 16 KB setup, release notes and preparation file exist                                                                         |
| Relative documentation references       | PASS: 390 paths, including 42 Markdown anchors, zero missing                                                                                               |
| Setup JavaScript snippets               | PASS: both data/preparation examples parsed with `node --check`; no downloads/inference executed                                                           |
| Environment defaults/model evidence     | PASS: `.env.example` validated with synthetic test DB/storage values; AI remains disabled; model names/digests match T05                                   |
| Four package/lock roots                 | PASS: JSON metadata and `npm.cmd ls --package-lock-only --omit=dev --depth=0 --json` in API/web/database/storage; no lockfile rewrite or upgrade           |
| Compose/provider examples               | PASS: nine configuration/privacy checks with synthetic env; optional live probe skipped because Docker daemon unavailable in T06, previously passed in T05 |
| Product vs contract version             | PASS: VERSION/README/release entry 1.3.1; private npm 0.0.1 and OpenAPI 1 intentionally preserved                                                          |
| Historical preservation                 | PASS: nine snapshot/baseline hash comparisons unchanged                                                                                                    |
| Formatting/diff and asset/secret review | PASS: final review recorded below                                                                                                                          |

Final review found zero generated test-credential matches in changed/new tracked-intent
files and zero model weights/bundles/wheels included. `git diff --check` and targeted
Prettier checks pass. The developer index prefix was formatted separately to preserve
its historical body. Snapshot hashes, documented script/command paths, model evidence,
current-version headings and substantive deliverable files were rechecked.

Unchanged application builds remain the successful T05 production API/worker and
frontend build evidence; no manifest/runtime modification requires a new build.
No full E2E, paid API, model pull, Docker startup, migration or remote CI was repeated.

T06-created files: `VERSION`, `docs/development/local-ai.md`,
`docs/releases/v1.3.1.md`, `docs/local-provider-release-preparation.md`.
T06-modified files: `README.md`, `CHANGELOG.md`, `.env.example`, `docs/README.md`,
`docs/developer/README.md`, `docs/developer/versions/v1.3.1.md`,
`docs/development/conventions.md`, `docs/deployment/environment-variables.md`,
`docs/architecture.md`, `docs/database.md`, `docs/roadmap.md`.
Pre-existing T01–T05 working-tree changes remain separate from this inventory.

**T06 complete.** Readiness remains **CONDITIONALLY READY**, with the qualified
support matrix and unexecuted deployment-specific checks above. No outstanding
critical/major release blocker was found in reviewed T05 evidence.

## Maintainer handoff

Review all T01–T06 changes and unrelated pre-existing edits separately. A release
commit must contain the complete implementation/assets **tooling**, tests and docs,
not just T06 files or ignored local caches. Stage explicitly, obtain the actual CI
result, then authorize commit/tag/push/publication as separate actions. Do not tag
the previous baseline as this candidate. No automatic Git or release action occurred.

Next action is maintainer review and CI verification, followed by separately authorized
release preparation. No new development phase is begun by this task.
