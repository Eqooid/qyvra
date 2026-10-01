import {
  BadRequestException,
  Controller,
  Headers,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiCookieAuth,
  ApiConsumes,
  ApiBody,
  ApiHeader,
  ApiCreatedResponse,
  ApiBadRequestResponse,
  ApiUnauthorizedResponse,
  ApiForbiddenResponse,
  ApiConflictResponse,
  ApiPayloadTooLargeResponse,
  ApiUnsupportedMediaTypeResponse,
  ApiServiceUnavailableResponse,
  ApiOperation,
  ApiResponse,
  ApiNotFoundResponse,
} from '@nestjs/swagger';
import { isUUID } from 'class-validator';
import { Request } from 'express';
import { SessionAuthGuard, CurrentUser, AuthenticatedUser } from '../auth';
import { OwnedMutationGuard } from '../../common/owned-mutation.guard';
import { UploadService } from './upload.service';

/** @description Creates a document and its first version only, through authenticated streaming multipart input. */
@ApiTags('Documents')
@ApiCookieAuth('session')
@UseGuards(SessionAuthGuard, OwnedMutationGuard)
@Controller('documents')
export class UploadController {
  constructor(private readonly uploads: UploadService) {}
  @Post()
  @ApiOperation({
    summary: 'Upload one PDF, JPEG or PNG and create version 1',
    description:
      'Title required. Creates UPLOADED/PENDING and durably schedules stored-file integrity verification; no processing runs in the request. Maximum bytes/pages/pixels use validated UPLOAD_* configuration (defaults 50 MiB/500/40 million). Same-owner checksums conflict, including deleted documents. Safe idempotency replay retains the original data for 24 hours.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiHeader({
    name: 'X-CSRF-Protection',
    required: true,
    schema: { type: 'string', enum: ['1'] },
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'title'],
      additionalProperties: false,
      properties: {
        file: { type: 'string', format: 'binary' },
        title: { type: 'string', minLength: 1, maxLength: 300 },
        description: {
          type: 'string',
          maxLength: 2000,
          description:
            'Optional; surrounding whitespace trimmed, empty stored as null.',
        },
        documentType: { type: 'string', default: 'OTHER' },
        issuer: { type: 'string', maxLength: 200 },
        referenceNumber: { type: 'string', maxLength: 200 },
        documentDate: { type: 'string', format: 'date' },
        expirationDate: { type: 'string', format: 'date' },
        categoryId: { type: 'string', format: 'uuid' },
        tagIds: {
          type: 'string',
          description:
            'JSON array of at most 100 owned tag UUIDs; duplicates removed.',
        },
      },
    },
  })
  @ApiCreatedResponse({
    description:
      'Standard data/meta envelope with safe document metadata, category, tags and first version metadata; never keys, checksums or bytes.',
    schema: {
      type: 'object',
      required: ['data', 'meta'],
      properties: {
        meta: {
          type: 'object',
          properties: { requestId: { type: 'string', format: 'uuid' } },
        },
        data: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', format: 'uuid' },
            title: { type: 'string' },
            status: { type: 'string', enum: ['UPLOADED'] },
            documentType: { type: 'string' },
            issuer: { type: 'string', nullable: true },
            referenceNumber: { type: 'string', nullable: true },
            documentDate: { type: 'string', format: 'date', nullable: true },
            expirationDate: { type: 'string', format: 'date', nullable: true },
            createdAt: { type: 'string', format: 'date-time' },
            category: {
              type: 'object',
              nullable: true,
              description:
                'Safe category: id, name, color, icon, createdAt, updatedAt.',
            },
            tags: {
              type: 'array',
              items: {
                type: 'object',
                description: 'Safe tag: id, name, createdAt, updatedAt.',
              },
            },
            version: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', format: 'uuid' },
                versionNumber: { type: 'integer', enum: [1] },
                originalFilename: { type: 'string', maxLength: 255 },
                mimeType: {
                  type: 'string',
                  enum: ['application/pdf', 'image/jpeg', 'image/png'],
                },
                fileSize: { type: 'integer', minimum: 1 },
                pageCount: { type: 'integer', minimum: 1, nullable: true },
                extractionStatus: { type: 'string', enum: ['PENDING'] },
                createdAt: { type: 'string', format: 'date-time' },
              },
            },
          },
        },
      },
    },
  })
  @ApiBadRequestResponse({
    description:
      'Invalid metadata, malformed/empty/encrypted file, multiple/missing files or page/pixel limit.',
  })
  @ApiUnauthorizedResponse()
  @ApiForbiddenResponse()
  @ApiNotFoundResponse({
    description: 'Category or tag unavailable to the authenticated user.',
  })
  @ApiResponse({ status: 408, description: 'Upload receive timeout.' })
  @ApiResponse({
    status: 429,
    description: 'Per-process concurrent upload capacity reached; retry later.',
  })
  @ApiConflictResponse({
    description:
      'Owned duplicate, concurrent same-key request, or mismatched idempotency replay.',
  })
  @ApiPayloadTooLargeResponse()
  @ApiUnsupportedMediaTypeResponse()
  @ApiServiceUnavailableResponse({
    description:
      'Storage, database or inspection unavailable; no false success.',
  })
  create(
    @CurrentUser() user: Readonly<AuthenticatedUser>,
    @Headers('idempotency-key') key: unknown,
    @Req() request: Request,
  ) {
    if (typeof key !== 'string' || !isUUID(key))
      throw new BadRequestException('Idempotency-Key must be a UUID');
    return this.uploads.create(user.id, key.toLowerCase(), request);
  }
}
