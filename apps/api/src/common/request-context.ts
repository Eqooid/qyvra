import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * @author Cristono Wijaya
 * @description Validates and returns a correlation ID if the provided value is a valid UUID.
 * It checks if the value is a string and matches the UUID format, returning the value if valid or undefined otherwise.
 * @tags Correlation ID Validation
 * @param value - The value to be validated as a correlation ID.
 * @returns - The valid correlation ID string or undefined if the value is not a valid UUID.
 */
export function correlationId(value: unknown): string | undefined {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
    ? value
    : undefined;
}

/**
 * @author Cristono Wijaya
 * @description The RequestContext class provides a mechanism to manage and access request-specific context data, such as correlation IDs, across asynchronous operations.
 * It utilizes AsyncLocalStorage to maintain context for each request, allowing for consistent tracking and logging of request-related information.
 * @tags Request Context Management
 * @injectable - Marks the class as injectable, allowing it to be used as a provider in NestJS modules.
 */
@Injectable()
export class RequestContext {
  /**
   * @author Cristono Wijaya
   * @description An instance of AsyncLocalStorage used to store and retrieve request-specific context data.
   * It enables the preservation of context across asynchronous operations, ensuring that each request has its own isolated context.
   * @private - This property is private to the RequestContext class and is not accessible from outside the class.
   * @type {AsyncLocalStorage<string>} - The type of the storage, which is an AsyncLocalStorage instance that holds string values (correlation IDs).
   * @readonly - This property is read-only, meaning it cannot be reassigned after initialization.
   */
  private readonly storage = new AsyncLocalStorage<string>();

  /**
   * @author Cristono Wijaya
   * @description Retrieves the current correlation ID from the request context.
   * It accesses the AsyncLocalStorage to get the stored correlation ID for the current asynchronous execution context.
   * @returns - The current correlation ID if available, or undefined if no correlation ID is set in the context.
   */
  get correlationId(): string | undefined {
    return this.storage.getStore();
  }

  /**
   * @author Cristono Wijaya
   * @description Runs a callback function within a specific request context, associating it with a given correlation ID.
   * It uses AsyncLocalStorage to create a new execution context for the callback, allowing the correlation ID to be accessible during its execution.
   * @param id - The correlation ID to associate with the request context for the duration of the callback execution.
   * @param callback - The function to be executed within the specified request context.
   * @returns - The result of the callback function execution.
   */
  run<T>(id: string, callback: () => T): T {
    return this.storage.run(id, callback);
  }

  /**
   * @author Cristono Wijaya
   * @description Creates a new correlation ID based on the provided primary and fallback values.
   * It attempts to extract a valid correlation ID from the primary value, falling back to the secondary value if necessary.
   * If neither value yields a valid correlation ID, a new UUID is generated as the correlation ID.
   * @param primary - The primary value to be used for correlation ID extraction.
   * @param fallback - The fallback value to be used if the primary value does not yield a valid correlation ID.
   * @returns - A valid correlation ID string, either extracted from the provided values or generated as a new UUID.
   */
  create(primary: unknown, fallback: unknown): string {
    return correlationId(primary) ?? correlationId(fallback) ?? randomUUID();
  }
}
