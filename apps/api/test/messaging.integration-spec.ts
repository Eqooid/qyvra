import { randomUUID } from 'node:crypto';
import { connect } from 'amqplib';
import type { ProcessingMessageV1 } from '@brainless/database';
import { RabbitMqPublisher } from '../src/infrastructure/messaging/rabbitmq.publisher';
import {
  DEAD_EXCHANGE,
  DEAD_QUEUE,
  PROCESSING_EXCHANGE,
  PROCESSING_QUEUE,
  PROCESSING_ROUTING_KEY,
} from '../src/infrastructure/messaging/rabbitmq-topology';

const url = process.env.TEST_RABBITMQ_URL;
const describeBroker = url ? describe : describe.skip;

describeBroker('RabbitMQ transport integration', () => {
  it('declares durable topology, confirms a routed persistent message, and dead-letters a rejected delivery', async () => {
    if (!url) throw new Error('TEST_RABBITMQ_URL is required.');
    const publisher = new RabbitMqPublisher({
      url,
      connectTimeoutMs: 5000,
      confirmTimeoutMs: 10000,
    });
    const connection = await connect(url);
    const channel = await connection.createChannel();
    const message: ProcessingMessageV1 = {
      schemaVersion: 1,
      messageId: randomUUID(),
      type: 'processing.execute',
      occurredAt: new Date().toISOString(),
      correlationId: randomUUID(),
      jobId: randomUUID(),
      documentId: randomUUID(),
      documentVersionId: randomUUID(),
      jobType: 'VERIFY_STORED_FILE',
      dispatchSequence: 1,
    };
    try {
      // The test must run against an isolated vhost; never consume production work.
      // Topology is declared by the first publish, so only check if queues exist
      // after the adapter has initialized them.
      await publisher.publishProcessing(message);
      await channel.checkExchange(PROCESSING_EXCHANGE);
      await channel.checkExchange(DEAD_EXCHANGE);
      expect((await channel.checkQueue(PROCESSING_QUEUE)).messageCount).toBe(1);
      expect((await channel.checkQueue(DEAD_QUEUE)).messageCount).toBe(0);
      const received = await channel.get(PROCESSING_QUEUE, { noAck: false });
      expect(received).not.toBe(false);
      if (!received) return;
      expect(received.fields.routingKey).toBe(PROCESSING_ROUTING_KEY);
      expect(received.properties.deliveryMode).toBe(2);
      expect(received.properties.contentType).toBe('application/json');
      expect(received.properties.messageId).toBe(message.messageId);
      expect(received.properties.correlationId).toBe(message.correlationId);
      expect(JSON.parse(received.content.toString('utf8'))).toEqual(message);
      channel.nack(received, false, false);
      let dead = await channel.get(DEAD_QUEUE, { noAck: false });
      for (let retry = 0; retry < 20 && !dead; retry++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        dead = await channel.get(DEAD_QUEUE, { noAck: false });
      }
      expect(dead).not.toBe(false);
      if (dead) channel.ack(dead);
    } finally {
      await publisher.onApplicationShutdown();
      await channel.close();
      await connection.close();
    }
  });
});
