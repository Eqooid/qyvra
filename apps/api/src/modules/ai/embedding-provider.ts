import { createHash } from 'node:crypto';
import type { EmbeddingProfileIdentity } from '@qyvra/database';

export interface EmbeddingInput {
  readonly id: string;
  readonly text: string;
}
export interface EmbeddingRequest {
  readonly profile: EmbeddingProfileIdentity;
  readonly inputs: readonly EmbeddingInput[];
  readonly purpose: 'document' | 'query';
  readonly signal: AbortSignal;
}
export interface EmbeddingResult {
  readonly id: string;
  readonly vector: readonly number[];
}
export interface EmbeddingProvider {
  embed(request: EmbeddingRequest): Promise<readonly EmbeddingResult[]>;
}

/** Only stable safe categories cross the provider boundary. Never retain a cause/body. */
export class EmbeddingFailure extends Error {
  constructor(
    readonly code: string,
    readonly retryable = false,
    readonly retryAfterMs?: number,
  ) {
    super(code);
  }
}

export function embeddingText(
  text: string,
  profile: EmbeddingProfileIdentity,
  purpose: 'document' | 'query',
): string {
  if (profile.normalizationVersion !== 'qyvra-embedding-input/v1')
    throw new EmbeddingFailure('EMBEDDING_PROFILE_UNSUPPORTED');
  if (!text.trim()) throw new EmbeddingFailure('EMBEDDING_EMPTY_INPUT');
  const instruction =
    purpose === 'document'
      ? profile.documentInstruction
      : profile.queryInstruction;
  return instruction ? `${instruction}\n${text}` : text;
}

export function embeddingInputHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function validVector(
  value: unknown,
  dimensions: number,
): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === dimensions &&
    Array.from(value).every(
      (n: unknown) => typeof n === 'number' && Number.isFinite(n),
    ) &&
    value.some((n: number) => n !== 0)
  );
}

/** Validate the entire batch before any checkpoint can be committed. */
export function validateEmbeddingResults(
  inputs: readonly EmbeddingInput[],
  results: readonly EmbeddingResult[],
  dimensions: number,
): readonly EmbeddingResult[] {
  if (!Array.isArray(results) || results.length !== inputs.length)
    throw new EmbeddingFailure('EMBEDDING_INVALID_OUTPUT');
  const expected = new Set(inputs.map((input) => input.id));
  const byId = new Map<string, EmbeddingResult>();
  for (const result of results) {
    if (
      !result ||
      !expected.has(result.id) ||
      byId.has(result.id) ||
      !validVector(result.vector, dimensions)
    )
      throw new EmbeddingFailure('EMBEDDING_INVALID_OUTPUT');
    byId.set(result.id, result);
  }
  return inputs.map((input) => {
    const result = byId.get(input.id);
    if (!result) throw new EmbeddingFailure('EMBEDDING_INVALID_OUTPUT');
    return result;
  });
}
