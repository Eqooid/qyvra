import { validateTestEnvironment } from '../../test/configuration.fixture';
const base = {
  DATABASE_URL: 'postgresql://localhost/search_test',
  ELASTICSEARCH_ENABLED: 'true',
  ELASTICSEARCH_URL: 'https://search.internal:9200',
  ELASTICSEARCH_USERNAME: 'fixture',
  ELASTICSEARCH_PASSWORD: 'synthetic-fixture-password',
};
describe('server-only Elasticsearch configuration', () => {
  it('enables relay search delivery without granting it Elasticsearch credentials', () => {
    const relay = validateTestEnvironment({
      DATABASE_URL: base.DATABASE_URL,
      SEARCH_OUTBOX_DELIVERY_ENABLED: 'true',
    });
    expect(relay.outbox.searchDeliveryEnabled).toBe(true);
    expect(relay.elasticsearch.enabled).toBe(false);
    expect(relay.elasticsearch.passwordFile).toBeUndefined();
    expect(validateTestEnvironment(base).outbox.searchDeliveryEnabled).toBe(
      true,
    );
    expect(
      validateTestEnvironment({ DATABASE_URL: base.DATABASE_URL }).outbox
        .searchDeliveryEnabled,
    ).toBe(false);
    expect(() =>
      validateTestEnvironment({
        DATABASE_URL: base.DATABASE_URL,
        SEARCH_OUTBOX_DELIVERY_ENABLED: 'invalid',
      }),
    ).toThrow();
  });
  it('defaults off independently of AI, enrollment and search serving', () => {
    const c = validateTestEnvironment({ DATABASE_URL: base.DATABASE_URL });
    expect(c.elasticsearch.enabled).toBe(false);
    expect(c.searchEnrollment.enabled).toBe(false);
    expect(c.semanticSearch.enabled).toBe(false);
  });
  it('accepts authenticated HTTPS and explicitly isolated development HTTP', () => {
    expect(validateTestEnvironment(base).elasticsearch.url).toBe(
      base.ELASTICSEARCH_URL,
    );
    for (const host of ['elasticsearch', '127.0.0.1', '10.0.0.2', '[::1]'])
      expect(
        validateTestEnvironment({
          ...base,
          ELASTICSEARCH_URL: `http://${host}:9200`,
          ELASTICSEARCH_ALLOW_HTTP: 'true',
        }).elasticsearch.enabled,
      ).toBe(true);
    expect(
      validateTestEnvironment({
        ...base,
        ELASTICSEARCH_USERNAME: undefined,
        ELASTICSEARCH_PASSWORD: undefined,
        ELASTICSEARCH_API_KEY: 'synthetic-base64-fixture',
      }).elasticsearch.apiKey,
    ).toBe('synthetic-base64-fixture');
  });
  it.each([
    'ftp://search.internal',
    'https://user:password@search.internal',
    'https://search.internal/index',
    'https://search.internal/?secret=value',
    'https://search.internal/#fragment',
    'not a URL',
    'http://search.internal',
  ])('rejects endpoint %s', (url) => {
    expect(() =>
      validateTestEnvironment({ ...base, ELASTICSEARCH_URL: url }),
    ).toThrow('ELASTICSEARCH_URL');
  });
  it('rejects unintended public HTTP and production HTTP despite explicit allowance', () => {
    expect(() =>
      validateTestEnvironment({
        ...base,
        ELASTICSEARCH_URL: 'http://example.com',
        ELASTICSEARCH_ALLOW_HTTP: 'true',
      }),
    ).toThrow('ELASTICSEARCH_URL');
    // The production environment's pre-existing cookie rules may fail first;
    // supply an HTTPS cookie deployment to exercise this specific boundary.
    expect(() =>
      validateTestEnvironment({
        ...base,
        NODE_ENV: 'production',
        COOKIE_SECURE: 'true',
        ELASTICSEARCH_URL: 'http://elasticsearch:9200',
        ELASTICSEARCH_ALLOW_HTTP: 'true',
      }),
    ).toThrow('ELASTICSEARCH_URL');
  });
  it.each([
    { ELASTICSEARCH_PASSWORD: undefined },
    { ELASTICSEARCH_USERNAME: undefined },
    { ELASTICSEARCH_API_KEY: 'fixture' },
    { ELASTICSEARCH_PASSWORD_FILE: 'C:/secrets/password' },
    {
      ELASTICSEARCH_USERNAME: undefined,
      ELASTICSEARCH_PASSWORD: undefined,
      ELASTICSEARCH_API_KEY: 'fixture',
      ELASTICSEARCH_API_KEY_FILE: 'C:/secrets/key',
    },
  ])('rejects incomplete or ambiguous authentication', (values) => {
    expect(() => validateTestEnvironment({ ...base, ...values })).toThrow(
      'ELASTICSEARCH_AUTH',
    );
  });
  it('validates server-only file paths and never disables TLS verification', () => {
    expect(() =>
      validateTestEnvironment({
        ...base,
        ELASTICSEARCH_PASSWORD: undefined,
        ELASTICSEARCH_PASSWORD_FILE: 'relative.txt',
      }),
    ).toThrow('ELASTICSEARCH_PASSWORD_FILE');
    expect(() =>
      validateTestEnvironment({
        ...base,
        ELASTICSEARCH_CA_FILE: 'relative.pem',
      }),
    ).toThrow('ELASTICSEARCH_CA_FILE');
    expect(() =>
      validateTestEnvironment({
        ...base,
        ELASTICSEARCH_CA_FILE: 'C:/secrets/ca.pem',
        ELASTICSEARCH_URL: 'http://elasticsearch',
        ELASTICSEARCH_ALLOW_HTTP: 'true',
      }),
    ).toThrow('ELASTICSEARCH_CA_FILE');
  });
  it.each([
    ['ELASTICSEARCH_SCHEMA_VERSION', '2'],
    ['ELASTICSEARCH_INDEX_PREFIX', '*'],
    ['ELASTICSEARCH_TIMEOUT_MS', '0'],
    ['ELASTICSEARCH_MAX_REQUEST_BYTES', '1048577'],
    ['ELASTICSEARCH_MAX_RESPONSE_BYTES', '8388609'],
    ['ELASTICSEARCH_BULK_SIZE', '101'],
    ['ELASTICSEARCH_CONCURRENCY', '17'],
    ['ELASTICSEARCH_MAX_SCOPES', '101'],
  ])('bounds %s', (key, value) => {
    expect(() => validateTestEnvironment({ ...base, [key]: value })).toThrow(
      key,
    );
  });
});
