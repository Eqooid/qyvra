import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../../database/prisma.service';
import { SessionService, sessionToken } from './session.service';

describe('session authentication', () => {
  const token = randomBytes(32).toString('base64url');
  const authSession = {
    findUnique: jest.fn(),
    updateMany: jest.fn(),
    findFirst: jest.fn(),
  };
  const service = new SessionService({
    client: { authSession },
  } as unknown as PrismaService);
  const user = {
    id: 'user-id',
    email: 'person@example.invalid',
    displayName: null,
    locale: 'en',
    timezone: 'UTC',
    deletedAt: null,
  };
  const active = () => ({
    id: 'session-id',
    expiresAt: new Date(Date.now() + 60000),
    revokedAt: null,
    lastSeenAt: new Date(),
    user,
  });
  beforeEach(() => {
    jest.resetAllMocks();
    authSession.updateMany.mockResolvedValue({ count: 1 });
  });

  it('looks up the SHA-256 hash and returns a frozen safe user without an activity write', async () => {
    authSession.findUnique.mockResolvedValue(active());
    const result = await service.authenticate(token);
    const query = authSession.findUnique.mock.calls[0]?.[0] as {
      where: { tokenHash: string };
    };
    expect(
      query.where.tokenHash ===
        createHash('sha256').update(token).digest('hex'),
    ).toBe(true);
    expect(JSON.stringify(query).includes(token)).toBe(false);
    expect(result).toEqual({
      id: user.id,
      email: user.email,
      displayName: null,
      locale: 'en',
      timezone: 'UTC',
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(authSession.updateMany).not.toHaveBeenCalled();
  });
  it.each(['missing', 'expired', 'revoked', 'deleted'])(
    'rejects a %s session',
    async (state) => {
      const session = active();
      authSession.findUnique.mockResolvedValue(
        state === 'missing'
          ? null
          : {
              ...session,
              ...(state === 'expired' ? { expiresAt: new Date(0) } : {}),
              ...(state === 'revoked' ? { revokedAt: new Date() } : {}),
              ...(state === 'deleted'
                ? { user: { ...user, deletedAt: new Date() } }
                : {}),
            },
      );
      expect(await service.authenticate(token)).toBeNull();
      expect(authSession.updateMany).not.toHaveBeenCalled();
    },
  );
  it.each([null, new Date(0)])(
    'updates stale activity with a conditional predicate %#',
    async (lastSeenAt) => {
      authSession.findUnique.mockResolvedValue({ ...active(), lastSeenAt });
      await service.authenticate(token);
      expect(authSession.updateMany).toHaveBeenCalledTimes(1);
      expect(authSession.updateMany.mock.calls[0]?.[0]).toMatchObject({
        where: {
          id: 'session-id',
          revokedAt: null,
          user: { deletedAt: null },
          OR: [
            { lastSeenAt: null },
            { lastSeenAt: { lte: expect.any(Date) as Date } },
          ],
        },
        data: { lastSeenAt: expect.any(Date) as Date },
      });
    },
  );
  it('rechecks validity when a concurrent update wins or revocation blocks the write', async () => {
    authSession.findUnique.mockResolvedValue({ ...active(), lastSeenAt: null });
    authSession.updateMany.mockResolvedValue({ count: 0 });
    authSession.findFirst.mockResolvedValue(null);
    expect(await service.authenticate(token)).toBeNull();
    authSession.findFirst.mockResolvedValue({ id: 'session-id' });
    expect(await service.authenticate(token)).not.toBeNull();
  });
  it('sanitizes infrastructure failures', async () => {
    authSession.findUnique.mockRejectedValue(
      new Error('internal connection data'),
    );
    await expect(service.authenticate(token)).rejects.toThrow(
      'Session authentication failed.',
    );
  });
  it('rechecks the presented hash when rotation races with an activity update', async () => {
    authSession.findUnique.mockResolvedValue({ ...active(), lastSeenAt: null });
    authSession.updateMany.mockResolvedValue({ count: 0 });
    authSession.findFirst.mockResolvedValue(null);
    expect(await service.authenticate(token)).toBeNull();
    for (const query of [
      authSession.updateMany.mock.calls[0]?.[0],
      authSession.findFirst.mock.calls[0]?.[0],
    ] as { where: { tokenHash: string } }[]) {
      expect(
        query.where.tokenHash ===
          createHash('sha256').update(token).digest('hex'),
      ).toBe(true);
    }
  });
  it('accepts only a single canonical configured cookie', () => {
    expect(
      sessionToken(`other=value; custom=${token}`, 'custom') === token,
    ).toBe(true);
    for (const header of [
      undefined,
      '',
      `refresh=${token}`,
      'custom=invalid',
      `custom=${token}; custom=${token}`,
      'custom=%invalid',
      `custom="${token}"`,
      `custom=${token}=`,
      'custom=' + '_'.repeat(43),
    ]) {
      expect(sessionToken(header, 'custom') === undefined).toBe(true);
    }
  });
});
