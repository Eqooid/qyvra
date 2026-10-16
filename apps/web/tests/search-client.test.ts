import { expect, it, vi } from "vitest"
import { AuthApi } from "@/lib/api/client"
import {
  getLexicalSource,
  lexicalSourcePath,
  searchDocuments,
  searchRequestSchema,
  searchResponseSchema,
  suggestSearch,
} from "@/lib/api/search"
import {
  reference,
  lexicalSource,
  searchResponse,
  searchJson,
} from "./search.fixture"

it("uses authenticated POST, CSRF, no-store, normalized query and unchanged cursor/filter contracts", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => searchJson(searchResponse))
  const api = new AuthApi("/api/v1", fetcher),
    signal = new AbortController().signal
  await searchDocuments(
    api,
    "keyword",
    {
      query: "  cafe\u0301  ",
      limit: 10,
      cursor: "opaque",
      filters: { mimeType: "application/pdf" },
    },
    signal
  )
  const [url, init] = fetcher.mock.calls[0]
  expect(url).toBe("/api/v1/search/keyword")
  expect(init).toMatchObject({
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: { "X-CSRF-Protection": "1" },
  })
  expect(JSON.parse(init!.body as string)).toEqual({
    query: "café",
    limit: 10,
    cursor: "opaque",
    filters: { mimeType: "application/pdf" },
  })
})
it.each(["", "   ", "x".repeat(4001), "a\nword", "\ud800", "word ".repeat(65)])(
  "rejects invalid query %j",
  (query) => {
    expect(searchRequestSchema.safeParse({ query }).success).toBe(false)
  }
)
it("rejects unknown request fields and invalid limits and identifiers", () => {
  for (const request of [
    { query: "ok", index: "private" },
    { query: "ok", limit: 21 },
    { query: "ok", filters: { categoryId: "bad" } },
    { query: "ok", mode: "semantic" },
  ])
    expect(searchRequestSchema.safeParse(request).success).toBe(false)
})
it("validates result payloads instead of accepting raw search engine responses", () => {
  expect(searchResponseSchema.safeParse(searchResponse).success).toBe(true)
  expect(searchResponseSchema.safeParse({ hits: [] }).success).toBe(false)
})
it("requires the requested mode and ranking contract instead of silently accepting a keyword downgrade", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => searchJson(searchResponse))
  const api = new AuthApi("/api/v1", fetcher),
    signal = new AbortController().signal
  await expect(
    searchDocuments(api, "hybrid", { query: "private" }, signal)
  ).rejects.toMatchObject({ status: 502 })
  fetcher.mockResolvedValueOnce(
    searchJson({
      ...searchResponse,
      mode: "hybrid",
      results: [{ ...searchResponse.results[0], ranking: "document-rrf60-v1" }],
    })
  )
  expect(
    await searchDocuments(api, "hybrid", { query: "private" }, signal)
  ).toMatchObject({ mode: "hybrid" })
})
it("bounds and authenticates private suggestions", async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    searchJson({ suggestions: [] })
  )
  const api = new AuthApi("/api/v1", fetcher),
    signal = new AbortController().signal
  await suggestSearch(api, "  report  ", {}, signal)
  expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual({
    prefix: "report",
    limit: 5,
    filters: {},
  })
  expect(() => suggestSearch(api, "x", {}, signal)).toThrow()
})
it("rebuilds source paths from validated identity, ignoring supplied href and checking response identity", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => searchJson(lexicalSource))
  const api = new AuthApi("/api/v1", fetcher),
    signal = new AbortController().signal
  expect(lexicalSourcePath(reference)).toMatch(
    /^\/documents\/.+\/pages\/2\/segments\/0$/
  )
  expect(await getLexicalSource(api, reference, signal)).toMatchObject({
    excerpt: "Exact page two",
  })
  expect(fetcher.mock.calls[0][0]).not.toContain("untrusted")
  fetcher.mockResolvedValueOnce(searchJson({ ...lexicalSource, pageNumber: 3 }))
  await expect(getLexicalSource(api, reference, signal)).rejects.toMatchObject({
    status: 502,
  })
})
