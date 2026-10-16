import {
  maintenanceBatch,
  maintenanceInitiator,
  maintenanceUuid,
  authorizeSearchOperator,
} from './search-maintenance.service';
import type { PrismaClient } from '@qyvra/database';
describe('search maintenance operator boundaries', () => {
  it.each([0, 26, -1, 1.5, NaN])('rejects unbounded batches %s', (n) =>
    expect(() => maintenanceBatch(n)).toThrow(),
  );
  it('accepts bounded batches and explicit audit identities', () => {
    expect(maintenanceBatch(25)).toBe(25);
    expect(maintenanceInitiator('ops:operator-1')).toBe('ops:operator-1');
    expect(
      maintenanceUuid('11111111-1111-4111-8111-111111111111'),
    ).toBeDefined();
  });
  it.each(['', 'operator with spaces', '<script>', 'x'.repeat(101)])(
    'rejects unsafe audit identity %s',
    (name) => expect(() => maintenanceInitiator(name)).toThrow(),
  );
  it.each([
    'bad',
    '../../private',
    '11111111-1111-4111-8111-111111111111/index',
  ])('rejects request-selected paths %s', (id) =>
    expect(() => maintenanceUuid(id)).toThrow(),
  );
  it('requires actual database operator membership, not a supplied user ID', async () => {
    const $queryRaw = jest.fn().mockResolvedValue([{ authorized: false }]);
    const db = { $queryRaw } as unknown as PrismaClient;
    await expect(authorizeSearchOperator(db)).rejects.toThrow(
      'OPERATOR_AUTHORIZATION_REQUIRED',
    );
    $queryRaw.mockResolvedValueOnce([{ authorized: true }]);
    await expect(authorizeSearchOperator(db)).resolves.toBeUndefined();
  });
});
