import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  LocalFileStorage,
  STORAGE,
  StorageError,
  originalDocumentKey,
} from '@qyvra/storage';
import { ProcessingRepository } from '@qyvra/database';
import { randomUUID, createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename, dirname, resolve } from 'node:path';
import { Server } from 'node:http';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/configure-application';
import { settings } from '../src/configuration/configuration.module';
import { validateTestEnvironment } from './configuration.fixture';
import { PrismaService } from '../src/database/prisma.service';
import { LOG_SINK } from '../src/common/structured-logger';
import { UploadRepository } from '../src/modules/documents/upload.repository';
import { UploadInspector } from '../src/infrastructure/storage/upload-inspector';
import { createTestOwner, TestOwner } from './owner.fixture';
import { pdfFixture } from './upload.fixture';
import { imageReader as sharp } from '../src/infrastructure/storage/image-reader';

describe('Immutable versions PostgreSQL HTTP workflow', () => {
  let app: INestApplication,
    server: Server,
    db: PrismaService,
    directory: string,
    storage: LocalFileStorage;
  const users: string[] = [],
    logs: string[] = [];
  const owner = () => createTestOwner(db, users);
  const begin = (user: TestOwner, id: string, key: string = randomUUID()) =>
    request(server)
      .post(`/api/v1/documents/${id}/versions`)
      .set('Cookie', user.cookie)
      .set('X-CSRF-Protection', '1')
      .set('Idempotency-Key', key);
  const upload = (
    user: TestOwner,
    id: string,
    bytes = pdfFixture(randomUUID()),
    key: string = randomUUID(),
  ) =>
    begin(user, id, key).attach('file', bytes, {
      filename: 'version.pdf',
      contentType: 'application/pdf',
    });
  const list = (user: TestOwner, id: string) =>
    request(server)
      .get(`/api/v1/documents/${id}/versions`)
      .set('Cookie', user.cookie);
  const seed = async (user: TestOwner) => {
    const doc = await db.client.document.create({
      data: { userId: user.id, title: 'Preserved title', status: 'READY' },
    });
    const versionId = randomUUID(),
      bytes = pdfFixture(randomUUID()),
      storageKey = originalDocumentKey(user.id, doc.id, versionId, 'pdf');
    await storage.save(storageKey, Readable.from([bytes]));
    const version = await db.client.documentVersion.create({
      data: {
        id: versionId,
        documentId: doc.id,
        userId: user.id,
        versionNumber: 1,
        storageKey,
        originalFilename: 'first.pdf',
        mimeType: 'application/pdf',
        fileSize: bytes.length,
        checksumSha256: createHash('sha256').update(bytes).digest('hex'),
        pageCount: 1,
        extractionStatus: 'COMPLETED',
      },
    });
    return { doc, version, bytes };
  };
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'qyvra-versions-test-'));
    storage = new LocalFileStorage(join(directory, 'objects'));
    const config = validateTestEnvironment({
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      UPLOAD_QPDF_PATH: process.env.UPLOAD_QPDF_PATH,
      UPLOAD_MAX_BYTES: '1048576',
      UPLOAD_CONCURRENCY: '8',
    });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(settings.KEY)
      .useValue(config)
      .overrideProvider(STORAGE)
      .useValue(storage)
      .overrideProvider(LOG_SINK)
      .useValue((line: string) => logs.push(line))
      .compile();
    app = module.createNestApplication();
    configureApplication(app, config);
    await app.init();
    server = app.getHttpServer();
    db = app.get(PrismaService);
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    try {
      if (db)
        await db.client.$transaction(async (tx) => {
          const where = { userId: { in: users } };
          await tx.documentUpload.deleteMany({ where });
          await tx.document.deleteMany({ where });
          await tx.authSession.deleteMany({ where });
          await tx.user.deleteMany({ where: { id: { in: users } } });
        });
    } finally {
      await app?.close();
      if (directory) {
        expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
        expect(basename(directory).startsWith('qyvra-versions-test-')).toBe(
          true,
        );
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
  it('creates version 2, resets status and preserves every original field/object', async () => {
    const user = await owner(),
      original = await seed(user);
    const bytes = pdfFixture(randomUUID());
    const result = await upload(user, original.doc.id, bytes).expect(201);
    expect(result.body.data).toMatchObject({
      documentId: original.doc.id,
      status: 'UPLOADED',
      version: {
        versionNumber: 2,
        isLatest: true,
        extractionStatus: 'PENDING',
      },
    });
    expect(
      await db.client.documentVersion.findUnique({
        where: { id: original.version.id },
      }),
    ).toEqual(original.version);
    expect(await storage.exists(original.version.storageKey)).toBe(true);
    const doc = await db.client.document.findUniqueOrThrow({
      where: { id: original.doc.id },
    });
    expect(doc.title).toBe(original.doc.title);
    expect(doc.status).toBe('UPLOADED');
    const newVersionId = result.body.data.version.id as string;
    const jobs = await db.client.processingJob.findMany({
      where: { documentId: doc.id },
      include: { outbox: true },
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      userId: user.id,
      documentVersionId: newVersionId,
      jobType: 'VERIFY_STORED_FILE',
      status: 'PENDING',
    });
    expect(jobs[0].outbox).toHaveLength(1);
    expect(jobs[0].outbox[0].payload).toMatchObject({
      jobId: jobs[0].id,
      documentVersionId: newVersionId,
    });
    const downloaded = await request(server)
      .get(`/api/v1/documents/${doc.id}/download`)
      .set('Cookie', user.cookie)
      .expect(200);
    expect(downloaded.body).toEqual(bytes);
    expect(JSON.stringify(result.body)).not.toMatch(
      /storageKey|checksum|userId|qyvra-versions-test/,
    );
    await expect(
      db.client.documentVersion.update({
        where: { id: original.version.id },
        data: { versionNumber: 50 },
      }),
    ).rejects.toThrow();
  });
  it('allocates sequential numbers under concurrent different-key uploads and paginates deterministically', async () => {
    const user = await owner(),
      { doc, version } = await seed(user);
    const results = await Promise.all([
      upload(user, doc.id),
      upload(user, doc.id),
    ]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    expect(
      results.map((r) => r.body.data.version.versionNumber).sort(),
    ).toEqual([2, 3]);
    const page = await list(user, doc.id).query({ limit: 2 }).expect(200);
    expect(
      page.body.data.map((v: { versionNumber: number }) => v.versionNumber),
    ).toEqual([3, 2]);
    expect(
      page.body.data.map((v: { isLatest: boolean }) => v.isLatest),
    ).toEqual([true, false]);
    const next = await list(user, doc.id)
      .query({ cursor: page.body.meta.nextCursor as string, limit: 2 })
      .expect(200);
    expect(next.body.data[0].id).toBe(version.id);
    expect(next.body.meta.hasMore).toBe(false);
    const detail = await request(server)
      .get(`/api/v1/documents/${doc.id}/versions/${version.id}`)
      .set('Cookie', user.cookie)
      .expect(200);
    expect(detail.body.data.isLatest).toBe(false);
    expect(JSON.stringify(page.body)).not.toMatch(/storageKey|checksum|userId/);
  });
  it('isolates ownership, version membership and cursors before streaming', async () => {
    const user = await owner(),
      other = await owner(),
      { doc, version } = await seed(user),
      second = await seed(user);
    const saved = jest.spyOn(storage, 'save');
    await list(other, doc.id).expect(404);
    await upload(other, doc.id).expect(404);
    await request(server)
      .get(`/api/v1/documents/${doc.id}/versions/${version.id}`)
      .set('Cookie', other.cookie)
      .expect(404);
    await request(server)
      .get(`/api/v1/documents/${second.doc.id}/versions/${version.id}`)
      .set('Cookie', user.cookie)
      .expect(404);
    await list(user, doc.id).query({ cursor: second.version.id }).expect(400);
    expect(saved).not.toHaveBeenCalled();
  });
  it('allows archived history but rejects archived/processing/deleting uploads and hides deleted history', async () => {
    const user = await owner(),
      { doc, version } = await seed(user);
    await db.client.document.update({
      where: { id: doc.id },
      data: { status: 'ARCHIVED', isArchived: true },
    });
    await list(user, doc.id).expect(200);
    await upload(user, doc.id).expect(409);
    await db.client.document.update({
      where: { id: doc.id },
      data: { deletedAt: new Date() },
    });
    await list(user, doc.id).expect(404);
    await upload(user, doc.id).expect(404);
    await request(server)
      .get(`/api/v1/documents/${doc.id}/versions/${version.id}`)
      .set('Cookie', user.cookie)
      .expect(404);
    for (const status of ['DELETING', 'PROCESSING']) {
      await db.client.document.update({
        where: { id: doc.id },
        data: { deletedAt: null, isArchived: false, status },
      });
      await upload(user, doc.id).expect(409);
    }
  });
  it('keeps same-owner checksum uniqueness across documents and concurrent requests', async () => {
    const user = await owner(),
      first = await seed(user),
      second = await seed(user),
      bytes = pdfFixture(randomUUID());
    const remove = jest.spyOn(storage, 'delete');
    await upload(user, first.doc.id, first.bytes).expect(409);
    await upload(user, second.doc.id, first.bytes).expect(409);
    const results = await Promise.all([
      upload(user, first.doc.id, bytes),
      upload(user, first.doc.id, bytes),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(remove).toHaveBeenCalled();
    for (const [key] of remove.mock.calls)
      expect(await storage.exists(key)).toBe(false);
    const other = await owner(),
      third = await seed(other);
    await upload(other, third.doc.id, first.bytes).expect(201);
  });
  it('serializes the same key, replays the receipt, and rejects incompatible content', async () => {
    const user = await owner(),
      { doc } = await seed(user),
      key = randomUUID(),
      bytes = pdfFixture(randomUUID());
    const results = await Promise.all([
      upload(user, doc.id, bytes, key),
      upload(user, doc.id, bytes, key),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const original = results.find((r) => r.status === 201);
    await upload(user, doc.id).expect(201);
    expect(
      (await upload(user, doc.id, bytes, key).expect(201)).body.data,
    ).toEqual(original?.body.data);
    await upload(user, doc.id, pdfFixture(randomUUID()), key).expect(409);
    expect(
      await db.client.documentVersion.count({ where: { documentId: doc.id } }),
    ).toBe(3);
    expect(
      await db.client.processingJob.count({ where: { documentId: doc.id } }),
    ).toBe(2);
  });
  it('scopes the same client key independently to initial creation and each document', async () => {
    const user = await owner(),
      key = randomUUID();
    const initial = await request(server)
      .post('/api/v1/documents')
      .set('Cookie', user.cookie)
      .set('X-CSRF-Protection', '1')
      .set('Idempotency-Key', key)
      .field('title', 'Initial')
      .attach('file', pdfFixture(randomUUID()), 'first.pdf')
      .expect(201);
    await upload(
      user,
      initial.body.data.id as string,
      pdfFixture(randomUUID()),
      key,
    ).expect(201);
    const second = await seed(user);
    await upload(user, second.doc.id, pdfFixture(randomUUID()), key).expect(
      201,
    );
    const receipts = await db.client.documentUpload.findMany({
      where: { userId: user.id, key },
      select: { scope: true },
    });
    expect(receipts.map((r) => r.scope).sort()).toEqual(
      [
        'create',
        `versions:${initial.body.data.id as string}`,
        `versions:${second.doc.id}`,
      ].sort(),
    );
  });
  it('rejects text fields, invalid/empty/multiple/oversize/mismatched files without adding a version', async () => {
    const user = await owner(),
      { doc } = await seed(user);
    for (const name of [
      'title',
      'userId',
      'storageKey',
      'checksum',
      'fileSize',
      'mimeType',
      'versionNumber',
    ])
      await begin(user, doc.id)
        .field(name, 'untrusted')
        .attach('file', pdfFixture(), 'v.pdf')
        .expect(400);
    await begin(user, doc.id).send({ file: 'not multipart' }).expect(415);
    await begin(user, doc.id)
      .set('Content-Type', 'multipart/form-data; boundary=empty')
      .send('--empty--\r\n')
      .expect(400);
    await upload(user, doc.id, Buffer.alloc(0)).expect(400);
    await upload(user, doc.id, Buffer.from('%PDF-1.4\nmalformed')).expect(400);
    await begin(user, doc.id)
      .attach('file', pdfFixture(), 'a.pdf')
      .attach('file', pdfFixture(), 'b.pdf')
      .expect(400);
    await begin(user, doc.id)
      .attach('file', pdfFixture(), {
        filename: 'a.png',
        contentType: 'image/png',
      })
      .expect(415);
    const large = Buffer.alloc(1048577, 32);
    large.write('%PDF-1.4\n');
    await upload(user, doc.id, large).expect(413);
    expect(
      await db.client.documentVersion.count({ where: { documentId: doc.id } }),
    ).toBe(1);
    expect(
      (await readdir(join(directory, 'objects'), { recursive: true })).some(
        (entry) => entry.includes('.pending-'),
      ),
    ).toBe(false);
  });
  it.each(['jpeg', 'png'] as const)(
    'reuses image validation for %s',
    async (format) => {
      const user = await owner(),
        { doc } = await seed(user);
      const bytes = await sharp({
        create: { width: 2, height: 2, channels: 3, background: 'red' },
      })
        .toFormat(format)
        .toBuffer();
      const result = await begin(user, doc.id)
        .attach('file', bytes, {
          filename: `../../image.${format}`,
          contentType: `image/${format}`,
        })
        .expect(201);
      expect(result.body.data.version.mimeType).toBe(`image/${format}`);
      expect(result.body.data.version.pageCount).toBeNull();
    },
  );
  it('compensates SQL failure and never creates a version after storage failure', async () => {
    const user = await owner(),
      { doc } = await seed(user);
    const remove = jest.spyOn(storage, 'delete');
    jest
      .spyOn(app.get(UploadRepository), 'complete')
      .mockRejectedValueOnce(new Error('private infrastructure detail'));
    await upload(user, doc.id).expect(503);
    expect(remove).toHaveBeenCalled();
    for (const [key] of remove.mock.calls)
      expect(await storage.exists(key)).toBe(false);
    jest
      .spyOn(storage, 'save')
      .mockRejectedValueOnce(new StorageError('WRITE_FAILED'));
    await upload(user, doc.id).expect(503);
    expect(
      await db.client.documentVersion.count({ where: { documentId: doc.id } }),
    ).toBe(1);
    expect(logs.join('\n')).not.toContain('private infrastructure detail');
  });
  it('rolls back a replacement version and preserves the previous version when scheduling fails', async () => {
    const user = await owner();
    const { doc, version } = await seed(user);
    const remove = jest.spyOn(storage, 'delete');
    jest
      .spyOn(ProcessingRepository.prototype, 'createInTransaction')
      .mockRejectedValueOnce(new Error('forced scheduling failure'));
    await upload(user, doc.id).expect(503);
    expect(remove).toHaveBeenCalled();
    expect(
      await db.client.documentVersion.count({ where: { documentId: doc.id } }),
    ).toBe(1);
    expect(
      await db.client.processingJob.count({ where: { documentId: doc.id } }),
    ).toBe(0);
    expect(
      (await db.client.document.findUniqueOrThrow({ where: { id: doc.id } }))
        .status,
    ).toBe('READY');
    expect(await storage.exists(version.storageKey)).toBe(true);
  });
  it('rechecks lifecycle under the commit lock and cleans the file if archived while receiving', async () => {
    const user = await owner(),
      { doc } = await seed(user);
    const inspector = app.get(UploadInspector),
      inspect = inspector.inspect.bind(inspector);
    jest.spyOn(inspector, 'inspect').mockImplementationOnce(async (...args) => {
      const pages = await inspect(...args);
      await db.client.document.update({
        where: { id: doc.id },
        data: { status: 'ARCHIVED', isArchived: true },
      });
      return pages;
    });
    const remove = jest.spyOn(storage, 'delete');
    await upload(user, doc.id).expect(409);
    expect(remove).toHaveBeenCalled();
    expect(
      await db.client.documentVersion.count({ where: { documentId: doc.id } }),
    ).toBe(1);
  });
  it('recovers a lost commit acknowledgement without deleting the new version object', async () => {
    const user = await owner(),
      { doc } = await seed(user),
      repo = app.get(UploadRepository),
      complete = repo.complete.bind(repo);
    jest.spyOn(repo, 'complete').mockImplementationOnce(async (...args) => {
      await complete(...args);
      throw new Error('lost acknowledgement');
    });
    const result = await upload(user, doc.id).expect(201);
    const row = await db.client.documentVersion.findUniqueOrThrow({
      where: { id: result.body.data.version.id as string },
    });
    expect(await storage.exists(row.storageKey)).toBe(true);
  });
});
