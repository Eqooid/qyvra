import { existsSync } from 'node:fs';
import type { PrismaService } from '../../database/prisma.service';
import { WorkerReadiness } from './worker-readiness';
import { workerReadyFile } from './worker-ready';

describe('worker dependency readiness', () => {
  it('requires both dependencies and clears readiness on database loss and shutdown', async () => {
    const database = { ping: jest.fn().mockResolvedValue(undefined) };
    const readiness = new WorkerReadiness(database as unknown as PrismaService);
    try {
      await readiness.onModuleInit();
      expect(existsSync(workerReadyFile)).toBe(false);
      readiness.setConsumerReady(true);
      expect(existsSync(workerReadyFile)).toBe(true);

      database.ping.mockRejectedValueOnce(new Error('test outage'));
      await readiness.refreshDatabase();
      expect(existsSync(workerReadyFile)).toBe(false);

      await readiness.refreshDatabase();
      expect(existsSync(workerReadyFile)).toBe(true);
    } finally {
      await readiness.onApplicationShutdown();
    }
    expect(existsSync(workerReadyFile)).toBe(false);
  });
});
