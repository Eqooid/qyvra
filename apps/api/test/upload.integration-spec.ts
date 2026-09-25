import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@brainless/database';
import {
  Storage,
  STORAGE,
  LocalFileStorage,
  StorageError,
} from '@brainless/storage';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm, readdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { Server } from 'node:http';
import { imageReader as sharp } from '../src/infrastructure/storage/image-reader';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/configure-application';
import { settings } from '../src/configuration/configuration.module';
import { validateTestEnvironment } from './configuration.fixture';
import { PrismaService } from '../src/database/prisma.service';
import { LOG_SINK } from '../src/common/structured-logger';
import { createTestOwner, TestOwner } from './owner.fixture';
import { UploadRepository } from '../src/modules/documents/upload.repository';
import { pdfFixture } from './upload.fixture';

describe('Streaming upload PostgreSQL HTTP workflow', () => {
  let app: INestApplication,
    server: Server,
    db: PrismaService,
    storage: Storage,
    directory: string;
  const users: string[] = [];
  const logs: string[] = [];
  const owner = () => createTestOwner(db, users);
  const begin = (user: TestOwner, key: string = randomUUID()) =>
    request(server)
      .post('/api/v1/documents')
      .set('Cookie', user.cookie)
      .set('X-CSRF-Protection', '1')
      .set('Idempotency-Key', key);
  const upload = (
    user: TestOwner,
    bytes = pdfFixture(randomUUID()),
    key: string = randomUUID(),
  ) =>
    begin(user, key).field('title', 'Test document').attach('file', bytes, {
      filename: 'original.pdf',
      contentType: 'application/pdf',
    });
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'brainless-upload-test-'));
    storage = new LocalFileStorage(join(directory, 'objects'));
    const config = validateTestEnvironment({
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      UPLOAD_QPDF_PATH: process.env.UPLOAD_QPDF_PATH,
      UPLOAD_MAX_BYTES: '1048576',
      UPLOAD_MAX_PAGES: '2',
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
          await tx.category.deleteMany({ where });
          await tx.tag.deleteMany({ where });
          await tx.authSession.deleteMany({ where });
          await tx.user.deleteMany({ where: { id: { in: users } } });
        });
    } finally {
      await app?.close();
      if (directory) {
        expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
        expect(basename(directory).startsWith('brainless-upload-test-')).toBe(
          true,
        );
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
  it('requires auth, CSRF, UUID idempotency and multipart input', async () => {
    await request(server)
      .post('/api/v1/documents')
      .attach('file', pdfFixture(), 'a.pdf')
      .expect(401);
    const user = await owner();
    await request(server)
      .post('/api/v1/documents')
      .set('Cookie', user.cookie)
      .attach('file', pdfFixture(), 'a.pdf')
      .expect(403);
    await begin(user, 'bad').attach('file', pdfFixture(), 'a.pdf').expect(400);
    await begin(user).send({ title: 'JSON alternative' }).expect(415);
  });
  it('persists PDF and version 1 with correct states, checksum, safe associations and server keys', async () => {
    const user = await owner();
    const bytes = pdfFixture(randomUUID());
    const category = await db.client.category.create({
      data: { userId: user.id, name: 'Owned' },
    });
    const tag = await db.client.tag.create({
      data: { userId: user.id, name: 'Owned' },
    });
    const result = await begin(user)
      .field('title', '  Warranty  ')
      .field('categoryId', category.id)
      .field('tagIds', JSON.stringify([tag.id, tag.id.toUpperCase()]))
      .attach('file', bytes, {
        filename: 'original.pdf',
        contentType: 'application/pdf',
      })
      .expect(201);
    expect(result.body.data).toMatchObject({
      title: 'Warranty',
      status: 'UPLOADED',
      category: { id: category.id },
      tags: [{ id: tag.id }],
      version: {
        versionNumber: 1,
        originalFilename: 'original.pdf',
        mimeType: 'application/pdf',
        fileSize: bytes.length,
        pageCount: 1,
        extractionStatus: 'PENDING',
      },
    });
    const version = await db.client.documentVersion.findUniqueOrThrow({
      where: { id: result.body.data.version.id as string },
    });
    expect(version.checksumSha256).toBe(
      createHash('sha256').update(bytes).digest('hex'),
    );
    expect(version.storageKey).toBe(
      `documents/${user.id}/${version.documentId}/${version.id}/original.pdf`,
    );
    expect(await storage.exists(version.storageKey)).toBe(true);
    expect(JSON.stringify(result.body)).not.toMatch(
      /storageKey|checksum|userId|processing|objects|brainless-upload-test/,
    );
    await expect(
      db.client.documentVersion.update({
        where: { id: version.id },
        data: { originalFilename: 'changed.pdf' },
      }),
    ).rejects.toThrow();
    await expect(
      db.client.documentVersion.create({
        data: {
          ...version,
          id: randomUUID(),
          storageKey: `other/${randomUUID()}`,
        },
      }),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  });
  it.each(['jpeg', 'png'] as const)(
    'accepts synthetic %s files and sanitizes traversal filenames',
    async (format) => {
      const user = await owner();
      const bytes = await sharp({
        create: { width: 2, height: 2, channels: 3, background: 'red' },
      })
        .toFormat(format)
        .toBuffer();
      const result = await begin(user)
        .field('title', 'Image')
        .attach('file', bytes, {
          filename: `../../unsafe.${format}`,
          contentType: `image/${format}`,
        })
        .expect(201);
      expect(result.body.data.version).toMatchObject({
        versionNumber: 1,
        mimeType: `image/${format}`,
        pageCount: null,
      });
      const row = await db.client.documentVersion.findUniqueOrThrow({
        where: { id: result.body.data.version.id as string },
      });
      expect(row.storageKey).toMatch(
        new RegExp(`/original.${format === 'jpeg' ? 'jpg' : 'png'}$`),
      );
      expect(row.storageKey).not.toContain('unsafe');
    },
  );
  it('rejects missing, empty, multiple, oversize and malformed file bodies', async () => {
    const user = await owner();
    await begin(user).field('title', 'Missing').expect(400);
    await begin(user)
      .field('title', 'Empty')
      .attach('file', Buffer.alloc(0), 'a.pdf')
      .expect(400);
    await begin(user)
      .field('title', 'Multiple')
      .attach('file', pdfFixture(), 'a.pdf')
      .attach('file', pdfFixture(), 'b.pdf')
      .expect(400);
    const oversized = Buffer.alloc(1048577, 65);
    oversized.write('%PDF-1.4\n');
    await begin(user)
      .field('title', 'Large')
      .attach('file', oversized, {
        filename: 'a.pdf',
        contentType: 'application/pdf',
      })
      .expect(413);
    await upload(user, Buffer.from('%PDF-1.4\ntruncated')).expect(400);
    await upload(user, pdfFixture('pages', 3)).expect(400);
    expect(await db.client.document.count({ where: { userId: user.id } })).toBe(
      0,
    );
    expect(
      await db.client.documentUpload.count({ where: { userId: user.id } }),
    ).toBe(0);
  });
  it.each([
    ['wrong.exe', 'application/pdf', pdfFixture()],
    ['a.pdf', 'text/plain', pdfFixture()],
    ['a.png', 'image/png', pdfFixture()],
  ])(
    'rejects extension/MIME/signature mismatch %s %s',
    async (filename, contentType, bytes) => {
      await begin(await owner())
        .field('title', 'Mismatch')
        .attach('file', bytes as Buffer, {
          filename: filename as string,
          contentType: contentType as string,
        })
        .expect(415);
    },
  );
  it('rejects encrypted PDFs with a real parser', async () => {
    const original = join(directory, 'source.pdf'),
      encrypted = join(directory, 'encrypted.pdf');
    await writeFile(original, pdfFixture());
    await promisify(execFile)(process.env.UPLOAD_QPDF_PATH ?? 'qpdf', [
      '--encrypt',
      'fixture-password',
      'fixture-owner',
      '256',
      '--',
      original,
      encrypted,
    ]);
    await upload(await owner(), await readFile(encrypted)).expect(400);
  });
  it('validates metadata and rejects unsupported properties and foreign associations', async () => {
    const user = await owner(),
      foreign = await owner();
    const category = await db.client.category.create({
      data: { userId: foreign.id, name: 'Private' },
    });
    const tag = await db.client.tag.create({
      data: { userId: foreign.id, name: 'Private' },
    });
    for (const [field, value, status] of [
      ['categoryId', category.id, 404],
      ['tagIds', JSON.stringify([tag.id]), 404],
      ['userId', foreign.id, 400],
      ['documentDate', '2026-02-30', 400],
      ['tagIds', 'not-json', 400],
      ['status', 'READY', 400],
    ] as const)
      await begin(user)
        .field('title', 'Rejected')
        .field(field, value)
        .attach('file', pdfFixture(randomUUID()), 'a.pdf')
        .expect(status);
    await begin(user).attach('file', pdfFixture(), 'a.pdf').expect(400);
    expect(await db.client.document.count({ where: { userId: user.id } })).toBe(
      0,
    );
  });
  it('protects duplicate checksums concurrently while allowing different owners', async () => {
    const user = await owner(),
      foreign = await owner(),
      bytes = pdfFixture(randomUUID());
    const results = await Promise.all([
      upload(user, bytes),
      upload(user, bytes),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    await upload(foreign, bytes).expect(201);
    expect(await db.client.document.count({ where: { userId: user.id } })).toBe(
      1,
    );
  });
  it('replays exactly the original response and rejects changed requests and concurrent same-key uploads', async () => {
    const user = await owner(),
      bytes = pdfFixture(randomUUID()),
      key: string = randomUUID();
    const concurrent = await Promise.all([
      upload(user, bytes, key),
      upload(user, bytes, key),
    ]);
    expect(concurrent.map((result) => result.status).sort()).toEqual([
      201, 409,
    ]);
    const original = concurrent.find((result) => result.status === 201);
    expect((await upload(user, bytes, key).expect(201)).body.data).toEqual(
      original?.body.data,
    );
    await begin(user, key)
      .field('title', 'Changed')
      .attach('file', bytes, 'original.pdf')
      .expect(409);
    await upload(user, pdfFixture('different'), key).expect(409);
    expect(
      await db.client.documentVersion.count({ where: { userId: user.id } }),
    ).toBe(1);
  });
  it('persists optional description while keeping creation receipts and legacy fingerprints stable', async () => {
    const user = await owner();
    const bytes = pdfFixture(randomUUID());
    const key = randomUUID();
    const initial = await begin(user, key)
      .field('title', 'Test document')
      .field('description', '  Annual report  ')
      .attach('file', bytes, 'original.pdf')
      .expect(201);
    const id = initial.body.data.id as string;
    expect(initial.body.data).not.toHaveProperty('description');
    expect(
      (await db.client.document.findUniqueOrThrow({ where: { id } }))
        .description,
    ).toBe('Annual report');
    expect(
      (
        await request(server)
          .get(`/api/v1/documents/${id}`)
          .set('Cookie', user.cookie)
          .expect(200)
      ).body.data.description,
    ).toBe('Annual report');
    const replay = await begin(user, key)
      .field('title', 'Test document')
      .field('description', 'Annual report')
      .attach('file', bytes, 'original.pdf')
      .expect(201);
    expect(replay.body.data).toEqual(initial.body.data);
    await begin(user, key)
      .field('title', 'Test document')
      .field('description', 'Different report')
      .attach('file', bytes, 'original.pdf')
      .expect(409);
    expect(await db.client.document.count({ where: { userId: user.id } })).toBe(
      1,
    );
    const legacyBytes = pdfFixture(randomUUID());
    const legacyKey = randomUUID();
    const legacy = await upload(user, legacyBytes, legacyKey).expect(201);
    const legacyReceipt = await db.client.documentUpload.findUniqueOrThrow({
      where: {
        userId_scope_key: { userId: user.id, scope: 'create', key: legacyKey },
      },
    });
    expect(legacyReceipt.response).not.toHaveProperty('description');
    expect(legacyReceipt.fingerprint).toBe(
      createHash('sha256')
        .update(
          JSON.stringify({
            title: 'Test document',
            documentType: 'OTHER',
            issuer: null,
            referenceNumber: null,
            documentDate: null,
            expirationDate: null,
            categoryId: null,
            tagIds: [],
            filename: 'original.pdf',
            mime: 'application/pdf',
            size: legacyBytes.length,
            checksum: createHash('sha256').update(legacyBytes).digest('hex'),
          }),
        )
        .digest('hex'),
    );
    expect(
      (await upload(user, legacyBytes, legacyKey).expect(201)).body.data,
    ).toEqual(legacy.body.data);
    expect(
      (
        await begin(user, legacyKey)
          .field('title', 'Test document')
          .field('description', '   ')
          .attach('file', legacyBytes, 'original.pdf')
          .expect(201)
      ).body.data,
    ).toEqual(legacy.body.data);
    expect(
      (
        await db.client.document.findUniqueOrThrow({
          where: { id: legacy.body.data.id as string },
        })
      ).description,
    ).toBeNull();
    expect(await db.client.document.count({ where: { userId: user.id } })).toBe(
      2,
    );
  });
  it('rejects invalid upload descriptions', async () => {
    const user = await owner();
    for (const description of ['x'.repeat(2001), 'bad\u0000value'])
      await begin(user)
        .field('title', 'Test document')
        .field('description', description)
        .attach('file', pdfFixture(randomUUID()), 'original.pdf')
        .expect(400);
    expect(await db.client.document.count({ where: { userId: user.id } })).toBe(
      0,
    );
  });
  it('compensates failed persistence and does not create rows when storage fails', async () => {
    const user = await owner();
    const remove = jest.spyOn(storage, 'delete');
    jest
      .spyOn(app.get(UploadRepository), 'complete')
      .mockRejectedValueOnce(new Error('private database failure'));
    const failed = await upload(user).expect(503);
    expect(remove).toHaveBeenCalled();
    expect(JSON.stringify(failed.body)).not.toContain('private database');
    expect(await db.client.document.count({ where: { userId: user.id } })).toBe(
      0,
    );
    jest
      .spyOn(storage, 'save')
      .mockRejectedValueOnce(new StorageError('WRITE_FAILED'));
    await upload(user).expect(503);
    expect(await db.client.document.count({ where: { userId: user.id } })).toBe(
      0,
    );
    const rows = await readdir(join(directory, 'objects'), { recursive: true });
    expect(rows.some((row) => row.includes('.pending-'))).toBe(false);
  });
  it('replaces expired receiving reservations safely', async () => {
    const user = await owner(),
      key = randomUUID();
    const repository = app.get(UploadRepository);
    const reservation = await repository.reserve(user.id, key);
    await db.client.documentUpload.update({
      where: { userId_scope_key: { userId: user.id, scope: 'create', key } },
      data: { expiresAt: new Date(0) },
    });
    await upload(user, pdfFixture(randomUUID()), key).expect(201);
    const row = await db.client.documentUpload.findUniqueOrThrow({
      where: { userId_scope_key: { userId: user.id, scope: 'create', key } },
    });
    expect(row.attemptId).not.toBe(reservation.attemptId);
    expect(row.state).toBe('COMPLETED');
    await expect(
      db.client.documentUpload.update({
        where: { userId_scope_key: { userId: user.id, scope: 'create', key } },
        data: { fingerprint: null },
      }),
    ).rejects.toThrow();
  });
  it('cleans an interrupted multipart write and rejects duplicate metadata fields', async () => {
    const user = await owner();
    await begin(user)
      .set('Content-Type', 'multipart/form-data; boundary=broken')
      .send(
        Buffer.from(
          '--broken\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4\npartial',
        ),
      )
      .expect(400);
    await begin(user)
      .field('title', 'First')
      .field('title', 'Second')
      .attach('file', pdfFixture(), 'a.pdf')
      .expect(400);
    expect(await db.client.document.count({ where: { userId: user.id } })).toBe(
      0,
    );
    expect(
      (await readdir(join(directory, 'objects'), { recursive: true })).some(
        (row) => row.includes('.pending-'),
      ),
    ).toBe(false);
  });
  it('records cleanup failure for reconciliation without returning false success', async () => {
    const user = await owner();
    jest
      .spyOn(app.get(UploadRepository), 'complete')
      .mockRejectedValueOnce(new Error('private transaction'));
    jest
      .spyOn(storage, 'delete')
      .mockRejectedValueOnce(new StorageError('DELETE_FAILED'));
    await upload(user).expect(503);
    expect(await db.client.document.count({ where: { userId: user.id } })).toBe(
      0,
    );
    expect(
      logs.some((line) => line.includes('upload.storage_cleanup_failed')),
    ).toBe(true);
    expect(logs.join('\n')).not.toContain('private transaction');
  });
  it('recovers a committed response after acknowledgement failure without deleting its file', async () => {
    const user = await owner();
    const repository = app.get(UploadRepository);
    const complete = repository.complete.bind(repository);
    jest
      .spyOn(repository, 'complete')
      .mockImplementationOnce(async (...args) => {
        await complete(...args);
        throw new Error('lost commit acknowledgement');
      });
    const result = await upload(user).expect(201);
    const row = await db.client.documentVersion.findUniqueOrThrow({
      where: { id: result.body.data.version.id as string },
    });
    expect(await storage.exists(row.storageKey)).toBe(true);
  });
  it('preserves an uncertain object for reconciliation and logs no infrastructure details', async () => {
    const user = await owner();
    const repository = app.get(UploadRepository);
    jest
      .spyOn(repository, 'complete')
      .mockRejectedValueOnce(new Error('private SQL path'));
    jest
      .spyOn(repository, 'committed')
      .mockRejectedValueOnce(new Error('private connection'));
    const remove = jest.spyOn(storage, 'delete');
    const response = await upload(user).expect(503);
    expect(remove).not.toHaveBeenCalled();
    expect(
      logs.some((line) => line.includes('upload.commit_outcome_unknown')),
    ).toBe(true);
    expect(JSON.stringify(response.body)).not.toMatch(
      /private|storageKey|brainless-upload-test/,
    );
    expect(logs.join('\n')).not.toMatch(/private SQL path|private connection/);
  });
  it('rejects truncated images and malformed image headers', async () => {
    const user = await owner();
    for (const format of ['png', 'jpeg'] as const) {
      const bytes = await sharp({
        create: { width: 2, height: 2, channels: 3, background: 'blue' },
      })
        .toFormat(format)
        .toBuffer();
      await begin(user)
        .field('title', 'Truncated')
        .attach('file', bytes.subarray(0, bytes.length - 4), {
          filename: `a.${format}`,
          contentType: `image/${format}`,
        })
        .expect(400);
    }
    await begin(user)
      .field('title', 'Malformed')
      .attach(
        'file',
        Buffer.from('89504e470d0a1a0a0000000049454e44ae426082', 'hex'),
        { filename: 'a.png', contentType: 'image/png' },
      )
      .expect(400);
  });
});
