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
import { PdfTextExtractionHandler } from './pdf-text-extraction.handler';
import { ChunkGenerationHandler } from './chunk-generation.handler';
import { EmbeddingGenerationHandler } from './embedding-generation.handler';
import { VectorIndexHandler } from './vector-index.handler';
import { VectorRemovalHandler } from './vector-removal.handler';
import { QdrantVectorStore } from '../vectors/qdrant-vector-store';
import { OpenAiCompatibleEmbeddingProvider } from '../embeddings/openai-compatible.provider';
import { DeterministicChunker } from '../../modules/ai/deterministic-chunker';
import { IsolatedPdfParser } from '../extraction/pdf-parser';
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
      provide: QdrantVectorStore,
      inject: [ConfigurationService],
      useFactory: (config: ConfigurationService) =>
        new QdrantVectorStore(config.vectorIndex),
    },
    {
      provide: VectorIndexHandler,
      inject: [
        PrismaService,
        QdrantVectorStore,
        ConfigurationService,
        PROCESSING_PROGRESS,
      ],
      useFactory: (
        database: PrismaService,
        store: QdrantVectorStore,
        config: ConfigurationService,
        progress: ProcessingProgressStore,
      ) =>
        new VectorIndexHandler(
          database.client,
          store,
          config.vectorIndex,
          config.worker.jobLeaseMs,
          progress,
        ),
    },
    {
      provide: VectorRemovalHandler,
      inject: [PrismaService, QdrantVectorStore, ConfigurationService],
      useFactory: (
        database: PrismaService,
        store: QdrantVectorStore,
        config: ConfigurationService,
      ) =>
        new VectorRemovalHandler(
          database.client,
          store,
          config.worker.jobLeaseMs,
        ),
    },
    {
      provide: EmbeddingGenerationHandler,
      inject: [PrismaService, ConfigurationService, PROCESSING_PROGRESS],
      useFactory: (
        database: PrismaService,
        config: ConfigurationService,
        progress: ProcessingProgressStore,
      ) =>
        new EmbeddingGenerationHandler(
          database.client,
          new OpenAiCompatibleEmbeddingProvider(config.embedding),
          config.embedding,
          config.worker.jobLeaseMs,
          progress,
        ),
    },
    {
      provide: ChunkGenerationHandler,
      inject: [PrismaService, ConfigurationService, PROCESSING_PROGRESS],
      useFactory: (
        database: PrismaService,
        config: ConfigurationService,
        progress: ProcessingProgressStore,
      ) =>
        new ChunkGenerationHandler(
          database.client,
          new DeterministicChunker(
            config.chunking.maxChunks,
            config.chunking.maxOutputBytes,
          ),
          config.chunking,
          progress,
        ),
    },
    {
      provide: PdfTextExtractionHandler,
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
        new PdfTextExtractionHandler(
          database.client,
          storage,
          new IsolatedPdfParser(
            config.extraction,
            config.application.environment === 'production',
          ),
          config.extraction,
          progress,
        ),
    },
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
        PdfTextExtractionHandler,
        ChunkGenerationHandler,
        EmbeddingGenerationHandler,
        VectorIndexHandler,
        VectorRemovalHandler,
        PROCESSING_PROGRESS,
      ],
      useFactory: (
        database: PrismaService,
        config: ConfigurationService,
        integrity: StoredFileIntegrityHandler,
        extraction: PdfTextExtractionHandler,
        chunks: ChunkGenerationHandler,
        embeddings: EmbeddingGenerationHandler,
        indexing: VectorIndexHandler,
        removal: VectorRemovalHandler,
        progress: ProcessingProgressStore,
      ) =>
        new ProcessingMessageHandler(
          new ProcessingRepository(database.client),
          [integrity, extraction, chunks, embeddings, indexing, removal],
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
