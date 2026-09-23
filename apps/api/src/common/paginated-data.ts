/**
 * @author Cristono Wijaya
 * @description Marks cursor-paginated application results for the standard list envelope; ordinary responses keep their existing shape.
 * @tags HTTP Pagination
 */
export class PaginatedData<T> {
  /** @description Carries safe items and an exclusive cursor; no ownership comes from this marker. */
  constructor(
    readonly items: T[],
    readonly nextCursor: string | null,
    readonly hasMore: boolean,
  ) {}
}
