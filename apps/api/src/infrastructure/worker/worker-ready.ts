import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Container-local readiness signal; never a source of processing state. */
export const workerReadyFile = join(tmpdir(), 'brainless-worker-ready');

export function markWorkerReady(ready: boolean): void {
  if (ready) writeFileSync(workerReadyFile, '', { mode: 0o600 });
  else if (existsSync(workerReadyFile)) unlinkSync(workerReadyFile);
}
