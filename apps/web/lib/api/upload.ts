import { z } from "zod"
import { AuthApi, ApiError, UploadCancelled, UploadOptions } from "./client"

export type UploadMetadata = {
  title: string
  description?: string
  documentType: string
  issuer: string
  referenceNumber: string
  documentDate: string
  expirationDate: string
  categoryId: string
  tagIds: string[]
}
export const uploadReceipt = z.object({
  id: z.string().uuid(),
  status: z.literal("UPLOADED"),
  version: z.object({
    id: z.string().uuid(),
    versionNumber: z.literal(1),
    extractionStatus: z.literal("PENDING"),
  }),
})
export function normalizedMetadata(values: UploadMetadata): UploadMetadata {
  return {
    title: values.title.trim(),
    description: values.description,
    documentType: values.documentType.trim(),
    issuer: values.issuer.trim(),
    referenceNumber: values.referenceNumber.trim(),
    documentDate: values.documentDate,
    expirationDate: values.expirationDate,
    categoryId: values.categoryId,
    tagIds: [...new Set(values.tagIds)].sort(),
  }
}
export function uploadBody(file: File, values: UploadMetadata) {
  const data = normalizedMetadata(values)
  const body = new FormData()
  for (const key of [
    "title",
    "documentType",
    "issuer",
    "referenceNumber",
    "documentDate",
    "expirationDate",
    "categoryId",
  ] as const)
    if (data[key]) body.append(key, data[key])
  if (data.description !== undefined)
    body.append("description", data.description)
  if (data.tagIds.length) body.append("tagIds", JSON.stringify(data.tagIds))
  body.append("file", file)
  return body
}
/** File object identity avoids reading bytes and never confuses two selected files. */
export class UploadAttempt {
  private previous?: { file: File; metadata: string; key: string }
  key(file: File, values: UploadMetadata) {
    const metadata = JSON.stringify(normalizedMetadata(values))
    if (
      !this.previous ||
      this.previous.file !== file ||
      this.previous.metadata !== metadata
    )
      this.previous = { file, metadata, key: crypto.randomUUID() }
    return this.previous.key
  }
  reset() {
    this.previous = undefined
  }
}
export const uploadDocument = (
  api: AuthApi,
  file: File,
  values: UploadMetadata,
  key: string,
  options: UploadOptions
) => api.upload(uploadBody(file, values), key, uploadReceipt, options)
export function uploadError(error: unknown): string {
  if (error instanceof UploadCancelled) return error.message
  if (!(error instanceof ApiError))
    return "Upload could not be confirmed. Check your documents before retrying."
  switch (error.status) {
    case 0:
      return "Network interrupted. The upload may have completed. Check your documents or retry unchanged to reuse this attempt."
    case 400:
      return "Upload rejected. Check required metadata and the file. Damaged or password-protected PDFs, excessive page counts and invalid dates are not accepted."
    case 404:
      return "The selected category or tags are no longer available. Reload their options and choose again."
    case 408:
      return "Upload timed out. Check your documents or retry the unchanged upload."
    case 409:
      return "This file may already exist, or this upload key is in progress or conflicts with an earlier request. Check your documents before retrying unchanged."
    case 413:
      return "The file exceeds the server's upload size limit. Choose a smaller file."
    case 415:
      return "Unsupported file or file contents do not match its extension and MIME type. Choose a valid PDF, JPEG or PNG."
    case 503:
      return "Upload storage or validation services are unavailable. Your form is preserved; try again later."
    case 401:
    case 403:
    case 429:
      return error.message
    default:
      return "The server could not confirm the upload. Check your documents before retrying."
  }
}
