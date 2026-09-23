import {
  applyDecorators,
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
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
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Request } from 'express';
import { AuthenticatedUser, CurrentUser, SessionAuthGuard } from '../auth';
import { OwnedMutationGuard } from '../../common/owned-mutation.guard';
import { DocumentsService } from './documents.service';
import { DocumentListQuery, UpdateDocumentDto } from './documents.dto';
import {
  DocumentNotFound,
  DocumentStateConflict,
  InvalidDocumentMetadata,
} from './document-lifecycle';

/** @description Safe schemas contain metadata only; upload, version and infrastructure fields are absent. */
const relation = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};
const documentSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', format: 'uuid' },
    title: { type: 'string' },
    documentType: { type: 'string' },
    status: { type: 'string' },
    issuer: { type: 'string', nullable: true },
    referenceNumber: { type: 'string', nullable: true },
    documentDate: { type: 'string', format: 'date', nullable: true },
    expirationDate: { type: 'string', format: 'date', nullable: true },
    verifiedSummary: { type: 'string', nullable: true, readOnly: true },
    isArchived: { type: 'boolean', readOnly: true },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    deletedAt: { type: 'string', format: 'date-time', nullable: true },
    category: {
      ...relation,
      nullable: true,
      properties: {
        ...relation.properties,
        color: { type: 'string', nullable: true },
        icon: { type: 'string', nullable: true },
      },
    },
    tags: { type: 'array', items: relation },
  },
};
const meta = {
  type: 'object',
  properties: { requestId: { type: 'string', format: 'uuid' } },
};
const single = { type: 'object', properties: { data: documentSchema, meta } };
/** @description Documents shared CSRF and safe mutation responses without changing authentication behavior. */
function Mutation() {
  return applyDecorators(
    ApiHeader({
      name: 'X-CSRF-Protection',
      required: true,
      schema: { type: 'string', enum: ['1'] },
    }),
    ApiForbiddenResponse({
      description: 'Missing CSRF header or untrusted Origin.',
    }),
    ApiConflictResponse({
      description:
        'Lifecycle action conflicts with the current document state.',
    }),
    ApiOkResponse({ schema: single }),
  );
}

/**
 * @author Cristono Wijaya
 * @description Exposes metadata/lifecycle only; no public creation, file or version route is registered.
 * @tags Documents
 */
@ApiTags('Documents')
@ApiCookieAuth('session')
@ApiUnauthorizedResponse({
  description: 'Missing, invalid, expired or revoked session.',
})
@ApiBadRequestResponse({
  description: 'Invalid or unsupported metadata, UUID, filter or cursor.',
})
@ApiNotFoundResponse({
  description:
    'Resource or association unavailable; missing and unowned IDs are indistinguishable.',
})
@UseGuards(SessionAuthGuard, OwnedMutationGuard)
@Controller('documents')
export class DocumentsController {
  /**
   * @author Cristono Wijaya
   * @description Initializes the DocumentsController with the required DocumentsService.
   * @param documents - The service responsible for handling document-related operations.
   * @constructor
   */
  constructor(private readonly documents: DocumentsService) {}

  /**
   * @author Cristono Wijaya
   * @description Lists owned document metadata with pagination and filtering options.
   * @tags Documents
   * @param user - The authenticated user making the request.
   * @param query - The query parameters for listing documents, including limit, cursor, sort order, and filters.
   * @returns A paginated list of document metadata along with pagination information.
   * @throws BadRequestException - Throws an error if the query parameters are invalid or unsupported.
   */
  @Get()
  @ApiOperation({
    summary: 'List owned document metadata',
    description:
      'No file data. Default -createdAt order plus UUID tiebreaker; archived rows included unless filtered. Dates use inclusive bounds. Keep filters/order unchanged while following cursors.',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: {
        data: { type: 'array', items: documentSchema },
        meta: {
          ...meta,
          properties: {
            ...meta.properties,
            nextCursor: { type: 'string', nullable: true },
            hasMore: { type: 'boolean' },
          },
        },
      },
    },
  })
  list(
    @CurrentUser() user: Readonly<AuthenticatedUser>,
    @Query() query: DocumentListQuery,
  ) {
    return this.result(() => this.documents.list(user.id, query));
  }

  /**
   * @author Cristono Wijaya
   * @description Retrieves the metadata of a specific document owned by the authenticated user.
   * @tags Documents
   * @param user - The authenticated user making the request.
   * @param id - The UUID of the document to retrieve.
   * @param request - The HTTP request object, used to validate that no query parameters are present.
   * @returns The metadata of the specified document.
   * @throws BadRequestException - Throws an error if any query parameters are present in the request.
   * @throws NotFoundException - Throws an error if the document does not exist or is not owned by the user.
   */
  @Get(':documentId')
  @ApiParam({ name: 'documentId', type: String, format: 'uuid' })
  @ApiOperation({
    summary: 'Get document metadata',
    description:
      'Unavailable for deleted or foreign documents. No query/body fields accepted.',
  })
  @ApiOkResponse({ schema: single })
  detail(
    @CurrentUser() user: Readonly<AuthenticatedUser>,
    @Param('documentId', new ParseUUIDPipe()) id: string,
    @Req() request: Request,
  ) {
    if (Object.keys(request.query).length) throw new BadRequestException();
    return this.result(() => this.documents.detail(user.id, id));
  }

  /**
   * @author Cristono Wijaya
   * @description Updates the metadata of a specific document owned by the authenticated user.
   * @tags Documents
   * @param user - The authenticated user making the request.
   * @param id - The UUID of the document to update.
   * @param dto - The data transfer object containing the updated document metadata.
   * @returns The updated metadata of the specified document.
   * @throws BadRequestException - Throws an error if the request body is empty or invalid.
   * @throws NotFoundException - Throws an error if the document does not exist or is not owned by the user.
   * @throws ConflictException - Throws an error if there is a conflict with the current state of the document (e.g., lifecycle state).
   */
  @Patch(':documentId')
  @ApiParam({ name: 'documentId', type: String, format: 'uuid' })
  @Mutation()
  @ApiOperation({
    summary: 'Update document metadata',
    description:
      'Nonempty partial update. Null clears nullable fields; [] clears tags. Expiration cannot precede document date after merging. Status, summary, archive/delete and infrastructure fields are read-only. Relationships must be owned.',
  })
  update(
    @CurrentUser() user: Readonly<AuthenticatedUser>,
    @Param('documentId', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateDocumentDto,
  ) {
    if (!dto || !Object.keys(dto).length) throw new BadRequestException();
    return this.result(() => this.documents.update(user.id, id, dto));
  }

  /**
   * @author Cristono Wijaya
   * @description Archives a specific document owned by the authenticated user.
   * @tags Documents
   * @param user - The authenticated user making the request.
   * @param id - The UUID of the document to archive.
   * @param request - The HTTP request object, used to validate that no body fields are present.
   * @returns The updated metadata of the archived document.
   * @throws BadRequestException - Throws an error if any body fields are present in the request.
   * @throws NotFoundException - Throws an error if the document does not exist or is not owned by the user.
   * @throws ConflictException - Throws an error if there is a conflict with the current state of the document (e.g., lifecycle state).
   */
  @Post(':documentId/archive')
  @ApiParam({ name: 'documentId', type: String, format: 'uuid' })
  @HttpCode(200)
  @Mutation()
  @ApiOperation({
    summary: 'Archive document',
    description:
      'Sets ARCHIVED/isArchived. Deleted documents return 404; PROCESSING/DELETING conflict. Empty body only. Repeating preserves timestamps.',
  })
  archive(
    @CurrentUser() user: Readonly<AuthenticatedUser>,
    @Param('documentId', new ParseUUIDPipe()) id: string,
    @Req() request: Request,
  ) {
    this.empty(request);
    return this.result(() => this.documents.transition(user.id, id, 'archive'));
  }

  /**
   * @author Cristono Wijaya
   * @description Restores a specific archived or soft-deleted document owned by the authenticated user.
   * @tags Documents
   * @param user - The authenticated user making the request.
   * @param id - The UUID of the document to restore.
   * @param request - The HTTP request object, used to validate that no body fields are present.
   * @returns The updated metadata of the restored document.
   * @throws BadRequestException - Throws an error if any body fields are present in the request.
   * @throws NotFoundException - Throws an error if the document does not exist or is not owned by the user.
   * @throws ConflictException - Throws an error if there is a conflict with the current state of the document (e.g., lifecycle state).
   */
  @Post(':documentId/restore')
  @ApiParam({ name: 'documentId', type: String, format: 'uuid' })
  @HttpCode(200)
  @Mutation()
  @ApiOperation({
    summary: 'Restore archived or soft-deleted document',
    description:
      'Clears archive/deletion and uses UPLOADED, never READY. Active rows are unchanged. PROCESSING/DELETING conflict. Empty body only.',
  })
  restore(
    @CurrentUser() user: Readonly<AuthenticatedUser>,
    @Param('documentId', new ParseUUIDPipe()) id: string,
    @Req() request: Request,
  ) {
    this.empty(request);
    return this.result(() => this.documents.transition(user.id, id, 'restore'));
  }

  /**
   * @author Cristono Wijaya
   * @description Soft deletes a specific document owned by the authenticated user.
   * @tags Documents
   * @param user - The authenticated user making the request.
   * @param id - The UUID of the document to soft delete.
   * @param request - The HTTP request object, used to validate that no body fields are present.
   * @returns The updated metadata of the soft-deleted document.
   * @throws BadRequestException - Throws an error if any body fields are present in the request.
   * @throws NotFoundException - Throws an error if the document does not exist or is not owned by the user.
   * @throws ConflictException - Throws an error if there is a conflict with the current state of the document (e.g., lifecycle state).
   */
  @Delete(':documentId')
  @ApiParam({ name: 'documentId', type: String, format: 'uuid' })
  @Mutation()
  @ApiOperation({
    summary: 'Soft delete document',
    description:
      'Sets deletedAt and preserves status/archive and relationships for recovery. Repeated deletion preserves timestamps. No file deletion or purge. Empty body only.',
  })
  delete(
    @CurrentUser() user: Readonly<AuthenticatedUser>,
    @Param('documentId', new ParseUUIDPipe()) id: string,
    @Req() request: Request,
  ) {
    this.empty(request);
    return this.result(() => this.documents.transition(user.id, id, 'delete'));
  }

  /**
   * @author Cristono Wijaya
   * @description Validates that the request body is empty for endpoints that do not accept any body fields.
   * @param request - The HTTP request object to validate.
   * @throws BadRequestException - Throws an error if the request body is not empty or is invalid.
   */
  private empty(request: Request): void {
    const body: unknown = request.body;
    if (
      body !== undefined &&
      (body === null ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).length)
    )
      throw new BadRequestException();
  }

  /**
   * @author Cristono Wijaya
   * @description Handles the result of a document operation, mapping known errors to appropriate HTTP exceptions.
   * @param work - A function that performs the document operation and returns a Promise.
   * @returns The result of the document operation if successful.
   * @throws NotFoundException - Throws an error if the document is not found or is not owned by the user.
   * @throws BadRequestException - Throws an error if the document metadata is invalid or cannot be processed.
   * @throws ConflictException - Throws an error if there is a conflict with the current state of the document (e.g., lifecycle state).
   * @throws Error - Throws any other unexpected errors that may occur during the operation.
   */
  private async result<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof DocumentNotFound) throw new NotFoundException();
      if (error instanceof InvalidDocumentMetadata)
        throw new BadRequestException();
      if (error instanceof DocumentStateConflict) throw new ConflictException();
      throw error;
    }
  }
}
