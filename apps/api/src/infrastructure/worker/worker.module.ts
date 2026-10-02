import { Module } from '@nestjs/common';
import { ProcessingRepository } from '@qyvra/database';
import { STORAGE, type Storage } from '@qyvra/storage';
import {
  ConfigurationModule,
  ConfigurationService,
} from '../../configuration/configuration.module';
import { DatabaseModule } from '../../database/database.module';
import { PrismaService } from '../../database/prisma.service';
import { StorageModule } from '../storage/storage.module';
import { RabbitMqConsumer } from '../messaging/rabbitmq.consumer';
import { ProcessingMessageHandler } from './processing-message-handler';
import { WorkerReadiness } from './worker-readiness';
import { StoredFileIntegrityHandler } from './stored-file-integrity.handler';
import { ProgressModule } from '../progress/progress.module';
import {
  PROCESSING_PROGRESS,
  ProcessingProgressStore,
} from '../progress/processing-progress';

/** Independent worker context; no public HTTP modules. */
@Module({
  imports: [ConfigurationModule, DatabaseModule, StorageModule, ProgressModule],
  providers: [
    WorkerReadiness,
    {
      provide: StoredFileIntegrityHandler,
      inject: [
        PrismaService,
        STORAGE,
        ConfigurationService,
        PROCESSING_PROGRESS,
      ],
      useFactory: (
        database: PrismaService,
        storage: Storage,
        config: ConfigurationService,
        progress: ProcessingProgressStore,
      ) =>
        new StoredFileIntegrityHandler(
          database.client,
          storage,
          Math.max(1, Math.floor(config.worker.jobLeaseMs * 0.75)),
          progress,
        ),
    },
    {
      provide: ProcessingMessageHandler,
      inject: [
        PrismaService,
        ConfigurationService,
        StoredFileIntegrityHandler,
        PROCESSING_PROGRESS,
      ],
      useFactory: (
        database: PrismaService,
        config: ConfigurationService,
        integrity: StoredFileIntegrityHandler,
        progress: ProcessingProgressStore,
      ) =>
        new ProcessingMessageHandler(
          new ProcessingRepository(database.client),
          [integrity],
          () => new Date(),
          config.worker.jobLeaseMs,
          progress,
        ),
    },
    {
      provide: RabbitMqConsumer,
      inject: [ProcessingMessageHandler, ConfigurationService, WorkerReadiness],
      useFactory: (
        handler: ProcessingMessageHandler,
        config: ConfigurationService,
        readiness: WorkerReadiness,
      ) =>
        new RabbitMqConsumer(
          handler,
          {
            url: config.messaging.url,
            connectTimeoutMs: config.messaging.connectTimeoutMs,
            prefetch: config.worker.prefetch,
            reconnectDelayMs: config.worker.reconnectDelayMs,
            shutdownTimeoutMs: config.worker.shutdownTimeoutMs,
          },
          (ready) => readiness.setConsumerReady(ready),
        ),
    },
  ],
  exports: [ProcessingMessageHandler, RabbitMqConsumer],
})
export class WorkerModule {}
