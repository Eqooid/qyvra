import { Module } from '@nestjs/common';
import {
  ConfigurationModule,
  ConfigurationService,
} from '../../configuration/configuration.module';
import { PROCESSING_PROGRESS } from './processing-progress';
import { RedisProcessingProgressStore } from './redis-processing-progress.store';

@Module({
  imports: [ConfigurationModule],
  providers: [
    {
      provide: PROCESSING_PROGRESS,
      inject: [ConfigurationService],
      useFactory: (configuration: ConfigurationService) =>
        new RedisProcessingProgressStore(configuration.progress),
    },
  ],
  exports: [PROCESSING_PROGRESS],
})
export class ProgressModule {}
