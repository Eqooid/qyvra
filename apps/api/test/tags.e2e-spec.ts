import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Server } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/configure-application';
import { settings } from '../src/configuration/configuration.module';
import { validateTestEnvironment as validateEnvironment } from './configuration.fixture';
import { PRISMA_CLIENT } from '../src/database/prisma.service';
import { LOG_SINK } from '../src/common/structured-logger';
import {
  TagsService,
  TagConflict,
  TagNotFound,
} from '../src/modules/tags/tags.service';
import { PaginatedData } from '../src/common/paginated-data';
import { databaseStub } from './database.stub';

describe('Tags HTTP contract', () => {
  let app: INestApplication;
  let server: Server;
  const owner = randomUUID();
  const id = randomUUID();
  const cookie = `document_tracker_session=${randomBytes(32).toString('base64url')}`;
  const tag = {
    id,
    name: 'Finance',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const service = {
    list: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  };
  const authSession = { findUnique: jest.fn(), updateMany: jest.fn() };
  const mutate = (method: 'post' | 'patch' | 'delete', path = '') =>
    request(server)
      [method](`/api/v1/tags${path}`)
      .set('Cookie', cookie)
      .set('X-CSRF-Protection', '1');
  beforeAll(async () => {
    const config = validateEnvironment({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://localhost/test',
      CORS_ORIGINS: 'https://frontend.example',
    });
    const fixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(settings.KEY)
      .useValue(config)
      .overrideProvider(PRISMA_CLIENT)
      .useValue({ ...databaseStub(), authSession })
      .overrideProvider(TagsService)
      .useValue(service)
      .overrideProvider(LOG_SINK)
      .useValue(() => undefined)
      .compile();
    app = fixture.createNestApplication();
    configureApplication(app, config);
    await app.init();
    server = app.getHttpServer();
  });
  beforeEach(() => {
    jest.resetAllMocks();
    authSession.findUnique.mockResolvedValue({
      id: randomUUID(),
      expiresAt: new Date(Date.now() + 60000),
      revokedAt: null,
      lastSeenAt: new Date(),
      user: {
        id: owner,
        email: 'owner@example.invalid',
        displayName: null,
        locale: 'en',
        timezone: 'UTC',
        deletedAt: null,
      },
    });
    service.list.mockResolvedValue(new PaginatedData([tag], null, false));
    service.create.mockResolvedValue(tag);
    service.update.mockResolvedValue(tag);
    service.delete.mockResolvedValue({ deleted: true });
  });
  afterAll(async () => {
    await app?.close();
  });
  it.each(['get', 'post', 'patch', 'delete'] as const)(
    'requires authentication for %s',
    async (method) => {
      await request(server)
        [method](
          `/api/v1/tags${method === 'patch' || method === 'delete' ? `/${id}` : ''}`,
        )
        .expect(401);
      for (const operation of Object.values(service))
        expect(operation).not.toHaveBeenCalled();
    },
  );
  it('normalizes display names and derives ownership only from the session', async () => {
    const response = await mutate('post')
      .set('userId', 'foreign')
      .send({ name: '  Ｆｉｎａｎｃｅ ' })
      .expect(201);
    expect(response.body).toEqual({
      data: tag,
      meta: { requestId: response.headers['x-request-id'] as string },
    });
    expect(service.create).toHaveBeenCalledWith(owner, { name: 'Finance' });
  });
  it.each([
    {},
    { name: '' },
    { name: '   ' },
    { name: null },
    { name: 12 },
    { name: ['Finance'] },
    { name: 'a'.repeat(101) },
    { name: 'bad\u0000name' },
    { name: 'Finance', userId: 'foreign' },
    { name: 'Finance', color: '#abcdef' },
  ])('rejects invalid or unsupported creation input %#', async (body) => {
    await mutate('post').send(body).expect(400);
    expect(service.create).not.toHaveBeenCalled();
  });
  it('normalizes search and uses the standard bounded list envelope', async () => {
    const response = await request(server)
      .get('/api/v1/tags')
      .query({ q: '  FINANCE  ', limit: 2, cursor: id, sort: 'id' })
      .set('Cookie', cookie)
      .expect(200);
    expect(response.body).toEqual({
      data: [tag],
      meta: {
        requestId: response.headers['x-request-id'] as string,
        nextCursor: null,
        hasMore: false,
      },
    });
    expect(service.list).toHaveBeenCalledWith(owner, {
      q: 'FINANCE',
      limit: 2,
      cursor: id,
      sort: 'id',
    });
  });
  it.each([
    'limit=0',
    'limit=101',
    'limit=1.5',
    'cursor=invalid',
    'sort=name',
    'q=',
    'q=%20%20',
    'q=a&q=b',
    'q=' + 'a'.repeat(101),
    'userId=foreign',
  ])('rejects invalid list query %s', async (query) => {
    await request(server)
      .get(`/api/v1/tags?${query}`)
      .set('Cookie', cookie)
      .expect(400);
    expect(service.list).not.toHaveBeenCalled();
  });
  it('updates only the name and validates route IDs and partial bodies', async () => {
    await mutate('patch', `/${id}`).send({ name: ' Renamed ' }).expect(200);
    expect(service.update).toHaveBeenCalledWith(owner, id, { name: 'Renamed' });
    for (const body of [
      {},
      { name: null },
      { name: '' },
      { name: 'Renamed', userId: owner },
    ])
      await mutate('patch', `/${id}`).send(body).expect(400);
    await mutate('patch', '/invalid').send({ name: 'Name' }).expect(400);
    await mutate('delete', '/invalid').expect(400);
  });
  it('maps duplicate updates and missing resources to safe envelopes', async () => {
    service.update.mockRejectedValueOnce(new TagConflict());
    const conflict = await mutate('patch', `/${id}`)
      .send({ name: 'Finance' })
      .expect(409);
    expect(conflict.body.error).toMatchObject({
      code: 'CONFLICT',
      message: 'Conflict',
      details: {},
    });
    service.update.mockRejectedValueOnce(new TagNotFound());
    await mutate('patch', `/${id}`).send({ name: 'Finance' }).expect(404);
    service.delete.mockRejectedValueOnce(new TagNotFound());
    await mutate('delete', `/${id}`).expect(404);
  });
  it('acknowledges deletion and rejects body/query owner selectors', async () => {
    expect((await mutate('delete', `/${id}`).expect(200)).body.data).toEqual({
      deleted: true,
    });
    await mutate('delete', `/${id}`).send({ userId: owner }).expect(400);
    await mutate('delete', `/${id}?userId=foreign`).expect(400);
    await request(server)
      .get('/api/v1/tags')
      .set('Cookie', cookie)
      .send({ userId: owner })
      .expect(400);
  });
  it('enforces the shared Origin and CSRF policy on each mutation', async () => {
    for (const method of ['post', 'patch', 'delete'] as const) {
      const path = method === 'post' ? '' : `/${id}`;
      await request(server)
        [method](`/api/v1/tags${path}`)
        .set('Cookie', cookie)
        .send({ name: 'Finance' })
        .expect(403);
      await mutate(method, path)
        .set('Origin', 'https://untrusted.example')
        .send({ name: 'Finance' })
        .expect(403);
    }
    expect(service.create).not.toHaveBeenCalled();
    expect(service.update).not.toHaveBeenCalled();
    expect(service.delete).not.toHaveBeenCalled();
  });
  it('documents authentication, search, pagination, conflict, missing and delete responses', async () => {
    const response = await request(server).get('/api/v1/docs-json').expect(200);
    const paths = response.body.paths as Record<
      string,
      Record<
        string,
        {
          security: unknown;
          parameters: { name: string }[];
          responses: Record<string, unknown>;
        }
      >
    >;
    for (const [path, method] of [
      ['/tags', 'get'],
      ['/tags', 'post'],
      ['/tags/{tagId}', 'patch'],
      ['/tags/{tagId}', 'delete'],
    ])
      expect(paths[`/api/v1${path}`][method].security).toEqual([
        { session: [] },
      ]);
    expect(
      paths['/api/v1/tags'].get.parameters.map((parameter) => parameter.name),
    ).toEqual(expect.arrayContaining(['q', 'limit', 'cursor', 'sort']));
    expect(paths['/api/v1/tags/{tagId}'].patch.responses['409']).toBeDefined();
    expect(paths['/api/v1/tags/{tagId}'].delete.responses['404']).toBeDefined();
    expect(paths['/api/v1/tags/{tagId}'].delete.responses['200']).toBeDefined();
  });
});
