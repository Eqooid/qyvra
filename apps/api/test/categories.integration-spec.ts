import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { createTestOwner, TestOwner as Owner } from './owner.fixture';
import { Server } from 'node:http';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/configure-application';
import { settings } from '../src/configuration/configuration.module';
import { validateTestEnvironment as validateEnvironment } from './configuration.fixture';
import { PrismaService } from '../src/database/prisma.service';
import { LOG_SINK } from '../src/common/structured-logger';

describe('Categories with PostgreSQL', () => {
  let app: INestApplication;
  let server: Server;
  let db: PrismaService;
  const users: string[] = [];
  const owner = () => createTestOwner(db, users);
  const mutate = (
    user: Owner,
    method: 'post' | 'patch' | 'delete',
    suffix = '',
  ) =>
    request(server)
      [method](`/api/v1/categories${suffix}`)
      .set('Cookie', user.cookie)
      .set('X-CSRF-Protection', '1');
  const list = (user: Owner, query = '') =>
    request(server)
      .get(`/api/v1/categories${query}`)
      .set('Cookie', user.cookie);
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
          await tx.category.deleteMany({ where });
          await tx.authSession.deleteMany({ where });
          await tx.user.deleteMany({ where: { id: { in: users } } });
        });
    } finally {
      await app?.close();
    }
  });
  it('creates normalized safe categories and allows another owner to reuse the name', async () => {
    const first = await owner();
    const second = await owner();
    const created = await mutate(first, 'post')
      .set('userId', second.id)
      .send({
        name: '  Personal   Records ',
        color: '#AABBCC',
        icon: 'folder-open',
      })
      .expect(201);
    const data = created.body.data as {
      id: string;
      name: string;
      color: string;
      icon: string;
      createdAt: string;
      updatedAt: string;
    };
    expect(data).toMatchObject({
      name: 'Personal Records',
      color: '#aabbcc',
      icon: 'folder-open',
    });
    expect(Object.keys(data).sort()).toEqual(
      ['id', 'name', 'color', 'icon', 'createdAt', 'updatedAt'].sort(),
    );
    expect(
      (await db.client.category.findUniqueOrThrow({ where: { id: data.id } }))
        .userId,
    ).toBe(first.id);
    await mutate(first, 'post').send({ name: 'personal records' }).expect(409);
    await mutate(second, 'post').send({ name: 'PERSONAL RECORDS' }).expect(201);
    const normalized = await mutate(first, 'post')
      .send({ name: 'Ｆｉｌｅｓ' })
      .expect(201);
    expect(normalized.body.data.name).toBe('Files');
    await mutate(first, 'post').send({ name: 'files' }).expect(409);
  });
  it('enforces uniqueness under concurrent creation at the database boundary', async () => {
    const user = await owner();
    const results = await Promise.all([
      mutate(user, 'post').send({ name: 'Concurrent' }),
      mutate(user, 'post').send({ name: 'CONCURRENT' }),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([
      201, 409,
    ]);
    expect(await db.client.category.count({ where: { userId: user.id } })).toBe(
      1,
    );
    await expect(
      db.client.category.create({
        data: { userId: user.id, name: 'concurrent' },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
  it('lists only owned rows in stable cursor order, including empty and final pages', async () => {
    const user = await owner();
    const foreign = await owner();
    expect((await list(user).expect(200)).body).toMatchObject({
      data: [],
      meta: { nextCursor: null, hasMore: false },
    });
    for (const name of ['One', 'Two', 'Three'])
      await mutate(user, 'post').send({ name }).expect(201);
    const foreignRow = await db.client.category.create({
      data: { userId: foreign.id, name: 'Private' },
    });
    const first = await list(user, '?limit=2&sort=id').expect(200);
    const page = first.body as {
      data: { id: string }[];
      meta: { nextCursor: string; hasMore: boolean };
    };
    expect(page.data).toHaveLength(2);
    expect(page.meta.hasMore).toBe(true);
    const second = await list(
      user,
      `?limit=2&cursor=${page.meta.nextCursor}`,
    ).expect(200);
    expect(second.body.data).toHaveLength(1);
    expect(second.body.meta).toMatchObject({
      nextCursor: null,
      hasMore: false,
    });
    const rows = await db.client.category.findMany({
      where: { userId: user.id },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    expect(
      [...page.data, ...(second.body.data as { id: string }[])].map(
        (row) => row.id,
      ),
    ).toEqual(rows.map((row) => row.id));
    const foreignCursor = await list(user, `?cursor=${foreignRow.id}`).expect(
      200,
    );
    expect(
      (foreignCursor.body.data as { id: string }[]).some(
        (row) => row.id === foreignRow.id,
      ),
    ).toBe(false);
    await list(user, `?userId=${foreign.id}`).expect(400);
  });
  it('updates only editable owned fields and handles duplicate names and null styling', async () => {
    const user = await owner();
    const row = await db.client.category.create({
      data: {
        userId: user.id,
        name: 'First',
        color: '#aabbcc',
        icon: 'folder',
      },
    });
    await db.client.category.create({
      data: { userId: user.id, name: 'Second' },
    });
    await mutate(user, 'patch', `/${row.id}`)
      .send({ name: 'SECOND' })
      .expect(409);
    const response = await mutate(user, 'patch', `/${row.id}`)
      .send({ name: ' Renamed ', color: null, icon: null })
      .expect(200);
    expect(response.body.data).toMatchObject({
      id: row.id,
      name: 'Renamed',
      color: null,
      icon: null,
      createdAt: row.createdAt.toISOString(),
    });
    expect(
      new Date(response.body.data.updatedAt as string).getTime(),
    ).toBeGreaterThanOrEqual(row.updatedAt.getTime());
    await mutate(user, 'patch', `/${row.id}`)
      .send({ userId: randomUUID() })
      .expect(400);
  });
  it('makes foreign and missing resources indistinguishable and preserves the foreign row', async () => {
    const user = await owner();
    const foreign = await owner();
    const row = await db.client.category.create({
      data: { userId: foreign.id, name: 'Private' },
    });
    for (const id of [row.id, randomUUID()]) {
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
    }
    expect((await list(user).expect(200)).body.data).toEqual([]);
    expect(
      await db.client.category.findUniqueOrThrow({ where: { id: row.id } }),
    ).toEqual(row);
  });
  it('permanently deletes unused categories, excludes them from lists and permits name reuse', async () => {
    const user = await owner();
    const row = await db.client.category.create({
      data: { userId: user.id, name: 'Disposable' },
    });
    expect(
      (await mutate(user, 'delete', `/${row.id}`).expect(200)).body.data,
    ).toEqual({ deleted: true });
    expect(
      await db.client.category.findUnique({ where: { id: row.id } }),
    ).toBeNull();
    expect((await list(user).expect(200)).body.data).toEqual([]);
    await mutate(user, 'delete', `/${row.id}`).expect(404);
    await mutate(user, 'patch', `/${row.id}`)
      .send({ name: 'Missing' })
      .expect(404);
    await mutate(user, 'post').send({ name: 'DISPOSABLE' }).expect(201);
  });
  it('enforces foreign keys and input invariants even when bypassing the HTTP layer', async () => {
    const user = await owner();
    await expect(
      db.client.category.create({
        data: { userId: randomUUID(), name: 'Orphan' },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    for (const data of [
      { name: '' },
      { name: ' padded ' },
      { name: 'double  space' },
      { name: 'bad\tname' },
      { name: 'Bad color', color: 'red' },
      { name: 'Bad icon', icon: '../folder' },
    ]) {
      await expect(
        db.client.category.create({ data: { ...data, userId: user.id } }),
      ).rejects.toBeDefined();
    }
    expect(await db.client.category.count({ where: { userId: user.id } })).toBe(
      0,
    );
    await db.client.category.create({
      data: { userId: user.id, name: 'Owned' },
    });
    await expect(
      db.client.user.delete({ where: { id: user.id } }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });
});
