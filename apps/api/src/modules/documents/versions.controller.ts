import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { isUUID } from 'class-validator';
import { Request } from 'express';
import { CurrentUser, AuthenticatedUser, SessionAuthGuard } from '../auth';
import { OwnedMutationGuard } from '../../common/owned-mutation.guard';
import { UploadService } from './upload.service';
import { VersionsService } from './versions.service';
import { VersionListQuery, versionSchema } from './versions.dto';

/** @description Read immutable metadata or append a file through the existing streaming use case. */
@ApiTags('Document versions')
@ApiCookieAuth('session')
@ApiParam({ name: 'documentId', type: String, format: 'uuid' })
@ApiUnauthorizedResponse()
@ApiBadRequestResponse()
@ApiNotFoundResponse({
  description:
    'Missing/unowned/deleted document or mismatched version; DELETING history unavailable.',
})
@UseGuards(SessionAuthGuard)
@Controller('documents/:documentId/versions')
export class VersionsController {
  constructor(
    private readonly versions: VersionsService,
    private readonly uploads: UploadService,
  ) {}
  @Get()
  @ApiOperation({
    summary: 'List owned immutable versions',
    description:
      'Newest version first; limit 25 by default, maximum 100. Exclusive UUID cursor must belong to this document. Archived allowed, deleted/DELETING unavailable. isLatest uses a consistent snapshot per request.',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: {
        data: { type: 'array', items: versionSchema },
        meta: {
          type: 'object',
          properties: {
            requestId: { type: 'string', format: 'uuid' },
            nextCursor: { type: 'string', format: 'uuid', nullable: true },
            hasMore: { type: 'boolean' },
          },
        },
      },
    },
  })
  list(
    @CurrentUser() user: Readonly<AuthenticatedUser>,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
    @Query() query: VersionListQuery,
    @Req() request: Request,
  ) {
    this.noBody(request);
    return this.versions.list(user.id, documentId.toLowerCase(), query);
  }
  @Get(':versionId')
  @ApiParam({ name: 'versionId', type: String, format: 'uuid' })
  @ApiOperation({
    summary: 'Get safe version metadata',
    description:
      'No query/body parameters or storage access. A mismatched version is indistinguishable from a missing one.',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: { data: versionSchema, meta: { type: 'object' } },
    },
  })
  detail(
    @CurrentUser() user: Readonly<AuthenticatedUser>,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
    @Param('versionId', new ParseUUIDPipe()) versionId: string,
    @Req() request: Request,
  ) {
    this.noBody(request);
    if (Object.keys(request.query).length) throw new BadRequestException();
    return this.versions.detail(
      user.id,
      documentId.toLowerCase(),
      versionId.toLowerCase(),
    );
  }
  @Post()
  @UseGuards(OwnedMutationGuard)
  @ApiOperation({
    summary: 'Append an immutable file version',
    description:
      'Exactly one file, no text fields. Reuses UPLOAD_* byte/page/pixel/time limits and PDF/JPEG/PNG validation. Archived, DELETING and PROCESSING uploads conflict; deleted is 404. Resets logical status to UPLOADED and new extractionStatus to PENDING. Same-owner checksums conflict across all documents. isLatest in this creation receipt refers to completion time; replay returns that original receipt.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', format: 'uuid' },
    description:
      'Scoped to owner, version-upload operation and document; 24-hour completed replay window.',
  })
  @ApiHeader({
    name: 'X-CSRF-Protection',
    required: true,
    schema: { type: 'string', enum: ['1'] },
  })
  @ApiBody({
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiCreatedResponse({
    schema: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: {
            documentId: { type: 'string', format: 'uuid' },
            status: { type: 'string', enum: ['UPLOADED'] },
            version: versionSchema,
          },
        },
        meta: { type: 'object' },
      },
    },
  })
  @ApiForbiddenResponse()
  @ApiConflictResponse({
    description:
      'Lifecycle, duplicate checksum, active key or incompatible replay conflict.',
  })
  @ApiResponse({ status: 413, description: 'Streaming byte limit exceeded.' })
  @ApiResponse({
    status: 415,
    description:
      'Unsupported file, MIME/signature mismatch, compressed input or non-multipart request.',
  })
  @ApiResponse({ status: 408, description: 'Receive timeout.' })
  @ApiResponse({
    status: 429,
    description: 'Shared upload concurrency capacity exhausted.',
  })
  @ApiServiceUnavailableResponse({
    description:
      'Storage/database/inspection failure; same safe compensation policy as initial upload.',
  })
  async upload(
    @CurrentUser() user: Readonly<AuthenticatedUser>,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
    @Headers('idempotency-key') key: unknown,
    @Req() request: Request,
  ) {
    if (typeof key !== 'string' || !isUUID(key))
      throw new BadRequestException('Idempotency-Key must be a UUID');
    const response = await this.uploads.create(
      user.id,
      key.toLowerCase(),
      request,
      documentId.toLowerCase(),
    );
    return {
      documentId: response.id,
      status: response.status,
      version: { ...response.version, isLatest: true },
    };
  }
  private noBody(request: Request) {
    if (
      request.headers['transfer-encoding'] !== undefined ||
      Number(request.headers['content-length'] ?? 0) > 0
    )
      throw new BadRequestException();
  }
}
