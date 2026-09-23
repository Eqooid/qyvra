import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

/***
 * @class AppController
 * @description Controller for handling application-related requests.
 * @tags Application
 * @author Cristono Wijaya
 */
@ApiTags('Application')
@Controller()
export class AppController {
  /**
   * @author Cristono Wijaya
   * @constructor - Initializes the AppController with the provided AppService.
   * @param appService - The service responsible for providing application information.
   */
  constructor(private readonly appService: AppService) {}

  /**
   * @author Cristono Wijaya
   * @description Retrieves public application information including the application name and API version.
   * @returns An object containing the application name and API version.
   * @example
   * Example response:
   * {
   *   "data": {
   *     "name": "My Application",
   *     "apiVersion": "v1"
   *   },
   *   "meta": {
   *     "requestId": "123e4567-e89b-12d3-a456-426614174000"
   *   }
   * }  
   */
  @Get()
  @ApiOperation({ summary: 'Get public application information' })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            apiVersion: { type: 'string', enum: ['v1'] },
          },
        },
        meta: {
          type: 'object',
          properties: { requestId: { type: 'string', format: 'uuid' } },
        },
      },
    },
  })
  getInformation() {
    return this.appService.getInformation();
  }
}
