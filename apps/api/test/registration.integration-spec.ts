import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { Server } from 'node:http';
import { verify } from 'argon2';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/configure-application';
import { settings } from '../src/configuration/configuration.module';
import { validateTestEnvironment as validateEnvironment } from './configuration.fixture';
import { PrismaService } from '../src/database/prisma.service';
import { RegistrationRepository } from '../src/modules/auth/registration.repository';
import { LOG_SINK } from '../src/common/structured-logger';

describe('registration with real PostgreSQL and Argon2id', () => {
  let app: INestApplication;
  let database: PrismaService;
  let server: Server;
  const emails: string[] = [];
  const logs: string[] = [];
  const password = 'a sufficiently long integration passphrase';
  const email = () => {
    const value = `${randomUUID()}@example.invalid`;
    emails.push(value);
    return value;
  };

  beforeAll(async () => {
    const config = validateEnvironment({
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL,
    });
    const fixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(settings.KEY)
      .useValue(config)
      .overrideProvider(LOG_SINK)
      .useValue((line: string) => logs.push(line))
      .compile();
    app = fixture.createNestApplication();
    configureApplication(app, config);
    await app.init();
    database = app.get(PrismaService);
    server = app.getHttpServer();
  });

  afterAll(async () => {
    try {
      if (database) {
        // Delete only rows belonging to the random addresses allocated by this suite.
        await database.client.$transaction(async (tx) => {
          await tx.localCredential.deleteMany({
            where: { user: { email: { in: emails } } },
          });
          await tx.userIdentity.deleteMany({
            where: { user: { email: { in: emails } } },
          });
          await tx.user.deleteMany({ where: { email: { in: emails } } });
        });
      }
    } finally {
      await app?.close();
    }
  });

  it('creates all three records and no session, returning and logging no security data', async () => {
    const address = email();
    const response = await request(server)
      .post('/api/v1/auth/register')
      .send({ email: ` ${address.toUpperCase()} `, password })
      .expect(201);
    const user = await database.client.user.findUniqueOrThrow({
      where: { email: address },
      include: { identities: true, localCredentials: true, sessions: true },
    });
    expect(
      user.identities.map(({ provider, issuer, subject }) => ({
        provider,
        issuer,
        subject,
      })),
    ).toEqual([{ provider: 'LOCAL', issuer: 'local', subject: user.id }]);
    const storedHash = user.localCredentials?.passwordHash ?? '';
    expect(storedHash.startsWith('$argon2id$')).toBe(true);
    expect(await verify(storedHash, password)).toBe(true);
    expect(user.sessions).toHaveLength(0);
    expect(response.body).toEqual({
      data: { id: user.id, email: address },
      meta: { requestId: response.headers['x-correlation-id'] as string },
    });
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(logs.join('').includes(password)).toBe(false);
    expect(logs.join('').includes(storedHash)).toBe(false);
    expect(logs.join('').includes(address)).toBe(false);
  });

  it('rejects invalid input without creating rows', async () => {
    const address = email();
    await request(server)
      .post('/api/v1/auth/register')
      .send({ email: address, password: 'short' })
      .expect(400);
    expect(
      await database.client.user.count({ where: { email: address } }),
    ).toBe(0);
  });

  it('handles concurrent and normalized duplicate registration atomically', async () => {
    const address = email();
    const responses = await Promise.all([
      request(server)
        .post('/api/v1/auth/register')
        .send({ email: address, password }),
      request(server)
        .post('/api/v1/auth/register')
        .send({ email: address.toUpperCase(), password }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      201, 409,
    ]);
    const duplicate = await request(server)
      .post('/api/v1/auth/register')
      .send({ email: address, password })
      .expect(409);
    expect(duplicate.body).toEqual({
      error: {
        code: 'CONFLICT',
        message: 'Conflict',
        details: {},
        traceId: duplicate.headers['x-correlation-id'] as string,
      },
    });
    expect(
      await database.client.user.count({ where: { email: address } }),
    ).toBe(1);
    expect(
      await database.client.userIdentity.count({
        where: { user: { email: address } },
      }),
    ).toBe(1);
    expect(
      await database.client.localCredential.count({
        where: { user: { email: address } },
      }),
    ).toBe(1);
  });

  it('rolls back the user and identity when credential insertion fails', async () => {
    const address = email();
    await expect(
      app.get(RegistrationRepository).create(address, 'invalid-hash'),
    ).rejects.toThrow('Registration persistence failed.');
    expect(
      await database.client.user.count({ where: { email: address } }),
    ).toBe(0);
    expect(
      await database.client.userIdentity.count({
        where: { user: { email: address } },
      }),
    ).toBe(0);
  });
});
