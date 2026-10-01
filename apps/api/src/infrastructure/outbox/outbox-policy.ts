/** Publication retry is separate from processing-job attempts. Delay is capped. */
export function outboxRetryDelayMs(messageId: string, attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1)
    throw new Error('Invalid outbox publication attempt.');
  const base = Math.min(300_000, 5_000 * 2 ** Math.min(attempt - 1, 16));
  let hash = attempt;
  for (const char of messageId)
    hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  return Math.min(300_000, base + Math.floor((base * (hash % 21)) / 100));
}
