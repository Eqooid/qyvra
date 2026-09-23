import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ConfigurationService } from './configuration/configuration.module';
import { configureApplication } from './configure-application';
import { RequestContext } from './common/request-context';
import { stdoutSink, StructuredLogger } from './common/structured-logger';

/**
 * @author Cristono Wijaya
 * @description The main entry point for the NestJS application. This function bootstraps the application, configures global settings, and starts listening for incoming requests.
 * It initializes the application with a structured logger and sets up necessary configurations before starting the server.
 * @tags Application Bootstrap
 */
const bootstrapLogger = new StructuredLogger(new RequestContext(), stdoutSink);

/**
 * @author Cristono Wijaya
 * @description Bootstraps the NestJS application by creating an instance of the AppModule, configuring global settings, and starting the server.
 * It handles any errors that occur during the bootstrap process and logs them appropriately.
 * @tags Application Bootstrap
 */
async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: bootstrapLogger,
    abortOnError: false,
  });
  const configuration = app.get(ConfigurationService);
  configureApplication(app, configuration);
  await app.listen(configuration.http.port, configuration.http.host);
}
void bootstrap().catch(() => {
  bootstrapLogger.event('error', 'application.startup.failed');
  process.exitCode = 1;
});
