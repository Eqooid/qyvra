import {
  embeddingText,
  embeddingInputHash,
  validVector,
  validateEmbeddingResults,
} from './embedding-provider';

const profile = {
  profileVersion: 1,
  provider: 'openai-compatible',
  model: 'test',
  modelRevision: 'v1',
  dimensions: 3,
  distance: 'Cosine' as const,
  normalizationVersion: 'qyvra-embedding-input/v1',
  tokenizer: 'cl100k_base',
  tokenizerVersion: 'tiktoken-1.0.22',
  documentInstruction: 'passage:',
  queryInstruction: 'query:',
};
describe('owned embedding contracts', () => {
  it('preserves canonical Unicode and uses purpose-specific pinned instructions', () => {
    expect(embeddingText('é 文 😀\nText', profile, 'document')).toBe(
      'passage:\né 文 😀\nText',
    );
    expect(embeddingText('hello', profile, 'query')).toBe('query:\nhello');
    expect(embeddingInputHash('hello')).toMatch(/^[a-f0-9]{64}$/);
    expect(() => embeddingText(' \n', profile, 'document')).toThrow(
      'EMBEDDING_EMPTY_INPUT',
    );
  });
  it.each([
    [0, 0, 0],
    [NaN, 1, 2],
    [Infinity, 1, 2],
    [1, 2],
    ['1', 2, 3],
    null,
  ])('rejects invalid vector %j', (vector) => {
    expect(validVector(vector, 3)).toBe(false);
  });
  it('normalizes explicit ID mapping and rejects duplicates/foreign/partial outputs', () => {
    expect(validVector([1, , 3], 3)).toBe(false);
    const inputs = [
      { id: 'a', text: 'a' },
      { id: 'b', text: 'b' },
    ];
    const results = [
      { id: 'b', vector: [1, 2, 3] },
      { id: 'a', vector: [4, 5, 6] },
    ];
    expect(
      validateEmbeddingResults(inputs, results, 3).map((r) => r.id),
    ).toEqual(['a', 'b']);
    for (const invalid of [
      results.slice(0, 1),
      [results[0], results[0]],
      [{ id: 'foreign', vector: [1, 2, 3] }, results[1]],
    ])
      expect(() => validateEmbeddingResults(inputs, invalid, 3)).toThrow(
        'EMBEDDING_INVALID_OUTPUT',
      );
  });
});
