const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const {
  createPrismaClient,
  SearchPersistenceRepository,
  ProcessingRepository,
  searchRecordId,
  createProcessingOutboxIntent,
} = require('../dist');
const hash = (value) => createHash('sha256').update(value).digest('hex');

test('Phase 5 search persistence against real PostgreSQL', async (t) => {
  const url = process.env.TEST_DATABASE_URL;
  assert.ok(url, 'Use a migrated disposable TEST_DATABASE_URL.');
  assert.match(new URL(url).pathname, /test/i);
  const db = createPrismaClient({
    url,
    connectTimeoutMs: 2000,
    queryTimeoutMs: 8000,
    poolSize: 5,
  });
  const search = new SearchPersistenceRepository(db),
    processing = new ProcessingRepository(db);
  const users = [],
    generations = [];
  await db.$connect();
  const identity = {
    schemaVersion: 1,
    mappingVersion: 'v1',
    analyzerVersion: 'v1',
    extractor: 'pdf',
    extractorVersion: 'v1',
    normalizationVersion: 'nfc-lf-v1',
    segmentationVersion: 'v1',
  };
  let sequence = 0;
  const generationInput = () => {
    const unique = randomUUID();
    return {
      ...identity,
      mappingVersion: 'v1-' + unique,
      generation: ++sequence,
      metadataIndexName: 'qyvra-search-' + unique + '-metadata',
      pageIndexName: 'qyvra-search-' + unique + '-pages',
    };
  };
  async function newGeneration() {
    const g = await search.createGeneration(generationInput());
    generations.push(g.id);
    return g;
  }
  async function fixture(g, mimeType = 'image/png') {
    const user = await db.user.create({
      data: { email: randomUUID() + '@example.invalid' },
    });
    users.push(user.id);
    const document = await db.document.create({
      data: { userId: user.id, title: 'Search fixture' },
    });
    const version = await db.documentVersion.create({
      data: {
        userId: user.id,
        documentId: document.id,
        versionNumber: 1,
        originalFilename:
          mimeType === 'application/pdf' ? 'fixture.pdf' : 'fixture.png',
        mimeType,
        pageCount: mimeType === 'application/pdf' ? 1 : null,
        fileSize: 12,
        storageKey: 'test/' + randomUUID(),
        checksumSha256: hash(randomUUID()),
      },
    });
    const owned = {
      userId: user.id,
      documentId: document.id,
      documentVersionId: version.id,
    };
    await db.$transaction((tx) =>
      search.initializeStateInTransaction(tx, owned),
    );
    const input = {
      ...owned,
      indexGenerationId: g.id,
      revision: 1,
      metadataHash: (await db.$queryRaw`SELECT search_metadata_hash(${version.id}::uuid) AS hash`)[0].hash,
    };
    const projection = await db.$transaction((tx) =>
      search.createProjectionInTransaction(tx, input),
    );
    return { user, document, version, owned, input, projection };
  }
  const jobInput = (f) => ({
    ...f.owned,
    searchProjectionId: f.projection.id,
    jobType: 'INDEX_SEARCH',
    maxAttempts: 3,
    correlationId: randomUUID(),
  });
  const makeReady = (f) =>
    db.versionSearchProjection.update({
      where: { id: f.projection.id },
      data: {
        expectedRecordIds: [
          searchRecordId(f.projection.id, { kind: 'metadata' }),
        ],
        expectedRecordCount: 1,
        recordsHash: hash('remote records'),
        metadataReady: true,
        verifiedAt: new Date(),
        status: 'READY',
      },
    });
  try {
    const g = await newGeneration();
    await t.test(
      'concurrent generation creation is idempotent and fingerprint/configuration immutable',
      async () => {
        const input = generationInput();
        const rows = await Promise.all([
          search.createGeneration(input),
          search.createGeneration(input),
        ]);
        generations.push(rows[0].id);
        assert.equal(rows[0].id, rows[1].id);
        await assert.rejects(
          search.createGeneration({
            ...input,
            generation: input.generation + 10,
          }),
        );
        await assert.rejects(
          db.searchIndexGeneration.update({
            where: { id: g.id },
            data: { mappingVersion: 'changed' },
          }),
        );
        await assert.rejects(
          db.searchIndexGeneration.create({
            data: {
              ...input,
              generation: 1000,
              metadataIndexName: 'qyvra-search-invalid-meta',
              pageIndexName: 'qyvra-search-invalid-page',
              fingerprint: 'a'.repeat(64),
            },
          }),
        );
      },
    );
    await t.test(
      'owned state/projection identity, creation concurrency and rollback',
      async () => {
        const f = await fixture(g);
        const rows = await Promise.all([
          db.$transaction((tx) =>
            search.createProjectionInTransaction(tx, f.input),
          ),
          db.$transaction((tx) =>
            search.createProjectionInTransaction(tx, f.input),
          ),
        ]);
        assert.equal(rows[0].id, rows[1].id);
        assert.equal(rows[0].id, f.projection.id);
        assert.equal(
          await search.findProjection(randomUUID(), f.projection.id),
          null,
        );
        assert.equal(
          (await search.findProjection(f.user.id, f.projection.id)).revision,
          1,
        );
        await assert.rejects(
          db.$transaction((tx) =>
            search.createProjectionInTransaction(tx, {
              ...f.input,
              metadataHash: hash('other'),
            }),
          ),
        );
        await assert.rejects(
          db.documentSearchState.create({
            data: {
              documentId: f.document.id,
              userId: randomUUID(),
              desiredVersionId: f.version.id,
            },
          }),
        );
        const other = await fixture(g);
        await assert.rejects(
          db.versionSearchProjection.create({
            data: {
              ...f.input,
              id: randomUUID(),
              documentVersionId: other.version.id,
            },
          }),
        );
        await assert.rejects(
          db.$transaction(async (tx) => {
            await search.advanceRevisionInTransaction(tx, {
              ...f.owned,
              expectedRevision: 1,
            });
            await search.createProjectionInTransaction(tx, {
              ...f.input,
              revision: 2,
            });
            throw Error('forced rollback');
          }),
        );
        assert.equal(
          (
            await db.documentSearchState.findUnique({
              where: { documentId: f.document.id },
            })
          ).desiredRevision,
          1,
        );
        assert.equal(
          await db.versionSearchProjection.count({
            where: { documentId: f.document.id },
          }),
          1,
        );
      },
    );
    await t.test(
      'revision CAS rejects stale/concurrent writers and stale READY publication',
      async () => {
        const f = await fixture(g);
        const writes = await Promise.allSettled(
          [1, 2].map(() =>
            db.$transaction((tx) =>
              search.advanceRevisionInTransaction(tx, {
                ...f.owned,
                expectedRevision: 1,
              }),
            ),
          ),
        );
        assert.equal(writes.filter((r) => r.status === 'fulfilled').length, 1);
        await assert.rejects(makeReady(f));
        await assert.rejects(
          db.documentSearchState.update({
            where: { documentId: f.document.id },
            data: { desiredRevision: 1 },
          }),
        );
        await assert.rejects(
          db.documentSearchState.update({
            where: { documentId: f.document.id },
            data: { desiredRevision: 4 },
          }),
        );
      },
    );
    await t.test(
      'verified manifests and serving generation guard ready pointers and retirement',
      async () => {
        const f = await fixture(g);
        await assert.rejects(
          db.versionSearchProjection.update({
            where: { id: f.projection.id },
            data: { status: 'READY' },
          }),
        );
        await assert.rejects(
          db.versionSearchProjection.update({
            where: { id: f.projection.id },
            data: {
              expectedRecordIds: [
                f.projection.id + ':metadata',
                f.projection.id + ':metadata',
              ],
              expectedRecordCount: 2,
            },
          }),
        );
        await assert.rejects(
          db.versionSearchProjection.update({
            where: { id: f.projection.id },
            data: {
              expectedRecordIds: ['foreign:metadata'],
              expectedRecordCount: 1,
            },
          }),
        );
        await assert.rejects(
          db.versionSearchProjection.update({
            where: { id: f.projection.id },
            data: { textCoverage: 'READY' },
          }),
        );
        await makeReady(f);
        await assert.rejects(
          db.documentSearchState.update({
            where: { documentId: f.document.id },
            data: { readyProjectionId: f.projection.id },
          }),
        );
        await db.searchIndexGeneration.update({
          where: { id: g.id },
          data: { status: 'SERVING' },
        });
        await db.documentSearchState.update({
          where: { documentId: f.document.id },
          data: { readyProjectionId: f.projection.id },
        });
        await assert.rejects(
          db.versionSearchProjection.update({
            where: { id: f.projection.id },
            data: { status: 'REMOVAL_PENDING' },
          }),
        );
        await assert.rejects(
          db.versionSearchProjection.update({
            where: { id: f.projection.id },
            data: { recordsHash: hash('modified') },
          }),
        );
        const second = await newGeneration();
        await assert.rejects(
          db.searchIndexGeneration.update({
            where: { id: second.id },
            data: { status: 'SERVING' },
          }),
        );
        await db.$transaction((tx) =>
          search.advanceRevisionInTransaction(tx, {
            ...f.owned,
            expectedRevision: 1,
          }),
        );
        await db.versionSearchProjection.update({
          where: { id: f.projection.id },
          data: { status: 'REMOVAL_PENDING' },
        });
        await assert.rejects(
          db.versionSearchProjection.update({
            where: { id: f.projection.id },
            data: { status: 'READY' },
          }),
        );
      },
    );
    await t.test(
      'new-version, archive and deletion prevent new projection publication',
      async () => {
        for (const mode of ['version', 'archive', 'delete']) {
          const f = await fixture(g);
          if (mode === 'version')
            await db.documentVersion.create({
              data: {
                userId: f.user.id,
                documentId: f.document.id,
                versionNumber: 2,
                originalFilename: 'new.png',
                mimeType: 'image/png',
                fileSize: 12,
                storageKey: 'test/' + randomUUID(),
                checksumSha256: hash(randomUUID()),
              },
            });
          else
            await db.document.update({
              where: { id: f.document.id },
              data:
                mode === 'archive'
                  ? { isArchived: true, status: 'ARCHIVED' }
                  : { deletedAt: new Date() },
            });
          await assert.rejects(makeReady(f));
          await assert.rejects(
            db.$transaction((tx) =>
              search.createProjectionInTransaction(tx, f.input),
            ),
          );
        }
      },
    );
    await t.test(
      'atomic job/outbox concurrency, v3 lineage and immutable input validation',
      async () => {
        const f = await fixture(g),
          input = jobInput(f);
        const jobs = await Promise.all([
          db.$transaction((tx) => search.createJobInTransaction(tx, input)),
          db.$transaction((tx) => search.createJobInTransaction(tx, input)),
        ]);
        assert.equal(jobs.filter((j) => j.created).length, 1);
        assert.equal(jobs[0].job.id, jobs[1].job.id);
        assert.equal(jobs[0].outbox.id, jobs[1].outbox.id);
        const payload = jobs[0].outbox.payload;
        assert.equal(payload.schemaVersion, 3);
        assert.equal(payload.revision, 1);
        assert.equal(payload.indexGenerationId, g.id);
        assert.equal(payload.searchProjectionId, f.projection.id);
        assert.equal(payload.messageId, jobs[0].outbox.id);
        assert.equal('userId' in payload, false);
        await assert.rejects(
          db.processingOutbox.update({
            where: { id: jobs[0].outbox.id },
            data: { payload: { ...payload, revision: 2 } },
          }),
        );
        await assert.rejects(
          db.processingOutbox.update({
            where: { id: jobs[0].outbox.id },
            data: { payload: { ...payload, content: 'secret' } },
          }),
        );
        await assert.rejects(
          db.processingOutbox.update({
            where: { id: jobs[0].outbox.id },
            data: {
              schemaVersion: 2,
              payload: { ...payload, schemaVersion: 2 },
            },
          }),
        );
        await assert.rejects(
          db.processingJob.update({
            where: { id: jobs[0].job.id },
            data: { searchProjectionId: null, jobType: 'VERIFY_STORED_FILE' },
          }),
        );
        const another = await fixture(g);
        await assert.rejects(
          db.$transaction(async (tx) => {
            await search.createJobInTransaction(tx, jobInput(another));
            throw Error('rollback');
          }),
        );
        assert.equal(
          await db.processingJob.count({
            where: { documentId: another.document.id },
          }),
          0,
        );
        await assert.rejects(
          db.$transaction((tx) =>
            createProcessingOutboxIntent(tx, jobs[0].job, 2, new Date(), 2),
          ),
        );
      },
    );
    await t.test(
      'retry/recovery retains projection revision and rejects unimplemented completion',
      async () => {
        const f = await fixture(g),
          created = await db.$transaction((tx) =>
            search.createJobInTransaction(tx, jobInput(f)),
          );
        const now = new Date(),
          claimed = await processing.claim(created.job.id, now, 120000);
        await assert.rejects(
          processing.complete(claimed.id, claimed.leaseToken, now),
        );
        assert.equal(
          (await db.processingJob.findUnique({ where: { id: claimed.id } }))
            .status,
          'PROCESSING',
        );
        const retry = await processing.fail(
          claimed.id,
          claimed.leaseToken,
          now,
          'SEARCH_TEMPORARY_ERROR',
          true,
        );
        const dispatch = await processing.scheduleRetryDispatch(
          retry.id,
          new Date(retry.availableAt.getTime() + 1),
        );
        const intents = await db.processingOutbox.findMany({
          where: { processingJobId: retry.id },
          orderBy: { dispatchSequence: 'asc' },
        });
        assert.ok(dispatch);
        assert.equal(intents.length, 2);
        assert.notEqual(intents[0].id, intents[1].id);
        assert.equal(intents[1].payload.dispatchSequence, 2);
        for (const key of [
          'jobId',
          'correlationId',
          'searchProjectionId',
          'indexGenerationId',
          'revision',
        ])
          assert.equal(intents[0].payload[key], intents[1].payload[key]);
        const next = await processing.claim(
          retry.id,
          new Date(retry.availableAt.getTime() + 2),
          1000,
        );
        await processing.recoverInterrupted(
          next.id,
          next.leaseToken,
          new Date(next.leaseExpiresAt.getTime() + 1),
        );
        assert.equal(
          (await db.processingJob.findUnique({ where: { id: next.id } }))
            .status,
          'RETRYING',
        );
      },
    );
    await t.test(
      'extraction requires a completed owned integrity predecessor and PDF',
      async () => {
        const f = await fixture(g, 'application/pdf');
        await assert.rejects(
          db.$transaction((tx) =>
            search.createJobInTransaction(tx, {
              ...jobInput(f),
              jobType: 'EXTRACT_SEARCH_TEXT',
            }),
          ),
        );
        const integrity = await processing.create({
          ...f.owned,
          correlationId: randomUUID(),
          maxAttempts: 3,
        });
        await assert.rejects(
          db.$transaction((tx) =>
            search.createJobInTransaction(tx, {
              ...jobInput(f),
              jobType: 'EXTRACT_SEARCH_TEXT',
              predecessorJobId: integrity.job.id,
            }),
          ),
        );
        const now = new Date(),
          claimed = await processing.claim(integrity.job.id, now, 120000);
        await processing.complete(claimed.id, claimed.leaseToken, now);
        const extraction = await db.$transaction((tx) =>
          search.createJobInTransaction(tx, {
            ...jobInput(f),
            jobType: 'EXTRACT_SEARCH_TEXT',
            predecessorJobId: integrity.job.id,
          }),
        );
        assert.equal(extraction.outbox.payload.jobType, 'EXTRACT_SEARCH_TEXT');
        const extractionNow = new Date();
        const attempt = await processing.claim(
          extraction.job.id,
          extractionNow,
          120000,
        );
        await assert.rejects(
          processing.complete(attempt.id, attempt.leaseToken, extractionNow),
        );
        assert.equal(
          await db.aiProcessingRun.count({
            where: { documentId: f.document.id },
          }),
          0,
        );
        const artifact = await db.extractedText.create({
          data: {
            ...f.owned,
            extractionFingerprint: hash('search extraction'),
            extractor: 'pdf',
            extractorVersion: 'v1',
            normalizationVersion: 'nfc-lf-v1',
            sourceChecksum: f.version.checksumSha256,
            contentHash: hash('Alpha'),
            text: 'Alpha',
            characterCount: 5,
            pageCount: 1,
            pageSpans: [{ pageNumber: 1, startOffset: 0, endOffset: 5 }],
          },
        });
        const completed = await processing.complete(
          attempt.id,
          attempt.leaseToken,
          new Date(),
          async () => ({ extractedTextId: artifact.id }),
        );
        assert.equal(completed.status, 'COMPLETED');
        assert.equal(completed.extractedTextId, artifact.id);
        await assert.rejects(
          db.processingJob.update({
            where: { id: attempt.id },
            data: { extractedTextId: null },
          }),
        );
      },
    );
    await t.test(
      'retired projection removal contracts remain eligible for archived documents',
      async () => {
        const f = await fixture(g);
        await db.versionSearchProjection.update({
          where: { id: f.projection.id },
          data: { status: 'REMOVAL_PENDING' },
        });
        await db.document.update({
          where: { id: f.document.id },
          data: { isArchived: true, status: 'ARCHIVED' },
        });
        const created = await db.$transaction((tx) =>
          search.createJobInTransaction(tx, {
            ...jobInput(f),
            jobType: 'REMOVE_SEARCH_INDEX',
          }),
        );
        assert.equal(created.outbox.payload.jobType, 'REMOVE_SEARCH_INDEX');
        const now = new Date(),
          claimed = await processing.claim(created.job.id, now, 120000);
        await assert.rejects(
          processing.complete(claimed.id, claimed.leaseToken, now),
        );
        const retry = await processing.fail(
          claimed.id,
          claimed.leaseToken,
          now,
          'SEARCH_TEMPORARY_ERROR',
          true,
        );
        assert.ok(
          (
            await processing.findRetryEligible(
              new Date(retry.availableAt.getTime() + 1),
              100,
            )
          ).includes(retry.id),
        );
      },
    );
    await t.test(
      'bounded durable fanout checkpoints coalesce duplicates and reject stale CAS',
      async () => {
        const f = await fixture(g),
          input = {
            id: randomUUID(),
            userId: f.user.id,
            reason: 'TAG_DELETED',
            resourceId: randomUUID(),
          };
        const rows = await Promise.all([
          db.$transaction((tx) => search.createChangeInTransaction(tx, input)),
          db.$transaction((tx) =>
            search.createChangeInTransaction(tx, {
              ...input,
              id: randomUUID(),
            }),
          ),
        ]);
        assert.equal(rows[0].id, rows[1].id);
        const ids = [randomUUID(), randomUUID()].sort();
        await db.$transaction((tx) =>
          search.advanceChangeInTransaction(tx, {
            id: rows[0].id,
            userId: f.user.id,
            expectedAfterDocumentId: null,
            afterDocumentId: ids[1],
            complete: false,
          }),
        );
        await assert.rejects(
          db.$transaction((tx) =>
            search.advanceChangeInTransaction(tx, {
              id: rows[0].id,
              userId: f.user.id,
              expectedAfterDocumentId: null,
              afterDocumentId: ids[1],
              complete: true,
            }),
          ),
        );
        await assert.rejects(
          db.searchProjectionChange.update({
            where: { id: rows[0].id },
            data: { afterDocumentId: ids[0] },
          }),
        );
        await db.$transaction((tx) =>
          search.advanceChangeInTransaction(tx, {
            id: rows[0].id,
            userId: f.user.id,
            expectedAfterDocumentId: ids[1],
            afterDocumentId: ids[1],
            complete: true,
          }),
        );
        await assert.rejects(
          db.searchProjectionChange.update({
            where: { id: rows[0].id },
            data: { status: 'PENDING', completedAt: null },
          }),
        );
        assert.equal(
          (
            await db.$transaction((tx) =>
              search.createChangeInTransaction(tx, input),
            )
          ).id,
          rows[0].id,
        );
      },
    );
  } finally {
    await db.searchProjectionChange.deleteMany({
      where: { userId: { in: users } },
    });
    await db.document.deleteMany({ where: { userId: { in: users } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    await db.searchIndexGeneration.deleteMany({
      where: { id: { in: generations } },
    });
    await db.$disconnect();
  }
});
