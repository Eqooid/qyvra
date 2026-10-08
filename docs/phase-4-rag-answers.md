# T10 — Grounded answers and validated citations

**Implemented, opt-in; verified 7 October 2026.** T10 adds standalone, non-streaming
answers through `POST /api/v1/rag/answers`. It reuses [T09 authorized retrieval](phase-4-semantic-search.md),
the existing session/CSRF policy and HTTP envelopes. No migrations, new jobs,
conversation tables, AI frameworks or dependencies were added. T11 frontend/source navigation is implemented in [T11](phase-4-ai-frontend.md); [T12 acceptance](phase-4-verification.md) is complete with known non-blocking limitations; this is not a v1.3.0 release declaration.

## Application and provider boundaries

`RagAnswerController` validates a trimmed question (1–4000 UTF-16 code units;
invalid surrogate sequences are rejected) and an optional list of 1–50 unique owned
document UUIDs. Clients cannot supply ownership, context, vectors, prompts, models,
provider endpoints or generation settings. Session authentication and
`X-CSRF-Protection: 1`/trusted Origin are required. Foreign/inaccessible IDs return
404, invalid input 400, missing authentication 401, and CSRF rejection 403.

`RagAnswerService.answer()` invokes T09 once, checks the configured score floor,
reauthorizes exact evidence through the exported `SemanticSearchService.revalidate()`
boundary, constructs context, makes one generation call, reauthorizes again and
validates the result. RAG does not import Qdrant or implement an alternate search.
SQL revalidation checks owner, active document, latest version, complete chunk set,
READY pointer/manifest, serving profile and unchanged canonical text/hash. Metadata
in citations comes from the final SQL read. PostgreSQL remains authoritative.

The Qyvra-owned `GenerationProvider` accepts system/user messages and cancellation;
it returns text and optional normalized usage. It is separate from embeddings and
their profiles. The first native HTTP adapter sends Chat Completions with strict
JSON Schema, `stream:false`, `store:false`, a configured output cap and temperature
0 by default. It sends no tools, remote resources or conversation identifiers.
It follows the [official Chat Completions request contract](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create).
The full endpoint is trusted server configuration, HTTPS by default; credentials,
query strings, fragments and redirects are rejected. HTTP requires explicit opt-in
for private development/local infrastructure. API keys appear only in transport
headers, never context, SQL, vector payloads or logs.

The adapter performs exactly one attempt, bounds its response to 256 KiB, requires
one completed choice and rejects truncated output, refusals, tools and malformed
responses. A compatible future local HTTP deployment can use the same boundary
if it supports this request/schema contract and an available matching tokenizer.
No local orchestration or dedicated Ollama adapter is implemented. Deployments
that lack strict schemas fail safely; there is no free-text fallback.

## Context and sufficiency

`qyvra-rag-v1` uses deterministic rank order and request-local `S1`, `S2`, … tokens.
Only tokens and exact canonical excerpt text are sent as evidence. Titles, filenames,
business UUIDs, storage keys, provider keys and vector metadata are not injected.
Question and evidence are JSON-serialized data in the user message; the separate
system message declares them untrusted and instructs evidence-only answers,
abstention, valid source tokens and no external actions. Document content cannot
change server authorization or add model tools.

Context selects whole chunks, skips duplicate IDs and overlapping ranges within a
version, caps contributions per document and chooses the highest-ranked chunks
that fit. Oversized chunks are skipped, never truncated; this avoids ambiguous
snippet hashes and page offsets. Selection may leave gaps and omit overlapping
chunks with unique trailing text. It does not promise complete corpus coverage.
No reranking, query rewriting, multiple searches or threshold relaxation occurs.

The existing `tiktoken` dependency counts serialized system/user messages and the
output schema with the independently configured `o200k_base` or `cl100k_base`
encoding. The total budget reserves the maximum output plus 1024 tokens for the
chat envelope/provider schema overhead. This is a conservative input estimate,
not an exact provider billing count. Operators must select the encoding appropriate
to their generation model and declare a window no larger than its supported limit;
arbitrary local tokenizers require a future strategy. Character counts are not
treated as tokens. Changing embedding models does not change generation encoding.

RAG enablement requires an explicit `SEMANTIC_SEARCH_MIN_SCORE` calibrated for the
selected serving embedding profile. Cosine scores are not confidence probabilities.
An empty or below-floor retrieval returns `no_authorized_evidence` without an LLM
call; no fitting excerpt returns `context_budget`. A valid model abstention returns
`model_insufficient_evidence`. Evidence revoked before dispatch/publication returns
`evidence_changed`, with no answer/citations. Calibrating an actual production corpus
and evaluating semantic entailment remain release acceptance requirements.

## Output and citation contract

The model must return exactly:

```json
{
  "outcome": "answered",
  "claims": [{ "text": "Supported fact.", "sourceTokens": ["S1"] }]
}
```

or `{"outcome":"insufficient_evidence","claims":[]}`. Extra fields, unknown tokens,
empty answered claims, uncited claims, malformed JSON and model-written `[S1]`/`[C1]`
markers are rejected with the fixed safe **502 `AI_OUTPUT_INVALID`** envelope. No
invalid answer text is published. Limits are 64 claims, 2048 code units per claim,
32768 total claim characters, and at most 20 source tokens per claim. Repeated known
tokens are deduplicated. Validation proves provenance/reference membership and basic
citation coverage; it does not prove that every claim is entailed by its source.

Answered data contains `outcome`, server-composed plain-text `answer`,
`claims:[{text,citationIds}]`, `citations` and `requestId`. The server appends `[S1]`
markers derived from validated tokens. Frontends must render answer/claim/snippet
strings as untrusted text. Citation objects contain:

```text
citationId, documentId, documentVersionId, versionNumber, chunkId, chunkOrdinal,
title, originalFilename, pageSpans, excerptStart, excerptEnd, excerptHash, excerpt
```

Each citation is constructed from the corresponding authorized PostgreSQL chunk,
never from model-provided IDs, filenames, pages or URLs. `excerpt` is exactly the
bounded text supplied to generation; `excerptHash` is SHA-256 of its UTF-8 bytes.
Offsets and page spans are half-open Unicode scalar ranges in canonical extracted
content, preserving multi-page provenance. Canonical chunk IDs remain independent
of Qdrant point identities. Citations appear once in source order; each claim keeps
its validated citation IDs. Tokens are request-local, not durable chunk identities.

Insufficient data contains `outcome:"insufficient_evidence"`, `answer:null`,
`citations:[]`, a controlled `reason` and `requestId`. Responses retain the standard
`{data,meta:{requestId}}` envelope and no-store policy. Generated OpenAPI describes
the discriminated union. Citation source resolution/document-version navigation
is implemented in [T11](phase-4-ai-frontend.md) with independent SQL authorization. Historical binary download/PDF page viewing remains Planned; T10 itself adds no source resolution route.

## Timeout, admission and privacy

RAG defaults to a 60-second total deadline and a 25-second generation deadline;
the parent signal also cancels T09 query embedding. Qdrant/SQL retain their existing
bounded timeouts. Default per-process admission is 2 active requests, 10 per user
per minute and 100 globally. T09 admission also applies. Timed-out generation retains
its slot until underlying work settles. Budgets are not distributed quotas; multiply
them across replicas or add a separately authorized distributed gate in future work.

There are no interactive retries or ingestion job records. Provider/network/auth
failures return safe 503, timeout 504, rate limits/admission 429 and invalid generation 502. No provider body, raw network error or model text enters the error envelope.
Original document/upload/download/status capabilities remain independent of RAG.

Structured events include outcome, durations, input length, source/citation count,
prompt version, generation provider/model, embedding profile and optional normalized
usage. Existing secret redaction may redact token-count keys. Questions, document
text, snippets, answers, vectors, cookies and keys are not logged. Answers/history
are not persisted. Only the question and authorized excerpts leave Qyvra for the
configured provider; operators must assess provider retention, confidentiality and
deployment policy. `store:false` does not promise zero provider-side retention.

Archive, soft deletion, supersession, profile switches and removed source mappings
fail the SQL fence. Already dispatched, then-authorized context cannot be recalled
from a provider. A lifecycle change after the final SQL read is an unavoidable
publication race; the final read is the response authorization boundary. Future
citation navigation rechecks current access. The current ownership model is internal
`users.id`; no separate tenant model was invented.

## Configuration

All settings use existing startup validation and typed configuration; generation
values are supplied only to the Compose API service. `.env.example` contains:

| Setting                                                             | Default / contract                                             |
| ------------------------------------------------------------------- | -------------------------------------------------------------- |
| `RAG_ENABLED`                                                       | `false`; requires semantic search and explicit score floor     |
| `RAG_MAX_SOURCES` / `RAG_PER_DOCUMENT_SOURCES`                      | `8` / `3`, each 1–20                                           |
| `RAG_CONTEXT_TOKENS`                                                | `8192`, max 32768; greater than output cap + 1024              |
| `RAG_TIMEOUT_MS`                                                    | `60000`, max 120000                                            |
| `RAG_CONCURRENCY` / `RAG_USER_PER_MINUTE` / `RAG_GLOBAL_PER_MINUTE` | `2` / `10` / `100`                                             |
| `GENERATION_PROVIDER`                                               | `openai-compatible` only implemented adapter                   |
| `GENERATION_MODEL` / `GENERATION_ENDPOINT`                          | Required when enabled; no default model                        |
| `GENERATION_API_KEY`                                                | Optional secret; needed for providers requiring authentication |
| `GENERATION_ALLOW_HTTP`                                             | `false`; private HTTP opt-in                                   |
| `GENERATION_TOKENIZER`                                              | `o200k_base`; `cl100k_base` also accepted                      |
| `GENERATION_TIMEOUT_MS`                                             | `25000`, max 60000                                             |
| `GENERATION_MAX_OUTPUT_TOKENS`                                      | `1024`, max 4096                                               |
| `GENERATION_TEMPERATURE`                                            | `0`, finite 0–1                                                |
| `GENERATION_OUTPUT_TOKEN_FIELD`                                     | `max_completion_tokens`; explicit `max_tokens` legacy option   |

Pin/test the deployment's model, tokenizer, strict-schema support, output-field and
temperature compatibility before enabling. API/provider compatibility is not inferred
from an endpoint merely calling itself OpenAI-compatible. No paid calls are made by
normal automated verification. Existing deployment network rules keep Qdrant private;
generation does not add a publicly exposed infrastructure service.

## Files and verification

Created:

- `apps/api/src/common/ai-output-invalid.exception.ts`
- `apps/api/src/modules/ai/generation-provider.ts`
- `apps/api/src/modules/ai/rag-context.ts` and `rag-context.spec.ts`
- `apps/api/src/modules/ai/rag-citations.ts`
- `apps/api/src/modules/ai/rag-answer.service.ts` and `rag-answer.service.spec.ts`
- `apps/api/src/modules/ai/rag-answer.controller.ts` and `rag.module.ts`
- `apps/api/src/infrastructure/generation/openai-compatible.provider.ts` and `.spec.ts`
- `apps/api/test/rag-source.fixture.ts` and `rag-answer.integration-spec.ts`
- This guide.

Modified (22 files):

- `.env.example`, `README.md`, `docker-compose.yml`
- `apps/api/src/app.module.ts`, `configure-swagger.ts`, `common/http-envelope.ts`
- `apps/api/src/configuration/settings.ts`, `environment.ts`, `environment.spec.ts`, `configuration.module.ts`
- `apps/api/src/modules/search/semantic-search.service.ts`, `search.module.ts`
- `docs/README.md`, `api.md`, `architecture.md`, `database.md`, `specification.md`, `roadmap.md`, `compose.md`
- `docs/phase-4-ai-rag.md`, `phase-4-semantic-search.md`, `deployment/environment-variables.md`

Historical migrations and release snapshots are preserved. No dependencies,
database entities or worker handlers were changed by T10. Existing T01–T09 and
unrelated storage changes remain intact. No new binary fixtures were required.

Unit tests
exercise deterministic context, structural prompt separation, multilingual evidence,
overlap/budgets, strict output/citation validation, abstention, authorization races,
provider errors/timeout/admission and native HTTP transport. Real integration tests
upload PDFs for two owners, run integrity/extraction/chunking/embedding/index activation,
retrieve through real Qdrant and SQL, and use a deterministic generation double. They
verify canonical citations, foreign higher-scoring vectors, rejected S999/forged pages,
weak evidence, guarded DTOs and archive during generation. The optional final-image
test uses native query/generation HTTP adapters against a local provider stand-in;
it was executed successfully, not just added. Archive and soft-delete during
generation both discard stale answers.

| Executed verification                                                                            | Result                                                      |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| API `nest build`; final Docker image builds shared database/storage packages and API/worker code | Passed                                                      |
| `tsc --noEmit --incremental false`                                                               | Passed                                                      |
| ESLint `src/**/*.ts` and `test/**/*.ts`                                                          | Passed                                                      |
| Prettier source/tests/changed canonical docs/Compose                                             | Passed                                                      |
| Targeted RAG/provider/configuration unit suites                                                  | 134 passed                                                  |
| Full API unit suite                                                                              | 40 suites, 414 passed; one optional live Redis test skipped |
| Final context suite after adding both encoding assertions                                        | 18 passed                                                   |
| Full existing HTTP end-to-end suite                                                              | 15 suites, 281 passed                                       |
| Final T10 real PostgreSQL/Qdrant/PDF + native generation/query Docker suite                      | 9 passed                                                    |
| T03–T09, status, outbox and worker integration selection                                         | 83 passed; 12 optional checks skipped                       |
| `npm run migrate:deploy` against fresh `qyvra_t10_api_test`                                      | All 15 existing migrations applied; no T10 migration        |
| `docker compose config --quiet`                                                                  | Passed, no secret-bearing config output                     |
| Canonical documentation local-link/anchor check                                                  | Passed                                                      |
| `git diff --check`; historical snapshot diff inspection                                          | Passed; historical release/developer snapshots unchanged    |

The 12 skipped regression checks were 10 live RabbitMQ cases (including the five
dedicated worker cases), one live Redis enrichment case and the existing optional
T09 container test. The new T10 container check exercises native query/Qdrant and
generation together; the T09 container check was already verified before T10.
RabbitMQ/Redis infrastructure was not started or claimed tested in this run. Their
transport/retry/recovery unit tests and PostgreSQL outbox tests passed; T10 changes
neither messaging nor worker execution. Normal verification makes no paid calls.

Commands ran from `apps/api` using the installed Node entry points:
`node node_modules/@nestjs/cli/bin/nest.js build`,
`node node_modules/typescript/bin/tsc --noEmit --incremental false`,
`node node_modules/eslint/bin/eslint.js 'src/**/*.ts' 'test/**/*.ts'`,
`node node_modules/prettier/bin/prettier.cjs --check ...`, and
`node node_modules/jest/bin/jest.js --runInBand` with the unit/default,
`test/jest-e2e.json` and `test/jest-integration.json` configurations. Integration
used a newly migrated loopback PostgreSQL test database and isolated Qdrant 1.19.2
on port 6339. The final T10 suite additionally set
`TEST_CONTAINER_IMAGE=qyvra-t10-api-test` and ran native adapters in that image
against the same authorized SQL/index data and a local HTTP provider stand-in.

`docker build -f infrastructure/docker/api.Dockerfile --target runtime -t
qyvra-t10-api-test .` passed; image ID is
`sha256:62e2dbe4c78dc5e9000d4bf15eac61e2d01a4177c62fde85a22c86af6a26c284`.
Test reports/logs are under ignored `.tools/t10-*`. Full suites were not repeatedly
rerun after documentation-only changes; the changed context assertions and final
integration cases were rerun specifically. No validation was disabled.

**T10 is complete within its standalone answer-generation scope.** Live paid-provider
and production semantic quality/cost/load acceptance are explicitly not established
by deterministic provider doubles. RAG remains disabled by default until deployment
configuration and profile-specific calibration are supplied.

## Scope and remaining acceptance work

T01's claim-level contract and proposed `/rag/answers` route are followed. T10
concretizes whole-excerpt selection, overlap exclusion, tokenizer selection, explicit
score-floor enablement, output limits and safe 502 mapping; it does not redesign
T01–T09. ADR-005 remains authoritative; no new ADR is required.

No agents, external tools/actions, MCP, Hermes, LangChain/LangGraph, OCR, persistent
conversation memory, streaming, reranking, hybrid search, local model orchestration,
document modification or AI frontend are implemented. Prompt instructions plus
strict references reduce injection risk but cannot certify an LLM's semantic honesty.
Live paid-provider/model compatibility, corpus relevance/entailment/injection evaluation,
replica-wide quotas and production load/cost measurement remain explicit acceptance
work. T11 implements safe semantic/RAG UI and reauthorized citation navigation;
T12 should perform full-stack security/recovery/quality acceptance and release evidence.
