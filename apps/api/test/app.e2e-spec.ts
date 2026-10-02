import { Body, Controller, INestApplication, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Type } from 'class-transformer';
import { IsInt, IsString, Min } from 'class-validator';
import { Server } from 'node:http';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/configure-application';
import { validateTestEnvironment as validateEnvironment } from './configuration.fixture';
import { settings } from '../src/configuration/configuration.module';
import { PRISMA_CLIENT } from '../src/database/prisma.service';
import { databaseStub } from './database.stub';

const testEnvironment = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://localhost/configuration_test',
};

class ValidationProbeDto {
  @IsString()
  declare name: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  declare count: number;
}

// This test-only route exercises the production pipe without adding a feature.
@Controller('validation-probe')
class ValidationProbeController {
  @Post()
  create(@Body() dto: ValidationProbeDto) {
    return { ...dto, transformed: dto instanceof ValidationProbeDto };
  }
}

describe('API foundation (e2e)', () => {
  let app: INestApplication;
  let server: Server;
  const origin = 'https://frontend.example';
  const shutdownListenersBefore = process.listenerCount('SIGTERM');

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [ValidationProbeController],
    })
      .overrideProvider(settings.KEY)
      .useValue(validateEnvironment(testEnvironment))
      .overrideProvider(PRISMA_CLIENT)
      .useValue(databaseStub())
      .compile();
    app = moduleFixture.createNestApplication();
    configureApplication(
      app,
      validateEnvironment({
        ...testEnvironment,
        CORS_ORIGINS: origin,
        CORS_CREDENTIALS: 'true',
      }),
    );
    await app.init();
    server = app.getHttpServer();
  });

  afterAll(async () => {
    await app?.close();
    expect(process.listenerCount('SIGTERM')).toBe(shutdownListenersBefore);
  });

  it('registers graceful shutdown signal handling', () => {
    expect(process.listenerCount('SIGTERM')).toBeGreaterThan(
      shutdownListenersBefore,
    );
  });

  it('serves information under /api/v1 with a request ID', async () => {
    const response = await request(server).get('/api/v1').expect(200);
    expect(response.body).toEqual({
      data: { name: 'QYVRA API', apiVersion: 'v1' },
      meta: { requestId: response.headers['x-request-id'] },
    });
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('does not expose the unprefixed starter route', async () => {
    const response = await request(server).get('/').expect(404);
    expect(response.body).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'Not Found',
        details: {},
        traceId: response.headers['x-request-id'],
      },
    });
  });
  it('transforms DTO instances and explicitly typed properties', async () => {
    const response = await request(server)
      .post('/api/v1/validation-probe')
      .send({ name: 'example', count: '2' })
      .expect(201);
    expect(response.body.data).toEqual({
      name: 'example',
      count: 2,
      transformed: true,
    });
  });
  it.each([
    { name: 'example', count: 1, unexpected: 'secret' },
    { name: 123, count: 1 },
    { name: 'example', count: 0 },
    { name: 'example', count: 'invalid' },
    {},
  ])('rejects invalid bodies %p', async (body) => {
    const response = await request(server)
      .post('/api/v1/validation-probe')
      .send(body)
      .expect(400);
    expect(response.body.error.code).toBe('BAD_REQUEST');
    expect(JSON.stringify(response.body)).not.toContain('secret');
  });
  it('allows a configured origin and credentialed preflight', async () => {
    await request(server)
      .options('/api/v1/validation-probe')
      .set('Origin', origin)
      .set('Access-Control-Request-Method', 'POST')
      .expect(204)
      .expect('Access-Control-Allow-Origin', origin)
      .expect('Access-Control-Allow-Credentials', 'true');
  });
  it('omits CORS permission for an unlisted origin', async () => {
    const response = await request(server)
      .get('/api/v1')
      .set('Origin', 'https://unlisted.example')
      .expect(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
  it('serves requests without an Origin header', async () => {
    await request(server).get('/api/v1').expect(200);
  });

  it('disables browser CORS permissions when no origins are configured', async () => {
    const fixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(settings.KEY)
      .useValue(validateEnvironment(testEnvironment))
      .overrideProvider(PRISMA_CLIENT)
      .useValue(databaseStub())
      .compile();
    const isolatedApp = fixture.createNestApplication();
    try {
      configureApplication(isolatedApp, validateEnvironment(testEnvironment));
      await isolatedApp.init();
      const isolatedServer: Server = isolatedApp.getHttpServer();
      const response = await request(isolatedServer)
        .get('/api/v1')
        .set('Origin', origin)
        .expect(200);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
      expect(
        response.headers['access-control-allow-credentials'],
      ).toBeUndefined();
    } finally {
      await isolatedApp.close();
    }
  });
});
