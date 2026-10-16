import {
  searchProcessingJobTypes,
  type ProcessingMessageV1,
  type ProcessingMessageV3,
} from '@qyvra/database';
import {
  parseProcessingMessage,
  serializeProcessingMessage,
} from './processing-message';

export const sampleMessage: ProcessingMessageV1 = {
  schemaVersion: 1,
  messageId: '11111111-1111-4111-8111-111111111111',
  type: 'processing.execute',
  occurredAt: '2026-01-01T00:00:00.000Z',
  correlationId: '22222222-2222-4222-8222-222222222222',
  jobId: '33333333-3333-4333-8333-333333333333',
  documentId: '44444444-4444-4444-8444-444444444444',
  documentVersionId: '55555555-5555-4555-8555-555555555555',
  jobType: 'VERIFY_STORED_FILE',
  dispatchSequence: 1,
};

describe('processing message transport serialization', () => {
  const search: ProcessingMessageV3 = {
    ...sampleMessage,
    schemaVersion: 3,
    jobType: 'INDEX_SEARCH',
    searchProjectionId: '66666666-6666-5666-8666-666666666666',
    indexGenerationId: '77777777-7777-4777-8777-777777777777',
    revision: 1,
  };
  it.each(searchProcessingJobTypes)(
    'round-trips explicit v3 %s identifiers only',
    (jobType) => {
      const message = { ...search, jobType };
      expect(
        parseProcessingMessage(
          JSON.parse(serializeProcessingMessage(message).toString()),
        ),
      ).toEqual(message);
    },
  );
  it('rejects version confusion, malformed v3 fields and expanded payloads', () => {
    for (const invalid of [
      { ...search, schemaVersion: 2 },
      { ...search, schemaVersion: 4 },
      { ...sampleMessage, schemaVersion: 3 },
      { ...search, jobType: 'VERIFY_STORED_FILE' },
      { ...search, searchProjectionId: undefined },
      { ...search, indexGenerationId: 'bad' },
      { ...search, revision: 0 },
      { ...search, revision: 1.5 },
      { ...search, revision: 2147483648 },
      { ...search, revision: '1' },
      { ...search, dispatchSequence: 0 },
      { ...search, occurredAt: '2026-01-01' },
      { ...search, userId: search.documentId },
      { ...search, content: 'secret' },
      { ...search, apiKey: 'secret' },
    ])
      expect(() => parseProcessingMessage(invalid)).toThrow(
        'Invalid processing message contract.',
      );
    for (const field of Object.keys(search)) {
      const missing = { ...search } as Record<string, unknown>;
      delete missing[field];
      expect(() => parseProcessingMessage(missing)).toThrow();
    }
  });
  it('keeps the canonical versioned envelope and stable field order', () => {
    const encoded = serializeProcessingMessage(sampleMessage);
    expect(JSON.parse(encoded.toString('utf8'))).toEqual(sampleMessage);
    expect(parseProcessingMessage({ ...sampleMessage })).toEqual(sampleMessage);
    expect(encoded.toString('utf8')).toContain('"schemaVersion":1,"messageId"');
  });

  it('accepts all known v2 stages without adding content fields', () => {
    for (const jobType of [
      'VERIFY_STORED_FILE',
      'EXTRACT_TEXT',
      'GENERATE_CHUNKS',
      'GENERATE_EMBEDDINGS',
      'INDEX_VECTORS',
      'REMOVE_VECTOR_INDEX',
    ]) {
      const message = { ...sampleMessage, schemaVersion: 2, jobType };
      expect(parseProcessingMessage(message)).toEqual(message);
    }
  });

  it('rejects malformed or expanded envelopes before publishing', () => {
    for (const invalid of [
      { ...sampleMessage, schemaVersion: 3 },
      { ...sampleMessage, jobType: 'EXTRACT_TEXT' },
      { ...sampleMessage, schemaVersion: 2, jobType: 'unknown' },
      { ...sampleMessage, dispatchSequence: 0 },
      { ...sampleMessage, jobId: 'bad' },
      { ...sampleMessage, fileContents: 'secret' },
    ]) {
      expect(() =>
        serializeProcessingMessage(invalid as ProcessingMessageV1),
      ).toThrow('Invalid processing message contract.');
    }
  });
});
