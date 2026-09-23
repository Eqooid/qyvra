import { z } from "zod"
import { AuthApi, ApiError } from "./client"

export const tagSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export const categorySchema = tagSchema.extend({
  color: z.string().nullable(),
  icon: z.string().nullable(),
})
const documentSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  documentType: z.string(),
  status: z.string(),
  issuer: z.string().nullable(),
  referenceNumber: z.string().nullable(),
  documentDate: z.string().nullable(),
  expirationDate: z.string().nullable(),
  isArchived: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  category: categorySchema.nullable(),
  tags: z.array(tagSchema),
})
const page = <T>(schema: z.ZodType<T>) =>
  z.object({
    data: z.array(schema),
    meta: z.object({
      requestId: z.string(),
      nextCursor: z.string().nullable(),
      hasMore: z.boolean(),
    }),
  })
export type DocumentItem = z.infer<typeof documentSchema>
const detailSchema = documentSchema.extend({
  verifiedSummary: z.string().nullable(),
  deletedAt: z.string().nullable(),
})
export type DocumentDetail = z.infer<typeof detailSchema>
export type DocumentPatch = Partial<{
  title: string
  documentType: string
  issuer: string | null
  referenceNumber: string | null
  documentDate: string | null
  expirationDate: string | null
  categoryId: string | null
  tagIds: string[]
}>
function documentPath(id: string) {
  if (!z.string().uuid().safeParse(id).success) throw new ApiError(404)
  return `/documents/${id}`
}
export const getDocument = async (api: AuthApi, id: string) =>
  (await api.get(documentPath(id), z.object({ data: detailSchema }))).data
export const updateDocument = (
  api: AuthApi,
  id: string,
  body: DocumentPatch
) => {
  // Explicit allowlist also protects callers that pass wider objects at runtime.
  const safe: DocumentPatch = {}
  for (const key of [
    "title",
    "documentType",
    "issuer",
    "referenceNumber",
    "documentDate",
    "expirationDate",
    "categoryId",
  ] as const) {
    const value = body[key]
    if (value !== undefined) Object.assign(safe, { [key]: value })
  }
  if (body.tagIds !== undefined) safe.tagIds = [...new Set(body.tagIds)]
  return api.mutate(documentPath(id), "PATCH", detailSchema, safe)
}
export const changeDocumentState = (
  api: AuthApi,
  id: string,
  action: "archive" | "restore" | "delete"
) =>
  api.mutate(
    `${documentPath(id)}${action === "delete" ? "" : `/${action}`}`,
    action === "delete" ? "DELETE" : "POST",
    detailSchema
  )
export const prepareDocumentDownload = (api: AuthApi, id: string) =>
  api.prepareDownload(`${documentPath(id)}/download`)
export function documentActionError(error: unknown) {
  if (!(error instanceof ApiError))
    return "The action could not be confirmed. Reload the document before retrying."
  if (error.status === 400)
    return "Check the metadata and date values. The server rejected this update."
  if (error.status === 404)
    return "The document or selected category/tag is unavailable. Reload before trying again."
  if (error.status === 409)
    return "This action conflicts with the document's current state. It may have changed elsewhere; reload before retrying."
  if (error.status === 503)
    return "The service is unavailable. Please try again later."
  return error.message
}
export const statuses = [
  "UPLOADED",
  "PROCESSING",
  "READY",
  "PARTIALLY_READY",
  "FAILED",
  "ARCHIVED",
  "DELETING",
] as const
export type DocumentQuery = {
  q?: string
  documentType?: string
  status?: (typeof statuses)[number]
  categoryId?: string
  tagId?: string
  archived?: "true" | "false"
  sort?: "-createdAt" | "createdAt"
  limit?: number
  cursor?: string
}
export function queryString(params: DocumentQuery) {
  const query = new URLSearchParams()
  for (const key of [
    "q",
    "documentType",
    "status",
    "categoryId",
    "tagId",
    "archived",
    "sort",
    "limit",
    "cursor",
  ] as const) {
    const value = params[key]
    if (value !== undefined && value !== "") query.set(key, String(value))
  }
  return query.toString()
}
export const listDocuments = (api: AuthApi, query: DocumentQuery) =>
  api.get(`/documents?${queryString(query)}`, page(documentSchema))
export function listCategories(api: AuthApi, cursor?: string) {
  const query = new URLSearchParams({ limit: "100", sort: "id" })
  if (cursor) query.set("cursor", cursor)
  return api.get(`/categories?${query}`, page(categorySchema))
}
export function listTags(api: AuthApi, cursor?: string) {
  const query = new URLSearchParams({ limit: "100", sort: "id" })
  if (cursor) query.set("cursor", cursor)
  return api.get(`/tags?${query}`, page(tagSchema))
}
