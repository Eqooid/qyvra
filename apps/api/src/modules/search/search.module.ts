import { Module } from '@nestjs/common';
import {
  ConfigurationModule,
  ConfigurationService,
} from '../../configuration/configuration.module';
import { DatabaseModule } from '../../database/database.module';
import { ObservabilityModule } from '../../common/observability.module';
import { OwnedMutationGuard } from '../../common/owned-mutation.guard';
import { AuthModule } from '../auth';
import { OpenAiCompatibleEmbeddingProvider } from '../../infrastructure/embeddings/openai-compatible.provider';
import { QdrantVectorStore } from '../../infrastructure/vectors/qdrant-vector-store';
import { SemanticSearchRepository } from './semantic-search.repository';
import {
  QUERY_EMBEDDINGS,
  SEMANTIC_VECTORS,
  SemanticSearchService,
} from './semantic-search.service';
import { SemanticSearchController } from './semantic-search.controller';

@Module({
  imports: [
    AuthModule,
    ConfigurationModule,
    DatabaseModule,
    ObservabilityModule,
  ],
  controllers: [SemanticSearchController],
  exports: [SemanticSearchService],
  providers: [
    OwnedMutationGuard,
    SemanticSearchRepository,
    SemanticSearchService,
    {
      provide: QUERY_EMBEDDINGS,
      inject: [ConfigurationService],
      useFactory: (c: ConfigurationService) =>
        new OpenAiCompatibleEmbeddingProvider(c.embedding),
    },
    {
      provide: SEMANTIC_VECTORS,
      inject: [ConfigurationService],
      useFactory: (c: ConfigurationService) =>
        new QdrantVectorStore(c.vectorIndex),
    },
  ],
})
export class SearchModule {}
