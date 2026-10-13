# v1.3.1 T07 - Release candidate review

Reviewed 13 October 2026. **CONDITIONALLY READY** within the pinned T05 model and
deployment scope. This is preparation for maintainer review, not publication or
approval of an unexecuted final-commit CI run.

## Candidate and baseline

- Branch: `v1.3.1`.
- HEAD: `dec2c0f42421a90aa32d96c2799af5daec7ba8be` (`Add Documentation v1.3.0`).
- Local `v1.3.0` branch and merge-base resolve to that same SHA. No v1.3.0 tag
  exists; the only local tag is v1.1.0. The actual branch baseline is used.
- All candidate changes are uncommitted; the index was empty and remains empty.
- Initial effective diff: 29 tracked files plus 33 untracked files. Seven PDF
  status entries had no content diff. No deletions or migrations, no unrelated
  feature changes identified. Ignored `.tools` assets/logs are not release files.
- T07 adds this report, updates current documentation links/security notes and the
  web manifest/lock, and extends encrypted-PDF fixture checks. The complete proposed
  file inventory is below; these paths have **not** been staged.

## T01-T06 assessment

| Task | Actual evidence reviewed                                                                                       | Assessment                                                                                   |
| ---- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| T01  | Versioned audit and ADR-006; native adapters match recommended approach                                        | Complete audit; ADR remains explicitly proposed                                              |
| T02  | Native embedding adapter/factory/tokenizer, SQL profile fingerprints and checkpoint integration tests          | Implemented; cloud adapter retained                                                          |
| T03  | Native schema-constrained chat, independent factory, context counting and existing strict citation parser      | Implemented                                                                                  |
| T04  | Shared configuration validation, API/worker wiring, optional asset/host overrides and model-free network tests | Implemented                                                                                  |
| T05  | Final continuation ledger plus actual provider, tokenizer, workflow and real-service artifacts                 | Real pinned-pair application E2E complete; historical failed attempts remain distinguishable |
| T06  | VERSION, walkthrough/setup/release files, current indexes/roadmap and validation record                        | Complete; product version differs intentionally from private package/API versions            |

Primary retained evidence: [T05 verification](local-provider-verification.md) and
[T06 preparation](local-provider-release-preparation.md). Real T05 calls used
Ollama 0.40.3, `nomic-embed-text:v1.5` (768 dimensions) and `qwen3:0.6b`, with pinned
digests and independently checked tokenizer bundles. Actual Nginx upload, Linux
PDF parsing, four chunks/checkpoints, complete READY index, owned search, Qwen
answers, canonical page citations and browser source navigation passed. Controlled
503 interruption reused the first checkpoint; deleting only the isolated derived
collection rebuilt without re-embedding. User isolation, archive/source fences,
insufficient evidence and safe rejection of adversarial output passed.

Thirty-six additional real PostgreSQL/Qdrant/RabbitMQ/Redis cases passed in T05.
These, Docker runtime builds and real inference were deliberately not repeated:
T07 changes no provider, persistence, worker, retrieval or citation algorithm.
The prior live browser run used Next.js 16.3.6; it is historical evidence, not a
fresh browser certification of the T07 framework patch. Frontend static/unit checks
and a production build are run for that patch.

## Architecture and security audit

The native providers are infrastructure adapters behind existing interfaces.
`embedding-provider.factory.ts` is shared by worker and search; dispatch uses the
immutable SQL profile, not request input. `generation-provider.factory.ts` is
independent and generation-only changes do not invalidate vectors.

- PostgreSQL jobs, checkpoints, profile identity and index activation remain
  authoritative. RabbitMQ transports durable identifiers/outbox envelopes; Redis
  progress is optional; Qdrant is derived and rebuildable.
- Provider, model, revision, dimensions, normalization, instructions and tokenizer
  identity participate in the existing fingerprint. Matching dimensions do not
  permit checkpoint/vector reuse. Retrieval compares the configured fingerprint,
  uses the active compatible SQL scope and rehydrates exact candidate tuples.
- Qdrant requests carry user/profile/manifest filters. PostgreSQL ownership,
  current version, lifecycle and completed-generation checks remain mandatory.
  RAG revalidates sources before generation and before publishing the answer.
- Incomplete indexes cannot become READY through the existing guarded repository
  activation. No schema or activation change is introduced in this release.
- Citation identifiers resolve only through the request-local canonical source
  map. Unknown identifiers, invented metadata and malformed output are rejected.
  Empty evidence avoids model calls; PDF text is evidence, not trusted instructions.
- Native calls have finite deadlines, bounded bodies/batches/context/output,
  validated finite vectors, model-digest checks and controlled failure categories.
  Only durable worker processing retries; generation has no unbounded retry loop.
- Tokenizers are operator-provisioned JSON data, bounded to 64 MB, hash/profile/
  reference checked. No remote code, startup download, tool use or browser provider
  access is added. Endpoint validation forbids URL credentials/query/fragment and
  redirects; private HTTP requires explicit opt-in. Trusted operator URLs still
  require network controls; this is not arbitrary-user URL fetching.
- Compose mounts certified assets read-only, keeps provider configuration server-side,
  preserves storage/vector networks and has no mandatory inference service, public
  provider port or Nginx Ollama route. Host-gateway mapping is an explicit override.

No confirmed authorization, citation, checkpoint, profile or activation violation
was found. There is no separate tenant entity; user ownership is the implemented
isolation boundary. Structural citation validation cannot prove every factual claim
or universal prompt-injection resistance. Before/after model-catalog checks cannot
provide an atomic snapshot against malicious replace-and-restore model changes.

## Dependencies and focused corrections

Original candidate adds only `@huggingface/tokenizers` **0.2.0**, an exact-version
data tokenizer with no framework or transitive dependencies. API lock resolution
and integrity are present. Existing cloud HTTP adapters remain unchanged; there
is no newly installed OpenAI SDK, Ollama SDK or AI orchestration framework.

T07 reproduced a required release-gate failure: web production audit exits 1 for
Next.js 16.3.6. [GHSA-cjq9-62q9-8jv4](https://github.com/advisories/GHSA-cjq9-62q9-8jv4)
identifies 16.3.8 as patched. Qyvra has no `images.remotePatterns`, so the advisory's
remote-image exploit precondition is absent; the audit gate still fails.

Minimal correction: `next` and matching `eslint-config-next` **16.3.6 -> 16.3.8**,
with the npm-generated lockfile. Only Next-family resolved versions change. npm
also normalizes optional/peer metadata; no broad dependency upgrade or audit-force
operation was used. An isolated package-lock-only update preserves original
resolution inputs; clean-install dry-run with registry access passes. Offline
validation lacked optional WASM peer metadata and failed; it is not a passing
offline-install claim. Web production audit after correction reports zero findings.

A second regression check found checkout-added CRLF bytes in `encrypted.pdf`:
1413 working bytes versus 1378 committed bytes, breaking its xref pointer. T07
restored the exact committed bytes, without weakening parser validation or changing
fixture content, and added both encrypted fixtures to the xref byte check. The
new case failed before restoration and all nine checks pass afterwards. Existing
`*.pdf binary` prevents this on future checkouts; the restored PDF needs no content
staging because it equals the baseline.

No new/applied migration is modified. Existing fifteen-migration chain and v1.3.0
state stay intact; retained T05 isolated clean deployment passed. No database reset,
model download, inference, Qdrant mutation or data cleanup was performed in T07.

## CI review and remote results

Only `.github/workflows/phase-four.yml` exists. Push and pull-request events have
no branch/path filter, so v1.3.1 matches; workflow_dispatch is also supported.
There is no separate release publication workflow. Node 24/Ubuntu, locked installs,
kernel PDF guard, API/worker and web builds, all-package type/lint, production audit,
clean/upgrade migrations, unit/API integration and web tests are declared.
The candidate adds model-free Compose/privacy and PDF fixture tests. Routine CI
requires no Ollama, GPU, downloaded model or host tokenizer cache: native tests
construct controlled JSON fixtures. Infrastructure comes from declared service
containers. Browser fault injection/live model testing remains opt-in. This job
does not build production Docker images or run a live browser/model workflow;
those retain their separately recorded T05 evidence.

GitHub was accessible read-only. The latest inspected branch run is
[38112491169](https://github.com/Eqooid/qyvra/actions/runs/38112491169), push on
`v1.3.1`, SHA `dec2c0f42421a90aa32d96c2799af5daec7ba8be`, created 11 October 2026.
Job `contracts-and-recovery` failed at **Production dependency audit**; locked
installs, builds and type/lint passed; migration and test steps were skipped.
Earlier v1.3.0 runs also failed. This run is the baseline, not the dirty candidate.
Local audit reproduces the web failure and verifies the patch, but remote CI has
**not** run the final candidate. No workflow was dispatched or pushed.

## T07 commands and outcomes

Commands run from repository root unless a directory is specified.

| Check/command                                                                                                          | Result                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Git status/diff/cached diff/log/branches/tags/rev-parse/merge-base                                                     | Baseline established; staged diff empty; scope isolated                                                    |
| `npm.cmd --prefix apps/api run build`                                                                                  | PASS; shared storage/database and Nest API/worker/outbox entry points build                                |
| `npm.cmd --prefix apps/api run typecheck`                                                                              | PASS                                                                                                       |
| `npm.cmd --prefix apps/api run lint`                                                                                   | PASS                                                                                                       |
| API local Jest `--runInBand --runTestsByPath` embedding/generation Ollama specs + local-provider/environment specs     | PASS: 185 tests, four suites                                                                               |
| API local Jest RAG answer/context + citation-source specs                                                              | PASS: 36 tests, three suites                                                                               |
| `node --test infrastructure/docker/local-provider-config.test.cjs infrastructure/test/pdf-fixture-integrity.test.cjs`  | Initial PASS: 16, one live-network skip; expanded encrypted regression separately PASS: nine               |
| Four packages `npm.cmd --prefix <package> audit --omit=dev --audit-level=high --json`                                  | Storage/database PASS zero; API PASS five moderate, zero high/critical; original web FAIL one high package |
| `npm.cmd --prefix apps/web install --save-exact next@16.3.8 eslint-config-next@16.3.8 --ignore-scripts`                | Patch installed; no automatic audit fix                                                                    |
| Isolated `npm.cmd --prefix .tools/v131-t07-web-lock install --package-lock-only --ignore-scripts --no-audit --no-fund` | PASS, original lock inputs retained                                                                        |
| `npm.cmd --prefix apps/web ci --dry-run --ignore-scripts --no-audit --no-fund --loglevel=error`                        | PASS with registry metadata; no installation performed by dry run                                          |
| Web production audit after patch                                                                                       | PASS, zero production findings                                                                             |
| `npm.cmd --prefix apps/web run build`                                                                                  | PASS Next 16.3.8 production standalone build; existing font download needs network                         |
| `npm.cmd --prefix apps/web run typecheck` / `run lint`                                                                 | PASS                                                                                                       |
| Web Vitest three AI files `--maxWorkers=1 --pool=threads`                                                              | PASS: 12 tests; default Windows worker stalled and was interrupted, not counted as passing                 |
| `npm.cmd --prefix apps/web test -- --maxWorkers=1 --pool=threads`                                                      | PASS: 214 tests, 21 files; includes the focused AI subset                                                  |
| Documentation/version/lock-root/historical/credential/asset validation                                                 | PASS; final totals recorded below                                                                          |
| `git diff --check`                                                                                                     | PASS                                                                                                       |

The first API command used an incorrect npm working-directory prefix and was
cancelled. A subsequent run named a nonexistent citation-spec file: four suites
passed but the overall command failed. Correct explicit paths were then verified;
neither mistaken invocation is counted as a successful command.

Docker daemon is unavailable in this T07 environment. Compose parsing/configuration
checks pass using synthetic environment values; live model-free network probe is
SKIPPED, with prior actual T05 pass retained. No claim is made about current container
health, host/LAN/remote connectivity or a new Linux Docker build.

Final documentation/hygiene validation: **65 intended files, 496 relative links/anchors, zero errors**; eight historical snapshot hashes unchanged. Targeted Prettier formatting and Git whitespace checks pass. No model or credential file is in the proposed scope. T07 review/commit preparation is complete; release publication remains a separate decision.

## Release findings and remaining gates

| Severity      | Finding                                                                 | Disposition                                                                                       |
| ------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| HIGH          | Required production audit fails for locked Next.js 16.3.6               | Fixed narrowly to 16.3.8; audit/build/focused UI regression pass locally                          |
| MEDIUM        | API audit has five moderate entries in Nest/file-type dependency chains | Recorded; high/critical gate passes. No unsafe major upgrade or assertion of zero vulnerabilities |
| MEDIUM        | Encrypted fixture checkout conversion breaks xref                       | Exact baseline bytes restored; reproduced failure and nine regression checks pass                 |
| INFORMATIONAL | Remote baseline CI failed; no final candidate commit/run exists         | Reported separately; maintainer must inspect CI for the subsequently authorized candidate SHA     |
| LOW           | Only pinned models/templates and host Docker Desktop certified          | Preserve qualified support matrix; other deployments remain operator validation                   |
| INFORMATIONAL | Docker unavailable now; paid cloud smoke/production rollback not run    | Retain actual T05 evidence; no fabricated current pass                                            |

No unresolved confirmed critical/high product defect was found after corrections.
The API moderate findings require separate triage, not an unreviewed Nest major
upgrade in this release audit. Existing full-local provider/backend/security/recovery
evidence is retained. No final remote green check is claimed. The maintainer should
review the exact scope, authorize a release-candidate commit separately, and obtain
its actual CI results before any tag/publication. Do not publish the baseline SHA.

## Version, documentation, artifacts and upgrade

`VERSION` and active product documentation say 1.3.1. Four private package/lock roots
remain 0.0.1 under documented independent version ownership; API version 1 and
`/api/v1` intentionally remain. No root/worker npm manifest or release-registry
automation exists. Historical snapshots were hash-checked unchanged.

All current guides exist and contain implementation-specific content: provider
interfaces/protocols, four combinations, profile switching, Qdrant compatibility,
local setup, pinned bundles, Docker networking, security/recovery and release notes.
Relative paths/anchors and package/lock roots were checked. Existing backfill and
reprocess commands were reviewed; no unsupported admin/reindex command is invented.

Upgrade/rollback guidance in [release notes](releases/v1.3.1.md) preserves original
files/SQL/old compatible profiles. Native enrollment must be paused/configuration
restored together on rollback; old vectors cannot be reinterpreted as new models.
There is no new down-migration or tested automatic production rollback promise.

Intended-file inspection found no generated fixture password, committed model
weights/bundles/wheels, real environment file, dump or user document. No file exceeds
1 MB. `.tools/`, `.env`, verification logs and built parser guard remain ignored.
Private generated test state and tokenizer/model caches are explicitly excluded.
This is a diff-focused hygiene check, not certification of all Git history.

## Proposed commit message

```text
chore(release): prepare Qyvra v1.3.1

Add native Ollama embeddings and structured Qwen-compatible RAG generation.
Preserve independent providers, profile isolation and durable checkpoints.
Document local models/tokenizers, private Docker connectivity and recovery.
Record pinned-pair local E2E, authorization and canonical citation evidence.
Patch Next.js to 16.3.8 and protect encrypted PDF fixture byte offsets.
Finalize candidate version, setup guides and release review.

Local checks pass within the documented scope; final-commit remote CI is pending.
```

Existing history uses short imperative subjects without an enforced convention;
the proposed Conventional Commit follows the task's suggested release subject.

## Proposed staging scope

Stage **only** the following exact paths after maintainer review. Do not use
`git add .`/`-A`; do not stage `.tools`, env files, caches, logs, model weights or
unchanged PDF files. Recheck the working tree before staging if other work arrives.
The inventory is a proposal, not an executed command.

```text
.env.example
.gitattributes
.github/workflows/phase-four.yml
CHANGELOG.md
README.md
VERSION
apps/api/package-lock.json
apps/api/package.json
apps/api/src/configuration/environment.spec.ts
apps/api/src/configuration/environment.ts
apps/api/src/configuration/local-provider-configuration.spec.ts
apps/api/src/configuration/settings.ts
apps/api/src/infrastructure/embeddings/embedding-provider.factory.ts
apps/api/src/infrastructure/embeddings/local-tokenizer.ts
apps/api/src/infrastructure/embeddings/ollama.provider.spec.ts
apps/api/src/infrastructure/embeddings/ollama.provider.ts
apps/api/src/infrastructure/generation/generation-provider.factory.ts
apps/api/src/infrastructure/generation/local-tokenizer.ts
apps/api/src/infrastructure/generation/ollama.provider.spec.ts
apps/api/src/infrastructure/generation/ollama.provider.ts
apps/api/src/infrastructure/worker/worker.module.ts
apps/api/src/modules/ai/embedding-provider.ts
apps/api/src/modules/ai/generation-provider.ts
apps/api/src/modules/ai/rag-answer.service.ts
apps/api/src/modules/ai/rag-context.ts
apps/api/src/modules/ai/rag.module.ts
apps/api/src/modules/search/search.module.ts
apps/api/test/embedding-generation.integration-spec.ts
apps/api/test/ollama-generation.fixture.ts
apps/api/test/ollama.fixture.ts
apps/web/package-lock.json
apps/web/package.json
docker-compose.local-ai.yml
docker-compose.ollama-host.yml
docker-compose.yml
docs/README.md
docs/api.md
docs/architecture.md
docs/compose.md
docs/database.md
docs/decisions/ADR-006-local-provider-compatibility.md
docs/decisions/README.md
docs/deployment/environment-variables.md
docs/developer/README.md
docs/developer/versions/v1.3.1.md
docs/development/conventions.md
docs/development/local-ai.md
docs/local-embeddings.md
docs/local-generation.md
docs/local-provider-configuration.md
docs/local-provider-release-candidate-review.md
docs/local-provider-release-preparation.md
docs/local-provider-verification.md
docs/releases/v1.3.1.md
docs/roadmap.md
infrastructure/docker/local-provider-config.test.cjs
infrastructure/e2e/local-ai-compose.yml
infrastructure/e2e/local-ai-run.cjs
infrastructure/e2e/local-ai-verify.cjs
infrastructure/e2e/local-infrastructure-verify.cjs
infrastructure/e2e/local-ollama-relay.cjs
infrastructure/e2e/local-tokenizer-reference.py
infrastructure/test/local-ai-test.Dockerfile
infrastructure/test/local-provider-network.compose.yml
infrastructure/test/pdf-fixture-integrity.test.cjs
```

## T08 commit and CI tracking

Recorded 13 October 2026. **COMMITTED — PUSH BLOCKED**. This section is an
uncommitted documentation-only tracking update; it is not part of the candidate
SHA below. No extra bookkeeping commit, amendment, tag, merge or deployment was made.

- Initial branch `v1.3.1`, HEAD `dec2c0f42421a90aa32d96c2799af5daec7ba8be`.
  The 65 reviewed paths exactly matched the effective working-tree changes:
  no extra/missing paths, unexpected deletions or unrelated work were staged.
- T07 CONDITIONALLY READY permits candidate preparation within its qualified
  model/deployment scope; it is not final publication approval. Existing successful
  build/type/lint/provider/UI/live-model evidence was reused without expensive reruns.
- `node .tools/v131-t07-validate.cjs` passed version/lock roots, 496 links,
  historical hashes and credential/artifact checks. `git diff --check` and
  `git diff --cached --check` passed. All staged bytes were checked against the
  recovered scope before the commit; no generated fixture password was present.
- Created exactly one commit:
  **`358edf95db481d57fbed0a7167abcf0b8b01a418`**,
  `chore(release): prepare Qyvra v1.3.1`, with the proposed body above.
  `git diff-tree --no-commit-id --name-only -r HEAD` matches all 65 proposed paths:
  7,184 insertions, 255 deletions. No corrective commit exists.
- Intended destination: `origin`, `https://github.com/Eqooid/qyvra.git`,
  existing `refs/heads/v1.3.1`, also the configured upstream. Read-only remote
  inspection finds the branch at the baseline SHA and not protected. Only this
  one candidate commit is ahead; normal fast-forward push is appropriate.
- Initial push waited for Git Credential Manager and was interrupted. Bounded
  noninteractive push, including the continuation retry, failed with:
  `could not read Username for 'https://github.com': terminal prompts disabled`.
  Local Git HTTPS authentication is unavailable. Read-only GitHub connector access
  does not supply credentials to local Git. No force push or protection bypass occurred.
- Remote branch still points to `dec2c0f42421a90aa32d96c2799af5daec7ba8be`.
  Exact-SHA GitHub Actions query returned **zero runs** for `358edf95...`.
  Workflow `Phase 4 verification` runs on push/PR/manual dispatch; no push means
  there is no new run ID, conclusion or job result. **CI NOT VERIFIED**, not CI passed
  or a failed test run. The historical baseline failure above remains separate.
- Before this tracking update, eight PDF status entries remained but raw bytes
  equal HEAD and `git diff --numstat` is empty; they were not included in the commit.
  This report is now the only actual content change left unstaged. No untracked
  release files remain; ignored local assets/logs are untouched.
- T05 native providers, tokenizer, worker, retrieval, citation and recovery evidence
  still applies: T08 changed no runtime behavior. T07's frontend security patch has
  separate production-build and 214-test evidence; no new live-browser claim is made.

The safe local portion is complete. **T08 is not fully complete:** Git push and
exact-candidate CI verification are blocked by missing local Git credentials.
Authenticate local Git for GitHub using the operator's approved credential flow,
then resume the normal `git push origin HEAD:refs/heads/v1.3.1` and inspect Actions
for the exact candidate SHA. Do not paste tokens into chat or commit credentials.
Keep this tracking edit unstaged or include it in a separately reviewed later
documentation change; do not silently amend the candidate merely for bookkeeping.
No tagging, release publication or deployment is authorized by this task.
