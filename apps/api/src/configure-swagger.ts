import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { TagsModule } from './modules/tags/tags.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { CategoriesModule } from './modules/categories/categories.module';
import { ConfigurationService } from './configuration/configuration.module';
import { AppModule } from './app.module';

/**
 * @author Cristono Wijaya
 * @description Configures Swagger documentation for the NestJS application.
 * This function sets up the Swagger document with API information, security schemes, and response schemas.
 * It also customizes the Swagger UI and JSON document endpoints.
 * @tags Swagger Configuration
 * @param app - The NestJS application instance for which Swagger documentation is to be configured.
 */
export function configureSwagger(app: INestApplication): void {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Brainless API')
      .setVersion('1')
      .setDescription(
        'Brainless personal knowledge and document-management API. Authentication, Categories, Tags, metadata/lifecycle, streaming upload, immutable version history and secure current-version download are available. Processing and historical-version download are not implemented. Upload requires multipart/form-data and a UUID Idempotency-Key. Cookie mutations require X-CSRF-Protection: 1 and an allowlisted browser Origin. Register first, then log in to set HttpOnly cookies; serialize refresh calls.',
      )
      .addCookieAuth(
        app.get(ConfigurationService).cookie.refreshName,
        {
          type: 'apiKey',
          in: 'cookie',
          description:
            'HttpOnly refresh cookie issued by login and rotated on refresh.',
        },
        'refresh',
      )
      .addCookieAuth(
        app.get(ConfigurationService).cookie.name,
        {
          type: 'apiKey',
          in: 'cookie',
          description:
            'HttpOnly session cookie issued by local login. Use login to set it; do not paste tokens into examples.',
        },
        'session',
      )
      .build(),
    {
      include: [
        AppModule,
        HealthModule,
        AuthModule,
        CategoriesModule,
        TagsModule,
        DocumentsModule,
      ],
    },
  );
  for (const path of [
    '/api/v1/auth/register',
    '/api/v1/auth/login',
    '/api/v1/auth/refresh',
  ]) {
    const operation = document.paths[path]?.post;
    if (operation) {
      operation.responses['429'] = {
        description:
          'Request budget exhausted; standard TOO_MANY_REQUESTS envelope. Retry after the Retry-After seconds header.',
        headers: {
          'Retry-After': {
            description:
              'Seconds until the request budget resets; exposed to allowed CORS origins.',
            schema: { type: 'integer', minimum: 1 },
          },
        },
      };
      operation.responses['413'] = {
        description:
          'JSON body exceeds HTTP_BODY_LIMIT_BYTES; standard PAYLOAD_TOO_LARGE envelope.',
      };
    }
  }
  document.components ??= {};
  document.components.schemas ??= {};
  document.components.schemas.ErrorEnvelope = {
    type: 'object',
    required: ['error'],
    properties: {
      error: {
        type: 'object',
        required: ['code', 'message', 'details', 'traceId'],
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
          details: { type: 'object', additionalProperties: false },
          traceId: { type: 'string', format: 'uuid' },
        },
      },
    },
  };
  for (const path of Object.values(document.paths)) {
    for (const method of ['get', 'post', 'delete', 'patch'] as const) {
      const operation = path[method];
      if (!operation) continue;
      operation.responses['500'] ??= {
        description: 'Internal Server Error; no infrastructure details.',
      };
      if (method !== 'get') {
        operation.responses['400'] ??= {
          description: 'Bad Request; invalid or unexpected input.',
        };
        operation.responses['413'] ??= {
          description: 'Payload Too Large; exceeds HTTP_BODY_LIMIT_BYTES.',
        };
        operation.responses['415'] ??= {
          description: 'Unsupported Media Type; uncompressed JSON required.',
        };
        if (method === 'delete')
          operation.responses['403'] ??= {
            description: 'Forbidden; missing CSRF header or untrusted Origin.',
          };
      }
      for (const [status, response] of Object.entries(operation.responses)) {
        if (response && Number(status) >= 400 && !('$ref' in response))
          response.content ??= {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorEnvelope' },
            },
          };
      }
    }
  }
  SwaggerModule.setup('api/v1/docs', app, document, {
    jsonDocumentUrl: 'api/v1/docs-json',
  });
}
