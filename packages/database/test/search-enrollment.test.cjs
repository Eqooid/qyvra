const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const {
  createPrismaClient,
  SearchEnrollmentRepository,
  SearchPersistenceRepository,
  ProcessingRepository,
  searchRecordId,
} = require('../dist');

test('T03 SQL enrollment, fencing, fanout and recovery', async (t) => {
  const url = process.env.TEST_DATABASE_URL;
  assert.ok(url, 'A migrated disposable TEST_DATABASE_URL is required.');
  assert.match(new URL(url).pathname, /test/i);
  const db = createPrismaClient({
    url,
    connectTimeoutMs: 2000,
    queryTimeoutMs: 15000,
    poolSize: 8,
  });
  const enrollment = new SearchEnrollmentRepository(db);
  const persistence = new SearchPersistenceRepository(db);
  const processing = new ProcessingRepository(db);
  const users = [],
    generations = [];
  const digest = (value) => createHash('sha256').update(value).digest('hex');
  async function generation() {
    const key = randomUUID();
    const g = await persistence.createGeneration({
      generation: 100 + generations.length,
      schemaVersion: 1,
      mappingVersion: key,
      analyzerVersion: 'v1',
      extractor: 'pdf',
      extractorVersion: 'v1',
      normalizationVersion: 'nfc-lf-v1',
      segmentationVersion: 'v1',
      metadataIndexName: 'qyvra-search-' + key + '-metadata',
      pageIndexName: 'qyvra-search-' + key + '-pages',
    });
    generations.push(g.id);
    return g;
  }
  const g = await generation();
  const policy = { enabled: true, generationFingerprint: g.fingerprint };
  async function fixture() {
    const user = await db.user.create({
      data: { email: randomUUID() + '@example.invalid' },
    });
    users.push(user.id);
    const document = await db.document.create({
      data: { userId: user.id, title: 'T03 fixture' },
    });
    const version = await db.documentVersion.create({
      data: {
        userId: user.id,
        documentId: document.id,
        versionNumber: 1,
        originalFilename: 'fixture.png',
        mimeType: 'image/png',
        fileSize: 12,
        storageKey: 'test/' + randomUUID(),
        checksumSha256: digest(randomUUID()),
      },
    });
    return { userId: user.id, documentId: document.id, version };
  }
  const enroll = (f) =>
    db.$transaction((tx) =>
      enrollment.enrollInTransaction(tx, f.userId, f.documentId, policy),
    );
  const state = (f) =>
    db.documentSearchState.findUnique({ where: { documentId: f.documentId } });
  const job = (p) =>
    db.processingJob.findFirst({
      where: { searchProjectionId: p.id, jobType: 'INDEX_SEARCH' },
    });
  async function ready(p) {
    await db.searchIndexGeneration.update({
      where: { id: p.indexGenerationId },
      data: { status: 'SERVING' },
    });
    await db.versionSearchProjection.update({
      where: { id: p.id },
      data: {
        status: 'READY',
        metadataReady: true,
        verifiedAt: new Date(),
        expectedRecordIds: [searchRecordId(p.id, { kind: 'metadata' })],
        expectedRecordCount: 1,
        recordsHash: digest('verified fixture'),
      },
    });
    await db.documentSearchState.update({
      where: { documentId: p.documentId },
      data: { readyProjectionId: p.id },
    });
  }
  try {
    await t.test(
      'enabled policy requires a provisioned non-retired generation',
      async () => {
        await enrollment.validatePolicy(policy);
        await assert.rejects(
          enrollment.validatePolicy({
            enabled: true,
            generationFingerprint: 'a'.repeat(64),
          }),
        );
        await enrollment.validatePolicy({
          enabled: false,
          generationFingerprint: '',
        });
      },
    );
    await t.test(
      'concurrent enrollment converges on one projection, job and v3 outbox',
      async () => {
        const f = await fixture();
        const results = await Promise.all([enroll(f), enroll(f), enroll(f)]);
        assert.equal(new Set(results.map((p) => p.id)).size, 1);
        const j = await job(results[0]);
        assert.equal(
          await db.processingJob.count({
            where: { documentId: f.documentId, jobType: 'INDEX_SEARCH' },
          }),
          1,
        );
        const outbox = await db.processingOutbox.findFirst({
          where: { processingJobId: j.id },
        });
        assert.equal(outbox.schemaVersion, 3);
        assert.equal(outbox.payload.revision, 1);
        assert.equal(outbox.payload.correlationId, j.correlationId);
        assert.equal(outbox.payload.searchProjectionId, results[0].id);
        assert.equal(
          JSON.stringify(outbox.payload).includes('T03 fixture'),
          false,
        );
        assert.equal(
          (
            await processing.findPendingOutbox(new Date(Date.now() + 1000), 100)
          ).some((o) => o.id === outbox.id),
          false,
        );
        assert.equal(
          (
            await processing.findPendingOutbox(
              new Date(Date.now() + 1000),
              100,
              ['INDEX_SEARCH'],
            )
          ).some((o) => o.id === outbox.id),
          true,
        );
      },
    );
    await t.test(
      'enrollment and document version roll back with jobs and outbox',
      async () => {
        const f = await fixture();
        await assert.rejects(
          db.$transaction(async (tx) => {
            await enrollment.enrollInTransaction(
              tx,
              f.userId,
              f.documentId,
              policy,
            );
            throw new Error('Injected post-scheduling failure');
          }),
        );
        assert.equal(await state(f), null);
        assert.equal(
          await db.processingJob.count({ where: { documentId: f.documentId } }),
          0,
        );
        await assert.rejects(
          db.$transaction(async (tx) => {
            await tx.documentVersion.create({
              data: {
                ...f.version,
                id: randomUUID(),
                versionNumber: 2,
                storageKey: 'test/' + randomUUID(),
                checksumSha256: digest(randomUUID()),
              },
            });
            await enrollment.enrollInTransaction(tx, f.userId, f.documentId, {
              enabled: true,
              generationFingerprint: '0'.repeat(64),
            });
          }),
        );
        assert.equal(
          await db.documentVersion.count({
            where: { documentId: f.documentId },
          }),
          1,
        );
      },
    );
    await t.test(
      'metadata replacement clears publication and cancels old work while preserving cleanup',
      async () => {
        const f = await fixture();
        const p = await enroll(f);
        await ready(p);
        const next = await db.$transaction(async (tx) => {
          await tx.document.update({
            where: { id: f.documentId },
            data: { title: 'Changed' },
          });
          return enrollment.enrollInTransaction(
            tx,
            f.userId,
            f.documentId,
            policy,
          );
        });
        assert.equal(next.revision, 2);
        assert.equal((await state(f)).readyProjectionId, null);
        assert.equal((await job(p)).status, 'CANCELLED');
        assert.equal(
          (await db.versionSearchProjection.findUnique({ where: { id: p.id } }))
            .status,
          'REMOVAL_PENDING',
        );
        const cleanup = await db.processingJob.findFirst({
          where: { searchProjectionId: p.id, jobType: 'REMOVE_SEARCH_INDEX' },
        });
        assert.equal(cleanup.status, 'PENDING');
        await assert.rejects(ready(p));
        await db.$transaction((tx) =>
          processing.cancelUnfinishedForDocument(
            tx,
            f.userId,
            f.documentId,
            new Date(),
          ),
        );
        assert.equal(
          (await db.processingJob.findUnique({ where: { id: cleanup.id } }))
            .status,
          'PENDING',
        );
      },
    );
    await t.test(
      'archive is idempotent; restore creates a new revision; deletion prevents enrollment',
      async () => {
        const f = await fixture();
        const p = await enroll(f);
        await db.$transaction(async (tx) => {
          await tx.document.update({
            where: { id: f.documentId },
            data: { isArchived: true, status: 'ARCHIVED' },
          });
          await enrollment.invalidateInTransaction(tx, f.userId, f.documentId);
        });
        assert.equal((await state(f)).desiredRevision, 2);
        assert.equal(await enroll(f), null);
        assert.equal((await state(f)).desiredRevision, 2);
        await db.document.update({
          where: { id: f.documentId },
          data: { isArchived: false, status: 'ACTIVE' },
        });
        const restored = await enroll(f);
        assert.equal(restored.revision, 3);
        await db.$transaction(async (tx) => {
          await tx.document.update({
            where: { id: f.documentId },
            data: { deletedAt: new Date(), status: 'DELETING' },
          });
          await enrollment.invalidateInTransaction(tx, f.userId, f.documentId);
        });
        assert.equal(await enroll(f), null);
        assert.equal((await job(p)).status, 'CANCELLED');
      },
    );
    await t.test(
      'new current version and generation fence previous work',
      async () => {
        const f = await fixture();
        const old = await enroll(f);
        const next = await db.$transaction(async (tx) => {
          await tx.documentVersion.create({
            data: {
              ...f.version,
              id: randomUUID(),
              versionNumber: 2,
              storageKey: 'test/' + randomUUID(),
              checksumSha256: digest(randomUUID()),
            },
          });
          return enrollment.enrollInTransaction(
            tx,
            f.userId,
            f.documentId,
            policy,
          );
        });
        assert.notEqual(next.documentVersionId, old.documentVersionId);
        assert.equal((await state(f)).desiredVersionId, next.documentVersionId);
        const newer = await generation();
        const changed = await db.$transaction((tx) =>
          enrollment.enrollInTransaction(tx, f.userId, f.documentId, {
            enabled: true,
            generationFingerprint: newer.fingerprint,
          }),
        );
        assert.equal(changed.revision, next.revision + 1);
        assert.equal((await job(next)).status, 'CANCELLED');
      },
    );
    await t.test(
      'tag cascade is fenced immediately, checkpoint fanout resumes and duplicate events converge',
      async () => {
        const f = await fixture();
        const tag = await db.tag.create({
          data: { userId: f.userId, name: 'fixture' },
        });
        await db.documentTag.create({
          data: { userId: f.userId, documentId: f.documentId, tagId: tag.id },
        });
        const p = await enroll(f);
        const j = await job(p);
        await db.$transaction(async (tx) => {
          await tx.tag.delete({ where: { id: tag.id, userId: f.userId } });
          await enrollment.recordOrganizationChangeInTransaction(
            tx,
            f.userId,
            tag.id,
            'TAG_DELETED',
            policy,
          );
          await enrollment.recordOrganizationChangeInTransaction(
            tx,
            f.userId,
            tag.id,
            'TAG_DELETED',
            policy,
          );
        });
        assert.equal(
          await db.searchProjectionChange.count({
            where: { resourceId: tag.id },
          }),
          1,
        );
        await assert.rejects(
          processing.claim(j.id, new Date(), 1000),
          (e) => e.code === 'INELIGIBLE_DOCUMENT',
        );
        await assert.rejects(ready(p));
        // One batch processes the document, the next commits the end-of-scan checkpoint.
        await enrollment.reconcile(policy, 1);
        await enrollment.reconcile(policy, 1);
        const checkpoint = await db.searchProjectionChange.findFirst({
          where: { resourceId: tag.id },
        });
        assert.equal(checkpoint.status, 'COMPLETED');
        assert.equal((await state(f)).desiredRevision, 2);
        await enrollment.reconcile(policy, 1);
        assert.equal((await state(f)).desiredRevision, 2);
      },
    );
    await t.test(
      'missing outbox intent is recoverable without replacing the job or correlation',
      async () => {
        const f = await fixture();
        const p = await enroll(f);
        const before = await job(p);
        await db.processingOutbox.deleteMany({
          where: { processingJobId: before.id },
        });
        await enroll(f);
        const after = await job(p);
        assert.equal(after.id, before.id);
        assert.equal(after.correlationId, before.correlationId);
        assert.equal(
          await db.processingOutbox.count({
            where: { processingJobId: after.id },
          }),
          1,
        );
      },
    );
    await t.test(
      'foreign owner and malformed identifiers cannot enroll or invalidate',
      async () => {
        const f = await fixture();
        await assert.rejects(
          db.$transaction((tx) =>
            enrollment.enrollInTransaction(
              tx,
              randomUUID(),
              f.documentId,
              policy,
            ),
          ),
        );
        await assert.rejects(
          db.$transaction((tx) =>
            enrollment.invalidateInTransaction(tx, 'invalid', f.documentId),
          ),
        );
        assert.equal(await state(f), null);
      },
    );
    await t.test(
      'disabling enrollment schedules no new build and revokes enrolled state',
      async () => {
        const f = await fixture();
        const p = await enroll(f);
        await db.$transaction((tx) =>
          enrollment.enrollInTransaction(tx, f.userId, f.documentId, {
            enabled: false,
            generationFingerprint: '',
          }),
        );
        assert.equal((await job(p)).status, 'CANCELLED');
        assert.equal((await state(f)).readyProjectionId, null);
      },
    );
    await t.test(
      'concurrent edit and archive converge on ineligible state without active build work',
      async () => {
        const f = await fixture();
        const p = await enroll(f);
        await Promise.all([
          db.$transaction(async (tx) => {
            await tx.document.update({
              where: { id: f.documentId },
              data: { title: 'Concurrent edit' },
            });
            await enrollment.enrollInTransaction(
              tx,
              f.userId,
              f.documentId,
              policy,
            );
          }),
          db.$transaction(async (tx) => {
            await tx.document.update({
              where: { id: f.documentId },
              data: { isArchived: true, status: 'ARCHIVED' },
            });
            await enrollment.invalidateInTransaction(
              tx,
              f.userId,
              f.documentId,
            );
          }),
        ]);
        assert.equal((await state(f)).readyProjectionId, null);
        assert.equal(
          await db.processingJob.count({
            where: {
              documentId: f.documentId,
              jobType: 'INDEX_SEARCH',
              status: { in: ['PENDING', 'QUEUED', 'PROCESSING', 'RETRYING'] },
            },
          }),
          0,
        );
        assert.equal((await job(p)).status, 'CANCELLED');
      },
    );
    await t.test(
      'fanout rollback and competing recovery passes preserve the checkpoint',
      async () => {
        const f = await fixture();
        await enroll(f);
        const tag = await db.tag.create({
          data: { userId: f.userId, name: 'Restart checkpoint' },
        });
        await db.$transaction(async (tx) => {
          await tx.documentTag.create({
            data: { documentId: f.documentId, userId: f.userId, tagId: tag.id },
          });
          await enrollment.enrollInTransaction(
            tx,
            f.userId,
            f.documentId,
            policy,
          );
        });
        const change = await db.$transaction(async (tx) => {
          await tx.tag.delete({ where: { id: tag.id } });
          return enrollment.recordOrganizationChangeInTransaction(
            tx,
            f.userId,
            tag.id,
            'TAG_DELETED',
            policy,
          );
        });
        await assert.rejects(
          enrollment.reconcile(
            { enabled: true, generationFingerprint: '0'.repeat(64) },
            1,
          ),
        );
        assert.equal(
          (
            await db.searchProjectionChange.findUnique({
              where: { id: change.id },
            })
          ).afterDocumentId,
          null,
        );
        await Promise.all([
          enrollment.reconcile(policy, 1),
          enrollment.reconcile(policy, 1),
        ]);
        await new SearchEnrollmentRepository(db).reconcile(policy, 1);
        assert.equal(
          (
            await db.searchProjectionChange.findUnique({
              where: { id: change.id },
            })
          ).status,
          'COMPLETED',
        );
        assert.equal((await state(f)).desiredRevision, 3);
      },
    );
    await t.test(
      'obsolete in-flight results are cancelled and cannot complete after membership changes',
      async () => {
        const f = await fixture();
        const p = await enroll(f);
        const j = await job(p);
        const claimed = await processing.claim(
          j.id,
          new Date(),
          30000,
        );
        const tag = await db.tag.create({
          data: { userId: f.userId, name: 'Late result' },
        });
        await db.documentTag.create({
          data: { userId: f.userId, documentId: f.documentId, tagId: tag.id },
        });
        await assert.rejects(
          processing.complete(j.id, claimed.leaseToken, new Date()),
        );
        assert.equal(
          await processing.cancelObsoleteSearchJob(j.id, new Date()),
          true,
        );
        assert.equal(
          await processing.cancelObsoleteSearchJob(j.id, new Date()),
          false,
        );
        assert.equal((await job(p)).status, 'CANCELLED');
        await assert.rejects(ready(p));
      },
    );
  } finally {
    await db.document.deleteMany({ where: { userId: { in: users } } });
    await db.tag.deleteMany({ where: { userId: { in: users } } });
    await db.searchProjectionChange.deleteMany({
      where: { userId: { in: users } },
    });
    await db.user.deleteMany({ where: { id: { in: users } } });
    await db.searchIndexGeneration.deleteMany({
      where: { id: { in: generations } },
    });
    await db.$disconnect();
  }
});
