import { Module } from '@nestjs/common';
import { RequestContext } from './request-context';
import { LOG_SINK, stdoutSink, StructuredLogger } from './structured-logger';

/**
 * @author Cristono Wijaya
 * @description ObservabilityModule is a NestJS module that provides observability features such as structured logging and request context management.
 * It sets up the necessary providers for logging and request context, allowing other modules to utilize these features for better monitoring and debugging.
 * @tags Observability
 * @module ObservabilityModule
 */
@Module({
  providers: [
    RequestContext,
    StructuredLogger,
    { provide: LOG_SINK, useValue: stdoutSink },
  ],
  exports: [RequestContext, StructuredLogger],
})

/**
 * @author Cristono Wijaya
 * @class ObservabilityModule
 * @description The ObservabilityModule class serves as a container for observability-related providers and exports them for use in other modules.
 * It encapsulates the setup of structured logging and request context management, promoting a consistent approach to observability across the application.
 * @tags Observability
 * @module ObservabilityModule
 */
export class ObservabilityModule {}
