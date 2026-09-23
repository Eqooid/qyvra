import { Module } from '@nestjs/common';
import { createPrismaClient } from '@brainless/database';
import {
  ConfigurationModule,
  ConfigurationService,
} from '../configuration/configuration.module';
import { PRISMA_CLIENT, PrismaService } from './prisma.service';

/**
 * @author Cristono Wijaya
 * @description Creates the shared Prisma client from validated configuration and exports its lifecycle-aware service.
 * @tags Database Lifecycle
 * @class DatabaseModule
 * @module DatabaseModule
 */
@Module({
  imports: [ConfigurationModule],
  providers: [
    {
      provide: PRISMA_CLIENT,
      inject: [ConfigurationService],
      useFactory: (config: ConfigurationService) =>
        createPrismaClient(config.database),
    },
    PrismaService,
  ],
  exports: [PrismaService],
})
export class DatabaseModule {}
