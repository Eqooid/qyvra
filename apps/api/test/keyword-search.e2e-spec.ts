import { KeywordSearchService } from '../src/modules/search/keyword-search.service';
import { LexicalSourceService } from '../src/modules/documents/lexical-source.service';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomBytes, randomUUID } from 'node:crypto';
import { Server } from 'node:http';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/configure-application';
import { settings } from '../src/configuration/configuration.module';
import { PRISMA_CLIENT } from '../src/database/prisma.service';
import { LOG_SINK } from '../src/common/structured-logger';
import { HybridSearchService } from '../src/modules/search/hybrid-search.service';
import { validateTestEnvironment } from './configuration.fixture';
import { databaseStub } from './database.stub';

describe('keyword HTTP authentication/DTO/OpenAPI boundary (SQL/search doubles)', () => {
  let app: INestApplication, server: Server;
  const owner = randomUUID(),
    cookie = `document_tracker_session=${randomBytes(32).toString('base64url')}`;
  const session = { findUnique: jest.fn(), updateMany: jest.fn() },
    service = { keywordSearch: jest.fn(), hybridSearch: jest.fn() };
  const suggestions = { suggestions: jest.fn() },
    sources = { resolve: jest.fn() };
  const version = randomUUID(),
    artifact = randomUUID();
  const sourcePath = `/api/v1/documents/${owner}/versions/${version}/extractions/${artifact}/pages/1/segments/0`;
  const begin = () =>
    request(server)
      .post('/api/v1/search/keyword')
      .set('Cookie', cookie)
      .set('X-CSRF-Protection', '1');
  beforeAll(async () => {
    const config = validateTestEnvironment({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://localhost/search_test',
      CORS_ORIGINS: 'https://frontend.example',
    });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(settings.KEY)
      .useValue(config)
      .overrideProvider(PRISMA_CLIENT)
      .useValue({ ...databaseStub(), authSession: session })
      .overrideProvider(HybridSearchService)
      .useValue(service)
      .overrideProvider(KeywordSearchService)
      .useValue(suggestions)
      .overrideProvider(LexicalSourceService)
      .useValue(sources)
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
    session.findUnique.mockResolvedValue({
      id: randomUUID(),
      expiresAt: new Date(Date.now() + 60000),
      revokedAt: null,
      lastSeenAt: new Date(),
      user: {
        id: owner,
        email: 'fixture@example.invalid',
        displayName: null,
        locale: 'en',
        timezone: 'UTC',
        deletedAt: null,
      },
    });
    service.keywordSearch.mockResolvedValue({
      results: [],
      coverage: {
        eligibleDocuments: 0,
        metadataReadyDocuments: 0,
        textReadyDocuments: 0,
      },
      pagination: {
        hasMore: false,
        nextCursor: null,
        paginationAvailable: false,
        truncated: false,
      },
    });
  });
  afterAll(async () => {
    await app.close();
  });
  it('requires a session and the existing CSRF/origin boundary', async () => {
    await request(server)
      .post('/api/v1/search/keyword')
      .send({ query: 'hello' })
      .expect(401);
    await request(server)
      .post('/api/v1/search/keyword')
      .set('Cookie', cookie)
      .send({ query: 'hello' })
      .expect(403);
    await begin()
      .set('Origin', 'https://foreign.example')
      .send({ query: 'hello' })
      .expect(403);
    expect(service.keywordSearch).not.toHaveBeenCalled();
  });
  it.each([
    { query: '' },
    { query: 'x'.repeat(4001) },
    { query: 'broken\ud800' },
    { query: 'hello', userId: owner },
    { query: 'hello', tenantId: owner },
    { query: 'hello', index: 'foreign' },
    { query: 'hello', dsl: { match_all: {} } },
    { query: 'hello', filters: { archived: true } },
    { query: 'hello', filters: { tagIds: ['bad'] } },
    { query: 'hello', filters: null },
    { query: 'hello', sort: 'title' },
    { query: 'hello', limit: 21 },
  ])('rejects malformed or unsupported body %j', async (body) => {
    await begin().send(body).expect(400);
    expect(service.keywordSearch).not.toHaveBeenCalled();
  });
  it('derives ownership from the guard, normalizes inputs and uses a no-store typed envelope', async () => {
    const result = await begin()
      .send({
        query: '  hello ',
        match: 'phrase',
        filters: { tagIds: [owner.toUpperCase()], mimeType: 'application/pdf' },
      })
      .expect(200);
    expect(service.keywordSearch).toHaveBeenCalledWith(
      owner,
      expect.any(String),
      expect.objectContaining({
        query: 'hello',
        match: 'phrase',
        filters: expect.objectContaining({ tagIds: [owner] }),
      }),
    );
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.body.data.results).toEqual([]);
    expect(result.body.meta.requestId).toEqual(expect.any(String));
  });
  it('secures the additive hybrid route and derives its session binding from authentication', async () => {
    await request(server)
      .post('/api/v1/search/hybrid')
      .send({ query: 'hello' })
      .expect(401);
    service.hybridSearch.mockResolvedValue({
      mode: 'hybrid',
      results: [],
      coverage: {
        eligibleDocuments: 0,
        metadataReadyDocuments: 0,
        textReadyDocuments: 0,
      },
      pagination: {
        hasMore: false,
        nextCursor: null,
        paginationAvailable: true,
        truncated: false,
      },
    });
    await request(server)
      .post('/api/v1/search/hybrid')
      .set('Cookie', cookie)
      .set('X-CSRF-Protection', '1')
      .send({ query: 'hello' })
      .expect(200);
    expect(service.hybridSearch).toHaveBeenCalledWith(
      owner,
      expect.any(String),
      expect.objectContaining({ query: 'hello' }),
    );
    await request(server)
      .post('/api/v1/search/hybrid')
      .set('Cookie', cookie)
      .set('X-CSRF-Protection', '1')
      .send({ query: 'hello', mode: 'semantic' })
      .expect(400);
  });
  it('requires session/CSRF for private suggestions and rejects unknown filter/DSL fields', async () => {
    await request(server)
      .post('/api/v1/search/suggestions')
      .send({ prefix: 'he' })
      .expect(401);
    await request(server)
      .post('/api/v1/search/suggestions')
      .set('Cookie', cookie)
      .send({ prefix: 'he' })
      .expect(403);
    for (const body of [
      { prefix: 'x' },
      { prefix: 'x'.repeat(201) },
      { prefix: 'he', limit: 11 },
      { prefix: 'he', userId: owner },
      { prefix: 'he', query: 'dsl' },
      { prefix: 'he', filters: { archived: true } },
    ]) {
      await request(server)
        .post('/api/v1/search/suggestions')
        .set('Cookie', cookie)
        .set('X-CSRF-Protection', '1')
        .send(body)
        .expect(400);
    }
    expect(suggestions.suggestions).not.toHaveBeenCalled();
    suggestions.suggestions.mockResolvedValue({ suggestions: [] });
    await request(server)
      .post('/api/v1/search/suggestions')
      .set('Cookie', cookie)
      .set('X-CSRF-Protection', '1')
      .send({ prefix: '  hello  ', limit: 5 })
      .expect(200);
    expect(suggestions.suggestions).toHaveBeenCalledWith(
      owner,
      expect.objectContaining({ prefix: 'hello', limit: 5 }),
    );
  });
  it('guards exact page reads and rejects invalid integers, UUIDs, bodies and query fields', async () => {
    await request(server).get(sourcePath).expect(401);
    sources.resolve.mockResolvedValue({
      documentId: owner,
      documentVersionId: version,
      extractedTextId: artifact,
      pageNumber: 1,
      segment: 0,
      excerpt: '<script>alert(1)</script>',
    });
    const r = await request(server)
      .get(sourcePath)
      .set('Cookie', cookie)
      .expect(200);
    expect(r.headers['content-type']).toContain('application/json');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body.data.excerpt).toBe('<script>alert(1)</script>');
    expect(sources.resolve).toHaveBeenCalledWith(
      owner,
      owner,
      version,
      artifact,
      1,
      0,
    );
    for (const path of [
      sourcePath + '?raw=true',
      sourcePath.replace('/pages/1/', '/pages/0/'),
      sourcePath.replace('/segments/0', '/segments/1e2'),
      sourcePath.replace(artifact, 'not-a-uuid'),
    ])
      await request(server).get(path).set('Cookie', cookie).expect(400);
    await request(server)
      .get(sourcePath)
      .set('Cookie', cookie)
      .send({ raw: true })
      .expect(400);
  });
  it('documents the implemented keyword route and bounded response without exposing indexes', async () => {
    const result = await request(server).get('/api/v1/docs-json').expect(200);
    const operation = result.body.paths['/api/v1/search/keyword'].post;
    expect(
      operation.responses['200'].content['application/json'].schema.properties
        .data.$ref,
    ).toContain('KeywordSearchResponseDto');
    expect(operation.responses['409']).toBeDefined();
    expect(operation.security).toEqual([{ session: [] }]);
    const response = result.body.components.schemas.KeywordResultDto;
    expect(response.properties.storageKey).toBeUndefined();
    expect(response.properties.userId).toBeUndefined();
    expect(response.properties.score).toBeUndefined();
    expect(response.properties.rank).toBeDefined();
    expect(result.body.paths['/api/v1/search/hybrid'].post).toBeDefined();
    expect(
      result.body.paths['/api/v1/search/suggestions'].post.security,
    ).toEqual([{ session: [] }]);
    expect(
      result.body.components.schemas.KeywordMatchDto.properties.ranges,
    ).toBeDefined();
    expect(
      result.body.components.schemas.LexicalPageSourceDto.properties
        .excerptHash,
    ).toBeDefined();
  });
});
