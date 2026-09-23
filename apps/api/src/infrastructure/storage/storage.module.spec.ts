import { Test } from '@nestjs/testing';
import { STORAGE, Storage, LocalFileStorage } from '@brainless/storage';
import { StorageModule } from './storage.module';
import { settings } from '../../configuration/configuration.module';
import { validateTestEnvironment } from '../../../test/configuration.fixture';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { Readable } from 'node:stream';

describe('StorageModule provider binding', () => {
  it('resolves the shared token with isolated streaming operations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'brainless-storage-di-'));
    const module = await Test.createTestingModule({ imports: [StorageModule] })
      .overrideProvider(settings.KEY)
      .useValue(
        validateTestEnvironment({
          NODE_ENV: 'test',
          DATABASE_URL: 'postgresql://localhost/test',
          LOCAL_STORAGE_ROOT: root,
        }),
      )
      .compile();
    try {
      const storage = module.get<Storage>(STORAGE);
      expect(storage).toBeInstanceOf(LocalFileStorage);
      expect(
        (await storage.save('fixture', Readable.from(['hello']))).size,
      ).toBe(5);
      expect(await storage.delete('fixture')).toBe(true);
    } finally {
      await module.close();
      expect(dirname(resolve(root))).toBe(resolve(tmpdir()));
      expect(basename(root).startsWith('brainless-storage-di-')).toBe(true);
      await rm(root, { recursive: true, force: true });
    }
  });
  it('fails selection defensively if injected configuration names an unsupported provider', async () => {
    const config = validateTestEnvironment({
      DATABASE_URL: 'postgresql://localhost/test',
    });
    await expect(
      Test.createTestingModule({ imports: [StorageModule] })
        .overrideProvider(settings.KEY)
        .useValue({
          ...config,
          storage: { ...config.storage, provider: 'unsupported' },
        })
        .compile(),
    ).rejects.toThrow('Unsupported storage provider');
  });
});
