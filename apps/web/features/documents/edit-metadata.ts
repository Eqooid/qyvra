import { DocumentDetail, DocumentPatch } from "@/lib/api/documents"
import { UploadMetadata } from "@/lib/api/upload"
export function editDefaults(document: DocumentDetail): UploadMetadata {
  return {
    title: document.title,
    documentType: document.documentType,
    issuer: document.issuer ?? "",
    referenceNumber: document.referenceNumber ?? "",
    documentDate: document.documentDate ?? "",
    expirationDate: document.expirationDate ?? "",
    categoryId: document.category?.id ?? "",
    tagIds: document.tags.map((tag) => tag.id),
  }
}
/** Only changed fields are sent; null clears optional metadata, [] clears tags. */
export function metadataPatch(
  original: DocumentDetail,
  values: UploadMetadata
): DocumentPatch {
  const baseline = editDefaults(original),
    patch: DocumentPatch = {}
  for (const key of ["title", "documentType"] as const)
    if (values[key].trim() !== baseline[key]) patch[key] = values[key].trim()
  for (const key of [
    "issuer",
    "referenceNumber",
    "documentDate",
    "expirationDate",
    "categoryId",
  ] as const)
    if (values[key].trim() !== baseline[key])
      patch[key] = values[key].trim() || null
  const tags = [...new Set(values.tagIds)].sort()
  if (JSON.stringify(tags) !== JSON.stringify([...baseline.tagIds].sort()))
    patch.tagIds = tags
  return patch
}
