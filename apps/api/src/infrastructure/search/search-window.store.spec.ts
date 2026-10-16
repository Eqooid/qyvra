import { randomBytes, randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import { ConfigurationService } from '../../configuration/configuration.module';
import { validateTestEnvironment } from '../../../test/configuration.fixture';
import {
  SearchWindowStore,
  type SearchWindow,
  validSearchWindow,
  SEARCH_WINDOWS_KEY,
} from './search-window.store';

function window(): SearchWindow {
  return {
    version: 'document-rrf60-v1',
    owner: randomUUID(),
    session: 'a'.repeat(64),
    digest: 'b'.repeat(64),
    mode: 'keyword',
    generationId: randomUUID(),
    expires: Date.now() + 300000,
    nonce: randomBytes(32).toString('base64url'),
    limit: 10,
    truncated: false,
    entries: [],
  };
}
describe('private bounded disposable search windows', () => {
  it('validates identities, per-document bounds and incompatible/corrupt stored values', () => {
    expect(validSearchWindow(window())).toBe(true);
    for (const value of [
      { ...window(), entries: Array(201).fill({}) },
      { ...window(), limit: 21 },
      { ...window(), mode: 'semantic' },
      { ...window(), nonce: 'bad' },
      { ...window(), session: 'raw-session' },
      { ...window(), mode: 'hybrid' },
    ])
      expect(validSearchWindow(value as SearchWindow)).toBe(false);
  });
  it('does not connect when Redis is absent and rejects oversize state before IO', async () => {
    const store = new SearchWindowStore(
      new ConfigurationService(
        validateTestEnvironment({
          DATABASE_URL: 'postgresql://localhost/test',
        }),
      ),
    );
    await expect(store.read('A'.repeat(22))).rejects.toThrow(
      'SEARCH_WINDOW_UNAVAILABLE',
    );
    expect(await store.save('bad', window())).toBe(false);
    expect(
      await store.save('A'.repeat(22), {
        ...window(),
        nonce: 'x'.repeat(300000),
      }),
    ).toBe(false);
    await store.onApplicationShutdown();
  });
  (process.env.TEST_REDIS_URL ? it : it.skip)(
    'real Redis atomically enforces owner caps, expiry and private round trips',
    async () => {
      const config = new ConfigurationService(
        validateTestEnvironment({
          DATABASE_URL: 'postgresql://localhost/test',
          REDIS_URL: process.env.TEST_REDIS_URL,
        }),
      );
      const store = new SearchWindowStore(config),
        admin = createClient({ url: process.env.TEST_REDIS_URL });
      await admin.connect();
      const w = window(),
        ids: string[] = [];
      try {
        for (let i = 0; i < 8; i++) {
          const id = randomBytes(16).toString('base64url');
          ids.push(id);
          expect(await store.save(id, w)).toBe(true);
        }
        expect(await store.save(randomBytes(16).toString('base64url'), w)).toBe(
          false,
        );
        expect(await store.read(ids[0])).toEqual(w);
        expect(await admin.ttl(SEARCH_WINDOWS_KEY)).toBeGreaterThan(0);
        const field = (await admin.hKeys(SEARCH_WINDOWS_KEY)).find((f) =>
          f.endsWith(':' + ids[0]),
        );
        if (field) {
          const payload = await admin.hGet(SEARCH_WINDOWS_KEY, field);
          await admin.hDel(SEARCH_WINDOWS_KEY, field);
          if (payload)
            await admin.hSet(
              SEARCH_WINDOWS_KEY,
              `0:${w.owner}:${ids[0]}`,
              payload,
            );
        }
        expect(await store.read(ids[0])).toBeNull();
      } finally {
        // Remove only fields for this test's random IDs, never a shared database/hash flush.
        const fields = (await admin.hKeys(SEARCH_WINDOWS_KEY)).filter((f) =>
          ids.some((id) => f.endsWith(':' + id)),
        );
        if (fields.length) await admin.hDel(SEARCH_WINDOWS_KEY, fields);
        await admin.close();
        await store.onApplicationShutdown();
      }
    },
  );
});
