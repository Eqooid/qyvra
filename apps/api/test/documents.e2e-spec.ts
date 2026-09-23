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
import { DocumentsService } from '../src/modules/documents/documents.service';
import {
  DocumentNotFound,
  DocumentStateConflict,
  InvalidDocumentMetadata,
} from '../src/modules/documents/document-lifecycle';
import { PaginatedData } from '../src/common/paginated-data';
import { databaseStub } from './database.stub';

describe('Document metadata HTTP contract', () => {
  let app: INestApplication;
  let server: Server;
  const owner = randomUUID();
  const id = randomUUID();
  const cookie = `document_tracker_session=${randomBytes(32).toString('base64url')}`;
  const document = {
    id,
    title: 'Fixture',
    status: 'UPLOADED',
    category: null,
    tags: [],
  };
  const service = {
    list: jest.fn(),
    detail: jest.fn(),
    update: jest.fn(),
    transition: jest.fn(),
  };
  const authSession = { findUnique: jest.fn(), updateMany: jest.fn() };
  const routes = [
    ['get', ''],
    ['get', `/${id}`],
    ['patch', `/${id}`],
    ['post', `/${id}/archive`],
    ['post', `/${id}/restore`],
    ['delete', `/${id}`],
  ] as const;
  const mutate = (method: 'patch' | 'post' | 'delete', path = `/${id}`) =>
    request(server)
      [method](`/api/v1/documents${path}`)
      .set('Cookie', cookie)
      .set('X-CSRF-Protection', '1');
  beforeAll(async () => {
    const config = validateEnvironment({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://localhost/test',
      CORS_ORIGINS: 'https://frontend.example',
    });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(settings.KEY)
      .useValue(config)
      .overrideProvider(PRISMA_CLIENT)
      .useValue({ ...databaseStub(), authSession })
      .overrideProvider(DocumentsService)
      .useValue(service)
      .overrideProvider(LOG_SINK)
      .useValue(() => undefined)
      .compile();
    app = module.createNestApplication();
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
    service.list.mockResolvedValue(new PaginatedData([document], null, false));
    service.detail.mockResolvedValue(document);
    service.update.mockResolvedValue(document);
    service.transition.mockResolvedValue(document);
  });
  afterAll(async () => {
    await app?.close();
  });
  it.each(routes)('requires authentication for %s %s', async (method, path) => {
    await request(server)[method](`/api/v1/documents${path}`).expect(401);
    for (const operation of Object.values(service))
      expect(operation).not.toHaveBeenCalled();
  });
  it('derives ownership from the session and normalizes only allowed metadata', async () => {
    const tag = randomUUID();
    const response = await mutate('patch')
      .set('userId', randomUUID())
      .send({
        title: '  Updated  ',
        issuer: null,
        tagIds: [tag, tag.toUpperCase()],
      })
      .expect(200);
    expect(service.update).toHaveBeenCalledWith(owner, id, {
      title: 'Updated',
      issuer: null,
      tagIds: [tag],
    });
    expect(response.body).toEqual({
      data: document,
      meta: { requestId: response.headers['x-request-id'] as string },
    });
  });
  it.each([
    {},
    { title: null },
    { title: ' ' },
    { title: 'a'.repeat(301) },
    { title: 123 },
    { title: 'bad\u0000name' },
    { issuer: ' ' },
    { issuer: 'a'.repeat(201) },
    { referenceNumber: 123 },
    { documentType: 'arbitrary.field' },
    { documentType: null },
    { documentDate: '2026-02-30' },
    { documentDate: '0000-01-01' },
    { expirationDate: '2026-01-01T00:00:00Z' },
    { categoryId: 'invalid' },
    { tagIds: null },
    { tagIds: 'invalid' },
    { tagIds: ['invalid'] },
    { tagIds: Array.from({ length: 101 }, () => randomUUID()) },
    { title: 'X', userId: randomUUID() },
    { status: 'READY' },
    { isArchived: true },
    { deletedAt: null },
    { verifiedSummary: 'fake' },
    { storageKey: 'private' },
    { version: 1 },
  ])('rejects invalid or unsupported update %#', async (body) => {
    await mutate('patch').send(body).expect(400);
    expect(service.update).not.toHaveBeenCalled();
  });
  it.each([
    'limit=0',
    'limit=101',
    'limit=1.5',
    'sort=title',
    'sort=__proto__',
    'cursor=!',
    'q=%20',
    'q=a&q=b',
    'archived=1',
    'status=UNKNOWN',
    'documentType=bad',
    'categoryId=bad',
    'tagId=bad',
    'dateFrom=2026-02-30',
    'expirationTo=2026-13-01',
    'userId=foreign',
  ])('rejects invalid list query %s', async (query) => {
    await request(server)
      .get(`/api/v1/documents?${query}`)
      .set('Cookie', cookie)
      .expect(400);
    expect(service.list).not.toHaveBeenCalled();
  });
  it('transforms bounded pagination and archive filters and wraps the page', async () => {
    const response = await request(server)
      .get('/api/v1/documents')
      .set('Cookie', cookie)
      .query({ limit: 2, archived: false })
      .expect(200);
    expect(service.list).toHaveBeenCalledWith(owner, {
      limit: 2,
      sort: '-createdAt',
      archived: false,
    });
    expect(response.body.meta).toMatchObject({
      nextCursor: null,
      hasMore: false,
    });
    expect(response.body.data).toEqual([document]);
  });
  it('rejects route, query and body selectors, and protects mutations from CSRF', async () => {
    for (const [method, path] of routes) {
      if (path)
        await request(server)
          [method](`/api/v1/documents${path.replace(id, 'invalid')}`)
          .set('Cookie', cookie)
          .set('X-CSRF-Protection', '1')
          .send(method === 'patch' ? { title: 'X' } : {})
          .expect(400);
      if (method !== 'get') {
        await request(server)
          [method](`/api/v1/documents${path}`)
          .set('Cookie', cookie)
          .expect(403);
        await mutate(method, path)
          .set('Origin', 'https://untrusted.example')
          .expect(403);
        await mutate(method, `${path}?userId=foreign`).send({}).expect(400);
        if (method !== 'patch')
          await mutate(method, path).send({ userId: owner }).expect(400);
      }
    }
    await request(server)
      .get(`/api/v1/documents/${id}?userId=foreign`)
      .set('Cookie', cookie)
      .expect(400);
    await request(server)
      .get('/api/v1/documents')
      .set('Cookie', cookie)
      .send({ userId: owner })
      .expect(400);
  });
  it('maps domain errors without exposing private infrastructure details', async () => {
    service.detail.mockRejectedValueOnce(new DocumentNotFound());
    expect(
      (
        await request(server)
          .get(`/api/v1/documents/${id}`)
          .set('Cookie', cookie)
          .expect(404)
      ).body.error,
    ).toMatchObject({ code: 'NOT_FOUND', details: {} });
    service.transition.mockRejectedValueOnce(new DocumentStateConflict());
    await mutate('post', `/${id}/archive`).expect(409);
    service.update.mockRejectedValueOnce(new InvalidDocumentMetadata());
    await mutate('patch').send({ title: 'X' }).expect(400);
    service.update.mockRejectedValueOnce(
      new Error('private database connection'),
    );
    const result = await mutate('patch').send({ title: 'X' }).expect(500);
    expect(JSON.stringify(result.body)).not.toContain('private database');
  });
  it('documents only implemented routes with cookie authentication and filter parameters', async () => {
    await mutate('post', '').send({ title: 'X' }).expect(400);
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
    expect(paths['/api/v1/documents'].post).toBeDefined();
    for (const [method, path] of routes) {
      const route =
        paths[`/api/v1/documents${path.replace(id, '{documentId}')}`][method];
      expect(route.security).toEqual([{ session: [] }]);
      expect(route.responses['200']).toBeDefined();
      expect(route.responses['401']).toBeDefined();
    }
    expect(
      paths['/api/v1/documents'].get.parameters.map(
        (parameter) => parameter.name,
      ),
    ).toEqual(
      expect.arrayContaining([
        'q',
        'sort',
        'limit',
        'cursor',
        'status',
        'documentType',
        'categoryId',
        'tagId',
        'archived',
        'dateFrom',
        'dateTo',
        'expirationFrom',
        'expirationTo',
      ]),
    );
    expect(paths['/api/v1/documents/{documentId}/download']).toBeDefined();
    expect(paths['/api/v1/documents/{documentId}/versions']).toBeDefined();
  });
});
