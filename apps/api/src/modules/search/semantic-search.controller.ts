import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiHeader,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
  ApiOkResponse,
  ApiServiceUnavailableResponse,
  ApiBadRequestResponse,
  ApiUnauthorizedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiTooManyRequestsResponse,
  ApiGatewayTimeoutResponse,
} from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { OwnedMutationGuard } from '../../common/owned-mutation.guard';
import { AuthenticatedUser, CurrentUser, SessionAuthGuard } from '../auth';
import { SemanticSearchService } from './semantic-search.service';

export class SemanticSearchDto {
  @ApiProperty({
    minLength: 1,
    maxLength: 4000,
    description: 'Trimmed question; maximum 4000 UTF-16 code units.',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  query!: string;
  @ApiPropertyOptional({ default: 8, minimum: 1, maximum: 20 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  limit?: number;
  @ApiPropertyOptional({
    type: [String],
    maxItems: 50,
    description:
      'Optional owned, active document UUIDs. Every ID must be accessible.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  @Transform(({ value }: { value: unknown }) =>
    Array.isArray(value)
      ? value.map((v: unknown) => (typeof v === 'string' ? v.toLowerCase() : v))
      : value,
  )
  documentIds?: string[];
}
@ApiTags('Semantic search')
@ApiCookieAuth('session')
@UseGuards(SessionAuthGuard, OwnedMutationGuard)
@Controller('search')
export class SemanticSearchController {
  constructor(private readonly search: SemanticSearchService) {}
  @Post('semantic')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Search authorized current-version document chunks',
    description:
      'Cosine scores are similarity values, not confidence. No index repair or RAG generation occurs. Returns an empty results array when the selected profile has no eligible owned indexes.',
  })
  @ApiHeader({
    name: 'X-CSRF-Protection',
    required: true,
    schema: { type: 'string', enum: ['1'] },
  })
  @ApiOkResponse({
    description:
      'Envelope containing results with canonical document/version/chunk IDs, title, filename, ordinal, pageSpans, Unicode scalar half-open offsets, exact excerpt/hash, score, profile and manifest IDs.',
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
          required: ['results'],
          properties: {
            results: {
              type: 'array',
              maxItems: 20,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  chunkId: { type: 'string', format: 'uuid' },
                  documentId: { type: 'string', format: 'uuid' },
                  documentVersionId: { type: 'string', format: 'uuid' },
                  chunkSetId: { type: 'string', format: 'uuid' },
                  indexManifestId: { type: 'string', format: 'uuid' },
                  embeddingProfileId: { type: 'string', format: 'uuid' },
                  chunkOrdinal: { type: 'integer', minimum: 0 },
                  versionNumber: { type: 'integer', minimum: 1 },
                  title: { type: 'string' },
                  originalFilename: { type: 'string' },
                  excerpt: { type: 'string' },
                  excerptHash: { type: 'string' },
                  startOffset: { type: 'integer', minimum: 0 },
                  endOffset: { type: 'integer', minimum: 0 },
                  score: {
                    type: 'number',
                    description:
                      'Cosine similarity, higher is better; not a probability.',
                  },
                  pageSpans: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        pageNumber: { type: 'integer', minimum: 1 },
                        startOffset: { type: 'integer', minimum: 0 },
                        endOffset: { type: 'integer', minimum: 0 },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  })
  @ApiBadRequestResponse()
  @ApiUnauthorizedResponse()
  @ApiForbiddenResponse()
  @ApiNotFoundResponse()
  @ApiTooManyRequestsResponse()
  @ApiGatewayTimeoutResponse()
  @ApiServiceUnavailableResponse()
  semantic(
    @CurrentUser() user: Readonly<AuthenticatedUser>,
    @Body() input: SemanticSearchDto,
  ) {
    return this.search.search(user.id, input);
  }
}
