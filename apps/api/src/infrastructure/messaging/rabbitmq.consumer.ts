import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import {
  connect,
  type ChannelModel,
  type ConfirmChannel,
  type ConsumeMessage,
} from 'amqplib';
import type { ProcessingMessageV1 } from '@qyvra/database';
import { parseProcessingMessage } from './processing-message';
import {
  declareProcessingTopology,
  PROCESSING_QUEUE,
} from './rabbitmq-topology';
import type { DeliveryDecision } from '../worker/processing-message-handler';

export interface ProcessingDeliveryHandler {
  handle(
    message: ProcessingMessageV1,
    redelivered: boolean,
  ): Promise<DeliveryDecision>;
}

export interface ConsumerSettings {
  readonly url?: string;
  readonly connectTimeoutMs: number;
  readonly prefetch: number;
  readonly reconnectDelayMs: number;
  readonly shutdownTimeoutMs: number;
}

/** Owns AMQP delivery/acknowledgement; job rules stay in ProcessingDeliveryHandler. */
@Injectable()
export class RabbitMqConsumer implements OnApplicationShutdown {
  private readonly logger = new Logger(RabbitMqConsumer.name);
  private connection?: ChannelModel;
  private channel?: ConfirmChannel;
  private consumerTag?: string;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private readonly inFlight = new Set<Promise<void>>();
  private stopping = false;
  private restarting = false;
  private ready = false;

  constructor(
    private readonly handler: ProcessingDeliveryHandler,
    private readonly settings: ConsumerSettings,
    private readonly readyChanged: (ready: boolean) => void = () => undefined,
  ) {}

  isReady(): boolean {
    return this.ready;
  }
  activeCount(): number {
    return this.inFlight.size;
  }

  private setReady(value: boolean): void {
    if (this.ready === value) return;
    this.ready = value;
    this.readyChanged(value);
  }

  async start(): Promise<void> {
    if (this.stopping) throw new Error('Worker consumer is stopping.');
    if (this.channel) return;
    if (!this.settings.url)
      throw new Error('RABBITMQ_URL is required for the worker.');
    await this.connectAndConsume();
  }

  private async connectAndConsume(): Promise<void> {
    const url = this.settings.url;
    if (!url) throw new Error('RABBITMQ_URL is required for the worker.');
    let connection: ChannelModel | undefined;
    try {
      connection = await connect(url, {
        timeout: this.settings.connectTimeoutMs,
      });
      connection.on('error', () =>
        this.logger.warn('Worker RabbitMQ connection error.'),
      );
      connection.on('close', () => {
        if (this.connection !== connection) return;
        this.connection = undefined;
        this.channel = undefined;
        this.consumerTag = undefined;
        this.setReady(false);
        if (!this.stopping) this.scheduleReconnect();
      });
      const channel = await connection.createConfirmChannel();
      channel.on('error', () =>
        this.logger.warn('Worker RabbitMQ channel error.'),
      );
      channel.on('close', () => {
        if (this.channel !== channel) return;
        this.channel = undefined;
        this.consumerTag = undefined;
        this.setReady(false);
        if (!this.stopping && !this.restarting) {
          void connection?.close().catch(() => undefined);
          this.scheduleReconnect();
        }
      });
      await declareProcessingTopology(channel);
      await channel.prefetch(this.settings.prefetch);
      const consumer = await channel.consume(
        PROCESSING_QUEUE,
        (delivery) => {
          if (!delivery) return;
          const task = this.handleDelivery(channel, delivery).catch(() => {
            this.logger.error(
              'Worker delivery handling failed; channel recovery will redeliver.',
            );
          });
          this.inFlight.add(task);
          void task.then(() => this.inFlight.delete(task));
        },
        { noAck: false },
      );
      this.connection = connection;
      this.channel = channel;
      this.consumerTag = consumer.consumerTag;
      this.restarting = false;
      this.setReady(true);
      this.logger.log(
        `Worker consumer ready: queue=${PROCESSING_QUEUE} prefetch=${this.settings.prefetch}.`,
      );
    } catch {
      if (connection) await connection.close().catch(() => undefined);
      throw new Error('Worker RabbitMQ consumer initialization failed.');
    }
  }

  private async handleDelivery(
    channel: ConfirmChannel,
    delivery: ConsumeMessage,
  ): Promise<void> {
    let message: ProcessingMessageV1;
    try {
      if (
        delivery.content.length > 4096 ||
        delivery.properties.contentType !== 'application/json'
      )
        throw new Error('Invalid message transport metadata.');
      message = parseProcessingMessage(
        JSON.parse(delivery.content.toString('utf8')),
      );
      if (
        delivery.properties.messageId !== message.messageId ||
        delivery.properties.correlationId !== message.correlationId
      )
        throw new Error('Message metadata does not match contract.');
    } catch {
      if (channel === this.channel) {
        try {
          channel.nack(delivery, false, false);
          this.logger.warn(
            'Worker rejected malformed delivery to dead-letter queue.',
          );
        } catch {
          await this.pauseForRetry(channel);
        }
      }
      return;
    }
    let decision: DeliveryDecision;
    try {
      decision = await this.handler.handle(
        message,
        delivery.fields.redelivered,
      );
    } catch {
      decision = 'retry';
    }
    if (channel !== this.channel) return;
    try {
      if (decision === 'ack') channel.ack(delivery);
      else if (decision === 'dead-letter') {
        channel.nack(delivery, false, false);
        this.logger.warn(
          'Worker rejected invalid or unsupported delivery to dead-letter queue.',
        );
      } else {
        // Close after requeue and reconnect with delay; never hot-loop a failed delivery.
        channel.nack(delivery, false, true);
        await this.pauseForRetry(channel);
      }
    } catch {
      this.logger.error(
        'Worker acknowledgement failed; broker will redeliver after channel closure.',
      );
      await this.pauseForRetry(channel);
    }
  }

  private async pauseForRetry(channel: ConfirmChannel): Promise<void> {
    if (this.restarting || this.stopping || channel !== this.channel) return;
    this.restarting = true;
    this.setReady(false);
    this.channel = undefined;
    this.consumerTag = undefined;
    const connection = this.connection;
    this.connection = undefined;
    await channel.close().catch(() => undefined);
    if (connection) await connection.close().catch(() => undefined);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer) return;
    this.setReady(false);
    this.logger.warn('Worker consumer disconnected; reconnect scheduled.');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.stopping) return;
      void this.connectAndConsume().catch(() => this.scheduleReconnect());
    }, this.settings.reconnectDelayMs);
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.setReady(false);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const channel = this.channel;
    const connection = this.connection;
    if (channel && this.consumerTag)
      await channel.cancel(this.consumerTag).catch(() => undefined);
    if (this.inFlight.size) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...this.inFlight]),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, this.settings.shutdownTimeoutMs);
        }),
      ]);
      if (timeout) clearTimeout(timeout);
    }
    this.channel = undefined;
    this.connection = undefined;
    if (channel) await channel.close().catch(() => undefined);
    if (connection) await connection.close().catch(() => undefined);
    this.logger.log('Worker consumer stopped.');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }
}
