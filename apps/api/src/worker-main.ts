import { NestFactory } from '@nestjs/core';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { ConfigurationService } from './configuration/configuration.module';
import { RabbitMqConsumer } from './infrastructure/messaging/rabbitmq.consumer';
import { WorkerModule } from './infrastructure/worker/worker.module';
import { markWorkerReady } from './infrastructure/worker/worker-ready';

async function bootstrap(): Promise<void> {
  markWorkerReady(false);
  const app = await NestFactory.createApplicationContext(WorkerModule);
  const config = app.get(ConfigurationService);
  if (!config.messaging.url) {
    await app.close();
    throw new Error('RABBITMQ_URL is required for the worker.');
  }
  try {
    const root = config.storage.localRoot;
    const info = await stat(root);
    if (!info.isDirectory())
      throw new Error('Storage root is not a directory.');
    await access(root, constants.R_OK | constants.X_OK);
  } catch {
    await app.close();
    throw new Error('Worker private storage unavailable at startup.');
  }
  const consumer = app.get(RabbitMqConsumer);
  try {
    await consumer.start();
  } catch {
    await app.close();
    throw new Error('Worker consumer startup failed.');
  }
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void consumer
      .stop()
      .then(() => app.close())
      .catch(() => {
        process.stderr.write('Worker shutdown failed.\n');
        process.exitCode = 1;
      });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

void bootstrap().catch(() => {
  markWorkerReady(false);
  process.stderr.write('Worker startup failed.\n');
  process.exitCode = 1;
});
