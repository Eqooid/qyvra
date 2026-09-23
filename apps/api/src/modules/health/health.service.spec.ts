import { ServiceUnavailableException } from '@nestjs/common';
import { HealthService } from './health.service';

describe('health lifecycle', () => {
  it('is live but not ready before initialization', async () => {
    const health = new HealthService({
      ping: jest.fn().mockResolvedValue(undefined),
    });
    expect(health.live()).toEqual({ status: 'ok' });
    await expect(health.readiness()).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('becomes ready after bootstrap and unready during shutdown', async () => {
    const health = new HealthService({
      ping: jest.fn().mockResolvedValue(undefined),
    });
    health.onApplicationBootstrap();
    await expect(health.readiness()).resolves.toEqual({ status: 'ready' });
    health.beforeApplicationShutdown();
    await expect(health.readiness()).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(health.live()).toEqual({ status: 'ok' });
  });
});
