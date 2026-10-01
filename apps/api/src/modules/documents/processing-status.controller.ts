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
import { Request } from 'express';
import { AuthenticatedUser, CurrentUser, SessionAuthGuard } from '../auth';
import { ProcessingStatusService } from './processing-status.service';
import { ProcessingStatusView } from './processing-status.dto';

@ApiTags('Document processing')
@ApiCookieAuth('session')
@ApiExtraModels(ProcessingStatusView)
@ApiUnauthorizedResponse()
@ApiBadRequestResponse()
@ApiNotFoundResponse({
  description: 'Missing, foreign, or unavailable version.',
})
@UseGuards(SessionAuthGuard)
@Controller('documents/:documentId/versions/:versionId/processing')
export class ProcessingStatusController {
  constructor(private readonly status: ProcessingStatusService) {}

  @Get()
  @ApiOperation({
    summary: 'Get owned version processing status',
    description:
      'Newest job generation for each processing type. An empty jobs array means no processing was scheduled. Archived versions remain readable; deleted versions do not. PostgreSQL is authoritative. No query or body parameters are accepted.',
  })
  @ApiParam({ name: 'documentId', format: 'uuid', type: String })
  @ApiParam({ name: 'versionId', format: 'uuid', type: String })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: {
        data: { $ref: getSchemaPath(ProcessingStatusView) },
        meta: {
          type: 'object',
          properties: { requestId: { type: 'string', format: 'uuid' } },
        },
      },
    },
  })
  getStatus(
    @CurrentUser() user: Readonly<AuthenticatedUser>,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
    @Param('versionId', new ParseUUIDPipe()) versionId: string,
    @Req() request: Request,
  ) {
    if (
      Object.keys(request.query).length ||
      request.headers['transfer-encoding'] !== undefined ||
      Number(request.headers['content-length'] ?? 0) > 0
    )
      throw new BadRequestException();
    return this.status.forVersion(
      user.id,
      documentId.toLowerCase(),
      versionId.toLowerCase(),
    );
  }
}
