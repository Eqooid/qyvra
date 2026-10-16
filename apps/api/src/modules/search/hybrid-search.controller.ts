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
import { KeywordSearchDto } from './keyword-search.dto';
import { HybridSearchResponseDto } from './hybrid-search.dto';
import { HybridSearchService } from './hybrid-search.service';

@ApiTags('Hybrid search')
@ApiCookieAuth('session')
@UseGuards(SessionAuthGuard, OwnedMutationGuard)
@ApiExtraModels(HybridSearchResponseDto)
@Controller('search')
export class HybridSearchController {
  constructor(private readonly service: HybridSearchService) {}
  @Post('hybrid')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Fuse authorized lexical and semantic document candidates',
    description:
      'Literal terms/phrase lexical search, combined with profile-compatible semantic candidates using document RRF. SQL applies all filters before candidate retrieval and reauthorizes canonical output. Fixed bounded result windows reauthorize canonical SQL content on every page.',
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
        data: { $ref: getSchemaPath(HybridSearchResponseDto) },
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
  hybrid(
    @CurrentUser() user: Readonly<AuthenticatedUser>,
    @Body() input: KeywordSearchDto,
    @CurrentSession() session: Readonly<AuthenticatedSession>,
  ) {
    return this.service.hybridSearch(user.id, session.sessionId, input);
  }
}
