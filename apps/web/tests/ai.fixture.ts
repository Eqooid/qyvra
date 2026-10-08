import { id, secondId } from "./documents.fixture"
import type { Citation } from "@/lib/api/ai"
export const citation: Citation = {
  citationId: "S4",
  documentId: id,
  documentVersionId: secondId,
  chunkId: "33ee39cf-ed80-4d42-a7ec-a5df28c297d9",
  chunkOrdinal: 0,
  title: "Owned document",
  versionNumber: 2,
  originalFilename: "source.pdf",
  excerpt: "Hello world",
  excerptHash: "a".repeat(64),
  excerptStart: 10,
  excerptEnd: 21,
  pageSpans: [
    { pageNumber: 2, startOffset: 10, endOffset: 16 },
    { pageNumber: 3, startOffset: 16, endOffset: 21 },
  ],
}
export const answer = {
  outcome: "answered" as const,
  answer: "Hello [S4] again [S4]. Unknown [S999].",
  requestId: id,
  citations: [citation],
  claims: [{ text: "Hello", citationIds: ["S4"] }],
}
