import { z } from "zod"
import { DocumentQuery, statuses } from "@/lib/api/documents"

/** URL input is untrusted; only supported list controls reach the API. */
export function readDocumentQuery(input: URLSearchParams): DocumentQuery {
  const result: DocumentQuery = { sort: "-createdAt", limit: 25 }
  const q = input.get("q")?.trim()
  if (q && q.length <= 200 && !/[\u0000-\u001f\u007f]/.test(q)) result.q = q
  const type = input.get("documentType")
  if (type && /^[A-Z][A-Z0-9_]{0,49}$/.test(type)) result.documentType = type
  const status = z.enum(statuses).safeParse(input.get("status"))
  if (status.success) result.status = status.data
  for (const key of ["categoryId", "tagId"] as const) {
    const id = z.string().uuid().safeParse(input.get(key))
    if (id.success) result[key] = id.data
  }
  const archived = input.get("archived")
  if (archived === "true" || archived === "false") result.archived = archived
  if (input.get("sort") === "createdAt") result.sort = "createdAt"
  const limit = input.get("limit")
  if (limit && /^\d+$/.test(limit) && +limit >= 1 && +limit <= 100)
    result.limit = +limit
  const cursor = input.get("cursor")
  if (cursor && /^[A-Za-z0-9_-]{1,512}$/.test(cursor)) result.cursor = cursor
  return result
}
export const hasFilters = (query: DocumentQuery) =>
  Boolean(
    query.q ||
    query.documentType ||
    query.status ||
    query.categoryId ||
    query.tagId ||
    query.archived
  )
