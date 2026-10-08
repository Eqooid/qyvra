import { expect, it, vi } from "vitest"
import { AuthApi, ApiError } from "@/lib/api/client"
import {
  aiQuestionSchema,
  ragAnswerSchema,
  citationSourceSchema,
  semanticSearch,
  askDocuments,
  getCitationSource,
  sourcePath,
  reprocessDocument,
} from "@/lib/api/ai"
import { citation, answer } from "./ai.fixture"
import { id, json } from "./documents.fixture"

it("accepts page provenance through the server's 2000-page configuration limit", () => {
  const source = {
    ...citation,
    excerpt: "x".repeat(2000),
    excerptStart: 0,
    excerptEnd: 2000,
    pageSpans: Array.from({ length: 2000 }, (_, index) => ({
      pageNumber: index + 1,
      startOffset: index,
      endOffset: index + 1,
    })),
  }
  expect(citationSourceSchema.safeParse(source).success).toBe(true)
  expect(
    citationSourceSchema.safeParse({
      ...source,
      pageSpans: [...source.pageSpans, source.pageSpans[1999]],
    }).success
  ).toBe(false)
})

it("validates bounded questions, canonical provenance and known citation references", () => {
  expect(aiQuestionSchema.parse({ question: "  hello  " }).question).toBe(
    "hello"
  )
  for (const question of ["  ", "x".repeat(4001)])
    expect(aiQuestionSchema.safeParse({ question }).success).toBe(false)
  expect(ragAnswerSchema.parse(answer).outcome).toBe("answered")
  expect(
    ragAnswerSchema.safeParse({ ...answer, citations: [citation, citation] })
      .success
  ).toBe(false)
  expect(
    ragAnswerSchema.safeParse({
      ...answer,
      claims: [{ text: "bad", citationIds: ["S999"] }],
    }).success
  ).toBe(false)
  expect(
    citationSourceSchema.safeParse({ ...citation, excerptEnd: 200 }).success
  ).toBe(false)
  expect(
    citationSourceSchema.safeParse({
      ...citation,
      pageSpans: [{ pageNumber: 999, startOffset: 0, endOffset: 1 }],
    }).success
  ).toBe(false)
  expect(
    ragAnswerSchema.safeParse({
      outcome: "insufficient_evidence",
      answer: null,
      requestId: id,
      reason: "no_authorized_evidence",
      citations: [],
    }).success
  ).toBe(true)
})
it("uses credentialed CSRF transport, cancellation and canonical identifiers without provider overrides", async () => {
  const fetcher = vi.fn<typeof fetch>(async (input) =>
    json({
      data: String(input).endsWith("semantic")
        ? { results: [] }
        : String(input).endsWith("reprocess")
          ? { runId: id, generation: 1, status: "BUILDING" }
          : answer,
    })
  )
  const api = new AuthApi("/api/v1", fetcher),
    controller = new AbortController()
  await semanticSearch(api, "hello", controller.signal)
  await askDocuments(api, "hello", controller.signal)
  await reprocessDocument(
    api,
    citation.documentId,
    citation.documentVersionId,
    id
  )
  for (const [, init] of fetcher.mock.calls) {
    expect(init?.credentials).toBe("include")
    expect(init?.cache).toBe("no-store")
    expect(init?.headers).toMatchObject({ "X-CSRF-Protection": "1" })
    expect(init?.body).not.toMatch(/userId|model|provider|context|history/)
  }
  expect(fetcher.mock.calls[2][1]?.headers).toMatchObject({
    "Idempotency-Key": id,
  })
  const signal = fetcher.mock.calls[0][1]?.signal
  controller.abort()
  expect(signal?.aborted).toBe(true)
  expect(sourcePath(citation)).toContain(
    `/versions/${citation.documentVersionId}/sources/${citation.chunkId}`
  )
})
it("rejects malformed routes and substituted source references", async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    json({ data: { ...citation, documentId: citation.documentVersionId } })
  )
  const api = new AuthApi("/api/v1", fetcher)
  await expect(
    getCitationSource(
      api,
      "../foreign",
      citation.documentVersionId,
      citation.chunkId
    )
  ).rejects.toMatchObject({ status: 404 })
  expect(fetcher).not.toHaveBeenCalled()
  await expect(
    getCitationSource(
      api,
      citation.documentId,
      citation.documentVersionId,
      citation.chunkId
    )
  ).rejects.toBeInstanceOf(ApiError)
})
