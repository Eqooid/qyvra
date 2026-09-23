import { Module } from '@nestjs/common';
import { AuthModule } from '../auth';
import { DatabaseModule } from '../../database/database.module';
import { ConfigurationModule } from '../../configuration/configuration.module';
import { TagsController } from './tags.controller';
import { TagsService } from './tags.service';
import { OwnedMutationGuard } from '../../common/owned-mutation.guard';

/**
 * @author Cristono Wijaya
 * @description Wires owned tag operations to the existing authentication and database modules.
 * @tags Tags
 */
@Module({
  imports: [AuthModule, DatabaseModule, ConfigurationModule],
  controllers: [TagsController],
  providers: [TagsService, OwnedMutationGuard],
})

/**
 * @author Cristono Wijaya
 * @description The TagsModule encapsulates the functionality related to tag management, including CRUD operations and ownership validation.
 * @tags Tags
 */
export class TagsModule {}
