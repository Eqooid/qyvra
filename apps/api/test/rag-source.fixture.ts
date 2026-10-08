import { createHash, randomUUID } from 'node:crypto';
import type { SemanticSearchResult } from '../src/modules/search/semantic-search.service';

export function ragSource(
  text = 'Qyvra stores owned documents.',
  changes: Partial<SemanticSearchResult> = {},
): SemanticSearchResult {
  return {
    chunkId: randomUUID(),
    documentId: randomUUID(),
    documentVersionId: randomUUID(),
    chunkSetId: randomUUID(),
    indexManifestId: randomUUID(),
    embeddingProfileId: randomUUID(),
    chunkOrdinal: 0,
    versionNumber: 1,
    title: 'Owned title',
    originalFilename: 'owned.pdf',
    excerpt: text,
    excerptHash: createHash('sha256').update(text).digest('hex'),
    startOffset: 0,
    endOffset: Array.from(text).length,
    pageSpans: [
      { pageNumber: 1, startOffset: 0, endOffset: Array.from(text).length },
    ],
    score: 0.9,
    ...changes,
  };
}
