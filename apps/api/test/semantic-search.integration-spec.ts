import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { QdrantClient } from '@qdrant/js-client-rest';
import {
  createPrismaClient,
  embeddingProfileFingerprint,
  ProcessingRepository,
  type PrismaClient,
  type ProcessingMessage,
} from '@qyvra/database';
import { LocalFileStorage } from '@qyvra/storage';
import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/configure-application';
import { settings } from '../src/configuration/configuration.module';
import { validateEnvironment } from '../src/configuration/environment';
import { PrismaService } from '../src/database/prisma.service';
import { LOG_SINK } from '../src/common/structured-logger';
import { createTestOwner, TestOwner } from './owner.fixture';
import {
  QUERY_EMBEDDINGS,
  SEMANTIC_VECTORS,
} from '../src/modules/search/semantic-search.service';
import { SemanticSearchRepository } from '../src/modules/search/semantic-search.repository';
import {
  EmbeddingFailure,
  type EmbeddingRequest,
} from '../src/modules/ai/embedding-provider';
import { DeterministicChunker } from '../src/modules/ai/deterministic-chunker';
import { IsolatedPdfParser } from '../src/infrastructure/extraction/pdf-parser';
import { StoredFileIntegrityHandler } from '../src/infrastructure/worker/stored-file-integrity.handler';
import { PdfTextExtractionHandler } from '../src/infrastructure/worker/pdf-text-extraction.handler';
import { ChunkGenerationHandler } from '../src/infrastructure/worker/chunk-generation.handler';
import { EmbeddingGenerationHandler } from '../src/infrastructure/worker/embedding-generation.handler';
import { VectorIndexHandler } from '../src/infrastructure/worker/vector-index.handler';
import { VectorRemovalHandler } from '../src/infrastructure/worker/vector-removal.handler';
import { ProcessingMessageHandler } from '../src/infrastructure/worker/processing-message-handler';
import { QdrantVectorStore } from '../src/infrastructure/vectors/qdrant-vector-store';
import {
  vectorCollectionName,
  vectorPointId,
} from '../src/modules/ai/vector-store';

const databaseUrl = process.env.TEST_DATABASE_URL,
  qdrantUrl = process.env.TEST_QDRANT_URL;
jest.setTimeout(60000);
(databaseUrl && qdrantUrl ? describe : describe.skip)(
  'authorized semantic HTTP retrieval (real PostgreSQL/Qdrant/PDF pipeline)',
  () => {
    let app: INestApplication,
      db: PrismaClient,
      root: string,
      worker: ProcessingMessageHandler;
    let a: TestOwner,
      b: TestOwner,
      docA: string,
      docB: string,
      versionA: string,
      profileId: string;
    const users: string[] = [],
      logs: string[] = [];
    const provider = {
      embed: jest.fn(async (r: EmbeddingRequest) =>
        r.inputs.map((input) => ({ id: input.id, vector: [1, 2, 3] })),
      ),
    };
    const query = (user = a, body: object = { query: 'Hello world' }) =>
      request(app.getHttpServer())
        .post('/api/v1/search/semantic')
        .set('Cookie', user.cookie)
        .set('X-CSRF-Protection', '1')
        .send(body);
    const transition = (action: 'archive' | 'restore') =>
      request(app.getHttpServer())
        .post(`/api/v1/documents/${docA}/${action}`)
        .set('Cookie', a.cookie)
        .set('X-CSRF-Protection', '1')
        .send({});
    async function drain(version: string) {
      for (let step = 0; step < 12; step++) {
        const job = await db.processingJob.findFirst({
          where: {
            documentVersionId: version,
            status: { in: ['PENDING', 'QUEUED'] },
          },
          orderBy: { createdAt: 'asc' },
        });
        if (!job) return;
        const event = await db.processingOutbox.findFirstOrThrow({
          where: { processingJobId: job.id },
          orderBy: { dispatchSequence: 'desc' },
        });
        expect(
          await worker.handle(
            event.payload as unknown as ProcessingMessage,
            false,
          ),
        ).toBe('ack');
        expect(
          (await db.processingJob.findUniqueOrThrow({ where: { id: job.id } }))
            .status,
        ).toBe('COMPLETED');
      }
      throw Error('Pipeline did not drain');
    }
    beforeAll(async () => {
      if (!databaseUrl || !/test/i.test(new URL(databaseUrl).pathname))
        throw Error('Disposable database required');
      root = await mkdtemp(join(tmpdir(), 'qyvra-t09-'));
      db = createPrismaClient({
        url: databaseUrl,
        connectTimeoutMs: 2000,
        queryTimeoutMs: 10000,
        poolSize: 5,
      });
      await db.$connect();
      const identity = {
        provider: 'openai-compatible',
        model: randomUUID(),
        modelRevision: 'v1',
        dimensions: 3,
        distance: 'Cosine' as const,
        profileVersion: 1,
        normalizationVersion: 'qyvra-embedding-input/v1',
        tokenizer: 'cl100k_base',
        tokenizerVersion: 'tiktoken-1.0.22',
        documentInstruction: '',
        queryInstruction: '',
      };
      const profile = await db.embeddingProfile.create({
        data: {
          ...identity,
          fingerprint: embeddingProfileFingerprint(identity),
        },
      });
      profileId = profile.id;
      await db.aiServingProfile.create({
        data: { id: 1, embeddingProfileId: profile.id },
      });
      const config = validateEnvironment({
        NODE_ENV: 'test',
        DATABASE_URL: databaseUrl,
        LOCAL_STORAGE_ROOT: root,
        DATABASE_QUERY_TIMEOUT_MS: '1000',
        AI_INGESTION_ENABLED: 'true',
        AI_INGESTION_PROFILE_FINGERPRINT: profile.fingerprint,
        EMBEDDING_ENABLED: 'true',
        EMBEDDING_PROFILE_FINGERPRINT: profile.fingerprint,
        EMBEDDING_ENDPOINT: 'https://provider.example.invalid/embeddings',
        VECTOR_INDEX_ENABLED: 'true',
        QDRANT_URL: qdrantUrl,
        SEMANTIC_SEARCH_ENABLED: 'true',
        CHUNK_SIZE_TOKENS: '32',
        CHUNK_OVERLAP_TOKENS: '8',
        CORS_ORIGINS: 'https://frontend.example',
      });
      const module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(settings.KEY)
        .useValue(config)
        .overrideProvider(QUERY_EMBEDDINGS)
        .useValue(provider)
        .overrideProvider(LOG_SINK)
        .useValue((line: string) => logs.push(line))
        .compile();
      app = module.createNestApplication();
      configureApplication(app, config);
      await app.init();
      const prisma = app.get(PrismaService);
      a = await createTestOwner(prisma, users);
      b = await createTestOwner(prisma, users);
      const storage = new LocalFileStorage(root),
        vector = new QdrantVectorStore(config.vectorIndex);
      worker = new ProcessingMessageHandler(new ProcessingRepository(db), [
        new StoredFileIntegrityHandler(db, storage, 10000),
        new PdfTextExtractionHandler(
          db,
          storage,
          new IsolatedPdfParser(config.extraction),
          config.extraction,
        ),
        new ChunkGenerationHandler(
          db,
          new DeterministicChunker(),
          config.chunking,
        ),
        new EmbeddingGenerationHandler(db, provider, config.embedding),
        new VectorIndexHandler(db, vector, config.vectorIndex),
        new VectorRemovalHandler(db, vector),
      ]);
      const bytes = await readFile(
        resolve(__dirname, 'fixtures/pdf/single.pdf'),
      );
      for (const owner of [a, b]) {
        const uploaded = await request(app.getHttpServer())
          .post('/api/v1/documents')
          .set('Cookie', owner.cookie)
          .set('X-CSRF-Protection', '1')
          .set('Idempotency-Key', randomUUID())
          .field('title', owner === a ? 'A private title' : 'B secret title')
          .attach('file', bytes, {
            filename: owner === a ? 'a.pdf' : 'b-secret.pdf',
            contentType: 'application/pdf',
          })
          .expect(201);
        const id = uploaded.body.data.id as string;
        const version = await db.documentVersion.findFirstOrThrow({
          where: { documentId: id },
        });
        if (owner === a) {
          docA = id;
          versionA = version.id;
        } else docB = id;
        await drain(version.id);
        expect(
          await db.versionReadyIndex.count({
            where: { documentVersionId: version.id },
          }),
        ).toBe(1);
      }
    });
    afterAll(async () => {
      if (db) {
        await db.aiServingProfile.deleteMany({
          where: { embeddingProfileId: profileId },
        });
        await db.document.deleteMany({ where: { userId: { in: users } } });
        await db.documentUpload.deleteMany({
          where: { userId: { in: users } },
        });
        await db.authSession.deleteMany({ where: { userId: { in: users } } });
        await db.user.deleteMany({ where: { id: { in: users } } });
        if (profileId)
          await db.embeddingProfile.delete({ where: { id: profileId } });
        await db.$disconnect();
      }
      if (app) await app.close();
      if (root) await rm(root, { recursive: true, force: true });
    });
    (process.env.TEST_CONTAINER_IMAGE ? it : it.skip)(
      'serves authorized queries through native provider and Qdrant adapters in the final runtime image',
      async () => {
        const run = promisify(execFile),
          name = `qyvra-t09-search-${randomUUID().slice(0, 8)}`;
        const serving = await db.embeddingProfile.findUniqueOrThrow({
          where: { id: profileId },
        });
        const remote = createServer(async (req, res) => {
          const pieces: Buffer[] = [];
          for await (const part of req) pieces.push(Buffer.from(part));
          const body = JSON.parse(Buffer.concat(pieces).toString()) as {
            model: string;
            input: string[];
          };
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              model: body.model,
              data: body.input.map((_text, index) => ({
                index,
                embedding: [1, 2, 3],
              })),
            }),
          );
        });
        await new Promise<void>((resolve) =>
          remote.listen(0, '127.0.0.1', resolve),
        );
        const address = remote.address();
        if (!address || typeof address === 'string')
          throw Error('Provider fixture did not listen');
        const apiUrl = 'http://127.0.0.1:3019';
        const env = {
          NODE_ENV: 'test',
          HTTP_HOST: '0.0.0.0',
          PORT: '3001',
          LOCAL_STORAGE_ROOT: '/data/qyvra',
          DATABASE_URL: databaseUrl!.replace(
            '127.0.0.1',
            'host.docker.internal',
          ),
          DATABASE_QUERY_TIMEOUT_MS: '1000',
          SEMANTIC_SEARCH_ENABLED: 'true',
          EMBEDDING_ENABLED: 'true',
          EMBEDDING_ALLOW_HTTP: 'true',
          EMBEDDING_ENDPOINT: `http://host.docker.internal:${address.port}/embeddings`,
          EMBEDDING_PROFILE_FINGERPRINT: serving.fingerprint,
          VECTOR_INDEX_ENABLED: 'true',
          QDRANT_URL: qdrantUrl!.replace('127.0.0.1', 'host.docker.internal'),
        };
        try {
          await run(
            'docker',
            [
              'run',
              '-d',
              '--name',
              name,
              '-p',
              '127.0.0.1:3019:3001',
              ...Object.entries(env).flatMap(([key, value]) => [
                '-e',
                `${key}=${value}`,
              ]),
              process.env.TEST_CONTAINER_IMAGE!,
              'node',
              'dist/main.js',
            ],
            { timeout: 15000 },
          );
          let healthy = false;
          for (let attempt = 0; attempt < 100; attempt++) {
            try {
              healthy = (await fetch(`${apiUrl}/api/v1/health/ready`)).ok;
            } catch {
              healthy = false;
            }
            if (healthy) break;
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
          expect(healthy).toBe(true);
          const response = await fetch(`${apiUrl}/api/v1/search/semantic`, {
            method: 'POST',
            headers: {
              Cookie: a.cookie,
              'X-CSRF-Protection': '1',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ query: 'Hello world' }),
          });
          expect(response.status).toBe(200);
          const json = (await response.json()) as {
            data: { results: { documentId: string; excerpt: string }[] };
          };
          expect(json.data.results.length).toBeGreaterThan(0);
          expect(json.data.results.every((r) => r.documentId === docA)).toBe(
            true,
          );
          const spec = await fetch(`${apiUrl}/api/v1/docs-json`);
          expect(spec.status).toBe(200);
          const openApi = (await spec.json()) as {
            paths: Record<string, unknown>;
          };
          expect(openApi.paths['/api/v1/search/semantic']).toBeDefined();
          const captured = (
            await run('docker', ['logs', name], { timeout: 5000 })
          ).stdout;
          expect(captured).not.toContain('Hello world');
        } finally {
          await run('docker', ['rm', '-f', name], { timeout: 10000 });
          await new Promise<void>((resolve, reject) =>
            remote.close((error) => (error ? reject(error) : resolve())),
          );
        }
      },
    );
    it('returns only A canonical content/provenance despite equal A/B vectors', async () => {
      const specification = await request(app.getHttpServer())
        .get('/api/v1/docs-json')
        .expect(200);
      expect(
        specification.body.paths['/api/v1/search/semantic'].post.responses[
          '200'
        ].content['application/json'].schema.properties.data.properties.results
          .maxItems,
      ).toBe(20);
      const response = await query().expect(200);
      const results = response.body.data.results;
      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(r).toMatchObject({
          documentId: docA,
          documentVersionId: versionA,
          title: 'A private title',
          originalFilename: 'a.pdf',
          embeddingProfileId: profileId,
        });
        const canonical = await db.documentChunk.findUniqueOrThrow({
          where: { id: r.chunkId },
        });
        expect(r.excerpt).toBe(canonical.text);
        expect(r.pageSpans).toEqual(canonical.pageSpans);
        expect(r.startOffset).toBe(canonical.startOffset);
        expect(r.endOffset).toBe(canonical.endOffset);
      }
      expect(JSON.stringify(response.body)).not.toMatch(
        /B secret title|b-secret.pdf|storageKey|vector|userId/,
      );
      const ownB = await query(b).expect(200);
      expect(
        ownB.body.data.results.every(
          (r: { documentId: string }) => r.documentId === docB,
        ),
      ).toBe(true);
    });
    it('rejects unauthenticated, CSRF, origin, arbitrary authority and invalid inputs before external work', async () => {
      const count = provider.embed.mock.calls.length;
      await request(app.getHttpServer())
        .post('/api/v1/search/semantic')
        .send({ query: 'hello' })
        .expect(401);
      await request(app.getHttpServer())
        .post('/api/v1/search/semantic')
        .set('Cookie', a.cookie)
        .send({ query: 'hello' })
        .expect(403);
      await query().set('Origin', 'https://evil.example').expect(403);
      for (const body of [
        { query: '  ' },
        { query: 'x'.repeat(4001) },
        { query: 'hello', limit: 21 },
        { query: 'hello', limit: '8' },
        { query: 'hello', userId: b.id },
        { query: 'hello', vector: [1, 2, 3] },
        { query: 'hello', documentIds: [docA, docA] },
        { query: 'hello', documentIds: [randomUUID()] },
      ]) {
        await query(a, body).expect(
          'documentIds' in body && body.documentIds?.length === 1 ? 404 : 400,
        );
      }
      await query(a, { query: 'hello', documentIds: [docB] }).expect(404);
      expect(provider.embed.mock.calls.length).toBe(count);
    });
    it('preserves retained ready index during an index rebuild and excludes incomplete generations', async () => {
      const path = `/api/v1/documents/${docA}/versions/${versionA}/ai/reprocess`;
      const before = (await query().expect(200)).body.data.results[0]
        .indexManifestId;
      await request(app.getHttpServer())
        .post(path)
        .set('Cookie', a.cookie)
        .set('X-CSRF-Protection', '1')
        .set('Idempotency-Key', randomUUID())
        .send({ mode: 'index' })
        .expect(202);
      expect(
        (await query().expect(200)).body.data.results[0].indexManifestId,
      ).toBe(before);
      await drain(versionA);
      expect(
        (await query().expect(200)).body.data.results[0].indexManifestId,
      ).not.toBe(before);
    });
    it('rejects forged foreign chunk IDs even under A owner/active manifest payload', async () => {
      const manifest = await db.versionReadyIndex.findFirstOrThrow({
        where: { documentVersionId: versionA },
        include: { index: true },
      });
      const foreign = await db.documentChunk.findFirstOrThrow({
        where: { documentId: docB },
      });
      const client = new QdrantClient({
        url: qdrantUrl!,
        checkCompatibility: false,
      });
      const id = vectorPointId(foreign.id, profileId, manifest.vectorIndexId);
      await client.upsert(vectorCollectionName(profileId), {
        wait: true,
        points: [
          {
            id,
            vector: [1, 2, 3],
            payload: {
              userId: a.id,
              documentId: docA,
              documentVersionId: versionA,
              chunkSetId: manifest.index.chunkSetId,
              indexManifestId: manifest.vectorIndexId,
              embeddingProfileId: profileId,
              embeddingProfileVersion: 1,
              payloadSchemaVersion: 1,
              chunkId: foreign.id,
              ordinal: 0,
              pageNumbers: [1],
              text: 'FORGED REMOTE TEXT',
              title: 'B secret title',
            },
          },
        ],
      });
      try {
        const response = await query().expect(200);
        expect(
          response.body.data.results.some(
            (r: { chunkId: string }) => r.chunkId === foreign.id,
          ),
        ).toBe(false);
        expect(JSON.stringify(response.body)).not.toContain(
          'FORGED REMOTE TEXT',
        );
      } finally {
        await client.delete(vectorCollectionName(profileId), {
          wait: true,
          points: [id],
        });
      }
    });
    it('excludes archive immediately and restores only after verified new activation', async () => {
      const old = (await query().expect(200)).body.data.results[0]
        .indexManifestId;
      await transition('archive').expect(200);
      const calls = provider.embed.mock.calls.length;
      expect((await query().expect(200)).body.data.results).toEqual([]);
      expect(provider.embed.mock.calls.length).toBe(calls);
      await transition('restore').expect(200);
      expect((await query().expect(200)).body.data.results).toEqual([]);
      await drain(versionA);
      const response = await query().expect(200);
      expect(response.body.data.results.length).toBeGreaterThan(0);
      expect(response.body.data.results[0].indexManifestId).not.toBe(old);
    });
    it('rechecks SQL after remote search if ownership lifecycle changes during the request', async () => {
      const store = app.get<QdrantVectorStore>(SEMANTIC_VECTORS);
      const original = store.search.bind(store);
      const spy = jest
        .spyOn(store, 'search')
        .mockImplementationOnce(async (input) => {
          const candidates = await original(input);
          await transition('archive').expect(200);
          return candidates;
        });
      try {
        expect((await query().expect(200)).body.data.results).toEqual([]);
      } finally {
        spy.mockRestore();
      }
      await transition('restore').expect(200);
      await drain(versionA);
    });
    it('fails closed and sanitized on provider/Qdrant failure and avoids content logs', async () => {
      provider.embed.mockRejectedValueOnce(
        new EmbeddingFailure('EMBEDDING_NETWORK', true),
      );
      await query(a, { query: 'TOP SECRET QUESTION' }).expect(503);
      const store = app.get<QdrantVectorStore>(SEMANTIC_VECTORS);
      const spy = jest
        .spyOn(store, 'search')
        .mockRejectedValueOnce(new Error('TOP SECRET provider credentials'));
      try {
        await query().expect(503);
      } finally {
        spy.mockRestore();
      }
      expect(logs.join('')).not.toMatch(
        /TOP SECRET|Hello world|B secret title|FORGED REMOTE TEXT/,
      );
    });
    it('SQL serving selection and exact candidate references are authoritative', async () => {
      const repository = app.get(SemanticSearchRepository);
      const foreign = await db.documentChunk.findFirstOrThrow({
        where: { documentId: docB },
      });
      const own = await db.versionReadyIndex.findFirstOrThrow({
        where: { documentVersionId: versionA },
        include: { index: true },
      });
      expect(
        await repository.hydrate(a.id, profileId, [
          {
            chunkId: foreign.id,
            indexManifestId: own.vectorIndexId,
            documentId: docA,
            documentVersionId: versionA,
            chunkSetId: own.index.chunkSetId,
            score: 1,
          },
        ]),
      ).toEqual([]);
      await db.aiServingProfile.delete({ where: { id: 1 } });
      try {
        await query().expect(503);
      } finally {
        await db.aiServingProfile.create({
          data: { id: 1, embeddingProfileId: profileId },
        });
      }
    });
    it('excludes superseded versions and soft-deleted sources until new/restore activation', async () => {
      const bytes = await readFile(
        resolve(__dirname, 'fixtures/pdf/single.pdf'),
      );
      const updated = Buffer.concat([
        bytes,
        Buffer.from('\n% immutable version two\n'),
      ]);
      await request(app.getHttpServer())
        .post(`/api/v1/documents/${docA}/versions`)
        .set('Cookie', a.cookie)
        .set('X-CSRF-Protection', '1')
        .set('Idempotency-Key', randomUUID())
        .attach('file', updated, {
          filename: 'a-v2.pdf',
          contentType: 'application/pdf',
        })
        .expect(201);
      expect((await query().expect(200)).body.data.results).toEqual([]);
      const current = await db.documentVersion.findFirstOrThrow({
        where: { documentId: docA },
        orderBy: { versionNumber: 'desc' },
      });
      expect(current.versionNumber).toBe(2);
      await drain(current.id);
      const found = (await query().expect(200)).body.data.results;
      expect(found.length).toBeGreaterThan(0);
      expect(
        found.every(
          (r: { documentVersionId: string }) =>
            r.documentVersionId === current.id,
        ),
      ).toBe(true);
      await request(app.getHttpServer())
        .delete(`/api/v1/documents/${docA}`)
        .set('Cookie', a.cookie)
        .set('X-CSRF-Protection', '1')
        .expect(200);
      expect((await query().expect(200)).body.data.results).toEqual([]);
      await transition('restore').expect(200);
      expect((await query().expect(200)).body.data.results).toEqual([]);
      await drain(current.id);
      expect(
        (await query().expect(200)).body.data.results.length,
      ).toBeGreaterThan(0);
    });
  },
);
