import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
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

describe('Tags with PostgreSQL', () => {
  let app: INestApplication;
  let server: Server;
  let db: PrismaService;
  const users: string[] = [];
  const owner = () => createTestOwner(db, users);
  const mutate = (
    user: TestOwner,
    method: 'post' | 'patch' | 'delete',
    suffix = '',
  ) =>
    request(server)
      [method](`/api/v1/tags${suffix}`)
      .set('Cookie', user.cookie)
      .set('X-CSRF-Protection', '1');
  const list = (user: TestOwner) =>
    request(server).get('/api/v1/tags').set('Cookie', user.cookie);
  beforeAll(async () => {
    const config = validateEnvironment({
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL,
    });
    const fixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(settings.KEY)
      .useValue(config)
      .overrideProvider(LOG_SINK)
      .useValue(() => undefined)
      .compile();
    app = fixture.createNestApplication();
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
          await tx.tag.deleteMany({ where });
          await tx.authSession.deleteMany({ where });
          await tx.user.deleteMany({ where: { id: { in: users } } });
        });
    } finally {
      await app?.close();
    }
  });
  it('normalizes names, preserves safe display fields, and permits cross-owner reuse', async () => {
    const user = await owner();
    const foreign = await owner();
    const response = await mutate(user, 'post')
      .set('userId', foreign.id)
      .send({ name: '  Ｆｉｎａｎｃｅ ' })
      .expect(201);
    expect(response.body.data.name).toBe('Finance');
    expect(Object.keys(response.body.data).sort()).toEqual(
      ['id', 'name', 'createdAt', 'updatedAt'].sort(),
    );
    expect(
      (
        await db.client.tag.findUniqueOrThrow({
          where: { id: response.body.data.id as string },
        })
      ).userId,
    ).toBe(user.id);
    for (const name of ['finance', 'Finance', ' finance ', 'FINANCE'])
      await mutate(user, 'post').send({ name }).expect(409);
    await mutate(foreign, 'post').send({ name: 'FINANCE' }).expect(201);
    await mutate(user, 'post')
      .send({ name: '  Annual   Report  ' })
      .expect(201);
    await mutate(user, 'post').send({ name: 'annual report' }).expect(409);
  });
  it('enforces duplicate constraints even under concurrent requests and direct database writes', async () => {
    const user = await owner();
    const results = await Promise.all([
      mutate(user, 'post').send({ name: 'Concurrent' }),
      mutate(user, 'post').send({ name: 'CONCURRENT' }),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([
      201, 409,
    ]);
    expect(await db.client.tag.count({ where: { userId: user.id } })).toBe(1);
    await expect(
      db.client.tag.create({ data: { userId: user.id, name: 'concurrent' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
  it('searches case-insensitive literal substrings without broadening ownership or wildcard meaning', async () => {
    const user = await owner();
    const foreign = await owner();
    for (const name of [
      'Annual Finance',
      'finance notes',
      'Other',
      '100% complete',
      'under_score',
      'back\\slash',
    ])
      await mutate(user, 'post').send({ name }).expect(201);
    await mutate(foreign, 'post').send({ name: 'Private Finance' }).expect(201);
    const search = await list(user)
      .query({ q: ' ＦＩＮＡＮＣＥ ' })
      .expect(200);
    expect(
      (search.body.data as { name: string }[]).map((row) => row.name).sort(),
    ).toEqual(['Annual Finance', 'finance notes']);
    for (const [q, name] of [
      ['%', '100% complete'],
      ['_', 'under_score'],
      ['\\', 'back\\slash'],
    ]) {
      const response = await list(user).query({ q }).expect(200);
      expect(
        (response.body.data as { name: string }[]).map((row) => row.name),
      ).toEqual([name]);
    }
    const missing = await list(user).query({ q: "' OR 1=1 --" }).expect(200);
    expect(missing.body).toMatchObject({
      data: [],
      meta: { nextCursor: null, hasMore: false },
    });
    await list(user).query({ userId: foreign.id }).expect(400);
  });
  it('paginates search deterministically using owned UUID bounds and terminal-page metadata', async () => {
    const user = await owner();
    const foreign = await owner();
    expect((await list(user).expect(200)).body).toMatchObject({
      data: [],
      meta: { nextCursor: null, hasMore: false },
    });
    for (const name of ['Match One', 'Match Two', 'Match Three', 'Unrelated'])
      await mutate(user, 'post').send({ name }).expect(201);
    const foreignRow = await db.client.tag.create({
      data: { userId: foreign.id, name: 'Match Private' },
    });
    const first = await list(user)
      .query({ q: 'match', limit: 2, sort: 'id' })
      .expect(200);
    const page = first.body as {
      data: { id: string }[];
      meta: { nextCursor: string; hasMore: boolean };
    };
    expect(page.data).toHaveLength(2);
    expect(page.meta.hasMore).toBe(true);
    const repeated = await list(user)
      .query({ q: 'match', limit: 2 })
      .expect(200);
    expect(repeated.body.data).toEqual(page.data);
    const second = await list(user)
      .query({ q: 'match', limit: 2, cursor: page.meta.nextCursor })
      .expect(200);
    expect(second.body.meta).toMatchObject({
      nextCursor: null,
      hasMore: false,
    });
    const actual = [
      ...page.data,
      ...(second.body.data as { id: string }[]),
    ].map((row) => row.id);
    const expected = await db.client.tag.findMany({
      where: { userId: user.id, name: { startsWith: 'Match' } },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    expect(actual).toEqual(expected.map((row) => row.id));
    const foreignCursor = await list(user)
      .query({ cursor: foreignRow.id })
      .expect(200);
    expect(
      (foreignCursor.body.data as { id: string }[]).some(
        (row) => row.id === foreignRow.id,
      ),
    ).toBe(false);
  });
  it('renames safely and rejects duplicate updates without changing the original row', async () => {
    const user = await owner();
    const first = await db.client.tag.create({
      data: { userId: user.id, name: 'First' },
    });
    await db.client.tag.create({ data: { userId: user.id, name: 'Second' } });
    await mutate(user, 'patch', `/${first.id}`)
      .send({ name: ' SECOND ' })
      .expect(409);
    expect(
      await db.client.tag.findUniqueOrThrow({ where: { id: first.id } }),
    ).toEqual(first);
    const renamed = await mutate(user, 'patch', `/${first.id}`)
      .send({ name: ' Renamed ' })
      .expect(200);
    expect(renamed.body.data).toMatchObject({
      id: first.id,
      name: 'Renamed',
      createdAt: first.createdAt.toISOString(),
    });
    expect(
      new Date(renamed.body.data.updatedAt as string).getTime(),
    ).toBeGreaterThanOrEqual(first.updatedAt.getTime());
    await mutate(user, 'patch', `/${first.id}`)
      .send({ name: 'Attack', userId: randomUUID() })
      .expect(400);
  });
  it('never reveals or changes another owner tag and gives the same missing response', async () => {
    const user = await owner();
    const foreign = await owner();
    const row = await db.client.tag.create({
      data: { userId: foreign.id, name: 'Private' },
    });
    for (const id of [row.id, randomUUID()])
      for (const method of ['patch', 'delete'] as const) {
        const call = mutate(user, method, `/${id}`).set('userId', foreign.id);
        if (method === 'patch') call.send({ name: 'Attack' });
        const response = await call.expect(404);
        expect(response.body.error).toMatchObject({
          code: 'NOT_FOUND',
          message: 'Not Found',
          details: {},
        });
      }
    expect((await list(user).expect(200)).body.data).toEqual([]);
    expect(
      await db.client.tag.findUniqueOrThrow({ where: { id: row.id } }),
    ).toEqual(row);
  });
  it('permanently deletes the owned tag, permits name reuse and returns 404 on a retry', async () => {
    const user = await owner();
    const foreign = await owner();
    const row = await db.client.tag.create({
      data: { userId: user.id, name: 'Disposable' },
    });
    const other = await db.client.tag.create({
      data: { userId: foreign.id, name: 'Disposable' },
    });
    expect(
      (await mutate(user, 'delete', `/${row.id}`).expect(200)).body.data,
    ).toEqual({ deleted: true });
    expect(
      await db.client.tag.findUnique({ where: { id: row.id } }),
    ).toBeNull();
    expect((await list(user).expect(200)).body.data).toEqual([]);
    await mutate(user, 'delete', `/${row.id}`).expect(404);
    await mutate(user, 'patch', `/${row.id}`)
      .send({ name: 'Missing' })
      .expect(404);
    await mutate(user, 'post').send({ name: 'DISPOSABLE' }).expect(201);
    expect(
      await db.client.tag.findUniqueOrThrow({ where: { id: other.id } }),
    ).toEqual(other);
  });
  it('enforces name checks and foreign keys for direct writers', async () => {
    const user = await owner();
    await expect(
      db.client.tag.create({ data: { userId: randomUUID(), name: 'Orphan' } }),
    ).rejects.toMatchObject({ code: 'P2003' });
    for (const name of [
      '',
      ' padded ',
      'double  space',
      'bad\tname',
      'a'.repeat(101),
    ])
      await expect(
        db.client.tag.create({ data: { userId: user.id, name } }),
      ).rejects.toBeDefined();
    expect(await db.client.tag.count({ where: { userId: user.id } })).toBe(0);
    await db.client.tag.create({ data: { userId: user.id, name: 'Owned' } });
    await db.client.authSession.deleteMany({ where: { userId: user.id } });
    await expect(
      db.client.user.delete({ where: { id: user.id } }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });
});
