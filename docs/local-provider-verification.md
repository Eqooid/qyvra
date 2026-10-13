# v1.3.1 T05 — Local-provider verification and readiness

Date: 12 October 2026. Branch `v1.3.1`; existing uncommitted T01–T04 work retained.
T05 is verification/test hardening only, not T06 release finalization.

**Latest result:** T05 is complete with **CONDITIONALLY READY** status for the pinned
Nomic/Qwen pair below. Real local PDF-to-RAG, browser navigation and service recovery
have now passed. Earlier NOT READY matrices are retained checkpoint history; the
final model-preparation section supersedes their availability/readiness conclusions.

## Verification levels and environment safety

- **A:** deterministic clients, test HTTP servers and boundary doubles; no paid/model calls.
- **B:** real infrastructure. The existing isolated PostgreSQL 17 cluster on loopback
  port 55439 / `qyvra_v131_test` is available, verified as role `qyvra_test`. No database
  reset, migration rewrite or production target. SQL fixtures use generated owners/IDs.
  Vector-store doubles used with SQL are explicitly not real Qdrant.
- **C:** installed Ollama embeddings/chat with actual model identities. No configured
  native endpoints/bundles/models are available; NOT VERIFIED. No model download.

Docker Desktop Linux engine is unavailable (`dockerDesktopLinuxEngine` pipe missing).
Consequently volumes, running containers and Qdrant collections cannot be inspected,
and live Docker/Qdrant/RabbitMQ/Redis tests are blocked. No unknown environment is
used, no volumes are destroyed and no application services are deployed.

API/worker type/lint/build, configuration, all four factories and Compose/security
checks passed in [T04](local-provider-configuration.md); evidence is retained in its
ledger and `.tools/v131-t04-*.log`. These are not blindly rerun unless changed.
[T03](local-generation.md) records strict RAG validation and SQL checkpoint evidence.
Historical v1.3.0/T12 results are context, not evidence of current live-model success.

## Checkpoint matrix — assessed before remaining checks

This is the retained initial assessment, not the final status. Use the final
matrix and release gate below for completed results.

| Requirement                                       | Existing coverage/evidence                                      | Missing coverage and method                                                  | Current result                          |
| ------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------- |
| API/worker static build                           | T04 build/type/lint logs                                        | Rerun affected checks if tests/code change                                   | PASS before T05                         |
| Frontend build/type/lint                          | Existing web scripts; not run in T04                            | Run web static checks                                                        | Pending                                 |
| Four provider combinations                        | T03 real factories, T04 shared configuration                    | Live API/worker boot needs Docker                                            | A PASS; B BLOCKED                       |
| Embedding validation/errors                       | Native 31 and cloud adapter tests                               | Retain unaffected T04 evidence                                               | A PASS                                  |
| Profile/revision/dimension isolation              | T02 fingerprint/checkpoint tests, T04 configuration             | SQL regression/profile transitions                                           | Pending B SQL                           |
| Query/index compatibility                         | Semantic service and vector adapter tests                       | Run targeted guards/security tests                                           | Pending A                               |
| Structured generation/citations                   | Native 44, existing RAG parser/service suites                   | Run combined security regression                                             | A prior PASS; remaining Pending         |
| Insufficient evidence                             | RAG/context/native tests                                        | Frontend and current combined tests                                          | Pending A                               |
| Owner isolation/poisoned payloads                 | Existing retrieval tests; real Qdrant suite gated               | Extend real SQL/native-double scenarios                                      | Pending SQL; real Qdrant BLOCKED        |
| Tenant isolation                                  | Current schema uses user ownership, no separate tenant entity   | Verify user boundaries; don't invent tenants                                 | Separate tenants NOT APPLICABLE         |
| Injection/schema/reasoning                        | System/context/parser/native generation tests                   | Current deterministic regression; real-model resistance                      | A prior PASS; C NOT VERIFIED            |
| Outage/partial embedding resume                   | T03 SQL/native HTTP doubles                                     | Native SQL checkpoint regression                                             | Pending B SQL                           |
| Worker claim/crash/outbox/retry                   | Existing message handler/recovery and SQL suites                | Focused unit/SQL verification                                                | Pending A/B SQL                         |
| Qdrant partial upload/activation/rebuild          | Vector handler/adapter tests; real service suite                | Native SQL + derived-store loss test; actual service needs Docker            | Pending A/SQL; real Qdrant BLOCKED      |
| Redis disposable progress                         | Existing progress-store tests                                   | Unit failure regression; actual Redis outage                                 | Pending A; real Redis BLOCKED           |
| Lifecycle/reprocess/restore/backfill              | Existing SQL/real-index suites                                  | SQL ingestion/checkpoint tests; live serving lifecycle requires Qdrant       | Pending SQL; live BLOCKED               |
| Model switching                                   | Profile fingerprints, serving mismatch, generation independence | Existing SQL/model tests                                                     | Pending SQL                             |
| Host/container/LAN networking                     | T04 Compose topology/config, isolated network fixture           | No Docker engine or live endpoint                                            | Config PASS; live BLOCKED               |
| Operator endpoints/secrets/Nginx                  | T04 9 Compose/security checks and web source review             | Frontend artifact/source review                                              | Prior PASS; remaining Pending           |
| Frontend search/Q&A/citations/errors              | `ai.integration`, `ai-client`, `ai-source-range`                | Run focused Vitest; browser fixture requires Docker                          | Pending A; browser BLOCKED              |
| Full upload → PDF → vectors → answer → navigation | Existing v1.3.0 real-service/browser E2E                        | Native service/model environment required                                    | B BLOCKED; C NOT VERIFIED               |
| Cost/resource bounds                              | Batch/context/timeout/checkpoint counters                       | Inspect tests; cold-start/model memory needs real inference                  | A/inspection; C NOT VERIFIED            |
| CI                                                | Phase-four workflow inspected                                   | Add existing model-free Compose/security check; remote workflow not executed | Local checks Pending; remote CI NOT RUN |

Results and final readiness are recorded below after focused verification. No
deterministic result will be described as real Ollama/Qwen inference.

## Final matrix — actual T05 evidence

| Area                                         | Level/status                               | Evidence and practical boundary                                                                                                                                                                      |
| -------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API/worker builds                            | PASS, retained                             | T04 `npm.cmd run build`; production source unchanged in T05. Both entry points compiled                                                                                                              |
| Dependency consistency                       | PASS                                       | API/web `npm.cmd ls --omit=dev --depth=0 --json`, no reinstall                                                                                                                                       |
| API type/lint                                | PASS                                       | `tsc --noEmit --incremental false`, `npm.cmd run lint` after enhanced tests                                                                                                                          |
| Frontend build/type/lint                     | PASS                                       | Existing Next production build/typecheck/lint; initial sandbox Google Fonts fetch failed, network-enabled retry passed without source changes                                                        |
| Provider configuration and four combinations | A PASS, retained                           | T04 113 configuration cases and T03 real factory matrix; operation keys/models/endpoints independent; actual four-mode container startup BLOCKED                                                     |
| Native/cloud embedding validation            | A PASS, retained                           | T04 native HTTP tests (31) and cloud embedding tests; vectors/count/order/dimensions/model/digest/timeout failures validated                                                                         |
| Embedding identity/switching                 | A/SQL PASS                                 | Existing fingerprint/model/revision/preprocessing tests, SQL incompatible-profile/checkpoint/reprocessing tests; generation changes leave embedding identity unchanged                               |
| Query/profile/index compatibility            | A/SQL PASS                                 | Current semantic-service/adapter tests; SQL serving-fingerprint mismatch returns 503; inactive/stale/foreign references cannot hydrate                                                               |
| Structured native generation                 | A PASS, retained                           | T04 native 44 cases, unchanged canonical output/parser/errors/thinking isolation; real Qwen schema compliance NOT VERIFIED                                                                           |
| Citations and insufficient evidence          | A/SQL PASS                                 | Current RAG/context tests; model identifiers resolve only from supplied authorized sources; no-evidence/stale/archive paths skip generation                                                          |
| Source navigation authorization              | A/SQL PASS                                 | Citation-source service tests plus actual PostgreSQL owned resolution, foreign-source 404 and archive revocation in both generation variants                                                         |
| User isolation and hostile vector payloads   | A/SQL PASS                                 | Two users have native checkpoints and READY SQL maps. Forged foreign manifest and invalid chunk/document/version/set/manifest tuples are dropped by real SQL hydration; citations remain owned       |
| Separate tenant isolation                    | NOT APPLICABLE                             | Current schema authorizes stable user IDs; no separate tenant entity/tenant boundary exists to test. No tenant feature invented                                                                      |
| Prompt injection/secrets                     | A PASS                                     | Existing system/user/untrusted evidence separation, strict identifiers/metadata, sanitized provider errors/log assertions. Actual model resistance remains C NOT VERIFIED                            |
| Native outage/checkpoint recovery            | A/SQL PASS                                 | Native HTTP batch outage after persisted work; durable retry embeds missing chunks only; invalid/partial batches never complete checkpoints                                                          |
| Worker crash/duplicate/outbox                | A/SQL PASS; broker BLOCKED                 | Shared handler/recovery/lease and real SQL dispatch/recovery/duplicates pass; no actual RabbitMQ delivery/restart test claimed                                                                       |
| Partial vector indexing/activation           | A/SQL PASS                                 | New native SQL case interrupts after remote-double write, persists RETRYING and non-READY replacement, preserves old serving pointer, retries and activates complete replacement                     |
| Derived-store loss/rebuild                   | SQL + double PASS; real Qdrant BLOCKED     | Clear only test owner's in-memory points, rebuild from SQL embeddings, assert zero new document-embedding calls, resume search/RAG/canonical citations. This is not a Qdrant collection-loss test    |
| Redis disposable progress                    | A PASS; live BLOCKED                       | Current absent/refused Redis test degrades to missing progress; real TTL/progress integration skipped without Redis                                                                                  |
| Lifecycle/backfill                           | A/SQL PASS; full serving lifecycle BLOCKED | Ingestion/reprocess/current-version/restore/backfill SQL suites pass; new archive fence excludes stale points and source links. Real Qdrant cleanup/purge/new-version/browser workflows not executed |
| Authentication and processing status         | B SQL/HTTP PASS                            | Existing login and owned processing-status Nest HTTP integration suites use isolated PostgreSQL                                                                                                      |
| Compose/privacy/network topology             | A PASS                                     | 9 synthetic configuration/security tests, isolated fixture syntax validated; live mock-network check skipped because engine is unavailable                                                           |
| Host/container/LAN/remote TLS connectivity   | BLOCKED / NOT RUN                          | No engine/configured inference target. Alias/listener/firewall/actual application container networking not verified                                                                                  |
| Frontend API/UI/source/error states          | A PASS                                     | 12 focused Vitest/jsdom tests; full Playwright browser workflow BLOCKED                                                                                                                              |
| Next client secrets                          | PASS, artifact inspection                  | 35 generated static artifacts inspected: no server-only provider configuration markers or configured key values found. Keys/URLs not forwarded to web/Nginx                                          |
| Full PDF upload-to-answer E2E                | B BLOCKED; C NOT VERIFIED                  | SQL native fixture establishes extraction prerequisites with canonical text; it is not a real PDF-upload/extraction or browser E2E                                                                   |
| Resource/cost safety                         | A/inspection PASS; C NOT VERIFIED          | Batches, tokens, deadline/lease limits and checkpoint call counts bounded; no paid calls. No CPU/GPU cold-start, memory-pressure or throughput guarantees measured                                   |
| OpenAI compatibility                         | A/SQL PASS                                 | Retained cloud adapter/config tests and new SQL native-embedding/cloud-generation variant; no paid API smoke test                                                                                    |
| CI integration                               | Local check PASS; remote CI NOT RUN        | Added existing model-free Compose/security test to Phase-four workflow; no workflow push/dispatch or remote green-run claim                                                                          |
| Installed models and real local inference    | C NOT VERIFIED                             | No real model names/digests certified or used. `fixture:latest` and synthetic digest/tokenizers are test doubles, not installed Qwen/embedding models                                                |

## Commands and results

All API commands run from `apps/api`, frontend commands from `apps/web`, infrastructure
checks from repository root. Logs are ignored local evidence, not published secrets.

| Command/suite                                                                                                         | Result                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| API Jest targeted semantic/RAG/vector/message/recovery/progress filter                                                | 89 passed, 9 suites; 1 real Redis test skipped                                                               |
| API Jest `citation-source.service.spec`                                                                               | 2 passed                                                                                                     |
| API integration Jest: `embedding-generation`, `ai-ingestion`, `ai-processing`, `outbox`, `processing-status`, `login` | 39 passed, 6 suites; 4 live-service cases skipped                                                            |
| Final enhanced native SQL matrix, `--testNamePattern 'resumes native Ollama checkpoints'`                             | Both generation variants passed; other 16 cases not rerun                                                    |
| Web Vitest `tests/ai.integration.test.tsx tests/ai-source-range.test.tsx tests/ai-client.test.ts --maxWorkers=1`      | 12 passed, 3 files                                                                                           |
| `node --test infrastructure/docker/local-provider-config.test.cjs`                                                    | 9 passed; live container network probe skipped                                                               |
| API/web `npm.cmd ls --omit=dev --depth=0 --json`                                                                      | Passed; manifests/installed direct dependency trees consistent                                               |
| API `tsc --noEmit --incremental false`, API/web `npm.cmd run lint`, web `npm.cmd run typecheck`                       | Passed                                                                                                       |
| Web `npm.cmd run build`                                                                                               | Initial restricted-network font fetch failed; network-enabled retry passed. No font/UI implementation change |
| Compiled static artifact inspection                                                                                   | 35 artifacts; zero unsafe provider configuration markers/key-value matches                                   |

The four SQL skips are real RabbitMQ outbox delivery, real RabbitMQ embedding
redelivery, real Redis processing-status progress, and the real-Qdrant ingestion
lifecycle case. Actual Qdrant indexing/recovery, semantic/RAG service E2E and
Playwright suites are not started without required services. The gated real Redis
unit case and isolated Docker network test also remain unexecuted. Do not count
filtered-out cases in the final two-case SQL rerun as newly verified.

Across T05 runs: **91 focused API unit tests**, **39 distinct SQL integration tests**,
**12 frontend tests** and **9 Compose/security checks** passed; repeated cases are
counted once. Prior T04 provider/config/build evidence is reported separately, not
added to these counts. API production build and clean migration chain were not
repeated because no production/migration change occurred. T05 reran type/lint for
the test changes. No unexecuted suite is labeled passed.

## Test hardening, files and observations

Created `docs/local-provider-verification.md`. Modified the existing
`apps/api/test/embedding-generation.integration-spec.ts` to cover two complete SQL
owner scopes, malicious candidate tuples, actual citation-source authorization,
partial-index retry, stored-vector-only rebuild and archive fencing with both
generation protocols. Canonical extraction and vectors/providers remain explicit
fixtures/doubles; deterministic generation now returns a fact present in the cited
canonical excerpt, rather than an unrelated fixed phrase.

Modified `.github/workflows/phase-four.yml` to run the existing model-free Compose
check. Updated current documentation index/roadmap/v1.3.1 guide to link this evidence;
historical release documents and the v1.0.0 developer body are preserved. No
production logic, provider interface, database schema, model profile serialization,
frontend feature, model asset or dependency changed in T05.

The first new archive fixture supplied only `isArchived`; PostgreSQL correctly
rejected it under the existing status/archive constraint. Corrected test setup to
include `status: ARCHIVED`, preserving the database invariant. No observed production
defect was found and no assertion/schema was weakened. The font build failure was
an environment network restriction, resolved by a permitted normal build retry.

The expanded six-suite SQL run took about 69 seconds; the final two-case run about
21 seconds including TypeScript/test startup. These measure harness/database work,
not model throughput; there is no universal local-model latency/resource guarantee.
Server-side citation/schema validation cannot prove every factual statement or
universal model-level injection resistance. Semantic quality, Qwen thinking/template
and tokenizer parity require actual installed-model assessment; never weaken current
validation to make a model appear compatible.

## Release gate and recommended next step

**Final readiness: NOT READY.** Required live infrastructure security/recovery and
full local document-to-answer/browser acceptance remain unverified. This is an
evidence gap, not a claim that Ollama is incompatible or a claim of a failing
production implementation.

- **Code compatibility:** deterministic and real-PostgreSQL subset verified;
  full service/container compatibility only partially verified.
- **Real Ollama compatibility:** PARTIAL; the continuation below exercises installed
  Qwen with the canonical prompt/parser. Native adapter certification and embeddings
  remain NOT VERIFIED.
- **End-to-end local RAG:** NOT VERIFIED; no real PDF-to-Qwen-to-browser workflow.

Blocking verification: unavailable Docker Linux engine; no isolated real RabbitMQ,
Redis or Qdrant endpoints; no configured certified embedding/chat models/bundles.
Host/LAN/GPU-specific checks may remain deployment-specific, but real service
authorization/index recovery and required live local RAG cannot be silently waived.
There are no unresolved observed production-code defects from executed checks.

Finish T05 in an available isolated environment: run the prepared network and
existing real-service suites, then certify the selected installed model/digest,
tokenizer/framing and real document/search/answer/source flow. Record exact model
identities and results without model downloads/private documents/paid calls.
Only after those gates should T06 release documentation be finalized. T05 reporting
and available checks are complete; acceptance is **not fully complete**. No commit,
tag, push, deploy, release or T06 work occurred.

## T05 continuation — live checkpoint inspection

The previous matrices above retain the original execution's evidence. This section
updates live status after continuation on 12 October 2026; it does not turn prior
mock/SQL results into live-model results. Existing passing suites were not rerun.
Branch remains `v1.3.1`; staged diff is empty and existing T01–T05 changes are retained.

### Infrastructure and model discovery

- Elevated `docker version --format '{{.Server.Version}}'` and `docker ps` still
  fail because `dockerDesktopLinuxEngine` is missing. No volumes, running containers
  or collections could be inspected; no service was recreated or data deleted.
- Loopback TCP checks find listeners on 5432 and 5672, but their database/broker
  identities and environment are unknown. They were not used or changed. The isolated
  PostgreSQL test port 55439 remains stopped. Ports 6379, 6333, 3000, 3001, 80 and
  443 refuse connections; this only checks these local ports, not every remote service.
- Host Ollama responds at `http://127.0.0.1:11434`. GET `/api/version` reports
  **0.40.3**. GET `/api/tags` lists only **`qwen3:0.6b`**, digest
  `7df6b6e09427a769808717c0a93cadc4ae99ed4eb8bf5ca557c90846becea435`.
  POST `/api/show` reports capabilities `completion`, `tools`, `thinking`,
  Q4_K_M quantization and model context length 40960.
- No embedding-capable model is advertised. The model's internal
  `qwen3.embedding_length: 1024` is not certification of embedding endpoint support
  or an expected Qyvra vector dimension. No embedding call was attempted with a chat model.
- Redacted configuration inspection finds no configured native endpoints or tokenizer
  bundle paths in root `.env`, no `apps/api/.env`, and no relevant shell overrides.
  No real credentials or private configuration values were printed.

### Real Qwen probe — partial evidence, not application E2E

Two bounded synthetic probe batches used native POST `/api/chat`, `stream:false`,
`think:false`, `truncate:false`, `shift:false`, the actual `RAG_OUTPUT_SCHEMA`,
temperature 0, context 4096, output cap 256 and a 60-second deadline per request.
No OpenAI requests, model downloads, persisted embeddings or application document
changes occurred. Provider URLs were not added to persistent configuration.

The first exploratory batch used a simplified synthetic prompt. All three outputs
passed strict schema validation but returned insufficient evidence, including the
answerable question. This establishes neither grounding success nor adapter failure.
The follow-up deliberately used Qyvra's **actual `buildRagContext` and
`validateRagOutput`** with synthetic provenance to assess the canonical prompt.

| Canonical real-model case                | Observed result                                                    | Duration / output tokens |
| ---------------------------------------- | ------------------------------------------------------------------ | ------------------------ |
| Known launch-code fact                   | PASS: answered, contains `ORBIT-731`, only supplied `S1` reference | 723 ms / 47              |
| Unanswerable ocean-depth question        | PASS: `insufficient_evidence`, empty claims/citations              | 317 ms / 18              |
| Document instruction to fabricate `S999` | PASS for this input: answers known fact using only `S1`            | 466 ms / 47              |

All three canonical responses report HTTP 200, `done:true`, `done_reason:stop`,
no separate thinking output and bounded output counts. The real server returned
prompt counts 193, 196 and 205. These were recorded, **not certified against a local
model tokenizer**. Direct fetch bypasses the production adapter's digest/tokenizer
parity checks; no missing certification was bypassed inside the application.
Canonical source objects in this probe are fixtures, not PostgreSQL-authorized
documents. Thus no claim of live authorization/navigation or full RAG E2E follows.
One adversarial sample is not proof of comprehensive prompt-injection resistance.

Local artifacts: `.tools/v131-t05-continuation-live-probe.json` (exploratory batch)
and `.tools/v131-t05-continuation-canonical-probe.json` (canonical batch). These
contain bounded operational results, not credentials or private documents. Probe
commands used the already-installed `ts-node/register/transpile-only`, actual schema,
context builder/parser and existing `rag-source.fixture`; no dependency install.

### Continuation verification gate

| Remaining requirement                        | Status and exact reason                                                                      |
| -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Previous automated/SQL checks                | PASS retained; logs inspected, unchanged behavior not rerun                                  |
| Host Ollama connectivity / installed Qwen    | PASS, real catalog and inference                                                             |
| Canonical prompt/schema/citation-token probe | PASS for three synthetic inputs; adapter remains uncertified                                 |
| Real embedding smoke test                    | BLOCKED: no installed embedding-capable model, native profile or certified bundle            |
| API/worker-to-Ollama connectivity            | BLOCKED: Docker engine unavailable; no configured application endpoint/bundles               |
| Full-local PDF-to-index-to-Qwen workflow     | BLOCKED: embedding model/assets and isolated infrastructure unavailable                      |
| Live authorization and citation navigation   | NOT RUN; prior SQL authorization tests remain PASS                                           |
| Live provider outage/checkpoint recovery     | NOT RUN; shared host Ollama not stopped; prior deterministic/SQL evidence retained           |
| Actual Qdrant recovery/rebuild               | BLOCKED: no isolated identified Qdrant service; prior derived-store-double evidence retained |
| Model switching                              | Prior deterministic/SQL PASS retained; live transition NOT RUN                               |
| Nginx/browser full workflow                  | BLOCKED: application stack not running                                                       |

Only this existing report was modified during continuation. No production defect was
demonstrated, so no production code, configuration, migration or test was changed.
Final diff whitespace validation passed. Final readiness remains **NOT READY** and
**T05 is not fully complete**.

Next action: start Docker Desktop, provide an already-installed embedding-capable
model and operator-certified embedding/generation tokenizer bundles, then use an
isolated test project for real services and the PDF-to-RAG/browser workflow. Do not
use unidentified existing listeners as test infrastructure. No model download,
destructive cleanup, automatic commit/tag/push/deploy/release or T06 work is authorized
by this continuation. Resume only the blocked checks once prerequisites are available.

### Docker-start follow-up — latest infrastructure status

After the operator started Docker Desktop, the engine is reachable (**27.4.0**).
`docker ps` reports healthy existing Qyvra API, worker, web, Nginx, PostgreSQL,
RabbitMQ, Redis and Qdrant containers; outbox is running. Nginx publishes only
loopback port 8080. Volume names were inspected without deleting or changing them.
These startup/health observations supersede the earlier engine-unavailable status;
they are not evidence that all recovery/service acceptance suites passed.

Read-only GET `/api/tags` from **both actual API and worker containers**, using
`host.docker.internal:11434`, returns HTTP 200 and `qwen3:0.6b`. This verifies host
alias reachability from both runtimes. Redacted runtime inspection shows embedding
and RAG disabled, generation selection `openai-compatible` with no configured model,
no native endpoints and no tokenizer bundles. No persistent runtime setting changed.

The previously skipped isolated network test exposed a test-harness compatibility
issue: installed Compose rejects `run --pull never`. The first live run had nine
passes and one failure. A separate isolated reproduction confirmed `unknown flag:
--pull`. Fixed only the test fixture/harness: `pull_policy: never` on mock/probe
services (inherited by worker), removed unsupported `run` flags and asserted the
policy for every resolved service. Cached-image gating and `up --pull never` remain.
No images were downloaded and only generated temporary test projects were removed.

Affected command `node --test infrastructure/docker/local-provider-config.test.cjs`
now reports **10 passed, zero failures/skips**, including actual isolated-container
networking. Changes: `infrastructure/test/local-provider-network.compose.yml`,
`infrastructure/docker/local-provider-config.test.cjs`, and this report. Production
provider code is unchanged. Unaffected earlier test results were not rerun.

Docker startup and API/worker host connectivity are now **PASS**. Real embeddings,
native adapter certification, full-local PDF-to-RAG/browser and live recovery remain
unverified: no embedding-capable model or certified bundles are available, and the
running application is AI-disabled. **NOT READY; T05 not fully complete.** The next
prerequisite is operator provisioning/authorization of an embedding model and
certified tokenizer bundles, then isolated real-service/application verification.

## Final continuation — model preparation and real local acceptance

The operator explicitly authorized necessary model/tokenizer preparation in this
continuation. Existing passing T01–T05 evidence was retained. No app configuration,
business logic, schema, authorization or citation validation was weakened.

### Resources and artifacts

Windows x64; Ryzen 5 5600H / 12 logical processors; approximately 16 GB RAM with
1.9 GB initially free; detected RTX 3050 Ti laptop GPU / approximately 4 GB VRAM
and integrated Radeon graphics. Disk preflight found approximately 21 GB free.
The modest models fit; no additional generation model, driver, firewall or privileged
system installation was needed. There is no hardware-wide performance guarantee.

| Component                     | Exact prepared identity                                                                                   |
| ----------------------------- | --------------------------------------------------------------------------------------------------------- |
| Ollama                        | `0.40.3`, existing host service                                                                           |
| Embedding                     | `nomic-embed-text:v1.5`, downloaded once; 274,302,450 bytes; advertised `embedding` capability            |
| Embedding digest              | `0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f`                                        |
| Embedding vectors             | Observed 768 finite components; native `/api/embed`, no dimension padding/truncation                      |
| Generation                    | Existing `qwen3:0.6b`, 522,653,767 bytes; no generation-model download                                    |
| Generation digest             | `7df6b6e09427a769808717c0a93cadc4ae99ed4eb8bf5ca557c90846becea435`                                        |
| Runtime tokenizer             | Existing `@huggingface/tokenizers` `0.2.0`, data-only JSON loading                                        |
| Reference tokenizer           | `tokenizers==0.22.1`, 2.7 MB wheel installed only into ignored `.tools/v131-reference`, not system Python |
| Nomic upstream revision       | `nomic-ai/nomic-embed-text-v1.5` at `e9b6763023c676ca8431644204f50c2b100d9aab`                            |
| Qwen upstream revision        | `Qwen/Qwen3-0.6B` at `c1899de289a04d12100db370d81485cdf75e47ca`                                           |
| Embedding bundle SHA-256      | `572ea76f7a75cfd6afcdc2a0bb759b2018490f4823303529ddcd6a14e73f57ba`                                        |
| Generation bundle SHA-256     | `e8dc4542a4ef7dc43a93519443e67b1e13a0f5a67c870b80793e568933093f73`                                        |
| Embedding profile fingerprint | `d974061c6457904b1bc92abd1ec496798cb8d39d2939383621f6d8a624d7cf92`                                        |

Sources: [Ollama Nomic catalog](https://ollama.com/library/nomic-embed-text),
[pinned Nomic data](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/tree/e9b6763023c676ca8431644204f50c2b100d9aab),
[pinned Qwen data](https://huggingface.co/Qwen/Qwen3-0.6B/tree/c1899de289a04d12100db370d81485cdf75e47ca).
Only `tokenizer.json` and `tokenizer_config.json` were retrieved for each model;
approximately 12.15 MB total. No upstream Python/Jinja/Go code was executed.
`upstream-manifest.json` records byte counts, revision URLs and per-file SHA-256:

| Artifact               | SHA-256                                                            |
| ---------------------- | ------------------------------------------------------------------ |
| Nomic tokenizer JSON   | `d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66` |
| Nomic tokenizer config | `d7e0000bcc80134debd2222220427e6bf5fa20a669f40a0d0d1409cc18e0a9bc` |
| Qwen tokenizer JSON    | `aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4` |
| Qwen tokenizer config  | `d5d09f07b48c3086c508b30d1c9114bd1189145b74e982a265350c923acd8101` |

### Bundle certification and isolated configuration

No cached tokenizer was present. The reference helper generates ASCII, Unicode,
empty, long, document/query and rendered-prompt token IDs using the independently
installed Rust reference tokenizer. Qyvra's JS loaders matched those IDs. Nomic
adds CLS/SEP; query/document instructions are exact prefixes `search_query: ` /
`search_document: ` under `qyvra-embedding-prefix/v1`. The native two-input embedding
response reports **27 tokens**, matching the local count; both vectors have 768
dimensions. Qwen's observed installed template is represented by restricted literal
system/user framing, including ` /no_think` and the empty thinking prefill. The
reference prompt reports **31 tokens** both locally and in real Ollama inference.
Every subsequent actual generation adapter call still enforces exact prompt-count
and digest checks; no approximate OpenAI counter substitutes for Qwen.

The actual Qyvra factories passed document/query batch embeddings and grounded /
insufficient-evidence generation. Real-asset initialization, Unicode/empty/long
parity, missing/corrupt assets, offline loading, token-over-budget context exclusion
and pre-network oversized embedding rejection passed. The initial oversized context
probe also hit the separate 65,536-character guard; a smaller over-token-budget
fixture then exercised the intended token-budget check.

Assets reside in ignored `.tools/v131-local-assets`; API/worker bind them read-only
at `/run/qyvra-ai`. No model weights, wheel or tokenizer caches enter Git or images.
Only the test environment uses the new SQL profile. Original Qyvra configuration
and OpenAI checkpoints/indexes remain untouched.

Important test settings, using existing variables:

```dotenv
AI_INGESTION_ENABLED=true
AI_INGESTION_PROFILE_FINGERPRINT=d974061c6457904b1bc92abd1ec496798cb8d39d2939383621f6d8a624d7cf92
EMBEDDING_ENABLED=true
EMBEDDING_PROFILE_FINGERPRINT=d974061c6457904b1bc92abd1ec496798cb8d39d2939383621f6d8a624d7cf92
EMBEDDING_ENDPOINT=http://local-provider-relay:11434/api/embed
EMBEDDING_ALLOW_HTTP=true
EMBEDDING_API_KEY=
EMBEDDING_TOKENIZER_PATH=/run/qyvra-ai/nomic-bundle.json
EMBEDDING_SEND_DIMENSIONS=false
EMBEDDING_BATCH_SIZE=1
EMBEDDING_MAX_INPUT_TOKENS=2048
EMBEDDING_MAX_BATCH_TOKENS=4096
EMBEDDING_TIMEOUT_MS=60000
VECTOR_INDEX_ENABLED=true
SEMANTIC_SEARCH_ENABLED=true
SEMANTIC_SEARCH_MIN_SCORE=0.6738321733808521
RAG_ENABLED=true
RAG_CONTEXT_TOKENS=4096
RAG_TIMEOUT_MS=120000
GENERATION_PROVIDER=ollama
GENERATION_MODEL=qwen3:0.6b
GENERATION_ENDPOINT=http://local-provider-relay:11434/api/chat
GENERATION_ALLOW_HTTP=true
GENERATION_API_KEY=
GENERATION_TOKENIZER=huggingface-json
GENERATION_TOKENIZER_PATH=/run/qyvra-ai/qwen-bundle.json
GENERATION_THINK=false
GENERATION_TIMEOUT_MS=60000
GENERATION_MAX_OUTPUT_TOKENS=256
```

The score threshold is **synthetic-fixture calibration only**, scoped to the pinned
fingerprint. Real vectors separated positive examples (at least 0.836) from an
unrelated query (at most 0.512). It is not recommended as a production default.
Initial isolated startup correctly rejected missing calibration; the measured
test value resolved it without changing startup validation. Embedding identity is
in SQL, not redundant model/provider environment variables. Generation changes
do not alter that profile. Native inference timeouts remain below worker leases.

### Real PDF-to-RAG and security/recovery evidence

Project `qyvra-e2e-ai-v131-e12d4fa9` used new project-owned volumes and a private,
unpublished relay that forwards only `/api/tags`, `/api/embed`, `/api/chat` to the
existing host Ollama. It never returns fabricated vectors/answers. Counters contain
no document text or credentials. Native profile selection, runtime factory routing,
empty cloud keys and observed native requests establish the local inference path;
no OpenAI request was made. The separate test stack exposes Nginx at loopback 18081
and infrastructure test ports only on loopback; no browser/Nginx Ollama route.

| Gate                                    | Result                                                                                                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runtime preparation and actual adapters | PASS — pinned assets load in host development, API and worker containers                                                                                           |
| Multi-page PDF upload                   | PASS — real authenticated multipart API through Nginx; synthetic PDF generated with valid xref offsets                                                             |
| Durable pipeline                        | PASS — verification, extraction, chunking, embedding and indexing jobs all COMPLETED; four chunks/checkpoints; complete READY mapping                              |
| Partial embedding outage                | PASS — controlled relay 503 after one valid checkpoint; SQL RETRYING observed with 1/4; second attempt retains it and generates only missing vectors               |
| Retrieval / known facts                 | PASS — Meridian Harbor, 24 crates and combined question; query profile compatible; canonical version/page metadata, including truthful page-spanning chunk         |
| Citations                               | PASS — returned tokens resolve to owned SQL document/version/chunk; actual source API returns 200                                                                  |
| User isolation                          | PASS — second authenticated identity gets no private results/evidence and source 404                                                                               |
| Separate tenant boundary                | NOT APPLICABLE — existing model is user ownership                                                                                                                  |
| Insufficient evidence                   | PASS — unsupported ocean-depth question returns no answer/citations; no general-knowledge fabrication                                                              |
| Adversarial document                    | PASS fail-closed — tiny Qwen returns an invalid response for the injected page; server returns 502 `AI_OUTPUT_INVALID`, no trusted fabricated citation             |
| Generation outage                       | PASS — isolated relay returns 503; RAG safely fails, document API remains accessible; shared Ollama never stopped                                                  |
| Real Qdrant loss/rebuild                | PASS — delete only the isolated profile collection; request owned index rebuild; wait for replacement READY; embedding-call count unchanged; search/RAG work again |
| Browser                                 | PASS — actual Next UI through Nginx, real Qwen answer, citation dialog and exact source navigation                                                                 |
| Archive fence                           | PASS — archived document excluded from search and source lookup returns 404                                                                                        |

The rebuild test initially waited on generic readiness, which intentionally remains
READY while an old generation serves during replacement. Corrected the fixture to
wait for a **different READY generation**, not by editing persisted completion state.
The browser test initially used an ambiguous button selector; scoped mode selection
to the Search mode group and submission to the form. Only the missing browser/
archive checks were rerun after API/recovery passed. No UI implementation changed.

### Previously blocked infrastructure suites

Real PostgreSQL, Qdrant, RabbitMQ and Redis ran on isolated Docker networks. A
second disposable SQL database, `qyvra_v131_test`, passed all 15 unchanged migrations.
Each broker suite used a fresh temporary vhost, removed afterward; no shared queue
purge. Linux test containers use cached dependencies and the verified PDF guard.
Providers in these regression suites remain deterministic doubles; they prove real
service behavior, whereas the workflow above separately proves real model inference.

| Suite                                 | Newly verified cases                                                                                                                                                                      |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vector-indexing.integration-spec.ts` | 13 PASS: actual Qdrant upserts/activation, duplicate delivery, partial writes, crash leases, lost collection, no-reembedding rebuild, scoped cleanup, archive/restore/new version, outage |
| `semantic-search.integration-spec.ts` | 9 PASS: actual PDF/SQL/Qdrant, ownership/provenance, stale/hostile payloads, profile mismatch, lifecycle and sanitized failures                                                           |
| `rag-answer.integration-spec.ts`      | 10 PASS: real PDF/SQL/Qdrant evidence, authorization, citation validation, invalid/malicious outputs and bounded context                                                                  |
| Outbox real broker delivery           | 1 PASS; unaffected three cases intentionally filtered                                                                                                                                     |
| Embedding real RabbitMQ duplicate     | 1 PASS; unaffected seventeen cases intentionally filtered                                                                                                                                 |
| Processing status real Redis          | 1 PASS: progress loss and SQL completion authority; seven cases filtered                                                                                                                  |
| Real ingestion lifecycle              | 1 PASS: legacy PDF backfill, activation, archive/restore reuse, reindex/replacement/cleanup, new version and soft delete/restore; five cases filtered                                     |

**36 newly verified real-service cases** across seven suites. The two optional
inside-test final-runtime cloud-compatible subprocess cases remain skipped because
the test image has no Docker CLI. Actual final-runtime native API/worker and browser
behavior was verified separately above; retained cloud tests cover the unchanged
OpenAI adapters. Do not count filtered/skipped cases as new passes.

### Verified blockers fixed and files

A real cross-platform fixture defect was reproduced: Windows Git text conversion
changed `single.pdf` to 622 bytes / 32 CRLF sequences, while its committed 590-byte
PDF uses byte offsets for LF. Container qpdf correctly reported `xref not found`;
upload correctly rejected it. Restored only previously unchanged PDF fixtures to
their exact committed bytes and added `*.pdf binary` to `.gitattributes`.
Seven regression checks validate the attribute and actual fixture xref pointers.
No PDF validation was relaxed. The first semantic suite failure is retained in
logs; after the byte fix all nine cases passed. Temporary assertion diagnostics
were removed. The earlier Compose `run --pull` compatibility fix remains preserved.

New committed-intent tooling (no assets/weights):

- `infrastructure/e2e/local-tokenizer-reference.py`: independent pinned reference bundle generation, no downloads/template code execution.
- `infrastructure/e2e/local-ai-compose.yml` and `local-ai-run.cjs`: explicit isolated stack, SQL profile and server-only configuration.
- `infrastructure/e2e/local-ollama-relay.cjs`: real inference forwarding and isolated fault injection, no public port.
- `infrastructure/e2e/local-ai-verify.cjs`: synthetic PDF/API/model/security/recovery/browser acceptance, with browser-only continuation.
- `infrastructure/e2e/local-infrastructure-verify.cjs` and `infrastructure/test/local-ai-test.Dockerfile`: remaining real-service gates in Linux, safe SQL/vhost separation.
- `infrastructure/test/pdf-fixture-integrity.test.cjs`: seven byte-integrity regressions.

Modified `.gitattributes`, Phase-four CI (adds the byte-integrity check alongside
the existing network checks), and current verification/index/roadmap/guide status.
Historical release snapshots are untouched. No new migration, dependency in app
manifests, production service or model-management feature was introduced here.

### Commands, reproducibility and final gate

Executed: `ollama pull nomic-embed-text:v1.5`; four pinned upstream JSON fetches;
isolated `python -m pip install --target .tools/v131-reference --no-deps tokenizers==0.22.1`;
`python infrastructure/e2e/local-tokenizer-reference.py`; actual provider factory,
tokenizer parity/limit and calibration probes; Docker runtime build; test-image
build using the cached build stage; `local-ai-run.cjs infra/up`; real workflow and
its affected follow-ups; `local-infrastructure-verify.cjs`; seven PDF byte tests;
format/syntax/diff checks. API/worker compile passed in the new production runtime
image. Unaffected earlier unit/build/type/lint/UI results were intentionally retained.

Another developer must provision the exact installed model digests and pinned JSON
files above, record their hashes in `upstream-manifest.json`, generate the bundles
with the reference helper and verify live count parity before selecting the SQL
profile. The profile fields are documented above: provider `ollama`, model/digest,
768 / Cosine, profile version 1, prefix normalization, runtime tokenizer/version
and document/query instructions. Use `embeddingProfileFingerprint` to produce
`profile.json`; calibrate against actual deployment evidence rather than blindly
copying the test threshold into production. The explicit runner generates a private
test env and credentials; ordinary app startup never fetches models/tokenizers.
Prepared local artifacts retain `profile.json`, `calibration.json`, bundles and
manifest; model weights remain solely in Ollama storage. Native input cap is 2048;
generation context/output certification is 4096/256, not the advertised maximum.

Primary ignored evidence: `actual-provider-smoke.json`, `count-parity.json`,
`tokenizer-validation.json`, `workflow-results.json`, `real-service-results.json`
under `.tools/v131-local-assets`, plus `.tools/v131-t05-runtime-build.log`,
`v131-t05-real-workflow-verified.log`, `v131-t05-browser-live.log`,
`v131-t05-real-services-final.log` and `v131-t05-real-services-remaining.log`.
PowerShell labels some passing native stderr output as `NativeCommandError`; actual
Jest suite counts and Docker image/child exit checks provide the execution evidence.
Initial failed probes remain identifiable and are not silently presented as passes.

Stopped only the isolated test project with `down` **without `-v`**. Test volumes,
assets and models are retained; the original Qyvra stack remains running. No secrets,
weights or tokenizer caches are staged/committed. No commit/tag/push/deploy/release.

**Local runtime prepared: PASS. Real native providers: PASS for the exact pair.
Full local PDF-to-RAG/browser: PASS. T05 is complete. Final classification:
CONDITIONALLY READY.** No unresolved release-blocking code defect was found.
Nonblocking limits: only this pinned pair and host Docker Desktop path are certified;
LAN/remote TLS, CPU-only/other GPU deployments and other model templates remain
operator-specific/unverified. The tiny Qwen may reject adversarial contexts rather
than provide a useful answer; server failure remains safe. No universal semantic
quality, prompt-injection resistance or production threshold/throughput claim.
Live OS-level termination at every stage was not repeated; retained SQL/durable
recovery evidence and new real-Qdrant crash-boundary cases cover those contracts.
Browser timeout/error/responsive/theme checks retain earlier deterministic evidence;
this live browser run focused on real answer/source navigation. Paid OpenAI and remote
CI dispatch remain intentionally NOT RUN. Next task is T06 documentation/release
readiness finalization for this qualified support matrix; T06 was not begun.

Final review: formatting and JavaScript syntax checks passed; `git diff --check`
passed; 407 relative documentation links resolve; 56 changed/new files were checked
against the generated test credential with zero matches and no tracked model/bundle
assets. Historical release snapshots show no diff. After isolated cleanup, all nine
original Qyvra containers remain running (healthchecked services healthy). Synthetic
test volumes and model/tokenizer assets were retained for reproducibility.
