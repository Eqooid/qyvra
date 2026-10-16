import { Module } from '@nestjs/common';
import {
  ConfigurationModule,
  ConfigurationService,
} from '../../configuration/configuration.module';
import { ElasticsearchStore } from './elasticsearch-store';
import { LEXICAL_STORE } from './lexical-store';

/** Shared by HTTP and worker contexts, with no startup network/index mutation. */
@Module({
  imports: [ConfigurationModule],
  providers: [
    {
      provide: LEXICAL_STORE,
      inject: [ConfigurationService],
      useFactory: (config: ConfigurationService) =>
        new ElasticsearchStore(config.elasticsearch),
    },
  ],
  exports: [LEXICAL_STORE],
})
export class LexicalStoreModule {}
