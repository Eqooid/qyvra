import { z } from "zod"
import { ApiError, AuthApi, type UploadOptions } from "./client"
import { uploadError } from "./upload"

export const versionSchema = z.object({
  id: z.string().uuid(),
  versionNumber: z.number().int().positive(),
  originalFilename: z.string(),
  mimeType: z.enum(["application/pdf", "image/jpeg", "image/png"]),
  fileSize: z.number().int().positive(),
  pageCount: z.number().int().positive().nullable(),
  extractionStatus: z.string(),
  createdAt: z.string().datetime(),
  isLatest: z.boolean(),
})
export type DocumentVersion = z.infer<typeof versionSchema>
const receiptSchema = z.object({
  documentId: z.string().uuid(),
  status: z.literal("UPLOADED"),
  version: versionSchema,
})
export type VersionReceipt = z.infer<typeof receiptSchema>
function uuid(value: string) {
  if (!z.string().uuid().safeParse(value).success) throw new ApiError(404)
  return value
}
function path(documentId: string) {
  return `/documents/${uuid(documentId)}/versions`
}
export function listVersions(
  api: AuthApi,
  documentId: string,
  cursor?: string
) {
  const query = new URLSearchParams({ limit: "25", sort: "-versionNumber" })
  if (cursor) query.set("cursor", uuid(cursor))
  return api.get(
    `${path(documentId)}?${query}`,
    z.object({
      data: z.array(versionSchema),
      meta: z.object({
        nextCursor: z.string().uuid().nullable(),
        hasMore: z.boolean(),
      }),
    })
  )
}
export async function getVersion(
  api: AuthApi,
  documentId: string,
  versionId: string
) {
  return (
    await api.get(
      `${path(documentId)}/${uuid(versionId)}`,
      z.object({ data: versionSchema })
    )
  ).data
}
export function uploadVersion(
  api: AuthApi,
  documentId: string,
  file: File,
  key: string,
  options: UploadOptions
) {
  const target = path(documentId)
  const body = new FormData()
  body.append("file", file)
  return api.upload(body, key, receiptSchema, options, target)
}
export function versionError(error: unknown, uploading = false) {
  if (error instanceof ApiError) {
    if (error.status === 404) return "This document or version is unavailable."
    if (error.status === 403)
      return "This request is not permitted. Check your access or contact the application owner."
    if (error.status === 409)
      return "The file may already exist, the document may no longer accept versions, or this upload attempt conflicts. Refresh history before retrying the unchanged file."
    if (uploading) return uploadError(error)
    if (error.status === 400)
      return "This history page is no longer available. Refresh history to start again."
    return error.message
  }
  return uploading
    ? uploadError(error)
    : "Version history could not be loaded. Please try again."
}
