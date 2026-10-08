import { randomUUID } from 'node:crypto';
import {
  ProcessingRepository,
  embeddingProfileFingerprint,
  type PrismaClient,
} from '@qyvra/database';
import { VectorIndexHandler } from './vector-index.handler';
import {
  VectorStoreFailure,
  vectorCollectionName,
  type VectorStore,
} from '../../modules/ai/vector-store';
import { embeddingInputHash } from '../../modules/ai/embedding-provider';

describe('vector handler with a fake vector-store boundary', () => {
  function fixture() {
    const profile = {
      id: randomUUID(),
      provider: 'test',
      model: 'test',
      modelRevision: '1',
      profileVersion: 1,
      dimensions: 3,
      distance: 'Cosine' as const,
      normalizationVersion: 'qyvra-embedding-input/v1',
      tokenizer: 'cl100k_base',
      tokenizerVersion: 'tiktoken-1.0.22',
      documentInstruction: '',
      queryInstruction: '',
      fingerprint: '',
    };
    profile.fingerprint = embeddingProfileFingerprint(profile);
    const setId = randomUUID(),
      runId = randomUUID();
    const index = {
      id: randomUUID(),
      aiRunId: runId,
      chunkSetId: setId,
      embeddingProfileId: profile.id,
      collectionName: vectorCollectionName(profile.id),
      expectedPointCount: 1,
      confirmedPointCount: 0,
      checkpointOrdinal: -1,
      status: 'BUILDING',
      profile,
      set: { complete: true, chunkCount: 1 },
    };
    const job = {
      id: randomUUID(),
      jobType: 'INDEX_VECTORS',
      status: 'PROCESSING',
      leaseToken: randomUUID(),
      attempts: 1,
      documentId: randomUUID(),
      documentVersionId: randomUUID(),
      userId: randomUUID(),
      aiRunId: runId,
      chunkSetId: setId,
      vectorIndex: index,
      predecessor: {
        jobType: 'GENERATE_EMBEDDINGS',
        status: 'COMPLETED',
        chunkSetId: setId,
      },
    };
    const chunk = {
      id: randomUUID(),
      text: 'Private canonical text',
      ordinal: 0,
      pageSpans: [{ pageNumber: 1 }, { pageNumber: 2 }],
      embeddings: [
        {
          dimensions: 3,
          inputHash: embeddingInputHash('Private canonical text'),
          vector: [1, 2, 3],
        },
      ],
    };
    const tx = {
      versionVectorIndex: {
        findUniqueOrThrow: jest.fn(async () => index),
        update: jest.fn(async ({ data }: { data: object }) =>
          Object.assign(index, data),
        ),
      },
    };
    const db = {
      processingJob: { findUnique: jest.fn(async () => job) },
      documentChunk: { findMany: jest.fn(async () => [chunk]) },
    } as unknown as PrismaClient;
    const store: VectorStore = {
      ensureCollection: jest.fn(async () => {}),
      verify: jest.fn(async () => true),
      upsert: jest.fn(async () => {}),
      count: jest.fn(async () => 1),
      remove: jest.fn(async () => {}),
    };
    jest
      .spyOn(ProcessingRepository.prototype, 'heartbeat')
      .mockResolvedValue(job as never);
    jest
      .spyOn(ProcessingRepository.prototype, 'checkpoint')
      .mockImplementation(async (_id, _token, _now, commit) => {
        await commit(tx as never, job as never);
      });
    const input = {
      jobId: job.id,
      documentId: job.documentId,
      documentVersionId: job.documentVersionId,
      leaseToken: job.leaseToken,
      attempt: 1,
    };
    return {
      job,
      index,
      chunk,
      db,
      store,
      input,
      tx,
      handler: new VectorIndexHandler(db, store, {
        enabled: true,
        batchSize: 2,
        timeoutMs: 1000,
      }),
    };
  }
  afterEach(() => jest.restoreAllMocks());
  it('verifies checkpointed points without duplicate writes and commits READY only after verification', async () => {
    const f = fixture();
    const result = await f.handler.execute(f.input);
    expect(result.kind).toBe('success');
    expect(f.store.upsert).not.toHaveBeenCalled();
    expect(f.index.status).toBe('BUILDING');
    if (result.kind !== 'success' || !result.commit)
      throw Error('Expected successful fenced commit');
    await result.commit(f.tx as never, f.job as never);
    expect(f.index.status).toBe('READY');
  });
  it('sends identifiers and truthful multi-page provenance without text', async () => {
    const f = fixture();
    (f.store.verify as jest.Mock)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    expect((await f.handler.execute(f.input)).kind).toBe('success');
    const points = (f.store.upsert as jest.Mock).mock.calls[0][1] as {
      payload: object;
    }[];
    expect(points[0].payload).toMatchObject({
      userId: f.job.userId,
      pageNumbers: [1, 2],
      chunkId: f.chunk.id,
    });
    expect(JSON.stringify(points[0].payload)).not.toContain(f.chunk.text);
  });
  it('does not complete an unconfirmed write', async () => {
    const f = fixture();
    (f.store.verify as jest.Mock).mockResolvedValue(false);
    expect(await f.handler.execute(f.input)).toEqual({
      kind: 'retryable',
      failureCode: 'VECTOR_WRITE_UNCONFIRMED',
    });
    expect(ProcessingRepository.prototype.checkpoint).not.toHaveBeenCalled();
    expect(f.index.status).toBe('BUILDING');
  });
  it('refuses missing embeddings and mismatched broker identities', async () => {
    const f = fixture();
    f.chunk.embeddings = [];
    expect(await f.handler.execute(f.input)).toEqual({
      kind: 'terminal',
      failureCode: 'VECTOR_EMBEDDING_INVALID',
    });
    expect(f.store.upsert).not.toHaveBeenCalled();
    expect(
      await f.handler.execute({ ...f.input, documentId: randomUUID() }),
    ).toEqual({ kind: 'terminal', failureCode: 'VECTOR_JOB_INVALID' });
  });
  it('classifies unsupported persisted normalization as a deterministic profile failure', async () => {
    const f = fixture();
    f.index.profile.normalizationVersion = 'unsupported/v2';
    f.index.profile.fingerprint = embeddingProfileFingerprint(f.index.profile);
    expect(await f.handler.execute(f.input)).toEqual({
      kind: 'terminal',
      failureCode: 'VECTOR_PROFILE_INVALID',
    });
    expect(f.store.upsert).not.toHaveBeenCalled();
  });
  it('preserves sanitized retryable vector-store failures', async () => {
    const f = fixture();
    (f.store.ensureCollection as jest.Mock).mockRejectedValue(
      new VectorStoreFailure('VECTOR_UNAVAILABLE', true),
    );
    expect(await f.handler.execute(f.input)).toEqual({
      kind: 'retryable',
      failureCode: 'VECTOR_UNAVAILABLE',
    });
  });
});
