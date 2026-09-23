import {
  HttpException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { STORAGE, Storage, StorageError } from '@brainless/storage';
import { Request } from 'express';
import { randomUUID } from 'node:crypto';
import { ConfigurationService } from '../../configuration/configuration.module';
import { StructuredLogger } from '../../common/structured-logger';
import { UploadInspector } from '../../infrastructure/storage/upload-inspector';
import { UploadRepository } from './upload.repository';
import { receiveUpload } from './upload-multipart';

/** @description Coordinates storage/SQL compensation without holding a transaction while receiving bytes. */
@Injectable()
export class UploadService {
  private active = 0;
  constructor(
    @Inject(STORAGE) private readonly storage: Storage,
    private readonly repository: UploadRepository,
    private readonly inspector: UploadInspector,
    private readonly configuration: ConfigurationService,
    private readonly logger: StructuredLogger,
  ) {}
  async create(
    userId: string,
    key: string,
    request: Request,
    targetDocumentId?: string,
  ) {
    if (this.active >= this.configuration.upload.concurrency)
      throw new HttpException('Upload capacity reached', 429);
    this.active++;
    const documentId = targetDocumentId ?? randomUUID(),
      versionId = randomUUID();
    const scope = targetDocumentId ? `versions:${documentId}` : 'create';
    let storageKey: string | undefined;
    let attemptId: string | undefined;
    let committed = false;
    let completing = false;
    const cleanup = async () => {
      if (!storageKey) return;
      try {
        await this.storage.delete(storageKey);
      } catch {
        this.logger.event('error', 'upload.storage_cleanup_failed', {
          documentId,
          versionId,
        });
      }
    };
    try {
      if (targetDocumentId)
        await this.repository.assertVersionTarget(userId, documentId);
      const reservation = await this.repository.reserve(userId, key, scope);
      attemptId = reservation.attemptId;
      const file = await receiveUpload(
        request,
        this.storage,
        { userId, documentId, versionId },
        this.configuration.upload,
        (value) => {
          storageKey = value;
        },
        Boolean(targetDocumentId),
      );
      const pageCount = await this.inspector.inspect(
        this.storage,
        file.key,
        file.mime,
      );
      completing = true;
      const result = await this.repository.complete(
        userId,
        key,
        attemptId,
        documentId,
        versionId,
        file,
        pageCount,
        scope,
      );
      committed = !result.replay;
      if (result.replay) await cleanup();
      return result.response;
    } catch (error) {
      if (completing && attemptId && !(error instanceof HttpException)) {
        try {
          const response = await this.repository.committed(
            userId,
            key,
            attemptId,
            documentId,
            scope,
            targetDocumentId ? versionId : undefined,
          );
          if (response) {
            committed = true;
            return response;
          }
        } catch {
          // Preserve the file when commit outcome cannot be established; reconciliation must resolve it.
          committed = true;
          this.logger.event('error', 'upload.commit_outcome_unknown', {
            documentId,
            versionId,
          });
        }
      }
      if (
        !committed &&
        !(error instanceof StorageError && error.code === 'ALREADY_EXISTS')
      )
        await cleanup();
      if (attemptId) {
        try {
          await this.repository.release(userId, key, attemptId, scope);
        } catch {
          this.logger.event('error', 'upload.reservation_cleanup_failed', {
            documentId,
            versionId,
          });
        }
      }
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException('Upload unavailable');
    } finally {
      this.active--;
    }
  }
}
