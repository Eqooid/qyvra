import type { LexicalReference } from './keyword-search.repository';
import type { VectorCandidate } from '../ai/vector-store';

export const SEARCH_RANKING_VERSION = 'document-rrf60-v1';
export const SEARCH_LEG_WINDOW = 100;
export const SEARCH_WINDOW_LIMIT = 200;
export type SearchMode = 'keyword' | 'hybrid';
export interface SearchWindowEntry {
  documentId: string;
  documentVersionId: string;
  rank: number;
  lexicalRank?: number;
  semanticRank?: number;
  lexical: LexicalReference[];
  semantic: Omit<VectorCandidate, 'score'>[];
}
export interface SemanticDocumentCandidate {
  source: 'semantic';
  userId: string;
  documentId: string;
  documentVersionId: string;
  sourceRank: number;
  score: number;
  references: Omit<VectorCandidate, 'score'>[];
}
export interface RankedLeg {
  documentId: string;
  documentVersionId: string;
  sourceRank: number;
}
export const compareId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Collapse BEFORE assigning ranks: repeated chunks never contribute extra votes. */
export function rankSemantic(
  userId: string,
  hits: readonly VectorCandidate[],
): SemanticDocumentCandidate[] {
  const groups = new Map<string, VectorCandidate[]>();
  for (const hit of [...hits].sort(
    (a, b) => b.score - a.score || compareId(a.chunkId, b.chunkId),
  )) {
    const key = `${hit.documentId}:${hit.documentVersionId}`;
    const group = groups.get(key) ?? [];
    if (
      !group.some(
        (c) =>
          c.chunkId === hit.chunkId &&
          c.indexManifestId === hit.indexManifestId,
      )
    )
      group.push(hit);
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort(
      (a, b) =>
        b[0].score - a[0].score || compareId(a[0].documentId, b[0].documentId),
    )
    .slice(0, SEARCH_LEG_WINDOW)
    .map((group, index) => ({
      source: 'semantic',
      userId,
      documentId: group[0].documentId,
      documentVersionId: group[0].documentVersionId,
      sourceRank: index + 1,
      score: group[0].score,
      // Explicit allow-list: SQL SearchSource objects also carry canonical text at runtime.
      references: group.slice(0, 3).map((hit) => ({
        chunkId: hit.chunkId,
        indexManifestId: hit.indexManifestId,
        documentId: hit.documentId,
        documentVersionId: hit.documentVersionId,
        chunkSetId: hit.chunkSetId,
      })),
    }));
}

export function fuseDocuments(
  lexical: readonly (RankedLeg & { references: LexicalReference[] })[],
  semantic: readonly SemanticDocumentCandidate[],
): SearchWindowEntry[] {
  const groups = new Map<string, SearchWindowEntry>();
  for (const [leg, values] of [
    ['lexical', lexical],
    ['semantic', semantic],
  ] as const) {
    for (const candidate of values.slice(0, SEARCH_LEG_WINDOW)) {
      const key = `${candidate.documentId}:${candidate.documentVersionId}`;
      const row = groups.get(key) ?? {
        documentId: candidate.documentId,
        documentVersionId: candidate.documentVersionId,
        rank: 0,
        lexical: [],
        semantic: [],
      };
      const field = leg === 'lexical' ? 'lexicalRank' : 'semanticRank';
      // Defensive duplicate delivery must never add multiple votes.
      if (row[field] !== undefined) continue;
      row[field] = candidate.sourceRank;
      if (leg === 'lexical')
        row.lexical = (candidate as (typeof lexical)[number]).references.slice(
          0,
          3,
        );
      else
        row.semantic = (
          candidate as SemanticDocumentCandidate
        ).references.slice(0, 3);
      groups.set(key, row);
    }
  }
  const score = (e: SearchWindowEntry) =>
    (e.lexicalRank ? 1 / (60 + e.lexicalRank) : 0) +
    (e.semanticRank ? 1 / (60 + e.semanticRank) : 0);
  return [...groups.values()]
    .sort(
      (a, b) => score(b) - score(a) || compareId(a.documentId, b.documentId),
    )
    .slice(0, SEARCH_WINDOW_LIMIT)
    .map((entry, index) => ({ ...entry, rank: index + 1 }));
}
