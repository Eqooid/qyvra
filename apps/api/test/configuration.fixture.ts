import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateEnvironment } from '../src/configuration/environment';

// Configuration-only path: these tests never write storage objects or create it.
export const storageTestRoot = join(tmpdir(), 'brainless-configuration-only');
export function validateTestEnvironment(environment: Record<string, unknown>) {
  return validateEnvironment({
    LOCAL_STORAGE_ROOT: storageTestRoot,
    ...environment,
  });
}
