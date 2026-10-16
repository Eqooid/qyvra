import { randomUUID } from 'node:crypto';
import { fuseDocuments, rankSemantic } from './search-ranking';
import type { VectorCandidate } from '../ai/vector-store';

const version = randomUUID(),
  owner = randomUUID();
const chunk = (documentId: string, score: number): VectorCandidate => ({
  documentId,
  documentVersionId: version,
  chunkId: randomUUID(),
  chunkSetId: randomUUID(),
  indexManifestId: randomUUID(),
  score,
});
describe('fixed document rank fusion fixtures', () => {
  it('collapses duplicate chunks before ranking and bounds representative matches', () => {
    const a = randomUUID(),
      b = randomUUID(),
      first = chunk(a, 0.9);
    const leg = rankSemantic(owner, [
      first,
      first,
      chunk(a, 0.8),
      chunk(a, 0.7),
      chunk(a, 0.6),
      chunk(b, 0.75),
    ]);
    expect(leg.map((c) => [c.documentId, c.sourceRank])).toEqual([
      [a, 1],
      [b, 2],
    ]);
    expect(leg[0].references).toHaveLength(3);
  });
  it('uses RRF60 votes rather than adding incompatible raw scores', () => {
    const a = '00000000-0000-4000-8000-000000000001',
      b = '00000000-0000-4000-8000-000000000002';
    const semantic = rankSemantic(owner, [chunk(b, 0.99), chunk(a, 0.01)]);
    const lexical = [
      {
        documentId: a,
        documentVersionId: version,
        sourceRank: 1,
        references: [],
      },
      {
        documentId: b,
        documentVersionId: version,
        sourceRank: 2,
        references: [],
      },
    ];
    // Both have 1/61+1/62; exact tie is the UUID, regardless of score magnitude.
    const fused = fuseDocuments(lexical, semantic);
    expect(fused.map((c) => c.documentId)).toEqual([a, b]);
    expect(fused[0]).toMatchObject({
      rank: 1,
      lexicalRank: 1,
      semanticRank: 2,
    });
    expect(fuseDocuments([...lexical, ...lexical], semantic)).toEqual(fused);
  });
  it('allow-lists reference identities even when canonical SQL sources contain text and metadata at runtime', () => {
    const candidate = {
      ...chunk(randomUUID(), 0.8),
      excerpt: 'private canonical content',
      title: 'private title',
      pageSpans: [{ pageNumber: 1 }],
    };
    const result = rankSemantic(owner, [candidate]);
    expect(Object.keys(result[0].references[0]).sort()).toEqual([
      'chunkId',
      'chunkSetId',
      'documentId',
      'documentVersionId',
      'indexManifestId',
    ]);
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('handles empty, single-leg and independent hard 100-document windows', () => {
    expect(fuseDocuments([], [])).toEqual([]);
    const semantic = rankSemantic(
      owner,
      Array.from({ length: 150 }, (_, i) => chunk(randomUUID(), 1 - i / 300)),
    );
    expect(semantic).toHaveLength(100);
    expect(fuseDocuments([], semantic)).toHaveLength(100);
    const lexical = Array.from({ length: 150 }, (_, i) => ({
      documentId: randomUUID(),
      documentVersionId: version,
      sourceRank: i + 1,
      references: [],
    }));
    expect(fuseDocuments(lexical, semantic)).toHaveLength(200);
  });
});
