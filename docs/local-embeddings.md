# Native Ollama embeddings — v1.3.1 T02

**Implemented:** native embedding adapter, shared worker/query profile dispatch,
local tokenizer validation and existing checkpoint/index/retrieval integration.
**T02 scope:** generation was deferred; [T03 native generation](local-generation.md)
is now implemented. [T04 configuration/networking](local-provider-configuration.md)
adds shared URL/key policy and optional mounts. [T05 live verification](local-provider-verification.md)
now certifies the pinned Nomic/Qwen pair and full local workflow. Earlier T02/T04
ledgers below retain their original unverified status; other models remain uncertified.

[v1.3.1 audit and plan](developer/versions/v1.3.1.md) |
[Existing embedding lifecycle](phase-4-embedding-generation.md) |
[Index publication](phase-4-vector-indexing.md)

## Runtime boundary

[createEmbeddingProvider](../apps/api/src/infrastructure/embeddings/embedding-provider.factory.ts)
selects from the authoritative request profile's `provider`, for both the existing
worker and semantic search. `openai-compatible` retains its previous adapter;
`ollama` uses [OllamaEmbeddingProvider](../apps/api/src/infrastructure/embeddings/ollama.provider.ts).
Unknown providers fail permanently. RAG reuses that same query path, with its
independently configured generation provider unchanged.

There is no second pipeline, model registry, queue, worker, authorization model or
new migration. PostgreSQL remains authoritative; RabbitMQ carries identifiers;
Redis progress is disposable; Qdrant remains derived and rebuildable. Elasticsearch
is still planned, not a current Compose service.

The native adapter sends one POST to the full `/api/embed` endpoint:
model, ordered transformed strings, `truncate: false` and optional dimensions.
It does not send owner/document/chunk identifiers. Exact result count/order, model,
finite nonzero vectors and expected dimensions are checked before a complete batch
can be checkpointed. No padding or truncating vectors. Returned aggregate
`prompt_eval_count` must equal the pinned local tokenizer's aggregate count;
missing or mismatched counts fail closed. This deliberately excludes uncertified
server/tokenizer combinations. [Ollama API contract](https://docs.ollama.com/api/embed).

The adapter reads the same server's `/api/tags` before and after inference and
requires exactly one matching installed tag with the profile's digest. Proxies must
forward both routes. This detects ordinary model replacement; it is not an atomic
server-side model snapshot or proof against a malicious inference server. Operators
must keep model tags fixed while requests are in flight. Catalog labels without
a tag use `:latest`; immutable profiles must still pin the digest, never only latest.
[Installed model metadata](https://docs.ollama.com/api/tags).

## Configuration and provisioning

Model, provider, dimensions and revision remain SQL profile fields. There is no new
`EMBEDDING_PROVIDER`, `EMBEDDING_MODEL` or BASE_URL setting. Existing independent
generation configuration defaults to `GENERATION_PROVIDER=openai-compatible`;
T03 also supports `ollama` independently. See the T04 configuration matrix.

| Setting                                                    | Required use                                                                                                                             |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `EMBEDDING_ENABLED`                                        | true when enabling document/query embeddings                                                                                             |
| `EMBEDDING_ENDPOINT`                                       | Full operator-selected native URL, e.g. `http://ai-server.internal:11434/api/embed`                                                      |
| `EMBEDDING_ALLOW_HTTP`                                     | true only for an intentionally trusted HTTP deployment                                                                                   |
| `EMBEDDING_API_KEY`                                        | Optional bearer credential for an authenticated reverse proxy; local Ollama itself typically does not require one                        |
| `EMBEDDING_TOKENIZER_PATH`                                 | **New:** absolute path to an operator-provisioned JSON bundle, readable by API/worker, mounted read-only in containers                   |
| `EMBEDDING_PROFILE_FINGERPRINT`                            | Worker selection of the new immutable profile                                                                                            |
| `AI_INGESTION_PROFILE_FINGERPRINT`                         | Ingestion selection when automatic AI ingestion is enabled                                                                               |
| `SEMANTIC_SEARCH_PROFILE_FINGERPRINT`                      | Explicit API serving selection in Compose when it differs from worker selection                                                          |
| `EMBEDDING_BATCH_SIZE`                                     | Existing bounded batching; local models may require smaller batches                                                                      |
| `EMBEDDING_MAX_INPUT_TOKENS`, `EMBEDDING_MAX_BATCH_TOKENS` | Pinned local-token counts including instructions/special tokens; match installed model input limits                                      |
| `EMBEDDING_TIMEOUT_MS`, `WORKER_JOB_LEASE_MS`              | One bounded metadata/inference attempt and existing durable lease; embedding deadline remains at most half the lease                     |
| `EMBEDDING_SEND_DIMENSIONS`                                | true only if the installed server/model supports the configured output dimension; false requests native dimensions, still validates them |

Existing search/index/RAG feature flags, SQL serving selection, calibrated score
thresholds and independent generation credentials still apply. Profile creation
does not seed or automatically process existing documents.

### Operator tokenizer bundle

Use trusted installed model assets corresponding to the actual model digest. No
runtime downloads, Python/model execution, shell calls or remote repository code.
The small pinned dependency `@huggingface/tokenizers@0.2.0` supports local JSON
tokenization without a model runtime or transitive dependencies.
[Tokenizer source/API](https://github.com/huggingface/tokenizers.js).

Bundle fields:

- `schemaVersion`: 1.
- `model`: exact profile model name/tag.
- `modelRevision`: `sha256:` plus the installed catalog's 64 lowercase hex digest.
- `tokenizerJson`: the pinned Hugging Face tokenizer JSON object; truncation and
  padding must be null/absent, never silently enabled.
- `tokenizerConfig`: the matching tokenizer configuration JSON object.
- `addSpecialTokens`: boolean matching the installed embedding engine's behavior.
- `parity`: array of `{category, text, ids}` with trusted reference token IDs.
  Required categories are `ascii`, `unicode`, `document` and `query`; include
  accented/CJK/emoji text, special tokens and the exact configured instructions.
  Provide expected IDs from a trusted reference implementation for this revision,
  not from the same library under test merely to satisfy the checks.

The bundle is capped at 64 MB, loaded once at factory initialization and validated
against all reference encodings. Invalid/missing assets fail startup with a safe
category when a path is supplied. A local profile without configured assets returns
`EMBEDDING_NOT_CONFIGURED`; cloud-only configuration needs no bundle.

Profile tokenizer is `huggingface-json`; tokenizerVersion is
`hf-tokenizers-0.2.0:sha256:` followed by SHA-256 of the exact bundle file bytes.
Model/revision must match the bundle. Even reformatting a bundle changes its hash;
freeze deployed bytes and create a new profile if assets/semantics change.
The tokenizer library has documented regex/component limitations: successful bundle
parity plus actual server counts are required, not universal support claims.

Use `qyvra-embedding-input/v1` for the existing instruction + LF transformation,
or new `qyvra-embedding-prefix/v1` for exact instruction + text concatenation.
For Nomic-style inline prefixes, store `search_document: ` and `search_query: `
including their trailing space under the new normalization. Other models require
their own validated instructions/templates; names alone do not establish them.
Both checkpoint and indexing hash validation use the same Qyvra transformation.
Chunking remains unchanged; oversized local inputs fail rather than truncate.

Do not provision an actual model from the synthetic WordLevel test fixture.
EmbeddingGemma, Nomic and Qwen3-Embedding are configurable candidates, not a tested
installed-model support matrix. Chat-only Qwen models are not embedding models.

### Docker and LAN operation

Compose forwards `EMBEDDING_TOKENIZER_PATH` to API and worker; it does not copy assets,
start Ollama or configure GPU access. Add an operator-owned override mounting the
same bundle read-only into both services, for example:

```yaml
services:
  api:
    volumes:
      - ./private-ai-assets:/run/qyvra-ai:ro
  worker:
    volumes:
      - ./private-ai-assets:/run/qyvra-ai:ro
```

Set the path to `/run/qyvra-ai/embedding-tokenizer-bundle.json` inside containers.
Keep assets outside the repository and manage permissions; preserve existing storage
volume mounts when merging overrides. API and worker have default-network egress.
On Docker Desktop an operator may choose `host.docker.internal`; native Linux may
need an explicit host-gateway alias/override. Another LAN machine uses a reachable
private address/DNS name. An optional container uses shared service DNS. `localhost`
inside a container does not mean the host. No hostname/IP is hardcoded by Qyvra.

The server must bind an interface reachable from the clients. Do not publicly
expose unauthenticated Ollama or add it to frontend/Nginx routing. Protect operator
configuration, proxy credentials, asset paths and network egress. Use segmentation
and TLS/authentication for remote deployments as appropriate. Existing URL checks
and redirect rejection remain; they are not a destination allowlist. CPU-only
is supported by the HTTP design; GPU/driver management remains external.

## Checkpoints, switching and search

The immutable fingerprint already includes provider, model/revision, dimensions,
normalization, tokenizer/version, instructions and distance. No schema changes.
Equal dimensions across providers/models do not confer compatibility. New identities
require new checkpoints and profile-specific collections; old OpenAI rows remain
unchanged. Exactly matching existing checkpoints can be reused without inference.

The handler commits only a completely validated batch under existing live-lease,
owner, lifecycle and current-run checks. On retry it reuses valid prior batches and
embeds only missing chunks. A model-digest change fails the next provider call;
revert to the pinned installed model or create a new profile/run. Do not rewrite
old checkpoints. An entirely checkpointed generation/index rebuild can proceed
without provider calls; retrieval still checks the installed model for new queries.

Indexing still verifies complete point sets before SQL READY publication. A
replacement generation remains BUILDING until verified; existing publication rules
are unchanged. Query selection must match SQL `AiServingProfile` and READY manifests;
mismatched configuration returns a controlled unavailable response before vector
search. Candidate text is hydrated only after PostgreSQL ownership/lifecycle checks.
RAG retains server-side token/citation validation with its independent cloud provider.

Operator cutover: provision new profile/bundle/model → select worker/ingestion profile
→ regenerate embeddings and verified indexes using existing reprocessing/backfill
→ switch SQL serving selection and API fingerprint after coverage → existing cleanup.
When the worker moves to Ollama while the API still serves an OpenAI profile,
override the API's embedding endpoint/key separately to retain its cloud adapter;
the default Compose environment otherwise shares one endpoint. A serving fingerprint
alone does not change the transport. Use service-specific environment overrides,
then switch API endpoint/assets/profile together at cutover. No automatic fallback.
Do not mix vector spaces or automatically delete old collections. Rebuilding lost
Qdrant alone still uses durable PostgreSQL vectors, without re-embedding.

## Errors and troubleshooting

| Category                                                                   | Behavior / operator action                                                                                              |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `EMBEDDING_TOKENIZER_INVALID`                                              | Permanent; inspect bundle schema/parity/assets, never exposes path/content                                              |
| `EMBEDDING_PROFILE_UNSUPPORTED`                                            | Permanent; verify provider/tokenizer hash/model/revision/normalization identity                                         |
| `EMBEDDING_NOT_CONFIGURED`                                                 | Permanent; enable configuration and provide assets/full native endpoint                                                 |
| `EMBEDDING_MODEL_REVISION_MISMATCH`                                        | Permanent; missing/different installed tag digest, restore pinned model or provision a new identity                     |
| `EMBEDDING_INPUT_LIMIT`                                                    | Permanent; local budget exceeded, adjust upstream chunks/profile/config deliberately                                    |
| `EMBEDDING_INVALID_OUTPUT`, `EMBEDDING_OUTPUT_LIMIT`                       | Permanent; invalid vector/count/model/token parity/envelope; no batch checkpoints committed                             |
| `EMBEDDING_AUTH_FAILED`, `EMBEDDING_REQUEST_REJECTED`                      | Permanent HTTP 4xx including unknown/unsupported model or server input rejection; inspect trusted server logs privately |
| `EMBEDDING_NETWORK`, `EMBEDDING_TIMEOUT`, `EMBEDDING_PROVIDER_UNAVAILABLE` | Retryable connection/timeout/408/5xx; existing bounded PostgreSQL backoff/recovery                                      |
| `EMBEDDING_RATE_LIMITED`                                                   | Retryable 429 with bounded Retry-After                                                                                  |

The adapter does not retry internally. Some server-side unsupported/resource failures
may use 5xx; these get bounded existing retries rather than an infinite loop. Provider
error bodies are discarded, not logged or exposed. A request deadline covers both
catalog checks, inference and bounded response reads. CPU/cold-load latency may need
smaller batches or measured timeout/lease tuning; never use infinite timeouts.

## Verification ledger and limitations

Deterministic unit coverage includes single/batch order, purpose preprocessing,
invalid vectors/count/model/envelope/token counts, timeout/cancellation/network,
HTTP classification, pre/post-inference digest drift, assets/parity and selection.
Existing compatible adapters, query authorization, RAG/context/citations and vector
contracts are included in the targeted regression command.

PostgreSQL integration uses a new loopback-only disposable cluster/database and all
15 historical migrations. The native fixture proves partial batch outage → durable
retry → prior checkpoint reuse → one index intent → SQL READY activation → owned
query retrieval → unchanged compatible generation → validated citations. It also
checks another owner's empty scope and mismatched serving fingerprints. Its vector
store and provider transport are deterministic doubles, not live infrastructure.

Real Ollama smoke is **NOT RUN**: no configured
installed-model endpoint. Docker image/real Qdrant/broker verification is **BLOCKED**
by the unavailable Docker daemon; those tests must run in capable CI/deployment.
No model download, paid cloud call, production reindex or user-data deletion occurred.

Known limitations: trusted operator asset provisioning/parity evidence is required;
actual candidate models/server versions are not certified here; metadata digest
checks cannot atomically freeze a mutable server; tokenizer count equality is a
guard, not proof that every token ID is identical. Generation remains compatible-only.
These are documented verification/operational limits, not permission to weaken gates.

## T02 completion report

1. Existing architecture: typed document/query embedding interface, immutable SQL
   profiles, native compatible HTTP adapter, full-batch checkpoints and existing
   index/retrieval/RAG boundaries inspected. Elasticsearch is planned, not installed.
2. T01 approach followed: native embedding adapter alongside the compatible adapter;
   pinned local assets and authoritative profile dispatch, no framework.
3. Adapter: `OllamaEmbeddingProvider`, shared result validator, bounded metadata and
   inference reads, optional bearer key, explicit no-truncation and digest gates.
4. Protocol: POST `/api/embed`, GET sibling `/api/tags`; no `/v1` SDK or baseURL.
5. Created: `ollama.provider.ts`, `ollama.provider.spec.ts`, `local-tokenizer.ts`,
   `embedding-provider.factory.ts` under API infrastructure/embeddings,
   `test/ollama.fixture.ts` and this guide. T01 planning files existed before T02.
6. Modified code/config: API manifest/lockfile, configuration settings/environment
   and tests, embedding preprocessing, worker/search DI, embedding integration
   tests, `.env.example` and Compose. Modified current docs: README, documentation/
   developer/ADR indexes, roadmap, architecture/database/API/environment guides,
   v1.3.1 audit and ADR-006. Historical release guides remain unchanged.
7. New environment variable: only `EMBEDDING_TOKENIZER_PATH`; endpoint/key/model/profile/
   dimensions/timeout/batching reuse existing boundaries. No generation settings added.
8. Models: operator-selected SQL model/tag, digest and compatible assets; no hardcoded
   production model or guaranteed installed candidate. Synthetic fixture is test-only.
9. Validation: complete count/order, exact model/digest, finite nonzero dimensional
   vectors, bounded response and token-count parity; all failures precede checkpoint writes.
10. Identity: no fingerprint format change. New provider/digest/tokenizer bundle hash
    and optional prefix normalization distinguish compatibility-relevant semantics.
11. Migrations: none added/edited. All 15 existing migrations applied successfully
    to new disposable PostgreSQL database `qyvra_v131_test`.
12. Checkpoints: valid prior batches reused after 503/retry; exact transformed-input
    hashes persisted, duplicates safe, no downstream intent before complete embeddings.
13. Qdrant: existing profile collections, dimensions and point IDs preserved;
    deterministic adapter regression and real SQL READY activation pass. Live Qdrant
    transport/image checks blocked by Docker availability.
14. Queries: same factory/profile as document embeddings; serving mismatch fails 503
    before searching another vector space, dimensions validated as before.
15. Worker: existing DI/router/leases/jobs/retries unchanged apart from factory selection.
16. Retrieval: real SQL scope/hydration in integration, other owner gets no results;
    existing authorization tests pass. RAG continues with independent cloud adapter
    and SQL-derived validated citation provenance.
17. OpenAI regression: compatible embedding and generation adapter tests pass;
    profiles/checkpoints/collections never overwritten or migrated by T02.
18. Unit results: targeted regression **10 suites / 226 tests passed**; native adapter
    **31 tests passed**, including final targeted rerun after the last code adjustment.
19. Integration results: final embedding/checkpoint suite **16 passed, 1 skipped**
    against real PostgreSQL. Native combined case uses deterministic HTTP/vector
    doubles; it is not real Ollama/Qdrant certification.
20. Recovery: partial outage/resume, crash after checkpoints, duplicate/concurrent
    delivery, invalid batches, rollback, lifecycle/lease fencing and profile changes
    pass. Real RabbitMQ case skipped because no test broker is available.
21. Live Ollama smoke: **NOT RUN**, no explicit configured installed-model endpoint.
22. Documentation: provisioning, exact bundle/hash/profile identity, cutover,
    Docker mounts/forwarding, errors, retry behavior and verification evidence updated.
23. Limits: trusted model/tokenizer assets/parity required, mutable server checks
    non-atomic, installed models/performance unverified, generation remains unchanged.
24. Verification blockers: Docker Desktop Linux engine pipe is absent, confirmed
    outside sandbox. No Docker build/Compose startup or live Qdrant/broker test claimed.
25. Status: T02 implementation and deterministic validation complete; **full
    infrastructure/live-model verification remains outstanding**. No release readiness
    or universal model compatibility claim follows from these results.
26. Next: T03 — Implement Ollama Generation and Qwen Output Compatibility.

Executed commands, using existing repository dependencies:

- `npm.cmd install --save-exact @huggingface/tokenizers@0.2.0 --ignore-scripts`:
  installed one pinned zero-dependency package; no model downloads. Registry access
  required sandbox escalation. Existing lock entries retained without npm metadata churn.
- `npm.cmd run build` in apps/api: passed shared builds and Nest build; compiled
  `dist/main.js` and `dist/worker-main.js` exist.
- `npm.cmd run typecheck` and `npm.cmd run lint` in apps/api: passed, exit 0.
- API Jest targeted pattern covering native/compatible providers, embedding contract,
  configuration, semantic search, RAG/context, vector handler and Qdrant adapter:
  10 suites / 226 tests passed. Final native-only Jest rerun: 31 passed.
- Existing integration Jest config with `TEST_DATABASE_URL` targeting the separate
  loopback test database: final 16 passed / 1 broker-dependent skipped.
- `prisma migrate deploy` using that test database: all 15 existing migrations passed.
- Docker availability check, including outside sandbox: failed because the Docker
  Desktop Linux engine is not running; no unrelated developer volumes were touched.
- `docker compose config --quiet`: passed without printing resolved credentials or
  starting services. Image build/startup and live infrastructure remain unverified.
- Final documentation/code formatting and `git diff --check`: passed. Local-link
  review checked 336 paths without findings; historical developer baseline, release
  snapshots, migrations and all existing dependency lock entries are preserved.
- The task-owned PostgreSQL test instance was stopped after verification; its
  isolated files remain available for later evidence/retesting. No staged changes.

Initial test fixture/type issues were corrected (Jest invocation context, table-row
typing, an assumed document-current-version field and missing fixture score policy).
The final commands above passed; assertions and existing tests were not weakened.
No browser E2E, paid provider test, model install, production reindex or deployment.
