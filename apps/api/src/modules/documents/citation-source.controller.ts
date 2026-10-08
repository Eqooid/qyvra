import {
  BadRequestException,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
import {
  CitationSourceService,
  type CitationSource,
} from './citation-source.service';
import { AuthenticatedUser, CurrentUser, SessionAuthGuard } from '../auth';

/** Canonical immutable source resolution, including retained historical versions. */
@ApiTags('Document sources')
@ApiCookieAuth('session')
@UseGuards(SessionAuthGuard)
@Controller('documents/:documentId/versions/:versionId/chunks/:chunkId')
export class CitationSourceController {
  constructor(private readonly sources: CitationSourceService) {}
  @Get()
  @ApiOperation({
    summary: 'Resolve an owned canonical citation source',
    description:
      'Reauthorizes document, exact version and complete chunk set. Historical retained sources remain resolvable; archived, deleted, foreign or missing sources return 404. No file/storage/vector references.',
  })
  @ApiParam({ name: 'documentId', format: 'uuid' })
  @ApiParam({ name: 'versionId', format: 'uuid' })
  @ApiParam({ name: 'chunkId', format: 'uuid' })
  @ApiOkResponse({
    description:
      'Standard envelope with canonical document/version/chunk IDs, versionNumber, chunkOrdinal, title, originalFilename, pageSpans, excerptStart/excerptEnd/excerptHash/excerpt.',
    schema: {
      type: 'object',
      required: ['data', 'meta'],
      properties: {
        data: {
          type: 'object',
          required: [
            'documentId',
            'documentVersionId',
            'chunkId',
            'chunkOrdinal',
            'title',
            'versionNumber',
            'originalFilename',
            'pageSpans',
            'excerptStart',
            'excerptEnd',
            'excerptHash',
            'excerpt',
          ],
          properties: {
            documentId: { type: 'string', format: 'uuid' },
            documentVersionId: { type: 'string', format: 'uuid' },
            chunkId: { type: 'string', format: 'uuid' },
            chunkOrdinal: { type: 'integer', minimum: 0 },
            title: { type: 'string' },
            versionNumber: { type: 'integer', minimum: 1 },
            originalFilename: { type: 'string' },
            pageSpans: {
              type: 'array',
              items: {
                type: 'object',
                required: ['pageNumber', 'startOffset', 'endOffset'],
                properties: {
                  pageNumber: { type: 'integer', minimum: 1 },
                  startOffset: { type: 'integer', minimum: 0 },
                  endOffset: { type: 'integer', minimum: 1 },
                },
              },
            },
            excerptStart: { type: 'integer', minimum: 0 },
            excerptEnd: { type: 'integer', minimum: 1 },
            excerptHash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
            excerpt: { type: 'string' },
          },
        },
        meta: {
          type: 'object',
          properties: { requestId: { type: 'string', format: 'uuid' } },
        },
      },
    },
  })
  @ApiUnauthorizedResponse()
  @ApiBadRequestResponse()
  @ApiNotFoundResponse()
  async resolve(
    @CurrentUser() user: Readonly<AuthenticatedUser>,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
    @Param('versionId', new ParseUUIDPipe()) versionId: string,
    @Param('chunkId', new ParseUUIDPipe()) chunkId: string,
    @Req() request: Request,
  ): Promise<CitationSource> {
    if (
      Object.keys(request.query).length ||
      request.headers['transfer-encoding'] !== undefined ||
      Number(request.headers['content-length'] ?? 0) > 0
    )
      throw new BadRequestException();
    return this.sources.resolve(
      user.id,
      documentId.toLowerCase(),
      versionId.toLowerCase(),
      chunkId.toLowerCase(),
    );
  }
}
