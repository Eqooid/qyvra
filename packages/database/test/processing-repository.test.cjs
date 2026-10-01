const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const {
  createPrismaClient,
  ProcessingRepository,
  ProcessingError,
} = require('../dist');

test('processing repository against PostgreSQL', async (t) => {
  const url = process.env.TEST_DATABASE_URL;
  assert.ok(
    url,
    'Set TEST_DATABASE_URL to a migrated disposable test database.',
  );
  assert.match(new URL(url).pathname.slice(1), /test/i);
  const db = createPrismaClient({
    url,
    connectTimeoutMs: 2000,
    queryTimeoutMs: 5000,
    poolSize: 4,
  });
  const repository = new ProcessingRepository(db);
  const users = [];
  await db.$connect();
  async function fixture() {
    const user = await db.user.create({
      data: { email: `${randomUUID()}@example.invalid` },
    });
    users.push(user.id);
    const document = await db.document.create({
      data: { userId: user.id, title: 'Job rules fixture' },
    });
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
  const input = (f, maxAttempts = 3) => ({
    userId: f.user.id,
    documentId: f.document.id,
    documentVersionId: f.version.id,
    correlationId: randomUUID(),
    maxAttempts,
  });
  const isCode = (code) => (error) =>
    error instanceof ProcessingError && error.code === code;
  try {
    await t.test(
      'idempotent creation, owned lookup, replay generation, and rollback',
      async () => {
        const f = await fixture();
        const created = await repository.create(input(f));
        assert.equal(created.created, true);
        assert.equal(created.job.status, 'PENDING');
        assert.equal(created.outbox.status, 'PENDING');
        const repeated = await repository.create(input(f));
        assert.equal(repeated.created, false);
        assert.equal(repeated.job.id, created.job.id);
        assert.equal(repeated.outbox.id, created.outbox.id);
        const parallel = await fixture();
        const racing = await Promise.all([
          repository.create(input(parallel)),
          repository.create(input(parallel)),
        ]);
        assert.equal(racing.filter((result) => result.created).length, 1);
        assert.equal(racing[0].job.id, racing[1].job.id);
        assert.equal(racing[0].outbox.id, racing[1].outbox.id);
        assert.equal(
          (
            await repository.findByVersion(
              f.user.id,
              f.document.id,
              f.version.id,
            )
          ).length,
          1,
        );
        assert.equal(
          (
            await repository.findByVersion(
              randomUUID(),
              f.document.id,
              f.version.id,
            )
          ).length,
          0,
        );
        assert.equal(
          (await repository.findByDocument(f.user.id, f.document.id, 10))
            .length,
          1,
        );
        await assert.rejects(
          repository.create({ ...input(f), documentId: randomUUID() }),
          isCode('INELIGIBLE_DOCUMENT'),
        );
        await assert.rejects(
          repository.create({ ...input(f), maxAttempts: 0 }),
          isCode('INVALID_INPUT'),
        );
        await assert.rejects(
          repository.create({ ...input(f), documentVersionId: 'bad-id' }),
          isCode('INVALID_INPUT'),
        );
        await assert.rejects(
          repository.create({ ...input(f), jobType: 'EMBED_DOCUMENT' }),
          isCode('UNSUPPORTED_JOB_TYPE'),
        );
        let rolledBackFixture;
        await assert.rejects(
          db.$transaction(async (tx) => {
            rolledBackFixture = await fixture();
            await repository.createInTransaction(tx, input(rolledBackFixture));
            throw new Error('ROLLBACK');
          }),
          /ROLLBACK/,
        );
        assert.equal(
          await db.processingJob.count({
            where: { documentVersionId: rolledBackFixture.version.id },
          }),
          0,
        );
        assert.equal(
          await db.processingOutbox.count({
            where: { job: { documentVersionId: rolledBackFixture.version.id } },
          }),
          0,
        );
        const started = await repository.claim(
          created.job.id,
          new Date(),
          60000,
        );
        await repository.fail(
          created.job.id,
          started.leaseToken,
          new Date(),
          'FILE_MISMATCH',
          false,
        );
        await assert.rejects(
          repository.create(input(f)),
          isCode('DUPLICATE_JOB'),
        );
        const replay = await repository.create(input(f), true);
        assert.equal(replay.job.generation, 2);
        assert.equal(replay.outbox.payload.dispatchSequence, 1);
      },
    );

    await t.test(
      'concurrent claims spend exactly one attempt and completion is idempotent',
      async () => {
        const f = await fixture();
        const { job } = await repository.create(input(f));
        const now = new Date();
        const results = await Promise.allSettled([
          repository.claim(job.id, now, 60000),
          repository.claim(job.id, now, 60000),
        ]);
        assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
        const claimed = await repository.findById(job.id);
        assert.equal(claimed.attempts, 1);
        assert.equal(claimed.status, 'PROCESSING');
        await assert.rejects(
          repository.complete(job.id, randomUUID(), now),
          isCode('CONCURRENT_CHANGE'),
        );
        const done = await repository.complete(job.id, claimed.leaseToken, now);
        assert.equal(done.status, 'COMPLETED');
        assert.equal(done.completedAt.getTime(), now.getTime());
        assert.equal(done.leaseToken, null);
        assert.equal(
          (await repository.complete(job.id, claimed.leaseToken, now)).attempts,
          1,
        );
        await assert.rejects(
          repository.claim(job.id, now, 60000),
          isCode('INVALID_TRANSITION'),
        );
      },
    );

    await t.test(
      'retry scheduling, due query, next dispatch, and exhausted terminal failure',
      async () => {
        const f = await fixture();
        const { job } = await repository.create(input(f, 2));
        const first = await repository.claim(job.id, new Date(), 60000);
        const failedAt = new Date();
        const retry = await repository.fail(
          job.id,
          first.leaseToken,
          failedAt,
          'STORAGE_UNAVAILABLE',
          true,
        );
        assert.equal(retry.status, 'RETRYING');
        assert.equal(retry.attempts, 1);
        assert.ok(retry.availableAt > failedAt);
        assert.equal(retry.lastFailureCode, 'STORAGE_UNAVAILABLE');
        assert.equal(
          (await repository.findRetryEligible(failedAt, 100)).includes(job.id),
          false,
        );
        const due = new Date(retry.availableAt.getTime() + 1);
        assert.ok(
          (await repository.findRetryEligible(due, 100)).includes(job.id),
        );
        const dispatch = await repository.scheduleRetryDispatch(job.id, due);
        assert.equal(dispatch.dispatchSequence, 2);
        assert.equal(
          (await repository.findRetryEligible(due, 100)).includes(job.id),
          false,
          'an existing retry intent must not occupy every later polling batch',
        );
        assert.equal(
          (await repository.scheduleRetryDispatch(job.id, due)).id,
          dispatch.id,
        );
        await assert.rejects(
          repository.markQueued(job.id, 1, due),
          isCode('INVALID_TRANSITION'),
        );
        await assert.rejects(
          repository.markQueued(job.id, 2, due),
          isCode('INVALID_TRANSITION'),
        );
        const dispatchClaim = await repository.claimOutbox(
          dispatch.id,
          due,
          60000,
        );
        await repository.markOutboxPublished(
          dispatch.id,
          dispatchClaim.claimToken,
          due,
        );
        await repository.markQueued(job.id, 2, due);
        assert.equal(
          (await repository.markQueued(job.id, 2, due)).status,
          'QUEUED',
        );
        const second = await repository.claim(job.id, due, 60000);
        assert.equal(second.attempts, 2);
        const terminal = await repository.fail(
          job.id,
          second.leaseToken,
          due,
          'STORAGE_UNAVAILABLE',
          true,
        );
        assert.equal(terminal.status, 'FAILED');
        assert.equal(terminal.completedAt.getTime(), due.getTime());
        assert.equal(
          (
            await repository.findRetryEligible(
              new Date(due.getTime() + 600000),
              100,
            )
          ).includes(job.id),
          false,
        );
        await assert.rejects(
          repository.fail(
            job.id,
            second.leaseToken,
            due,
            'STORAGE_UNAVAILABLE',
            true,
          ),
          isCode('INVALID_TRANSITION'),
        );
      },
    );

    await t.test(
      'concurrent retry scheduling creates one outbox intent and an insertion failure remains recoverable',
      async () => {
        const f = await fixture();
        const { job } = await repository.create(input(f));
        const claimed = await repository.claim(job.id, new Date(), 60000);
        const retry = await repository.fail(
          job.id,
          claimed.leaseToken,
          new Date(),
          'STORAGE_READ_FAILED',
          true,
        );
        const due = new Date(retry.availableAt.getTime() + 1);
        await db.$executeRawUnsafe(
          'ALTER TABLE processing_outbox ADD CONSTRAINT test_reject_retry_dispatch CHECK (dispatch_sequence <> 2) NOT VALID',
        );
        try {
          await assert.rejects(repository.scheduleRetryDispatch(job.id, due));
          assert.equal((await repository.findById(job.id)).status, 'RETRYING');
          assert.equal(
            await db.processingOutbox.count({
              where: { processingJobId: job.id, dispatchSequence: 2 },
            }),
            0,
          );
        } finally {
          await db.$executeRawUnsafe(
            'ALTER TABLE processing_outbox DROP CONSTRAINT test_reject_retry_dispatch',
          );
        }
        const results = await Promise.all([
          repository.scheduleRetryDispatch(job.id, due),
          repository.scheduleRetryDispatch(job.id, due),
        ]);
        assert.equal(results[0].id, results[1].id);
        assert.equal(
          await db.processingOutbox.count({
            where: { processingJobId: job.id, dispatchSequence: 2 },
          }),
          1,
        );
      },
    );

    await t.test('expired lease candidates and fenced recovery', async () => {
      const f = await fixture();
      const { job } = await repository.create(input(f));
      const now = new Date();
      const active = await repository.claim(job.id, now, 1000);
      assert.deepEqual(await repository.findStaleProcessing(now, 10), []);
      await assert.rejects(
        repository.recoverInterrupted(job.id, active.leaseToken, now),
        isCode('CONCURRENT_CHANGE'),
      );
      const later = new Date(now.getTime() + 1001);
      assert.ok(
        (await repository.findStaleProcessing(later, 10)).includes(job.id),
      );
      const recovered = await repository.recoverInterrupted(
        job.id,
        active.leaseToken,
        later,
      );
      assert.equal(recovered.status, 'RETRYING');
      assert.equal(recovered.lastFailureCode, 'WORKER_INTERRUPTED');
      await assert.rejects(
        repository.complete(job.id, active.leaseToken, later),
        isCode('INVALID_TRANSITION'),
      );

      const exhaustedFixture = await fixture();
      const exhaustedJob = await repository.create(input(exhaustedFixture, 1));
      const exhaustedAt = new Date();
      const exhaustedClaim = await repository.claim(
        exhaustedJob.job.id,
        exhaustedAt,
        1000,
      );
      const exhausted = await repository.recoverInterrupted(
        exhaustedJob.job.id,
        exhaustedClaim.leaseToken,
        new Date(exhaustedAt.getTime() + 1001),
      );
      assert.equal(exhausted.status, 'FAILED');
      assert.equal(exhausted.attempts, 1);
      assert.equal(
        (
          await repository.findRetryEligible(
            new Date(later.getTime() + 600000),
            10,
          )
        ).includes(exhausted.id),
        false,
      );
      assert.equal(
        await db.processingOutbox.count({
          where: { processingJobId: exhausted.id },
        }),
        1,
      );
    });

    await t.test(
      'archived documents are excluded from recovery and retry scheduling',
      async () => {
        const f = await fixture();
        const { job } = await repository.create(input(f));
        const now = new Date();
        const claim = await repository.claim(job.id, now, 1000);
        await db.document.update({
          where: { id: f.document.id },
          data: { isArchived: true, status: 'ARCHIVED' },
        });
        const later = new Date(now.getTime() + 1001);
        assert.equal(
          (await repository.findStaleProcessing(later, 10)).includes(job.id),
          false,
        );
        await db.document.update({
          where: { id: f.document.id },
          data: { isArchived: false, status: 'UPLOADED' },
        });
        const retry = await repository.recoverInterrupted(
          job.id,
          claim.leaseToken,
          later,
        );
        await db.document.update({
          where: { id: f.document.id },
          data: { isArchived: true, status: 'ARCHIVED' },
        });
        const due = new Date(retry.availableAt.getTime() + 1);
        assert.equal(
          (await repository.findRetryEligible(due, 10)).includes(job.id),
          false,
        );
        await assert.rejects(
          repository.scheduleRetryDispatch(job.id, due),
          isCode('INELIGIBLE_DOCUMENT'),
        );
      },
    );

    await t.test(
      'archive eligibility, atomic cancellation, and outbox claim fencing',
      async () => {
        const f = await fixture();
        const { job, outbox } = await repository.create(input(f));
        const now = new Date();
        await assert.rejects(
          repository.markQueued(job.id, 1, now),
          isCode('INVALID_TRANSITION'),
        );
        assert.equal(
          (await repository.findPendingOutbox(now, 100)).some(
            (row) => row.id === outbox.id,
          ),
          true,
        );
        const results = await Promise.allSettled([
          repository.claimOutbox(outbox.id, now, 60000),
          repository.claimOutbox(outbox.id, now, 60000),
        ]);
        assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
        const claimed = await db.processingOutbox.findUniqueOrThrow({
          where: { id: outbox.id },
        });
        assert.equal(claimed.publicationAttempts, 1);
        await assert.rejects(
          repository.markOutboxPublished(outbox.id, randomUUID(), now),
          isCode('CONCURRENT_CHANGE'),
        );
        await repository.recordOutboxFailure(
          outbox.id,
          claimed.claimToken,
          now,
          'BROKER_UNAVAILABLE',
          new Date(now.getTime() + 1000),
        );
        const again = await repository.claimOutbox(
          outbox.id,
          new Date(now.getTime() + 1001),
          60000,
        );
        const published = await repository.markOutboxPublished(
          outbox.id,
          again.claimToken,
          new Date(now.getTime() + 1001),
        );
        assert.equal(published.status, 'PUBLISHED');
        assert.equal(published.publicationAttempts, 2);
        assert.equal(
          (await repository.markQueued(job.id, 1, now)).status,
          'QUEUED',
        );
        await db.document.update({
          where: { id: f.document.id },
          data: { isArchived: true, status: 'ARCHIVED' },
        });
        await assert.rejects(
          repository.claim(job.id, now, 60000),
          isCode('CONCURRENT_CHANGE'),
        );
        const cancelled = await db.$transaction((tx) =>
          repository.cancelUnfinishedForDocument(
            tx,
            f.user.id,
            f.document.id,
            now,
          ),
        );
        assert.equal(cancelled, 1);
        assert.equal((await repository.findById(job.id)).status, 'CANCELLED');
        await assert.rejects(
          repository.create(input(f)),
          isCode('INELIGIBLE_DOCUMENT'),
        );
      },
    );
  } finally {
    try {
      await db.document.deleteMany({ where: { userId: { in: users } } });
      await db.user.deleteMany({ where: { id: { in: users } } });
    } finally {
      await db.$disconnect();
    }
  }
});
