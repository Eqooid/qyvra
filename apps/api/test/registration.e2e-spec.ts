import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Server } from 'node:http';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/configure-application';
import { settings } from '../src/configuration/configuration.module';
import { validateTestEnvironment as validateEnvironment } from './configuration.fixture';
import { PRISMA_CLIENT } from '../src/database/prisma.service';
import { RegistrationRepository } from '../src/modules/auth/registration.repository';
import { RegistrationConflict } from '../src/modules/auth/registration.errors';
import { databaseStub } from './database.stub';

describe('registration HTTP contract', () => {
  let app: INestApplication;
  let server: Server;
  const repository = { create: jest.fn() };
  const password = 'a sufficiently long passphrase';
  beforeAll(async () => {
    const config = validateEnvironment({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://localhost/test',
    });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(settings.KEY)
      .useValue(config)
      .overrideProvider(PRISMA_CLIENT)
      .useValue(databaseStub())
      .overrideProvider(RegistrationRepository)
      .useValue(repository)
      .compile();
    app = module.createNestApplication();
    configureApplication(app, config);
    await app.init();
    server = app.getHttpServer();
  });
  beforeEach(() => {
    repository.create.mockReset();
  });
  afterAll(async () => {
    await app?.close();
  });

  it('returns only public fields in the standard envelope without a session cookie', async () => {
    repository.create.mockResolvedValue({
      id: '9a184646-412b-4300-a52e-3cab9112db71',
      email: 'person@example.invalid',
    });
    const response = await request(server)
      .post('/api/v1/auth/register')
      .send({ email: ' Person@Example.Invalid ', password })
      .expect(201);
    expect(response.body).toEqual({
      data: {
        id: '9a184646-412b-4300-a52e-3cab9112db71',
        email: 'person@example.invalid',
      },
      meta: { requestId: response.headers['x-correlation-id'] as string },
    });
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.headers['cache-control']).toBe('no-store');
    expect(repository.create.mock.calls[0]?.[0]).toBe('person@example.invalid');
  });

  it.each([
    { email: 'invalid', password },
    { email: 'person@example.invalid', password: 'short' },
    { email: 'person@example.invalid', password: 123 },
    { email: 'person@example.invalid' },
    { email: 'person@example.invalid', password, userId: 'untrusted' },
    { email: ['person@example.invalid'], password },
  ])('rejects invalid input case %# before persistence', async (body) => {
    const response = await request(server)
      .post('/api/v1/auth/register')
      .send(body)
      .expect(400);
    expect(response.body).toEqual({
      error: {
        code: 'BAD_REQUEST',
        message: 'Bad Request',
        details: {},
        traceId: response.headers['x-correlation-id'] as string,
      },
    });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('returns a generic conflict without account details', async () => {
    repository.create.mockRejectedValue(new RegistrationConflict());
    const response = await request(server)
      .post('/api/v1/auth/register')
      .send({ email: 'person@example.invalid', password })
      .expect(409);
    expect(response.body).toEqual({
      error: {
        code: 'CONFLICT',
        message: 'Conflict',
        details: {},
        traceId: response.headers['x-correlation-id'] as string,
      },
    });
  });

  it('documents the registration request and responses', async () => {
    const response = await request(server).get('/api/v1/docs-json').expect(200);
    const document = response.body as {
      paths: Record<string, { post: { responses: Record<string, unknown> } }>;
    };
    expect(
      Object.keys(document.paths['/api/v1/auth/register'].post.responses),
    ).toEqual(expect.arrayContaining(['201', '400', '409']));
  });
});
