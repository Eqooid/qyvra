import { Injectable } from '@nestjs/common';
import { Prisma } from '@brainless/database';
import { PrismaService } from '../../database/prisma.service';
import { PaginatedData } from '../../common/paginated-data';
import { TagListQuery, CreateTagDto, UpdateTagDto } from './tags.dto';

/** @description Missing and foreign IDs intentionally share one application error. */
export class TagNotFound extends Error {}
/** @description An owned tag already uses the normalized name. */
export class TagConflict extends Error {}

/**
 * @author Cristono Wijaya
 * @description Public projection excludes owner identifiers and future internal metadata.
 * @tags Tags
 */
const safeTag = {
  id: true,
  name: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * @author Cristono Wijaya
 * @description Owns bounded tag persistence with an owner predicate on every read, edit and deletion.
 * @tags Tags
 * @injectable - Marks the class as a provider that can be injected into other classes.
 */
@Injectable()
export class TagsService {
  /**
   * @author Cristono Wijaya
   * @description Injects PrismaService for database access.
   * @tags Tags
   * @param database - The PrismaService instance for database operations.
   * @constructor
   */
  constructor(private readonly database: PrismaService) {}

  /**
   * @author Cristono Wijaya
   * @description Lists owned tags with pagination and cursor-based navigation.
   * @tags Tags
   * @param userId - The ID of the user whose tags are to be listed.
   * @param query - The query parameters for listing tags, including limit, cursor, and sort order.
   * @returns A PaginatedData object containing the list of tags, next cursor, and hasMore flag.
   * @throws Error - Throws an error if tag listing fails.
   */
  async list(userId: string, query: TagListQuery) {
    try {
      const rows = await this.database.client.tag.findMany({
        where: {
          userId,
          ...(query.cursor ? { id: { gt: query.cursor } } : {}),
          // Escape LIKE metacharacters so user input is a literal substring.
          ...(query.q === undefined
            ? {}
            : {
                name: {
                  contains: query.q.replace(
                    /[\\%_]/g,
                    (character) => `\\${character}`,
                  ),
                  mode: 'insensitive' as const,
                },
              }),
        },
        orderBy: { id: 'asc' },
        take: query.limit + 1,
        select: safeTag,
      });
      const hasMore = rows.length > query.limit;
      const items = rows.slice(0, query.limit);
      return new PaginatedData(
        items,
        hasMore ? items[items.length - 1].id : null,
        hasMore,
      );
    } catch {
      throw new Error('Tag listing failed.');
    }
  }

  /**
   * @author Cristono Wijaya
   * @description Creates a new tag for the authenticated user.
   * @tags Tags
   * @param userId - The ID of the user creating the tag.
   * @param dto - The data transfer object containing the tag details (name).
   * @returns The newly created tag object.
   * @throws TagConflict - Throws an error if a tag with the same normalized name already exists for the user.
   * @throws Error - Throws an error if tag creation fails for any other reason.
   */
  async create(userId: string, dto: CreateTagDto) {
    try {
      return await this.database.client.tag.create({
        data: { userId, name: dto.name },
        select: safeTag,
      });
    } catch (error) {
      this.mapFailure(error);
    }
  }

  /**
   * @author Cristono Wijaya
   * @description Updates the name of an existing tag owned by the authenticated user.
   * @tags Tags
   * @param userId - The ID of the user who owns the tag to be updated.
   * @param id - The ID of the tag to be updated.
   * @param dto - The data transfer object containing the updated tag details (name).
   * @returns The updated tag object.
   * @throws TagNotFound - Throws an error if the tag does not exist or is not owned by the user.
   * @throws TagConflict - Throws an error if a tag with the same normalized name already exists for the user.
   * @throws Error - Throws an error if tag update fails for any other reason.
   */
  async update(userId: string, id: string, dto: UpdateTagDto) {
    try {
      return await this.database.client.tag.update({
        where: { id, userId },
        data: { name: dto.name },
        select: safeTag,
      });
    } catch (error) {
      this.mapFailure(error);
    }
  }

  /**
   * @author Cristono Wijaya
   * @description Deletes an existing tag owned by the authenticated user.
   * @tags Tags
   * @param userId - The ID of the user who owns the tag to be deleted.
   * @param id - The ID of the tag to be deleted.
   * @returns An object indicating successful deletion.  
   * @throws TagNotFound - Throws an error if the tag does not exist or is not owned by the user.
   * @throws Error - Throws an error if tag deletion fails for any other reason.
   */
  async delete(userId: string, id: string): Promise<{ deleted: true }> {
    try {
      await this.database.client.tag.delete({
        where: { id, userId },
        select: { id: true },
      });
      return { deleted: true };
    } catch (error) {
      this.mapFailure(error);
    }
  }

  /**
   * @author Cristono Wijaya
   * @description Maps database errors to application-specific errors for tag operations.
   * @tags Tags
   * @param error - The error object thrown by the database operation.
   * @throws TagConflict - Throws if a tag with the same normalized name already exists for the user.
   * @throws TagNotFound - Throws if the tag does not exist or is not owned by the user.
   * @throws Error - Throws a generic error if tag persistence fails for any other reason.
   */
  private mapFailure(error: unknown): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') throw new TagConflict();
      if (error.code === 'P2025') throw new TagNotFound();
    }
    throw new Error('Tag persistence failed.');
  }
}
