import type { ProcessingMessageV1 } from '@qyvra/database';
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
  it('keeps the canonical versioned envelope and stable field order', () => {
    const encoded = serializeProcessingMessage(sampleMessage);
    expect(JSON.parse(encoded.toString('utf8'))).toEqual(sampleMessage);
    expect(parseProcessingMessage({ ...sampleMessage })).toEqual(sampleMessage);
    expect(encoded.toString('utf8')).toContain('"schemaVersion":1,"messageId"');
  });

  it('rejects malformed or expanded envelopes before publishing', () => {
    for (const invalid of [
      { ...sampleMessage, schemaVersion: 2 },
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
