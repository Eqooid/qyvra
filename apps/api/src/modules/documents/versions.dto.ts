import { ApiPropertyOptional, PickType } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { CursorQuery } from '../../common/cursor-query';
import { UploadResponse } from './upload.dto';

/** @description Existing bounded UUID cursor contract, with immutable version-number ordering. */
export class VersionListQuery extends PickType(CursorQuery, [
  'limit',
  'cursor',
] as const) {
  @ApiPropertyOptional({ default: '-versionNumber', enum: ['-versionNumber'] })
  @IsIn(['-versionNumber'])
  sort = '-versionNumber';
}
export type VersionView = UploadResponse['version'] & { isLatest: boolean };

/** @description Explicit public shape excludes checksum, owner and storage identifiers. */
export const versionSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', format: 'uuid' },
    versionNumber: { type: 'integer', minimum: 1 },
    originalFilename: { type: 'string' },
    mimeType: {
      type: 'string',
      enum: ['application/pdf', 'image/jpeg', 'image/png'],
    },
    fileSize: { type: 'integer', minimum: 1 },
    pageCount: { type: 'integer', minimum: 1, nullable: true },
    extractionStatus: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    isLatest: { type: 'boolean' },
  },
};
