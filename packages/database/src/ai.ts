import { createHash } from 'node:crypto';

export const aiRunStatuses = [
  'BUILDING',
  'READY',
  'FAILED',
  'CANCELLED',
  'SUPERSEDED',
] as const;
export type AiRunStatus = (typeof aiRunStatuses)[number];

export const vectorIndexStatuses = [
  'BUILDING',
  'READY',
  'STALE',
  'REMOVAL_PENDING',
  'REMOVED',
  'FAILED',
] as const;
export type VectorIndexStatus = (typeof vectorIndexStatuses)[number];

/** Half-open Unicode scalar offsets into the canonical extraction, not JS UTF-16. */
export interface SourcePageSpan {
  readonly pageNumber: number;
  readonly startOffset: number;
  readonly endOffset: number;
}

/** Public configuration only: endpoint credentials and operational settings stay outside it. */
export interface EmbeddingProfileIdentity {
  readonly profileVersion: number;
  readonly provider: string;
  readonly model: string;
  readonly modelRevision: string;
  readonly dimensions: number;
  readonly distance: 'Cosine';
  readonly normalizationVersion: string;
  readonly tokenizer: string;
  readonly tokenizerVersion: string;
  readonly documentInstruction: string;
  readonly queryInstruction: string;
}

export type AiStageType =
  'EXTRACT_TEXT' | 'GENERATE_CHUNKS' | 'GENERATE_EMBEDDINGS' | 'INDEX_VECTORS';

/** Declares dependencies without scheduling jobs or implementing any handlers. */
export const aiStagePrerequisites = {
  EXTRACT_TEXT: 'VERIFY_STORED_FILE',
  GENERATE_CHUNKS: 'EXTRACT_TEXT',
  GENERATE_EMBEDDINGS: 'GENERATE_CHUNKS',
  INDEX_VECTORS: 'GENERATE_EMBEDDINGS',
} as const;

/** Versioned ordered serialization; changing any semantic field changes identity. */
export function embeddingProfileFingerprint(
  profile: EmbeddingProfileIdentity,
): string {
  const fields = [
    profile.provider,
    profile.model,
    profile.modelRevision,
    profile.normalizationVersion,
    profile.tokenizer,
    profile.tokenizerVersion,
  ];
  if (
    !Number.isSafeInteger(profile.profileVersion) ||
    profile.profileVersion < 1 ||
    !Number.isSafeInteger(profile.dimensions) ||
    profile.dimensions < 1 ||
    profile.dimensions > 65536 ||
    profile.distance !== 'Cosine' ||
    fields.some((value) => typeof value !== 'string' || !value.trim()) ||
    typeof profile.documentInstruction !== 'string' ||
    typeof profile.queryInstruction !== 'string'
  )
    throw new Error('Invalid embedding profile identity.');
  return createHash('sha256')
    .update(
      JSON.stringify([
        'qyvra.embedding-profile.v1',
        profile.profileVersion,
        profile.provider,
        profile.model,
        profile.modelRevision,
        profile.dimensions,
        profile.distance,
        profile.normalizationVersion,
        profile.tokenizer,
        profile.tokenizerVersion,
        profile.documentInstruction,
        profile.queryInstruction,
      ]),
      'utf8',
    )
    .digest('hex');
}
