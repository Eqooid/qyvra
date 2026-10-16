import type { LexicalHighlightHint } from '../../infrastructure/search/lexical-store';
import {
  BadRequestException,
  ConflictException,
  GatewayTimeoutException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { ConfigurationService } from '../../configuration/configuration.module';
import { StructuredLogger } from '../../common/structured-logger';
import {
  SearchWindowStore,
  WINDOW_TTL_SECONDS,
  type SearchWindow,
} from '../../infrastructure/search/search-window.store';
import { SearchStoreFailure } from '../../infrastructure/search/lexical-store';
import { EmbeddingFailure } from '../ai/embedding-provider';
import { VectorStoreFailure } from '../ai/vector-store';
import { KeywordSearchRepository } from './keyword-search.repository';
import { SemanticSearchRepository } from './semantic-search.repository';
import { SemanticSearchService } from './semantic-search.service';
import {
  KeywordSearchService,
  keywordMatch,
  keywordSnippet,
  lexicalResult,
  normalizeKeywordInput,
} from './keyword-search.service';
import {
  KeywordSearchDto,
  KeywordSearchResponseDto,
  KeywordResultDto,
} from './keyword-search.dto';
import { HybridResultDto, HybridSearchResponseDto } from './hybrid-search.dto';
import {
  fuseDocuments,
  rankSemantic,
  SEARCH_RANKING_VERSION,
  type SearchMode,
  type SearchWindowEntry,
} from './search-ranking';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
/** Canonical input binds defaults, filter sets, page size, mode, budgets and current transport caps. */
export function searchInputDigest(
  input: KeywordSearchDto,
  mode: SearchMode,
  budgetIdentity: string,
) {
  const normalized = {
    query: input.query,
    match: input.match ?? 'terms',
    limit: input.limit ?? 10,
    sort: 'relevance',
    documentIds: input.documentIds ? [...input.documentIds].sort() : null,
    filters: Object.fromEntries(
      Object.entries(input.filters ?? {})
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => [k, k === 'tagIds' ? [...(v as string[])].sort() : v]),
    ),
    mode,
    budgetIdentity,
    ranking: SEARCH_RANKING_VERSION,
  };
  return hash(JSON.stringify(normalized));
}
export function windowCursor(id: string, offset: number, window: SearchWindow) {
  const mac = createHmac('sha256', window.nonce)
    .update(
      `${id}:${offset}:${window.digest}:${window.owner}:${window.session}`,
    )
    .digest('base64url');
  return `${id}_${offset}_${mac}`;
}
export function parseWindowCursor(cursor: string) {
  const parts = /^([A-Za-z0-9_-]{22})_([0-9]{1,3})_([A-Za-z0-9_-]{43})$/.exec(
    cursor,
  );
  if (!parts) throw new BadRequestException();
  return { id: parts[1], offset: Number(parts[2]) };
}
type VisibleResult = KeywordResultDto | HybridResultDto;

@Injectable()
export class HybridSearchService {
  private active = 0;
  private resetAt = 0;
  private total = 0;
  private readonly users = new Map<string, number>();
  constructor(
    private readonly keyword: KeywordSearchService,
    private readonly semantic: SemanticSearchService,
    private readonly lexicalRepository: KeywordSearchRepository,
    private readonly semanticRepository: SemanticSearchRepository,
    private readonly windows: SearchWindowStore,
    private readonly config: ConfigurationService,
    private readonly logger: StructuredLogger,
  ) {}

  keywordSearch(
    userId: string,
    sessionId: string,
    input: KeywordSearchDto,
  ): Promise<KeywordSearchResponseDto> {
    return this.search(
      'keyword',
      userId,
      sessionId,
      input,
    ) as Promise<KeywordSearchResponseDto>;
  }
  hybridSearch(
    userId: string,
    sessionId: string,
    input: KeywordSearchDto,
  ): Promise<HybridSearchResponseDto> {
    return this.search(
      'hybrid',
      userId,
      sessionId,
      input,
    ) as Promise<HybridSearchResponseDto>;
  }
  private admit(owner: string) {
    const p = this.config.keywordSearch;
    if (Date.now() >= this.resetAt) {
      this.resetAt = Date.now() + 60000;
      this.total = 0;
      this.users.clear();
    }
    const n = this.users.get(owner) ?? 0;
    if (
      this.active >= p.concurrency ||
      n >= p.perUserPerMinute ||
      this.total >= p.globalPerMinute
    )
      throw new HttpException('Too Many Requests', 429);
    this.active++;
    this.total++;
    this.users.set(owner, n + 1);
  }
  private async search(
    mode: SearchMode,
    userId: string,
    sessionId: string,
    input: KeywordSearchDto,
  ) {
    const dto = normalizeKeywordInput(input, true);
    if (
      !this.config.keywordSearch.enabled ||
      (mode === 'hybrid' && !this.config.hybridSearch.enabled)
    )
      throw new ServiceUnavailableException();
    this.admit(userId);
    const started = performance.now(),
      abort = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const work = this.execute(
      mode,
      userId,
      sessionId,
      dto,
      abort.signal,
    ).finally(() => {
      this.active--;
    });
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => {
              abort.abort();
              reject(new GatewayTimeoutException());
            },
            mode === 'hybrid'
              ? Math.max(
                  this.config.semanticSearch.timeoutMs,
                  this.config.keywordSearch.timeoutMs,
                )
              : this.config.keywordSearch.timeoutMs,
          );
        }),
      ]);
    } catch (error) {
      this.logger.event('warn', 'search.window.failed', {
        mode,
        category:
          error instanceof EmbeddingFailure ||
          error instanceof VectorStoreFailure ||
          error instanceof SearchStoreFailure
            ? error.code
            : 'SEARCH_FAILED',
        durationMs: Math.round(performance.now() - started),
      });
      if (error instanceof HttpException) throw error;
      if (
        error instanceof EmbeddingFailure &&
        error.code === 'EMBEDDING_INPUT_LIMIT'
      )
        throw new BadRequestException();
      if (
        error instanceof EmbeddingFailure &&
        error.code === 'EMBEDDING_RATE_LIMITED'
      )
        throw new HttpException('Too Many Requests', 429);
      if (
        abort.signal.aborted ||
        (error instanceof EmbeddingFailure &&
          error.code === 'EMBEDDING_TIMEOUT')
      )
        throw new GatewayTimeoutException();
      if (
        error instanceof EmbeddingFailure ||
        error instanceof VectorStoreFailure ||
        error instanceof SearchStoreFailure
      )
        throw new ServiceUnavailableException();
      throw error; // PostgreSQL errors follow the centralized safe 500 mapping.
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  private async execute(
    mode: SearchMode,
    owner: string,
    sessionId: string,
    input: KeywordSearchDto,
    signal: AbortSignal,
  ) {
    const budget = JSON.stringify([
      100,
      200,
      this.config.keywordSearch.maxScopes,
      this.config.keywordSearch.rawHitLimit,
      this.config.elasticsearch.maxResponseBytes,
      this.config.keywordSearch.generationFingerprint,
      mode === 'hybrid' ? this.config.embedding.profileFingerprint : null,
      mode === 'hybrid' ? this.config.semanticSearch.minScore : null,
    ]);
    const digest = searchInputDigest(input, mode, budget),
      session = hash(sessionId);
    const query = { ...input, cursor: undefined };
    let highlights: Map<string, LexicalHighlightHint[]> | undefined;
    let window: SearchWindow,
      id: string,
      offset = 0;
    if (input.cursor) {
      const parsed = parseWindowCursor(input.cursor);
      id = parsed.id;
      offset = parsed.offset;
      let stored: SearchWindow | null;
      try {
        stored = await this.windows.read(id);
      } catch {
        throw new ServiceUnavailableException();
      }
      if (
        !stored ||
        stored.version !== SEARCH_RANKING_VERSION ||
        stored.owner !== owner ||
        stored.session !== session ||
        stored.digest !== digest ||
        stored.mode !== mode ||
        stored.expires <= Date.now()
      )
        throw new ConflictException('Restart search.');
      window = stored;
      const expected = Buffer.from(windowCursor(id, offset, window));
      const supplied = Buffer.from(input.cursor);
      if (
        expected.length !== supplied.length ||
        !timingSafeEqual(expected, supplied) ||
        offset < 1 ||
        offset >= window.entries.length ||
        offset % window.limit !== 0
      )
        throw new ConflictException('Restart search.');
    } else {
      await this.lexicalRepository.authorizeDocuments(owner, input.documentIds);
      const documents =
        mode === 'hybrid'
          ? await this.lexicalRepository.filteredDocuments(
              owner,
              query,
              this.config.keywordSearch.maxScopes,
            )
          : [];
      const lexicalStarted = performance.now();
      let lexicalDurationMs = 0;
      const lexicalPromise = this.keyword
        .candidates(owner, query, signal)
        .then((r) => {
          lexicalDurationMs = Math.round(performance.now() - lexicalStarted);
          return r;
        });
      const semanticStarted = performance.now();
      const semanticPromise =
        mode === 'hybrid'
          ? this.semantic.candidates(
              owner,
              input.query,
              documents.map((d) => d.documentId),
              signal,
            )
          : Promise.resolve(null);
      const legs = await Promise.allSettled([lexicalPromise, semanticPromise]);
      if (legs[0].status === 'rejected') throw legs[0].reason;
      if (legs[1].status === 'rejected') throw legs[1].reason;
      const lexical = legs[0].value,
        semantic = legs[1].value;
      highlights = lexical.highlights;
      signal.throwIfAborted();
      const semanticLeg = semantic ? rankSemantic(owner, semantic.results) : [];
      const fusionStarted = performance.now();
      const entries =
        mode === 'hybrid'
          ? fuseDocuments(lexical.candidates, semanticLeg)
          : lexical.candidates.map((c) => ({
              documentId: c.documentId,
              documentVersionId: c.documentVersionId,
              rank: c.sourceRank,
              lexicalRank: c.sourceRank,
              lexical: c.references,
              semantic: [],
            }));
      window = {
        version: SEARCH_RANKING_VERSION,
        owner,
        session,
        digest,
        mode,
        generationId: lexical.generationId,
        profileId: semantic?.profileId,
        profileFingerprint: semantic?.profileFingerprint,
        expires: Date.now() + WINDOW_TTL_SECONDS * 1000,
        nonce: randomBytes(32).toString('base64url'),
        limit: input.limit ?? 10,
        truncated:
          lexical.response.pagination.truncated || !!semantic?.truncated,
        entries,
      };
      id = randomBytes(16).toString('base64url');
      this.logger.event('info', 'search.candidates.completed', {
        mode,
        lexicalDocuments: lexical.candidates.length,
        semanticDocuments: semanticLeg.length,
        lexicalDurationMs,
        fusionDurationMs: Math.round(performance.now() - fusionStarted),
        retrievalDurationMs: Math.round(performance.now() - semanticStarted),
      });
    }
    if (input.cursor)
      highlights = await this.keyword.highlightHints(
        owner,
        query,
        window.generationId,
        window.entries
          .slice(offset, offset + window.limit)
          .flatMap((e) => e.lexical),
        signal,
      );
    const authorizationStarted = performance.now();
    const hydrated = await this.hydrate(window, query, highlights);
    const authorizationDurationMs = Math.round(
      performance.now() - authorizationStarted,
    );
    signal.throwIfAborted();
    // Remove revoked references before storing the FIRST window; never cache authorization decisions.
    if (!input.cursor) {
      const lex = hydrated.entries
        .filter((e) => e.lexical.length)
        .sort((a, b) => (a.lexicalRank ?? 0) - (b.lexicalRank ?? 0))
        .map((e, i) => ({
          documentId: e.documentId,
          documentVersionId: e.documentVersionId,
          sourceRank: i + 1,
          references: e.lexical,
        }));
      const sem = hydrated.entries
        .filter((e) => e.semantic.length)
        .sort((a, b) => (a.semanticRank ?? 0) - (b.semanticRank ?? 0))
        .map((e, i) => ({
          source: 'semantic' as const,
          userId: owner,
          documentId: e.documentId,
          documentVersionId: e.documentVersionId,
          sourceRank: i + 1,
          score: 0,
          references: e.semantic,
        }));
      window.entries =
        mode === 'hybrid'
          ? fuseDocuments(lex, sem)
          : lex.map((e) => ({
              documentId: e.documentId,
              documentVersionId: e.documentVersionId,
              rank: e.sourceRank,
              lexicalRank: e.sourceRank,
              lexical: e.references,
              semantic: [],
            }));
    }
    const slots = window.entries.slice(offset, offset + window.limit);
    const results = slots.flatMap((e) => {
      const r = hydrated.results.get(e.documentId);
      return r ? [{ ...r, rank: e.rank }] : [];
    });
    const hasMore = window.entries
      .slice(offset + window.limit)
      .some((e) => hydrated.results.has(e.documentId));
    let paginationAvailable = true;
    if (!input.cursor && hasMore) {
      try {
        paginationAvailable = await this.windows.save(id, window);
      } catch {
        paginationAvailable = false;
      }
      if (!paginationAvailable)
        this.logger.event('warn', 'search.window.unpaginated', { mode });
    }
    this.logger.event('info', 'search.page.completed', {
      mode,
      resultCount: results.length,
      authorizationDurationMs,
      continuation: !!input.cursor,
      paginationAvailable,
    });
    return {
      ...(mode === 'hybrid' ? { mode } : {}),
      results,
      coverage: hydrated.coverage,
      pagination: {
        nextCursor:
          hasMore && paginationAvailable
            ? windowCursor(id, offset + window.limit, window)
            : null,
        hasMore,
        paginationAvailable,
        truncated: window.truncated || (!paginationAvailable && hasMore),
      },
    };
  }
  private hydrate(
    window: SearchWindow,
    input: KeywordSearchDto,
    highlights?: Map<string, LexicalHighlightHint[]>,
  ) {
    return this.lexicalRepository.snapshot(async (tx) => {
      if (window.profileId) {
        const profile = await this.semanticRepository.profile(tx);
        if (
          profile?.id !== window.profileId ||
          profile.fingerprint !== window.profileFingerprint ||
          profile.fingerprint !== this.config.embedding.profileFingerprint
        )
          throw new ConflictException('Restart search.');
      }
      const documents =
        window.mode === 'hybrid'
          ? await this.lexicalRepository.filteredDocuments(
              window.owner,
              input,
              this.config.keywordSearch.maxScopes,
              tx,
            )
          : [];
      const lexical = await this.lexicalRepository.finalize(
        window.owner,
        window.generationId,
        input,
        this.config.keywordSearch.maxScopes,
        window.entries.flatMap((e) => e.lexical),
        tx,
      );
      const semantic = window.profileId
        ? await this.semanticRepository.hydrate(
            window.owner,
            window.profileId,
            window.entries.flatMap((e) =>
              e.semantic.map((r) => ({ ...r, score: 0 })),
            ),
            tx,
          )
        : [];
      const results = new Map<string, VisibleResult>();
      const entries: SearchWindowEntry[] = [];
      for (const entry of window.entries) {
        const doc = documents.find(
          (d) =>
            d.documentId === entry.documentId &&
            d.documentVersionId === entry.documentVersionId,
        );
        if (window.mode === 'hybrid' && !doc) continue;
        const lex = entry.lexical.flatMap((r) => {
          const found = lexical.sources.find((s) => s.recordId === r.id);
          return found ? [found] : [];
        });
        const sem = entry.semantic.flatMap((r) => {
          const found = semantic.find(
            (s) =>
              s.chunkId === r.chunkId &&
              s.indexManifestId === r.indexManifestId &&
              s.documentId === entry.documentId &&
              s.documentVersionId === entry.documentVersionId,
          );
          return found ? [found] : [];
        });
        if (!lex.length && !sem.length) continue;
        entries.push({
          ...entry,
          lexical: entry.lexical.filter((r) =>
            lex.some((s) => s.recordId === r.id),
          ),
          semantic: entry.semantic.filter((r) =>
            sem.some(
              (s) =>
                s.chunkId === r.chunkId &&
                s.indexManifestId === r.indexManifestId,
            ),
          ),
        });
        const lexicalMatches = lex.map((s) =>
          keywordMatch(
            s,
            input.query,
            input.match ?? 'terms',
            highlights?.get(s.recordId),
          ),
        );
        if (window.mode === 'keyword') {
          if (lex.length)
            results.set(
              entry.documentId,
              lexicalResult(lex[0], lexicalMatches, entry.rank),
            );
          continue;
        }
        if (!doc) continue;
        const semanticMatches = sem.map((s) => ({
          kind: 'chunk' as const,
          ...keywordSnippet(s.excerpt, input.query, s.startOffset),
          chunkId: s.chunkId,
          chunkSetId: s.chunkSetId,
          indexManifestId: s.indexManifestId,
          embeddingProfileId: s.embeddingProfileId,
        }));
        // Retain at least one representative of each available leg.
        const matches =
          lexicalMatches.length && semanticMatches.length
            ? [
                lexicalMatches[0],
                semanticMatches[0],
                ...lexicalMatches.slice(1),
                ...semanticMatches.slice(1),
              ]
            : [...lexicalMatches, ...semanticMatches];
        results.set(doc.documentId, {
          ...doc,
          projectionId: lex[0]?.projectionId,
          ranking: SEARCH_RANKING_VERSION,
          rank: entry.rank,
          matches: matches.slice(0, 3),
        });
      }
      return { results, entries, coverage: lexical.coverage };
    });
  }
}
