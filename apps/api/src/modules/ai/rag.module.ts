import { Module } from '@nestjs/common';
import {
  ConfigurationModule,
  ConfigurationService,
} from '../../configuration/configuration.module';
import { ObservabilityModule } from '../../common/observability.module';
import { OwnedMutationGuard } from '../../common/owned-mutation.guard';
import { AuthModule } from '../auth';
import { SearchModule } from '../search/search.module';
import { createGenerationProvider } from '../../infrastructure/generation/generation-provider.factory';
import { GENERATION_PROVIDER } from './generation-provider';
import { RagAnswerController } from './rag-answer.controller';
import { RagAnswerService } from './rag-answer.service';

@Module({
  imports: [AuthModule, ConfigurationModule, ObservabilityModule, SearchModule],
  controllers: [RagAnswerController],
  providers: [
    OwnedMutationGuard,
    RagAnswerService,
    {
      provide: GENERATION_PROVIDER,
      inject: [ConfigurationService],
      useFactory: (c: ConfigurationService) =>
        createGenerationProvider(
          c.generation,
          c.rag.contextTokens,
          c.rag.enabled,
        ),
    },
  ],
})
export class RagModule {}
