# T11 — AI Search and authorized citation navigation

**Implemented and verified 7 October 2026.** [T12 acceptance](phase-4-verification.md)
is complete with known non-blocking limitations; v1.3.0 release publication remains
**Planned**. This slice adds no dependencies, migrations,
provider adapters, retrieval algorithms, new job system or chat persistence.

## Routes and product behavior

The authenticated `/ai` page appears once as **AI Search** in the existing
sidebar. Its **Semantic search** and **Ask documents** modes consume T09 and T10
respectively. Questions are trimmed, required and bounded to 4000 UTF-16 units.
Submission is explicit; there is no automatic search, conversation history,
streaming, tool execution or implicit memory. Changing modes clears the previous
result. A new submission replaces the previous answer. Submissions are guarded
against duplicates; cancellation and unmount abort transport and ignore late
responses. Questions and answers stay in page-local state, not URLs or storage.

Search cards show canonical title, version, pages and a bounded visible excerpt,
with **View source**. Cosine scores, profile/index identifiers and infrastructure
details are not presented as product concepts. Zero matches are an ordinary empty
state. Grounded Q&A shows a plain-text answer and a source list. Insufficient
evidence is an ordinary result, distinct from network, rate-limit, invalid-output
or provider errors. Safe error messages leave original documents accessible.

## Rendering and citation details

React renders generated text literally; no HTML/Markdown interpreter,
`dangerouslySetInnerHTML`, URL autolinking or model-supplied navigation is used.
Only canonical `[S1]`-style tokens matching the validated T10 citation array become
buttons. Repeated and nonsequential tokens work. Unknown `[S999]`, malformed
markers, embedded HTML and URLs remain text. Missing/duplicate source IDs or
claim references outside the citation array fail response validation.

The existing Sheet primitive presents **Source S1**, current canonical title,
exact version, filename, truthful page numbers and the cited excerpt. Opening it
performs a new authenticated source request. A bounded RAG excerpt is compared
with the exact Unicode scalar range of the full canonical chunk, including clipped
page spans; comparing the full-chunk hash to a shortened excerpt hash would be
incorrect. The Sheet displays the verified cited range and links to the owned
source route. Deleted, archived, foreign, changed or unavailable sources expose
no excerpt/link and show a safe unavailable message.

`/documents/:documentId/versions/:versionId/sources/:chunkId` is a frontend route
inside the existing protected document layout. It loads the exact chunk through
the backend, displays canonical text and source metadata, and links to document
details and version history. It preserves historical version identity rather than
substituting the latest file. Direct PDF page viewing and historical file download
remain **Planned**; the page states this limitation. Retained historical chunks
can be inspected even when their old index is no longer queryable.

## Minimal additive backend contract

`GET /api/v1/documents/:documentId/versions/:versionId/chunks/:chunkId` returns
the standard no-store `{data,meta}` envelope:

```text
data: {documentId, documentVersionId, chunkId, chunkOrdinal, title,
       versionNumber, originalFilename, pageSpans,
       excerptStart, excerptEnd, excerptHash, excerpt}
pageSpan: {pageNumber, startOffset, endOffset}
```

IDs are Qyvra UUIDs. Offsets are half-open Unicode scalar positions in canonical
extracted text; page numbers are one-based and chunk ordinals zero-based. SQL
checks the exact owned document/version/chunk tuple, active document lifecycle and
complete chunk set before returning text. Ownership comes only from the session.
No index-currentness check is required for retained historical provenance.
Missing, mismatched, archived, deleted and foreign sources share 404; anonymous
requests get 401; malformed UUIDs or any query/body get 400. No storage key, vector,
profile, owner ID or provider response is returned. OpenAPI documents the fields.

The existing owned version processing-status response adds `aiReadiness`:

| Value       | Product meaning                                                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| READY       | Current active owned version has a complete READY manifest through its SQL ready pointer, using the serving profile compatible with the API's embedding fingerprint; semantic search is enabled. |
| PROCESSING  | No eligible ready pointer; desired run is BUILDING.                                                                                                                                              |
| FAILED      | No eligible ready pointer; desired run failed, including extraction/no-text terminal failures.                                                                                                   |
| UNSUPPORTED | Active file is not a supported PDF.                                                                                                                                                              |
| UNAVAILABLE | Archived/ineligible/unconfigured, or no eligible ready data.                                                                                                                                     |

A run label of READY alone never establishes search readiness. A retained valid
pointer may remain READY while a replacement run builds. The readiness read makes
no provider or Qdrant request, so it describes durable eligibility, not remote
service health. Outages still produce safe search/Q&A errors. A subsequent upload
immediately removes the old version from retrieval eligibility, while owned
retained source navigation remains possible.

## Preparation and reprocessing

Document detail adds an **AI preparation** section, using the same owner/version
query key and existing five-second active-job/pipeline polling as the Phase 3
processing view. It shows authoritative readiness without interpreting task
completion as index activation. Pending stages and task labels remain distinct
from file-integrity success. Archive changes invalidate the shared status query.

**Reprocess for AI** uses T08's existing current-version endpoint with `mode:repair`.
The shared confirmation dialog explains time and potential provider cost, starts
with Cancel focused, and guards concurrent confirmation. A UUIDv4 idempotency key
survives an ambiguous error/retry; a successful receipt invalidates owned status.
Pending work, archived/unsupported versions and unavailable status disable the
action. A receipt indicates scheduling, never fabricated readiness. There are no
user-facing extraction/profile/index-specific modes in this slice.

## Client, security and accessibility boundaries

HTTP remains in `lib/api`; AuthApi retains credentialed cookies, no-store reads,
serialized session refresh and CSRF headers on mutations. Typed request options
add cancellation, per-operation timeout and the idempotency header. Search uses a
70-second client ceiling, answers 130 seconds to accommodate the backend's bounded
maximum; no network/provider automatic retry is added. Zod validates T09/T10/source
schemas, exact identifiers, finite scores, ranges, page spans and citation refs.
Processing-schema additions remain compatible with older status responses.

AI result state is reset across authenticated owner changes. Source query keys
include owner and exact source tuple, with zero stale/cache retention and no error
retry. 401 after the shared refresh path clears session state. Every source opens
through SQL authorization again; browser schema validation never grants access.
The browser calls only Qyvra. Qdrant/providers/RabbitMQ/Redis and API keys remain
server-only. Logs and browser tests record no real document bodies, credentials,
request traces, answer transcripts or screenshots containing real documents.

Inputs have labels, validation messages and keyboard submission; mode buttons use
`aria-pressed`, loading uses polite status and errors use alerts. Citation buttons
have source labels. The Sheet traps focus, dismisses with Escape and returns focus
to the activating citation. Existing theme tokens support light/dark without a
second theme system. Flexible controls, wrapping text and scrollable excerpts fit
narrow screens; source navigation remains keyboard accessible.

## File inventory

Created frontend routes: `apps/web/app/ai/{layout,page}.tsx` and
`apps/web/app/documents/[documentId]/versions/[versionId]/sources/[chunkId]/page.tsx`.
Created features: `features/ai/{ai-page,source-components}.tsx`,
`features/documents/ai-document-status.tsx`; API contract: `lib/api/ai.ts`.
Modified frontend: `components/layout/app-sidebar.tsx`, `features/auth/provider.tsx`,
`features/documents/{document-detail,processing-presentation,processing-status}.tsx`
(presentation is `.ts`), and `lib/api/{client,processing}.ts`.

Created backend: `apps/api/src/modules/documents/citation-source.{controller,service}.ts`
and `citation-source.service.spec.ts`. Modified `documents.module.ts` and
`processing-status.{dto,repository,service}.ts`.
Updated real integration suites: `apps/api/test/{rag-answer,processing-status}.integration-spec.ts`.
Updated frontend presentation test: `apps/web/tests/processing-status.test.tsx`.
Created web tests: `tests/{ai.fixture,ai-client.test,ai.integration.test,ai-source-range.test}`
(`.ts` for fixtures/client, `.tsx` for components), plus `e2e/phase-four-ai.spec.ts`.
Created isolated browser tooling: `infrastructure/e2e/{ai-run,ai-provider}.cjs`
and `ai-compose.yml`. Updated documentation: root `README.md`, `apps/web/README.md`,
`docs/{README,architecture,api,database,roadmap,specification,compose}.md` and
`docs/phase-4-{ai-rag,processing,chunk-generation,embedding-generation,vector-indexing,rag-answers}.md`.
The new canonical T11 guide is this file. Canonical documentation updates are linked from the index;
historical release snapshots are preserved. No production deployment defaults change.

## Verification and remaining scope

The command results below record actual execution. Browser tests use
the actual Docker/Nginx frontend, API, PostgreSQL, RabbitMQ, outbox, worker,
Redis, Qdrant and native HTTP adapters. A deterministic, private HTTP provider
fixture exists only in the explicit isolated test Compose overlay, avoiding paid
services. Browser API traffic is not intercepted. Its fixed vectors/claims test
integration and authorization, not model quality. The normal Compose stack never
loads this provider or enables AI on its behalf.

| Verification                                                    | Executed result                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web `npm run typecheck`, `npm run lint`                         | Passed.                                                                                                                                                                                                                                                                                                                                                                                   |
| Web `npm test -- --maxWorkers=1`                                | Full suite: 21 files, 212 tests passed before the final stage-label addition. Final affected run: 6 files, 40 tests passed, including that additional case.                                                                                                                                                                                                                               |
| Web targeted Prettier check                                     | All created/modified T11 TS/TSX files passed. Full `npm run format:check` found 25 pre-existing unrelated files; each is unchanged relative to HEAD. They were preserved.                                                                                                                                                                                                                 |
| API `npm run typecheck`, `npm run lint`, `npm run format:check` | Passed; shared storage/database builds and Prisma generation also passed.                                                                                                                                                                                                                                                                                                                 |
| API Jest `--runInBand`                                          | 41 suites passed: 416 tests passed, 1 optional Redis test skipped.                                                                                                                                                                                                                                                                                                                        |
| Real PostgreSQL/Qdrant integration                              | T08 ingestion, T09 search and owned processing-status suites passed (22 tests, 2 optional checks skipped). Corrected final T10/T11 RAG/source suite passed (9 tests, 1 optional native-container test skipped). No production constraint was weakened.                                                                                                                                    |
| Docker builds                                                   | API/migration/outbox/worker runtime and final standalone Next.js frontend built. New `/ai` and exact-source routes appear in the production route table.                                                                                                                                                                                                                                  |
| Isolated migrations                                             | All 15 existing migrations applied; subsequent runner startup reported no pending migrations. No T11 migration.                                                                                                                                                                                                                                                                           |
| Compose/Nginx and live OpenAPI                                  | Configuration validated, `nginx -t` passed, source UUID/page schema and processing readiness enum verified on the running API.                                                                                                                                                                                                                                                            |
| Real Chromium T11 workflow                                      | Passed: real PDF uploads through verification/extraction/chunking/embedding/index activation, semantic search, generated grounded answer, Sheet/Open source, higher-scoring foreign vector exclusion, foreign API/page denial, insufficient evidence, repair confirmation, new-version historical provenance, archive revocation, light/dark at 375px, keyboard focus trap/Escape/return. |
| Real Chromium anonymous routes                                  | Passed: `/ai` and exact-source route redirect to login; source API returns 401.                                                                                                                                                                                                                                                                                                           |
| Existing real Phase 3 browser regression                        | Passed: upload/new version, durable verification, original download checksum and foreign/anonymous processing denial.                                                                                                                                                                                                                                                                     |
| Diff and privacy review                                         | `git diff --check` passed; no direct provider/Qdrant browser access, unsafe generated HTML or T11 dependency/migration additions. Historical release snapshots unchanged.                                                                                                                                                                                                                 |

Earlier concurrent runs hit a one-second provider fixture timeout and asynchronous
focus timing; unchanged isolated checks and final runs passed. The first browser
attempts corrected test navigation/Next.js announcer selection and allowed existing
Sheet/sidebar transitions to settle. Initial isolated startup needed Docker Desktop
and profile provisioning before enrollment, as T08 requires. These checks were
diagnosed rather than disabled. The new SQL lifecycle test was corrected to revoke
the serving pointer and preserve archive/status invariants; all constraints remain.
No already-passing unaffected T08/T09/status suite was repeated after fixture-only
corrections. Native provider behavior in browser coverage uses production adapters;
the optional duplicate container tests remained explicitly skipped.

Run from the repository root after installed dependencies/shared database build:

```powershell
node infrastructure/e2e/ai-run.cjs test
```

The runner validates isolation, applies migrations, seeds a test-only immutable
profile and SQL serving configuration before enrollment startup, and runs the
dedicated browser suite. `up`, `build-web`, `validate` and
`down` support diagnosis without rebuilding unrelated passing applications.
The runner forces isolated volume names and test database credentials and clears
inherited provider keys; ambient deployment settings cannot select real data volumes.
Secrets are generated under ignored `.tools`; test volumes stay isolated and are
retained on shutdown. Chromium must be installed using the existing Playwright setup.

**Planned / excluded:** OCR, additional formats, historical binary/PDF page viewer,
chat history/memory, streaming, hybrid search, reranking, agents, tools/actions,
LangChain/LangGraph, Hermes/MCP and office/city visualization. No redesign of
T01–T10 is introduced: T11 concretizes the planned owned source route and adds
durable readiness to the existing status API. [T12](phase-4-verification.md) records
the completed end-to-end, security, lifecycle, outage/recovery and release assessment.
