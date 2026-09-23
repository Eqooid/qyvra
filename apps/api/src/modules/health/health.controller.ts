import { Controller, Get, Header } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { HealthService } from './health.service';

/**
 * @author Cristono Wijaya
 * @description Documents the correlation UUID headers included in health responses.
 * @tags Health Checks
 * @constant correlationHeaders - The shared correlationHeaders definition.
 */
const correlationHeaders = {
  'X-Correlation-Id': { schema: { type: 'string', format: 'uuid' } },
  'X-Request-Id': { schema: { type: 'string', format: 'uuid' } },
};

/**
 * @author Cristono Wijaya
 * @description Builds the standard success-envelope schema for the supplied health status.
 * @tags Health Checks
 * @param status - The documented health status.
 * @returns - The OpenAPI success-envelope schema for the given health status.
 */
function successSchema(status: string) {
  return {
    type: 'object',
    required: ['data', 'meta'],
    properties: {
      data: {
        type: 'object',
        required: ['status'],
        properties: { status: { type: 'string', enum: [status] } },
      },
      meta: {
        type: 'object',
        required: ['requestId'],
        properties: { requestId: { type: 'string', format: 'uuid' } },
      },
    },
  };
}

/**
 * @author Cristono Wijaya
 * @description Exposes public process liveness and PostgreSQL-backed readiness without connection details.
 * @tags Health Checks
 * @class HealthController
 */
@ApiTags('Health')
@Controller('health')
export class HealthController {
  /**
   * @author Cristono Wijaya
   * @description Initializes HealthController with its injected dependencies.
   * @tags Health Checks
   * @constructor - Initializes HealthController with the providers supplied by NestJS.
   * @param health - The service checking local liveness and database readiness.
   */
  constructor(private readonly health: HealthService) {}

  /**
   * @author Cristono Wijaya
   * @description Returns the local responsiveness result without querying external dependencies.
   * @tags Health Checks
   * @returns - A local health result with status set to ok.
   */
  @Get('live')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Confirm that the API process can respond',
    description: 'Local check only; does not contact dependencies.',
  })
  @ApiOkResponse({ schema: successSchema('ok'), headers: correlationHeaders })
  live() {
    return this.health.live();
  }

  /**
   * @author Cristono Wijaya
   * @description Delegates to the lifecycle and database readiness check, which reports unavailable dependencies as HTTP 503.
   * @tags Health Checks
   * @returns - A promise resolving to status ready when lifecycle and PostgreSQL checks succeed.
   * @throws ServiceUnavailableException - The application is not ready or PostgreSQL cannot be queried.
   */
  @Get('ready')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Check whether the API can serve requests',
    description:
      'Checks PostgreSQL with SELECT 1 and bounded connection/query timeouts. Unavailable during shutdown or when PostgreSQL cannot be queried. No other dependencies are checked.',
  })
  @ApiOkResponse({
    schema: successSchema('ready'),
    headers: correlationHeaders,
  })
  @ApiServiceUnavailableResponse({
    headers: correlationHeaders,
    schema: {
      type: 'object',
      required: ['error'],
      properties: {
        error: {
          type: 'object',
          required: ['code', 'message', 'details', 'traceId'],
          properties: {
            code: { type: 'string', enum: ['SERVICE_UNAVAILABLE'] },
            message: { type: 'string', enum: ['Service Unavailable'] },
            details: { type: 'object', additionalProperties: false },
            traceId: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
  })
  ready() {
    return this.health.readiness();
  }
}
