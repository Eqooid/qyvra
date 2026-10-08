import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBody,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOperation,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { IsIn, isUUID } from 'class-validator';
import { OwnedMutationGuard } from '../../common/owned-mutation.guard';
import { AuthenticatedUser, CurrentUser, SessionAuthGuard } from '../auth';
import {
  AiIngestionService,
  reprocessingModes,
  ReprocessingMode,
} from '../ai/ai-ingestion.service';

export class AiReprocessingDto {
  @IsIn(reprocessingModes)
  mode: ReprocessingMode = 'repair';
}

@ApiTags('Document processing')
@ApiCookieAuth('session')
@UseGuards(SessionAuthGuard, OwnedMutationGuard)
@Controller('documents/:documentId/versions/:versionId/ai')
export class AiReprocessingController {
  constructor(private readonly ingestion: AiIngestionService) {}

  @Post('reprocess')
  @HttpCode(202)
  @ApiOperation({
    summary: 'Schedule owned current-version AI processing',
    description:
      'Database scheduling only. Repair reuses compatible outputs; explicit stage modes rerun that stage and downstream. Immutable identical artifacts may be reused by handlers. No provider configuration is accepted.',
  })
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
  @ApiParam({ name: 'documentId', format: 'uuid' })
  @ApiParam({ name: 'versionId', format: 'uuid' })
  @ApiBody({
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: {
          type: 'string',
          enum: [...reprocessingModes],
          default: 'repair',
        },
      },
    },
  })
  @ApiAcceptedResponse({
    schema: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: {
            runId: { type: 'string', format: 'uuid' },
            generation: { type: 'integer' },
            status: { type: 'string' },
          },
        },
      },
    },
  })
  @ApiNotFoundResponse()
  @ApiConflictResponse()
  @ApiServiceUnavailableResponse()
  reprocess(
    @CurrentUser() user: Readonly<AuthenticatedUser>,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
    @Param('versionId', new ParseUUIDPipe()) versionId: string,
    @Headers('idempotency-key') key: string,
    @Body() dto: AiReprocessingDto,
  ) {
    if (!isUUID(key, '4'))
      throw new BadRequestException('A UUIDv4 idempotency key is required.');
    return this.ingestion.reprocess(
      user.id,
      documentId.toLowerCase(),
      versionId.toLowerCase(),
      dto?.mode ?? 'repair',
      key.toLowerCase(),
    );
  }
}
