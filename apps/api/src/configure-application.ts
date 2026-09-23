import { INestApplication, ValidationPipe } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import { RequestContext } from './common/request-context';
import { StructuredLogger } from './common/structured-logger';
import { NextFunction, Request, Response } from 'express';
import { ApiConfiguration } from './configuration/settings';
import { configureSwagger } from './configure-swagger';
import helmet from 'helmet';
import {
  authenticationRateLimit,
  boundedJsonBody,
} from './common/http-security';
import {
  HttpErrorFilter,
  ResponseEnvelopeInterceptor,
} from './common/http-envelope';

/**
 * @author Cristono Wijaya
 * @description Configures the NestJS application with global settings, middleware, and security features.
 * This function sets up request context, logging, security headers, CORS, validation pipes, and Swagger documentation.
 * It ensures that the application is properly configured for production and development environments.
 * @tags Application Configuration
 * @param app - The NestJS application instance to be configured.
 * @param configuration - The application configuration settings used to customize the behavior of the application.
 */
export function configureApplication(
  app: INestApplication,
  configuration: ApiConfiguration,
): void {
  app.setGlobalPrefix('api/v1');
  const context = app.get(RequestContext);
  const logger = app.get(StructuredLogger);
  app.useLogger(logger);
  app.use((request: Request, response: Response, next: NextFunction) => {
    const id = context.create(
      request.headers['x-correlation-id'],
      request.headers['x-request-id'],
    );
    response.setHeader('X-Correlation-Id', id);
    response.setHeader('X-Request-Id', id);
    context.run(id, () => {
      const started = performance.now();
      let logged = false;
      const complete = (aborted: boolean) => {
        if (logged) return;
        logged = true;
        context.run(id, () =>
          logger.event(
            aborted || response.statusCode >= 500
              ? 'error'
              : response.statusCode >= 400
                ? 'warn'
                : 'info',
            aborted ? 'http.request.aborted' : 'http.request.completed',
            {
              method: request.method,
              statusCode: response.statusCode,
              durationMs: Math.round((performance.now() - started) * 100) / 100,
            },
          ),
        );
      };
      response.once('finish', () => complete(false));
      response.once('close', () => complete(!response.writableFinished));
      next();
    });
  });
  app.use(
    helmet({
      strictTransportSecurity:
        configuration.application.environment === 'production'
          ? { maxAge: 31536000 }
          : false,
      contentSecurityPolicy: {
        directives: {
          'upgrade-insecure-requests':
            configuration.application.environment === 'production' ? [] : null,
        },
      },
    }),
  );
  app.use((_request: Request, response: Response, next: NextFunction) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      validationError: { target: false, value: false },
    }),
  );
  app.useGlobalInterceptors(new ResponseEnvelopeInterceptor());
  app.useGlobalFilters(new HttpErrorFilter(logger));
  app.enableCors({
    origin:
      configuration.cors.origins.length > 0
        ? [...configuration.cors.origins]
        : false,
    credentials: configuration.cors.credentials,
    exposedHeaders: ['X-Correlation-Id', 'X-Request-Id', 'Retry-After'],
  });
  app.use(authenticationRateLimit(configuration));
  app.use(boundedJsonBody(configuration.http.bodyLimitBytes));
  app.enableShutdownHooks();
  configureSwagger(app);
}
