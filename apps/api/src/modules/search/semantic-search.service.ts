import {
  BadRequestException,
  GatewayTimeoutException,
  HttpException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { embeddingProfileFingerprint } from '@qyvra/database';
import { ConfigurationService } from '../../configuration/configuration.module';
import { StructuredLogger } from '../../common/structured-logger';
import {
  EmbeddingFailure,
  validateEmbeddingResults,
  type EmbeddingProvider,
} from '../ai/embedding-provider';
import { VectorStoreFailure, type VectorSearchStore } from '../ai/vector-store';
import {
  SemanticSearchRepository,
  type SearchSource,
} from './semantic-search.repository';

export type SemanticSearchResult = SearchSource & { score: number };

export const QUERY_EMBEDDINGS = Symbol('QUERY_EMBEDDINGS');
export const SEMANTIC_VECTORS = Symbol('SEMANTIC_VECTORS');
export interface SemanticSearchInput {
  query: string;
  limit?: number;
  documentIds?: string[];
}

@Injectable()
export class SemanticSearchService {
  private active = 0;
  private resetAt = 0;
  private total = 0;
  private readonly users = new Map<string, number>();
  constructor(
    private readonly repository: SemanticSearchRepository,
    private readonly configuration: ConfigurationService,
    @Inject(QUERY_EMBEDDINGS) private readonly embeddings: EmbeddingProvider,
    @Inject(SEMANTIC_VECTORS) private readonly vectors: VectorSearchStore,
    private readonly logger: StructuredLogger,
  ) {}

  async search(
    userId: string,
    input: SemanticSearchInput,
    parentSignal?: AbortSignal,
  ) {
    const query = typeof input.query === 'string' ? input.query.trim() : '';
    const limit = input.limit ?? 8;
    if (
      !query ||
      query.length > 4000 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 20
    )
      throw new BadRequestException();
    const policy = this.configuration.semanticSearch;
    if (!policy.enabled) throw new ServiceUnavailableException();
    this.admit(userId);
    const started = performance.now();
    const abort = new AbortController();
    const cancel = () => abort.abort();
    parentSignal?.addEventListener('abort', cancel, { once: true });
    if (parentSignal?.aborted) abort.abort();
    let timer: NodeJS.Timeout | undefined;
    const work = this.execute(
      userId,
      { ...input, query, limit },
      abort.signal,
    ).finally(() => {
      this.active--;
      parentSignal?.removeEventListener('abort', cancel);
    });
    try {
      const result = await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            abort.abort();
            reject(new GatewayTimeoutException());
          }, policy.timeoutMs);
        }),
      ]);
      this.logger.event('info', 'ai.semantic_search.completed', {
        inputLength: query.length,
        resultCount: result.length,
        durationMs: Math.round(performance.now() - started),
      });
      return { results: result };
    } catch (error) {
      const category =
        error instanceof EmbeddingFailure || error instanceof VectorStoreFailure
          ? error.code
          : 'SEARCH_FAILED';
      this.logger.event('warn', 'ai.semantic_search.failed', {
        category,
        inputLength: query.length,
        durationMs: Math.round(performance.now() - started),
      });
      if (error instanceof HttpException) throw error;
      if (
        error instanceof EmbeddingFailure &&
        error.code === 'EMBEDDING_RATE_LIMITED'
      )
        throw new HttpException('Too Many Requests', 429);
      if (
        error instanceof EmbeddingFailure &&
        error.code === 'EMBEDDING_INPUT_LIMIT'
      )
        throw new BadRequestException();
      if (
        error instanceof EmbeddingFailure &&
        error.code === 'EMBEDDING_TIMEOUT'
      )
        throw new GatewayTimeoutException();
      throw new ServiceUnavailableException();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  /** Intentional public boundary: SQL reauthorizes the exact retrieved tuples, never remote payloads. */
  async revalidate(userId: string, sources: readonly SemanticSearchResult[]) {
    if (!sources.length) return [];
    const profile = await this.repository.profile();
    if (
      !profile ||
      profile.fingerprint !== this.configuration.embedding.profileFingerprint
    )
      throw new ServiceUnavailableException();
    const fresh = await this.repository.hydrate(userId, profile.id, [
      ...sources,
    ]);
    return sources.flatMap((s) => {
      const match = fresh.find(
        (f) =>
          f.chunkId === s.chunkId &&
          f.indexManifestId === s.indexManifestId &&
          f.documentId === s.documentId &&
          f.documentVersionId === s.documentVersionId &&
          f.chunkSetId === s.chunkSetId &&
          f.excerptHash === s.excerptHash &&
          f.excerpt === s.excerpt,
      );
      return match ? [{ ...match, score: s.score }] : [];
    });
  }
  private admit(userId: string) {
    const p = this.configuration.semanticSearch;
    if (Date.now() >= this.resetAt) {
      this.resetAt = Date.now() + 60000;
      this.total = 0;
      this.users.clear();
    }
    const count = this.users.get(userId) ?? 0;
    if (
      this.active >= p.concurrency ||
      this.total >= p.globalPerMinute ||
      count >= p.perUserPerMinute
    )
      throw new HttpException('Too Many Requests', 429);
    this.active++;
    this.total++;
    this.users.set(userId, count + 1);
  }
  private async execute(
    userId: string,
    input: SemanticSearchInput,
    signal: AbortSignal,
  ) {
    await this.repository.authorizeDocuments(userId, input.documentIds);
    const stored = await this.repository.profile();
    if (
      !stored ||
      stored.fingerprint !== this.configuration.embedding.profileFingerprint ||
      stored.distance !== 'Cosine'
    )
      throw new ServiceUnavailableException();
    const profile = { ...stored, distance: 'Cosine' as const };
    if (embeddingProfileFingerprint(profile) !== stored.fingerprint)
      throw new ServiceUnavailableException();
    const scope = await this.repository.scope(
      userId,
      profile.id,
      this.configuration.semanticSearch.maxManifests,
      input.documentIds,
    );
    if (!scope.length) return [];
    signal.throwIfAborted();
    const inputs = [{ id: 'query', text: input.query }];
    const embeddingStarted = performance.now();
    const output = validateEmbeddingResults(
      inputs,
      await this.embeddings.embed({
        profile,
        inputs,
        purpose: 'query',
        signal,
      }),
      profile.dimensions,
    );
    signal.throwIfAborted();
    const embeddingDurationMs = Math.round(
      performance.now() - embeddingStarted,
    );
    // Revoke any scope archived or replaced while the query provider was running.
    const fresh = await this.repository.scope(
      userId,
      profile.id,
      this.configuration.semanticSearch.maxManifests,
      input.documentIds,
    );
    const manifests = fresh.filter((id) => scope.includes(id));
    if (!manifests.length) return [];
    const vectorStarted = performance.now();
    const candidates = await this.vectors.search({
      userId,
      embeddingProfileId: profile.id,
      embeddingProfileVersion: profile.profileVersion,
      dimensions: profile.dimensions,
      manifestIds: manifests,
      vector: [...output[0].vector],
      limit: Math.min(100, (input.limit ?? 8) * 5),
      minScore: this.configuration.semanticSearch.minScore,
    });
    signal.throwIfAborted();
    this.logger.event('info', 'ai.semantic_search.candidates', {
      provider: profile.provider,
      model: profile.model,
      embeddingProfileId: profile.id,
      profileVersion: profile.profileVersion,
      fingerprint: profile.fingerprint,
      scopeCount: manifests.length,
      candidateCount: candidates.length,
      embeddingDurationMs,
      vectorDurationMs: Math.round(performance.now() - vectorStarted),
    });
    const valid = candidates.filter(
      (c) =>
        Number.isFinite(c.score) &&
        manifests.includes(c.indexManifestId) &&
        (this.configuration.semanticSearch.minScore === undefined ||
          c.score >= this.configuration.semanticSearch.minScore),
    );
    valid.sort(
      (a, b) =>
        b.score - a.score ||
        a.chunkId.localeCompare(b.chunkId) ||
        a.indexManifestId.localeCompare(b.indexManifestId),
    );
    const sources = await this.repository.hydrate(
      userId,
      profile.id,
      valid.slice(0, 100),
    );
    signal.throwIfAborted();
    const seen = new Set<string>();
    return valid
      .flatMap((candidate) => {
        const source = sources.find(
          (s) =>
            s.chunkId === candidate.chunkId &&
            s.indexManifestId === candidate.indexManifestId &&
            s.documentId === candidate.documentId &&
            s.documentVersionId === candidate.documentVersionId &&
            s.chunkSetId === candidate.chunkSetId,
        );
        if (!source || seen.has(source.chunkId)) return [];
        seen.add(source.chunkId);
        return [{ ...source, score: candidate.score }];
      })
      .slice(0, input.limit ?? 8);
  }
}
