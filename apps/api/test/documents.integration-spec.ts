import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@brainless/database';
import { randomUUID } from 'node:crypto';
import { Server } from 'node:http';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/configure-application';
import { settings } from '../src/configuration/configuration.module';
import { validateTestEnvironment as validateEnvironment } from './configuration.fixture';
import { PrismaService } from '../src/database/prisma.service';
import { LOG_SINK } from '../src/common/structured-logger';
import { createTestOwner, TestOwner } from './owner.fixture';

describe('Document metadata with PostgreSQL', () => {
  let app: INestApplication;
  let server: Server;
  let db: PrismaService;
  const users: string[] = [];
  const owner = () => createTestOwner(db, users);
  const fixtureDocument = (
    user: TestOwner,
    data: Partial<Prisma.DocumentUncheckedCreateInput> = {},
  ) =>
    db.client.document.create({
      data: { title: 'Fixture document', ...data, userId: user.id },
    });
  const get = (user: TestOwner, path = '') =>
    request(server).get(`/api/v1/documents${path}`).set('Cookie', user.cookie);
  const edit = (user: TestOwner, id: string, body: object) =>
    request(server)
      .patch(`/api/v1/documents/${id}`)
      .set('Cookie', user.cookie)
      .set('X-CSRF-Protection', '1')
      .send(body);
  const act = (
    user: TestOwner,
    id: string,
    action: 'archive' | 'restore' | 'delete',
  ) =>
    request(server)
      [action === 'delete' ? 'delete' : 'post'](
        `/api/v1/documents/${id}${action === 'delete' ? '' : `/${action}`}`,
      )
      .set('Cookie', user.cookie)
      .set('X-CSRF-Protection', '1');
  beforeAll(async () => {
    const config = validateEnvironment({
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL,
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
  });
  afterAll(async () => {
    try {
      if (db)
        await db.client.$transaction(async (tx) => {
          const where = { userId: { in: users } };
          await tx.document.deleteMany({ where });
          await tx.category.deleteMany({ where });
          await tx.tag.deleteMany({ where });
          await tx.authSession.deleteMany({ where });
          await tx.user.deleteMany({ where: { id: { in: users } } });
        });
    } finally {
      await app?.close();
    }
  });
  it('returns owned safe metadata and stable creation-time/UUID pages, hiding deleted and foreign rows', async () => {
    const user = await owner();
    const foreign = await owner();
    const time = new Date('2026-01-01T00:00:00.000Z');
    const rows = await Promise.all([
      fixtureDocument(user, { createdAt: time }),
      fixtureDocument(user, { createdAt: time }),
      fixtureDocument(user, { createdAt: time }),
    ]);
    await fixtureDocument(foreign, { createdAt: time });
    await fixtureDocument(user, { deletedAt: new Date() });
    const first = await get(user).query({ limit: 2 }).expect(200);
    expect(first.body.data).toHaveLength(2);
    expect(first.body.meta.hasMore).toBe(true);
    const second = await get(user)
      .query({ limit: 2, cursor: first.body.meta.nextCursor as string })
      .expect(200);
    expect(second.body.meta).toMatchObject({
      nextCursor: null,
      hasMore: false,
    });
    const ids = [
      ...(first.body.data as { id: string }[]),
      ...(second.body.data as { id: string }[]),
    ].map((row) => row.id);
    expect(ids).toEqual(
      rows
        .map((row) => row.id)
        .sort()
        .reverse(),
    );
    const ascending = await get(user).query({ sort: 'createdAt' }).expect(200);
    expect(
      (ascending.body.data as { id: string }[]).map((row) => row.id),
    ).toEqual([...ids].reverse());
    await get(user)
      .query({
        cursor: first.body.meta.nextCursor as string,
        sort: 'createdAt',
      })
      .expect(400);
    const detail = await get(user, `/${rows[0].id}`).expect(200);
    expect(Object.keys(detail.body.data).sort()).toEqual(
      [
        'id',
        'title',
        'documentType',
        'status',
        'issuer',
        'referenceNumber',
        'documentDate',
        'expirationDate',
        'verifiedSummary',
        'isArchived',
        'createdAt',
        'updatedAt',
        'deletedAt',
        'category',
        'tags',
      ].sort(),
    );
    expect(detail.body.data).toMatchObject({
      status: 'UPLOADED',
      category: null,
      tags: [],
      verifiedSummary: null,
    });
  });
  it('supports literal metadata search and combines owned type/status/category/tag/archive/date filters', async () => {
    const user = await owner();
    const category = await db.client.category.create({
      data: { userId: user.id, name: 'Owned' },
    });
    const tag = await db.client.tag.create({
      data: { userId: user.id, name: 'Owned' },
    });
    const row = await fixtureDocument(user, {
      title: '100% Warranty',
      categoryId: category.id,
      documentType: 'WARRANTY',
      issuer: 'Example issuer',
      referenceNumber: 'Ref_42',
      documentDate: new Date('2026-01-01'),
      expirationDate: new Date('2027-01-01'),
    });
    await db.client.documentTag.create({
      data: { documentId: row.id, tagId: tag.id, userId: user.id },
    });
    await fixtureDocument(user, { title: 'Other' });
    const filtered = await get(user)
      .query({
        q: '%',
        documentType: 'WARRANTY',
        status: 'UPLOADED',
        categoryId: category.id,
        tagId: tag.id,
        archived: false,
        dateFrom: '2026-01-01',
        dateTo: '2026-01-01',
        expirationFrom: '2027-01-01',
        expirationTo: '2027-01-01',
      })
      .expect(200);
    expect(
      (filtered.body.data as { id: string }[]).map((item) => item.id),
    ).toEqual([row.id]);
    expect(filtered.body.data[0]).toMatchObject({
      category: { id: category.id },
      tags: [{ id: tag.id }],
      documentDate: '2026-01-01',
    });
    for (const q of ['EXAMPLE ISSUER', 'Ref_'])
      expect((await get(user).query({ q }).expect(200)).body.data).toHaveLength(
        1,
      );
    await get(user)
      .query({ dateFrom: '2027-01-01', dateTo: '2026-01-01' })
      .expect(400);
    await act(user, row.id, 'archive').expect(200);
    expect(
      (await get(user).query({ archived: true }).expect(200)).body.data,
    ).toHaveLength(1);
    expect(
      (await get(user).query({ archived: false }).expect(200)).body.data,
    ).toHaveLength(1);
  });
  it('updates metadata and owned relationships atomically with deduplicated tags and explicit nulls', async () => {
    const user = await owner();
    const row = await fixtureDocument(user);
    const category = await db.client.category.create({
      data: { userId: user.id, name: 'Owned' },
    });
    const tag = await db.client.tag.create({
      data: { userId: user.id, name: 'Owned' },
    });
    const result = await edit(user, row.id, {
      title: '  Renamed  ',
      issuer: 'Issuer',
      referenceNumber: 'Ref',
      documentType: 'RECEIPT',
      documentDate: '2026-01-01',
      expirationDate: '2027-01-01',
      categoryId: category.id,
      tagIds: [tag.id, tag.id.toUpperCase()],
    }).expect(200);
    expect(result.body.data).toMatchObject({
      title: 'Renamed',
      category: { id: category.id },
      tags: [{ id: tag.id }],
    });
    expect(
      await db.client.documentTag.count({ where: { documentId: row.id } }),
    ).toBe(1);
    await edit(user, row.id, { documentDate: '2028-01-01' }).expect(400);
    const cleared = await edit(user, row.id, {
      issuer: null,
      referenceNumber: null,
      documentDate: null,
      expirationDate: null,
      categoryId: null,
      tagIds: [],
    }).expect(200);
    expect(cleared.body.data).toMatchObject({
      title: 'Renamed',
      category: null,
      tags: [],
      issuer: null,
      documentDate: null,
    });
  });
  it('rejects foreign associations without changing metadata or joins', async () => {
    const user = await owner();
    const foreign = await owner();
    const row = await fixtureDocument(user);
    const category = await db.client.category.create({
      data: { userId: foreign.id, name: 'Private' },
    });
    const tag = await db.client.tag.create({
      data: { userId: foreign.id, name: 'Private' },
    });
    for (const fields of [
      { categoryId: category.id },
      { tagIds: [tag.id] },
      { categoryId: randomUUID() },
      { tagIds: [randomUUID()] },
    ])
      await edit(user, row.id, { title: 'Attack', ...fields }).expect(404);
    expect(
      await db.client.document.findUniqueOrThrow({ where: { id: row.id } }),
    ).toEqual(row);
    expect(
      await db.client.documentTag.count({ where: { documentId: row.id } }),
    ).toBe(0);
  });
  it('rolls back metadata when join replacement fails inside a real transaction', async () => {
    const user = await owner();
    const row = await fixtureDocument(user);
    const tag = await db.client.tag.create({
      data: { userId: user.id, name: 'Owned' },
    });
    const original = db.client.$transaction.bind(db.client);
    const spy = jest.spyOn(db.client, '$transaction').mockImplementationOnce(((
      work: (tx: Prisma.TransactionClient) => Promise<unknown>,
    ) =>
      original(async (tx) => {
        tx.documentTag.createMany = jest
          .fn()
          .mockRejectedValue(new Error('simulated join failure'));
        return work(tx);
      })) as typeof db.client.$transaction);
    try {
      await edit(user, row.id, {
        title: 'Must roll back',
        tagIds: [tag.id],
      }).expect(500);
    } finally {
      spy.mockRestore();
    }
    expect(
      await db.client.document.findUniqueOrThrow({ where: { id: row.id } }),
    ).toEqual(row);
  });
  it('serializes concurrent partial updates so merged date validation cannot be bypassed', async () => {
    const user = await owner();
    const row = await fixtureDocument(user, {
      documentDate: new Date('2026-01-01'),
      expirationDate: new Date('2026-12-31'),
    });
    const results = await Promise.all([
      edit(user, row.id, { documentDate: '2026-09-01' }),
      edit(user, row.id, { expirationDate: '2026-03-01' }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 400]);
  });
  it('archives, deletes, restores and repeats actions without losing metadata or joins', async () => {
    const user = await owner();
    const row = await fixtureDocument(user);
    const tag = await db.client.tag.create({
      data: { userId: user.id, name: 'Owned' },
    });
    await db.client.documentTag.create({
      data: { userId: user.id, documentId: row.id, tagId: tag.id },
    });
    const archived = await act(user, row.id, 'archive').expect(200);
    expect(archived.body.data).toMatchObject({
      status: 'ARCHIVED',
      isArchived: true,
    });
    expect((await act(user, row.id, 'archive').expect(200)).body.data).toEqual(
      archived.body.data,
    );
    const deleted = await act(user, row.id, 'delete').expect(200);
    expect(deleted.body.data.deletedAt).not.toBeNull();
    expect((await act(user, row.id, 'delete').expect(200)).body.data).toEqual(
      deleted.body.data,
    );
    await get(user, `/${row.id}`).expect(404);
    await edit(user, row.id, { title: 'Hidden' }).expect(404);
    await act(user, row.id, 'archive').expect(404);
    expect((await get(user).expect(200)).body.data).toEqual([]);
    const restored = await act(user, row.id, 'restore').expect(200);
    expect(restored.body.data).toMatchObject({
      title: row.title,
      status: 'UPLOADED',
      isArchived: false,
      deletedAt: null,
      tags: [{ id: tag.id }],
    });
    expect((await act(user, row.id, 'restore').expect(200)).body.data).toEqual(
      restored.body.data,
    );
    await act(user, row.id, 'delete').expect(200);
    await act(user, row.id, 'restore').expect(200);
    for (const status of ['PROCESSING', 'DELETING']) {
      const blocked = await fixtureDocument(user, { status });
      for (const action of ['archive', 'restore', 'delete'] as const)
        await act(user, blocked.id, action).expect(409);
    }
  });
  it('makes missing and foreign documents indistinguishable for every operation', async () => {
    const user = await owner();
    const foreign = await owner();
    const row = await fixtureDocument(foreign);
    for (const id of [row.id, randomUUID()]) {
      await get(user, `/${id}`).expect(404);
      await edit(user, id, { title: 'Attack' }).expect(404);
      for (const action of ['archive', 'restore', 'delete'] as const)
        await act(user, id, action).expect(404);
    }
    expect(
      await db.client.document.findUniqueOrThrow({ where: { id: row.id } }),
    ).toEqual(row);
    expect((await get(user).expect(200)).body.data).toEqual([]);
  });
  it('enforces owner-composite foreign keys, join uniqueness, date and archive constraints', async () => {
    const user = await owner();
    const foreign = await owner();
    const row = await fixtureDocument(user);
    const category = await db.client.category.create({
      data: { userId: foreign.id, name: 'Private' },
    });
    const privateTag = await db.client.tag.create({
      data: { userId: foreign.id, name: 'Private' },
    });
    await expect(
      db.client.document.update({
        where: { id: row.id },
        data: { categoryId: category.id },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    for (const userId of [user.id, foreign.id])
      await expect(
        db.client.documentTag.create({
          data: { documentId: row.id, tagId: privateTag.id, userId },
        }),
      ).rejects.toMatchObject({ code: 'P2003' });
    const tag = await db.client.tag.create({
      data: { userId: user.id, name: 'Owned' },
    });
    const data = { userId: user.id, documentId: row.id, tagId: tag.id };
    await db.client.documentTag.create({ data });
    await expect(db.client.documentTag.create({ data })).rejects.toMatchObject({
      code: 'P2002',
    });
    await expect(
      fixtureDocument(user, { status: 'ARCHIVED', isArchived: false }),
    ).rejects.toBeDefined();
    await expect(
      fixtureDocument(user, {
        documentDate: new Date('2027-01-01'),
        expirationDate: new Date('2026-01-01'),
      }),
    ).rejects.toBeDefined();
    await db.client.document.delete({ where: { id: row.id } });
    expect(
      await db.client.documentTag.count({ where: { documentId: row.id } }),
    ).toBe(0);
    expect(
      await db.client.tag.findUnique({ where: { id: tag.id } }),
    ).not.toBeNull();
  });
  it('restricts category deletion while referenced and cascades tag deletion only to join rows', async () => {
    const user = await owner();
    const category = await db.client.category.create({
      data: { userId: user.id, name: 'Owned' },
    });
    const tag = await db.client.tag.create({
      data: { userId: user.id, name: 'Owned' },
    });
    const row = await fixtureDocument(user, { categoryId: category.id });
    await db.client.documentTag.create({
      data: { documentId: row.id, tagId: tag.id, userId: user.id },
    });
    await request(server)
      .delete(`/api/v1/categories/${category.id}`)
      .set('Cookie', user.cookie)
      .set('X-CSRF-Protection', '1')
      .expect(409);
    await act(user, row.id, 'delete').expect(200);
    await request(server)
      .delete(`/api/v1/categories/${category.id}`)
      .set('Cookie', user.cookie)
      .set('X-CSRF-Protection', '1')
      .expect(409);
    await request(server)
      .delete(`/api/v1/tags/${tag.id}`)
      .set('Cookie', user.cookie)
      .set('X-CSRF-Protection', '1')
      .expect(200);
    expect(
      await db.client.documentTag.count({ where: { documentId: row.id } }),
    ).toBe(0);
    expect(
      await db.client.document.findUnique({ where: { id: row.id } }),
    ).not.toBeNull();
    expect(
      await db.client.category.findUnique({ where: { id: category.id } }),
    ).not.toBeNull();
  });
});
