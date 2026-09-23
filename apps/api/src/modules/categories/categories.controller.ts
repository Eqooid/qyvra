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
import {
  CategoriesService,
  CategoryConflict,
  CategoryNotFound,
} from './categories.service';
import {
  CategoryListQuery,
  CreateCategoryDto,
  UpdateCategoryDto,
} from './categories.dto';
import { CategoryMutationGuard } from './category-mutation.guard';

/** @description Safe response schema; ownership and private metadata are not returned. */
const itemSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'color', 'icon', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    color: { type: 'string', nullable: true },
    icon: { type: 'string', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};
/** @description Standard single-category success envelope. */
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
 * @description Exposes category CRUD using only the guard-authenticated internal owner ID.
 * @tags Categories
 */
@ApiTags('Categories')
@ApiCookieAuth('session')
@ApiUnauthorizedResponse({
  description: 'Missing, invalid, expired or revoked session.',
})
@ApiBadRequestResponse({ description: 'Invalid or unsupported input.' })
@UseGuards(SessionAuthGuard, CategoryMutationGuard)
@Controller('categories')
export class CategoriesController {
  /**
   * @author Cristono Wijaya
   * @description Binds the categories service for CRUD operations.
   * @tags Categories
   * @constructor
   * @param categories - The categories service for handling category operations.
   */
  constructor(private readonly categories: CategoriesService) {}

  /**
   * @author Cristono Wijaya
   * @description Lists categories owned by the authenticated user, supporting pagination and sorting.
   * @tags Categories
   * @param user - The authenticated user making the request.
   * @param query - The query parameters for listing categories, including limit, cursor, and sort options.
   * @returns A paginated list of categories owned by the user.
   */
  @Get()
  @ApiOperation({
    summary: 'List your categories',
    description:
      'Ascending UUID order; limit defaults to 25 (maximum 100). Cursor is an exclusive UUID bound. Only sort=id is supported.',
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
    @Query() query: CategoryListQuery,
  ) {
    return this.categories.list(user.id, query);
  }

  /**
   * @author Cristono Wijaya
   * @description Creates a new category for the authenticated user, ensuring unique normalized names.
   * @tags Categories
   * @param user - The authenticated user making the request.
   * @param dto - The data transfer object containing the category details to be created.
   * @returns The newly created category.
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
    description:
      'An owned category uses the same normalized name, ignoring case.',
  })
  @ApiCreatedResponse({ schema: responseSchema })
  @ApiOperation({ summary: 'Create a category' })
  create(
    @CurrentUser() user: Readonly<AuthenticatedUser>,
    @Body() dto: CreateCategoryDto,
  ) {
    return this.result(() => this.categories.create(user.id, dto));
  }

  /**
   * @author Cristono Wijaya
   * @description Updates an existing category owned by the authenticated user, allowing renaming or restyling.
   * @tags Categories
   * @param user - The authenticated user making the request.
   * @param id - The UUID of the category to be updated.
   * @param dto - The data transfer object containing the updated category details.
   * @returns The updated category.
   */
  @Patch(':categoryId')
  @ApiHeader({
    name: 'X-CSRF-Protection',
    required: true,
    schema: { type: 'string', enum: ['1'] },
  })
  @ApiForbiddenResponse({
    description: 'Missing CSRF header or untrusted Origin.',
  })
  @ApiNotFoundResponse({ description: 'Category missing or not owned.' })
  @ApiConflictResponse({
    description: 'An owned category uses the same normalized name.',
  })
  @ApiOkResponse({ schema: responseSchema })
  @ApiOperation({
    summary: 'Rename or restyle your category',
    description:
      'A nonempty update is required. Null clears color/icon; name cannot be null.',
  })
  update(
    @CurrentUser() user: Readonly<AuthenticatedUser>,
    @Param('categoryId', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateCategoryDto,
  ) {
    if (!dto || !Object.keys(dto).length) throw new BadRequestException();
    return this.result(() => this.categories.update(user.id, id, dto));
  }

  /**
   * @author Cristono Wijaya
   * @description Permanently deletes an unused category owned by the authenticated user.
   * @tags Categories
   * @param user - The authenticated user making the request.
   * @param id - The UUID of the category to be deleted.
   * @param request - The HTTP request object, used to validate the request body.
   * @returns An object indicating successful deletion.
   */
  @Delete(':categoryId')
  @ApiConflictResponse({
    description:
      'Category is still referenced by a document, including a soft-deleted document.',
  })
  @ApiHeader({
    name: 'X-CSRF-Protection',
    required: true,
    schema: { type: 'string', enum: ['1'] },
  })
  @ApiForbiddenResponse({
    description: 'Missing CSRF header or untrusted Origin.',
  })
  @ApiNotFoundResponse({
    description: 'Category missing, already deleted or not owned.',
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
    summary: 'Permanently delete your unused category',
    description:
      'Referenced categories return 409, including references from soft-deleted documents. Accepts no body or an empty object. Repeated deletion returns 404; the name becomes reusable.',
  })
  delete(
    @CurrentUser() user: Readonly<AuthenticatedUser>,
    @Param('categoryId', new ParseUUIDPipe()) id: string,
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
    return this.result(() => this.categories.delete(user.id, id));
  }

  /**
   * @author Cristono Wijaya
   * @description Wraps category operations to handle specific errors and translate them into HTTP exceptions.
   * @tags Categories
   * @template T - The type of the result returned by the operation.
   * @param operation - A function that performs a category operation and returns a promise.
   * @returns A promise that resolves with the result of the operation or throws an appropriate HTTP exception.
   */
  private async result<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof CategoryNotFound) throw new NotFoundException();
      if (error instanceof CategoryConflict) throw new ConflictException();
      throw error;
    }
  }
}
