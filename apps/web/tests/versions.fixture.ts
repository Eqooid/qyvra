import { id, secondId } from "./documents.fixture"
export const version = {
  id: secondId,
  versionNumber: 2,
  originalFilename: "policy-v2.pdf",
  mimeType: "application/pdf",
  fileSize: 2048,
  pageCount: 2,
  extractionStatus: "PENDING",
  createdAt: "2026-09-18T03:00:00.000Z",
  isLatest: true,
  storageKey: "private-storage",
  checksumSha256: "private-checksum",
  userId: "private-user",
}
export const oldVersion = {
  ...version,
  id,
  versionNumber: 1,
  originalFilename: "policy-v1.pdf",
  isLatest: false,
}
export const versionReceipt = { documentId: id, status: "UPLOADED", version }
