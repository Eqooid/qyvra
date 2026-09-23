import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  STORAGE,
  LocalFileStorage,
  originalDocumentKey,
} from '@brainless/storage';
import { randomUUID, createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { Server } from 'node:http';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/configure-application';
import { settings } from '../src/configuration/configuration.module';
import { validateTestEnvironment } from './configuration.fixture';
import { PrismaService } from '../src/database/prisma.service';
import { LOG_SINK } from '../src/common/structured-logger';
import { createTestOwner, TestOwner } from './owner.fixture';
import { pdfFixture } from './upload.fixture';

describe('Download PostgreSQL and private storage workflow', () => {
  let app: INestApplication,
    server: Server,
    db: PrismaService,
    storage: LocalFileStorage,
    directory: string;
  const users: string[] = [];
  const owner = () => createTestOwner(db, users);
  const get = (user: TestOwner, id: string) =>
    request(server)
      .get(`/api/v1/documents/${id}/download`)
      .set('Cookie', user.cookie);
  const version = async (
    user: TestOwner,
    documentId: string,
    number: number,
  ) => {
    const id = randomUUID(),
      bytes = pdfFixture(randomUUID()),
      storageKey = originalDocumentKey(user.id, documentId, id, 'pdf');
    await storage.save(storageKey, Readable.from([bytes]));
    await db.client.documentVersion.create({
      data: {
        id,
        documentId,
        userId: user.id,
        versionNumber: number,
        storageKey,
        originalFilename: 'fixture.pdf',
        mimeType: 'application/pdf',
        fileSize: bytes.length,
        checksumSha256: createHash('sha256').update(bytes).digest('hex'),
        pageCount: 1,
      },
    });
    return { id, bytes, storageKey };
  };
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'brainless-download-test-'));
    storage = new LocalFileStorage(join(directory, 'objects'));
    const config = validateTestEnvironment({
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      UPLOAD_QPDF_PATH: process.env.UPLOAD_QPDF_PATH,
    });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(settings.KEY)
      .useValue(config)
      .overrideProvider(STORAGE)
      .useValue(storage)
      .overrideProvider(LOG_SINK)
      .useValue(() => undefined)
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
        expect(basename(directory).startsWith('brainless-download-test-')).toBe(
          true,
        );
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
  it('downloads the exact uploaded first version through the full workflow', async () => {
    const user = await owner(),
      bytes = pdfFixture(randomUUID());
    const upload = await request(server)
      .post('/api/v1/documents')
      .set('Cookie', user.cookie)
      .set('X-CSRF-Protection', '1')
      .set('Idempotency-Key', randomUUID())
      .field('title', 'Download fixture')
      .attach('file', bytes, 'fixture.pdf')
      .expect(201);
    const result = await get(user, upload.body.data.id as string).expect(200);
    expect(result.body).toEqual(bytes);
  });
  it('selects latest deterministic version and never falls back when its object disappears', async () => {
    const user = await owner(),
      doc = await db.client.document.create({
        data: { userId: user.id, title: 'Versions' },
      });
    await version(user, doc.id, 1);
    const latest = await version(user, doc.id, 2);
    expect((await get(user, doc.id).expect(200)).body).toEqual(latest.bytes);
    await storage.delete(latest.storageKey);
    await get(user, doc.id).expect(503);
  });
  it('allows archive but hides deleted, DELETING, foreign and missing documents before opening storage', async () => {
    const user = await owner(),
      other = await owner(),
      doc = await db.client.document.create({
        data: { userId: user.id, title: 'Visibility' },
      });
    await version(user, doc.id, 1);
    await db.client.document.update({
      where: { id: doc.id },
      data: { status: 'ARCHIVED', isArchived: true },
    });
    await get(user, doc.id).expect(200);
    const opened = jest.spyOn(storage, 'open');
    opened.mockClear();
    const foreign = await get(other, doc.id).expect(404),
      missing = await get(other, randomUUID()).expect(404);
    expect(foreign.body.error.code).toBe(missing.body.error.code);
    await db.client.document.update({
      where: { id: doc.id },
      data: { deletedAt: new Date() },
    });
    await get(user, doc.id).expect(404);
    await db.client.document.update({
      where: { id: doc.id },
      data: { deletedAt: null, isArchived: false, status: 'DELETING' },
    });
    await get(user, doc.id).expect(404);
    expect(opened).not.toHaveBeenCalled();
  });
  it('returns conflict for an owned metadata-only document', async () => {
    const user = await owner(),
      doc = await db.client.document.create({
        data: { userId: user.id, title: 'No version' },
      });
    await get(user, doc.id).expect(409);
  });
});
