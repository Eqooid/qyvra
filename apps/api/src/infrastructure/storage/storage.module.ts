import { Module } from '@nestjs/common';
import { LocalFileStorage, STORAGE, Storage } from '@qyvra/storage';
import {
  ConfigurationModule,
  ConfigurationService,
} from '../../configuration/configuration.module';

/** @author Cristono Wijaya
 * @description Binds the shared storage token using validated configuration. Disk access is lazy until an operation needs it.
 * @tags Storage
 */
@Module({
  imports: [ConfigurationModule],
  providers: [
    {
      provide: STORAGE,
      inject: [ConfigurationService],
      useFactory: (configuration: ConfigurationService): Storage => {
        const { provider, localRoot } = configuration.storage;
        if (provider !== 'local')
          throw new Error('Unsupported storage provider.');
        return new LocalFileStorage(localRoot);
      },
    },
  ],
  exports: [STORAGE],
})

/**
 * @author Cristono Wijaya
 * @description Storage module that provides a shared storage token for dependency injection.
 * @tags Storage
 */
export class StorageModule {}
