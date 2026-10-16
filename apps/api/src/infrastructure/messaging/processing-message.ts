import {
  legacyProcessingJobTypes,
  isSearchJobType,
  type ProcessingMessage,
} from '@qyvra/database';

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
export function parseProcessingMessage(value: unknown): ProcessingMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Invalid processing message contract.');
  const record = value as Record<string, unknown>;
  const expectedFields =
    record.schemaVersion === 3
      ? [...fields, 'searchProjectionId', 'indexGenerationId', 'revision']
      : [...fields];
  if (
    Object.keys(record).length !== expectedFields.length ||
    expectedFields.some(
      (field) => !Object.prototype.hasOwnProperty.call(record, field),
    ) ||
    ![1, 2, 3].includes(record.schemaVersion as number) ||
    record.type !== 'processing.execute' ||
    (record.schemaVersion === 1
      ? record.jobType !== 'VERIFY_STORED_FILE'
      : record.schemaVersion === 2
        ? !legacyProcessingJobTypes.some((type) => type === record.jobType)
        : typeof record.jobType !== 'string' ||
          !isSearchJobType(record.jobType)) ||
    (record.schemaVersion === 3 &&
      (!Number.isSafeInteger(record.revision) ||
        (record.revision as number) < 1 ||
        (record.revision as number) > 2147483647 ||
        ![record.searchProjectionId, record.indexGenerationId].every(
          (id) => typeof id === 'string' && uuid.test(id),
        ))) ||
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
    expectedFields.map((field) => [field, record[field]]),
  );
  const bytes = Buffer.from(JSON.stringify(ordered), 'utf8');
  if (bytes.length > 4096)
    throw new Error('Processing message exceeds size limit.');
  return ordered as unknown as ProcessingMessage;
}

/** Validate at the infrastructure boundary even if the caller is typed. */
export function serializeProcessingMessage(message: ProcessingMessage): Buffer {
  return Buffer.from(JSON.stringify(parseProcessingMessage(message)), 'utf8');
}
