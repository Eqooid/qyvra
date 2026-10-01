import { NestFactory } from '@nestjs/core';
import { OutboxModule } from './infrastructure/outbox/outbox.module';
import { OutboxDispatcher } from './infrastructure/outbox/outbox-dispatcher.service';
import { ConfigurationService } from './configuration/configuration.module';
import { ProcessingRecovery } from './infrastructure/outbox/processing-recovery.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(OutboxModule);
  const config = app.get(ConfigurationService);
  if (!config.messaging.url) {
    await app.close();
    throw new Error('RABBITMQ_URL is required for the outbox dispatcher.');
  }
  const dispatcher = app.get(OutboxDispatcher);
  const recovery = app.get(ProcessingRecovery);
  recovery.start();
  dispatcher.start();
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void Promise.all([dispatcher.stop(), recovery.stop()])
      .then(() => app.close())
      .catch(() => {
        process.stderr.write('Outbox dispatcher shutdown failed.\n');
        process.exitCode = 1;
      });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

void bootstrap().catch(() => {
  // Configuration and infrastructure details are not printed to process logs.
  process.stderr.write('Outbox dispatcher startup failed.\n');
  process.exitCode = 1;
});
