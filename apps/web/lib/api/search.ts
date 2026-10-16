import { z } from "zod"
import { ApiError, type AuthApi } from "./client"

const uuid = z.string().uuid()
const integer = z.number().int().nonnegative()
export const searchFiltersSchema = z
  .object({
    categoryId: uuid.optional(),
    tagIds: z.array(uuid).min(1).max(10).optional(),
    filename: z.string().trim().min(1).max(200).optional(),
    mimeType: z.enum(["application/pdf", "image/png", "image/jpeg"]).optional(),
  })
  .strict()
export type SearchFilters = z.infer<typeof searchFiltersSchema>
const query = z
  .string()
  .transform((s) => s.normalize("NFC").trim())
  .pipe(
    z
      .string()
      .min(1, "Enter a search query.")
      .max(4000, "Use at most 4000 characters.")
      .refine((s) => !/[\p{Cs}\p{Cc}]/u.test(s), "Remove control characters.")
      .refine(
        (s) => (s.match(/[\p{L}\p{N}]+/gu)?.length ?? 0) <= 64,
        "Use at most 64 words."
      )
  )
export const searchRequestSchema = z
  .object({
    query,
    match: z.enum(["terms", "phrase"]).optional(),
    limit: z.number().int().min(1).max(20).optional(),
    filters: searchFiltersSchema.optional(),
    cursor: z.string().min(1).max(8192).optional(),
  })
  .strict()
export type SearchRequest = z.infer<typeof searchRequestSchema>
export type SearchMode = "keyword" | "hybrid"
export const lexicalReferenceSchema = z.object({
  documentId: uuid,
  documentVersionId: uuid,
  extractedTextId: uuid,
  pageNumber: z.number().int().min(1).max(10000),
  segment: integer.max(10000),
  sourceId: z.string().max(200),
  href: z.string().max(500),
})
export type LexicalReference = z.infer<typeof lexicalReferenceSchema>
const lexicalMatch = z.object({
  kind: z.enum(["metadata", "page"]),
  snippet: z.string().max(1024),
  matchedFields: z.array(z.string().max(100)).max(20),
  pageNumber: z.number().int().positive().optional(),
  ranges: z
    .array(z.object({ start: integer, end: integer }))
    .max(32)
    .optional(),
  source: lexicalReferenceSchema.optional(),
})
const chunkMatch = z.object({
  kind: z.literal("chunk"),
  snippet: z.string().max(1024),
  chunkId: uuid,
  chunkSetId: uuid,
  indexManifestId: uuid,
  embeddingProfileId: uuid,
  startOffset: integer,
  endOffset: integer,
})
export const searchResultSchema = z.object({
  documentId: uuid,
  documentVersionId: uuid,
  projectionId: uuid.optional(),
  versionNumber: z.number().int().positive(),
  title: z.string().max(300),
  originalFilename: z.string().max(255),
  mimeType: z.string().max(100),
  documentType: z.string().max(50),
  status: z.string().max(50),
  categoryId: uuid.nullable(),
  tagIds: z.array(uuid),
  ranking: z.enum(["lexical-bm25", "document-rrf60-v1"]),
  rank: z.number().int().min(1).max(200),
  matches: z.array(z.union([lexicalMatch, chunkMatch])).max(3),
})
export type SearchResult = z.infer<typeof searchResultSchema>
export type SearchMatch = SearchResult["matches"][number]
export const searchResponseSchema = z.object({
  mode: z.literal("hybrid").optional(),
  results: z.array(searchResultSchema).max(20),
  coverage: z.object({
    eligibleDocuments: integer,
    metadataReadyDocuments: integer,
    textReadyDocuments: integer,
  }),
  pagination: z.object({
    nextCursor: z.string().max(8192).nullable(),
    hasMore: z.boolean(),
    paginationAvailable: z.boolean(),
    truncated: z.boolean(),
  }),
})
export type SearchResponse = z.infer<typeof searchResponseSchema>
export function searchDocuments(
  api: AuthApi,
  mode: SearchMode,
  request: SearchRequest,
  signal: AbortSignal
) {
  if (mode !== "keyword" && mode !== "hybrid") throw new ApiError(400)
  const schema = searchResponseSchema.refine(
    (value) =>
      (mode === "hybrid"
        ? value.mode === "hybrid"
        : value.mode === undefined) &&
      value.results.every(
        (result) =>
          result.ranking ===
            (mode === "hybrid" ? "document-rrf60-v1" : "lexical-bm25") &&
          (mode === "hybrid" ||
            result.matches.every((match) => match.kind !== "chunk"))
      )
  )
  return api.mutate(
    `/search/${mode}`,
    "POST",
    schema,
    searchRequestSchema.parse(request),
    { signal, timeoutMs: 70000 }
  )
}
export const suggestionsSchema = z.object({
  suggestions: z
    .array(
      z.object({
        text: z.string().max(200),
        type: z.enum(["title", "issuer", "referenceNumber"]),
        documentId: uuid,
        documentVersionId: uuid,
      })
    )
    .max(10),
})
export type Suggestion = z.infer<
  typeof suggestionsSchema
>["suggestions"][number]
export function suggestSearch(
  api: AuthApi,
  prefix: string,
  filters: SearchFilters,
  signal: AbortSignal
) {
  const safe = query.parse(prefix)
  if (safe.length < 2 || safe.length > 200 || !/[\p{L}\p{N}]/u.test(safe))
    throw new ApiError(400)
  return api.mutate(
    "/search/suggestions",
    "POST",
    suggestionsSchema,
    { prefix: safe, limit: 5, filters: searchFiltersSchema.parse(filters) },
    { signal }
  )
}
export const lexicalSourceSchema = z
  .object({
    documentId: uuid,
    documentVersionId: uuid,
    extractedTextId: uuid,
    versionNumber: z.number().int().positive(),
    title: z.string().max(300),
    originalFilename: z.string().max(255),
    pageNumber: z.number().int().min(1).max(10000),
    segment: integer.max(10000),
    excerpt: z.string().max(16384),
    excerptHash: z.string().regex(/^[0-9a-f]{64}$/),
    startOffset: integer,
    endOffset: integer,
    nextSegment: integer.max(10000).nullable(),
    previousSegment: integer.max(10000).nullable(),
  })
  .refine((s) => s.endOffset - s.startOffset === Array.from(s.excerpt).length)
export function lexicalSourcePath(reference: LexicalReference) {
  const r = lexicalReferenceSchema.parse(reference)
  return `/documents/${r.documentId}/versions/${r.documentVersionId}/extractions/${r.extractedTextId}/pages/${r.pageNumber}/segments/${r.segment}`
}
export async function getLexicalSource(
  api: AuthApi,
  reference: LexicalReference,
  signal: AbortSignal
) {
  const value = (
    await api.get(
      lexicalSourcePath(reference),
      z.object({ data: lexicalSourceSchema }),
      { signal }
    )
  ).data
  if (
    value.documentId !== reference.documentId ||
    value.documentVersionId !== reference.documentVersionId ||
    value.extractedTextId !== reference.extractedTextId ||
    value.pageNumber !== reference.pageNumber ||
    value.segment !== reference.segment
  )
    throw new ApiError(502)
  return value
}
export function searchError(error: unknown) {
  if (!(error instanceof ApiError))
    return "Check your query and filters, then try again."
  switch (error.status) {
    case 400:
      return "Check your query and filters, or restart the search."
    case 404:
      return "This source or document is no longer available to you."
    case 409:
      return "This result window has expired or changed. Restart the search."
    case 503:
      return "This search mode is currently unavailable. Try again later."
    case 504:
      return "Search took too long. Try again."
    default:
      return error.message
  }
}
