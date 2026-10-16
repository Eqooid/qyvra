export const searchId = "11111111-1111-4111-8111-111111111111"
export const reference = {
  documentId: searchId,
  documentVersionId: searchId,
  extractedTextId: searchId,
  pageNumber: 2,
  segment: 0,
  sourceId: `${searchId}:page:2:segment:0`,
  href: "https://untrusted.invalid/ignored",
}
export const searchResult = {
  documentId: searchId,
  documentVersionId: searchId,
  projectionId: searchId,
  versionNumber: 2,
  title: "Private report",
  originalFilename: "report.pdf",
  mimeType: "application/pdf",
  documentType: "OTHER",
  status: "READY",
  categoryId: null,
  tagIds: [],
  ranking: "lexical-bm25" as const,
  rank: 1,
  matches: [
    {
      kind: "page" as const,
      snippet: "😀 private <script>alert(1)</script>",
      matchedFields: ["text"],
      pageNumber: 2,
      ranges: [{ start: 2, end: 9 }],
      source: reference,
    },
  ],
}
export const searchResponse = {
  results: [searchResult],
  coverage: {
    eligibleDocuments: 2,
    metadataReadyDocuments: 2,
    textReadyDocuments: 1,
  },
  pagination: {
    nextCursor: null,
    hasMore: false,
    paginationAvailable: true,
    truncated: true,
  },
}
export const lexicalSource = {
  ...reference,
  versionNumber: 2,
  title: "Private report",
  originalFilename: "report.pdf",
  excerpt: "Exact page two",
  excerptHash: "a".repeat(64),
  startOffset: 10,
  endOffset: 24,
  nextSegment: null,
  previousSegment: null,
}
export const searchJson = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ data }), {
    status,
    headers: { "Content-Type": "application/json" },
  })
