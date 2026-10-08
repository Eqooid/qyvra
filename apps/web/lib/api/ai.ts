import { z } from "zod"
import { ApiError, type AuthApi } from "./client"

const uuid = z.string().uuid()
export const pageSpanSchema = z
  .object({
    pageNumber: z.number().int().positive(),
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().nonnegative(),
  })
  .refine((s) => s.endOffset > s.startOffset)
const sourceShape = {
  documentId: uuid,
  documentVersionId: uuid,
  chunkId: uuid,
  chunkOrdinal: z.number().int().nonnegative(),
  title: z.string().max(300),
  versionNumber: z.number().int().positive(),
  originalFilename: z.string().max(255),
  pageSpans: z.array(pageSpanSchema).min(1).max(2000),
  excerptStart: z.number().int().nonnegative(),
  excerptEnd: z.number().int().nonnegative(),
  excerptHash: z.string().regex(/^[0-9a-f]{64}$/),
  excerpt: z.string().min(1).max(65536),
}
const coherent = (s: {
  excerptStart: number
  excerptEnd: number
  excerpt: string
  pageSpans: z.infer<typeof pageSpanSchema>[]
}) =>
  s.excerptEnd - s.excerptStart === Array.from(s.excerpt).length &&
  s.pageSpans.every(
    (p) => p.startOffset >= s.excerptStart && p.endOffset <= s.excerptEnd
  )
export const citationSourceSchema = z
  .object(sourceShape)
  .refine(coherent, "Invalid source provenance")
export const citationSchema = z
  .object({ ...sourceShape, citationId: z.string().regex(/^S[1-9][0-9]*$/) })
  .refine(coherent, "Invalid citation provenance")
export type CitationSource = z.infer<typeof citationSourceSchema>
export type Citation = z.infer<typeof citationSchema>
export const semanticResultSchema = z
  .object({
    chunkId: uuid,
    documentId: uuid,
    documentVersionId: uuid,
    chunkSetId: uuid,
    indexManifestId: uuid,
    embeddingProfileId: uuid,
    chunkOrdinal: z.number().int().nonnegative(),
    title: z.string().max(300),
    originalFilename: z.string().max(255),
    versionNumber: z.number().int().positive(),
    excerpt: z.string().min(1).max(65536),
    excerptHash: sourceShape.excerptHash,
    startOffset: sourceShape.excerptStart,
    endOffset: sourceShape.excerptEnd,
    pageSpans: sourceShape.pageSpans,
    score: z.number().finite(),
  })
  .refine((s) =>
    coherent({ ...s, excerptStart: s.startOffset, excerptEnd: s.endOffset })
  )
export type SemanticResult = z.infer<typeof semanticResultSchema>
export const ragAnswerSchema = z
  .discriminatedUnion("outcome", [
    z.object({
      outcome: z.literal("answered"),
      answer: z.string().min(1).max(40000),
      requestId: uuid,
      claims: z
        .array(
          z.object({
            text: z.string().min(1).max(2048),
            citationIds: z.array(z.string()).min(1).max(20),
          })
        )
        .min(1)
        .max(64),
      citations: z.array(citationSchema).min(1).max(20),
    }),
    z.object({
      outcome: z.literal("insufficient_evidence"),
      answer: z.null(),
      requestId: uuid,
      citations: z.array(z.never()).length(0),
      reason: z.enum([
        "no_authorized_evidence",
        "context_budget",
        "model_insufficient_evidence",
        "evidence_changed",
      ]),
    }),
  ])
  .superRefine((v, ctx) => {
    if (v.outcome !== "answered") return
    const ids = new Set(v.citations.map((c) => c.citationId))
    if (
      ids.size !== v.citations.length ||
      v.claims.some((c) => c.citationIds.some((id) => !ids.has(id)))
    )
      ctx.addIssue({ code: "custom", message: "Invalid citation references" })
  })
export type RagAnswer = z.infer<typeof ragAnswerSchema>
export const aiQuestionSchema = z.object({
  question: z
    .string()
    .trim()
    .min(1, "Enter a question.")
    .max(4000, "Use at most 4000 characters."),
})
const input = (question: string, documentIds?: string[]) => ({
  question: aiQuestionSchema.parse({ question }).question,
  ...(documentIds
    ? { documentIds: z.array(uuid).min(1).max(50).parse(documentIds) }
    : {}),
})
export function semanticSearch(
  api: AuthApi,
  question: string,
  signal: AbortSignal,
  documentIds?: string[]
) {
  const safe = input(question, documentIds)
  return api.mutate(
    "/search/semantic",
    "POST",
    z.object({ results: z.array(semanticResultSchema).max(20) }),
    {
      query: safe.question,
      ...(safe.documentIds ? { documentIds: safe.documentIds } : {}),
    },
    { signal, timeoutMs: 70000 }
  )
}
export function askDocuments(
  api: AuthApi,
  question: string,
  signal: AbortSignal,
  documentIds?: string[]
) {
  return api.mutate(
    "/rag/answers",
    "POST",
    ragAnswerSchema,
    input(question, documentIds),
    { signal, timeoutMs: 130000 }
  )
}
export function sourcePath(
  s: Pick<CitationSource, "documentId" | "documentVersionId" | "chunkId">
) {
  return `/documents/${uuid.parse(s.documentId)}/versions/${uuid.parse(s.documentVersionId)}/sources/${uuid.parse(s.chunkId)}`
}
export async function getCitationSource(
  api: AuthApi,
  documentId: string,
  versionId: string,
  chunkId: string,
  signal?: AbortSignal
) {
  if (
    ![documentId, versionId, chunkId].every((id) => uuid.safeParse(id).success)
  )
    throw new ApiError(404)
  const value = (
    await api.get(
      `/documents/${documentId}/versions/${versionId}/chunks/${chunkId}`,
      z.object({ data: citationSourceSchema }),
      { signal }
    )
  ).data
  if (
    value.documentId !== documentId ||
    value.documentVersionId !== versionId ||
    value.chunkId !== chunkId
  )
    throw new ApiError(502)
  return value
}
export function reprocessDocument(
  api: AuthApi,
  documentId: string,
  versionId: string,
  key: string
) {
  return api.mutate(
    `/documents/${uuid.parse(documentId)}/versions/${uuid.parse(versionId)}/ai/reprocess`,
    "POST",
    z.object({
      runId: uuid,
      generation: z.number().int().positive(),
      status: z.enum([
        "BUILDING",
        "READY",
        "FAILED",
        "CANCELLED",
        "SUPERSEDED",
      ]),
    }),
    { mode: "repair" },
    { headers: { "Idempotency-Key": uuid.parse(key) } }
  )
}
export function aiError(error: unknown) {
  if (!(error instanceof ApiError))
    return "The response could not be read. Please try again."
  if (error.status === 404)
    return "This source is unavailable or you no longer have access."
  if (error.status === 502)
    return "The answer or source response could not be validated. Please try again."
  if (error.status === 503)
    return "AI search or answers are currently unavailable. Your original documents remain accessible."
  if (error.status === 504)
    return "The request took too long. Please try again."
  if (error.status === 409)
    return "This document is already being prepared or is no longer eligible. Refresh its status."
  if (error.status === 400)
    return "Check your question or document selection and try again."
  return error.message
}
