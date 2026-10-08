import { EventEmitter } from 'node:events';
import { connect } from 'amqplib';
import { RabbitMqConsumer } from './rabbitmq.consumer';

jest.mock('amqplib', () => ({ connect: jest.fn() }));
jest.mock('./rabbitmq-topology', () => ({
  PROCESSING_QUEUE: 'test',
  declareProcessingTopology: jest.fn().mockResolvedValue(undefined),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
const settings = {
  url: 'amqp://fixture.invalid',
  connectTimeoutMs: 1000,
  prefetch: 2,
  reconnectDelayMs: 10,
  shutdownTimeoutMs: 100,
};
function transport() {
  const channel = Object.assign(new EventEmitter(), {
    prefetch: jest.fn().mockResolvedValue(undefined),
    consume: jest.fn().mockResolvedValue({ consumerTag: 'test' }),
    close: jest.fn().mockResolvedValue(undefined),
  });
  const connection = Object.assign(new EventEmitter(), {
    createConfirmChannel: jest.fn().mockResolvedValue(channel),
    close: jest.fn().mockResolvedValue(undefined),
  });
  return { channel, connection };
}
describe('RabbitMQ consumer shutdown fencing', () => {
  beforeEach(() => jest.clearAllMocks());
  it('closes a connection resolving after stop without creating a consumer or restoring readiness', async () => {
    const { connection } = transport();
    const opening = deferred<typeof connection>();
    jest.mocked(connect).mockReturnValueOnce(opening.promise as never);
    const changed = jest.fn();
    const consumer = new RabbitMqConsumer(
      { handle: jest.fn() },
      settings,
      changed,
    );
    const starting = consumer.start();
    await consumer.stop();
    opening.resolve(connection);
    await starting;
    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(connection.createConfirmChannel).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalledWith(true);
    expect(consumer.isReady()).toBe(false);
  });
  it('closes both late setup resources when shutdown occurs during consume registration', async () => {
    const { channel, connection } = transport();
    const registering = deferred<{ consumerTag: string }>();
    const entered = deferred<void>();
    channel.consume.mockImplementationOnce(() => {
      entered.resolve();
      return registering.promise;
    });
    jest.mocked(connect).mockResolvedValueOnce(connection as never);
    const changed = jest.fn();
    const consumer = new RabbitMqConsumer(
      { handle: jest.fn() },
      settings,
      changed,
    );
    const starting = consumer.start();
    await entered.promise;
    await consumer.stop();
    registering.resolve({ consumerTag: 'late' });
    await starting;
    expect(channel.close).toHaveBeenCalledTimes(1);
    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(changed).not.toHaveBeenCalledWith(true);
    expect(consumer.isReady()).toBe(false);
  });
});
