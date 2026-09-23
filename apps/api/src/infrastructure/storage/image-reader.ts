import { createRequire } from 'node:module';
// Sharp 0.35's legacy TypeScript resolution selects ESM declarations, while this
// project emits CommonJS. Its require export is the factory itself, not .default.
export const imageReader = createRequire(__filename)(
  'sharp',
) as typeof import('sharp').default;
