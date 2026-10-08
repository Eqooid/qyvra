import { QdrantClient } from '@qdrant/js-client-rest';
import type { ApiConfiguration } from '../../configuration/settings';
import { validVector } from '../../modules/ai/embedding-provider';
import {
  VectorStoreFailure,
  validateScope,
  validatePoints,
  vectorCollectionName,
  vectorPointId,
  type VectorSearchRequest,
  type VectorSearchStore,
  type VectorCandidate,
  type VectorStore,
  type VectorScope,
  type VectorPoint,
} from '../../modules/ai/vector-store';

const scopeFields = [
  'userId',
  'documentId',
  'documentVersionId',
  'chunkSetId',
  'indexManifestId',
  'embeddingProfileId',
] as const;
function status(error: unknown): number | undefined {
  if (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof error.status === 'number'
  )
    return error.status;
  return undefined;
}
function filter(scope: VectorScope) {
  validateScope(scope);
  return {
    must: [
      ...scopeFields.map((key) => ({ key, match: { value: scope[key] } })),
      {
        key: 'embeddingProfileVersion',
        match: { value: scope.embeddingProfileVersion },
      },
      { key: 'payloadSchemaVersion', match: { value: 1 } },
    ],
  };
}
function normalized(vector: number[]): number[] {
  const scale = Math.max(...vector.map(Math.abs));
  const scaled = vector.map((v) => v / scale);
  const norm = Math.sqrt(scaled.reduce((sum, v) => sum + v * v, 0));
  return scaled.map((v) => v / norm);
}
export class QdrantVectorStore implements VectorStore, VectorSearchStore {
  private readonly client?: QdrantClient;
  constructor(config: ApiConfiguration['vectorIndex']) {
    if (config.enabled && config.url)
      this.client = new QdrantClient({
        url: config.url,
        port: new URL(config.url).port
          ? Number(new URL(config.url).port)
          : new URL(config.url).protocol === 'https:'
            ? 443
            : 80,
        apiKey: config.apiKey,
        timeout: config.timeoutMs,
        checkCompatibility: false,
        maxConnections: 4,
      });
  }
  private async operation<T>(
    action: (client: QdrantClient) => Promise<T>,
  ): Promise<T> {
    if (!this.client) throw new VectorStoreFailure('VECTOR_NOT_CONFIGURED');
    try {
      return await action(this.client);
    } catch (error) {
      if (error instanceof VectorStoreFailure) throw error;
      const code = status(error);
      throw new VectorStoreFailure(
        code === 401 || code === 403
          ? 'VECTOR_AUTH_FAILED'
          : code === 404
            ? 'VECTOR_COLLECTION_MISSING'
            : code && code >= 400 && code < 500 && code !== 408 && code !== 429
              ? 'VECTOR_REQUEST_INVALID'
              : 'VECTOR_UNAVAILABLE',
        !code || code >= 500 || code === 404 || code === 408 || code === 429,
      );
    }
  }
  async search(request: VectorSearchRequest): Promise<VectorCandidate[]> {
    const uuid = (value: unknown): value is string =>
      typeof value === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        value,
      );
    if (
      !uuid(request.userId) ||
      !uuid(request.embeddingProfileId) ||
      !Number.isSafeInteger(request.embeddingProfileVersion) ||
      request.embeddingProfileVersion < 1 ||
      !request.manifestIds.length ||
      request.manifestIds.length > 2000 ||
      !request.manifestIds.every(uuid) ||
      !Number.isInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > 100 ||
      !validVector(request.vector, request.dimensions) ||
      (request.minScore !== undefined &&
        (!Number.isFinite(request.minScore) ||
          request.minScore < -1 ||
          request.minScore > 1))
    )
      throw new VectorStoreFailure('VECTOR_SEARCH_INVALID');
    return this.operation(async (client) => {
      const collection = vectorCollectionName(request.embeddingProfileId);
      // Read-only compatibility check. Never create an absent collection during a query.
      const info = await client.getCollection(collection);
      const vectors = info.config.params.vectors;
      if (
        !vectors ||
        !('size' in vectors) ||
        vectors.size !== request.dimensions ||
        vectors.distance !== 'Cosine' ||
        info.config.metadata?.embeddingProfileId !==
          request.embeddingProfileId ||
        info.config.metadata?.embeddingProfileVersion !==
          request.embeddingProfileVersion ||
        info.config.metadata?.payloadSchemaVersion !== 1
      )
        throw new VectorStoreFailure('VECTOR_COLLECTION_INCOMPATIBLE');
      const found = await client.query(collection, {
        query: normalized(request.vector),
        limit: request.limit,
        score_threshold: request.minScore,
        with_vector: false,
        with_payload: [
          'userId',
          'embeddingProfileId',
          'embeddingProfileVersion',
          'payloadSchemaVersion',
          'chunkId',
          'indexManifestId',
          'documentId',
          'documentVersionId',
          'chunkSetId',
        ],
        filter: {
          must: [
            { key: 'userId', match: { value: request.userId } },
            {
              key: 'embeddingProfileId',
              match: { value: request.embeddingProfileId },
            },
            {
              key: 'embeddingProfileVersion',
              match: { value: request.embeddingProfileVersion },
            },
            { key: 'payloadSchemaVersion', match: { value: 1 } },
            {
              key: 'indexManifestId',
              match: { any: [...request.manifestIds] },
            },
          ],
        },
      });
      const candidates: VectorCandidate[] = [];
      for (const item of found.points.slice(0, request.limit)) {
        const p = item.payload;
        if (
          !p ||
          p.userId !== request.userId ||
          p.embeddingProfileId !== request.embeddingProfileId ||
          p.embeddingProfileVersion !== request.embeddingProfileVersion ||
          p.payloadSchemaVersion !== 1 ||
          !uuid(p.chunkId) ||
          !uuid(p.indexManifestId) ||
          !request.manifestIds.includes(p.indexManifestId) ||
          !uuid(p.documentId) ||
          !uuid(p.documentVersionId) ||
          !uuid(p.chunkSetId) ||
          item.id !==
            vectorPointId(
              p.chunkId,
              request.embeddingProfileId,
              p.indexManifestId,
            ) ||
          !Number.isFinite(item.score)
        )
          continue;
        candidates.push({
          chunkId: p.chunkId,
          indexManifestId: p.indexManifestId,
          documentId: p.documentId,
          documentVersionId: p.documentVersionId,
          chunkSetId: p.chunkSetId,
          score: item.score,
        });
      }
      return candidates;
    });
  }
  async ensureCollection(
    scope: VectorScope,
    dimensions: number,
  ): Promise<void> {
    validateScope(scope);
    await this.operation(async (client) => {
      try {
        await client.getCollection(scope.collectionName);
      } catch (error) {
        if (status(error) !== 404) throw error;
        try {
          await client.createCollection(scope.collectionName, {
            vectors: { size: dimensions, distance: 'Cosine' },
            metadata: {
              embeddingProfileId: scope.embeddingProfileId,
              embeddingProfileVersion: scope.embeddingProfileVersion,
              payloadSchemaVersion: 1,
            },
          });
        } catch (creation) {
          if (![409, 400].includes(status(creation) ?? 0)) throw creation;
        }
      }
      const info = await client.getCollection(scope.collectionName);
      const vectors = info.config.params.vectors;
      if (
        !vectors ||
        !('size' in vectors) ||
        vectors.size !== dimensions ||
        vectors.distance !== 'Cosine' ||
        info.config.metadata?.embeddingProfileId !== scope.embeddingProfileId ||
        info.config.metadata?.embeddingProfileVersion !==
          scope.embeddingProfileVersion ||
        info.config.metadata?.payloadSchemaVersion !== 1
      )
        throw new VectorStoreFailure('VECTOR_COLLECTION_INCOMPATIBLE');
      for (const key of [
        ...scopeFields,
        'embeddingProfileVersion',
        'payloadSchemaVersion',
      ]) {
        const type = scopeFields.includes(key as (typeof scopeFields)[number])
          ? 'keyword'
          : 'integer';
        const existing = info.payload_schema[key];
        if (existing && existing.data_type !== type)
          throw new VectorStoreFailure('VECTOR_COLLECTION_INCOMPATIBLE');
        if (!existing) {
          const result = await client.createPayloadIndex(scope.collectionName, {
            field_name: key,
            field_schema: type,
            wait: true,
          });
          if (result.status !== 'completed')
            throw new VectorStoreFailure('VECTOR_WRITE_UNCONFIRMED', true);
        }
      }
    });
  }
  async upsert(scope: VectorScope, points: VectorPoint[]): Promise<void> {
    validatePoints(scope, points);
    await this.operation(async (client) => {
      const result = await client.upsert(scope.collectionName, {
        wait: true,
        points: points.map((p) => ({
          ...p,
          vector: normalized(p.vector),
          payload: { ...p.payload },
        })),
      });
      if (result.status !== 'completed')
        throw new VectorStoreFailure('VECTOR_WRITE_UNCONFIRMED', true);
    });
  }
  async verify(scope: VectorScope, points: VectorPoint[]): Promise<boolean> {
    validatePoints(scope, points);
    return this.operation(async (client) => {
      const found = await client.retrieve(scope.collectionName, {
        ids: points.map((p) => p.id),
        with_payload: true,
        with_vector: true,
      });
      return points.every((expected) => {
        const actual = found.find((p) => p.id === expected.id);
        if (
          !actual?.payload ||
          !Array.isArray(actual.vector) ||
          actual.vector.length !== expected.vector.length
        )
          return false;
        if (
          Object.keys(actual.payload).length !==
            Object.keys(expected.payload).length ||
          Object.entries(expected.payload).some(
            ([k, v]) =>
              JSON.stringify(actual.payload![k]) !== JSON.stringify(v),
          )
        )
          return false;
        const vector = normalized(expected.vector);
        return actual.vector.every(
          (v, i) =>
            typeof v === 'number' &&
            Number.isFinite(v) &&
            Math.abs(v - vector[i]) <= 1e-5,
        );
      });
    });
  }
  async count(scope: VectorScope): Promise<number> {
    return this.operation(async (client) => {
      try {
        return (
          await client.count(scope.collectionName, {
            filter: filter(scope),
            exact: true,
          })
        ).count;
      } catch (error) {
        if (status(error) === 404) return 0;
        throw error;
      }
    });
  }
  async remove(scope: VectorScope): Promise<void> {
    await this.operation(async (client) => {
      try {
        const result = await client.delete(scope.collectionName, {
          filter: filter(scope),
          wait: true,
        });
        if (result.status !== 'completed')
          throw new VectorStoreFailure('VECTOR_WRITE_UNCONFIRMED', true);
      } catch (error) {
        if (status(error) !== 404) throw error;
      }
    });
    if ((await this.count(scope)) !== 0)
      throw new VectorStoreFailure('VECTOR_REMOVAL_UNCONFIRMED', true);
  }
}
