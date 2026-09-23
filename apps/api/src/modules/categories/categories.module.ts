import { Module } from '@nestjs/common';
import { AuthModule } from '../auth';
import { DatabaseModule } from '../../database/database.module';
import { ConfigurationModule } from '../../configuration/configuration.module';
import { CategoriesController } from './categories.controller';
import { CategoriesService } from './categories.service';
import { CategoryMutationGuard } from './category-mutation.guard';

/**
 * @author Cristono Wijaya
 * @description Wires owned category operations to the existing authentication and database modules.
 * @tags Categories
 */
@Module({
  imports: [AuthModule, DatabaseModule, ConfigurationModule],
  controllers: [CategoriesController],
  providers: [CategoriesService, CategoryMutationGuard],
})

/**
 * @author Cristono Wijaya
 * @description The CategoriesModule is a NestJS module that encapsulates the functionality related to category management. It imports necessary modules for authentication, database access, and configuration. It also defines the controller and service responsible for handling category-related operations, as well as a guard to manage category mutations.
 * @tags Categories
 */
export class CategoriesModule {}
