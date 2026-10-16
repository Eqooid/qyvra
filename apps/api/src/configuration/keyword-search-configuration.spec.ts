import { validateTestEnvironment } from '../../test/configuration.fixture';
const base = {
  DATABASE_URL: 'postgresql://localhost/search_test',
  ELASTICSEARCH_ENABLED: 'true',
  ELASTICSEARCH_URL: 'https://search.internal:9200',
  ELASTICSEARCH_USERNAME: 'fixture',
  ELASTICSEARCH_PASSWORD: 'synthetic-fixture-password',
  KEYWORD_SEARCH_ENABLED: 'true',
  KEYWORD_SEARCH_GENERATION_FINGERPRINT: 'a'.repeat(64),
};
describe('keyword serving configuration', () => {
  it('defaults off without AI or Elasticsearch', () => {
    const c = validateTestEnvironment({ DATABASE_URL: base.DATABASE_URL });
    expect(c.keywordSearch.enabled).toBe(false);
    expect(c.keywordSearch.generationFingerprint).toBe('');
  });
  it('enables independently of model providers and enrollment', () => {
    const c = validateTestEnvironment(base);
    expect(c.keywordSearch.enabled).toBe(true);
    expect(c.embedding.enabled).toBe(false);
    expect(c.semanticSearch.enabled).toBe(false);
    expect(c.searchEnrollment.enabled).toBe(false);
  });
  it.each([
    { ELASTICSEARCH_ENABLED: 'false' },
    { KEYWORD_SEARCH_GENERATION_FINGERPRINT: 'invalid' },
    { KEYWORD_SEARCH_MAX_SCOPES: '101' },
    { KEYWORD_SEARCH_RAW_HIT_LIMIT: '201' },
    { KEYWORD_SEARCH_CONCURRENCY: '0' },
    { KEYWORD_SEARCH_TIMEOUT_MS: '60001' },
    { KEYWORD_SEARCH_MAX_SCOPES: '100', ELASTICSEARCH_MAX_SCOPES: '10' },
  ])('rejects invalid settings %j', (override) => {
    expect(() => validateTestEnvironment({ ...base, ...override })).toThrow();
  });
  it('keeps hybrid disabled by default and rejects enabling without both retrieval legs', () => {
    expect(validateTestEnvironment(base).hybridSearch.enabled).toBe(false);
    expect(() =>
      validateTestEnvironment({ ...base, HYBRID_SEARCH_ENABLED: 'true' }),
    ).toThrow('HYBRID_SEARCH_ENABLED');
    expect(() =>
      validateTestEnvironment({ ...base, HYBRID_SEARCH_ENABLED: 'invalid' }),
    ).toThrow();
  });
  it('inherits the adapter scope ceiling unless explicitly narrowed', () => {
    expect(
      validateTestEnvironment({ ...base, ELASTICSEARCH_MAX_SCOPES: '10' })
        .keywordSearch.maxScopes,
    ).toBe(10);
  });
});
