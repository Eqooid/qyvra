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
  getSchemaPath,
  ApiExtraModels,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthenticatedUser, CurrentUser, SessionAuthGuard } from '../auth';
import {
  LexicalPageSourceDto,
  LexicalSourceService,
} from './lexical-source.service';

export function sourceInteger(value: string, min: number, max: number): number {
  if (!/^(0|[1-9][0-9]{0,4})$/.test(value)) throw new BadRequestException();
  const n = Number(value);
  if (n < min || n > max) throw new BadRequestException();
  return n;
}
@ApiTags('Document sources')
@ApiCookieAuth('session')
@UseGuards(SessionAuthGuard)
@ApiExtraModels(LexicalPageSourceDto)
@Controller(
  'documents/:documentId/versions/:versionId/extractions/:extractionId/pages/:pageNumber/segments/:segment',
)
export class LexicalSourceController {
  constructor(private readonly sources: LexicalSourceService) {}
  @Get()
  @ApiOperation({
    summary: 'Resolve an owned canonical lexical page segment',
    description:
      'Plain canonical text only. Retained historical verified sources are allowed; archived/deleted/foreign/missing/unpublished references return the same 404. No PDF URL or storage path.',
  })
  @ApiParam({ name: 'documentId', format: 'uuid' })
  @ApiParam({ name: 'versionId', format: 'uuid' })
  @ApiParam({ name: 'extractionId', format: 'uuid' })
  @ApiParam({
    name: 'pageNumber',
    schema: { type: 'integer', minimum: 1, maximum: 10000 },
  })
  @ApiParam({
    name: 'segment',
    schema: { type: 'integer', minimum: 0, maximum: 10000 },
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      required: ['data', 'meta'],
      properties: {
        data: { $ref: getSchemaPath(LexicalPageSourceDto) },
        meta: {
          type: 'object',
          properties: { requestId: { type: 'string', format: 'uuid' } },
        },
      },
    },
  })
  @ApiBadRequestResponse()
  @ApiUnauthorizedResponse()
  @ApiNotFoundResponse()
  resolve(
    @CurrentUser() user: Readonly<AuthenticatedUser>,
    @Param('documentId', new ParseUUIDPipe()) doc: string,
    @Param('versionId', new ParseUUIDPipe()) version: string,
    @Param('extractionId', new ParseUUIDPipe()) extraction: string,
    @Param('pageNumber') page: string,
    @Param('segment') segment: string,
    @Req() request: Request,
  ) {
    if (
      Object.keys(request.query).length ||
      request.headers['transfer-encoding'] !== undefined ||
      Number(request.headers['content-length'] ?? 0) > 0
    )
      throw new BadRequestException();
    return this.sources.resolve(
      user.id,
      doc.toLowerCase(),
      version.toLowerCase(),
      extraction.toLowerCase(),
      sourceInteger(page, 1, 10000),
      sourceInteger(segment, 0, 10000),
    );
  }
}
