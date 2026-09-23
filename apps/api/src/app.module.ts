import { Module } from '@nestjs/common';
import { StorageModule } from './infrastructure/storage/storage.module';
import { ConfigurationModule } from './configuration/configuration.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ObservabilityModule } from './common/observability.module';
import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { TagsModule } from './modules/tags/tags.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { CategoriesModule } from './modules/categories/categories.module';

/**
 * @Module - The main application module that imports necessary modules, declares controllers, and provides services.
 * @description This module serves as the entry point for the application, orchestrating the various components and services.
 * @tags Application
 * @author Cristono Wijaya
 */
@Module({
  imports: [
    ConfigurationModule,
    StorageModule,
    ObservabilityModule,
    HealthModule,
    AuthModule,
    CategoriesModule,
    TagsModule,
    DocumentsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})

/**
 * @class AppModule
 * @description The main application module that serves as the entry point for the application.
 * It imports necessary modules, declares controllers, and provides services.
 * @tags Application
 * @author Cristono Wijaya
 */
export class AppModule {}
