import {
  Controller,
  Get,
  HttpException,
  INestApplication,
  Injectable,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { Server } from 'node:http';
import { setTimeout } from 'node:timers/promises';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { ObservabilityModule } from '../src/common/observability.module';
import { RequestContext } from '../src/common/request-context';
import { LOG_SINK, StructuredLogger } from '../src/common/structured-logger';
import { settings } from '../src/configuration/configuration.module';
import { validateTestEnvironment as validateEnvironment } from './configuration.fixture';
import { configureApplication } from '../src/configure-application';
import { PRISMA_CLIENT } from '../src/database/prisma.service';
import { databaseStub } from './database.stub';

@Injectable()
class ProbeService {
  constructor(
    private readonly context: RequestContext,
    private readonly logger: StructuredLogger,
  ) {}
  async inspect() {
    const before = this.context.correlationId;
    await setTimeout(10);
    this.logger.event('info', 'probe.completed');
    return { before, after: this.context.correlationId };
  }
}

@Controller('observability-probe')
class ProbeController {
  constructor(private readonly service: ProbeService) {}
  @Get()
  inspect() {
    return this.service.inspect();
  }
  @Get('conflict')
  conflict() {
    throw new HttpException(
      {
        message: 'private database constraint',
        password: 'sensitive-exception',
      },
      409,
    );
  }
  @Get('unavailable')
  unavailable() {
    throw new HttpException('postgresql://private:credential@db', 503);
  }
  @Get('unknown')
  unknown() {
    throw new Error('private infrastructure stack and secret');
  }
  @Get('invalid-status')
  invalidStatus() {
    throw new HttpException('private invalid status', 200);
  }
}

describe('observability (e2e)', () => {
  let app: INestApplication;
  let server: Server;
  const lines: string[] = [];
  const config = validateEnvironment({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://localhost/test',
    CORS_ORIGINS: 'https://frontend.example',
  });

  beforeAll(async () => {
    const fixture = await Test.createTestingModule({
      imports: [AppModule, ObservabilityModule],
      providers: [ProbeService],
      controllers: [ProbeController],
    })
      .overrideProvider(settings.KEY)
      .useValue(config)
      .overrideProvider(PRISMA_CLIENT)
      .useValue(databaseStub())
      .overrideProvider(LOG_SINK)
      .useValue((line: string) => lines.push(line))
      .compile();
    app = fixture.createNestApplication();
    configureApplication(app, config);
    await app.init();
    server = app.getHttpServer();
  });
  beforeEach(() => {
    lines.length = 0;
  });
  afterAll(async () => {
    await app?.close();
  });

  it('propagates a supplied UUID into headers, envelopes, services, and logs', async () => {
    const id = randomUUID();
    const response = await request(server)
      .get('/api/v1/observability-probe')
      .set('X-Correlation-Id', id)
      .expect(200);
    expect(response.headers['x-request-id']).toBe(id);
    expect(response.headers['x-correlation-id']).toBe(id);
    expect(response.body).toEqual({
      data: { before: id, after: id },
      meta: { requestId: id },
    });
    const records = lines.map((line) => JSON.parse(line));
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'probe.completed',
          correlationId: id,
        }),
        expect.objectContaining({
          event: 'http.request.completed',
          correlationId: id,
          data: expect.objectContaining({
            method: 'GET',
            statusCode: 200,
            durationMs: expect.any(Number),
          }),
        }),
      ]),
    );
    expect(
      records.filter((record) => record.event === 'http.request.completed'),
    ).toHaveLength(1);
  });

  it.each([
    'invalid',
    'x'.repeat(200),
    `${randomUUID()}, ${randomUUID()}`,
    '00000000-0000-0000-0000-000000000000',
  ])('replaces invalid correlation IDs', async (id) => {
    const response = await request(server)
      .get('/api/v1')
      .set('X-Correlation-Id', id)
      .expect(200);
    expect(response.headers['x-correlation-id']).not.toBe(id);
    expect(response.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('accepts the legacy header and gives the primary header precedence', async () => {
    const legacy = randomUUID();
    const primary = randomUUID();
    const response = await request(server)
      .get('/api/v1')
      .set('X-Request-Id', legacy);
    expect(response.headers['x-correlation-id']).toBe(legacy);
    const both = await request(server)
      .get('/api/v1')
      .set('X-Request-Id', legacy)
      .set('X-Correlation-Id', primary);
    expect(both.headers['x-correlation-id']).toBe(primary);
  });

  it('isolates concurrent async service contexts', async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    await Promise.all(
      ids.map(async (id) => {
        const response = await request(server)
          .get('/api/v1/observability-probe')
          .set('X-Correlation-Id', id);
        expect(response.body.data).toEqual({ before: id, after: id });
      }),
    );
    expect(app.get(RequestContext).correlationId).toBeUndefined();
  });

  it.each([
    ['conflict', 409, 'CONFLICT', 'Conflict'],
    ['unavailable', 503, 'SERVICE_UNAVAILABLE', 'Service Unavailable'],
    ['unknown', 500, 'INTERNAL_SERVER_ERROR', 'Internal Server Error'],
    ['invalid-status', 500, 'INTERNAL_SERVER_ERROR', 'Internal Server Error'],
    ['missing', 404, 'NOT_FOUND', 'Not Found'],
  ])(
    'maps %s without leaking internal details',
    async (path, status, code, message) => {
      const id = randomUUID();
      const response = await request(server)
        .get(`/api/v1/observability-probe/${path}`)
        .set('X-Correlation-Id', id)
        .expect(Number(status));
      expect(response.body).toEqual({
        error: { code, message, details: {}, traceId: id },
      });
      expect(response.headers['x-correlation-id']).toBe(id);
      expect(lines.join('')).not.toMatch(
        /private|sensitive|postgresql|credential/,
      );
      expect(lines.map((line) => JSON.parse(line))).toContainEqual(
        expect.objectContaining({
          event: 'http.request.failed',
          correlationId: id,
        }),
      );
    },
  );

  it('handles malformed JSON before controller execution without logging credentials', async () => {
    const id = randomUUID();
    const response = await request(server)
      .post('/api/v1/observability-probe?token=sensitive-query')
      .set('X-Correlation-Id', id)
      .set('Authorization', 'Bearer sensitive-auth')
      .set('Cookie', 'session=sensitive-cookie')
      .set('Content-Type', 'application/json')
      .send('{"password":"sensitive-body",')
      .expect(400);
    expect(response.body).toEqual({
      error: {
        code: 'BAD_REQUEST',
        message: 'Bad Request',
        details: {},
        traceId: id,
      },
    });
    expect(lines.join('')).not.toContain('sensitive-');
  });

  it('makes correlation headers readable by allowed browser origins', async () => {
    const response = await request(server)
      .get('/api/v1')
      .set('Origin', 'https://frontend.example');
    expect(response.headers['access-control-expose-headers']).toContain(
      'X-Correlation-Id',
    );
  });
});
