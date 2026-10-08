import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiGatewayTimeoutResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { OwnedMutationGuard } from '../../common/owned-mutation.guard';
import { AuthenticatedUser, CurrentUser, SessionAuthGuard } from '../auth';
import { RagAnswerService } from './rag-answer.service';

export class RagAnswerDto {
  @ApiProperty({
    minLength: 1,
    maxLength: 4000,
    description: 'Standalone question, trimmed; UTF-16 code units.',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  question!: string;
  @ApiPropertyOptional({
    type: [String],
    minItems: 1,
    maxItems: 50,
    description: 'Narrow to owned active documents. Foreign IDs return 404.',
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
@ApiTags('RAG')
@ApiCookieAuth('session')
@UseGuards(SessionAuthGuard, OwnedMutationGuard)
@Controller('rag')
export class RagAnswerController {
  constructor(private readonly rag: RagAnswerService) {}
  @Post('answers')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Generate a grounded answer from authorized current-version evidence',
    description:
      'One bounded generation request. No conversation persistence. Citations are validated server-side; insufficient evidence is a typed successful result.',
  })
  @ApiHeader({
    name: 'X-CSRF-Protection',
    required: true,
    schema: { type: 'string', enum: ['1'] },
  })
  @ApiOkResponse({
    description:
      'Standard envelope. Answered: outcome, answer, claims (text/citationIds), citations (owned document/version/chunk IDs, title/filename, pageSpans, excerptStart/excerptEnd/excerptHash/excerpt), requestId. Insufficient: outcome, answer:null, citations:[], reason, requestId.',
    schema: {
      type: 'object',
      required: ['data', 'meta'],
      properties: {
        meta: {
          type: 'object',
          required: ['requestId'],
          properties: { requestId: { type: 'string', format: 'uuid' } },
        },
        data: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              required: [
                'outcome',
                'answer',
                'claims',
                'citations',
                'requestId',
              ],
              properties: {
                outcome: { type: 'string', enum: ['answered'] },
                answer: { type: 'string', maxLength: 40000 },
                requestId: { type: 'string', format: 'uuid' },
                claims: {
                  type: 'array',
                  minItems: 1,
                  maxItems: 64,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['text', 'citationIds'],
                    properties: {
                      text: { type: 'string', maxLength: 2048 },
                      citationIds: {
                        type: 'array',
                        minItems: 1,
                        maxItems: 20,
                        uniqueItems: true,
                        items: { type: 'string', pattern: '^S[1-9][0-9]*$' },
                      },
                    },
                  },
                },
                citations: {
                  type: 'array',
                  minItems: 1,
                  maxItems: 20,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: [
                      'citationId',
                      'documentId',
                      'documentVersionId',
                      'versionNumber',
                      'chunkId',
                      'chunkOrdinal',
                      'title',
                      'originalFilename',
                      'pageSpans',
                      'excerptStart',
                      'excerptEnd',
                      'excerptHash',
                      'excerpt',
                    ],
                    properties: {
                      citationId: { type: 'string', pattern: '^S[1-9][0-9]*$' },
                      documentId: { type: 'string', format: 'uuid' },
                      documentVersionId: { type: 'string', format: 'uuid' },
                      chunkId: { type: 'string', format: 'uuid' },
                      versionNumber: { type: 'integer', minimum: 1 },
                      chunkOrdinal: { type: 'integer', minimum: 0 },
                      title: { type: 'string' },
                      originalFilename: { type: 'string' },
                      excerptStart: { type: 'integer', minimum: 0 },
                      excerptEnd: { type: 'integer', minimum: 0 },
                      excerptHash: {
                        type: 'string',
                        pattern: '^[0-9a-f]{64}$',
                      },
                      excerpt: { type: 'string', maxLength: 65536 },
                      pageSpans: {
                        type: 'array',
                        minItems: 1,
                        items: {
                          type: 'object',
                          required: ['pageNumber', 'startOffset', 'endOffset'],
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
            {
              type: 'object',
              additionalProperties: false,
              required: [
                'outcome',
                'answer',
                'citations',
                'reason',
                'requestId',
              ],
              properties: {
                outcome: { type: 'string', enum: ['insufficient_evidence'] },
                answer: { type: 'string', nullable: true, enum: [null] },
                citations: {
                  type: 'array',
                  maxItems: 0,
                  items: { type: 'object' },
                },
                reason: {
                  type: 'string',
                  enum: [
                    'no_authorized_evidence',
                    'context_budget',
                    'model_insufficient_evidence',
                    'evidence_changed',
                  ],
                },
                requestId: { type: 'string', format: 'uuid' },
              },
            },
          ],
        },
      },
    },
  })
  @ApiBadRequestResponse()
  @ApiUnauthorizedResponse()
  @ApiForbiddenResponse()
  @ApiNotFoundResponse()
  @ApiTooManyRequestsResponse()
  @ApiServiceUnavailableResponse()
  @ApiGatewayTimeoutResponse()
  @ApiBadGatewayResponse({
    description:
      'AI_OUTPUT_INVALID: malformed, uncited or fabricated source references; no model text returned.',
  })
  answer(
    @CurrentUser() user: Readonly<AuthenticatedUser>,
    @Body() input: RagAnswerDto,
  ) {
    return this.rag.answer(user.id, input);
  }
}
