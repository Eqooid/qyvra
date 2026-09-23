/** @author Cristono Wijaya
 * @description Normalizes owned names to NFKC with trimmed, collapsed whitespace while preserving display case.
 * @param value - Untrusted transport value.
 * @returns - Normalized strings or the original value for type validation.
 * @tags Name Normalization
 */
export function normalizeOwnedName(value: unknown): unknown {
  return typeof value === 'string'
    ? value.normalize('NFKC').trim().replace(/\s+/gu, ' ')
    : value;
}
