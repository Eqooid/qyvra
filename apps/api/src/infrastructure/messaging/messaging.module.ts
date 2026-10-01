import { Module } from '@nestjs/common';
import {
  ConfigurationModule,
  ConfigurationService,
} from '../../configuration/configuration.module';
import { MESSAGE_PUBLISHER } from './message-publisher';
import { RabbitMqPublisher } from './rabbitmq.publisher';

/** Import only into a process that actually publishes; HTTP startup remains broker-independent. */
@Module({
  imports: [ConfigurationModule],
  providers: [
    {
      provide: MESSAGE_PUBLISHER,
      inject: [ConfigurationService],
      useFactory: (configuration: ConfigurationService) =>
        new RabbitMqPublisher(configuration.messaging),
    },
  ],
  exports: [MESSAGE_PUBLISHER],
})
export class MessagingModule {}
