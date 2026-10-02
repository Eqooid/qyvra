import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { connect, type ChannelModel, type ConfirmChannel } from 'amqplib';
import type { ProcessingMessageV1 } from '@qyvra/database';
import type { MessagePublisher } from './message-publisher';
import { serializeProcessingMessage } from './processing-message';
import {
  declareProcessingTopology,
  PROCESSING_EXCHANGE,
  PROCESSING_ROUTING_KEY,
} from './rabbitmq-topology';

export class MessagingTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MessagingTransportError';
  }
}

export interface RabbitMqSettings {
  readonly url?: string;
  readonly connectTimeoutMs: number;
  readonly confirmTimeoutMs: number;
}

/** One managed confirm channel, opened lazily so unrelated HTTP paths stay available. */
@Injectable()
export class RabbitMqPublisher
  implements MessagePublisher, OnApplicationShutdown
{
  private readonly logger = new Logger(RabbitMqPublisher.name);
  private connection?: ChannelModel;
  private channel?: ConfirmChannel;
  private opening?: Promise<ConfirmChannel>;
  private tail: Promise<void> = Promise.resolve();
  private shuttingDown = false;

  constructor(private readonly settings: RabbitMqSettings) {}

  private async getChannel(): Promise<ConfirmChannel> {
    if (this.shuttingDown)
      throw new MessagingTransportError(
        'Messaging transport is shutting down.',
      );
    if (this.channel) return this.channel;
    if (!this.opening) {
      this.opening = this.open().finally(() => {
        this.opening = undefined;
      });
    }
    return this.opening;
  }

  private async open(): Promise<ConfirmChannel> {
    if (!this.settings.url)
      throw new MessagingTransportError(
        'Messaging transport is not configured.',
      );
    let connection: ChannelModel | undefined;
    try {
      connection = await connect(this.settings.url, {
        timeout: this.settings.connectTimeoutMs,
      });
      connection.on('error', () =>
        this.logger.warn('RabbitMQ connection error.'),
      );
      connection.on('close', () => {
        if (this.connection === connection) this.invalidate();
        if (!this.shuttingDown)
          this.logger.warn(
            'RabbitMQ connection closed; next publication will reconnect.',
          );
      });
      const channel = await connection.createConfirmChannel();
      channel.on('error', () => this.logger.warn('RabbitMQ channel error.'));
      channel.on('close', () => {
        if (this.channel === channel) this.invalidate();
      });
      await declareProcessingTopology(channel);
      if (this.shuttingDown) {
        await channel.close();
        await connection.close();
        throw new MessagingTransportError(
          'Messaging transport is shutting down.',
        );
      }
      this.connection = connection;
      this.channel = channel;
      this.logger.log('RabbitMQ processing topology ready.');
      return channel;
    } catch {
      if (connection) await connection.close().catch(() => undefined);
      throw new MessagingTransportError(
        'RabbitMQ connection or topology initialization failed.',
      );
    }
  }

  private invalidate(): void {
    this.channel = undefined;
    this.connection = undefined;
  }

  async publishProcessing(message: ProcessingMessageV1): Promise<void> {
    const payload = serializeProcessingMessage(message);
    // One in-flight publication lets mandatory returns match their confirmation unambiguously.
    const publication = this.tail.then(() => this.publishOne(message, payload));
    this.tail = publication.catch(() => undefined);
    return publication;
  }

  private async publishOne(
    message: ProcessingMessageV1,
    payload: Buffer,
  ): Promise<void> {
    const channel = await this.getChannel();
    let returned = false;
    const onReturn = () => {
      returned = true;
    };
    channel.on('return', onReturn);
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          channel.off('close', onClose);
          if (error) reject(error);
          else resolve();
        };
        const onClose = () =>
          finish(
            new MessagingTransportError(
              'RabbitMQ channel closed before confirmation.',
            ),
          );
        const timer = setTimeout(
          () =>
            finish(
              new MessagingTransportError(
                'RabbitMQ publisher confirmation timed out.',
              ),
            ),
          this.settings.confirmTimeoutMs,
        );
        channel.once('close', onClose);
        try {
          channel.publish(
            PROCESSING_EXCHANGE,
            PROCESSING_ROUTING_KEY,
            payload,
            {
              mandatory: true,
              persistent: true,
              contentType: 'application/json',
              contentEncoding: 'utf-8',
              messageId: message.messageId,
              correlationId: message.correlationId,
              timestamp: Math.floor(Date.parse(message.occurredAt) / 1000),
              type: message.type,
              headers: { schemaVersion: message.schemaVersion },
            },
            (error: unknown) => {
              if (error || returned)
                finish(
                  new MessagingTransportError(
                    'RabbitMQ did not confirm a routed publication.',
                  ),
                );
              else finish();
            },
          );
        } catch {
          finish(new MessagingTransportError('RabbitMQ publication failed.'));
        }
      });
    } catch (error) {
      this.logger.warn(
        `RabbitMQ publish failed for message ${message.messageId}.`,
      );
      const connection = this.connection;
      this.invalidate();
      await channel.close().catch(() => undefined);
      if (connection) await connection.close().catch(() => undefined);
      throw error;
    } finally {
      channel.off('return', onReturn);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    await this.tail;
    const channel = this.channel;
    const connection = this.connection;
    this.invalidate();
    if (channel) await channel.close().catch(() => undefined);
    if (connection) await connection.close().catch(() => undefined);
  }
}
