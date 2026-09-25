import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@brainless/database';
import { createHash, randomUUID } from 'node:crypto';
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
  const fixtureVersion = (
    user: TestOwner,
    documentId: string,
    versionNumber: number,
    createdAt: Date,
    originalFilename = `report-v${versionNumber}.pdf`,
    mimeType = 'application/pdf',
    fileSize = versionNumber * 100,
  ) =>
    db.client.documentVersion.create({
      data: {
        userId: user.id,
        documentId,
        versionNumber,
        originalFilename,
        storageKey: `test/${randomUUID()}`,
        mimeType,
        fileSize,
        pageCount: mimeType === 'application/pdf' ? 1 : null,
        checksumSha256: createHash('sha256').update(randomUUID()).digest('hex'),
        createdAt,
      },
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
        'description',
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
        'currentVersion',
        'category',
        'tags',
      ].sort(),
    );
    expect(detail.body.data).toMatchObject({
      status: 'UPLOADED',
      description: null,
      category: null,
      tags: [],
      verifiedSummary: null,
      currentVersion: null,
    });
  });
  it('returns only each owned highest-numbered version across list, detail and PATCH', async () => {
    const user = await owner();
    const foreign = await owner();
    const first = await fixtureDocument(user, { description: 'Original' });
    const second = await fixtureDocument(user);
    const other = await fixtureDocument(foreign);
    await fixtureVersion(
      user,
      first.id,
      1,
      new Date('2026-07-01T00:00:00.000Z'),
    );
    const current = await fixtureVersion(
      user,
      first.id,
      2,
      new Date('2026-06-01T00:00:00.000Z'),
    );
    const secondCurrent = await fixtureVersion(
      user,
      second.id,
      1,
      new Date('2026-05-01T00:00:00.000Z'),
    );
    const foreignVersion = await fixtureVersion(
      foreign,
      other.id,
      1,
      new Date('2026-08-01T00:00:00.000Z'),
    );
    const summary = {
      id: current.id,
      versionNumber: 2,
      originalFilename: 'report-v2.pdf',
      mimeType: 'application/pdf',
      fileSize: 200,
      createdAt: '2026-06-01T00:00:00.000Z',
    };
    const page = await get(user).query({ limit: 1 }).expect(200);
    const next = await get(user)
      .query({ limit: 1, cursor: page.body.meta.nextCursor as string })
      .expect(200);
    const items = [...page.body.data, ...next.body.data] as Array<{
      id: string;
      currentVersion: unknown;
    }>;
    expect(items).toHaveLength(2);
    expect(items.find((item) => item.id === first.id)?.currentVersion).toEqual(
      summary,
    );
    expect(items.find((item) => item.id === second.id)?.currentVersion).toEqual(
      {
        ...summary,
        id: secondCurrent.id,
        versionNumber: 1,
        originalFilename: 'report-v1.pdf',
        fileSize: 100,
        createdAt: '2026-05-01T00:00:00.000Z',
      },
    );
    expect(JSON.stringify(items)).not.toContain(foreignVersion.id);
    expect(JSON.stringify(items)).not.toMatch(
      /storageKey|checksumSha256|userId/,
    );
    const detail = await get(user, `/${first.id}`).expect(200);
    expect(detail.body.data.currentVersion).toEqual(summary);
    await get(user, `/${other.id}`).expect(404);
    await edit(foreign, first.id, { description: 'No access' }).expect(404);
    const updated = await edit(user, first.id, {
      description: 'Changed',
    }).expect(200);
    expect(updated.body.data).toMatchObject({
      description: 'Changed',
      currentVersion: summary,
    });
    const cleared = await edit(user, first.id, { description: null }).expect(
      200,
    );
    expect(cleared.body.data).toMatchObject({
      description: null,
      currentVersion: summary,
    });
    expect(
      await db.client.documentVersion.count({
        where: { documentId: first.id },
      }),
    ).toBe(2);
    await act(user, first.id, 'archive').expect(200);
    expect(
      (await get(user, `/${first.id}`).expect(200)).body.data.currentVersion,
    ).toEqual(summary);
  });
  it('reads and patches owned descriptions, preserving omission and clearing with null', async () => {
    const user = await owner();
    const foreign = await owner();
    const row = await fixtureDocument(user, { description: 'Original' });
    expect(
      (await get(user, `/${row.id}`).expect(200)).body.data.description,
    ).toBe('Original');
    const listed = await get(user).expect(200);
    expect(
      listed.body.data.find((item: { id: string }) => item.id === row.id)
        .description,
    ).toBe('Original');
    expect(
      (await edit(user, row.id, { title: 'Renamed' }).expect(200)).body.data
        .description,
    ).toBe('Original');
    expect(
      (await edit(user, row.id, { description: '  Updated  ' }).expect(200))
        .body.data.description,
    ).toBe('Updated');
    expect(
      (await db.client.document.findUniqueOrThrow({ where: { id: row.id } }))
        .description,
    ).toBe('Updated');
    await edit(foreign, row.id, { description: 'Unauthorized' }).expect(404);
    expect(
      (await edit(user, row.id, { description: null }).expect(200)).body.data
        .description,
    ).toBeNull();
    expect(
      (await get(user, `/${row.id}`).expect(200)).body.data.description,
    ).toBeNull();
    expect(
      (await edit(user, row.id, { description: '   ' }).expect(200)).body.data
        .description,
    ).toBeNull();
    for (const description of ['x'.repeat(2001), 'bad\u0000value', 42])
      await edit(user, row.id, { description }).expect(400);
    expect(
      (await db.client.document.findUniqueOrThrow({ where: { id: row.id } }))
        .description,
    ).toBeNull();
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
  it('filters current file, all requested tags and UTC document timestamps before pagination', async () => {
    const user = await owner();
    const foreign = await owner();
    const [firstTag, secondTag, extraTag] = await Promise.all(
      ['First', 'Second', 'Extra'].map((name) =>
        db.client.tag.create({ data: { userId: user.id, name } }),
      ),
    );
    const old = new Date('2025-12-31T23:59:59.000Z');
    const created = new Date('2026-01-15T12:00:00.000Z');
    const updated = new Date('2026-03-02T12:00:00.000Z');
    const target = await fixtureDocument(user, {
      createdAt: created,
      updatedAt: updated,
    });
    const partial = await fixtureDocument(user, {
      createdAt: old,
      updatedAt: old,
    });
    const other = await fixtureDocument(foreign, {
      createdAt: created,
      updatedAt: updated,
    });
    await db.client.documentTag.createMany({
      data: [
        [target.id, firstTag.id],
        [target.id, secondTag.id],
        [target.id, extraTag.id],
        [partial.id, firstTag.id],
      ].map(([documentId, tagId]) => ({ documentId, tagId, userId: user.id })),
    });
    await fixtureVersion(
      user,
      target.id,
      1,
      new Date('2026-05-01T00:00:00.000Z'),
      'old-name.png',
      'image/png',
    );
    const current = await fixtureVersion(
      user,
      target.id,
      2,
      new Date('2026-04-01T00:00:00.000Z'),
      'Final_%Report.pdf',
    );
    await fixtureVersion(
      user,
      partial.id,
      1,
      new Date('2026-04-01T00:00:00.000Z'),
      'Final_%Report.pdf',
    );
    await fixtureVersion(
      foreign,
      other.id,
      1,
      new Date('2026-04-01T00:00:00.000Z'),
      'Final_%Report.pdf',
    );
    const ids = async (query: Record<string, unknown>) =>
      (
        (await get(user).query(query).expect(200)).body.data as { id: string }[]
      ).map((row) => row.id);
    expect(await ids({ filename: 'final_%report' })).toEqual(
      expect.arrayContaining([target.id, partial.id]),
    );
    expect(await ids({ filename: 'old-name' })).toEqual([]);
    expect(await ids({ filename: 'unrelated' })).toEqual([]);
    expect(await ids({ mimeType: 'application/pdf' })).toEqual(
      expect.arrayContaining([target.id, partial.id]),
    );
    expect(await ids({ mimeType: 'image/png' })).toEqual([]);
    expect(await ids({ tagIds: firstTag.id })).toEqual(
      expect.arrayContaining([target.id, partial.id]),
    );
    expect(await ids({ tagIds: `${firstTag.id},${secondTag.id}` })).toEqual([
      target.id,
    ]);
    expect(
      await ids({ tagIds: `${firstTag.id},${secondTag.id},${extraTag.id}` }),
    ).toEqual([target.id]);
    expect(await ids({ tagIds: `${firstTag.id},${randomUUID()}` })).toEqual([]);
    const foreignTag = await db.client.tag.create({
      data: { userId: foreign.id, name: 'First' },
    });
    expect(await ids({ tagIds: foreignTag.id })).toEqual([]);
    expect(await ids({ createdFrom: '2026-01-15' })).toEqual([target.id]);
    expect(await ids({ createdTo: '2025-12-31' })).toEqual([partial.id]);
    expect(
      await ids({ createdFrom: '2026-01-15', createdTo: '2026-01-15' }),
    ).toEqual([target.id]);
    expect(await ids({ updatedFrom: '2026-03-02' })).toEqual([target.id]);
    expect(await ids({ updatedTo: '2025-12-31' })).toEqual([partial.id]);
    expect(
      await ids({ updatedFrom: '2026-03-02', updatedTo: '2026-03-02' }),
    ).toEqual([target.id]);
    const combined = await get(user)
      .query({
        filename: 'final_%report',
        mimeType: 'application/pdf',
        tagIds: `${firstTag.id},${secondTag.id}`,
        createdFrom: '2026-01-15',
        createdTo: '2026-01-15',
        updatedFrom: '2026-03-02',
        updatedTo: '2026-03-02',
      })
      .expect(200);
    expect(combined.body.data.map((row: { id: string }) => row.id)).toEqual([
      target.id,
    ]);
    expect(combined.body.data[0].currentVersion).toMatchObject({
      id: current.id,
      originalFilename: 'Final_%Report.pdf',
    });
    expect(JSON.stringify(combined.body)).not.toContain(other.id);
    for (const invalid of [
      { tagIds: 'bad' },
      { tagIds: `${firstTag.id},${firstTag.id}` },
      { tagId: firstTag.id, tagIds: secondTag.id },
      { mimeType: 'text/plain' },
      { filename: '  ' },
      { createdFrom: '2026-02-30' },
      { updatedTo: 'tomorrow' },
      { createdFrom: '2026-12-31', createdTo: '2026-01-01' },
      { updatedFrom: '2026-12-31', updatedTo: '2026-01-01' },
    ])
      await get(user).query(invalid).expect(400);
    await get(user)
      .query({ tagIds: [firstTag.id, secondTag.id] })
      .expect(400);
  });
  it('paginates the filtered dataset without duplicates or a fabricated total count', async () => {
    const user = await owner();
    const recent = new Date('2026-06-01T12:00:00.000Z');
    const old = new Date('2025-06-01T12:00:00.000Z');
    await Promise.all(
      Array.from({ length: 8 }, () =>
        fixtureDocument(user, { createdAt: recent }),
      ),
    );
    await Promise.all(
      Array.from({ length: 12 }, () =>
        fixtureDocument(user, { createdAt: old }),
      ),
    );
    const first = await get(user)
      .query({ createdFrom: '2026-01-01', limit: 5 })
      .expect(200);
    expect(first.body.data).toHaveLength(5);
    expect(first.body.meta).toMatchObject({ hasMore: true });
    expect(first.body.meta).not.toHaveProperty('totalItems');
    const second = await get(user)
      .query({
        createdFrom: '2026-01-01',
        limit: 5,
        cursor: first.body.meta.nextCursor as string,
      })
      .expect(200);
    expect(second.body.data).toHaveLength(3);
    expect(second.body.meta).toMatchObject({
      hasMore: false,
      nextCursor: null,
    });
    const ids = [...first.body.data, ...second.body.data].map(
      (row: { id: string }) => row.id,
    );
    expect(new Set(ids).size).toBe(8);
  });
  it('treats filename wildcard characters literally and includes archived matches', async () => {
    const user = await owner();
    const literal = await fixtureDocument(user);
    const lookalike = await fixtureDocument(user);
    await fixtureVersion(
      user,
      literal.id,
      1,
      new Date('2026-01-01T00:00:00.000Z'),
      'Plan_%Done.pdf',
    );
    await fixtureVersion(
      user,
      lookalike.id,
      1,
      new Date('2026-01-01T00:00:00.000Z'),
      'PlanXYDone.pdf',
    );
    const matching = async () =>
      (await get(user).query({ filename: '_%' }).expect(200)).body.data.map(
        (row: { id: string }) => row.id,
      );
    expect(await matching()).toEqual([literal.id]);
    await act(user, literal.id, 'archive').expect(200);
    expect(await matching()).toEqual([literal.id]);
    expect(
      (await get(user).query({ filename: '_%', archived: false }).expect(200))
        .body.data,
    ).toEqual([]);
  });
  it('traverses every allowed sort with tied values and no duplicate or skipped documents', async () => {
    const user = await owner();
    const foreign = await owner();
    const created = [
      '2026-06-03',
      '2026-06-03',
      '2026-06-03',
      '2026-06-02',
      '2026-06-02',
      '2026-06-01',
      '2026-06-01',
    ];
    const updated = [
      '2026-07-02',
      '2026-07-02',
      '2026-07-01',
      '2026-07-02',
      '2026-07-01',
      '2026-07-01',
      '2026-07-01',
    ];
    const titles = [
      'Alpha',
      'Alpha',
      'beta',
      'Delta',
      'Alpha',
      'beta',
      'Alpha',
    ];
    const sizes: (number | null)[] = [100, 200, 200, null, null, 100, null];
    const rows = [];
    for (let index = 0; index < titles.length; index++)
      rows.push(
        await fixtureDocument(user, {
          title: titles[index],
          createdAt: new Date(`${created[index]}T12:00:00.000Z`),
          updatedAt: new Date(`${updated[index]}T12:00:00.000Z`),
        }),
      );
    await fixtureDocument(foreign, {
      title: 'Alpha',
      createdAt: rows[0].createdAt,
      updatedAt: rows[0].updatedAt,
    });
    await fixtureVersion(
      user,
      rows[0].id,
      1,
      new Date(),
      'old.pdf',
      'application/pdf',
      500,
    );
    await fixtureVersion(
      user,
      rows[0].id,
      2,
      new Date(),
      'report.pdf',
      'application/pdf',
      100,
    );
    for (const index of [1, 2, 5])
      await fixtureVersion(
        user,
        rows[index].id,
        1,
        new Date(),
        'report.pdf',
        'application/pdf',
        sizes[index] as number,
      );
    await fixtureDocument(user, { title: 'Deleted', deletedAt: new Date() });
    const sorts = [
      '-createdAt',
      'createdAt',
      '-updatedAt',
      'title',
      '-title',
      '-fileSize',
    ] as const;
    for (const sort of sorts) {
      const expected = rows
        .map((row, index) => ({ row, index }))
        .sort((a, b) => {
          const av = sort.includes('createdAt')
            ? a.row.createdAt.getTime()
            : sort === '-updatedAt'
              ? a.row.updatedAt.getTime()
              : sort.includes('title')
                ? a.row.title
                : sizes[a.index];
          const bv = sort.includes('createdAt')
            ? b.row.createdAt.getTime()
            : sort === '-updatedAt'
              ? b.row.updatedAt.getTime()
              : sort.includes('title')
                ? b.row.title
                : sizes[b.index];
          if (av === null || bv === null) {
            if (av === null && bv !== null) return 1;
            if (bv === null && av !== null) return -1;
          }
          const comparison = av! < bv! ? -1 : av! > bv! ? 1 : 0;
          const direction = sort.startsWith('-') ? -1 : 1;
          return comparison
            ? direction * comparison
            : direction * (a.row.id < b.row.id ? -1 : 1);
        })
        .map(({ row }) => row.id);
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
        const result = await get(user)
          .query({ sort, limit: 2, ...(cursor ? { cursor } : {}) })
          .expect(200);
        const page = (result.body.data as { id: string }[]).map(
          (item) => item.id,
        );
        seen.push(...page);
        if (!result.body.meta.hasMore) {
          expect(result.body.meta.nextCursor).toBeNull();
          break;
        }
        cursor = result.body.meta.nextCursor as string;
        expect(cursor).toEqual(expect.any(String));
      }
      expect(seen).toEqual(expected);
      expect(new Set(seen).size).toBe(rows.length);
    }
    const first = await get(user)
      .query({ sort: 'title', limit: 2 })
      .expect(200);
    await get(user)
      .query({
        sort: '-title',
        limit: 2,
        cursor: first.body.meta.nextCursor as string,
      })
      .expect(400);
    await get(foreign)
      .query({ sort: 'title', cursor: first.body.meta.nextCursor as string })
      .expect(200);
  });
  it('combines all-of tags and current-file filters with file-size cursors', async () => {
    const user = await owner();
    const tags = await Promise.all(
      ['One', 'Two'].map((name) =>
        db.client.tag.create({ data: { userId: user.id, name } }),
      ),
    );
    const rows = [];
    for (const size of [100, 200, 300]) {
      const row = await fixtureDocument(user, {
        createdAt: new Date('2026-01-15T12:00:00.000Z'),
        updatedAt: new Date('2026-02-15T12:00:00.000Z'),
      });
      rows.push({ row, size });
      await fixtureVersion(
        user,
        row.id,
        1,
        new Date(),
        'report.pdf',
        'application/pdf',
        size,
      );
      await db.client.documentTag.createMany({
        data: tags.map((tag) => ({
          userId: user.id,
          documentId: row.id,
          tagId: tag.id,
        })),
      });
    }
    const query = {
      filename: 'report',
      mimeType: 'application/pdf',
      tagIds: tags.map((tag) => tag.id).join(','),
      createdFrom: '2026-01-15',
      createdTo: '2026-01-15',
      updatedFrom: '2026-02-15',
      updatedTo: '2026-02-15',
      sort: '-fileSize',
      limit: 1,
    };
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 3; page++) {
      const result = await get(user)
        .query({ ...query, ...(cursor ? { cursor } : {}) })
        .expect(200);
      ids.push(result.body.data[0].id as string);
      cursor = result.body.meta.nextCursor as string | null;
      if (page < 2) expect(cursor).toEqual(expect.any(String));
      else expect(cursor).toBeNull();
    }
    expect(ids).toEqual(rows.reverse().map(({ row }) => row.id));
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
