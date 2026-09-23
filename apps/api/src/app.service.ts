import { Injectable } from '@nestjs/common';
import { ConfigurationService } from './configuration/configuration.module';

/**
 * @author Cristono Wijaya
 * @class AppService
 * @description Service responsible for providing application-related information.
 * @tags Application
 * @injectable - Marks the class as injectable, allowing it to be used as a provider in NestJS modules.
 */
@Injectable()
export class AppService {
  /**
   * @author Cristono Wijaya
   * @constructor - Initializes the AppService with the provided ConfigurationService.
   * @param configuration - The service responsible for accessing application configuration settings.
   */
  constructor(private readonly configuration: ConfigurationService) {}

  /**
   * @author Cristono Wijaya
   * @return An object containing the application name and API version.
   * @description Retrieves public application information including the application name and API version.
   * @example
   * Example response:
   * {
   *   "name": "My Application",
   *   "apiVersion": "v1"
   * }
   */
  getInformation(): { name: string; apiVersion: string } {
    return { name: this.configuration.application.name, apiVersion: 'v1' };
  }
}
