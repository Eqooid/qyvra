import { randomUUID } from 'node:crypto';
import { QdrantClient } from '@qdrant/js-client-rest';
import { QdrantVectorStore } from './qdrant-vector-store';
import {
  vectorCollectionName,
  vectorPointId,
  type VectorScope,
  type VectorPoint,
  type VectorPayload,
} from '../../modules/ai/vector-store';
jest.mock('@qdrant/js-client-rest', () => ({ QdrantClient: jest.fn() }));

describe('native Qdrant adapter response contracts', () => {
  it('filters owner/profile/active manifests before similarity search and returns identifiers only', async () => {
    const f = fixture();
    const results = await f.store.search({
      userId: f.scope.userId,
      embeddingProfileId: f.scope.embeddingProfileId,
      embeddingProfileVersion: 1,
      dimensions: 3,
      manifestIds: [f.scope.indexManifestId],
      vector: [1, 2, 3],
      limit: 20,
    });
    expect(results).toEqual([
      expect.objectContaining({ chunkId: f.point.payload.chunkId, score: 0.8 }),
    ]);
    expect(f.client.query).toHaveBeenCalledWith(
      f.scope.collectionName,
      expect.objectContaining({
        with_vector: false,
        limit: 20,
        filter: {
          must: expect.arrayContaining([
            { key: 'userId', match: { value: f.scope.userId } },
            {
              key: 'embeddingProfileId',
              match: { value: f.scope.embeddingProfileId },
            },
            { key: 'embeddingProfileVersion', match: { value: 1 } },
            {
              key: 'indexManifestId',
              match: { any: [f.scope.indexManifestId] },
            },
          ]),
        },
      }),
    );
    expect(f.client.createCollection).not.toHaveBeenCalled();
    expect(f.client.upsert).not.toHaveBeenCalled();
  });
  it('rejects forged point identity, missing metadata and foreign ownership defensively', async () => {
    const f = fixture();
    f.client.query.mockResolvedValue({
      points: [
        { id: randomUUID(), payload: f.point.payload, score: 0.9 },
        {
          id: f.point.id,
          payload: { ...f.point.payload, userId: randomUUID() },
          score: 0.9,
        },
        { id: f.point.id, payload: {}, score: 0.9 },
      ],
    } as never);
    expect(
      await f.store.search({
        userId: f.scope.userId,
        embeddingProfileId: f.scope.embeddingProfileId,
        embeddingProfileVersion: 1,
        dimensions: 3,
        manifestIds: [f.scope.indexManifestId],
        vector: [1, 2, 3],
        limit: 20,
      }),
    ).toEqual([]);
  });
  it('refuses incompatible collections without writes', async () => {
    const f = fixture();
    f.client.getCollection.mockResolvedValue({
      config: {
        params: { vectors: { size: 4, distance: 'Cosine' } },
        metadata: {},
      },
      payload_schema: {},
    } as never);
    await expect(
      f.store.search({
        userId: f.scope.userId,
        embeddingProfileId: f.scope.embeddingProfileId,
        embeddingProfileVersion: 1,
        dimensions: 3,
        manifestIds: [f.scope.indexManifestId],
        vector: [1, 2, 3],
        limit: 20,
      }),
    ).rejects.toMatchObject({ code: 'VECTOR_COLLECTION_INCOMPATIBLE' });
    expect(f.client.createCollection).not.toHaveBeenCalled();
  });
  function fixture() {
    const profileId = randomUUID();
    const scope: VectorScope = {
      collectionName: vectorCollectionName(profileId),
      embeddingProfileId: profileId,
      embeddingProfileVersion: 1,
      userId: randomUUID(),
      documentId: randomUUID(),
      documentVersionId: randomUUID(),
      chunkSetId: randomUUID(),
      indexManifestId: randomUUID(),
    };
    const chunkId = randomUUID();
    const payload: VectorPayload = {
      userId: scope.userId,
      documentId: scope.documentId,
      documentVersionId: scope.documentVersionId,
      chunkSetId: scope.chunkSetId,
      indexManifestId: scope.indexManifestId,
      embeddingProfileId: profileId,
      embeddingProfileVersion: 1,
      chunkId,
      ordinal: 0,
      payloadSchemaVersion: 1 as const,
      pageNumbers: [1],
    };
    const point: VectorPoint = {
      id: vectorPointId(chunkId, profileId, scope.indexManifestId),
      vector: [1, 2, 3],
      payload,
    };
    const client = {
      getCollection: jest.fn(async () => ({
        config: {
          params: { vectors: { size: 3, distance: 'Cosine' } },
          metadata: {
            embeddingProfileId: profileId,
            embeddingProfileVersion: 1,
            payloadSchemaVersion: 1,
          },
        },
        payload_schema: {},
      })),
      createCollection: jest.fn(async () => true),
      createPayloadIndex: jest.fn(async () => ({ status: 'completed' })),
      upsert: jest.fn(async () => ({ status: 'completed' })),
      retrieve: jest.fn(async () => [
        {
          id: point.id,
          payload,
          vector: [1, 2, 3].map((v) => v / Math.sqrt(14)),
        },
      ]),
      count: jest.fn(async () => ({ count: 0 })),
      query: jest.fn(async () => ({
        points: [{ id: point.id, payload, score: 0.8 }],
      })),
      delete: jest.fn(async () => ({ status: 'completed' })),
    };
    (QdrantClient as jest.Mock).mockImplementation(() => client);
    return {
      scope,
      point,
      client,
      store: new QdrantVectorStore({
        enabled: true,
        url: 'https://qdrant.example.invalid',
        apiKey: 'fixture-only-key',
        timeoutMs: 1000,
        batchSize: 2,
      }),
    };
  }
  afterEach(() => jest.clearAllMocks());
  it('checks compatible metadata and provisions mandatory payload indexes', async () => {
    const f = fixture();
    await f.store.ensureCollection(f.scope, 3);
    expect(f.client.createCollection).not.toHaveBeenCalled();
    expect(f.client.createPayloadIndex).toHaveBeenCalledTimes(8);
    expect(QdrantClient).toHaveBeenCalledWith(
      expect.objectContaining({
        timeout: 1000,
        checkCompatibility: false,
        port: 443,
      }),
    );
    await expect(f.store.ensureCollection(f.scope, 4)).rejects.toMatchObject({
      code: 'VECTOR_COLLECTION_INCOMPATIBLE',
      retryable: false,
    });
  });
  it('rejects acknowledged-only writes and normalizes vectors before transport', async () => {
    const f = fixture();
    f.client.upsert.mockResolvedValue({ status: 'acknowledged' });
    await expect(f.store.upsert(f.scope, [f.point])).rejects.toMatchObject({
      code: 'VECTOR_WRITE_UNCONFIRMED',
      retryable: true,
    });
    expect(f.client.upsert).toHaveBeenCalledWith(
      f.scope.collectionName,
      expect.objectContaining({ wait: true }),
    );
  });
  it('verifies actual payload ownership and Cosine vector values', async () => {
    const f = fixture();
    expect(await f.store.verify(f.scope, [f.point])).toBe(true);
    f.client.retrieve.mockResolvedValue([
      {
        id: f.point.id,
        vector: [1, 2, 3],
        payload: { ...f.point.payload, userId: randomUUID() },
      },
    ]);
    expect(await f.store.verify(f.scope, [f.point])).toBe(false);
  });
  it('sanitizes authentication failures and retries a missing collection', async () => {
    const f = fixture();
    f.client.upsert.mockRejectedValue({
      status: 403,
      data: 'private upstream body',
    });
    await expect(f.store.upsert(f.scope, [f.point])).rejects.toMatchObject({
      message: 'VECTOR_AUTH_FAILED',
      code: 'VECTOR_AUTH_FAILED',
      retryable: false,
    });
    f.client.retrieve.mockRejectedValue({
      status: 404,
      data: 'private upstream body',
    });
    await expect(f.store.verify(f.scope, [f.point])).rejects.toMatchObject({
      message: 'VECTOR_COLLECTION_MISSING',
      retryable: true,
    });
  });
  it('treats an absent collection as idempotent scoped cleanup', async () => {
    const f = fixture();
    f.client.delete.mockRejectedValue({ status: 404 });
    f.client.count.mockRejectedValue({ status: 404 });
    await expect(f.store.remove(f.scope)).resolves.toBeUndefined();
    const call = f.client.delete.mock.calls[0] as unknown as [
      string,
      {
        filter: { must: { key: string; match: { value: string | number } }[] };
        wait: boolean;
      },
    ];
    expect(call[1].wait).toBe(true);
    expect(call[1].filter.must).toContainEqual({
      key: 'userId',
      match: { value: f.scope.userId },
    });
    expect(call[1].filter.must).toContainEqual({
      key: 'indexManifestId',
      match: { value: f.scope.indexManifestId },
    });
  });
});
