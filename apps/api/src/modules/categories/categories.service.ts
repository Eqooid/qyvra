import { Injectable } from '@nestjs/common';
import { Prisma } from '@brainless/database';
import { PrismaService } from '../../database/prisma.service';
import { PaginatedData } from '../../common/paginated-data';
import {
  CategoryListQuery,
  CreateCategoryDto,
  UpdateCategoryDto,
} from './categories.dto';

/** @description Missing and foreign IDs intentionally share one application error. */
export class CategoryNotFound extends Error {}
/** @description An owned category already uses the normalized name. */
export class CategoryConflict extends Error {}

/**
 * @author Cristono Wijaya
 * @description Public projection excludes owner identifiers and future internal metadata.
 * @tags Categories
 */
const safeCategory = {
  id: true,
  name: true,
  color: true,
  icon: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * @author Cristono Wijaya
 * @description Owns bounded category persistence with an owner predicate on every read, edit and deletion.
 * @tags Categories
 * @injectable - Marks the class as a provider that can be injected into other classes.
 */
@Injectable()
export class CategoriesService {
  /**
   * @author Cristono Wijaya
   * @description Injects PrismaService for database access.
   * @tags Categories
   * @param database - The PrismaService instance for database operations.
   * @constructor
   */
  constructor(private readonly database: PrismaService) {}

  /**
   * @author Cristono Wijaya
   * @description Lists owned categories with pagination and cursor-based navigation.
   * @tags Categories
   * @param userId - The ID of the user whose categories are to be listed.
   * @param query - The query parameters for listing categories, including limit, cursor, and sort order.
   * @returns A PaginatedData object containing the list of categories, next cursor, and hasMore flag.
   * @throws Error - Throws an error if category listing fails.
   */
  async list(userId: string, query: CategoryListQuery) {
    try {
      const rows = await this.database.client.category.findMany({
        where: {
          userId,
          ...(query.cursor ? { id: { gt: query.cursor } } : {}),
        },
        orderBy: { id: 'asc' },
        take: query.limit + 1,
        select: safeCategory,
      });
      const hasMore = rows.length > query.limit;
      const items = rows.slice(0, query.limit);
      return new PaginatedData(
        items,
        hasMore ? items[items.length - 1].id : null,
        hasMore,
      );
    } catch {
      throw new Error('Category listing failed.');
    }
  }

  /**
   * @author Cristono Wijaya
   * @description Creates a new category for the specified user.
   * @tags Categories
   * @param userId - The ID of the user for whom the category is to be created.
   * @param dto - The data transfer object containing the category details (name, color, icon).
   * @returns The newly created category object.
   * @throws CategoryConflict - Throws an error if a category with the same name already exists for the user.
   * @throws Error - Throws a generic error if category creation fails for other reasons.
   */
  async create(userId: string, dto: CreateCategoryDto) {
    try {
      return await this.database.client.category.create({
        data: { userId, name: dto.name, color: dto.color, icon: dto.icon },
        select: safeCategory,
      });
    } catch (error) {
      this.mapFailure(error);
    }
  }

  /**
   * @author Cristono Wijaya
   * @description Updates an existing category for the specified user.
   * @tags Categories
   * @param userId - The ID of the user who owns the category to be updated.
   * @param id - The ID of the category to be updated.
   * @param dto - The data transfer object containing the updated category details (name, color, icon).
   * @returns The updated category object.
   * @throws CategoryNotFound - Throws an error if the category does not exist or is not owned by the user.
   * @throws CategoryConflict - Throws an error if a category with the same name already exists for the user.
   * @throws Error - Throws a generic error if category update fails for other reasons.
   */
  async update(userId: string, id: string, dto: UpdateCategoryDto) {
    try {
      return await this.database.client.category.update({
        where: { id, userId },
        data: { name: dto.name, color: dto.color, icon: dto.icon },
        select: safeCategory,
      });
    } catch (error) {
      this.mapFailure(error);
    }
  }

  /**
   * @author Cristono Wijaya
   * @description Deletes an existing category for the specified user.
   * @tags Categories
   * @param userId - The ID of the user who owns the category to be deleted.
   * @param id - The ID of the category to be deleted.
   * @returns An object indicating that the category was successfully deleted.
   * @throws CategoryNotFound - Throws an error if the category does not exist or is not owned by the user.
   * @throws Error - Throws a generic error if category deletion fails for other reasons.
   */
  async delete(userId: string, id: string): Promise<{ deleted: true }> {
    try {
      await this.database.client.category.delete({
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
   * @description Maps Prisma errors to application-specific errors for category operations.
   * @tags Categories
   * @param error - The error object thrown by Prisma during a database operation.
   * @throws CategoryConflict - Throws an error if a unique constraint violation occurs (e.g., duplicate category name).
   * @throws CategoryNotFound - Throws an error if the specified category does not exist or is not owned by the user.
   * @throws Error - Throws a generic error for other types of failures during category persistence operations.
   */
  private mapFailure(error: unknown): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (['P2002', 'P2003'].includes(error.code)) throw new CategoryConflict();
      if (error.code === 'P2025') throw new CategoryNotFound();
    }
    throw new Error('Category persistence failed.');
  }
}
