import type { ConfirmChannel } from 'amqplib';

export const PROCESSING_EXCHANGE = 'brainless.processing.v1';
export const PROCESSING_ROUTING_KEY = 'processing.execute.v1';
export const PROCESSING_QUEUE = 'brainless.processing.execute.v1';
export const DEAD_EXCHANGE = 'brainless.processing.dead.v1';
export const DEAD_QUEUE = 'brainless.processing.dead.execute.v1';
export const DEAD_ROUTING_KEY = 'processing.dead.execute.v1';

/** Idempotent declarations; incompatible existing resources fail loudly. */
export async function declareProcessingTopology(
  channel: ConfirmChannel,
): Promise<void> {
  await channel.assertExchange(DEAD_EXCHANGE, 'direct', { durable: true });
  await channel.assertQueue(DEAD_QUEUE, { durable: true });
  await channel.bindQueue(DEAD_QUEUE, DEAD_EXCHANGE, DEAD_ROUTING_KEY);
  await channel.assertExchange(PROCESSING_EXCHANGE, 'direct', {
    durable: true,
  });
  await channel.assertQueue(PROCESSING_QUEUE, {
    durable: true,
    deadLetterExchange: DEAD_EXCHANGE,
    deadLetterRoutingKey: DEAD_ROUTING_KEY,
  });
  await channel.bindQueue(
    PROCESSING_QUEUE,
    PROCESSING_EXCHANGE,
    PROCESSING_ROUTING_KEY,
  );
}
