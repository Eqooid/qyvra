const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const {
  createPrismaClient,
  ProcessingRepository,
  embeddingProfileFingerprint,
} = require('../dist');
const hash = (value) => createHash('sha256').update(value).digest('hex');

test('durable document pipeline against PostgreSQL', async (t) => {
  const url = process.env.TEST_DATABASE_URL;
  assert.ok(url, 'Use a migrated disposable TEST_DATABASE_URL');
  assert.match(new URL(url).pathname, /test/i);
  const db = createPrismaClient({
    url,
    connectTimeoutMs: 2000,
    queryTimeoutMs: 10000,
    poolSize: 6,
  });
  const repo = new ProcessingRepository(db);
  const users = [],
    profiles = [];
  async function fixture() {
    const user = await db.user.create({
      data: { email: `${randomUUID()}@example.invalid` },
    });
    users.push(user.id);
    const document = await db.document.create({
      data: { userId: user.id, title: 'Pipeline fixture' },
    });
    const version = await db.documentVersion.create({
      data: {
        userId: user.id,
        documentId: document.id,
        versionNumber: 1,
        originalFilename: 'test.pdf',
        storageKey: `test/${randomUUID()}`,
        mimeType: 'application/pdf',
        fileSize: 5,
        pageCount: 1,
        checksumSha256: hash('Alpha'),
      },
    });
    const identity = {
      profileVersion: 1,
      provider: 'test',
      model: randomUUID(),
      modelRevision: 'v1',
      dimensions: 3,
      distance: 'Cosine',
      normalizationVersion: 'v1',
      tokenizer: 'test',
      tokenizerVersion: 'v1',
      documentInstruction: '',
      queryInstruction: '',
    };
    const profile = await db.embeddingProfile.create({
      data: { ...identity, fingerprint: embeddingProfileFingerprint(identity) },
    });
    profiles.push(profile.id);
    const owned = {
      userId: user.id,
      documentId: document.id,
      documentVersionId: version.id,
    };
    const input = {
      ...owned,
      correlationId: randomUUID(),
      maxAttempts: 3,
      extractor: 'test',
      extractorVersion: 'v1',
      normalizationVersion: 'v1',
      chunkAlgorithm: 'test',
      chunkAlgorithmVersion: 'v1',
      tokenizer: 'test',
      tokenizerVersion: 'v1',
      chunkSize: 512,
      chunkOverlap: 64,
      embeddingProfileId: profile.id,
    };
    return { user, document, version, profile, owned, input };
  }
  async function pending(f, type) {
    return db.processingJob.findFirstOrThrow({
      where: { documentVersionId: f.version.id, jobType: type },
      orderBy: { generation: 'desc' },
    });
  }
  async function claim(f, type) {
    return repo.claim((await pending(f, type)).id, new Date(), 60000);
  }
  async function verify(f) {
    const job = await claim(f, 'VERIFY_STORED_FILE');
    return repo.complete(job.id, job.leaseToken, new Date());
  }
  async function extract(f) {
    const job = await claim(f, 'EXTRACT_TEXT');
    return repo.complete(job.id, job.leaseToken, new Date(), async (tx) => {
      const extraction = await tx.extractedText.upsert({
        where: {
          documentVersionId_extractionFingerprint: {
            documentVersionId: f.version.id,
            extractionFingerprint: hash('test-extraction'),
          },
        },
        create: {
          ...f.owned,
          extractionFingerprint: hash('test-extraction'),
          extractor: 'test',
          extractorVersion: 'v1',
          normalizationVersion: 'v1',
          sourceChecksum: f.version.checksumSha256,
          contentHash: hash('Alpha'),
          text: 'Alpha',
          pageSpans: [{ pageNumber: 1, startOffset: 0, endOffset: 5 }],
          characterCount: 5,
          pageCount: 1,
        },
        update: {},
      });
      return { extractedTextId: extraction.id };
    });
  }
  async function chunk(f) {
    const job = await claim(f, 'GENERATE_CHUNKS');
    return repo.complete(job.id, job.leaseToken, new Date(), async (tx) => {
      let set = await tx.chunkSet.findUnique({
        where: {
          documentVersionId_fingerprint: {
            documentVersionId: f.version.id,
            fingerprint: hash('test-chunk-set'),
          },
        },
      });
      if (!set) {
        set = await tx.chunkSet.create({
          data: {
            ...f.owned,
            extractedTextId: job.extractedTextId,
            extractionHash: hash('Alpha'),
            fingerprint: hash('test-chunk-set'),
            algorithm: 'test',
            algorithmVersion: 'v1',
            tokenizer: 'test',
            tokenizerVersion: 'v1',
            chunkSize: 512,
            chunkOverlap: 64,
          },
        });
        await tx.documentChunk.create({
          data: {
            ...f.owned,
            id: randomUUID(),
            chunkSetId: set.id,
            ordinal: 0,
            text: 'Alpha',
            textHash: hash('Alpha'),
            startOffset: 0,
            endOffset: 5,
            tokenCount: 1,
            pageSpans: [{ pageNumber: 1, startOffset: 0, endOffset: 5 }],
          },
        });
        set = await tx.chunkSet.update({
          where: { id: set.id },
          data: { complete: true, chunkCount: 1 },
        });
      }
      return { chunkSetId: set.id };
    });
  }
  async function embed(f) {
    const job = await claim(f, 'GENERATE_EMBEDDINGS');
    return repo.complete(job.id, job.leaseToken, new Date(), async (tx) => {
      const source = await tx.documentChunk.findFirstOrThrow({
        where: { chunkSetId: job.chunkSetId },
      });
      await tx.chunkEmbedding.upsert({
        where: {
          chunkId_embeddingProfileId: {
            chunkId: source.id,
            embeddingProfileId: f.profile.id,
          },
        },
        create: {
          ...f.owned,
          chunkId: source.id,
          embeddingProfileId: f.profile.id,
          dimensions: 3,
          inputHash: hash('Alpha'),
          vector: [1, 2, 3],
        },
        update: {},
      });
      return {};
    });
  }
  async function index(f) {
    const job = await claim(f, 'INDEX_VECTORS');
    return repo.complete(job.id, job.leaseToken, new Date(), async (tx) => {
      await tx.versionVectorIndex.update({
        where: { id: job.vectorIndexId },
        data: {
          status: 'READY',
          confirmedPointCount: 1,
          checkpointOrdinal: 0,
          indexedAt: new Date(),
        },
      });
      return {};
    });
  }
  try {
    await t.test(
      'ordered completion, compact v2 outbox, duplicate scheduling and completion',
      async () => {
        const f = await fixture();
        const runs = await Promise.all([
          repo.requestAiProcessing(f.input),
          repo.requestAiProcessing(f.input),
        ]);
        assert.equal(runs[0].id, runs[1].id);
        assert.equal(
          await db.processingJob.count({ where: { aiRunId: runs[0].id } }),
          0,
        );
        const verification = await verify(f);
        assert.equal(
          (await pending(f, 'EXTRACT_TEXT')).predecessorJobId,
          verification.id,
        );
        await repo.complete(verification.id, randomUUID(), new Date());
        assert.equal(
          await db.processingJob.count({ where: { aiRunId: runs[0].id } }),
          1,
        );
        const extraction = await extract(f);
        assert.equal(
          (await pending(f, 'GENERATE_CHUNKS')).extractedTextId,
          extraction.extractedTextId,
        );
        const chunking = await chunk(f);
        assert.equal(
          (await pending(f, 'GENERATE_EMBEDDINGS')).chunkSetId,
          chunking.chunkSetId,
        );
        await embed(f);
        await index(f);
        assert.equal(
          (
            await db.aiProcessingRun.findUniqueOrThrow({
              where: { id: runs[0].id },
            })
          ).status,
          'READY',
        );
        assert.equal(
          await db.versionReadyIndex.count({
            where: { documentVersionId: f.version.id },
          }),
          1,
        );
        const intents = await db.processingOutbox.findMany({
          where: { job: { aiRunId: runs[0].id } },
        });
        assert.equal(intents.length, 4);
        for (const intent of intents) {
          assert.equal(intent.schemaVersion, 2);
          assert.deepEqual(
            Object.keys(intent.payload).sort(),
            [
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
            ].sort(),
          );
        }
      },
    );
    await t.test(
      'missing output rolls back artifacts, completion and downstream intent',
      async () => {
        const f = await fixture();
        await repo.requestAiProcessing(f.input);
        await verify(f);
        const job = await claim(f, 'EXTRACT_TEXT');
        await assert.rejects(repo.complete(job.id, job.leaseToken, new Date()));
        await assert.rejects(
          repo.complete(job.id, job.leaseToken, new Date(), async (tx) => {
            await tx.extractedText.create({
              data: {
                ...f.owned,
                extractionFingerprint: hash('rollback-extraction'),
                extractor: 'test',
                extractorVersion: 'v1',
                normalizationVersion: 'v1',
                sourceChecksum: f.version.checksumSha256,
                contentHash: hash('Alpha'),
                text: 'Alpha',
                pageSpans: [{ pageNumber: 1, startOffset: 0, endOffset: 5 }],
                characterCount: 5,
                pageCount: 1,
              },
            });
            return {}; // Deliberately missing publication reference, not a production handler.
          }),
        );
        assert.equal(
          await db.extractedText.count({
            where: { documentVersionId: f.version.id },
          }),
          0,
        );
        assert.equal((await repo.findById(job.id)).status, 'PROCESSING');
        assert.equal(
          await db.processingJob.count({
            where: {
              documentVersionId: f.version.id,
              jobType: 'GENERATE_CHUNKS',
            },
          }),
          0,
        );
        await assert.rejects(
          repo.complete(job.id, randomUUID(), new Date(), async () => {
            throw Error('must not execute');
          }),
          /CONCURRENT_CHANGE/,
        );
      },
    );
    await t.test(
      'a lease expiring during a database publication callback rolls back completion',
      async () => {
        const f = await fixture();
        await repo.requestAiProcessing(f.input);
        await verify(f);
        const job = await pending(f, 'EXTRACT_TEXT');
        const claimed = await repo.claim(job.id, new Date(), 100);
        await assert.rejects(
          repo.complete(job.id, claimed.leaseToken, new Date(), async (tx) => {
            await tx.$executeRaw`SELECT pg_sleep(0.2)`;
            return {};
          }),
          /CONCURRENT_CHANGE/,
        );
        assert.equal((await repo.findById(job.id)).status, 'PROCESSING');
        assert.equal(
          await db.processingJob.count({
            where: { aiRunId: claimed.aiRunId, jobType: 'GENERATE_CHUNKS' },
          }),
          0,
        );
      },
    );
    await t.test(
      'concurrent claims, interruption recovery and retry intents are idempotent',
      async () => {
        const f = await fixture();
        const run = await repo.requestAiProcessing(f.input);
        await verify(f);
        const job = await pending(f, 'EXTRACT_TEXT'),
          now = new Date();
        const claims = await Promise.allSettled([
          repo.claim(job.id, now, 1000),
          repo.claim(job.id, now, 1000),
        ]);
        assert.equal(claims.filter((r) => r.status === 'fulfilled').length, 1);
        const claimed = claims.find((r) => r.status === 'fulfilled').value;
        const retry = await repo.recoverInterrupted(
          job.id,
          claimed.leaseToken,
          new Date(now.getTime() + 1001),
        );
        assert.equal(retry.status, 'RETRYING');
        assert.equal(
          (
            await db.aiProcessingRun.findUniqueOrThrow({
              where: { id: run.id },
            })
          ).status,
          'BUILDING',
        );
        const dispatches = await Promise.all([
          repo.scheduleRetryDispatch(job.id, retry.availableAt),
          repo.scheduleRetryDispatch(job.id, retry.availableAt),
        ]);
        assert.equal(dispatches[0].id, dispatches[1].id);
        assert.equal(dispatches[0].schemaVersion, 2);
        const next = await repo.claim(job.id, retry.availableAt, 60000);
        await repo.fail(
          job.id,
          next.leaseToken,
          retry.availableAt,
          'HANDLER_NOT_IMPLEMENTED',
          false,
        );
        assert.equal(
          (
            await db.aiProcessingRun.findUniqueOrThrow({
              where: { id: run.id },
            })
          ).status,
          'FAILED',
        );
        assert.equal(
          await db.processingJob.count({
            where: { aiRunId: run.id, jobType: 'GENERATE_CHUNKS' },
          }),
          0,
        );
      },
    );
    await t.test(
      'terminal failure requires explicit reprocessing; new run generation retains history',
      async () => {
        const f = await fixture();
        const run = await repo.requestAiProcessing(f.input);
        await verify(f);
        const job = await claim(f, 'EXTRACT_TEXT');
        await repo.fail(
          job.id,
          job.leaseToken,
          new Date(),
          'UNSUPPORTED_DOCUMENT',
          false,
        );
        assert.equal((await repo.requestAiProcessing(f.input)).id, run.id);
        const replay = await repo.requestAiProcessing(f.input, true);
        assert.equal(replay.generation, 2);
        assert.notEqual(replay.id, run.id);
        assert.equal((await pending(f, 'EXTRACT_TEXT')).generation, 2);
      },
    );
    await t.test(
      'reconciliation repairs missing extraction intent after completed integrity',
      async () => {
        const f = await fixture();
        const run = await repo.requestAiProcessing(f.input);
        const job = await claim(f, 'VERIFY_STORED_FILE');
        // Simulate a legacy completed predecessor without orchestration.
        await db.processingJob.update({
          where: { id: job.id },
          data: {
            status: 'COMPLETED',
            completedAt: new Date(),
            leaseToken: null,
            leaseExpiresAt: null,
            heartbeatAt: null,
          },
        });
        await repo.reconcilePipelines(new Date(), 100);
        await repo.reconcilePipelines(new Date(), 100);
        assert.equal(
          await db.processingJob.count({
            where: { aiRunId: run.id, jobType: 'EXTRACT_TEXT' },
          }),
          1,
        );
      },
    );
    await t.test(
      'reconciliation resumes a desired legacy run without an initial verification job',
      async () => {
        const f = await fixture();
        const { correlationId, maxAttempts, ...snapshot } = f.input;
        const run = await db.aiProcessingRun.create({
          data: { ...snapshot, generation: 1 },
        });
        await db.versionAiState.create({
          data: { ...f.owned, desiredRunId: run.id },
        });
        await repo.reconcilePipelines(new Date(), 100);
        assert.equal(
          (await pending(f, 'VERIFY_STORED_FILE')).status,
          'PENDING',
        );
        assert.equal(
          await db.processingJob.count({ where: { aiRunId: run.id } }),
          0,
        );
      },
    );
    await t.test(
      'archive revokes readiness, cancels AI, and preserves cleanup eligibility',
      async () => {
        const f = await fixture();
        await repo.requestAiProcessing(f.input);
        await verify(f);
        await extract(f);
        await chunk(f);
        await embed(f);
        await index(f);
        await db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM documents WHERE id=${f.document.id}::uuid FOR UPDATE`;
          await tx.document.update({
            where: { id: f.document.id },
            data: { isArchived: true, status: 'ARCHIVED' },
          });
          await repo.cancelUnfinishedForDocument(
            tx,
            f.user.id,
            f.document.id,
            new Date(),
          );
        });
        assert.equal(
          await db.versionReadyIndex.count({
            where: { documentVersionId: f.version.id },
          }),
          0,
        );
        const cleanup = await claim(f, 'REMOVE_VECTOR_INDEX');
        await repo.complete(
          cleanup.id,
          cleanup.leaseToken,
          new Date(),
          async (tx) => {
            await tx.versionVectorIndex.update({
              where: { id: cleanup.vectorIndexId },
              data: { status: 'REMOVED' },
            });
            return {};
          },
        );
        assert.equal((await repo.findById(cleanup.id)).status, 'COMPLETED');
      },
    );
    await t.test(
      'new version cancels old run and fencing prevents stale publication',
      async () => {
        const f = await fixture();
        const run = await repo.requestAiProcessing(f.input);
        await verify(f);
        const stale = await claim(f, 'EXTRACT_TEXT');
        await db.$transaction(async (tx) => {
          const version = await tx.documentVersion.create({
            data: {
              userId: f.user.id,
              documentId: f.document.id,
              versionNumber: 2,
              originalFilename: 'next.pdf',
              storageKey: `test/${randomUUID()}`,
              mimeType: 'application/pdf',
              fileSize: 5,
              pageCount: 1,
              checksumSha256: hash('Beta!'),
            },
          });
          await repo.createInTransaction(tx, {
            ...f.owned,
            documentVersionId: version.id,
            correlationId: randomUUID(),
            maxAttempts: 3,
          });
        });
        assert.equal((await repo.findById(stale.id)).status, 'CANCELLED');
        assert.equal(
          (
            await db.aiProcessingRun.findUniqueOrThrow({
              where: { id: run.id },
            })
          ).status,
          'CANCELLED',
        );
        await assert.rejects(
          repo.complete(stale.id, stale.leaseToken, new Date()),
          /INVALID_TRANSITION/,
        );
      },
    );
    await t.test(
      'request ownership and current-version checks reject foreign scopes',
      async () => {
        const f = await fixture(),
          other = await fixture();
        await assert.rejects(
          repo.requestAiProcessing({ ...f.input, userId: other.user.id }),
          /INELIGIBLE_DOCUMENT/,
        );
      },
    );
    await t.test(
      'same-profile rebuild retains readiness until atomic replacement and retires its exact manifest',
      async () => {
        const f = await fixture();
        const first = await repo.requestAiProcessing(f.input);
        await verify(f);
        await extract(f);
        await chunk(f);
        await embed(f);
        await index(f);
        const old = await db.versionReadyIndex.findFirstOrThrow({
          where: { documentVersionId: f.version.id },
        });
        const second = await repo.requestAiProcessing(f.input, true);
        assert.equal(second.generation, 2);
        assert.equal(
          (
            await db.versionReadyIndex.findFirstOrThrow({
              where: { documentVersionId: f.version.id },
            })
          ).vectorIndexId,
          old.vectorIndexId,
        );
        await extract(f);
        await chunk(f);
        await embed(f);
        await index(f);
        const replacement = await db.versionReadyIndex.findFirstOrThrow({
          where: { documentVersionId: f.version.id },
        });
        assert.notEqual(replacement.vectorIndexId, old.vectorIndexId);
        assert.equal(
          (
            await db.aiProcessingRun.findUniqueOrThrow({
              where: { id: first.id },
            })
          ).status,
          'SUPERSEDED',
        );
        assert.equal(
          (await pending(f, 'REMOVE_VECTOR_INDEX')).vectorIndexId,
          old.vectorIndexId,
        );
      },
    );
  } finally {
    await db.document.deleteMany({ where: { userId: { in: users } } });
    for (const id of users) await db.user.delete({ where: { id } });
    for (const id of profiles)
      await db.embeddingProfile.delete({ where: { id } });
    await db.$disconnect();
  }
});
