import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiGatewayTimeoutResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  getSchemaPath,
  ApiExtraModels,
} from '@nestjs/swagger';
import { OwnedMutationGuard } from '../../common/owned-mutation.guard';
import {
  CurrentUser,
  CurrentSession,
  SessionAuthGuard,
  type AuthenticatedSession,
  type AuthenticatedUser,
} from '../auth';
import {
  KeywordSearchDto,
  KeywordSearchResponseDto,
} from './keyword-search.dto';
import { HybridSearchService } from './hybrid-search.service';

@ApiTags('Keyword search')
@ApiCookieAuth('session')
@UseGuards(SessionAuthGuard, OwnedMutationGuard)
@ApiExtraModels(KeywordSearchResponseDto)
@Controller('search')
export class KeywordSearchController {
  constructor(private readonly service: HybridSearchService) {}
  @Post('keyword')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Search authorized current-version metadata and PDF text',
    description:
      'Literal terms/phrase lexical search, independent of AI. SQL applies all filters before candidate retrieval and reauthorizes canonical output. Fixed bounded result windows reauthorize canonical SQL content on every page.',
  })
  @ApiHeader({
    name: 'X-CSRF-Protection',
    required: true,
    schema: { type: 'string', enum: ['1'] },
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      required: ['data', 'meta'],
      properties: {
        data: { $ref: getSchemaPath(KeywordSearchResponseDto) },
        meta: {
          type: 'object',
          properties: { requestId: { type: 'string', format: 'uuid' } },
        },
      },
    },
  })
  @ApiBadRequestResponse()
  @ApiUnauthorizedResponse()
  @ApiForbiddenResponse()
  @ApiNotFoundResponse()
  @ApiConflictResponse()
  @ApiTooManyRequestsResponse()
  @ApiGatewayTimeoutResponse()
  @ApiServiceUnavailableResponse()
  keyword(
    @CurrentUser() user: Readonly<AuthenticatedUser>,
    @Body() input: KeywordSearchDto,
    @CurrentSession() session: Readonly<AuthenticatedSession>,
  ) {
    return this.service.keywordSearch(user.id, session.sessionId, input);
  }
}
