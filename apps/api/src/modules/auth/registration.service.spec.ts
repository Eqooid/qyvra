import { verify } from 'argon2';
import { ConfigurationService } from '../../configuration/configuration.module';
import { validateTestEnvironment as validateEnvironment } from '../../../test/configuration.fixture';
import { PasswordService } from './password.service';
import { RegistrationService } from './registration.service';
import { RegistrationRepository } from './registration.repository';
import {
  InvalidRegistration,
  RegistrationConflict,
} from './registration.errors';

const config = (env: Record<string, unknown> = {}) =>
  new ConfigurationService(
    validateEnvironment({
      DATABASE_URL: 'postgresql://localhost/test',
      ...env,
    }),
  );

describe('local registration', () => {
  it('hashes using Argon2id with random salts and preserves password bytes', async () => {
    const passwords = new PasswordService(config());
    const password = '  a sufficiently long passphrase  ';
    const first = await passwords.hash(password);
    const second = await passwords.hash(password);
    expect(first.startsWith('$argon2id$v=19$m=65536,t=3,p=1$')).toBe(true);
    expect(first === second).toBe(false);
    expect(await verify(first, password)).toBe(true);
    expect(await verify(first, password.trim())).toBe(false);
  });

  it.each(['short', ' '.repeat(20), 'x'.repeat(129), '😀'.repeat(14)])(
    'rejects an invalid password case %#',
    async (password) => {
      await expect(
        new PasswordService(config()).hash(password),
      ).rejects.toBeInstanceOf(InvalidRegistration);
    },
  );

  it('enforces configured lengths and counts Unicode code points', async () => {
    const passwords = new PasswordService(
      config({
        AUTH_PASSWORD_MIN_LENGTH: '20',
        AUTH_PASSWORD_MAX_LENGTH: '64',
      }),
    );
    await expect(passwords.hash('x'.repeat(19))).rejects.toBeInstanceOf(
      InvalidRegistration,
    );
    await expect(passwords.hash('x'.repeat(65))).rejects.toBeInstanceOf(
      InvalidRegistration,
    );
    expect(
      await verify(await passwords.hash('😀'.repeat(20)), '😀'.repeat(20)),
    ).toBe(true);
  });

  it('normalizes email and passes only the hash to persistence', async () => {
    const passwords = new PasswordService(config());
    const repository = {
      create: jest
        .fn()
        .mockResolvedValue({ id: 'id', email: 'person@example.invalid' }),
    };
    const service = new RegistrationService(
      passwords,
      repository as unknown as RegistrationRepository,
    );
    const password = 'a sufficiently long passphrase';
    await service.register(' Person@Example.Invalid ', password);
    const args = repository.create.mock.calls[0] as [string, string];
    expect(args[0]).toBe('person@example.invalid');
    expect(args[1] === password).toBe(false);
    expect(await verify(args[1], password)).toBe(true);
    repository.create.mockRejectedValue(new RegistrationConflict());
    await expect(
      service.register('person@example.invalid', password),
    ).rejects.toBeInstanceOf(RegistrationConflict);
  });

  it.each([
    { AUTH_PASSWORD_MIN_LENGTH: '14' },
    { AUTH_PASSWORD_MIN_LENGTH: '129' },
    { AUTH_PASSWORD_MAX_LENGTH: '63' },
    { AUTH_PASSWORD_MAX_LENGTH: '1025' },
    { AUTH_PASSWORD_MIN_LENGTH: '100', AUTH_PASSWORD_MAX_LENGTH: '64' },
    { AUTH_PASSWORD_MIN_LENGTH: 'NaN' },
  ])('rejects invalid startup password settings %#', (env) => {
    expect(() => config(env)).toThrow('AUTH_PASSWORD');
  });
});
