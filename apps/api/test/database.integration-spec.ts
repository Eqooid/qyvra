import { Test } from '@nestjs/testing';
import { createPrismaClient } from '@brainless/database';
import { DatabaseModule } from '../src/database/database.module';
import { PrismaService } from '../src/database/prisma.service';
import { settings } from '../src/configuration/configuration.module';
import { validateTestEnvironment as validateEnvironment } from './configuration.fixture';

describe('PostgreSQL connectivity (real database; read-only)', () => {
  it('connects at startup, executes SQL, and disconnects at shutdown', async () => {
    const config = validateEnvironment({
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL,
    });
    const fixture = await Test.createTestingModule({
      imports: [DatabaseModule],
    })
      .overrideProvider(settings.KEY)
      .useValue(config)
      .compile();
    const database = fixture.get(PrismaService);
    const disconnect = jest.spyOn(database.client, '$disconnect');
    try {
      await fixture.init();
      await expect(database.ping()).resolves.toBeUndefined();
      await expect(
        database.client.$queryRaw`SELECT 1 AS value`,
      ).resolves.toEqual([{ value: 1 }]);
    } finally {
      await fixture.close();
    }
    expect(disconnect).toHaveBeenCalledTimes(1);
    await expect(database.ping()).rejects.toThrow('PostgreSQL is unavailable');
  });

  it('fails startup against an unavailable database without leaking its URL', async () => {
    const client = createPrismaClient({
      url: 'postgresql://127.0.0.1:1/unavailable',
      connectTimeoutMs: 100,
      queryTimeoutMs: 100,
      poolSize: 1,
    });
    const database = new PrismaService(client);
    await expect(database.onModuleInit()).rejects.toThrow(
      'PostgreSQL connection failed during startup.',
    );
    await database.onApplicationShutdown();
  });

  it('bounds slow SQL execution with a real PostgreSQL timeout', async () => {
    const config = validateEnvironment({
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      DATABASE_QUERY_TIMEOUT_MS: '100',
    });
    const client = createPrismaClient(config.database);
    try {
      await client.$connect();
      const started = Date.now();
      await expect(client.$queryRaw`SELECT pg_sleep(2)`).rejects.toBeDefined();
      expect(Date.now() - started).toBeLessThan(1500);
    } finally {
      await client.$disconnect();
    }
  });
});
