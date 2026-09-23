import { Test } from '@nestjs/testing';
import { storageTestRoot } from '../../test/configuration.fixture';
import {
  ConfigurationModule,
  ConfigurationService,
} from './configuration.module';

describe('configuration startup integration', () => {
  afterEach(() => jest.restoreAllMocks());

  it('loads validated settings through typed dependency injection', async () => {
    jest.replaceProperty(process, 'env', {
      NODE_ENV: 'test',
      LOCAL_STORAGE_ROOT: storageTestRoot,
      DATABASE_URL: 'postgresql://localhost/configuration_test',
      PORT: '4567',
    });
    const module = await Test.createTestingModule({
      imports: [ConfigurationModule],
    }).compile();
    try {
      const config = module.get(ConfigurationService);
      expect(config.application.environment).toBe('test');
      expect(config.http.port).toBe(4567);
      expect(config.database.url).toBe(
        'postgresql://localhost/configuration_test',
      );
      expect(config.cors.origins).toEqual([]);
      expect(config.authentication.sessionTtlSeconds).toBe(604800);
      expect(config.cookie.httpOnly).toBe(true);
    } finally {
      await module.close();
    }
  });

  it.each([
    [{ NODE_ENV: 'test' }, 'DATABASE_URL'],
    [
      {
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://localhost/configuration_test',
        PORT: 'invalid',
      },
      'PORT',
    ],
  ])(
    'prevents startup with invalid or missing settings',
    async (environment, key) => {
      jest.replaceProperty(process, 'env', environment);
      await expect(
        Test.createTestingModule({ imports: [ConfigurationModule] }).compile(),
      ).rejects.toThrow(key);
    },
  );
});
