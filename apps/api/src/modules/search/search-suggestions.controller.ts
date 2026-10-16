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
import { CurrentUser, SessionAuthGuard, type AuthenticatedUser } from '../auth';
import { KeywordSearchService } from './keyword-search.service';
import {
  SearchSuggestionsDto,
  SearchSuggestionsResponseDto,
} from './search-suggestions.dto';

@ApiTags('Search suggestions')
@ApiCookieAuth('session')
@UseGuards(SessionAuthGuard, OwnedMutationGuard)
@ApiExtraModels(SearchSuggestionsResponseDto)
@Controller('search')
export class SearchSuggestionsController {
  constructor(private readonly service: KeywordSearchService) {}
  @Post('suggestions')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Suggest private current document title, issuer or reference text',
    description:
      'Bounded owner-filtered metadata prefix search. SQL reauthorizes current verified publications; no extracted text, filenames, global dictionary or result counts. No cache or AI call.',
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
        data: { $ref: getSchemaPath(SearchSuggestionsResponseDto) },
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
    @Body() input: SearchSuggestionsDto,
  ) {
    return this.service.suggestions(user.id, input);
  }
}
