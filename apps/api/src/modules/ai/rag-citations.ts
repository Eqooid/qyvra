import { AiOutputInvalidException } from '../../common/ai-output-invalid.exception';
import type { RagSource } from './rag-context';

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: readonly string[]) {
  return (
    Object.keys(value).length === allowed.length &&
    Object.keys(value).every((k) => allowed.includes(k))
  );
}
export interface GroundedClaim {
  text: string;
  citationIds: string[];
}
export interface Citation {
  citationId: string;
  documentId: string;
  documentVersionId: string;
  versionNumber: number;
  chunkId: string;
  chunkOrdinal: number;
  title: string;
  originalFilename: string;
  pageSpans: { pageNumber: number; startOffset: number; endOffset: number }[];
  excerptStart: number;
  excerptEnd: number;
  excerptHash: string;
  excerpt: string;
}
export type RagAnswer =
  | {
      outcome: 'answered';
      answer: string;
      claims: GroundedClaim[];
      citations: Citation[];
      requestId: string;
    }
  | {
      outcome: 'insufficient_evidence';
      answer: null;
      citations: [];
      reason:
        | 'no_authorized_evidence'
        | 'context_budget'
        | 'model_insufficient_evidence'
        | 'evidence_changed';
      requestId: string;
    };

/** Strict owned output contract; evidence tokens resolve through a request-local SQL source map. */
export function validateRagOutput(
  content: string,
  sources: readonly RagSource[],
) {
  let value: unknown;
  try {
    if (content.length > 65536) throw Error();
    value = JSON.parse(content);
  } catch {
    throw new AiOutputInvalidException();
  }
  if (
    !object(value) ||
    !keys(value, ['outcome', 'claims']) ||
    !Array.isArray(value.claims) ||
    value.claims.length > 64
  )
    throw new AiOutputInvalidException();
  if (value.outcome === 'insufficient_evidence' && value.claims.length === 0)
    return {
      outcome: 'insufficient_evidence' as const,
      claims: [],
      citations: [],
    };
  if (value.outcome !== 'answered' || !value.claims.length)
    throw new AiOutputInvalidException();
  const known = new Map(sources.map((s) => [s.token, s.source]));
  const used = new Set<string>();
  let length = 0;
  const claims: GroundedClaim[] = value.claims.map((claim: unknown) => {
    if (
      !object(claim) ||
      !keys(claim, ['text', 'sourceTokens']) ||
      typeof claim.text !== 'string' ||
      !claim.text.trim() ||
      claim.text.length > 2048 ||
      /\[(?:S|C)\d+\]/.test(claim.text) ||
      !Array.isArray(claim.sourceTokens) ||
      !claim.sourceTokens.length ||
      claim.sourceTokens.length > 20 ||
      !claim.sourceTokens.every(
        (s: unknown) => typeof s === 'string' && known.has(s),
      )
    )
      throw new AiOutputInvalidException();
    length += claim.text.length;
    if (length > 32768) throw new AiOutputInvalidException();
    const citationIds = [...new Set(claim.sourceTokens as string[])];
    citationIds.forEach((s) => used.add(s));
    return { text: claim.text.trim(), citationIds };
  });
  const citations: Citation[] = sources
    .filter((s) => used.has(s.token))
    .map(({ token, source: s }) => {
      if (!Array.isArray(s.pageSpans) || !s.pageSpans.length)
        throw new AiOutputInvalidException();
      const pageSpans = s.pageSpans.map((span) => {
        if (
          !object(span) ||
          !Number.isSafeInteger(span.pageNumber) ||
          Number(span.pageNumber) < 1 ||
          !Number.isSafeInteger(span.startOffset) ||
          !Number.isSafeInteger(span.endOffset) ||
          Number(span.startOffset) < s.startOffset ||
          Number(span.endOffset) > s.endOffset ||
          Number(span.startOffset) >= Number(span.endOffset)
        )
          throw new AiOutputInvalidException();
        return {
          pageNumber: Number(span.pageNumber),
          startOffset: Number(span.startOffset),
          endOffset: Number(span.endOffset),
        };
      });
      return {
        citationId: token,
        documentId: s.documentId,
        documentVersionId: s.documentVersionId,
        versionNumber: s.versionNumber,
        chunkId: s.chunkId,
        chunkOrdinal: s.chunkOrdinal,
        title: s.title,
        originalFilename: s.originalFilename,
        pageSpans,
        excerptStart: s.startOffset,
        excerptEnd: s.endOffset,
        excerptHash: s.excerptHash,
        excerpt: s.excerpt,
      };
    });
  return { outcome: 'answered' as const, claims, citations };
}
