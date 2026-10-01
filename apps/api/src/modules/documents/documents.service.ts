import { Injectable } from '@nestjs/common';
import { Prisma, ProcessingRepository } from '@brainless/database';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../database/prisma.service';
import { PaginatedData } from '../../common/paginated-data';
import {
  DocumentAction,
  DocumentNotFound,
  DocumentStateConflict,
  InvalidDocumentMetadata,
  transitionDocument,
} from './document-lifecycle';
import { DocumentListQuery, UpdateDocumentDto } from './documents.dto';
import { documentCursor, parseDocumentCursor } from './document-pagination';

/** @description Only metadata needed by the public contract and relationship batching is selected. */
const metadata = {
  id: true,
  categoryId: true,
  title: true,
  description: true,
  documentType: true,
  status: true,
  issuer: true,
  referenceNumber: true,
  documentDate: true,
  expirationDate: true,
  verifiedSummary: true,
  isArchived: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  versions: {
    orderBy: { versionNumber: 'desc' },
    take: 1,
    select: {
      id: true,
      versionNumber: true,
      originalFilename: true,
      mimeType: true,
      fileSize: true,
      createdAt: true,
    },
  },
} as const;
type Row = Prisma.DocumentGetPayload<{ select: typeof metadata }>;
const categoryFields = {
  id: true,
  name: true,
  color: true,
  icon: true,
  createdAt: true,
  updatedAt: true,
} as const;
const tagFields = {
  id: true,
  name: true,
  createdAt: true,
  updatedAt: true,
} as const;
const dateValue = (value: string | null | undefined) =>
  value ? new Date(`${value}T00:00:00.000Z`) : value;
const literal = (value: string) =>
  `%${value.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;

/**
 * @author Cristono Wijaya
 * @description Owns metadata persistence, batch relationship loading and serialized lifecycle transitions. No public creation or file operations exist.
 * @tags Documents
 * @injectable - Marks the class as a provider that can be injected into other classes.
 */
@Injectable()
export class DocumentsService {
  private readonly processing: ProcessingRepository;
  /**
   * @author Cristono Wijaya
   * @description Injects PrismaService for database access.
   * @tags Documents
   * @param database - The PrismaService instance for database operations.
   * @constructor
   */
  constructor(private readonly database: PrismaService) {
    this.processing = new ProcessingRepository(database.client);
  }

  /**
   * @author Cristono Wijaya
   * @description Lists owned documents with pagination, filtering, and cursor-based navigation.
   * @tags Documents
   * @param userId - The ID of the user whose documents are to be listed.
   * @param query - The query parameters for listing documents, including limit, cursor, sort order, and various filters.
   * @returns A PaginatedData object containing the list of documents, next cursor, and hasMore flag.
   * @throws InvalidDocumentMetadata - Throws an error if the provided date range filters are invalid.
   */
  async list(userId: string, query: DocumentListQuery) {
    return this.safe(async () => {
      if (
        (query.dateFrom && query.dateTo && query.dateFrom > query.dateTo) ||
        (query.expirationFrom &&
          query.expirationTo &&
          query.expirationFrom > query.expirationTo) ||
        (query.createdFrom &&
          query.createdTo &&
          query.createdFrom > query.createdTo) ||
        (query.updatedFrom &&
          query.updatedTo &&
          query.updatedFrom > query.updatedTo) ||
        (query.tagId && query.tagIds)
      )
        throw new InvalidDocumentMetadata();
      const descending = query.sort.startsWith('-');
      const order = descending ? Prisma.sql`DESC` : Prisma.sql`ASC`;
      const sortKey =
        query.sort === '-createdAt' || query.sort === 'createdAt'
          ? Prisma.sql`d.created_at`
          : query.sort === '-updatedAt'
            ? Prisma.sql`d.updated_at`
            : query.sort === 'title' || query.sort === '-title'
              ? Prisma.sql`d.title COLLATE "C"`
              : Prisma.sql`current_file.file_size`;
      const cursor = query.cursor
        ? parseDocumentCursor(query.cursor, query.sort)
        : undefined;
      const conditions: Prisma.Sql[] = [
        Prisma.sql`d.user_id = ${userId}::uuid`,
        Prisma.sql`d.deleted_at IS NULL`,
      ];
      if (query.status) conditions.push(Prisma.sql`d.status = ${query.status}`);
      if (query.documentType)
        conditions.push(Prisma.sql`d.document_type = ${query.documentType}`);
      if (query.categoryId)
        conditions.push(Prisma.sql`d.category_id = ${query.categoryId}::uuid`);
      if (query.archived !== undefined)
        conditions.push(Prisma.sql`d.is_archived = ${query.archived}`);
      if (query.q) {
        const pattern = literal(query.q);
        conditions.push(
          Prisma.sql`(d.title ILIKE ${pattern} ESCAPE E'\\\\' OR d.issuer ILIKE ${pattern} ESCAPE E'\\\\' OR d.reference_number ILIKE ${pattern} ESCAPE E'\\\\')`,
        );
      }
      if (query.tagId)
        conditions.push(
          Prisma.sql`EXISTS (SELECT 1 FROM document_tags dt WHERE dt.document_id = d.id AND dt.user_id = ${userId}::uuid AND dt.tag_id = ${query.tagId}::uuid)`,
        );
      for (const tagId of query.tagIds ?? [])
        conditions.push(
          Prisma.sql`EXISTS (SELECT 1 FROM document_tags dt WHERE dt.document_id = d.id AND dt.user_id = ${userId}::uuid AND dt.tag_id = ${tagId}::uuid)`,
        );
      if (query.dateFrom)
        conditions.push(Prisma.sql`d.document_date >= ${query.dateFrom}::date`);
      if (query.dateTo)
        conditions.push(Prisma.sql`d.document_date <= ${query.dateTo}::date`);
      if (query.expirationFrom)
        conditions.push(
          Prisma.sql`d.expiration_date >= ${query.expirationFrom}::date`,
        );
      if (query.expirationTo)
        conditions.push(
          Prisma.sql`d.expiration_date <= ${query.expirationTo}::date`,
        );
      if (query.createdFrom)
        conditions.push(
          Prisma.sql`d.created_at >= (${query.createdFrom}::date::timestamp AT TIME ZONE 'UTC')`,
        );
      if (query.createdTo)
        conditions.push(
          Prisma.sql`d.created_at < ((${query.createdTo}::date + INTERVAL '1 day') AT TIME ZONE 'UTC')`,
        );
      if (query.updatedFrom)
        conditions.push(
          Prisma.sql`d.updated_at >= (${query.updatedFrom}::date::timestamp AT TIME ZONE 'UTC')`,
        );
      if (query.updatedTo)
        conditions.push(
          Prisma.sql`d.updated_at < ((${query.updatedTo}::date + INTERVAL '1 day') AT TIME ZONE 'UTC')`,
        );
      if (query.filename)
        conditions.push(
          Prisma.sql`current_file.original_filename ILIKE ${literal(query.filename)} ESCAPE E'\\\\'`,
        );
      if (query.mimeType)
        conditions.push(Prisma.sql`current_file.mime_type = ${query.mimeType}`);
      if (cursor) {
        if (cursor.sort === '-fileSize' && cursor.value === null) {
          conditions.push(
            Prisma.sql`(current_file.file_size IS NULL AND d.id < ${cursor.id}::uuid)`,
          );
        } else if (cursor.sort === '-fileSize') {
          conditions.push(
            Prisma.sql`(current_file.file_size < ${cursor.value} OR (current_file.file_size = ${cursor.value} AND d.id < ${cursor.id}::uuid) OR current_file.file_size IS NULL)`,
          );
        } else {
          const value =
            'createdAt' in cursor
              ? new Date(cursor.createdAt)
              : cursor.sort === '-updatedAt'
                ? new Date(cursor.value as string)
                : cursor.value;
          const sortValue =
            cursor.sort === 'title' || cursor.sort === '-title'
              ? Prisma.sql`${value} COLLATE "C"`
              : Prisma.sql`${value}`;
          conditions.push(
            descending
              ? Prisma.sql`(${sortKey} < ${sortValue} OR (${sortKey} = ${sortValue} AND d.id < ${cursor.id}::uuid))`
              : Prisma.sql`(${sortKey} > ${sortValue} OR (${sortKey} = ${sortValue} AND d.id > ${cursor.id}::uuid))`,
          );
        }
      }
      const currentFileJoin =
        query.filename || query.mimeType || query.sort === '-fileSize'
          ? Prisma.sql`LEFT JOIN LATERAL (SELECT v.original_filename, v.mime_type, v.file_size FROM document_versions v WHERE v.document_id = d.id AND v.user_id = ${userId}::uuid ORDER BY v.version_number DESC LIMIT 1) current_file ON TRUE`
          : Prisma.empty;
      const keys = await this.database.client.$queryRaw<
        {
          id: string;
          createdAt: Date;
          sortValue: Date | string | number | null;
        }[]
      >(Prisma.sql`
        SELECT d.id, d.created_at AS "createdAt", ${sortKey} AS "sortValue"
        FROM documents d
        ${currentFileJoin}
        WHERE ${Prisma.join(conditions, ' AND ')}
        ORDER BY ${sortKey} ${order}${query.sort === '-fileSize' ? Prisma.sql` NULLS LAST` : Prisma.empty}, d.id ${order}
        LIMIT ${query.limit + 1}
      `);
      const more = keys.length > query.limit;
      const pageKeys = keys.slice(0, query.limit);
      const rows = pageKeys.length
        ? await this.database.client.document.findMany({
            where: {
              userId,
              deletedAt: null,
              id: { in: pageKeys.map((row) => row.id) },
            },
            select: metadata,
          })
        : [];
      const byId = new Map(rows.map((row) => [row.id, row]));
      const page = pageKeys.flatMap((key) => {
        const row = byId.get(key.id);
        return row ? [row] : [];
      });
      const last = page[page.length - 1];
      const lastKey = last && pageKeys.find((key) => key.id === last.id);
      return new PaginatedData(
        await this.hydrate(this.database.client, userId, page),
        more && lastKey ? documentCursor(lastKey, query.sort) : null,
        more,
      );
    });
  }

  /**
   * @author Cristono Wijaya
   * @description Retrieves the details of a specific document owned by the user.
   * @tags Documents
   * @param userId - The ID of the user who owns the document.
   * @param id - The ID of the document to retrieve.
   * @returns The document details if found and owned by the user.
   * @throws DocumentNotFound - Throws an error if the document does not exist or is not owned by the user.
   * @throws Error - Throws a generic error if the retrieval fails for other reasons.
   */
  async detail(userId: string, id: string) {
    return this.safe(async () => {
      const row = await this.database.client.document.findFirst({
        where: { id, userId, deletedAt: null },
        select: metadata,
      });
      if (!row) throw new DocumentNotFound();
      return (await this.hydrate(this.database.client, userId, [row]))[0];
    });
  }

  /**
   * @author Cristono Wijaya
   * @description Updates the metadata of a specific document owned by the user.
   * @tags Documents
   * @param userId - The ID of the user who owns the document.
   * @param id - The ID of the document to update.
   * @param dto - The data transfer object containing the updated document details.
   * @returns The updated document details if the update is successful.
   * @throws DocumentNotFound - Throws an error if the document does not exist or is not owned by the user.
   * @throws InvalidDocumentMetadata - Throws an error if the provided metadata is invalid (e.g., expiration date precedes document date).
   * @throws Error - Throws a generic error if the update fails for other reasons.
   */
  async update(userId: string, id: string, dto: UpdateDocumentDto) {
    return this.safe(() =>
      this.database.client.$transaction(async (tx) => {
        const row = await this.locked(tx, userId, id);
        if (row.deletedAt) throw new DocumentNotFound();
        const documentDate =
          dto.documentDate === undefined
            ? row.documentDate
            : dateValue(dto.documentDate);
        const expirationDate =
          dto.expirationDate === undefined
            ? row.expirationDate
            : dateValue(dto.expirationDate);
        if (documentDate && expirationDate && expirationDate < documentDate)
          throw new InvalidDocumentMetadata();
        if (
          dto.categoryId &&
          !(await tx.category.findFirst({
            where: { id: dto.categoryId, userId },
            select: { id: true },
          }))
        )
          throw new DocumentNotFound();
        const ids =
          dto.tagIds === undefined ? undefined : [...new Set(dto.tagIds)];
        if (
          ids &&
          (
            await tx.tag.findMany({
              where: { id: { in: ids }, userId },
              select: { id: true },
            })
          ).length !== ids.length
        )
          throw new DocumentNotFound();
        const updated = await tx.document.update({
          where: { id, userId, deletedAt: null },
          data: {
            title: dto.title,
            description: dto.description,
            documentType: dto.documentType,
            issuer: dto.issuer,
            referenceNumber: dto.referenceNumber,
            categoryId: dto.categoryId,
            documentDate: dateValue(dto.documentDate),
            expirationDate: dateValue(dto.expirationDate),
          },
          select: metadata,
        });
        if (ids) {
          await tx.documentTag.deleteMany({
            where: { documentId: id, userId, tagId: { notIn: ids } },
          });
          if (ids.length)
            await tx.documentTag.createMany({
              data: ids.map((tagId) => ({ documentId: id, tagId, userId })),
              skipDuplicates: true,
            });
        }
        return (await this.hydrate(tx, userId, [updated]))[0];
      }),
    );
  }

  /**
   * @author Cristono Wijaya
   * @description Transitions the state of a specific document owned by the user based on the specified action (archive, restore, delete).
   * @tags Documents
   * @param userId - The ID of the user who owns the document.
   * @param id - The ID of the document to transition.
   * @param action - The action to perform on the document (archive, restore, delete).
   * @returns The updated document details after the state transition.
   * @throws DocumentNotFound - Throws an error if the document does not exist or is not owned by the user.
   * @throws DocumentStateConflict - Throws an error if the state transition is invalid (e.g., trying to archive a deleted document).
   * @throws Error - Throws a generic error if the state transition fails for other reasons.
   */
  async transition(userId: string, id: string, action: DocumentAction) {
    return this.safe(() =>
      this.database.client.$transaction(async (tx) => {
        const row = await this.locked(tx, userId, id);
        const now = new Date();
        const data = transitionDocument(row, action, now);
        const updated = Object.keys(data).length
          ? await tx.document.update({
              where: { id, userId },
              data,
              select: metadata,
            })
          : row;
        if (Object.keys(data).length && action !== 'restore')
          await this.processing.cancelUnfinishedForDocument(
            tx,
            userId,
            id,
            now,
          );
        if (Object.keys(data).length && action === 'restore') {
          const currentVersionId = updated.versions[0]?.id;
          if (currentVersionId) {
            const latest = await tx.processingJob.findFirst({
              where: {
                userId,
                documentId: id,
                documentVersionId: currentVersionId,
                jobType: 'VERIFY_STORED_FILE',
              },
              orderBy: { generation: 'desc' },
              select: { status: true, maxAttempts: true },
            });
            if (latest?.status === 'CANCELLED')
              await this.processing.createInTransaction(
                tx,
                {
                  userId,
                  documentId: id,
                  documentVersionId: currentVersionId,
                  correlationId: randomUUID(),
                  maxAttempts: latest.maxAttempts,
                },
                true,
              );
          }
        }
        return (await this.hydrate(tx, userId, [updated]))[0];
      }),
    );
  }

  /**
   * @author Cristono Wijaya
   * @description Locks a specific document row for update within a transaction, ensuring that the document is owned by the user and exists.
   * @tags Documents
   * @param tx - The Prisma transaction client used for database operations.
   * @param userId - The ID of the user who owns the document.
   * @param id - The ID of the document to lock.
   * @returns The locked document row if it exists and is owned by the user.
   * @throws DocumentNotFound - Throws an error if the document does not exist or is not owned by the user.
   * @throws Error - Throws a generic error if the locking operation fails for other reasons.
   */
  private async locked(
    tx: Prisma.TransactionClient,
    userId: string,
    id: string,
  ): Promise<Row> {
    await tx.$queryRaw`SELECT id FROM documents WHERE id = ${id}::uuid AND user_id = ${userId}::uuid FOR UPDATE`;
    const row = await tx.document.findFirst({
      where: { id, userId },
      select: metadata,
    });
    if (!row) throw new DocumentNotFound();
    return row;
  }

  /**
   * @author Cristono Wijaya
   * @description Hydrates document rows with their associated categories and tags, returning enriched document data.
   * @tags Documents
   * @param tx - The Prisma transaction client used for database operations.
   * @param userId - The ID of the user who owns the documents.
   * @param rows - The document rows to hydrate with category and tag information.
   * @returns An array of hydrated document data, including associated categories and tags.
   * @throws Error - Throws a generic error if the hydration operation fails for any reason.
   */
  private async hydrate(
    tx: Prisma.TransactionClient,
    userId: string,
    rows: Row[],
  ) {
    if (!rows.length) return [];
    const categories = await tx.category.findMany({
      where: {
        userId,
        id: {
          in: [
            ...new Set(
              rows.flatMap((row) => (row.categoryId ? [row.categoryId] : [])),
            ),
          ],
        },
      },
      select: categoryFields,
    });
    const joins = await tx.documentTag.findMany({
      where: { userId, documentId: { in: rows.map((row) => row.id) } },
      select: { documentId: true, tagId: true },
      orderBy: { tagId: 'asc' },
    });
    const tags = await tx.tag.findMany({
      where: {
        userId,
        id: { in: [...new Set(joins.map((join) => join.tagId))] },
      },
      select: tagFields,
    });
    const categoryMap = new Map(categories.map((row) => [row.id, row]));
    const tagMap = new Map(tags.map((row) => [row.id, row]));
    const byDocument = new Map<string, typeof tags>();
    for (const join of joins) {
      const tag = tagMap.get(join.tagId);
      if (tag) {
        const assigned = byDocument.get(join.documentId) ?? [];
        assigned.push(tag);
        byDocument.set(join.documentId, assigned);
      }
    }
    return rows.map(
      ({ categoryId, documentDate, expirationDate, versions, ...row }) => ({
        ...row,
        documentDate: documentDate?.toISOString().slice(0, 10) ?? null,
        expirationDate: expirationDate?.toISOString().slice(0, 10) ?? null,
        category: categoryId ? (categoryMap.get(categoryId) ?? null) : null,
        tags: byDocument.get(row.id) ?? [],
        currentVersion: versions[0]
          ? { ...versions[0], createdAt: versions[0].createdAt.toISOString() }
          : null,
      }),
    );
  }

  /**
   * @author Cristono Wijaya
   * @description Wraps a function in a try-catch block to handle known document-related errors and rethrow them as specific exceptions.
   * @tags Documents
   * @param work - A function that returns a Promise to be executed safely.
   * @returns The result of the executed function if successful.
   * @throws DocumentNotFound - Rethrows if the error is an instance of DocumentNotFound.
   * @throws InvalidDocumentMetadata - Rethrows if the error is an instance of InvalidDocumentMetadata.
   * @throws DocumentStateConflict - Rethrows if the error is an instance of DocumentStateConflict.
   * @throws Error - Throws a generic error if the execution fails for any other reason.
   */
  private async safe<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (
        error instanceof DocumentNotFound ||
        error instanceof InvalidDocumentMetadata ||
        error instanceof DocumentStateConflict
      )
        throw error;
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        ['P2003', 'P2025'].includes(error.code)
      )
        throw new DocumentNotFound();
      throw new Error('Document persistence failed.');
    }
  }
}
