import { randomBytes, createHash } from 'node:crypto';
import { PrismaService } from '../../database/prisma.service';
import { ConfigurationService } from '../../configuration/configuration.module';
import { validateTestEnvironment as validateEnvironment } from '../../../test/configuration.fixture';
import { SessionLifecycleService } from './session-lifecycle.service';

describe('session lifecycle transactions', () => {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const tx = {
    $queryRaw: jest.fn(),
    authSession: {
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    consumedRefreshToken: { findUnique: jest.fn(), create: jest.fn() },
  };
  const transaction = jest.fn(
    (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
  );
  const service = new SessionLifecycleService(
    { client: { $transaction: transaction } } as unknown as PrismaService,
    new ConfigurationService(
      validateEnvironment({ DATABASE_URL: 'postgresql://localhost/test' }),
    ),
  );
  beforeEach(() => {
    jest.clearAllMocks();
    tx.authSession.findUnique.mockReset();
    tx.consumedRefreshToken.findUnique.mockResolvedValue(null);
  });

  it('archives the consumed hash and rotates independent tokens within absolute expiry', async () => {
    const deadline = new Date(Date.now() + 300000);
    tx.authSession.findUnique
      .mockResolvedValueOnce({ id: 'id' })
      .mockResolvedValueOnce({
        refreshTokenHash: tokenHash,
        refreshExpiresAt: deadline,
        revokedAt: null,
        user: { deletedAt: null },
      });
    const result = await service.refresh(token);
    if (!result) throw new Error('Expected rotation');
    expect(result.expiresAt).toEqual(deadline);
    expect(result.refreshExpiresAt).toEqual(deadline);
    expect(
      result.token === result.refreshToken || result.refreshToken === token,
    ).toBe(false);
    expect(Buffer.from(result.refreshToken, 'base64url').length).toBe(32);
    const archived = tx.consumedRefreshToken.create.mock.calls[0]?.[0] as {
      data: { tokenHash: string };
    };
    expect(archived.data.tokenHash === tokenHash).toBe(true);
    expect(
      JSON.stringify(tx.authSession.update.mock.calls).includes(
        result.refreshToken,
      ),
    ).toBe(false);
  });
  it.each(['expired', 'revoked', 'deleted', 'no-refresh'])(
    'rejects %s state without rotating',
    async (state) => {
      tx.authSession.findUnique
        .mockResolvedValueOnce({ id: 'id' })
        .mockResolvedValueOnce({
          refreshTokenHash: tokenHash,
          refreshExpiresAt:
            state === 'no-refresh'
              ? null
              : new Date(Date.now() + (state === 'expired' ? -1000 : 60000)),
          revokedAt: state === 'revoked' ? new Date() : null,
          user: { deletedAt: state === 'deleted' ? new Date() : null },
        });
      expect(await service.refresh(token)).toBeNull();
      expect(tx.authSession.update).not.toHaveBeenCalled();
      expect(tx.consumedRefreshToken.create).not.toHaveBeenCalled();
    },
  );
  it('commits revocation for a consumed token instead of throwing inside the transaction', async () => {
    tx.authSession.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        refreshTokenHash: 'new-digest',
        revokedAt: null,
      });
    tx.consumedRefreshToken.findUnique.mockResolvedValue({ sessionId: 'id' });
    expect(await service.refresh(token)).toBeNull();
    expect(tx.authSession.updateMany).toHaveBeenCalledWith({
      where: { id: 'id', revokedAt: null },
      data: { revokedAt: expect.any(Date) as Date },
    });
  });
  it('returns invalid for unknown tokens and sanitizes database errors', async () => {
    tx.authSession.findUnique.mockResolvedValue(null);
    expect(await service.refresh(token)).toBeNull();
    tx.authSession.findUnique.mockRejectedValue(
      new Error('internal connection data'),
    );
    await expect(service.refresh(token)).rejects.toThrow(
      'Session refresh failed.',
    );
  });
  it('makes missing logout a no-op and does not revoke an unrelated refresh session', async () => {
    await service.logout();
    expect(transaction).not.toHaveBeenCalled();
    tx.authSession.findUnique.mockResolvedValue({ id: 'current' });
    await service.logout(token, 'another-token');
    expect(tx.authSession.findUnique).toHaveBeenCalledTimes(1);
    expect(tx.authSession.updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { id: 'current', revokedAt: null },
    });
  });
});
