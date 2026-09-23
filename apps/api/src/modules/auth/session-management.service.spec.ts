import { PrismaService } from '../../database/prisma.service';
import {
  SessionManagementService,
  SessionNotFound,
} from './session-management.service';

describe('session management ownership', () => {
  const context = {
    sessionId: 'current',
    user: {
      id: 'owner',
      email: 'owner@example.invalid',
      displayName: null,
      locale: 'en',
      timezone: 'UTC',
    },
  };
  const authSession = {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    updateMany: jest.fn(),
  };
  const database = {
    client: {
      authSession,
      $transaction: (
        operation: (tx: {
          authSession: typeof authSession;
        }) => Promise<unknown>,
      ) => operation({ authSession }),
    },
  };
  const service = new SessionManagementService(
    database as unknown as PrismaService,
  );
  beforeEach(() => {
    jest.resetAllMocks();
  });
  it('scopes the list to its owner and never selects tokens or hashes', async () => {
    authSession.findMany.mockResolvedValue([
      { id: 'current' },
      { id: 'other' },
    ]);
    expect(await service.list(context, 1, 'cursor')).toEqual({
      sessions: [{ id: 'current', isCurrent: true }],
      nextCursor: 'current',
    });
    expect(authSession.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { userId: 'owner', revokedAt: null, id: { gt: 'cursor' } },
      take: 2,
      select: {
        id: true,
        createdAt: true,
        lastSeenAt: true,
        expiresAt: true,
        refreshExpiresAt: true,
      },
    });
    expect(
      Object.keys(
        (authSession.findMany.mock.calls[0]?.[0] as { select: object }).select,
      ),
    ).toEqual([
      'id',
      'createdAt',
      'lastSeenAt',
      'expiresAt',
      'refreshExpiresAt',
    ]);
  });
  it('returns not found without updating missing or foreign sessions', async () => {
    authSession.findFirst.mockResolvedValue(null);
    await expect(service.revoke(context, 'foreign')).rejects.toBeInstanceOf(
      SessionNotFound,
    );
    expect(authSession.findFirst).toHaveBeenCalledWith({
      where: { id: 'foreign', userId: 'owner' },
      select: { id: true },
    });
    expect(authSession.updateMany).not.toHaveBeenCalled();
  });
  it('keeps owned revocation idempotent and ownership-scoped', async () => {
    authSession.findFirst.mockResolvedValue({ id: 'owned' });
    authSession.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.revoke(context, 'owned')).resolves.toBeUndefined();
    expect(authSession.updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { id: 'owned', userId: 'owner', revokedAt: null },
    });
  });
  it('excludes the current session when revoking others', async () => {
    authSession.updateMany.mockResolvedValue({ count: 2 });
    expect(await service.revokeOthers(context)).toBe(2);
    expect(authSession.updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { userId: 'owner', id: { not: 'current' }, revokedAt: null },
    });
  });
});
