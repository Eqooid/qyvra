import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import { RedisProcessingProgressStore } from './redis-processing-progress.store';

const redisUrl = process.env.TEST_REDIS_URL;
const settings = {
  url: redisUrl,
  ttlSeconds: 2,
  connectTimeoutMs: 250,
  commandTimeoutMs: 250,
};

describe('Redis disposable processing progress', () => {
  it('degrades to missing progress when unconfigured or unavailable', async () => {
    const absent = new RedisProcessingProgressStore({
      ...settings,
      url: undefined,
    });
    const id = randomUUID();
    await absent.report(id, 1, 20, 'READING');
    expect(await absent.read(id, 1)).toBeNull();
    await absent.onApplicationShutdown();

    const unavailable = new RedisProcessingProgressStore({
      ...settings,
      url: 'redis://127.0.0.1:1',
    });
    await unavailable.report(id, 1, 20, 'READING');
    expect(await unavailable.read(id, 1)).toBeNull();
    await unavailable.clear(id, 1);
    await unavailable.onApplicationShutdown();
  });

  (redisUrl ? it : it.skip)(
    'stores only expiring attempt-scoped values, tolerates key loss, and clears',
    async () => {
      const id = randomUUID();
      const store = new RedisProcessingProgressStore(settings);
      const client = createClient({ url: redisUrl });
      await client.connect();
      const key = `brainless:processing:progress:${id}:1`;
      try {
        await store.report(id, 1, 25, 'READING');
        expect(await store.read(id, 1)).toMatchObject({
          attempt: 1,
          percent: 25,
          stage: 'READING',
        });
        expect(await store.read(id, 2)).toBeNull();
        expect(await client.ttl(key)).toBeGreaterThan(0);
        expect(await client.ttl(key)).toBeLessThanOrEqual(2);
        await new Promise((resolve) => setTimeout(resolve, 2100));
        expect(await store.read(id, 1)).toBeNull();
        await store.report(id, 1, 80, 'VERIFYING');
        expect((await store.read(id, 1))?.percent).toBe(80);
        await client.set(key, '{broken', { EX: 2 });
        expect(await store.read(id, 1)).toBeNull();
        await store.report(id, 1, 90, 'FINALIZING');
        await store.clear(id, 1);
        expect(await store.read(id, 1)).toBeNull();
        await store.report(id, 2, 10, 'PREPARING');
        await client.del(`brainless:processing:progress:${id}:2`);
        expect(await store.read(id, 2)).toBeNull();
      } finally {
        await client.del([key, `brainless:processing:progress:${id}:2`]);
        await client.destroy();
        await store.onApplicationShutdown();
      }
    },
  );
});
