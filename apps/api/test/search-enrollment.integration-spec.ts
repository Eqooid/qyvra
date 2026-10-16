import { createHash, randomUUID } from 'node:crypto';
import {
  createPrismaClient,
  SearchPersistenceRepository,
  ProcessingRepository,
  ProcessingMessage,
} from '@qyvra/database';
import { ConfigurationService } from '../src/configuration/configuration.module';
import { PrismaService } from '../src/database/prisma.service';
import { SearchEnrollmentService } from '../src/modules/search/search-enrollment.service';
import { UploadRepository } from '../src/modules/documents/upload.repository';
import { DocumentsService } from '../src/modules/documents/documents.service';
import { TagsService } from '../src/modules/tags/tags.service';
import {
  CategoriesService,
  CategoryConflict,
} from '../src/modules/categories/categories.service';
import { parseProcessingMessage } from '../src/infrastructure/messaging/processing-message';
import { UploadedFile } from '../src/modules/documents/upload-multipart';
import { OutboxDispatcher } from '../src/infrastructure/outbox/outbox-dispatcher.service';
import { ProcessingMessageHandler } from '../src/infrastructure/worker/processing-message-handler';
import { validateTestEnvironment } from './configuration.fixture';

describe('T03 application transaction hooks with PostgreSQL', () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !/test/i.test(new URL(url).pathname))
    throw new Error('Use a migrated disposable TEST_DATABASE_URL.');
  const db = new PrismaService(
    createPrismaClient({
      url,
      connectTimeoutMs: 2000,
      queryTimeoutMs: 15000,
      poolSize: 5,
    }),
  );
  const processing = new ProcessingRepository(db.client);
  let search: SearchEnrollmentService,
    uploads: UploadRepository,
    documents: DocumentsService;
  let userId: string, generationId: string;
  const hash = (value: string) =>
    createHash('sha256').update(value).digest('hex');
  beforeAll(async () => {
    const key = randomUUID();
    const generation = await new SearchPersistenceRepository(
      db.client,
    ).createGeneration({
      generation: 1234,
      schemaVersion: 1,
      mappingVersion: key,
      analyzerVersion: 'v1',
      extractor: 'pdf',
      extractorVersion: 'v1',
      normalizationVersion: 'nfc-lf-v1',
      segmentationVersion: 'v1',
      metadataIndexName: 'qyvra-search-' + key + '-metadata',
      pageIndexName: 'qyvra-search-' + key + '-pages',
    });
    generationId = generation.id;
    const config = new ConfigurationService(
      validateTestEnvironment({
        DATABASE_URL: url,
        SEARCH_ENROLLMENT_ENABLED: 'true',
        SEARCH_GENERATION_FINGERPRINT: generation.fingerprint,
      }),
    );
    search = new SearchEnrollmentService(db, config);
    await search.onModuleInit();
    uploads = new UploadRepository(db, config, undefined, search);
    documents = new DocumentsService(db, undefined, search);
    userId = (
      await db.client.user.create({ data: { email: key + '@example.invalid' } })
    ).id;
  });
  afterAll(async () => {
    await db.client.documentUpload.deleteMany({ where: { userId } });
    await db.client.document.deleteMany({ where: { userId } });
    await db.client.searchProjectionChange.deleteMany({ where: { userId } });
    await db.client.tag.deleteMany({ where: { userId } });
    await db.client.category.deleteMany({ where: { userId } });
    await db.client.user.deleteMany({ where: { id: userId } });
    await db.client.searchIndexGeneration.deleteMany({
      where: { id: generationId },
    });
    await db.client.$disconnect();
  });
  async function upload(
    documentId: string = randomUUID(),
    scope = 'create',
    tagIds: string[] = [],
  ) {
    const key = randomUUID();
    const reservation = await uploads.reserve(userId, key, scope);
    const versionId = randomUUID();
    const file: UploadedFile = {
      key: 'test/' + randomUUID(),
      filename: 'fixture.png',
      mime: 'image/png',
      size: 12,
      checksum: hash(randomUUID()),
      dto: { title: 'Enrolled upload', tagIds },
    };
    const args = [
      userId,
      key,
      reservation.attemptId,
      documentId,
      versionId,
      file,
      null,
      scope,
      randomUUID(),
    ] as const;
    return { result: await uploads.complete(...args), args };
  }
  it('initial upload, receipt replay, version upload and mutations create atomic search intent', async () => {
    const tag = await db.client.tag.create({
      data: { userId, name: 'Initial tag' },
    });
    const first = await upload(undefined, 'create', [tag.id]);
    const id = first.result.response.id;
    const p = await db.client.versionSearchProjection.findFirstOrThrow({
      where: { documentId: id },
    });
    expect(p.metadataHash).toBe(
      (
        await db.client.$queryRaw<
          { hash: string }[]
        >`SELECT search_metadata_hash(${p.documentVersionId}::uuid) AS hash`
      )[0].hash,
    );
    expect((await uploads.complete(...first.args)).replay).toBe(true);
    expect(
      await db.client.processingJob.count({
        where: { documentId: id, jobType: 'INDEX_SEARCH' },
      }),
    ).toBe(1);
    expect(
      await db.client.processingJob.count({
        where: { documentId: id, jobType: 'VERIFY_STORED_FILE' },
      }),
    ).toBe(1);
    const second = await upload(id, 'versions:' + id);
    expect(
      (
        await db.client.documentSearchState.findUniqueOrThrow({
          where: { documentId: id },
        })
      ).desiredVersionId,
    ).toBe(second.result.response.version.id);
    await documents.update(userId, id, { title: 'Updated', tagIds: [] });
    const revision = (
      await db.client.documentSearchState.findUniqueOrThrow({
        where: { documentId: id },
      })
    ).desiredRevision;
    expect(revision).toBe(3);
    await documents.transition(userId, id, 'archive');
    await documents.transition(userId, id, 'archive');
    expect(
      (
        await db.client.documentSearchState.findUniqueOrThrow({
          where: { documentId: id },
        })
      ).desiredRevision,
    ).toBe(4);
    const removals = await db.client.processingJob.findMany({
      where: { documentId: id, jobType: 'REMOVE_SEARCH_INDEX' },
    });
    expect(removals.length).toBeGreaterThan(0);
    expect(removals.every((j) => j.status === 'PENDING')).toBe(true);
    await documents.transition(userId, id, 'restore');
    expect(
      (
        await db.client.documentSearchState.findUniqueOrThrow({
          where: { documentId: id },
        })
      ).desiredRevision,
    ).toBe(5);
    await documents.transition(userId, id, 'delete');
    expect(
      await db.client.processingJob.count({
        where: { documentId: id, jobType: 'INDEX_SEARCH', status: 'PENDING' },
      }),
    ).toBe(0);
    const stale = (
      await db.client.processingOutbox.findFirstOrThrow({
        where: { job: { documentId: id, jobType: 'INDEX_SEARCH' } },
      })
    ).payload;
    expect(
      await new ProcessingMessageHandler(processing, []).handle(
        parseProcessingMessage(stale),
        false,
      ),
    ).toBe('ack');
  });
  it('upload scheduling failure rolls back version, search, integrity job and completed receipt', async () => {
    const key = randomUUID(),
      id = randomUUID();
    const reservation = await uploads.reserve(userId, key);
    const fail = jest
      .spyOn(search, 'enrollInTransaction')
      .mockRejectedValueOnce(new Error('Injected enrollment failure'));
    try {
      await expect(
        uploads.complete(
          userId,
          key,
          reservation.attemptId,
          id,
          randomUUID(),
          {
            key: 'test/' + randomUUID(),
            filename: 'fixture.png',
            mime: 'image/png',
            size: 12,
            checksum: hash(randomUUID()),
            dto: { title: 'Rollback' },
          },
          null,
          'create',
          randomUUID(),
        ),
      ).rejects.toThrow();
      expect(await db.client.document.findUnique({ where: { id } })).toBeNull();
      expect(
        await db.client.processingJob.count({ where: { documentId: id } }),
      ).toBe(0);
      expect(
        (
          await db.client.documentUpload.findUniqueOrThrow({
            where: { userId_scope_key: { userId, scope: 'create', key } },
          })
        ).state,
      ).toBe('RECEIVING');
    } finally {
      fail.mockRestore();
    }
  });
  it('organization deletion and checkpoint commit together; assigned categories remain protected', async () => {
    const tags = new TagsService(db, search);
    const categories = new CategoriesService(db, search);
    const tag = await db.client.tag.create({
      data: { userId, name: 'Cascade tag' },
    });
    const uploaded = await upload(undefined, 'create', [tag.id]);
    const id = uploaded.result.response.id;
    await tags.delete(userId, tag.id);
    expect(
      await db.client.searchProjectionChange.count({
        where: { userId, resourceId: tag.id, status: 'PENDING' },
      }),
    ).toBe(1);
    await search.reconcile(100);
    expect(
      (
        await db.client.documentSearchState.findUniqueOrThrow({
          where: { documentId: id },
        })
      ).desiredRevision,
    ).toBe(2);
    const category = await db.client.category.create({
      data: { userId, name: 'Assigned category' },
    });
    await documents.update(userId, id, { categoryId: category.id });
    await expect(categories.delete(userId, category.id)).rejects.toBeInstanceOf(
      CategoryConflict,
    );
    expect(
      await db.client.searchProjectionChange.count({
        where: { resourceId: category.id },
      }),
    ).toBe(0);
    await documents.update(userId, id, { categoryId: null });
    await categories.delete(userId, category.id);
    expect(
      await db.client.searchProjectionChange.count({
        where: { resourceId: category.id },
      }),
    ).toBe(1);
    const otherTag = await db.client.tag.create({
      data: { userId, name: 'Rollback deletion' },
    });
    const fail = jest
      .spyOn(search, 'recordOrganizationChangeInTransaction')
      .mockRejectedValueOnce(new Error('Injected checkpoint failure'));
    try {
      await expect(tags.delete(userId, otherTag.id)).rejects.toThrow();
      expect(
        await db.client.tag.findUnique({ where: { id: otherTag.id } }),
      ).not.toBeNull();
    } finally {
      fail.mockRestore();
    }
  });
  it('pending search survives missing workers and publisher failure; retry retains exact identity', async () => {
    const { result } = await upload();
    const j = await db.client.processingJob.findFirstOrThrow({
      where: { documentId: result.response.id, jobType: 'INDEX_SEARCH' },
    });
    const intent = await db.client.processingOutbox.findFirstOrThrow({
      where: { processingJobId: j.id },
    });
    const publish = jest
      .fn<Promise<void>, [ProcessingMessage]>()
      .mockRejectedValue(new Error('Injected transport failure'));
    const now = new Date(Date.now() + 1000);
    const held = new OutboxDispatcher(
      processing,
      { publishProcessing: publish },
      { pollIntervalMs: 1000, batchSize: 100, leaseMs: 30000 },
      () => now,
    );
    await held.dispatchOnce();
    expect(
      (
        await db.client.processingOutbox.findUniqueOrThrow({
          where: { id: intent.id },
        })
      ).publicationAttempts,
    ).toBe(0);
    const handoff = new OutboxDispatcher(
      processing,
      { publishProcessing: publish },
      { pollIntervalMs: 1000, batchSize: 100, leaseMs: 30000 },
      () => now,
      ['INDEX_SEARCH'],
    );
    await handoff.dispatchOnce();
    const failed = await db.client.processingOutbox.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(failed.status).toBe('PENDING');
    expect(failed.lastFailureCode).toBe('PUBLISH_FAILED');
    publish.mockResolvedValue(undefined);
    const retry = new OutboxDispatcher(
      processing,
      { publishProcessing: publish },
      { pollIntervalMs: 1000, batchSize: 100, leaseMs: 30000 },
      () => new Date(Date.now() + 600000),
      ['INDEX_SEARCH'],
    );
    await retry.dispatchOnce();
    await retry.dispatchOnce();
    expect(
      (
        await db.client.processingOutbox.findUniqueOrThrow({
          where: { id: intent.id },
        })
      ).status,
    ).toBe('PUBLISHED');
    const attempts = publish.mock.calls
      .map(([m]) => m)
      .filter((m) => m.messageId === intent.id);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toEqual(attempts[1]);
    expect(
      await new ProcessingMessageHandler(processing, []).handle(
        parseProcessingMessage(intent.payload),
        false,
      ),
    ).toBe('dead-letter');
    expect((await processing.findById(j.id))?.status).toBe('PENDING');
  });
});
