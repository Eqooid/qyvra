import { SearchEnrollmentModule } from '../../modules/search/search-enrollment.module';
import { SearchEnrollmentService } from '../../modules/search/search-enrollment.service';
import { Module } from '@nestjs/common';
import { ProcessingRepository } from '@qyvra/database';
import {
  ConfigurationModule,
  ConfigurationService,
} from '../../configuration/configuration.module';
import { DatabaseModule } from '../../database/database.module';
import { PrismaService } from '../../database/prisma.service';
import {
  MESSAGE_PUBLISHER,
  type MessagePublisher,
} from '../messaging/message-publisher';
import { MessagingModule } from '../messaging/messaging.module';
import { OutboxDispatcher } from './outbox-dispatcher.service';
import { ProcessingRecovery } from './processing-recovery.service';

@Module({
  imports: [
    ConfigurationModule,
    DatabaseModule,
    MessagingModule,
    SearchEnrollmentModule,
  ],
  providers: [
    {
      provide: OutboxDispatcher,
      inject: [PrismaService, MESSAGE_PUBLISHER, ConfigurationService],
      useFactory: (
        database: PrismaService,
        publisher: MessagePublisher,
        config: ConfigurationService,
      ) =>
        new OutboxDispatcher(
          new ProcessingRepository(database.client),
          publisher,
          config.outbox,
          undefined,
          (config.outbox.searchDeliveryEnabled ?? config.elasticsearch.enabled)
            ? ['INDEX_SEARCH', 'EXTRACT_SEARCH_TEXT', 'REMOVE_SEARCH_INDEX']
            : [],
        ),
    },
    {
      provide: ProcessingRecovery,
      inject: [PrismaService, ConfigurationService, SearchEnrollmentService],
      useFactory: (
        database: PrismaService,
        config: ConfigurationService,
        search: SearchEnrollmentService,
      ) =>
        new ProcessingRecovery(
          new ProcessingRepository(database.client),
          config.processingRecovery,
          undefined,
          () => search.reconcile(config.processingRecovery.batchSize),
        ),
    },
  ],
  exports: [OutboxDispatcher, ProcessingRecovery],
})
export class OutboxModule {}
