import type { ProcessingMessageV1 } from '@brainless/database';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fields = [
  'schemaVersion',
  'messageId',
  'type',
  'occurredAt',
  'correlationId',
  'jobId',
  'documentId',
  'documentVersionId',
  'jobType',
  'dispatchSequence',
] as const;

/** Recover the committed contract from PostgreSQL JSON without trusting a type assertion. */
export function parseProcessingMessage(value: unknown): ProcessingMessageV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Invalid processing message contract.');
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== fields.length ||
    fields.some(
      (field) => !Object.prototype.hasOwnProperty.call(record, field),
    ) ||
    record.schemaVersion !== 1 ||
    record.type !== 'processing.execute' ||
    record.jobType !== 'VERIFY_STORED_FILE' ||
    !Number.isSafeInteger(record.dispatchSequence) ||
    (record.dispatchSequence as number) < 1 ||
    ![
      record.messageId,
      record.correlationId,
      record.jobId,
      record.documentId,
      record.documentVersionId,
    ].every((id) => typeof id === 'string' && uuid.test(id)) ||
    typeof record.occurredAt !== 'string' ||
    Number.isNaN(Date.parse(record.occurredAt)) ||
    new Date(record.occurredAt).toISOString() !== record.occurredAt
  )
    throw new Error('Invalid processing message contract.');

  const ordered = Object.fromEntries(
    fields.map((field) => [field, record[field]]),
  );
  const bytes = Buffer.from(JSON.stringify(ordered), 'utf8');
  if (bytes.length > 4096)
    throw new Error('Processing message exceeds size limit.');
  return ordered as unknown as ProcessingMessageV1;
}

/** Validate at the infrastructure boundary even if the caller is typed. */
export function serializeProcessingMessage(
  message: ProcessingMessageV1,
): Buffer {
  return Buffer.from(JSON.stringify(parseProcessingMessage(message)), 'utf8');
}
