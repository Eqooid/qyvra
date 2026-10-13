# v1.3.1 T03 — Native Ollama generation and structured RAG

Status: **Implemented**. [T05 live verification](local-provider-verification.md)
certifies the pinned Qwen model/template and local PDF-to-RAG workflow. The earlier
T03 ledger below records its original no-endpoint status. This does not declare v1.3.1
released. [T01 audit](developer/versions/v1.3.1.md),
[ADR-006](decisions/ADR-006-local-provider-compatibility.md) and
[T02 embeddings](local-embeddings.md) remain the baseline.

## Runtime boundary

[The generation factory](../apps/api/src/infrastructure/generation/generation-provider.factory.ts)
selects `openai-compatible` or `ollama` independently of embedding configuration.
The compatible adapter is retained unchanged. The native
[Ollama adapter](../apps/api/src/infrastructure/generation/ollama.provider.ts)
uses **POST `/api/chat`**, `stream:false`, the existing Qyvra JSON schema in
`format`, explicit `think`, and `options.num_ctx`, `num_predict`, `temperature`.
This follows [Ollama's native chat contract](https://docs.ollama.com/api/chat).
It also sends `truncate:false` and `shift:false`, supported by current
[native request definitions](https://github.com/ollama/ollama/blob/main/api/types.go),
to prevent history dropping/context shifting. Older servers that ignore these
fields still must pass exact prompt-count checks; they require live certification.
There is no new dependency, tool access, model management, job system, migration,
public API format or frontend change.

The existing RAG service still retrieves owned SQL-authorized evidence, reauthorizes
before generation and publication, supplies request-local source tokens, validates
the strict output shape and resolves citations from canonical provenance. Unknown
tokens, missing citations, malformed JSON/types, invented source metadata and
excessive claims are rejected. Duplicate valid citations are deduplicated;
reordered references retain canonical source identity. Model-generated document
IDs, pages and URLs are never authoritative.

No authorized evidence means no inference. Model insufficient-evidence output must
have empty claims. Only complete final `message.content` enters validation; separate
`message.thinking` is discarded. Truncated answers, tool calls and empty content
are rejected. Thinking/markdown mixed into final JSON fails the existing parser.
Syntactically valid citations do not prove every factual claim; grounded quality
and adversarial behavior still require installed-model assessment.

## Configuration and connectivity

Reuse existing operator-only settings:

```dotenv
RAG_ENABLED=true
GENERATION_PROVIDER=ollama
GENERATION_MODEL=<installed-compatible-model-and-tag>
GENERATION_ENDPOINT=http://<trusted-ollama-host>:11434/api/chat
GENERATION_ALLOW_HTTP=true
GENERATION_API_KEY=
GENERATION_TOKENIZER=huggingface-json
GENERATION_TOKENIZER_PATH=/opt/qyvra/models/generation-bundle.json
GENERATION_THINK=false
GENERATION_TIMEOUT_MS=60000
GENERATION_MAX_OUTPUT_TOKENS=1024
GENERATION_TEMPERATURE=0
RAG_CONTEXT_TOKENS=8192
RAG_TIMEOUT_MS=120000
```

Also configure existing semantic search, indexing and compatible embeddings as in
[T02](local-embeddings.md). These are examples, not model certification. Context
must fit the installed model's certified usable limit. Generation timeout is bounded
at 60 seconds; RAG timeout at 120 seconds. Slow CPU/cold starts can exceed them;
there are no latency, throughput or memory guarantees.

Only `GENERATION_TOKENIZER_PATH` and `GENERATION_THINK` are new. Native mode requires
an absolute bundle path and `huggingface-json`; cloud mode retains `cl100k_base` or
`o200k_base`. `GENERATION_OUTPUT_TOKEN_FIELD` remains cloud-only; native uses
`num_predict`. Optional `GENERATION_API_KEY` supports a trusted bearer-auth proxy.
Endpoint must end in `/api/chat`, without URL credentials/query/fragment. Redirects
are rejected. Compatible Qwen or other model names remain operator configurable;
no model is installed/downloaded or guaranteed compatible merely by name.

Compose forwards new generation settings to the **API only**. Mount the bundle
read-only through an operator override; setting its path does not mount a host file.
`localhost` inside the API container means that container. For host Ollama, select
a host alias appropriate to deployment (Docker Desktop `host.docker.internal`, or
an explicit Linux host-gateway override where supported). For LAN/server inference,
use a reachable trusted address; an optional container can use service DNS on a
shared private network. T03 adds no host alias, Ollama service, public port or GPU
configuration. Never proxy Ollama to browsers. Protect unauthenticated LAN endpoints
with private networking; remote sensitive traffic needs TLS/proxy authentication.
Users cannot override provider endpoints or credentials.

| Embedding         | Generation        | Support      |
| ----------------- | ----------------- | ------------ |
| OpenAI-compatible | OpenAI-compatible | Retained     |
| Ollama            | OpenAI-compatible | T02 retained |
| OpenAI-compatible | Ollama            | Implemented  |
| Ollama            | Ollama            | Implemented  |

Generation switching changes no embedding profile, checkpoint, collection or active
index. PostgreSQL authorization/profile compatibility remain mandatory. Qdrant stays
derived; RabbitMQ transport and Redis progress are unchanged.

## Pinned tokenizer and framing bundle

[LocalGenerationTokenizer](../apps/api/src/infrastructure/generation/local-tokenizer.ts)
reuses T02's installed `@huggingface/tokenizers` 0.2.0. Operators provision a pinned
UTF-8 JSON file, at most 64 MB, containing:

- `schemaVersion: 1`, exact configured `model`, `modelRevision: sha256:<64 lowercase hex>`.
- `contextLimit`: certified usable context; `think`: exact configured boolean.
- `tokenizerJson`, `tokenizerConfig`, `addSpecialTokens`: pinned tokenizer data.
  Automatic tokenizer truncation/padding is forbidden.
- `framing`: strings `systemPrefix`, `systemSuffix`, `userPrefix`, `userSuffix`,
  `assistantPrefix` (each at most 8192 characters). Render system/user messages in
  order, then append assistant prefix. Match installed Ollama template/BOS/thinking.
- `parity`: reference `{category, text, ids}` samples covering `ascii`, `unicode`,
  `prompt`; nonnegative integer IDs must match the reference tokenizer.
- `promptParity`: reference `{messages, text}` with exactly system/user messages.
  Rendered framing must equal the reference text, also present in prompt parity.

**T01 concretization:** restricted, certified two-message framing replaces arbitrary
Go/Jinja template execution; no template engine is installed. Conditional message
rewriting, dynamic tools/history or other unsupported templates are not certified.
There is no universal shipped Qwen bundle. Certify the chosen model/digest,
tokenizer and thinking mode together; changes need a matching bundle and API restart,
not document reprocessing. Reference samples are data, not executable model code.

Budgeting counts rendered native prompt tokens plus schema-token and 1024-token
reserve. Existing context selection includes only whole excerpts whose input plus
reserved output fits `RAG_CONTEXT_TOKENS`; no evidence/citation mapping is sliced.
The adapter rechecks the budget and sends the same limit to Ollama. Reported
`prompt_eval_count` must exactly match rendered prompt tokens; `eval_count` must fit
the output cap. Template/tokenizer/server count differences fail closed rather than
certifying silent truncation. Versions with different cached-token accounting need
separate validation and are not certified here.

Bounded GET `/api/tags` before/after inference verifies the installed digest. Tags
must remain immutable during requests. These checks detect observed changes, not an
atomic model snapshot; change-and-restore races are not proven absent. Assets load
once at startup, with no network downloads. Synthetic bundles certify test behavior
only. `GENERATION_THINK=true` needs a bundle certified for true; reasoning consumes
the same output cap and never enters the public response.

## Failure and security policy

One HTTP attempt per question; no automatic generation retry/durable generation job.
Existing sanitized mappings remain: timeout **504**, rate limit **429**, unavailable
configuration/model/HTTP errors **503**, invalid envelope/output/citations **502**.
Transient and permanent HTTP failures share the existing unavailable public category.
Native failures retain internal retryability: connection/timeout, 408/429 and 5xx
are retryable; other 4xx, model/digest/configuration and invalid output are permanent.
This metadata does not introduce automatic retries. Fix unknown models, unsupported schemas and invalid bundles;
connection/timeouts never alter document-processing state.

One abort/deadline covers catalog checks, inference and body reads. Responses are
capped at 262144 bytes, final content at 65536 characters. Incomplete/tool/invalid
usage/over-limit results fail safely. No evidence, reasoning, raw error bodies,
credentials or endpoints are logged by the adapter. Existing RAG logs record safe
provider/model/duration/counts. Untrusted JSON evidence remains beneath unchanged
system instructions; there is no filesystem/database/action/tool access.

## Verification ledger

Native tests cover transport/options, budget, digest/parity, timeout/cancellation,
invalid envelopes and strict RAG/citation handling. Actual factories test all four
provider combinations and unchanged embedding profile identity. SQL checkpoint,
index activation, owned retrieval and RAG run with both generation adapters using
**real isolated PostgreSQL** and deterministic provider/vector-store doubles. This
is not a live Qdrant/Ollama test.

| Check                                  | Command/evidence                                                                                                                              | Result                                                                                                                                        |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Generation/RAG/cloud regression        | API Jest path filter `generation/ollama.provider.spec\|rag-answer.service.spec\|rag-context.spec\|generation/openai-compatible.provider.spec` | 88 tests, 4 suites passed; includes 44 native tests                                                                                           |
| Configuration                          | `configuration/environment.spec.ts` in the earlier targeted API Jest run                                                                      | 92 passed, unaffected by subsequent adapter-only changes                                                                                      |
| SQL checkpoint/index/retrieval/RAG     | Integration Jest `embedding-generation.integration-spec`, then targeted `resumes native Ollama checkpoints` after fixture fixes               | 17 distinct tests verified across full/targeted runs; 1 real-broker test skipped without RabbitMQ                                             |
| Type checking                          | `node node_modules/typescript/bin/tsc --noEmit --incremental false` from API                                                                  | Passed                                                                                                                                        |
| Lint                                   | `npm.cmd run lint` from API                                                                                                                   | Passed; final integration fixture separately checked after its last edit                                                                      |
| Build                                  | `npm.cmd run build`, then final `nest.js build` after native request changes                                                                  | Shared packages, API and dedicated worker entry point passed                                                                                  |
| Compiled runtime                       | CommonJS require of built generation factory; inspect emitted native request                                                                  | Loaded; `truncate:false` and `shift:false` emitted                                                                                            |
| Compose configuration                  | `docker compose config --quiet`                                                                                                               | Passed; no services started/credentials printed                                                                                               |
| Real Ollama/Qwen                       | Redacted endpoint-presence inspection                                                                                                         | NOT RUN: no configured endpoint/model/certified production bundle                                                                             |
| Live Qdrant/RabbitMQ/container/browser | Not executed for T03                                                                                                                          | Deterministic/SQL evidence above is not live service/browser certification; Docker daemon limitation recorded in T02 remains outside this run |

The first new combination fixture omitted the cloud response model field and was
corrected to the existing validated protocol. Parameterizing SQL tests revealed
shared-profile uniqueness and overly broad checkpoint assertions: fixtures now
reuse immutable profiles and scope checkpoints to their owner, preserving exact
expected counts. No production checkpoint, authorization or output assertions were
weakened. Existing 15 unaffected SQL cases passed in the full run; only the two
affected combination cases were rerun after corrections. Previously verified T02
provider/recovery suites, clean migrations and unrelated browser suites were not
repeated. No schema or migration changed.

## T03 file and completion record

Created:

- `apps/api/src/infrastructure/generation/generation-provider.factory.ts`
- `apps/api/src/infrastructure/generation/local-tokenizer.ts`
- `apps/api/src/infrastructure/generation/ollama.provider.ts`
- `apps/api/src/infrastructure/generation/ollama.provider.spec.ts`
- `apps/api/test/ollama-generation.fixture.ts`
- `docs/local-generation.md`

Modified for T03: API `configuration/settings.ts`, `environment.ts` and its tests;
AI `generation-provider.ts`, `rag-context.ts`, `rag-answer.service.ts`, `rag.module.ts`;
the existing embedding integration fixture; `.env.example`, `docker-compose.yml`;
root README, documentation/developer/ADR indexes, architecture, deployment variables,
roadmap, ADR-006 and the v1.3.1 development guide. Pre-existing T01/T02 working-tree
changes are preserved. No dependency changes in T03: reuse the T02 tokenizer.

**T03 implementation and available deterministic/SQL verification complete.** No
remaining observed code/test blocker. Live Qwen/schema/thinking/tokenizer parity,
network/container/browser certification and model resource behavior remain unverified.
Provision a certified model bundle before enabling local generation. The restricted
framing representation is the documented T01 concretization, not a universal model
template engine. OpenAI adapter, public responses, authorization and frontend code
remain unchanged. Next: T04 configuration/deployment consolidation; do not repeat
provider implementation.

Frontend DTOs/source routes are unchanged. Provider-neutral contract tests exercise
the same response; browser/model/network/GPU certification is not established by
deterministic tests. Live smoke testing is NOT RUN; no private data, model downloads
or paid calls. [T04 configuration/networking](local-provider-configuration.md) is now
implemented; live connectivity remains unverified. T05 installed-model/security/recovery
verification and T06 release documentation remain **PLANNED**. No commit/tag/deploy.
