import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  ProcessingRepository,
  embeddingProfileFingerprint,
} from '@qyvra/database';
import { createHash, randomUUID } from 'node:crypto';
import { Server } from 'node:http';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/configure-application';
import { settings } from '../src/configuration/configuration.module';
import { PrismaService } from '../src/database/prisma.service';
import { LOG_SINK } from '../src/common/structured-logger';
import { createTestOwner, TestOwner } from './owner.fixture';
import { validateTestEnvironment } from './configuration.fixture';
import {
  PROCESSING_PROGRESS,
  ProcessingProgressStore,
} from '../src/infrastructure/progress/processing-progress';

describe('owned processing-status HTTP contract', () => {
  let app: INestApplication;
  let server: Server;
  let db: PrismaService;
  let jobs: ProcessingRepository;
  let progress: ProcessingProgressStore;
  const users: string[] = [];
  const profiles: string[] = [];
  const owner = () => createTestOwner(db, users);
  const path = (documentId: string, versionId: string) =>
    `/api/v1/documents/${documentId}/versions/${versionId}/processing`;
  const get = (user: TestOwner, documentId: string, versionId: string) =>
    request(server).get(path(documentId, versionId)).set('Cookie', user.cookie);

  async function fixture(user: TestOwner) {
    const document = await db.client.document.create({
      data: { userId: user.id, title: 'Status fixture' },
    });
    const version = await db.client.documentVersion.create({
      data: {
        userId: user.id,
        documentId: document.id,
        versionNumber: 1,
        originalFilename: 'fixture.pdf',
        storageKey: `test/${randomUUID()}`,
        mimeType: 'application/pdf',
        fileSize: 12,
        pageCount: 1,
        checksumSha256: createHash('sha256').update(randomUUID()).digest('hex'),
      },
    });
    return { document, version };
  }

  async function schedule(
    user: TestOwner,
    documentId: string,
    versionId: string,
  ) {
    return jobs.create({
      userId: user.id,
      documentId,
      documentVersionId: versionId,
      correlationId: randomUUID(),
      maxAttempts: 3,
    });
  }

  beforeAll(async () => {
    if (
      !process.env.TEST_DATABASE_URL ||
      !/test/i.test(new URL(process.env.TEST_DATABASE_URL).pathname)
    )
      throw new Error('Use a disposable migrated TEST_DATABASE_URL.');
    const config = validateTestEnvironment({
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      UPLOAD_QPDF_PATH: process.env.UPLOAD_QPDF_PATH,
      REDIS_URL:
        process.env.TEST_REDIS_URL ?? process.env.TEST_REDIS_UNAVAILABLE_URL,
    });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(settings.KEY)
      .useValue(config)
      .overrideProvider(LOG_SINK)
      .useValue(() => undefined)
      .compile();
    app = module.createNestApplication();
    configureApplication(app, config);
    await app.init();
    server = app.getHttpServer();
    db = app.get(PrismaService);
    jobs = new ProcessingRepository(db.client);
    progress = app.get<ProcessingProgressStore>(PROCESSING_PROGRESS);
  });

  afterAll(async () => {
    try {
      if (db) {
        await db.client.documentUpload.deleteMany({
          where: { userId: { in: users } },
        });
        await db.client.document.deleteMany({
          where: { userId: { in: users } },
        });
        await db.client.authSession.deleteMany({
          where: { userId: { in: users } },
        });
        await db.client.user.deleteMany({ where: { id: { in: users } } });
        await db.client.embeddingProfile.deleteMany({
          where: { id: { in: profiles } },
        });
      }
    } finally {
      await app?.close();
    }
  });

  it('returns an empty, owned view for an older version with no processing job', async () => {
    const user = await owner();
    const { document, version } = await fixture(user);
    const response = await get(user, document.id, version.id).expect(200);
    expect(response.body.data).toEqual({
      documentId: document.id,
      documentVersionId: version.id,
      aiReadiness: 'UNAVAILABLE',
      jobs: [],
    });
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body.meta.requestId).toBeDefined();
  });

  it('reports the desired AI pipeline without exposing another owner or internal configuration', async () => {
    const user = await owner(),
      foreign = await owner();
    const { document, version } = await fixture(user);
    const identity = {
      profileVersion: 1,
      provider: 'test',
      model: randomUUID(),
      modelRevision: 'v1',
      dimensions: 3,
      distance: 'Cosine' as const,
      normalizationVersion: 'v1',
      tokenizer: 'test',
      tokenizerVersion: 'v1',
      documentInstruction: '',
      queryInstruction: '',
    };
    const profile = await db.client.embeddingProfile.create({
      data: { ...identity, fingerprint: embeddingProfileFingerprint(identity) },
    });
    profiles.push(profile.id);
    const run = await jobs.requestAiProcessing({
      userId: user.id,
      documentId: document.id,
      documentVersionId: version.id,
      correlationId: randomUUID(),
      maxAttempts: 3,
      extractor: 'test',
      extractorVersion: 'v1',
      normalizationVersion: 'v1',
      chunkAlgorithm: 'test',
      chunkAlgorithmVersion: 'v1',
      tokenizer: 'test',
      tokenizerVersion: 'v1',
      chunkSize: 512,
      chunkOverlap: 64,
      embeddingProfileId: profile.id,
    });
    const waiting = await get(user, document.id, version.id).expect(200);
    expect(waiting.body.data.pipeline).toMatchObject({
      runId: run.id,
      generation: 1,
      status: 'BUILDING',
      currentStage: 'VERIFY_STORED_FILE',
    });
    const verification = await db.client.processingJob.findFirstOrThrow({
      where: { documentVersionId: version.id, jobType: 'VERIFY_STORED_FILE' },
    });
    const claimed = await jobs.claim(verification.id, new Date(), 60000);
    await jobs.complete(claimed.id, claimed.leaseToken!, new Date());
    const active = await get(user, document.id, version.id).expect(200);
    expect(active.body.data.pipeline).toMatchObject({
      currentStage: 'EXTRACT_TEXT',
      stages: [
        { jobType: 'VERIFY_STORED_FILE', status: 'COMPLETED' },
        { jobType: 'EXTRACT_TEXT', status: 'PENDING' },
        { jobType: 'GENERATE_CHUNKS', status: 'NOT_SCHEDULED' },
        { jobType: 'GENERATE_EMBEDDINGS', status: 'NOT_SCHEDULED' },
        { jobType: 'INDEX_VECTORS', status: 'NOT_SCHEDULED' },
      ],
    });
    expect(JSON.stringify(active.body.data)).not.toMatch(
      /embeddingProfileId|leaseToken|correlationId|storageKey|fingerprint/,
    );
    await get(foreign, document.id, version.id).expect(404);
  });

  (process.env.TEST_REDIS_URL ? it : it.skip)(
    'enriches an owned active job, survives lost progress, and lets PostgreSQL completion win',
    async () => {
      const user = await owner();
      const { document, version } = await fixture(user);
      const created = await schedule(user, document.id, version.id);
      const now = new Date();
      const outboxClaim = await jobs.claimOutbox(created.outbox.id, now, 60000);
      if (!outboxClaim.claimToken)
        throw new Error('Missing outbox claim token.');
      await jobs.markOutboxPublished(
        created.outbox.id,
        outboxClaim.claimToken,
        now,
      );
      await jobs.markQueued(created.job.id, 1, now);
      const claimed = await jobs.claim(created.job.id, now, 60000);
      await progress.report(created.job.id, 1, 45, 'READING');
      const active = await get(user, document.id, version.id).expect(200);
      expect(active.body.data.jobs[0]).toMatchObject({
        status: 'PROCESSING',
        progress: { attempt: 1, percent: 45, stage: 'READING' },
      });
      await progress.clear(created.job.id, 1);
      const missing = await get(user, document.id, version.id).expect(200);
      expect(missing.body.data.jobs[0].progress).toBeNull();
      await progress.report(created.job.id, 1, 80, 'READING');
      if (!claimed.leaseToken) throw new Error('Missing lease token.');
      await jobs.complete(created.job.id, claimed.leaseToken, new Date());
      const completed = await get(user, document.id, version.id).expect(200);
      expect(completed.body.data.jobs[0]).toMatchObject({
        status: 'COMPLETED',
        progress: null,
      });
      await progress.clear(created.job.id, 1);
    },
  );

  it('shows durable transitions and retry time without internal fields', async () => {
    const user = await owner();
    const { document, version } = await fixture(user);
    const created = await schedule(user, document.id, version.id);
    const read = async () =>
      (await get(user, document.id, version.id).expect(200)).body.data.jobs[0];
    expect(await read()).toMatchObject({
      id: created.job.id,
      jobType: 'VERIFY_STORED_FILE',
      status: 'PENDING',
      attempts: 0,
      maxAttempts: 3,
      nextRetryAt: null,
      failureCode: null,
    });
    const now = new Date(Date.now() + 1000);
    const outboxClaim = await jobs.claimOutbox(created.outbox.id, now, 60000);
    if (!outboxClaim.claimToken) throw new Error('Missing outbox claim token.');
    await jobs.markOutboxPublished(
      created.outbox.id,
      outboxClaim.claimToken,
      now,
    );
    await jobs.markQueued(created.job.id, 1, now);
    expect((await read()).status).toBe('QUEUED');
    const claimed = await jobs.claim(created.job.id, now, 60000);
    expect(await read()).toMatchObject({
      status: 'PROCESSING',
      attempts: 1,
      nextRetryAt: null,
      progress: null,
    });
    if (!claimed.leaseToken) throw new Error('Missing lease token.');
    const failed = await jobs.fail(
      created.job.id,
      claimed.leaseToken,
      new Date(now.getTime() + 1),
      'STORAGE_READ_FAILED',
      true,
    );
    expect(await read()).toMatchObject({
      status: 'RETRYING',
      attempts: 1,
      nextRetryAt: failed.availableAt.toISOString(),
      failureCode: 'TEMPORARY_PROCESSING_ERROR',
    });
    const safe = JSON.stringify(await read());
    expect(safe).not.toMatch(
      /outbox|routingKey|exchange|queue|leaseToken|storageKey|lastFailureCode|STORAGE_READ_FAILED|userId|correlationId/,
    );
  });

  it('shows completed and terminal failure states with sanitized categories', async () => {
    const user = await owner();
    const first = await fixture(user);
    const complete = await schedule(user, first.document.id, first.version.id);
    const now = new Date();
    const claimed = await jobs.claim(complete.job.id, now, 60000);
    if (!claimed.leaseToken) throw new Error('Missing lease token.');
    await jobs.complete(
      complete.job.id,
      claimed.leaseToken,
      new Date(now.getTime() + 1),
    );
    const done = await get(user, first.document.id, first.version.id).expect(
      200,
    );
    expect(done.body.data.jobs[0]).toMatchObject({
      status: 'COMPLETED',
      attempts: 1,
      failureCode: null,
      nextRetryAt: null,
    });
    expect(done.body.data.jobs[0].completedAt).toEqual(expect.any(String));
    const replay = await jobs.create(
      {
        userId: user.id,
        documentId: first.document.id,
        documentVersionId: first.version.id,
        correlationId: randomUUID(),
        maxAttempts: 3,
      },
      true,
    );
    const latest = await get(user, first.document.id, first.version.id).expect(
      200,
    );
    expect(latest.body.data.jobs).toHaveLength(1);
    expect(latest.body.data.jobs[0]).toMatchObject({
      id: replay.job.id,
      status: 'PENDING',
      attempts: 0,
    });

    const second = await fixture(user);
    const terminal = await schedule(
      user,
      second.document.id,
      second.version.id,
    );
    const terminalNow = new Date(Date.now() + 1000);
    const terminalClaim = await jobs.claim(terminal.job.id, terminalNow, 60000);
    if (!terminalClaim.leaseToken) throw new Error('Missing lease token.');
    await jobs.fail(
      terminal.job.id,
      terminalClaim.leaseToken,
      new Date(terminalNow.getTime() + 1),
      'FILE_CHECKSUM_MISMATCH',
      false,
    );
    const failed = await get(
      user,
      second.document.id,
      second.version.id,
    ).expect(200);
    expect(failed.body.data.jobs[0]).toMatchObject({
      status: 'FAILED',
      failureCode: 'FILE_INTEGRITY_FAILED',
      nextRetryAt: null,
    });
    expect(JSON.stringify(failed.body)).not.toContain('FILE_CHECKSUM_MISMATCH');
  });

  it('hides foreign, mismatched and soft-deleted versions while allowing archived reads', async () => {
    const user = await owner();
    const stranger = await owner();
    const first = await fixture(user);
    const second = await fixture(user);
    await schedule(user, first.document.id, first.version.id);
    await get(stranger, first.document.id, first.version.id).expect(404);
    await get(user, second.document.id, first.version.id).expect(404);
    await request(server)
      .get(path(first.document.id, first.version.id))
      .expect(401);
    await db.client.document.update({
      where: { id: first.document.id },
      data: { isArchived: true, status: 'ARCHIVED' },
    });
    await get(user, first.document.id, first.version.id).expect(200);
    await db.client.document.update({
      where: { id: first.document.id },
      data: { deletedAt: new Date() },
    });
    await get(user, first.document.id, first.version.id).expect(404);
  });

  it('validates IDs and rejects unsupported query/body input', async () => {
    const user = await owner();
    const { document, version } = await fixture(user);
    await get(user, 'not-a-uuid', version.id).expect(400);
    await get(user, document.id, 'not-a-uuid').expect(400);
    await get(user, document.id, version.id).query({ debug: '1' }).expect(400);
    await get(user, document.id, version.id).send({ debug: true }).expect(400);
  });

  it('publishes the owned status schema in generated OpenAPI', async () => {
    const response = await request(server).get('/api/v1/docs-json').expect(200);
    const operation =
      response.body.paths[
        '/api/v1/documents/{documentId}/versions/{versionId}/processing'
      ].get;
    expect(operation.security).toEqual([{ session: [] }]);
    const view = response.body.components.schemas.ProcessingStatusView;
    expect(view.properties.jobs.items.$ref).toContain(
      'ProcessingJobStatusView',
    );
    const job = response.body.components.schemas.ProcessingJobStatusView;
    expect(job.properties).toHaveProperty('nextRetryAt');
    expect(job.properties).toHaveProperty('failureCode');
    expect(JSON.stringify(job)).not.toMatch(/outbox|routingKey|leaseToken/);
  });
});
