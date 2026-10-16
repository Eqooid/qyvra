# Phase 5 T04 — Private Elasticsearch adapter and deployment configuration

Status: **Implemented and locally verified; live acceptance pending.**
`VERSION` remains `1.3.1`; Phase 5 targets `v1.4.0` and is not released.
[T01](phase-5-search.md#t04--private-elasticsearch-adapter-and-deployment-configuration),
[T02](phase-5-data-foundation.md) and [T03](phase-5-search-enrollment.md) own the
approved scope and persistent processing boundary. No production search handler,
extraction, public search endpoint, frontend, enrollment change or SQL migration
is introduced by T04. T03's production search dispatch capabilities stay empty.

## Adapter and integration boundaries

`infrastructure/search/LexicalStoreModule` exports the `LEXICAL_STORE` token.
Existing API `SearchModule` and `WorkerModule` import it, sharing one implementation
and neutral TypeScript contracts. They do not call it during startup or register
search handlers. Outbox, frontend, providers and Nginx receive no search credentials.
The official client is confined to this infrastructure boundary.

| Internal operation | Implemented behavior |
| --- | --- |
| `availability` | Authenticated product/version, auto-create policy and cluster health checks; no index mutation. |
| `inspect` | Exact index existence, mapping metadata/properties, strict dynamic policy and analyzer inspection; reports missing/incompatible separately. |
| `createIndexes` | Explicit metadata/page index creation only when invoked; preserves and validates existing indexes instead of deleting/recreating them. |
| `upsert` | Deterministic exact-ID bulk writes, schema/lineage validation, compatible existing indexes, bounded request, every item checked, `refresh=wait_for`. |
| `verify` | Bounded exact-ID reads validating owner/version/projection/revision/generation and record identity; missing IDs are represented by absence. |
| `remove` | Validates owned records before exact-ID bulk deletion; repeated missing IDs are harmless. No delete-by-query or index deletion API. |
| `query` | Typed bounded literal terms/phrase/prefix primitives with mandatory user, generation and exact document/version/projection/revision filters. No caller DSL passthrough. |
| `close` | Aborts ongoing operations and closes the injected SDK client on Nest shutdown. |

Inputs come from trusted SQL-authorized services, not HTTP request-provided owner
IDs. Index metadata and adapter filtering **do not provide complete authorization**.
Future application services must validate SQL eligibility, canonical hashes,
publication and ownership before and after returning results. Remote hit lineage
is checked again in the adapter; foreign, malformed, timed-out and partial responses
fail closed. No SQL READY pointer or processing job is completed by this adapter.

There are no SDK automatic retries, endpoint discovery or sniffing. Each request
uses a configured deadline, cancellation signal, response ceiling and fixed
concurrency budget. Concurrent requests above the budget fail predictably without
an unbounded queue. A later caller-initiated request can recover connectivity;
PostgreSQL/outbox still own durable retries. Compound operations contain a bounded
number of requests; callers should propagate their own overall deadline signal.

Errors expose only stable `SEARCH_*` codes. Authentication, TLS, missing index,
contract, incompatibility and conflict are permanent; unavailable, timeout,
rate-limit and capacity failures are retryable. Cancellation is distinct. Raw SDK
errors, authorization headers, document text and request bodies are never logged.

## Version and mapping contracts

Selected client: exact `@elastic/elasticsearch@9.4.0`, lockfile-pinned dependencies.
Selected server: `docker.elastic.co/elasticsearch/elasticsearch:9.4.6`, pinned
multi-platform digest:
`sha256:6650a69591cddfb3afc1a586ce3796c5c0099852d8429fe13e71ec18e0150135`.
The adapter currently accepts server `9.4.x`; Node.js remains the repository's 24+.
The image tag and digest were verified from the official registry on 14 October
2026. **This selection is not live deployment certification.**

Elastic documents same-major forward minor client compatibility; the selected
client/server pair follows that rule. [Official client installation/compatibility](https://www.elastic.co/docs/reference/elasticsearch/clients/javascript/installation),
[official image](https://www.docker.elastic.co/r/elasticsearch/elasticsearch:9.4.6)
and [client timeout/retry options](https://www.elastic.co/docs/reference/elasticsearch/clients/javascript/basic-config)
support the selection. Distribution uses Elastic's published licensing terms;
the local image requests the Basic license and uses ordinary lexical/security
features, without enterprise ranking or hosted inference.
[Official licensing explanation](https://www.elastic.co/pricing/faq/licensing).

Physical names:
`<prefix>-s1-g<generation>-<full-generation-fingerprint>-metadata` and `-pages`.
Prefix defaults to `qyvra-search`, must remain in that family, and is at most 40
characters. No wildcards, arbitrary aliases, paths or untrusted index names are
accepted. `targetFromGeneration` checks immutable SQL names and schema/mapping/analyzer/
segmentation versions at the future SQL-to-adapter boundary. New SQL generations
must persist these exact generated names; T02's
older arbitrary provisioned names are not silently renamed. Serving cutover and
generation provisioning/rebuild remain later tasks.

Schema: `1`; mapping version: `lexical-metadata-pages-v1`; analyzer version:
`unicode-standard-lower-v1`; segmentation version: `scalar-8192-v1`. Both indexes
use `dynamic=strict`, one shard and zero replicas for the single-node development
topology. `_meta` records the contract, versions, generation ID/fingerprint, kind
and mapping hash. Compatibility inspects actual properties/analyzers in addition
to metadata; a claimed matching fingerprint alone is insufficient. Aliases are
not created or accepted by this initial contract.

| Fields | Explicit mapping |
| --- | --- |
| `userId`, document/version/projection/generation IDs, `sourceHash`, kind | `keyword` for exact equality. |
| `revision`, page/segment/scalar offsets | Integers with coercion disabled. |
| Title, description, issuer, reference and filename | Standard Unicode tokenization/lowercase with offsets for future highlighting. |
| `referenceExact` | NFKC/trim/lowercase derived value preserving punctuation, keyword lowercase normalizer. |
| `suggestText` | `search_as_you_type`, copied only from approved metadata fields; no category/tag names or PDF content. |
| MIME type, document type/status, category/tag IDs | Keyword filters. |
| Document/expiration dates, created/updated timestamps | Explicit strict date/date-time formats. |
| File size | Long with coercion disabled. |
| Page text | Bounded text plus immutable page/segment/scalar spans. |

Record IDs reuse T02 `searchRecordId` and deterministic projection identity. Page
segments are at most 8,192 Unicode scalars; the published projection ceiling remains
T02's 10,000 records. No page segmentation algorithm or extraction is implemented
here. Bulk batches are at most 100 records; scopes at most 100 exact tuples; query
text at most 256 UTF-16 units; result count at most 50. Request/response limits can
be lowered within validated ceilings. Text-language quality beyond the initial
standard analyzer and corpus-scale resource budgets require later live evaluation.

Automatic index creation must be disabled with `action.auto_create_index=false`.
Availability/upsert enforce this policy, preventing a missing/deleted index from
silently becoming an uncontrolled dynamic index. Explicit create and verified
mapping compatibility remain separate operations.

## Configuration

All settings are server-only and use existing frozen startup validation.

| Variable | Purpose/default |
| --- | --- |
| `ELASTICSEARCH_ENABLED` | Adapter registration capability, default false; does not enable enrollment, serving or handlers. |
| `ELASTICSEARCH_URL` | Required explicit HTTP(S) endpoint when enabled; no embedded credentials, path, query or fragment. |
| `ELASTICSEARCH_ALLOW_HTTP` | Default false; permits only explicit private development/test HTTP, never production HTTP. |
| `ELASTICSEARCH_USERNAME` + `ELASTICSEARCH_PASSWORD` or `ELASTICSEARCH_PASSWORD_FILE` | Complete Basic authentication; direct/file alternatives are mutually exclusive. |
| `ELASTICSEARCH_API_KEY` or `ELASTICSEARCH_API_KEY_FILE` | Alternative API-key authentication; cannot mix with Basic. |
| `ELASTICSEARCH_CA_FILE` | Optional absolute PEM trust file for HTTPS. Certificate verification is always enabled. |
| `ELASTICSEARCH_INDEX_PREFIX` / `ELASTICSEARCH_SCHEMA_VERSION` | `qyvra-search` / supported schema 1. |
| `ELASTICSEARCH_TIMEOUT_MS` | 10,000; maximum 60,000 ms. |
| `ELASTICSEARCH_MAX_REQUEST_BYTES` | 1,048,576; maximum 1 MiB. |
| `ELASTICSEARCH_MAX_RESPONSE_BYTES` | 4,194,304; maximum 8 MiB, including compressed-response ceiling. |
| `ELASTICSEARCH_BULK_SIZE` / `ELASTICSEARCH_MAX_SCOPES` | 100 / 100 maxima. |
| `ELASTICSEARCH_CONCURRENCY` | 4; maximum 16. |
| `SEARCH_BOOTSTRAP_PASSWORD_FILE` / `SEARCH_RUNTIME_PASSWORD_FILE` | Compose-only existing private files, mounted as separate Docker secrets. |
| `SEARCH_VOLUME_NAME` / `SEARCH_VOLUME_EXTERNAL` | Optional derived volume mapping; default project search_data / false. |

Missing/malformed configuration and unreadable/oversized secret files fail
initialization with sanitized errors. File paths must be absolute inside the
runtime; secret contents are bounded to 8 KiB, CA files to 1 MiB. There is no
default external cluster, credential fallback or TLS verification bypass.
Use scoped API keys or least-privilege Basic credentials for remote production
HTTPS. Mount files read-only and restrict their host permissions; never put them
in a repository or browser environment.

## Optional local deployment

Create two different private password files **outside the repository**, each
containing a separately generated 16–128-character alphanumeric secret. Set their
absolute host paths in `SEARCH_BOOTSTRAP_PASSWORD_FILE` and
`SEARCH_RUNTIME_PASSWORD_FILE`. Do not copy example/test credentials into a real
deployment. The local override is explicitly authenticated HTTP on an internal
network; it is not a production deployment template.

```sh
docker compose -f docker-compose.yml -f docker-compose.search.yml config --quiet
docker compose -f docker-compose.yml -f docker-compose.search.yml up -d elasticsearch
docker compose -f docker-compose.yml -f docker-compose.search.yml run --rm search-setup
docker compose -f docker-compose.yml -f docker-compose.search.yml up --build -d
```

Setup creates the dedicated `qyvra_search` user/role for `qyvra-search-*`: cluster
monitoring, read/write, create-index, metadata inspection and refresh maintenance.
It receives no cluster administration or whole-index deletion permission. Only
Elasticsearch/setup mount the bootstrap secret; API/worker mount the runtime
secret. Setup is repeatable for operator-controlled credential rotation. Ensure
setup succeeds before testing transport; application startup intentionally does
not wait for optional search availability.

Elasticsearch/setup attach only to the internal `search` network. API/worker add
that network while retaining existing networks and resolve `elasticsearch:9200`.
Outbox, PostgreSQL, RabbitMQ, Redis, Qdrant, web and Nginx remain unchanged by the
override. There is no Nginx route or host port. Developer debugging requires the
explicit `docker-compose.search-debug.yml` override, which publishes only
`127.0.0.1:9200`; retain authentication and remove it after debugging.

The named derived-data volume survives container replacement/restart. Do not use
`down --volumes` on a real installation. The local container has a 2 GiB memory
limit, 512 MiB fixed JVM heap, two CPUs and an authenticated cluster healthcheck.
Memory mapping is disabled in this local override to avoid privileged host kernel
changes; production should follow [Elastic virtual-memory guidance](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s/virtual-memory).
Multi-node production sizing, HTTPS/transport certificates, retention and backup
policy require operator configuration; no security mode is silently disabled for
production. Local security autoconfiguration/enrollment are explicitly disabled
because this topology provisions its own credentials and is not public.

## Health, troubleshooting and recovery

Configuration validity, cluster availability and index compatibility are separate
checks. A healthy container is not proof that any projection was indexed or
published. Index creation is explicit; readiness checks never create/delete it.
Existing HTTP readiness remains lifecycle/PostgreSQL-based and worker readiness
remains its existing processing boundary. Temporary Elasticsearch outages do not
gate document CRUD/downloads or independent semantic/RAG workflows.

For authentication failures, confirm setup and the chosen Basic/API-key mode.
For TLS failures, check hostname and trusted CA; do not disable verification.
For incompatible/missing indexes, inspect the generation's exact names, versions,
analyzers and disabled auto-create setting. Do not delete an existing index to
hide incompatibility. Capacity/429/timeout/unavailability are observable retryable
transport failures; future workers must retain their SQL/outbox recovery path.
If a bulk operation partly succeeds, the adapter fails it; callers retry identical
IDs and verify a complete manifest before publishing SQL READY.

## Verification and acceptance

Local verification on 14 October 2026:

| Actual command/check | Result |
| --- | --- |
| API full unit suite (`jest --runInBand` from apps/api) | 562 passed, 1 skipped, 48 suites. Later mapper/secret hardening separately verified below. |
| Focused Elasticsearch adapter/transport/configuration unit suite | 45 passed, 3 suites; includes secret/CA initialization, deterministic SQL-target compatibility, cancellation, real SDK timeout/recovery HTTP fixture and sanitized errors. |
| API HTTP E2E (`jest --config ./test/jest-e2e.json --runInBand`) | 281 passed, 15 suites; mocked service boundaries, not browser verification. |
| Database processing/AI/search tests against disposable PostgreSQL 17 | 76 passed; existing retries, outbox, ownership, lifecycle and T02/T03 search foundations preserved. |
| API SQL search/document/outbox/ES-selected integration suites | 26 passed, 6 skipped; 5 live ES cases skipped without TEST_ELASTICSEARCH_URL and 1 existing live broker case skipped. |
| API formatting, lint and TypeScript checks | Passed using repository commands and tsc --noEmit. |
| API production/shared build | Passed; compiles both API and worker source. |
| `node --test infrastructure/test/search-compose.test.cjs` | 1 passed; private/authenticated topology, loopback debug and all existing services preserved. |
| New YAML, runtime harness and shell syntax | YAML parses; harness passes node --check; both shell scripts pass Git Bash bash -n. |
| `node infrastructure/test/search-runtime.cjs` | Attempted, blocked before container build: default Docker engine named pipe missing. Isolated temporary secret files cleaned up; no application containers deployed. |
| Docker Linux Desktop endpoint probe | Also unavailable; com.docker.service stopped. No real ES/auth/mapping/connectivity/restart pass is claimed. |
| Locked dependency audit | Exactly 7 new entries for the official client dependency; 0 existing locked package versions changed. |
| Documentation checks | 319 local file link targets exist; new guide anchors and next task checked; git diff --check passed. |
| Release preservation | VERSION remains 1.3.1; no release snapshots or historical migrations changed by T04. |

The selected image digest was independently resolved with `docker buildx imagetools
inspect`; this registry read does not require or verify a running container.
Initial test harness configuration/assertion issues were corrected. No introduced
failure remains in the executable local checks; live deployment acceptance and CI
execution remain outstanding.

- [x] Shared private adapter/DI, neutral contracts and strict mapping/name foundations.
- [x] Secure validated credentials/TLS/configuration and explicit optional private topology.
- [x] Bounded scoped operations, per-item failure checks, cancellation and sanitized errors.
- [x] Local unit/SQL/HTTP/Compose compatibility checks and documentation.
- [ ] Real ES mapping/analyzer/phrase/prefix/auth/bulk/visibility acceptance.
- [ ] Container health, API/worker DNS connectivity, persistence/restart and live service regression.
- [ ] CI execution and deployment certification; T04 is not marked fully accepted.

Unit tests include mocked protocol
responses and an actual official-client HTTP fixture; that fixture is **not a real
Elasticsearch server**. `elasticsearch.integration-spec.ts` requires explicit
`TEST_ELASTICSEARCH_URL` and test-only authentication (optional CA); otherwise its
five live tests skip. They use unique isolated indexes and clean up only their
own resources. The suite requires an administrative test credential for mapping
tampering/index cleanup; production runtime credentials remain more restricted.

`node --test infrastructure/test/search-compose.test.cjs` validates merged private
topology without an engine. `node infrastructure/test/search-runtime.cjs` requires
a running Linux Docker engine: it generates ephemeral secrets, validates every
volume name belongs to a unique test project, builds API/worker, starts authenticated
Elasticsearch/setup, probes both runtime DI contexts, runs real mapping/query/
bulk/auth tests and verifies a retained record after restart. Cleanup is restricted
to the validated isolated project/volumes. The Phase 5 CI workflow runs these
checks; adding the workflow does not claim CI has executed successfully.

T04 acceptance remains pending wherever live infrastructure checks cannot execute.
No mocked results substitute for real index behavior, container health, runtime
connectivity or restart persistence.

Next: **T05 — Model-independent PDF text and verified lexical publication**.
Objective: deliver real current-version metadata/PDF projections via workers.

## 16 October deployment correction and live evidence

The Elasticsearch bootstrap entrypoint now copies the read-only Docker secret
into a dedicated private tmpfs path with mode 0600 before invoking the official
entrypoint. This handles Windows-mounted secret permissions without disabling
security or weakening the original secret. The setup script uses LF endings.
Mapping inspection normalizes omitted semantic defaults and scalar/array copy_to,
while retaining checks against incompatible ownership fields and source settings.

The [continuation ledger](phase-5-live-verification.md) supersedes earlier missing
live evidence for authenticated API/worker connectivity, real adapter operations
and index persistence across restart. Full broker/browser acceptance remains open.
A host bridge exists only in the isolated test override; production networking
remains private, with no default host publication or Nginx search-engine route.
