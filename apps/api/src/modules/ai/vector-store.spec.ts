import { randomUUID } from 'node:crypto';
import {
  vectorPointId,
  vectorCollectionName,
  validateScope,
  validatePoints,
  type VectorScope,
  type VectorPoint,
} from './vector-store';

describe('owned vector identity and payload contract', () => {
  const scope: VectorScope = {
    userId: randomUUID(),
    documentId: randomUUID(),
    documentVersionId: randomUUID(),
    chunkSetId: randomUUID(),
    indexManifestId: randomUUID(),
    embeddingProfileId: randomUUID(),
    embeddingProfileVersion: 1,
    collectionName: '',
  };
  scope.collectionName = vectorCollectionName(scope.embeddingProfileId);
  const chunkId = randomUUID();
  const { collectionName: _collection, ...payload } = scope;
  void _collection;
  const point: VectorPoint = {
    id: vectorPointId(chunkId, scope.embeddingProfileId, scope.indexManifestId),
    vector: [1, 2, 3],
    payload: {
      ...payload,
      chunkId,
      ordinal: 0,
      pageNumbers: [1, 2],
      payloadSchemaVersion: 1,
    },
  };
  it('is stable UUIDv5 and separates manifests and profiles', () => {
    expect(point.id).toMatch(/^[a-f0-9-]{14}5/);
    expect(
      vectorPointId(chunkId, scope.embeddingProfileId, scope.indexManifestId),
    ).toBe(point.id);
    expect(
      vectorPointId(chunkId, scope.embeddingProfileId, randomUUID()),
    ).not.toBe(point.id);
    expect(
      vectorPointId(chunkId, randomUUID(), scope.indexManifestId),
    ).not.toBe(point.id);
    expect(() => validatePoints(scope, [point], 3)).not.toThrow();
  });
  it('rejects foreign payloads, secrets, wrong dimensions and point IDs', () => {
    expect(() =>
      validatePoints(scope, [
        { ...point, payload: { ...point.payload, userId: randomUUID() } },
      ]),
    ).toThrow('VECTOR_POINTS_INVALID');
    expect(() =>
      validatePoints(scope, [
        {
          ...point,
          payload: { ...point.payload, text: 'private' },
        } as VectorPoint,
      ]),
    ).toThrow('VECTOR_POINTS_INVALID');
    expect(() => validatePoints(scope, [point], 4)).toThrow(
      'VECTOR_POINTS_INVALID',
    );
    expect(() =>
      validatePoints(scope, [{ ...point, id: randomUUID() }]),
    ).toThrow('VECTOR_POINTS_INVALID');
    expect(() =>
      validatePoints(scope, [{ ...point, vector: [NaN, 1, 2] }]),
    ).toThrow('VECTOR_POINTS_INVALID');
  });
  it('rejects malformed collection scopes and duplicate batches', () => {
    expect(() =>
      validateScope({ ...scope, collectionName: 'foreign' }),
    ).toThrow('VECTOR_SCOPE_INVALID');
    expect(() => validateScope({ ...scope, userId: '' })).toThrow(
      'VECTOR_SCOPE_INVALID',
    );
    expect(() => validatePoints(scope, [point, point])).toThrow(
      'VECTOR_POINTS_INVALID',
    );
  });
});
