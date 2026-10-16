import { SearchSuggestionsController } from './search-suggestions.controller';
import { HybridSearchController } from './hybrid-search.controller';
import { HybridSearchService } from './hybrid-search.service';
import { SearchWindowStore } from '../../infrastructure/search/search-window.store';
import { KeywordSearchController } from './keyword-search.controller';
import { KeywordSearchService } from './keyword-search.service';
import { KeywordSearchRepository } from './keyword-search.repository';
import { LexicalStoreModule } from '../../infrastructure/search/lexical-store.module';
import { Module } from '@nestjs/common';
import {
  ConfigurationModule,
  ConfigurationService,
} from '../../configuration/configuration.module';
import { DatabaseModule } from '../../database/database.module';
import { ObservabilityModule } from '../../common/observability.module';
import { OwnedMutationGuard } from '../../common/owned-mutation.guard';
import { AuthModule } from '../auth';
import { createEmbeddingProvider } from '../../infrastructure/embeddings/embedding-provider.factory';
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
    LexicalStoreModule,
    AuthModule,
    ConfigurationModule,
    DatabaseModule,
    ObservabilityModule,
  ],
  controllers: [
    SemanticSearchController,
    KeywordSearchController,
    HybridSearchController,
    SearchSuggestionsController,
  ],
  exports: [SemanticSearchService],
  providers: [
    OwnedMutationGuard,
    HybridSearchService,
    SearchWindowStore,
    KeywordSearchRepository,
    KeywordSearchService,
    SemanticSearchRepository,
    SemanticSearchService,
    {
      provide: QUERY_EMBEDDINGS,
      inject: [ConfigurationService],
      useFactory: (c: ConfigurationService) =>
        createEmbeddingProvider(c.embedding),
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
