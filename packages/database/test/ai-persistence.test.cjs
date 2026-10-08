const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const {
  createPrismaClient,
  embeddingProfileFingerprint,
  ProcessingRepository,
} = require('../dist');

const hash = (value) => createHash('sha256').update(value).digest('hex');
const spans = [
  { pageNumber: 1, startOffset: 0, endOffset: 7 },
  { pageNumber: 2, startOffset: 7, endOffset: 11 },
];

test('Phase 4 artifacts, dependencies and ownership against PostgreSQL', async (t) => {
  const url = process.env.TEST_DATABASE_URL;
  assert.ok(url, 'Use a migrated disposable TEST_DATABASE_URL.');
  assert.match(new URL(url).pathname, /test/i);
  const db = createPrismaClient({
    url,
    connectTimeoutMs: 2000,
    queryTimeoutMs: 5000,
    poolSize: 3,
  });
  const documents = [];
  const users = [];
  const profiles = [];
  await db.$connect();
  function owned(f) {
    return {
      userId: f.user.id,
      documentId: f.document.id,
      documentVersionId: f.version.id,
    };
  }
  async function fixture() {
    const user = await db.user.create({
      data: { email: `${randomUUID()}@example.invalid` },
    });
    users.push(user.id);
    const document = await db.document.create({
      data: { userId: user.id, title: 'AI fixture' },
    });
    documents.push(document.id);
    const version = await db.documentVersion.create({
      data: {
        documentId: document.id,
        userId: user.id,
        versionNumber: 1,
        originalFilename: 'fixture.pdf',
        storageKey: `test/${randomUUID()}`,
        mimeType: 'application/pdf',
        fileSize: 12,
        pageCount: 2,
        checksumSha256: hash(randomUUID()),
      },
    });
    const config = {
      profileVersion: 1,
      provider: 'test',
      model: `test-${randomUUID()}`,
      modelRevision: 'v1',
      dimensions: 3,
      distance: 'Cosine',
      normalizationVersion: 'nfc-lf-v1',
      tokenizer: 'test',
      tokenizerVersion: 'v1',
      documentInstruction: '',
      queryInstruction: '',
    };
    const profile = await db.embeddingProfile.create({
      data: { ...config, fingerprint: embeddingProfileFingerprint(config) },
    });
    profiles.push(profile.id);
    const f = { user, document, version, profile, config };
    const run = await db.aiProcessingRun.create({
      data: {
        ...owned(f),
        generation: 1,
        extractor: 'pdf',
        extractorVersion: 'v1',
        normalizationVersion: 'nfc-lf-v1',
        chunkAlgorithm: 'test',
        chunkAlgorithmVersion: 'v1',
        tokenizer: 'test',
        tokenizerVersion: 'v1',
        chunkSize: 512,
        chunkOverlap: 64,
        embeddingProfileId: profile.id,
      },
    });
    return { ...f, run };
  }
  async function extraction(f) {
    return db.extractedText.create({
      data: {
        ...owned(f),
        extractionFingerprint: hash('extraction-v1'),
        extractor: 'pdf',
        extractorVersion: 'v1',
        normalizationVersion: 'nfc-lf-v1',
        sourceChecksum: f.version.checksumSha256,
        contentHash: hash('Alpha😀\nBeta'),
        text: 'Alpha😀\nBeta',
        pageSpans: spans,
        characterCount: 11,
        pageCount: 2,
      },
    });
  }
  async function chunkSet(f, e, fingerprint = hash('chunks-v1')) {
    return db.chunkSet.create({
      data: {
        ...owned(f),
        extractedTextId: e.id,
        extractionHash: e.contentHash,
        fingerprint,
        algorithm: 'test',
        algorithmVersion: 'v1',
        tokenizer: 'test',
        tokenizerVersion: 'v1',
        chunkSize: 512,
        chunkOverlap: 64,
      },
    });
  }
  async function chunks(f, set) {
    const a = await db.documentChunk.create({
      data: {
        ...owned(f),
        id: randomUUID(),
        chunkSetId: set.id,
        ordinal: 0,
        text: 'Alpha😀',
        textHash: hash('Alpha😀'),
        startOffset: 0,
        endOffset: 6,
        tokenCount: 2,
        pageSpans: [{ pageNumber: 1, startOffset: 0, endOffset: 6 }],
      },
    });
    const b = await db.documentChunk.create({
      data: {
        ...owned(f),
        id: randomUUID(),
        chunkSetId: set.id,
        ordinal: 1,
        text: 'Beta',
        textHash: hash('Beta'),
        startOffset: 7,
        endOffset: 11,
        tokenCount: 1,
        pageSpans: [{ pageNumber: 2, startOffset: 7, endOffset: 11 }],
      },
    });
    await db.chunkSet.update({
      where: { id: set.id },
      data: { complete: true, chunkCount: 2 },
    });
    return [a, b];
  }
  async function embed(f, chunk, extra = {}) {
    return db.chunkEmbedding.create({
      data: {
        ...owned(f),
        chunkId: chunk.id,
        embeddingProfileId: f.profile.id,
        dimensions: 3,
        inputHash: chunk.textHash,
        vector: [0.1, 0.2, 0.3],
        ...extra,
      },
    });
  }
  async function index(f, set, extra = {}) {
    return db.versionVectorIndex.create({
      data: {
        ...owned(f),
        aiRunId: f.run.id,
        chunkSetId: set.id,
        embeddingProfileId: f.profile.id,
        collectionGeneration: 1,
        collectionName: `qyvra_chunks_${f.profile.id}_1`,
        expectedPointCount: 2,
        ...extra,
      },
    });
  }
  async function verified(f) {
    return db.processingJob.create({
      data: {
        ...owned(f),
        jobType: 'VERIFY_STORED_FILE',
        maxAttempts: 3,
        correlationId: randomUUID(),
        status: 'COMPLETED',
        completedAt: new Date(),
      },
    });
  }
  async function stage(f, jobType, predecessor, extra = {}) {
    return db.processingJob.create({
      data: {
        ...owned(f),
        aiRunId: f.run.id,
        jobType,
        maxAttempts: 3,
        correlationId: randomUUID(),
        predecessorJobId: predecessor.id,
        ...extra,
      },
    });
  }
  async function graph() {
    const f = await fixture();
    const e = await extraction(f);
    const set = await chunkSet(f, e);
    const members = await chunks(f, set);
    for (const c of members) await embed(f, c);
    const build = await index(f, set);
    return { ...f, e, set, members, build };
  }
  const rejects = (promise) => assert.rejects(promise);
  try {
    await t.test(
      'profile fingerprint is unique, immutable and dimensions are checked',
      async () => {
        const f = await fixture();
        const data = { ...f.config, fingerprint: f.profile.fingerprint };
        await rejects(db.embeddingProfile.create({ data }));
        const replay = await db.embeddingProfile.upsert({
          where: { fingerprint: f.profile.fingerprint },
          create: data,
          update: {},
        });
        assert.equal(replay.id, f.profile.id);
        await rejects(
          db.embeddingProfile.update({
            where: { id: f.profile.id },
            data: { model: 'other' },
          }),
        );
        await rejects(
          db.embeddingProfile.create({
            data: { ...data, fingerprint: hash(randomUUID()), dimensions: 0 },
          }),
        );
      },
    );
    await t.test(
      'one building run, monotonic generations and immutable snapshots',
      async () => {
        const f = await fixture();
        const { id, createdAt, updatedAt, ...data } = f.run;
        await rejects(
          db.aiProcessingRun.create({ data: { ...data, generation: 2 } }),
        );
        await rejects(
          db.aiProcessingRun.update({
            where: { id },
            data: { chunkSize: 256 },
          }),
        );
        await db.aiProcessingRun.update({
          where: { id },
          data: { status: 'CANCELLED', completedAt: new Date() },
        });
        await rejects(
          db.aiProcessingRun.create({ data: { ...data, generation: 3 } }),
        );
        const next = await db.aiProcessingRun.create({
          data: { ...data, generation: 2 },
        });
        assert.equal(next.generation, 2);
        await rejects(
          db.aiProcessingRun.update({
            where: { id },
            data: { status: 'BUILDING', completedAt: null },
          }),
        );
      },
    );
    await t.test(
      'extraction has exact owned version provenance and immutable replay identity',
      async () => {
        const f = await fixture();
        const e = await extraction(f);
        assert.equal(e.documentVersionId, f.version.id);
        assert.deepEqual(e.pageSpans, spans);
        await rejects(extraction(f));
        await rejects(
          db.extractedText.update({
            where: { id: e.id },
            data: { text: 'changed' },
          }),
        );
        const { id, createdAt, ...data } = e;
        await rejects(
          db.extractedText.create({
            data: {
              ...data,
              extractionFingerprint: hash('different'),
              sourceChecksum: hash('wrong'),
            },
          }),
        );
        await rejects(
          db.extractedText.create({
            data: {
              ...data,
              extractionFingerprint: hash('different'),
              characterCount: 12,
            },
          }),
        );
        await rejects(
          db.extractedText.create({
            data: {
              ...data,
              extractionFingerprint: hash('different'),
              pageSpans: [{ pageNumber: 0, startOffset: 0, endOffset: 11 }],
            },
          }),
        );
        await rejects(
          db.extractedText.create({
            data: {
              ...data,
              extractionFingerprint: hash('different'),
              pageSpans: [{ pageNumber: '1', startOffset: 0, endOffset: 11 }],
            },
          }),
        );
      },
    );
    await t.test(
      'foreign-owner and foreign-version links are rejected throughout the graph',
      async () => {
        const a = await graph();
        const b = await graph();
        const { id, createdAt, ...text } = a.e;
        await rejects(
          db.extractedText.create({
            data: {
              ...text,
              extractionFingerprint: hash('foreign'),
              userId: b.user.id,
            },
          }),
        );
        await rejects(
          db.chunkSet.create({
            data: {
              ...owned(a),
              extractedTextId: b.e.id,
              extractionHash: b.e.contentHash,
              fingerprint: hash('foreign'),
              algorithm: 'test',
              algorithmVersion: 'v1',
              tokenizer: 'test',
              tokenizerVersion: 'v1',
              chunkSize: 512,
              chunkOverlap: 64,
            },
          }),
        );
        await rejects(embed(a, b.members[0]));
        await rejects(index(a, b.set, { collectionGeneration: 2 }));
        await rejects(
          db.versionAiState.create({
            data: { ...owned(a), desiredRunId: b.run.id },
          }),
        );
        await rejects(
          db.versionReadyIndex.create({
            data: {
              ...owned(a),
              embeddingProfileId: b.profile.id,
              vectorIndexId: b.build.id,
            },
          }),
        );
        await rejects(stage(a, 'EXTRACT_TEXT', await verified(b)));
      },
    );
    await t.test(
      'unique chunk ordering, scalar offsets, source text and page provenance',
      async () => {
        const f = await fixture();
        const e = await extraction(f);
        const set = await chunkSet(f, e);
        const members = await chunks(f, set);
        assert.equal(members[0].text.length, 7);
        assert.equal(members[0].endOffset, 6);
        const { id, createdAt, ...data } = members[0];
        await rejects(
          db.documentChunk.create({ data: { ...data, id: randomUUID() } }),
        );
        await rejects(
          db.documentChunk.update({ where: { id }, data: { text: 'other' } }),
        );
        await rejects(db.documentChunk.delete({ where: { id } }));
        const next = await chunkSet(f, e, hash('new-settings'));
        await rejects(
          db.documentChunk.create({
            data: {
              ...data,
              id: randomUUID(),
              chunkSetId: next.id,
              text: 'Alphax',
            },
          }),
        );
        await rejects(
          db.documentChunk.create({
            data: {
              ...data,
              id: randomUUID(),
              chunkSetId: next.id,
              pageSpans: [{ pageNumber: 2, startOffset: 0, endOffset: 6 }],
            },
          }),
        );
        await rejects(
          db.chunkSet.update({
            where: { id: next.id },
            data: { complete: true, chunkCount: 2 },
          }),
        );
        await db.documentChunk.create({
          data: { ...data, id: randomUUID(), chunkSetId: next.id, ordinal: 1 },
        });
        await rejects(
          db.chunkSet.update({
            where: { id: next.id },
            data: { complete: true, chunkCount: 1 },
          }),
        );
      },
    );
    await t.test(
      'rechunking retains old IDs and allows ordinals in a replacement set',
      async () => {
        const f = await graph();
        const next = await chunkSet(f, f.e, hash('chunks-v2'));
        const replacement = await chunks(f, next);
        assert.notEqual(replacement[0].id, f.members[0].id);
        assert.equal(
          await db.documentChunk.count({
            where: { documentVersionId: f.version.id },
          }),
          4,
        );
        await rejects(chunkSet(f, f.e, hash('chunks-v2')));
      },
    );
    await t.test(
      'embedding checkpoints reject duplicate, mismatched and nonfinite vectors',
      async () => {
        const f = await fixture();
        const e = await extraction(f);
        const set = await chunkSet(f, e);
        const members = await chunks(f, set);
        for (const vector of [
          [],
          [1, 2],
          [0, 0, 0],
          [NaN, 1, 2],
          [Infinity, 1, 2],
        ]) {
          await rejects(embed(f, members[0], { vector }));
        }
        await rejects(embed(f, members[0], { dimensions: 2, vector: [1, 2] }));
        const checkpoint = await embed(f, members[0]);
        await rejects(embed(f, members[0]));
        await rejects(
          db.chunkEmbedding.update({
            where: { id: checkpoint.id },
            data: { vector: [1, 2, 3] },
          }),
        );
      },
    );
    await t.test(
      'indexes require complete chunks and all compatible embeddings',
      async () => {
        const f = await fixture();
        const e = await extraction(f);
        const set = await chunkSet(f, e);
        await rejects(index(f, set));
        const members = await chunks(f, set);
        await rejects(index(f, set));
        await embed(f, members[0]);
        await rejects(index(f, set));
        await embed(f, members[1]);
        const build = await index(f, set);
        await rejects(
          db.versionVectorIndex.update({
            where: { id: build.id },
            data: { status: 'READY', indexedAt: new Date() },
          }),
        );
        await rejects(
          db.versionVectorIndex.update({
            where: { id: build.id },
            data: { status: 'INDEXED' },
          }),
        );
        await rejects(
          db.versionVectorIndex.update({
            where: { id: build.id },
            data: { collectionName: 'different' },
          }),
        );
      },
    );
    await t.test(
      'ready mapping is per profile, requires desired build, and serving selection is separate',
      async () => {
        const f = await graph();
        const mapping = {
          ...owned(f),
          embeddingProfileId: f.profile.id,
          vectorIndexId: f.build.id,
        };
        await rejects(db.versionReadyIndex.create({ data: mapping }));
        await db.versionAiState.create({
          data: { ...owned(f), desiredRunId: f.run.id },
        });
        await db.versionVectorIndex.update({
          where: { id: f.build.id },
          data: {
            status: 'READY',
            confirmedPointCount: 2,
            checkpointOrdinal: 1,
            indexedAt: new Date(),
          },
        });
        await db.versionReadyIndex.create({ data: mapping });
        await rejects(db.versionReadyIndex.create({ data: mapping }));
        assert.equal(await db.aiServingProfile.count(), 0);
        await db.aiServingProfile.create({
          data: { embeddingProfileId: f.profile.id },
        });
        await rejects(
          db.aiServingProfile.create({
            data: { id: 2, embeddingProfileId: f.profile.id },
          }),
        );
        await db.aiServingProfile.deleteMany();
        await rejects(
          db.versionVectorIndex.update({
            where: { id: f.build.id },
            data: { status: 'STALE' },
          }),
        );
        await db.versionReadyIndex.deleteMany({
          where: { documentVersionId: f.version.id },
        });
        for (const status of [
          'STALE',
          'REMOVAL_PENDING',
          'REMOVED',
          'FAILED',
        ]) {
          await db.versionVectorIndex.update({
            where: { id: f.build.id },
            data: { status },
          });
        }
      },
    );
    await t.test(
      'downstream jobs cannot be scheduled or completed without exact upstream output',
      async () => {
        const f = await fixture();
        const verify = await verified(f);
        const extract = await stage(f, 'EXTRACT_TEXT', verify);
        await rejects(stage(f, 'GENERATE_CHUNKS', extract));
        await rejects(
          db.processingJob.update({
            where: { id: extract.id },
            data: { status: 'COMPLETED', completedAt: new Date() },
          }),
        );
        const e = await extraction(f);
        await db.processingJob.update({
          where: { id: extract.id },
          data: {
            extractedTextId: e.id,
            status: 'COMPLETED',
            completedAt: new Date(),
          },
        });
        const chunk = await stage(f, 'GENERATE_CHUNKS', extract, {
          extractedTextId: e.id,
        });
        await rejects(
          db.processingJob.update({
            where: { id: chunk.id },
            data: { status: 'COMPLETED', completedAt: new Date() },
          }),
        );
        const set = await chunkSet(f, e);
        const members = await chunks(f, set);
        await db.processingJob.update({
          where: { id: chunk.id },
          data: {
            chunkSetId: set.id,
            status: 'COMPLETED',
            completedAt: new Date(),
          },
        });
        const embedding = await stage(f, 'GENERATE_EMBEDDINGS', chunk, {
          chunkSetId: set.id,
        });
        await rejects(
          db.processingJob.update({
            where: { id: embedding.id },
            data: { status: 'COMPLETED', completedAt: new Date() },
          }),
        );
        for (const c of members) await embed(f, c);
        await db.processingJob.update({
          where: { id: embedding.id },
          data: { status: 'COMPLETED', completedAt: new Date() },
        });
        const build = await index(f, set);
        const indexing = await stage(f, 'INDEX_VECTORS', embedding, {
          chunkSetId: set.id,
          vectorIndexId: build.id,
        });
        await rejects(
          db.processingJob.update({
            where: { id: indexing.id },
            data: { status: 'COMPLETED', completedAt: new Date() },
          }),
        );
        await db.versionVectorIndex.update({
          where: { id: build.id },
          data: {
            status: 'READY',
            confirmedPointCount: 2,
            checkpointOrdinal: 1,
            indexedAt: new Date(),
          },
        });
        await db.processingJob.update({
          where: { id: indexing.id },
          data: { status: 'COMPLETED', completedAt: new Date() },
        });
        await db.aiProcessingRun.update({
          where: { id: f.run.id },
          data: { status: 'READY', completedAt: new Date() },
        });
        await db.versionAiState.create({
          data: {
            ...owned(f),
            desiredRunId: f.run.id,
            lastExtractionJobId: extract.id,
          },
        });
        await rejects(
          db.versionAiState.update({
            where: { documentVersionId: f.version.id },
            data: { lastExtractionJobId: verify.id },
          }),
        );
      },
    );
    await t.test(
      'new versions preserve historical artifacts; archive/soft delete do not cascade originals',
      async () => {
        const f = await graph();
        const next = await db.documentVersion.create({
          data: {
            documentId: f.document.id,
            userId: f.user.id,
            versionNumber: 2,
            originalFilename: 'new.pdf',
            storageKey: `test/${randomUUID()}`,
            mimeType: 'application/pdf',
            fileSize: 15,
            pageCount: 2,
            checksumSha256: hash(randomUUID()),
          },
        });
        await db.versionVectorIndex.update({
          where: { id: f.build.id },
          data: {
            status: 'READY',
            confirmedPointCount: 2,
            checkpointOrdinal: 1,
            indexedAt: new Date(),
          },
        });
        await db.versionAiState.create({
          data: { ...owned(f), desiredRunId: f.run.id },
        });
        await rejects(
          db.versionReadyIndex.create({
            data: {
              ...owned(f),
              embeddingProfileId: f.profile.id,
              vectorIndexId: f.build.id,
            },
          }),
        );
        await db.document.update({
          where: { id: f.document.id },
          data: { status: 'ARCHIVED', isArchived: true, deletedAt: new Date() },
        });
        assert.equal(
          await db.documentChunk.count({
            where: { documentVersionId: f.version.id },
          }),
          2,
        );
        assert.ok(
          await db.documentVersion.findUnique({ where: { id: next.id } }),
        );
      },
    );
    await t.test(
      'cleanup task identity survives retirement; completion requires removed state',
      async () => {
        const f = await graph();
        const cleanup = await db.processingJob.create({
          data: {
            ...owned(f),
            jobType: 'REMOVE_VECTOR_INDEX',
            vectorIndexId: f.build.id,
            maxAttempts: 3,
            correlationId: randomUUID(),
          },
        });
        await rejects(
          db.processingJob.update({
            where: { id: cleanup.id },
            data: { status: 'COMPLETED', completedAt: new Date() },
          }),
        );
        await db.versionVectorIndex.update({
          where: { id: f.build.id },
          data: { status: 'REMOVED' },
        });
        await db.processingJob.update({
          where: { id: cleanup.id },
          data: { status: 'COMPLETED', completedAt: new Date() },
        });
        await rejects(
          db.versionVectorIndex.delete({ where: { id: f.build.id } }),
        );
      },
    );
    await t.test(
      'deleting derived artifacts never deletes the authoritative version/document',
      async () => {
        const f = await graph();
        await db.versionVectorIndex.delete({ where: { id: f.build.id } });
        await db.chunkSet.delete({ where: { id: f.set.id } });
        assert.equal(
          await db.chunkEmbedding.count({
            where: { documentVersionId: f.version.id },
          }),
          0,
        );
        await db.extractedText.delete({ where: { id: f.e.id } });
        assert.ok(
          await db.documentVersion.findUnique({ where: { id: f.version.id } }),
        );
        assert.ok(
          await db.document.findUnique({ where: { id: f.document.id } }),
        );
      },
    );
    await t.test(
      'open sets enforce unique ordinals and IDs before publication',
      async () => {
        const f = await graph();
        const replacement = await chunkSet(f, f.e, hash('open-set'));
        const { id, createdAt, ...data } = f.members[0];
        const chunkId = randomUUID();
        await db.documentChunk.create({
          data: { ...data, id: chunkId, chunkSetId: replacement.id },
        });
        await rejects(
          db.documentChunk.create({
            data: { ...data, id: randomUUID(), chunkSetId: replacement.id },
          }),
        );
        await rejects(
          db.documentChunk.create({
            data: {
              ...data,
              id: chunkId,
              chunkSetId: replacement.id,
              ordinal: 1,
            },
          }),
        );
        await rejects(
          db.chunkSet.update({
            where: { id: replacement.id },
            data: { chunkOverlap: 512 },
          }),
        );
      },
    );
    await t.test(
      'new profile readiness retains the prior mapping and serving profile',
      async () => {
        const f = await graph();
        await db.versionAiState.create({
          data: { ...owned(f), desiredRunId: f.run.id },
        });
        await db.versionVectorIndex.update({
          where: { id: f.build.id },
          data: {
            status: 'READY',
            confirmedPointCount: 2,
            checkpointOrdinal: 1,
            indexedAt: new Date(),
          },
        });
        await db.versionReadyIndex.create({
          data: {
            ...owned(f),
            embeddingProfileId: f.profile.id,
            vectorIndexId: f.build.id,
          },
        });
        await db.aiServingProfile.create({
          data: { embeddingProfileId: f.profile.id },
        });
        await db.aiProcessingRun.update({
          where: { id: f.run.id },
          data: { status: 'SUPERSEDED', completedAt: new Date() },
        });
        const config = { ...f.config, modelRevision: 'v2' };
        const profile = await db.embeddingProfile.create({
          data: { ...config, fingerprint: embeddingProfileFingerprint(config) },
        });
        profiles.push(profile.id);
        const { id, createdAt, updatedAt, ...runData } = f.run;
        const run = await db.aiProcessingRun.create({
          data: { ...runData, generation: 2, embeddingProfileId: profile.id },
        });
        const next = { ...f, run, profile };
        for (const c of f.members) await embed(next, c);
        const build = await index(next, f.set);
        await db.versionVectorIndex.update({
          where: { id: build.id },
          data: {
            status: 'READY',
            confirmedPointCount: 2,
            checkpointOrdinal: 1,
            indexedAt: new Date(),
          },
        });
        // Wrong-profile pointer is rejected even though dimensions are identical.
        await rejects(
          db.versionReadyIndex.upsert({
            where: {
              documentVersionId_embeddingProfileId: {
                documentVersionId: f.version.id,
                embeddingProfileId: f.profile.id,
              },
            },
            create: {
              ...owned(f),
              embeddingProfileId: f.profile.id,
              vectorIndexId: build.id,
            },
            update: { vectorIndexId: build.id },
          }),
        );
        await rejects(
          db.versionReadyIndex.create({
            data: {
              ...owned(next),
              embeddingProfileId: profile.id,
              vectorIndexId: build.id,
            },
          }),
        );
        await db.versionAiState.update({
          where: { documentVersionId: f.version.id },
          data: { desiredRunId: run.id },
        });
        await db.versionReadyIndex.create({
          data: {
            ...owned(next),
            embeddingProfileId: profile.id,
            vectorIndexId: build.id,
          },
        });
        assert.equal(
          await db.versionReadyIndex.count({
            where: { documentVersionId: f.version.id },
          }),
          2,
        );
        assert.equal(
          (await db.aiServingProfile.findUnique({ where: { id: 1 } }))
            .embeddingProfileId,
          f.profile.id,
        );
        await db.aiServingProfile.deleteMany();
      },
    );
    await t.test(
      'published index checkpoints cannot be deleted while serving or building',
      async () => {
        const f = await graph();
        const checkpoint = await db.chunkEmbedding.findFirst({
          where: { chunkId: f.members[0].id },
        });
        await rejects(
          db.chunkEmbedding.delete({ where: { id: checkpoint.id } }),
        );
        await db.versionVectorIndex.update({
          where: { id: f.build.id },
          data: { status: 'STALE' },
        });
        await db.chunkEmbedding.delete({ where: { id: checkpoint.id } });
        await db.versionVectorIndex.update({
          where: { id: f.build.id },
          data: { status: 'REMOVAL_PENDING' },
        });
      },
    );
    await t.test(
      'hard parent deletion cascades all subordinate artifacts and dependent jobs',
      async () => {
        const f = await graph();
        const verify = await verified(f);
        const extract = await stage(f, 'EXTRACT_TEXT', verify);
        await db.document.delete({ where: { id: f.document.id } });
        for (const model of [
          'documentVersion',
          'aiProcessingRun',
          'extractedText',
          'chunkSet',
          'documentChunk',
          'chunkEmbedding',
          'versionVectorIndex',
          'processingJob',
        ]) {
          const where =
            model === 'documentVersion'
              ? { documentId: f.document.id }
              : { documentVersionId: f.version.id };
          assert.equal(await db[model].count({ where }), 0, model);
        }
        assert.equal(
          await db.processingJob.count({ where: { id: extract.id } }),
          0,
        );
      },
    );
    await t.test(
      'existing integrity repository still claims/completes v1 job and outbox',
      async () => {
        const f = await fixture();
        const repository = new ProcessingRepository(db);
        const created = await repository.create({
          ...owned(f),
          maxAttempts: 3,
          correlationId: randomUUID(),
        });
        assert.equal(created.job.aiRunId, null);
        assert.equal(created.job.predecessorJobId, null);
        assert.equal(created.outbox.schemaVersion, 1);
        assert.equal(created.outbox.payload.jobType, 'VERIFY_STORED_FILE');
        const claim = await repository.claim(
          created.job.id,
          new Date(),
          120000,
        );
        const complete = await repository.complete(
          claim.id,
          claim.leaseToken,
          new Date(),
        );
        assert.equal(complete.status, 'COMPLETED');
        assert.equal(
          (await db.documentVersion.findUnique({ where: { id: f.version.id } }))
            .extractionStatus,
          'PENDING',
        );
      },
    );
  } finally {
    await db.aiServingProfile.deleteMany({
      where: { embeddingProfileId: { in: profiles } },
    });
    await db.document.deleteMany({ where: { id: { in: documents } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    await db.embeddingProfile.deleteMany({ where: { id: { in: profiles } } });
    await db.$disconnect();
  }
});
