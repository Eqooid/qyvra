import {
  ArgumentsHost,
  CallHandler,
  Catch,
  ExceptionFilter,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { STATUS_CODES } from 'node:http';
import { AiOutputInvalidException } from './ai-output-invalid.exception';
import { Response } from 'express';
import { map, Observable } from 'rxjs';
import { StructuredLogger } from './structured-logger';
import { PaginatedData } from './paginated-data';

/**
 * @author Cristono Wijaya
 * @description Extracts the request ID from the response headers or generates a new UUID if not present.
 * This function is used to ensure that each request has a unique identifier for tracing and logging purposes.
 * @tags Request ID Extraction  
 * @param response - The HTTP response object from which the request ID is to be extracted.
 * @returns - The extracted or newly generated request ID.
 */
function requestId(response: Response): string {
  const id = response.getHeader('X-Request-Id');
  return typeof id === 'string' ? id : randomUUID();
}

/**
 * @author Cristono Wijaya
 * @description Interceptor that wraps the response data in a standardized envelope format.
 * It adds metadata including the request ID to the response, ensuring consistent response structure across the application.
 * @tags Response Envelope Interceptor
 * @param context - The execution context of the current request, providing access to request and response objects.
 * @param next - The call handler that processes the request and returns the response data.
 * @returns - An observable that emits the response data wrapped in an envelope with metadata.
 * @injectable - Marks the class as injectable, allowing it to be used as a provider in NestJS modules.
 */
@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const response = context.switchToHttp().getResponse<Response>();
    return next.handle().pipe(
      map((data: unknown) =>
        data instanceof PaginatedData
          ? {
              data: data.items,
              meta: {
                requestId: requestId(response),
                nextCursor: data.nextCursor,
                hasMore: data.hasMore,
              },
            }
          : { data, meta: { requestId: requestId(response) } },
      ),
    );
  }
}

/**
 * @author Cristono Wijaya
 * @description Exception filter that handles HTTP exceptions and formats the error response in a standardized envelope format.
 * It logs the error details and ensures that the response includes a request ID for tracing purposes.
 * @tags HTTP Error Filter
 * @param exception - The exception that was thrown during request processing.
 * @param host - The arguments host providing access to the request and response objects.
 * @returns - A JSON response containing the error details and metadata including the request ID.
 * @catch - Decorator that marks the class as an exception filter for handling all exceptions.
 */
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  constructor(private readonly logger: StructuredLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const candidate =
      exception instanceof HttpException ? exception.getStatus() : 500;
    const status =
      Number.isInteger(candidate) &&
      candidate >= 400 &&
      candidate <= 599 &&
      STATUS_CODES[candidate]
        ? candidate
        : 500;
    const message = STATUS_CODES[status] ?? 'Internal Server Error';
    const code =
      exception instanceof AiOutputInvalidException
        ? 'AI_OUTPUT_INVALID'
        : message.toUpperCase().replaceAll(' ', '_');
    this.logger.event(status >= 500 ? 'error' : 'warn', 'http.request.failed', {
      statusCode: status,
      code,
    });
    if (response.headersSent) return;
    response.status(status).json({
      error: {
        code,
        message,
        details: {},
        traceId: requestId(response),
      },
    });
  }
}
