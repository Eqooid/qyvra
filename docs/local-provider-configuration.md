# v1.3.1 T04 — Provider configuration and Docker networking

**Implemented:** shared endpoint/credential validation, disabled-provider startup
safety, optional read-only asset/private-network and Linux host-access overrides,
configuration/security tests. **Not released.** [T05](local-provider-verification.md)
now verifies Docker Desktop host connectivity, the pinned model pair and actual
local workflow. The T04 ledger below retains its original test environment results.

[T01 audit](developer/versions/v1.3.1.md) | [T02 embeddings](local-embeddings.md) |
[T03 generation](local-generation.md) | [Compose operations](compose.md)

## Authoritative configuration

API and worker use the same [ConfigurationModule](../apps/api/src/configuration/configuration.module.ts)
and [validateEnvironment](../apps/api/src/configuration/environment.ts). Embedding
provider/model/dimensions/revision/tokenizer/preprocessing belong to the immutable
**PostgreSQL embedding profile**, selected by `EMBEDDING_PROFILE_FINGERPRINT`.
Ingestion selects `AI_INGESTION_PROFILE_FINGERPRINT` under existing cutover rules.
Do not invent `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS` or
BASE_URL variables: they would compete with existing source-of-truth identity.
The shared worker/query factory dispatches the SQL profile's `provider`.

Generation independently uses `GENERATION_PROVIDER` (`openai-compatible` default,
or `ollama`), `GENERATION_MODEL` and its own endpoint/credentials/budgets. Changing
generation does not change ingestion, profiles, checkpoints, collections or active
index generations. Embedding identity changes require a new immutable fingerprint
and compatible generation/index transition, even when dimensions match. Positive
dimensions, nonempty model metadata and profile identity remain enforced by domain
validation and the existing database constraints; provider response dimensions are
also checked before checkpointing/querying. Unknown embedding providers fail safely
when the profile is resolved; environment validation cannot validate SQL rows offline.

## Four provider combinations

Combine one embedding column with one generation column; do not create four copies
of the entire environment. Set existing search/index/RAG flags and calibrate
`SEMANTIC_SEARCH_MIN_SCORE` before using document Q&A.

| Setting                         | OpenAI cloud embedding                             | Native Ollama embedding                                             |
| ------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------- |
| SQL profile provider            | `openai-compatible`                                | `ollama`                                                            |
| SQL model/dimensions            | Exact configured cloud model and actual dimensions | Exact installed embedding model and actual dimensions               |
| SQL revision/tokenizer          | Existing compatible profile conventions            | Pinned installed digest/local tokenizer identity; see T02           |
| `EMBEDDING_ENABLED`             | `true`                                             | `true`                                                              |
| `EMBEDDING_PROFILE_FINGERPRINT` | Fingerprint of persisted cloud profile             | Fingerprint of persisted native profile                             |
| `EMBEDDING_ENDPOINT`            | `https://api.openai.com/v1/embeddings`             | `http://<trusted-provider-host>:11434/api/embed`                    |
| `EMBEDDING_API_KEY`             | Operator-provided real cloud key                   | Empty, or optional trusted proxy bearer key                         |
| `EMBEDDING_ALLOW_HTTP`          | `false`                                            | `true` only for approved private HTTP                               |
| `EMBEDDING_TOKENIZER_PATH`      | Empty                                              | Absolute certified bundle path, e.g. `/run/qyvra-ai/embedding.json` |

| Setting                     | OpenAI cloud generation                       | Native Ollama generation                                             |
| --------------------------- | --------------------------------------------- | -------------------------------------------------------------------- |
| `GENERATION_PROVIDER`       | `openai-compatible`                           | `ollama`                                                             |
| `GENERATION_MODEL`          | Configured compatible cloud generation model  | Exact installed chat model/tag, such as a certified Qwen variant     |
| `GENERATION_ENDPOINT`       | `https://api.openai.com/v1/chat/completions`  | `http://<trusted-provider-host>:11434/api/chat`                      |
| `GENERATION_API_KEY`        | Operator-provided real cloud key              | Empty, or optional trusted proxy bearer key                          |
| `GENERATION_ALLOW_HTTP`     | `false`                                       | `true` only for approved private HTTP                                |
| `GENERATION_TOKENIZER`      | Model-compatible `cl100k_base` / `o200k_base` | `huggingface-json`                                                   |
| `GENERATION_TOKENIZER_PATH` | Empty                                         | Absolute certified bundle path, e.g. `/run/qyvra-ai/generation.json` |
| `GENERATION_THINK`          | Unused by compatible adapter                  | `false` default; must match certified framing                        |

| Embedding / generation | Select                                            |
| ---------------------- | ------------------------------------------------- |
| OpenAI / OpenAI        | Cloud embedding column + cloud generation column  |
| Ollama / OpenAI        | Native embedding column + cloud generation column |
| OpenAI / Ollama        | Cloud embedding column + native generation column |
| Ollama / Ollama        | Both native columns                               |

Endpoints are **full request URLs**, not base URLs or `/v1` roots. Native proxies
must also forward sibling `/api/tags`. HTTPS is the default. The common validator
rejects URL credentials/query/fragment and unsupported schemes. Enabled operations
against official `api.openai.com` require their own nonempty validated `*_API_KEY`
and HTTPS, including the trailing-dot hostname form. Disabled operations require
no key. Custom OpenAI-compatible endpoints retain optional keys because private
compatible servers can legitimately be unauthenticated; configure credentials
required by the operator's chosen service. No SDK placeholder keys are needed.
There is no silent default switch to Ollama or new embedding-profile identity format.

## Shared settings, startup and readiness

API and worker receive identical embedding endpoint/key/profile/tokenizer/timeout
settings from Compose. Only API receives generation configuration. Web/Nginx receive
no provider credentials or URLs. New T04 setting `LOCAL_AI_ASSETS_DIR` is used only
by the optional Compose override, not NestJS or embedding-profile hashing.

| Existing setting                                           | Bound/default                                                      |
| ---------------------------------------------------------- | ------------------------------------------------------------------ |
| `EMBEDDING_BATCH_SIZE`                                     | Default 32; range 1–128                                            |
| `EMBEDDING_TIMEOUT_MS`                                     | Default 30000; additionally bounded by processing lease policy     |
| `EMBEDDING_MAX_INPUT_TOKENS`, `EMBEDDING_MAX_BATCH_TOKENS` | Existing positive bounds; total must accommodate one allowed input |
| `GENERATION_TIMEOUT_MS`                                    | Default 25000; maximum 60000                                       |
| `GENERATION_MAX_OUTPUT_TOKENS`                             | Default 1024; maximum 4096                                         |
| `RAG_CONTEXT_TOKENS`                                       | Default 8192; maximum 32768; reserve output plus envelope          |
| `RAG_TIMEOUT_MS`                                           | Default 60000; maximum 120000                                      |

No timeout/global resource increases. Choose batch/context/timeout values for the
certified model and hardware; CPU cold starts can exceed allowed request deadlines.
See [embedding limits](phase-4-embedding-generation.md#configuration-and-deployment)
and [native generation budgeting](local-generation.md#pinned-tokenizer-and-framing-bundle).

Invalid environment configuration or enabled local assets fail clearly at startup.
Disabled embeddings now skip unused asset loading, matching disabled generation.
Enabled adapter construction performs no inference/connectivity request: an offline
Ollama server does not itself block application startup. API readiness remains
bootstrap/shutdown plus PostgreSQL; worker readiness remains database plus consumer
readiness. Provider checks are not health dependencies; health checks never generate
embeddings/answers or require model downloads. No new health endpoint is added.

At runtime embedding outages retain PostgreSQL retries/checkpoints; Redis loss is
disposable and RabbitMQ is transport. Native generation remains one bounded attempt
with existing sanitized 503/504/429/502 mappings and citation validation. Unknown
model/configuration/invalid output fail safely; TLS/DNS/connection failures do not
expose private endpoints, credentials or stack traces. Original document access
does not depend on inference availability.

## Provision assets and select a deployment

Provision certified tokenizer/framing bundles according to T02/T03, not synthetic
test fixtures. The asset directory contains tokenizer/reference data only, not API
keys, private documents or automatically downloaded model files. Set:

```dotenv
LOCAL_AI_ASSETS_DIR=<absolute-existing-host-asset-directory>
EMBEDDING_TOKENIZER_PATH=/run/qyvra-ai/embedding.json
GENERATION_TOKENIZER_PATH=/run/qyvra-ai/generation.json
```

Only set paths needed by selected providers. Run from the repository root:

```sh
docker compose -f docker-compose.yml -f docker-compose.local-ai.yml config --quiet
docker compose -f docker-compose.yml -f docker-compose.local-ai.yml up -d api worker
```

The override binds an existing directory read-only into API/worker, refuses automatic
creation of a missing host directory, preserves private storage/vector networks, and
adds an **internal `ai_provider` network** for an operator-managed provider container.
Web/Nginx do not join it. Cloud/host/LAN traffic still uses the existing outbound
network. Normal `docker compose up --build -d` remains unchanged and loads neither
override. Use the same explicit file list for later restarts/down operations.

### A — Ollama on the Docker host

Docker Desktop supplies `host.docker.internal`; use it in both full endpoint URLs.
For native Linux Engine, opt into the host-gateway mapping for API/worker:

```sh
docker compose -f docker-compose.yml -f docker-compose.local-ai.yml -f docker-compose.ollama-host.yml up -d api worker
```

This requires an Engine supporting `host-gateway`. Container `localhost` is not the
host. Ollama defaults to loopback binding; configure `OLLAMA_HOST` outside Qyvra so
the Docker bridge/Desktop backend can reach the listener. Prefer a specifically
reachable private interface; if binding `0.0.0.0:11434`, restrict host firewall access
to trusted Docker/LAN sources and do not expose it publicly. Desktop networking,
VPNs and endpoint security differ by platform. See [Docker host networking guidance](https://docs.docker.com/desktop/features/networking/)
and [Ollama listener configuration](https://docs.ollama.com/faq).

### B — Separately managed Ollama container

No Ollama service/profile is bundled: model storage, image versions and hardware
lifecycle belong to the operator. The optional private network is enough to attach
a separately managed container without making inference a mandatory dependency.
Find the chosen project's network with Docker Compose/network inspection; for the
default project it is `qyvra_ai_provider`. Attach the existing Ollama container to
that network with alias `ollama`; endpoints then use `http://ollama:11434/api/embed`
and `/api/chat`. Bind Ollama to the container's reachable interface and retain
operator-managed persistent model storage. Publish **no host port**, add no Nginx
route, and use no GPU setting unless separately managed. The internal network has
no external egress; model installation is an explicit external operational task,
never a Qyvra startup/test step. Joining another Compose project should use this
existing network as an explicit external network. Do not share database/storage
networks unnecessarily.

### C/D — Trusted LAN or remote server

Use operator-selected DNS/address and full native URLs. Permit API/worker outbound
traffic and provider inbound traffic only from approved sources. LAN HTTP requires
explicit opt-in and firewall segmentation. For remote sensitive traffic use HTTPS
with trusted certificates and authenticating proxy/private networking; optional
bearer keys remain server-only. Do not disable TLS verification. The browser never
talks directly to the provider; request DTOs cannot supply endpoints. Trusted
operator configuration does not replace network egress controls against SSRF.

## Connectivity, restart and troubleshooting

Use a metadata-only probe from each already-running API/worker container. The
following prints only HTTP status, never endpoint, headers, credentials or model
catalog; it does not call inference:

```sh
docker compose exec -T api node -e "const u=new URL(process.env.GENERATION_ENDPOINT);u.pathname=u.pathname.replace(/chat$/, 'tags');fetch(u,{redirect:'error',signal:AbortSignal.timeout(5000),headers:process.env.GENERATION_API_KEY?{Authorization:'Bearer '+process.env.GENERATION_API_KEY}:{}}).then(r=>{console.log(r.status);process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"
docker compose exec -T worker node -e "const u=new URL(process.env.EMBEDDING_ENDPOINT);u.pathname=u.pathname.replace(/embed$/, 'tags');fetch(u,{redirect:'error',signal:AbortSignal.timeout(5000),headers:process.env.EMBEDDING_API_KEY?{Authorization:'Bearer '+process.env.EMBEDDING_API_KEY}:{}}).then(r=>{console.log(r.status);process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"
```

These native-only examples assume that operation selects Ollama. Include override
files in the command when that is how services were created. A 200 response proves
metadata reachability only; separately inspect availability/digest/capabilities via
trusted operator tools and certify tokenizer/framing parity before inference.

After generation-only environment/asset changes, recreate API (`up -d api` with the
same file list); embedding changes require API and worker restart plus existing
profile enrollment/index cutover. Do not delete volumes or silently re-embed old
profiles. Restart containers to reload immutable bundles; `restart` alone does not
apply new environment values. API/worker run as non-root: asset permissions must
allow their configured container user to read the bundle.

Connection refused: check listener binding, metadata route and firewall. DNS failure:
check service alias/shared network or host-gateway override. TLS failure: fix CA/proxy
configuration. Missing key: provide only the affected official cloud operation key.
Unknown model/digest or token mismatch: correct/certify installed tag and matching
bundle rather than weaken validation. Empty/missing assets: fix host path/permissions
or clear unused provider paths. Avoid full `compose config`/environment dumps in
shared logs: they include resolved secrets; use `config --quiet` instead.

## Verification and completion record

New tests cover all four shared
configurations, official-only key requirements, native no-key operation, invalid
provider/model/URL/resource limits, offline construction, disabled asset safety,
profile isolation and generation independence. Compose checks use synthetic secrets,
never the developer `.env`, and test forwarding, defaults, read-only assets, private
networks, host mapping and no Nginx/browser exposure. The isolated network fixture
uses a model-free Node HTTP server and API/worker-equivalent network probes, not
full application startup. It never pulls images/models and cleans only its unique
test project. Live API/worker boot and real host/LAN/model reachability need available
infrastructure; deterministic configuration tests are not evidence they occurred.

| Check                                  | Executed command/evidence                                                                         | Result                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Shared configuration                   | API Jest `--testPathPattern 'configuration/.*spec'`                                               | 113 passed, 3 suites                                                                           |
| Native embedding/generation regression | API Jest targeted configuration/native adapter run                                                | 31 embedding + 44 generation tests passed; unaffected by subsequent validator-only corrections |
| Cloud generation regression            | API Jest `generation/openai-compatible.provider.spec` in initial targeted run                     | 10 passed                                                                                      |
| Cloud embeddings/readiness             | API Jest `embeddings/openai-compatible.provider.spec\|health.service.spec\|worker-readiness.spec` | 18 passed, 3 suites                                                                            |
| Type check                             | API `node node_modules/typescript/bin/tsc --noEmit --incremental false`                           | Passed                                                                                         |
| Lint                                   | API `npm.cmd run lint`                                                                            | Passed                                                                                         |
| Shared packages/API/worker build       | API `npm.cmd run build`                                                                           | Passed; dedicated worker compiled from the existing API build                                  |
| Compose forwarding/security/topology   | `node --test infrastructure/docker/local-provider-config.test.cjs`                                | 9 passed; 1 live Docker network test skipped                                                   |
| Live Docker networking/API/worker boot | Docker availability check, isolated fixture gate                                                  | NOT RUN: `dockerDesktopLinuxEngine` pipe unavailable; no images pulled or containers started   |
| Real Ollama/models/host/LAN            | No configured live endpoint/model used                                                            | NOT RUN; no model downloads or private document/provider calls                                 |
| Browser/client bundles                 | Compose environment, web Dockerfile and tracked web source review                                 | Provider settings absent; no frontend change/build/browser suite in T04                        |

There are **216 distinct passing unit tests across focused runs**; repeated passing
cases are counted once. No entire Phase 4 E2E or previously verified migrations/SQL
recovery suite was rerun. The initial helper typing error was fixed to the existing
unknown-valued environment contract. Compose test assertions were corrected to its
actual normalized representation (false bind flags are omitted, host mappings are
arrays); topology/security requirements remain asserted. Docker detection now uses
server-version availability instead of relying on `docker info`'s formatted exit
status. No application behavior was weakened to obtain passing tests.

## Files, decisions and remaining verification

Created:

- `apps/api/src/configuration/local-provider-configuration.spec.ts`
- `docker-compose.local-ai.yml`
- `docker-compose.ollama-host.yml`
- `infrastructure/docker/local-provider-config.test.cjs`
- `infrastructure/test/local-provider-network.compose.yml`
- `docs/local-provider-configuration.md`

Modified for T04: `apps/api/src/configuration/environment.ts`, shared embedding
factory, `.env.example`, root README, documentation/developer indexes, v1.3.1 guide,
roadmap, architecture, Compose/environment guides and current local embedding and
generation guides. Existing T01–T03 working-tree changes are preserved. Main Compose,
provider algorithms, public API/frontend, SQL schema and profile serialization are
unchanged by T04.

The only new setting is Compose-only `LOCAL_AI_ASSETS_DIR`. Defaults remain
backward compatible; the intentional stricter rule is a key/HTTPS requirement for
**enabled official OpenAI endpoints** that previously could start and then fail
remotely. Unauthenticated private compatible/Ollama operation is retained. No
optional Ollama service is added: operator-managed inference avoids image/model/GPU
lifecycle coupling. Host mapping and private mounts/network are opt-in overrides.

**T04 implementation and deterministic verification are complete. Live infrastructure
acceptance is not fully verified.** Remaining blockers to that verification are the
unavailable Docker engine and absence of a configured certified live Ollama model.
Host-gateway/listener/firewall, remote TLS/auth, actual application container boot and
installed-model behavior must be checked in a suitable environment. No observed
unresolved code/test defect remains. No release readiness claim is made.

No migrations, new AI providers, GPU dependencies, public ports, frontend changes,
profile identity changes, model installation or release action. Historical v1.3.0
documentation remains intact. Next: T05 security/recovery and optional real-model
verification; do not recreate completed provider/configuration functionality.
