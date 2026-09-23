import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Request } from 'express';
import { AuthenticatedUser, CurrentUser, SessionAuthGuard } from '../auth';
import { TagsService, TagConflict, TagNotFound } from './tags.service';
import { TagListQuery, CreateTagDto, UpdateTagDto } from './tags.dto';
import { OwnedMutationGuard } from '../../common/owned-mutation.guard';

/** @description Safe response schema; ownership and private metadata are not returned. */
const itemSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};
/** @description Standard single-tag success envelope. */
const responseSchema = {
  type: 'object',
  properties: {
    data: itemSchema,
    meta: {
      type: 'object',
      properties: { requestId: { type: 'string', format: 'uuid' } },
    },
  },
};

/**
 * @author Cristono Wijaya
 * @description Exposes tag CRUD using only the guard-authenticated internal owner ID.
 * @tags Tags
 */
@ApiTags('Tags')
@ApiCookieAuth('session')
@ApiUnauthorizedResponse({
  description: 'Missing, invalid, expired or revoked session.',
})
@ApiBadRequestResponse({ description: 'Invalid or unsupported input.' })
@UseGuards(SessionAuthGuard, OwnedMutationGuard)
@Controller('tags')
export class TagsController {
  /**
   * @author Cristono Wijaya
   * @description Injects TagsService for tag management operations.
   * @tags Tags
   * @param tags - The TagsService instance for managing tags.
   * @constructor
   */
  constructor(private readonly tags: TagsService) {}

  /**
   * @author Cristono Wijaya
   * @description Lists owned tags with pagination and optional filtering.
   * @tags Tags
   * @param user - The authenticated user making the request.
   * @param query - The query parameters for listing tags, including limit, cursor, sort order, and optional search term.
   * @returns A paginated list of owned tags based on the provided query parameters.
   * @throws Error - Throws an error if tag listing fails for any reason.
   */
  @Get()
  @ApiOperation({
    summary: 'List your tags',
    description:
      'Ascending UUID order; limit defaults to 25 (maximum 100). Cursor is an exclusive UUID bound. Only sort=id is supported. Optional q is a normalized, case-insensitive literal substring, 1-100 characters; SQL wildcard characters are literal.',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: {
        data: { type: 'array', items: itemSchema },
        meta: {
          type: 'object',
          properties: {
            requestId: { type: 'string' },
            nextCursor: { type: 'string', nullable: true },
            hasMore: { type: 'boolean' },
          },
        },
      },
    },
  })
  list(
    @CurrentUser() user: Readonly<AuthenticatedUser>,
    @Query() query: TagListQuery,
  ) {
    return this.tags.list(user.id, query);
  }

  /**
   * @author Cristono Wijaya
   * @description Creates a new tag for the authenticated user.
   * @tags Tags
   * @param user - The authenticated user making the request.
   * @param dto - The data transfer object containing the tag details (name).
   * @returns The newly created tag object.
   * @throws TagConflict - Throws an error if a tag with the same normalized name already exists for the user.
   * @throws Error - Throws a generic error if tag creation fails for any reason.
   */
  @Post()
  @ApiHeader({
    name: 'X-CSRF-Protection',
    required: true,
    schema: { type: 'string', enum: ['1'] },
  })
  @ApiForbiddenResponse({
    description: 'Missing CSRF header or untrusted Origin.',
  })
  @ApiConflictResponse({
    description: 'An owned tag uses the same normalized name, ignoring case.',
  })
  @ApiCreatedResponse({ schema: responseSchema })
  @ApiOperation({ summary: 'Create a tag' })
  create(
    @CurrentUser() user: Readonly<AuthenticatedUser>,
    @Body() dto: CreateTagDto,
  ) {
    return this.result(() => this.tags.create(user.id, dto));
  }

  /**
   * @author Cristono Wijaya
   * @description Updates the name of an existing tag owned by the authenticated user.
   * @tags Tags
   * @param user - The authenticated user making the request.
   * @param id - The ID of the tag to be updated.
   * @param dto - The data transfer object containing the updated tag details (name).
   * @returns The updated tag object.
   * @throws TagNotFound - Throws an error if the tag does not exist or is not owned by the user.
   * @throws TagConflict - Throws an error if a tag with the same normalized name already exists for the user.
   * @throws BadRequestException - Throws an error if the request body is missing or empty.
   * @throws Error - Throws a generic error if tag update fails for any reason.
   */
  @Patch(':tagId')
  @ApiHeader({
    name: 'X-CSRF-Protection',
    required: true,
    schema: { type: 'string', enum: ['1'] },
  })
  @ApiForbiddenResponse({
    description: 'Missing CSRF header or untrusted Origin.',
  })
  @ApiNotFoundResponse({ description: 'Tag missing or not owned.' })
  @ApiConflictResponse({
    description: 'An owned tag uses the same normalized name.',
  })
  @ApiOkResponse({ schema: responseSchema })
  @ApiOperation({
    summary: 'Rename your tag',
    description: 'Exactly name is required; it cannot be null.',
  })
  update(
    @CurrentUser() user: Readonly<AuthenticatedUser>,
    @Param('tagId', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateTagDto,
  ) {
    if (!dto || !Object.keys(dto).length) throw new BadRequestException();
    return this.result(() => this.tags.update(user.id, id, dto));
  }

  /**
   * @author Cristono Wijaya
   * @description Permanently deletes an existing tag owned by the authenticated user.
   * @tags Tags
   * @param user - The authenticated user making the request.
   * @param id - The ID of the tag to be deleted.
   * @param request - The HTTP request object, used to validate the request body.
   * @returns An object indicating that the tag was successfully deleted.
   * @throws TagNotFound - Throws an error if the tag does not exist or is not owned by the user.
   * @throws BadRequestException - Throws an error if the request body is not empty or invalid.
   * @throws Error - Throws a generic error if tag deletion fails for any reason.
   */
  @Delete(':tagId')
  @ApiHeader({
    name: 'X-CSRF-Protection',
    required: true,
    schema: { type: 'string', enum: ['1'] },
  })
  @ApiForbiddenResponse({
    description: 'Missing CSRF header or untrusted Origin.',
  })
  @ApiNotFoundResponse({
    description: 'Tag missing, already deleted or not owned.',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: { deleted: { type: 'boolean', enum: [true] } },
        },
        meta: responseSchema.properties.meta,
      },
    },
  })
  @ApiOperation({
    summary: 'Permanently delete your tag',
    description:
      'No document relationships exist yet. Accepts no body or an empty object. Repeated deletion returns 404; the name becomes reusable.',
  })
  delete(
    @CurrentUser() user: Readonly<AuthenticatedUser>,
    @Param('tagId', new ParseUUIDPipe()) id: string,
    @Req() request: Request,
  ) {
    const body: unknown = request.body;
    if (
      body !== undefined &&
      (body === null ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).length)
    )
      throw new BadRequestException();
    return this.result(() => this.tags.delete(user.id, id));
  }

  /**
   * @author Cristono Wijaya
   * @description Wraps the provided operation in a try-catch block to handle specific tag-related errors and map them to appropriate HTTP exceptions.
   * @tags Tags
   * @param operation - A function that performs a tag-related operation and returns a Promise.
   * @returns The result of the operation if successful.
   * @throws NotFoundException - Throws an error if the operation results in a TagNotFound error.
   * @throws ConflictException - Throws an error if the operation results in a TagConflict error.
   * @throws Error - Throws any other errors that occur during the operation.
   */
  private async result<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof TagNotFound) throw new NotFoundException();
      if (error instanceof TagConflict) throw new ConflictException();
      throw error;
    }
  }
}
