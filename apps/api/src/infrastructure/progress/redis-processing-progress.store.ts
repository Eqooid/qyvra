import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { createClient } from 'redis';
import {
  ProcessingProgress,
  ProcessingProgressStore,
  ProcessingStage,
  processingStages,
} from './processing-progress';

export interface RedisProgressSettings {
  readonly url?: string;
  readonly ttlSeconds: number;
  readonly connectTimeoutMs: number;
  readonly commandTimeoutMs: number;
}

function newClient(settings: RedisProgressSettings) {
  return createClient({
    url: settings.url,
    disableOfflineQueue: true,
    socket: {
      connectTimeout: settings.connectTimeoutMs,
      reconnectStrategy: false,
    },
    commandOptions: { timeout: settings.commandTimeoutMs },
  });
}

type RedisClient = ReturnType<typeof newClient>;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const retryConnectAfterMs = 5000;

/** Shared lazy connection; all failures degrade to missing disposable progress. */
@Injectable()
export class RedisProcessingProgressStore
  implements ProcessingProgressStore, OnApplicationShutdown
{
  private readonly logger = new Logger(RedisProcessingProgressStore.name);
  private client?: RedisClient;
  private connecting?: Promise<RedisClient | null>;
  private retryAt = 0;
  private warned = false;
  private stopping = false;

  constructor(
    private readonly settings: RedisProgressSettings,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private key(jobId: string, attempt: number): string | null {
    if (!uuid.test(jobId) || !Number.isSafeInteger(attempt) || attempt < 1)
      return null;
    return `brainless:processing:progress:${jobId.toLowerCase()}:${attempt}`;
  }

  private unavailable(): void {
    if (!this.warned) {
      this.warned = true;
      this.logger.warn('Disposable Redis processing progress is unavailable.');
    }
    this.retryAt = Date.now() + retryConnectAfterMs;
    if (this.client?.isOpen) this.client.destroy();
    this.client = undefined;
  }

  private async ready(): Promise<RedisClient | null> {
    if (!this.settings.url || this.stopping) return null;
    if (this.client?.isReady) return this.client;
    if (this.connecting) return this.connecting;
    if (Date.now() < this.retryAt) return null;
    const client = newClient(this.settings);
    client.on('error', () => {
      if (!this.stopping) this.unavailable();
    });
    this.client = client;
    this.connecting = (async () => {
      try {
        await client.connect();
        this.warned = false;
        return client;
      } catch {
        this.unavailable();
        return null;
      } finally {
        this.connecting = undefined;
      }
    })();
    return this.connecting;
  }

  async report(
    jobId: string,
    attempt: number,
    percent: number,
    stage: ProcessingStage,
  ): Promise<void> {
    const key = this.key(jobId, attempt);
    if (
      !key ||
      !Number.isSafeInteger(percent) ||
      percent < 0 ||
      percent > 99 ||
      !processingStages.includes(stage)
    )
      return;
    const client = await this.ready();
    if (!client) return;
    const value: ProcessingProgress = {
      attempt,
      percent,
      stage,
      updatedAt: this.clock().toISOString(),
    };
    try {
      await client.set(key, JSON.stringify(value), {
        EX: this.settings.ttlSeconds,
      });
    } catch {
      this.unavailable();
    }
  }

  async read(
    jobId: string,
    attempt: number,
  ): Promise<ProcessingProgress | null> {
    const key = this.key(jobId, attempt);
    if (!key) return null;
    const client = await this.ready();
    if (!client) return null;
    let value: string | null;
    try {
      value = await client.get(key);
    } catch {
      this.unavailable();
      return null;
    }
    if (!value || value.length > 256) return null;
    try {
      const parsed: unknown = JSON.parse(value);
      if (!parsed || typeof parsed !== 'object') return null;
      const item = parsed as Record<string, unknown>;
      if (
        item.attempt !== attempt ||
        !Number.isSafeInteger(item.percent) ||
        typeof item.percent !== 'number' ||
        item.percent < 0 ||
        item.percent > 99 ||
        typeof item.stage !== 'string' ||
        !processingStages.some((stage) => stage === item.stage) ||
        typeof item.updatedAt !== 'string' ||
        !Number.isFinite(Date.parse(item.updatedAt))
      )
        return null;
      return item as unknown as ProcessingProgress;
    } catch {
      return null;
    }
  }

  async clear(jobId: string, attempt: number): Promise<void> {
    const key = this.key(jobId, attempt);
    if (!key) return;
    const client = await this.ready();
    if (!client) return;
    try {
      await client.del(key);
    } catch {
      this.unavailable();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.client?.isOpen) this.client.destroy();
    this.client = undefined;
  }
}
