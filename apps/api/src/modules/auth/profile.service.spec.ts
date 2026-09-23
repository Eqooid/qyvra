import { PrismaService } from '../../database/prisma.service';
import { ProfileService } from './profile.service';
import { PasswordService } from './password.service';
import { InvalidCredentials } from './login.service';
import { InvalidRegistration } from './registration.errors';

describe('ProfileService ownership and credential transactions', () => {
  const context = {
    user: {
      id: 'owner',
      email: 'owner@example.invalid',
      displayName: null,
      timezone: 'UTC',
      locale: 'en',
    },
    sessionId: 'current',
  };
  const passwords = { verify: jest.fn(), hash: jest.fn() };
  const tx = {
    $queryRaw: jest.fn(),
    user: { findFirst: jest.fn() },
    localCredential: { update: jest.fn() },
    authSession: { findFirst: jest.fn(), updateMany: jest.fn() },
  };
  const client = {
    user: { findFirst: jest.fn(), update: jest.fn() },
    $transaction: jest.fn(
      (work: (transaction: typeof tx) => Promise<unknown>) => work(tx),
    ),
  };
  const service = new ProfileService(
    { client } as unknown as PrismaService,
    passwords as unknown as PasswordService,
  );
  beforeEach(() => {
    jest.clearAllMocks();
    passwords.verify.mockResolvedValue(true);
    passwords.hash.mockResolvedValue('new-test-hash');
    client.user.findFirst.mockResolvedValue({
      localCredentials: { passwordHash: 'old-test-hash' },
    });
    tx.user.findFirst.mockResolvedValue({
      localCredentials: { passwordHash: 'old-test-hash' },
    });
    tx.authSession.findFirst.mockResolvedValue({ id: context.sessionId });
    tx.authSession.updateMany.mockResolvedValue({ count: 2 });
  });
  it('selects safe fields and only updates the trusted owner', async () => {
    const input = {
      displayName: 'Name',
      userId: 'foreign',
      email: 'injected@example.invalid',
    };
    await service.update(context, input);
    expect(client.user.update).toHaveBeenCalledWith({
      where: { id: 'owner', deletedAt: null },
      data: { displayName: 'Name', timezone: undefined, locale: undefined },
      select: {
        id: true,
        email: true,
        displayName: true,
        locale: true,
        timezone: true,
      },
    });
  });
  it('changes the hash and timestamp and revokes only other owned sessions in one transaction', async () => {
    await service.changePassword(context, 'current password', 'new password');
    expect(passwords.verify).toHaveBeenCalledWith(
      'current password',
      'old-test-hash',
    );
    expect(passwords.hash).toHaveBeenCalledWith('new password');
    expect(client.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(3);
    expect(tx.localCredential.update).toHaveBeenCalledWith({
      where: { userId: 'owner' },
      data: {
        passwordHash: 'new-test-hash',
        passwordChangedAt: expect.any(Date),
        failedLoginAttempts: 0,
        lastFailedLoginAt: null,
        lockedUntil: null,
      },
    });
    expect(tx.authSession.updateMany).toHaveBeenCalledWith({
      where: { userId: 'owner', id: { not: 'current' }, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });
  it.each(['incorrect', 'non-local', 'no-credential'])(
    'rejects %s credentials without any transaction',
    async (kind) => {
      if (kind === 'incorrect') passwords.verify.mockResolvedValue(false);
      if (kind === 'non-local') client.user.findFirst.mockResolvedValue(null);
      if (kind === 'no-credential')
        client.user.findFirst.mockResolvedValue({ localCredentials: null });
      await expect(
        service.changePassword(context, 'wrong', 'replacement'),
      ).rejects.toBeInstanceOf(InvalidCredentials);
      expect(passwords.verify).toHaveBeenCalledTimes(1);
      expect(passwords.hash).not.toHaveBeenCalled();
      expect(client.$transaction).not.toHaveBeenCalled();
    },
  );
  it('does not change persistence when the existing password policy rejects the new password', async () => {
    passwords.hash.mockRejectedValueOnce(new InvalidRegistration());
    await expect(
      service.changePassword(context, 'current', 'weak'),
    ).rejects.toBeInstanceOf(InvalidRegistration);
    expect(client.$transaction).not.toHaveBeenCalled();
  });
  it.each(['changed-hash', 'revoked-session', 'deleted-account'])(
    'rechecks %s inside the transaction before writing',
    async (kind) => {
      if (kind === 'changed-hash')
        tx.user.findFirst.mockResolvedValue({
          localCredentials: { passwordHash: 'concurrent-hash' },
        });
      if (kind === 'revoked-session')
        tx.authSession.findFirst.mockResolvedValue(null);
      if (kind === 'deleted-account') tx.user.findFirst.mockResolvedValue(null);
      await expect(
        service.changePassword(context, 'current', 'replacement'),
      ).rejects.toBeInstanceOf(InvalidCredentials);
      expect(tx.localCredential.update).not.toHaveBeenCalled();
      expect(tx.authSession.updateMany).not.toHaveBeenCalled();
    },
  );
  it('sanitizes transaction failures instead of reporting success', async () => {
    tx.authSession.updateMany.mockRejectedValueOnce(
      new Error('private SQL details'),
    );
    await expect(
      service.changePassword(context, 'current', 'replacement'),
    ).rejects.toThrow('Password update failed.');
  });
  it('logout-all uses the owner filter and skips already revoked sessions on every call', async () => {
    await service.logoutAll(context);
    await service.logoutAll(context);
    expect(tx.authSession.updateMany).toHaveBeenCalledTimes(2);
    expect(tx.authSession.updateMany).toHaveBeenLastCalledWith({
      where: { userId: 'owner', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });
});
