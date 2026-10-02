import {
  RabbitMqPublisher,
  MessagingTransportError,
} from './rabbitmq.publisher';
import type { ProcessingMessageV1 } from '@qyvra/database';

const sampleMessage: ProcessingMessageV1 = {
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

describe('RabbitMQ publisher failure boundary', () => {
  it('rejects missing configuration without treating delivery as successful', async () => {
    const publisher = new RabbitMqPublisher({
      connectTimeoutMs: 100,
      confirmTimeoutMs: 100,
    });
    await expect(
      publisher.publishProcessing(sampleMessage),
    ).rejects.toBeInstanceOf(MessagingTransportError);
    await publisher.onApplicationShutdown();
  });

  it('surfaces broker unavailability and permits a later reconnection attempt', async () => {
    const publisher = new RabbitMqPublisher({
      url: 'amqp://guest:guest@127.0.0.1:1/',
      connectTimeoutMs: 200,
      confirmTimeoutMs: 200,
    });
    await expect(
      publisher.publishProcessing(sampleMessage),
    ).rejects.toBeInstanceOf(MessagingTransportError);
    await expect(
      publisher.publishProcessing(sampleMessage),
    ).rejects.toBeInstanceOf(MessagingTransportError);
    await publisher.onApplicationShutdown();
  });
});
