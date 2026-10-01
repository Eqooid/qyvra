import { Module } from '@nestjs/common';
import { StorageModule } from '../../infrastructure/storage/storage.module';
import { ObservabilityModule } from '../../common/observability.module';
import { UploadInspector } from '../../infrastructure/storage/upload-inspector';
import { UploadRepository } from './upload.repository';
import { UploadService } from './upload.service';
import { UploadController } from './upload.controller';
import { DownloadController } from './download.controller';
import { DownloadService } from './download.service';
import { VersionsController } from './versions.controller';
import { VersionsService } from './versions.service';
import { AuthModule } from '../auth';
import { DatabaseModule } from '../../database/database.module';
import { ConfigurationModule } from '../../configuration/configuration.module';
import { OwnedMutationGuard } from '../../common/owned-mutation.guard';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { ProcessingStatusController } from './processing-status.controller';
import { ProcessingStatusService } from './processing-status.service';
import { ProcessingStatusRepository } from './processing-status.repository';
import { ProgressModule } from '../../infrastructure/progress/progress.module';

/**
 * @author Cristono Wijaya
 * @description Wires the metadata-only document feature to existing ownership and persistence boundaries.
 * @tags Documents
 */
@Module({
  imports: [
    AuthModule,
    DatabaseModule,
    ConfigurationModule,
    StorageModule,
    ObservabilityModule,
    ProgressModule,
  ],
  controllers: [
    DocumentsController,
    UploadController,
    DownloadController,
    VersionsController,
    ProcessingStatusController,
  ],
  providers: [
    DocumentsService,
    OwnedMutationGuard,
    UploadRepository,
    UploadService,
    UploadInspector,
    DownloadService,
    VersionsService,
    ProcessingStatusService,
    ProcessingStatusRepository,
  ],
})
export class DocumentsModule {}
