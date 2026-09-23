import { Inject, Injectable, Module } from '@nestjs/common';
import { ConfigModule, registerAs } from '@nestjs/config';
import { resolve } from 'node:path';
import { validateEnvironment } from './environment';
import { ApiConfiguration } from './settings';

// All process environment access stays at this configuration boundary.
/**
 * @author Cristono Wijaya
 * @description Registers validated environment settings under a single NestJS injection token.
 * @tags Configuration
 * @constant settings - The registered configuration factory.
 */
export const settings = registerAs('settings', () =>
  validateEnvironment(process.env),
);

/**
 * @author Cristono Wijaya
 * @description Provides typed access to the validated settings without reading process.env in application services.
 * @tags Configuration
 * @class ConfigurationService
 * @injectable - Registers this class as a NestJS dependency-injection provider.
 */
@Injectable()
export class ConfigurationService {
  /** @description Bounded upload and inspection policy; executable selection is trusted configuration only. */
  get upload() {
    return this.settings.upload;
  }
  /** @description Returns validated provider selection and the private local root; never log the root. */
  get storage() {
    return this.settings.storage;
  }
  /**
   * @author Cristono Wijaya
   * @description Initializes ConfigurationService with its injected dependencies.
   * @tags Configuration
   * @constructor - Initializes ConfigurationService with the providers supplied by NestJS.
   * @param settings - The validated settings injected through the registered configuration token.
   */
  constructor(
    @Inject(settings.KEY) private readonly settings: ApiConfiguration,
  ) {}

  /**
   * @author Cristono Wijaya
   * @description Returns the configured application name and runtime environment.
   * @tags Configuration
   * @returns The application name and runtime environment.
   * @example
   * ```ts
   * const { name, environment } = this.configurationService.application;
   * ```
   */
  get application() {
    return this.settings.application;
  }

  /**
   * @author Cristono Wijaya
   * @description Returns the HTTP bind address, port, and request-body size limit.
   * @tags Configuration
   * @returns The HTTP bind address, port, and request-body size limit.
   * @example
   * ```ts
   * const { host, port, bodyLimitBytes } = this.configurationService.http;
   * ```
   */
  get http() {
    return this.settings.http;
  }

  /**
   * @author Cristono Wijaya
   * @description Returns PostgreSQL connection and pool settings. The connection URL must not be logged.
   * @tags Configuration
   * @returns The PostgreSQL connection and pool settings.
   * @example
   * ```ts
   * const { url, connectTimeoutMs, queryTimeoutMs, poolSize } = this.configurationService.database;
   * ```
   */
  get database() {
    return this.settings.database;
  }
  /**
   * @author Cristono Wijaya
   * @description Returns the exact allowed browser origins and credential-sharing policy.
   * @tags Configuration
   * @returns - The validated origin allowlist and credential-sharing setting.
   * @example
   * ```ts
   * const { origins, credentials } = this.configuration.cors;
   * ```
   */
  get cors() {
    return this.settings.cors;
  }
  /**
   * @author Cristono Wijaya
   * @description Returns password, session, lockout, and authentication rate-limit policies.
   * @tags Configuration
   * @returns - The validated password, session, lockout, and throttling policies.
   * @example
   * ```ts
   * const { sessionTtlSeconds, loginMaxAttempts } = this.configuration.authentication;
   * ```
   */
  get authentication() {
    return this.settings.authentication;
  }
  /**
   * @author Cristono Wijaya
   * @description Returns validated authentication cookie names, scopes, and security attributes.
   * @tags Configuration
   * @returns - The validated authentication cookie scope, lifetime, and security attributes.
   * @example
   * ```ts
   * const { secure, sameSite, path } = this.configuration.cookie;
   * ```
   */
  get cookie() {
    return this.settings.cookie;
  }
}

/**
 * @author Cristono Wijaya
 * @description Loads root environment settings and exports the typed configuration provider. Tests ignore the .env file.
 * @tags Configuration
 * @class ConfigurationModule
 * @module ConfigurationModule
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      envFilePath: resolve(__dirname, '../../../../.env'),
      ignoreEnvFile: process.env.NODE_ENV === 'test',
      load: [settings],
    }),
  ],
  providers: [ConfigurationService],
  exports: [ConfigurationService],
})
export class ConfigurationModule {}
