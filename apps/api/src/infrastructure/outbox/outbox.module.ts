import { Module } from '@nestjs/common';
import { ProcessingRepository } from '@brainless/database';
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
  imports: [ConfigurationModule, DatabaseModule, MessagingModule],
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
        ),
    },
    {
      provide: ProcessingRecovery,
      inject: [PrismaService, ConfigurationService],
      useFactory: (database: PrismaService, config: ConfigurationService) =>
        new ProcessingRecovery(
          new ProcessingRepository(database.client),
          config.processingRecovery,
        ),
    },
  ],
  exports: [OutboxDispatcher, ProcessingRecovery],
})
export class OutboxModule {}
