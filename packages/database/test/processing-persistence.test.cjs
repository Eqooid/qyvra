const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const {
  createPrismaClient,
  createStoredFileVerificationIntent,
} = require('../dist');

test('processing job and outbox persistence against PostgreSQL', async (t) => {
  const url = process.env.TEST_DATABASE_URL;
  assert.ok(
    url,
    'Set TEST_DATABASE_URL to a migrated, disposable test database.',
  );
  assert.match(new URL(url).pathname.slice(1), /test/i);
  const db = createPrismaClient({
    url,
    connectTimeoutMs: 2000,
    queryTimeoutMs: 5000,
    poolSize: 2,
  });
  const users = [];
  const documents = [];
  await db.$connect();
  async function fixture() {
    const user = await db.user.create({
      data: { email: `${randomUUID()}@example.invalid` },
    });
    users.push(user.id);
    const document = await db.document.create({
      data: { userId: user.id, title: 'Processing fixture' },
    });
    documents.push(document.id);
    const version = await db.documentVersion.create({
      data: {
        userId: user.id,
        documentId: document.id,
        versionNumber: 1,
        originalFilename: 'fixture.png',
        storageKey: `test/${randomUUID()}`,
        mimeType: 'image/png',
        fileSize: 12,
        checksumSha256: createHash('sha256').update(randomUUID()).digest('hex'),
      },
    });
    return { user, document, version };
  }
  function input(f) {
    return {
      userId: f.user.id,
      documentId: f.document.id,
      documentVersionId: f.version.id,
      correlationId: randomUUID(),
      maxAttempts: 3,
    };
  }
  try {
    await t.test(
      'persists a scoped job and the versioned outbox envelope atomically',
      async () => {
        const f = await fixture();
        const created = await db.$transaction((tx) =>
          createStoredFileVerificationIntent(tx, input(f)),
        );
        assert.equal(created.job.status, 'PENDING');
        assert.equal(created.job.jobType, 'VERIFY_STORED_FILE');
        assert.equal(created.job.attempts, 0);
        assert.equal(created.job.maxAttempts, 3);
        assert.equal(created.job.generation, 1);
        assert.equal(created.job.documentVersionId, f.version.id);
        assert.equal(created.job.documentId, f.document.id);
        assert.equal(created.job.userId, f.user.id);
        assert.equal(created.outbox.status, 'PENDING');
        assert.equal(created.outbox.publicationAttempts, 0);
        assert.equal(created.outbox.publishedAt, null);
        assert.equal(created.outbox.id, created.envelope.messageId);
        assert.deepEqual(created.outbox.payload, created.envelope);
        assert.equal(created.envelope.schemaVersion, 1);
        assert.equal(created.envelope.dispatchSequence, 1);
        assert.equal(created.envelope.jobId, created.job.id);
        assert.equal(created.envelope.documentId, f.document.id);
        assert.equal(created.envelope.documentVersionId, f.version.id);
        assert.equal(created.envelope.jobType, 'VERIFY_STORED_FILE');
        assert.deepEqual(Object.keys(created.envelope).sort(), [
          'correlationId',
          'dispatchSequence',
          'documentId',
          'documentVersionId',
          'jobId',
          'jobType',
          'messageId',
          'occurredAt',
          'schemaVersion',
          'type',
        ]);
        const found = await db.processingJob.findMany({
          where: {
            userId: f.user.id,
            documentId: f.document.id,
            documentVersionId: f.version.id,
          },
          include: { outbox: true },
        });
        assert.equal(found.length, 1);
        assert.equal(found[0].outbox.length, 1);
        assert.equal(found[0].outbox[0].id, created.outbox.id);
      },
    );

    await t.test(
      'rolls back both rows when the application transaction fails',
      async () => {
        const f = await fixture();
        let identifiers;
        await assert.rejects(
          db.$transaction(async (tx) => {
            identifiers = await createStoredFileVerificationIntent(
              tx,
              input(f),
            );
            throw new Error('TEST_ROLLBACK');
          }),
          /TEST_ROLLBACK/,
        );
        assert.equal(
          await db.processingJob.count({ where: { id: identifiers.job.id } }),
          0,
        );
        assert.equal(
          await db.processingOutbox.count({
            where: { id: identifiers.outbox.id },
          }),
          0,
        );
        await assert.rejects(
          db.$transaction(async (tx) => {
            const job = await tx.processingJob.create({
              data: {
                userId: f.user.id,
                documentId: f.document.id,
                documentVersionId: f.version.id,
                jobType: 'VERIFY_STORED_FILE',
                maxAttempts: 3,
                correlationId: randomUUID(),
              },
            });
            await tx.processingOutbox.create({
              data: {
                processingJobId: job.id,
                eventType: 'processing.execute',
                schemaVersion: 1,
                dispatchSequence: 1,
                payload: { messageId: randomUUID() },
                occurredAt: new Date(),
                correlationId: randomUUID(),
              },
            });
          }),
        );
        assert.equal(
          await db.processingJob.count({
            where: { documentVersionId: f.version.id },
          }),
          0,
        );
      },
    );

    await t.test(
      'enforces owner/version membership and duplicate-job rules',
      async () => {
        const owned = await fixture();
        const foreign = await fixture();
        await assert.rejects(
          db.$transaction((tx) =>
            createStoredFileVerificationIntent(tx, {
              ...input(owned),
              documentVersionId: foreign.version.id,
            }),
          ),
        );
        assert.equal(
          await db.processingJob.count({
            where: { documentVersionId: foreign.version.id },
          }),
          0,
        );
        const first = await db.$transaction((tx) =>
          createStoredFileVerificationIntent(tx, input(owned)),
        );
        await assert.rejects(
          db.$transaction((tx) =>
            createStoredFileVerificationIntent(tx, input(owned)),
          ),
        );
        await assert.rejects(
          db.processingJob.create({
            data: {
              userId: owned.user.id,
              documentId: owned.document.id,
              documentVersionId: owned.version.id,
              jobType: 'VERIFY_STORED_FILE',
              generation: 2,
              maxAttempts: 3,
              correlationId: randomUUID(),
            },
          }),
        );
        assert.equal(
          await db.processingOutbox.count({
            where: { processingJobId: first.job.id },
          }),
          1,
        );
        await db.processingJob.update({
          where: { id: first.job.id },
          data: { status: 'FAILED', completedAt: new Date() },
        });
        const next = await db.processingJob.create({
          data: {
            userId: owned.user.id,
            documentId: owned.document.id,
            documentVersionId: owned.version.id,
            jobType: 'VERIFY_STORED_FILE',
            generation: 2,
            maxAttempts: 3,
            correlationId: randomUUID(),
          },
        });
        assert.equal(next.generation, 2);
        assert.equal(next.status, 'PENDING');
      },
    );

    await t.test(
      'persists retry/lease fields and checks lifecycle invariants',
      async () => {
        const f = await fixture();
        const { job, outbox } = await db.$transaction((tx) =>
          createStoredFileVerificationIntent(tx, input(f)),
        );
        const startedAt = new Date();
        const leaseToken = randomUUID();
        const processing = await db.processingJob.update({
          where: { id: job.id },
          data: {
            status: 'PROCESSING',
            attempts: 1,
            leaseToken,
            leaseExpiresAt: new Date(startedAt.getTime() + 60000),
            startedAt,
            heartbeatAt: startedAt,
          },
        });
        assert.equal(processing.leaseToken, leaseToken);
        assert.equal(processing.attempts, 1);
        const availableAt = new Date(startedAt.getTime() + 120000);
        const retry = await db.processingJob.update({
          where: { id: job.id },
          data: {
            status: 'RETRYING',
            leaseToken: null,
            leaseExpiresAt: null,
            heartbeatAt: null,
            availableAt,
            lastFailureCode: 'STORAGE_UNAVAILABLE',
          },
        });
        assert.equal(retry.availableAt.getTime(), availableAt.getTime());
        assert.equal(retry.lastFailureCode, 'STORAGE_UNAVAILABLE');
        await assert.rejects(
          db.processingJob.update({
            where: { id: job.id },
            data: { attempts: 4 },
          }),
        );
        await assert.rejects(
          db.processingJob.update({
            where: { id: job.id },
            data: { status: 'UNKNOWN' },
          }),
        );
        const failure = await db.processingJob.update({
          where: { id: job.id },
          data: { status: 'FAILED', completedAt: new Date() },
        });
        assert.equal(failure.status, 'FAILED');
        assert.notEqual(failure.completedAt, null);
        await assert.rejects(
          db.processingOutbox.update({
            where: { id: outbox.id },
            data: { status: 'PUBLISHED' },
          }),
        );
        const publishedAt = new Date();
        const published = await db.processingOutbox.update({
          where: { id: outbox.id },
          data: { status: 'PUBLISHED', publishedAt, publicationAttempts: 1 },
        });
        assert.equal(published.status, 'PUBLISHED');
        assert.equal(published.publishedAt.getTime(), publishedAt.getTime());
      },
    );
  } finally {
    try {
      await db.document.deleteMany({ where: { id: { in: documents } } });
      await db.user.deleteMany({ where: { id: { in: users } } });
    } finally {
      await db.$disconnect();
    }
  }
});
