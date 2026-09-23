export const id = "13ee39cf-ed80-4d42-a7ec-a5df28c297d9"
export const secondId = "23ee39cf-ed80-4d42-a7ec-a5df28c297d9"
export const profile = {
  id,
  email: "owner@example.invalid",
  displayName: "Owner",
  timezone: "UTC",
  locale: "en",
}
export const tag = {
  id,
  name: "Finance",
  createdAt: "2026-09-16T00:00:00.000Z",
  updatedAt: "2026-09-16T00:00:00.000Z",
}
export const category = { ...tag, name: "Records", color: null, icon: null }
export const document = {
  id,
  title: "Insurance policy",
  documentType: "INSURANCE",
  status: "UPLOADED",
  issuer: "Example insurer",
  referenceNumber: null,
  documentDate: "2026-09-01",
  expirationDate: null,
  createdAt: tag.createdAt,
  updatedAt: tag.updatedAt,
  isArchived: false,
  category,
  tags: [tag],
  storageKey: "private-storage-key",
  userId: "private-owner",
  checksumSha256: "private-checksum",
}
export const envelope = (data: unknown, cursor: string | null = null) => ({
  data,
  meta: { requestId: id, nextCursor: cursor, hasMore: cursor !== null },
})
export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  })
