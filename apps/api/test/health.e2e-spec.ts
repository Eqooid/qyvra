import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { Server } from 'node:http';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/configure-application';
import { LOG_SINK } from '../src/common/structured-logger';
import { settings } from '../src/configuration/configuration.module';
import { validateTestEnvironment as validateEnvironment } from './configuration.fixture';
import { HealthService } from '../src/modules/health/health.service';
import { PRISMA_CLIENT } from '../src/database/prisma.service';
import { databaseStub } from './database.stub';

describe('health endpoints', () => {
  let app: INestApplication;
  let server: Server;
  let database: ReturnType<typeof databaseStub>;
  const config = validateEnvironment({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://unreachable.invalid/test',
  });

  beforeEach(async () => {
    database = databaseStub();
    const fixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(settings.KEY)
      .useValue(config)
      .overrideProvider(PRISMA_CLIENT)
      .useValue(database)
      .overrideProvider(LOG_SINK)
      .useValue(() => undefined)
      .compile();
    app = fixture.createNestApplication();
    configureApplication(app, config);
    await app.init();
    server = app.getHttpServer();
  });
  afterEach(async () => {
    await app?.close();
  });

  it.each([
    ['live', 'ok'],
    ['ready', 'ready'],
  ])('returns the documented %s success envelope', async (path, status) => {
    const id = randomUUID();
    const response = await request(server)
      .get(`/api/v1/health/${path}`)
      .set('X-Correlation-Id', id)
      .expect(200)
      .expect('Cache-Control', 'no-store');
    expect(response.body).toEqual({
      data: { status },
      meta: { requestId: id },
    });
    expect(response.headers['x-correlation-id']).toBe(id);
    expect(JSON.stringify(response.body)).not.toContain('unreachable');
  });

  it('returns a safe 503 during shutdown while liveness continues responding', async () => {
    app.get(HealthService).beforeApplicationShutdown();
    const id = randomUUID();
    const response = await request(server)
      .get('/api/v1/health/ready')
      .set('X-Correlation-Id', id)
      .expect(503)
      .expect('Cache-Control', 'no-store');
    expect(response.body).toEqual({
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Service Unavailable',
        details: {},
        traceId: id,
      },
    });
    await request(server).get('/api/v1/health/live').expect(200);
  });

  it('publishes Swagger schemas for both probes and readiness failure', async () => {
    const response = await request(server).get('/api/v1/docs-json').expect(200);
    expect(
      response.body.paths['/api/v1/health/live'].get.responses['200'].content[
        'application/json'
      ].schema.properties.data.properties.status.enum,
    ).toEqual(['ok']);
    expect(
      response.body.paths['/api/v1/health/ready'].get.responses['503'].content[
        'application/json'
      ].schema.properties.error.properties.code.enum,
    ).toEqual(['SERVICE_UNAVAILABLE']);
    await request(server).get('/api/v1/docs/').expect(200);
  });

  it('returns 503 without exposing database errors, and recovers', async () => {
    database.$queryRaw.mockRejectedValueOnce(
      new Error('secret connection URL'),
    );
    const response = await request(server)
      .get('/api/v1/health/ready')
      .expect(503);
    expect(JSON.stringify(response.body)).not.toContain('secret');
    await request(server).get('/api/v1/health/live').expect(200);
    await request(server).get('/api/v1/health/ready').expect(200);
  });
});
