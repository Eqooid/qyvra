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
  CategoriesService,
  CategoryConflict,
  CategoryNotFound,
} from '../src/modules/categories/categories.service';
import { PaginatedData } from '../src/common/paginated-data';
import { databaseStub } from './database.stub';

describe('Categories HTTP contract', () => {
  let app: INestApplication;
  let server: Server;
  const owner = randomUUID();
  const id = randomUUID();
  const cookie = `document_tracker_session=${randomBytes(32).toString('base64url')}`;
  const category = {
    id,
    name: 'Personal Records',
    color: '#abcdef',
    icon: 'folder-open',
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
  const mutation = (method: 'post' | 'patch' | 'delete', path = '') =>
    request(server)
      [method](`/api/v1/categories${path}`)
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
      .overrideProvider(CategoriesService)
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
    service.list.mockResolvedValue(new PaginatedData([category], null, false));
    service.create.mockResolvedValue(category);
    service.update.mockResolvedValue(category);
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
          `/api/v1/categories${method === 'patch' || method === 'delete' ? `/${id}` : ''}`,
        )
        .expect(401);
      for (const operation of Object.values(service))
        expect(operation).not.toHaveBeenCalled();
    },
  );
  it('normalizes names, accepts safe optional styling and uses trusted ownership', async () => {
    const response = await mutation('post')
      .set('userId', 'foreign')
      .send({
        name: '  Personal   Records  ',
        color: '#ABCDEF',
        icon: 'folder-open',
      })
      .expect(201);
    expect(response.body).toEqual({
      data: category,
      meta: { requestId: response.headers['x-request-id'] as string },
    });
    expect(service.create).toHaveBeenCalledWith(owner, {
      name: 'Personal Records',
      color: '#abcdef',
      icon: 'folder-open',
    });
  });
  it('returns the standard paginated envelope with defaults', async () => {
    const response = await request(server)
      .get('/api/v1/categories')
      .set('Cookie', cookie)
      .expect(200);
    expect(response.body).toEqual({
      data: [category],
      meta: {
        requestId: response.headers['x-request-id'] as string,
        nextCursor: null,
        hasMore: false,
      },
    });
    expect(service.list).toHaveBeenCalledWith(owner, { limit: 25, sort: 'id' });
  });
  it('rejects unsupported GET body properties instead of silently accepting an owner selector', async () => {
    await request(server)
      .get('/api/v1/categories')
      .set('Cookie', cookie)
      .send({ userId: 'foreign' })
      .expect(400);
    expect(service.list).not.toHaveBeenCalled();
  });
  it.each([
    {},
    { name: '' },
    { name: '  ' },
    { name: null },
    { name: 12 },
    { name: 'a'.repeat(101) },
    { name: 'bad\u0000name' },
    { name: 'ok', color: '#fff' },
    { name: 'ok', color: 'red' },
    { name: 'ok', color: 12 },
    { name: 'ok', icon: '<svg>' },
    { name: 'ok', icon: '../folder' },
    { name: 'ok', icon: 'a'.repeat(51) },
    { name: 'ok', userId: 'foreign' },
  ])('rejects invalid or unsupported creation input %#', async (body) => {
    const response = await mutation('post').send(body).expect(400);
    expect(response.body.error).toMatchObject({
      code: 'BAD_REQUEST',
      details: {},
    });
    expect(service.create).not.toHaveBeenCalled();
  });
  it.each([
    'limit=0',
    'limit=101',
    'limit=1.5',
    'limit=',
    'cursor=invalid',
    'sort=name',
    'userId=foreign',
    'limit=1&limit=2',
  ])('rejects unsupported list query %s', async (query) => {
    await request(server)
      .get(`/api/v1/categories?${query}`)
      .set('Cookie', cookie)
      .expect(400);
    expect(service.list).not.toHaveBeenCalled();
  });
  it('validates updates, supports clearing styling and preserves partial changes', async () => {
    await mutation('patch', `/${id}`)
      .send({ color: null, icon: null })
      .expect(200);
    expect(service.update).toHaveBeenCalledWith(owner, id, {
      color: null,
      icon: null,
    });
    for (const body of [
      {},
      { name: null },
      { name: '' },
      { userId: owner },
      { deletedAt: new Date().toISOString() },
    ])
      await mutation('patch', `/${id}`).send(body).expect(400);
    await mutation('patch', '/invalid').send({ name: 'Name' }).expect(400);
  });
  it('maps duplicates and foreign/missing IDs to generic envelopes', async () => {
    service.create.mockRejectedValueOnce(new CategoryConflict());
    const duplicate = await mutation('post').send({ name: 'Name' }).expect(409);
    expect(duplicate.body.error).toMatchObject({
      code: 'CONFLICT',
      message: 'Conflict',
      details: {},
    });
    service.update.mockRejectedValueOnce(new CategoryNotFound());
    await mutation('patch', `/${id}`).send({ name: 'Name' }).expect(404);
    service.delete.mockRejectedValueOnce(new CategoryNotFound());
    await mutation('delete', `/${id}`).expect(404);
  });
  it('returns a deletion acknowledgement and rejects body/query properties', async () => {
    expect((await mutation('delete', `/${id}`).expect(200)).body.data).toEqual({
      deleted: true,
    });
    await mutation('delete', `/${id}`).send({ userId: owner }).expect(400);
    await mutation('delete', `/${id}?userId=foreign`).expect(400);
  });
  it('enforces Origin and CSRF protection on every mutation', async () => {
    for (const method of ['post', 'patch', 'delete'] as const) {
      const path = method === 'post' ? '' : `/${id}`;
      await request(server)
        [method](`/api/v1/categories${path}`)
        .set('Cookie', cookie)
        .send({ name: 'Name' })
        .expect(403);
      await mutation(method, path)
        .set('Origin', 'https://untrusted.example')
        .send({ name: 'Name' })
        .expect(403);
    }
    expect(service.create).not.toHaveBeenCalled();
    expect(service.update).not.toHaveBeenCalled();
    expect(service.delete).not.toHaveBeenCalled();
  });
  it('documents cookie authentication, pagination and mutation responses', async () => {
    const response = await request(server).get('/api/v1/docs-json').expect(200);
    const document = response.body as {
      paths: Record<
        string,
        Record<
          string,
          { security: unknown; responses: Record<string, unknown> }
        >
      >;
    };
    for (const [path, method] of [
      ['/categories', 'get'],
      ['/categories', 'post'],
      ['/categories/{categoryId}', 'patch'],
      ['/categories/{categoryId}', 'delete'],
    ]) {
      expect(document.paths[`/api/v1${path}`][method].security).toEqual([
        { session: [] },
      ]);
      expect(
        document.paths[`/api/v1${path}`][method].responses['401'],
      ).toBeDefined();
    }
  });
});
