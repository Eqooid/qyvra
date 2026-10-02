import { createPrismaClient, Prisma, PrismaClient } from '@qyvra/database';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { validateTestEnvironment as validateEnvironment } from './configuration.fixture';

// Generated synthetic digests, not stored passwords or usable session tokens.
const digest = () => createHash('sha256').update(randomBytes(32)).digest('hex');
const passwordHash = () =>
  [
    '$argon2id$v=19$m=65536,t=3,p=1',
    randomBytes(16).toString('base64').replace(/=+$/, ''),
    randomBytes(32).toString('base64').replace(/=+$/, ''),
  ].join('$');

describe('authentication schema constraints (migrated PostgreSQL)', () => {
  let client: PrismaClient;
  beforeAll(async () => {
    const config = validateEnvironment({
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL,
    });
    client = createPrismaClient(config.database);
    await client.$connect();
  });
  afterAll(async () => {
    await client?.$disconnect();
  });

  async function transaction(
    test: (tx: Prisma.TransactionClient) => Promise<void>,
  ) {
    const rollback = new Error('Test rollback');
    try {
      await client.$transaction(
        async (tx) => {
          await test(tx);
          throw rollback;
        },
        { timeout: 10000 },
      );
    } catch (error) {
      if (error !== rollback) throw error;
    }
  }

  async function violates(
    tx: Prisma.TransactionClient,
    operation: () => Promise<unknown>,
  ) {
    await tx.$executeRaw`SAVEPOINT constraint_test`;
    let rejected = false;
    try {
      await operation();
    } catch (error) {
      rejected = error instanceof Prisma.PrismaClientKnownRequestError;
    }
    expect(rejected).toBe(true);
    await tx.$executeRaw`ROLLBACK TO SAVEPOINT constraint_test`;
  }

  const user = (tx: Prisma.TransactionClient) =>
    tx.user.create({ data: { email: `${randomUUID()}@example.invalid` } });
  const session = (userId: string) => ({
    userId,
    tokenHash: digest(),
    expiresAt: new Date(Date.now() + 3600000),
  });

  it('uses UUID defaults, required profile defaults, and separate optional credentials', async () =>
    transaction(async (tx) => {
      const created = await user(tx);
      expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(created).toMatchObject({
        locale: 'en',
        timezone: 'UTC',
        deletedAt: null,
        displayName: null,
      });
      expect(created.createdAt).toBeInstanceOf(Date);
      expect(
        await tx.localCredential.count({ where: { userId: created.id } }),
      ).toBe(0);
      const credential = await tx.localCredential.create({
        data: { userId: created.id, passwordHash: passwordHash() },
      });
      expect(credential.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(credential.failedLoginAttempts).toBe(0);
      expect(credential.lockedUntil).toBeNull();
    }));

  it('reserves normalized email even after soft deletion', async () =>
    transaction(async (tx) => {
      const created = await user(tx);
      await violates(tx, () =>
        tx.user.create({ data: { email: created.email } }),
      );
      await violates(tx, () =>
        tx.user.create({ data: { email: created.email.toUpperCase() } }),
      );
      await tx.user.update({
        where: { id: created.id },
        data: { deletedAt: new Date() },
      });
      await violates(tx, () =>
        tx.user.create({ data: { email: created.email } }),
      );
    }));

  it('uniquely identifies external subjects by provider and issuer, independent of email', async () =>
    transaction(async (tx) => {
      const first = await user(tx);
      const second = await user(tx);
      const identity = {
        userId: first.id,
        provider: 'KEYCLOAK' as const,
        issuer: 'https://identity.example.invalid/realm',
        subject: randomUUID(),
      };
      const linked = await tx.userIdentity.create({ data: identity });
      await violates(tx, () =>
        tx.userIdentity.create({ data: { ...identity, userId: second.id } }),
      );
      await tx.userIdentity.create({
        data: {
          ...identity,
          userId: second.id,
          issuer: 'https://other.example.invalid/realm',
        },
      });
      await tx.userIdentity.create({ data: { ...identity, provider: 'OIDC' } });
      await tx.user.update({
        where: { id: first.id },
        data: { email: `${randomUUID()}@example.invalid` },
      });
      expect(
        (await tx.userIdentity.findUniqueOrThrow({ where: { id: linked.id } }))
          .userId,
      ).toBe(first.id);
    }));

  it('requires local identities to reference the stable internal UUID', async () =>
    transaction(async (tx) => {
      const created = await user(tx);
      await tx.userIdentity.create({
        data: {
          userId: created.id,
          provider: 'LOCAL',
          issuer: 'local',
          subject: created.id,
        },
      });
      await violates(tx, () =>
        tx.userIdentity.create({
          data: {
            userId: created.id,
            provider: 'LOCAL',
            issuer: 'local',
            subject: created.email,
          },
        }),
      );
      await violates(tx, () =>
        tx.userIdentity.create({
          data: {
            userId: created.id,
            provider: 'OIDC',
            issuer: '',
            subject: 'subject',
          },
        }),
      );
    }));

  it('enforces one credential per user, hash format, and failure counters', async () =>
    transaction(async (tx) => {
      const created = await user(tx);
      await violates(tx, () =>
        tx.localCredential.create({
          data: { userId: created.id, passwordHash: 'not-a-hash' },
        }),
      );
      const data = { userId: created.id, passwordHash: passwordHash() };
      await violates(tx, () =>
        tx.localCredential.create({
          data: { ...data, failedLoginAttempts: -1 },
        }),
      );
      await violates(tx, () =>
        tx.localCredential.create({
          data: { ...data, failedLoginAttempts: 1 },
        }),
      );
      await tx.localCredential.create({
        data: {
          ...data,
          failedLoginAttempts: 2,
          lastFailedLoginAt: new Date(),
          lockedUntil: new Date(Date.now() + 60000),
        },
      });
      await violates(tx, () => tx.localCredential.create({ data }));
    }));

  it('enforces user foreign keys and prevents implicit deletion of authentication records', async () =>
    transaction(async (tx) => {
      const missing = randomUUID();
      await violates(tx, () =>
        tx.authSession.create({ data: session(missing) }),
      );
      await violates(tx, () =>
        tx.localCredential.create({
          data: { userId: missing, passwordHash: passwordHash() },
        }),
      );
      await violates(tx, () =>
        tx.userIdentity.create({
          data: {
            userId: missing,
            provider: 'OIDC',
            issuer: 'issuer',
            subject: 'subject',
          },
        }),
      );
      const created = await user(tx);
      await tx.authSession.create({ data: session(created.id) });
      await violates(tx, () => tx.user.delete({ where: { id: created.id } }));
    }));

  it('enforces unique session and refresh hashes while allowing sessions without refresh tokens', async () =>
    transaction(async (tx) => {
      const created = await user(tx);
      const data = {
        ...session(created.id),
        refreshTokenHash: digest(),
        refreshExpiresAt: new Date(Date.now() + 7200000),
      };
      await tx.authSession.create({ data });
      await violates(tx, () =>
        tx.authSession.create({
          data: { ...data, refreshTokenHash: digest() },
        }),
      );
      await violates(tx, () =>
        tx.authSession.create({ data: { ...data, tokenHash: digest() } }),
      );
      await tx.authSession.create({ data: session(created.id) });
      await tx.authSession.create({ data: session(created.id) });
    }));

  it('rejects plaintext-shaped tokens, mismatched refresh fields, and invalid lifecycle timestamps', async () =>
    transaction(async (tx) => {
      const created = await user(tx);
      const data = session(created.id);
      await violates(tx, () =>
        tx.authSession.create({
          data: { ...data, tokenHash: 'plaintext-token' },
        }),
      );
      await violates(tx, () =>
        tx.authSession.create({
          data: { ...data, refreshTokenHash: digest() },
        }),
      );
      await violates(tx, () =>
        tx.authSession.create({
          data: { ...data, refreshExpiresAt: new Date(Date.now() + 7200000) },
        }),
      );
      await violates(tx, () =>
        tx.authSession.create({ data: { ...data, expiresAt: new Date(0) } }),
      );
      await violates(tx, () =>
        tx.authSession.create({ data: { ...data, revokedAt: new Date(0) } }),
      );
      const active = await tx.authSession.create({ data });
      await tx.authSession.update({
        where: { id: active.id },
        data: { revokedAt: new Date() },
      });
    }));
});
