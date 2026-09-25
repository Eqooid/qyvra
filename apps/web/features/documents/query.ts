import { z } from "zod"
import {
  DocumentQuery,
  documentMimeTypeSchema,
  documentSortSchema,
  statuses,
} from "@/lib/api/documents"

const calendarDate = (value: string | null): value is string =>
  !!value &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !value.startsWith("0000") &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value

/** URL input is untrusted; only supported list controls reach the API. */
export function readDocumentQuery(input: URLSearchParams): DocumentQuery {
  const result: DocumentQuery = { sort: "-createdAt", limit: 25 }
  const q = input.get("q")?.trim()
  if (q && q.length <= 200 && !/[\u0000-\u001f\u007f]/.test(q)) result.q = q
  const filename = input.get("filename")?.trim()
  if (
    filename &&
    filename.length <= 200 &&
    !/[\u0000-\u001f\u007f]/.test(filename)
  )
    result.filename = filename
  const mimeType = documentMimeTypeSchema.safeParse(input.get("mimeType"))
  if (mimeType.success) result.mimeType = mimeType.data
  const type = input.get("documentType")
  if (type && /^[A-Z][A-Z0-9_]{0,49}$/.test(type)) result.documentType = type
  const status = z.enum(statuses).safeParse(input.get("status"))
  if (status.success) result.status = status.data
  for (const key of ["categoryId", "tagId"] as const) {
    const id = z.string().uuid().safeParse(input.get(key))
    if (id.success) result[key] = id.data
  }
  const tagIds = input.get("tagIds")?.split(",")
  if (tagIds && tagIds.length >= 1 && tagIds.length <= 10 && !result.tagId) {
    const parsed = z.array(z.string().uuid()).safeParse(tagIds)
    if (
      parsed.success &&
      new Set(parsed.data.map((id) => id.toLowerCase())).size ===
        parsed.data.length
    )
      result.tagIds = parsed.data
  }
  const archived = input.get("archived")
  if (archived === "true" || archived === "false") result.archived = archived
  for (const key of [
    "dateFrom",
    "dateTo",
    "expirationFrom",
    "expirationTo",
    "createdFrom",
    "createdTo",
    "updatedFrom",
    "updatedTo",
  ] as const) {
    const value = input.get(key)
    if (calendarDate(value)) result[key] = value
  }
  const sort = documentSortSchema.safeParse(input.get("sort"))
  if (sort.success) result.sort = sort.data
  const limit = input.get("limit")
  if (limit && /^\d+$/.test(limit) && +limit >= 1 && +limit <= 100)
    result.limit = +limit
  const cursor = input.get("cursor")
  if (cursor && /^[A-Za-z0-9_-]{1,4096}$/.test(cursor)) result.cursor = cursor
  return result
}
export const hasFilters = (query: DocumentQuery) =>
  Boolean(
    query.q ||
    query.filename ||
    query.mimeType ||
    query.documentType ||
    query.status ||
    query.categoryId ||
    query.tagId ||
    query.tagIds?.length ||
    query.archived ||
    query.dateFrom ||
    query.dateTo ||
    query.expirationFrom ||
    query.expirationTo ||
    query.createdFrom ||
    query.createdTo ||
    query.updatedFrom ||
    query.updatedTo
  )
