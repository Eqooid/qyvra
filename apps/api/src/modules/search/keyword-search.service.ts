import {
  SearchSuggestionsDto,
  type SearchSuggestionDto,
  type SearchSuggestionsResponseDto,
} from './search-suggestions.dto';
import { canonicalHighlight, textSegments } from './safe-highlights';
import { lexicalSourceReference } from './search-evidence.dto';
import type { LexicalHighlightHint } from '../../infrastructure/search/lexical-store';
import {
  BadRequestException,
  ConflictException,
  GatewayTimeoutException,
  HttpException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ConfigurationService } from '../../configuration/configuration.module';
import { StructuredLogger } from '../../common/structured-logger';
import {
  LEXICAL_STORE,
  SearchStoreFailure,
  type LexicalHit,
  type LexicalStore,
} from '../../infrastructure/search/lexical-store';
import {
  recordId,
  recordValid,
  targetFromGeneration,
} from '../../infrastructure/search/search-index';
import {
  plainKeyword,
  KeywordSearchDto,
  type KeywordMatchDto,
  type KeywordResultDto,
  type KeywordSearchResponseDto,
} from './keyword-search.dto';
import {
  KeywordSearchRepository,
  type CanonicalKeywordHit,
  type LexicalReference,
} from './keyword-search.repository';

export function normalizeKeywordInput(
  input: KeywordSearchDto,
  allowCursor = false,
): KeywordSearchDto {
  const dto = plainToInstance(KeywordSearchDto, input);
  if (
    validateSync(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
    }).length
  )
    throw new BadRequestException();
  for (const prefix of ['date', 'expiration', 'created', 'updated'] as const) {
    const from = dto.filters?.[`${prefix}From`],
      to = dto.filters?.[`${prefix}To`];
    if (from && to && from > to) throw new BadRequestException();
  }
  if ((dto.query.match(/[\p{L}\p{N}]+/gu) ?? []).length > 64)
    throw new BadRequestException();
  if (dto.filters?.filename && !plainKeyword(dto.filters.filename))
    throw new BadRequestException();
  if (dto.cursor && !allowCursor)
    throw new ConflictException(
      'Restart search; continuation is reserved for T07.',
    );
  return dto;
}
/** Plain canonical text only. Offsets remain scalar positions; no highlight HTML is consumed. */
export function keywordSnippet(text: string, query: string, base = 0) {
  const scalars = Array.from(text),
    lower = text.toLowerCase();
  const term = (query.match(/[\p{L}\p{N}]+/gu) ?? [query])[0].toLowerCase();
  const position = lower.indexOf(term);
  let scalarPosition = 0,
    units = 0;
  if (position >= 0)
    for (const scalar of scalars) {
      if (units >= position) break;
      units += scalar.toLowerCase().length;
      scalarPosition++;
    }
  const start = Math.max(
    0,
    Math.min(scalarPosition - 80, scalars.length - 400),
  );
  const value = scalars.slice(start, start + 400).join('');
  return {
    snippet: value,
    startOffset: base + start,
    endOffset: base + start + Math.min(400, scalars.length - start),
  };
}
export function keywordMatch(
  source: CanonicalKeywordHit,
  query: string,
  mode: 'terms' | 'phrase',
  hints?: readonly LexicalHighlightHint[],
): KeywordMatchDto {
  if (source.kind === 'page') {
    if (
      source.excerpt === null ||
      source.pageNumber === null ||
      source.startOffset === null ||
      !source.extractedTextId
    )
      throw new SearchStoreFailure('SEARCH_CONTRACT_INVALID');
    const plain = keywordSnippet(source.excerpt, query, source.startOffset);
    const evidence = canonicalHighlight(
      source.excerpt,
      hints?.find((h) => h.field === 'text'),
      source.startOffset,
    );
    return {
      kind: 'page',
      ...plain,
      ...(evidence ?? {
        ranges: [],
        segments: textSegments(plain.snippet, []),
      }),
      field: 'text',
      segmentId: source.recordId,
      ...(Number.isInteger(source.segment)
        ? {
            source: lexicalSourceReference(
              source.documentId,
              source.documentVersionId,
              source.extractedTextId,
              source.pageNumber,
              source.segment!,
            ),
          }
        : {}),
      matchedFields: ['text'],
      pageNumber: source.pageNumber,
      extractedTextId: source.extractedTextId,
    };
  }
  const fields = [
    ['referenceNumber', source.referenceNumber],
    ['title', source.title],
    ['description', source.description],
    ['issuer', source.issuer],
    ['filename', source.originalFilename],
  ] as const;
  const matched = fields.filter(([field, value]) => {
    if (value === null) return false;
    if (
      field === 'referenceNumber' &&
      value.normalize('NFKC').trim().toLowerCase() ===
        query.normalize('NFKC').trim().toLowerCase()
    )
      return true;
    const tokens: string[] = value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [
      value.toLowerCase(),
    ];
    const queryTokens = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [
      query.toLowerCase(),
    ];
    return mode === 'phrase'
      ? tokens.some((_, i) =>
          queryTokens.every((word, j) => tokens[i + j] === word),
        )
      : queryTokens.every((word) => tokens.includes(word));
  });
  const enriched = fields.flatMap(([field, text]) => {
    if (text === null) return [];
    const evidence = canonicalHighlight(
      text,
      hints?.find((h) => h.field === field),
    );
    return evidence ? [{ field, evidence }] : [];
  })[0];
  const text = matched[0]?.[1] ?? source.title;
  const plain = keywordSnippet(text, query).snippet;
  return {
    kind: 'metadata',
    ...(enriched?.evidence ?? {
      snippet: plain,
      ranges: [],
      segments: textSegments(plain, []),
    }),
    field: enriched?.field ?? matched[0]?.[0] ?? 'title',
    matchedFields: matched.map(([key]) => key),
  };
}

export interface LexicalDocumentCandidate {
  source: 'lexical';
  userId: string;
  documentId: string;
  documentVersionId: string;
  sourceRank: number;
  score: number;
  result: KeywordResultDto;
  references: LexicalReference[];
}
export interface KeywordCandidateBatch {
  response: KeywordSearchResponseDto;
  generationId: string;
  candidates: LexicalDocumentCandidate[];
  highlights?: Map<string, LexicalHighlightHint[]>;
}
export function lexicalResult(
  s: CanonicalKeywordHit,
  matches: KeywordMatchDto[],
  rank: number,
): KeywordResultDto {
  return {
    documentId: s.documentId,
    documentVersionId: s.documentVersionId,
    projectionId: s.projectionId,
    versionNumber: s.versionNumber,
    title: s.title,
    originalFilename: s.originalFilename,
    mimeType: s.mimeType,
    documentType: s.documentType,
    status: s.status,
    categoryId: s.categoryId,
    tagIds: s.tagIds,
    ranking: 'lexical-bm25',
    rank,
    matches,
  };
}
@Injectable()
export class KeywordSearchService {
  private active = 0;
  private resetAt = 0;
  private total = 0;
  private readonly users = new Map<string, number>();
  constructor(
    private readonly repository: KeywordSearchRepository,
    private readonly config: ConfigurationService,
    @Inject(LEXICAL_STORE) private readonly store: LexicalStore,
    private readonly logger: StructuredLogger,
  ) {}
  async search(
    userId: string,
    input: KeywordSearchDto,
    parentSignal?: AbortSignal,
  ): Promise<KeywordSearchResponseDto> {
    return (await this.run(userId, input, parentSignal)).response;
  }
  /** Internal candidate budget; never accepted from an HTTP body. */
  candidates(userId: string, input: KeywordSearchDto, signal: AbortSignal) {
    return this.run(userId, input, signal, 100);
  }
  private async run(
    userId: string,
    input: KeywordSearchDto,
    parentSignal?: AbortSignal,
    budget?: number,
  ): Promise<KeywordCandidateBatch> {
    const dto = normalizeKeywordInput(input);
    return this.request(userId, parentSignal, (signal) =>
      this.execute(userId, dto, signal, budget),
    );
  }
  private async request<T>(
    userId: string,
    parentSignal: AbortSignal | undefined,
    execute: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const policy = this.config.keywordSearch;
    if (!policy.enabled) throw new ServiceUnavailableException();
    this.admit(userId);
    const controller = new AbortController(),
      cancel = () => controller.abort();
    parentSignal?.addEventListener('abort', cancel, { once: true });
    if (parentSignal?.aborted) cancel();
    let timer: NodeJS.Timeout | undefined;
    const work = execute(controller.signal).finally(() => {
      this.active--;
      parentSignal?.removeEventListener('abort', cancel);
    });
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new GatewayTimeoutException());
          }, policy.timeoutMs);
        }),
      ]);
    } catch (error) {
      this.logger.event('warn', 'search.keyword.failed', {
        category:
          error instanceof SearchStoreFailure ? error.code : 'SEARCH_FAILED',
      });
      if (error instanceof HttpException) throw error;
      if (error instanceof SearchStoreFailure) {
        if (error.code === 'SEARCH_TIMEOUT' || controller.signal.aborted)
          throw new GatewayTimeoutException();
        throw new ServiceUnavailableException();
      }
      // SQL authorization failures follow the existing safe 500 envelope; never become empty results.
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async suggestions(
    userId: string,
    input: SearchSuggestionsDto,
  ): Promise<SearchSuggestionsResponseDto> {
    const dto = plainToInstance(SearchSuggestionsDto, input);
    if (
      validateSync(dto, {
        whitelist: true,
        forbidNonWhitelisted: true,
        forbidUnknownValues: true,
      }).length
    )
      throw new BadRequestException();
    if (dto.prefix.length < 2 || dto.prefix.length > 200)
      throw new BadRequestException();
    const query = normalizeKeywordInput({
      query: dto.prefix,
      filters: dto.filters,
      documentIds: dto.documentIds,
    });
    if (!query.query.match(/[\p{L}\p{N}]/u)) throw new BadRequestException();
    return this.request(userId, undefined, async (signal) => {
      await this.repository.authorizeDocuments(userId, dto.documentIds);
      const generation = await this.repository.generation();
      if (
        !generation ||
        generation.fingerprint !==
          this.config.keywordSearch.generationFingerprint
      )
        throw new ServiceUnavailableException();
      const target = targetFromGeneration(
        this.config.elasticsearch.indexPrefix,
        generation,
      );
      const initial = await this.repository.scope(
        userId,
        generation.id,
        query,
        this.config.keywordSearch.maxScopes,
      );
      await this.store.availability(signal);
      const inspected = await this.store.inspect(target, 'metadata', signal);
      if (!inspected.exists || !inspected.compatible)
        throw new ServiceUnavailableException();
      const limit = Math.min(50, this.config.keywordSearch.rawHitLimit);
      const hits = initial.scopes.length
        ? await this.store.query(
            target,
            'metadata',
            {
              userId,
              scopes: initial.scopes,
              text: dto.prefix,
              mode: 'prefix',
              limit,
            },
            signal,
          )
        : [];
      if (
        hits.length > limit ||
        new Set(hits.map((h) => h.id)).size !== hits.length
      )
        throw new SearchStoreFailure('SEARCH_CONTRACT_INVALID');
      for (const h of hits) {
        recordValid(h.record, target);
        if (
          h.record.kind !== 'metadata' ||
          h.id !== recordId(h.record) ||
          !Number.isFinite(h.score)
        )
          throw new SearchStoreFailure('SEARCH_CONTRACT_INVALID');
      }
      const fresh = await this.repository.finalize(
        userId,
        generation.id,
        query,
        this.config.keywordSearch.maxScopes,
        hits,
      );
      signal.throwIfAborted();
      const suggestions: SearchSuggestionDto[] = [],
        seen = new Set<string>();
      const words = dto.prefix.toLowerCase().match(/[\p{L}\p{N}]+/gu)!;
      const prefixMatches = (value: string) => {
        const tokens: string[] =
          value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
        return (
          words.slice(0, -1).every((w) => tokens.includes(w)) &&
          tokens.some((t) => t.startsWith(words.at(-1)!))
        );
      };
      for (const h of hits) {
        const source = fresh.sources.find((s) => s.recordId === h.id);
        if (!source) continue;
        for (const [type, value] of [
          ['title', source.title],
          ['referenceNumber', source.referenceNumber],
          ['issuer', source.issuer],
        ] as const) {
          if (!value || !plainKeyword(value)) continue;
          let text = '';
          for (const scalar of value.trim()) {
            if (text.length + scalar.length > 200) break;
            text += scalar;
          }
          const key = text.normalize('NFKC').toLowerCase();
          if (!prefixMatches(text) || seen.has(key)) continue;
          seen.add(key);
          suggestions.push({
            text,
            type,
            documentId: source.documentId,
            documentVersionId: source.documentVersionId,
          });
          if (suggestions.length === (dto.limit ?? 5)) return { suggestions };
        }
      }
      return { suggestions };
    });
  }
  /** Optional continuation evidence, freshly owner-scoped, never cached or used to rerank. */
  async highlightHints(
    userId: string,
    input: KeywordSearchDto,
    generationId: string,
    references: readonly LexicalReference[],
    parent: AbortSignal,
  ): Promise<Map<string, LexicalHighlightHint[]>> {
    const generation = await this.repository.generation();
    if (generation?.id !== generationId) return new Map(); // Final page snapshot determines restart behavior.
    const authorized = await this.repository.finalize(
      userId,
      generationId,
      input,
      this.config.keywordSearch.maxScopes,
      references,
    );
    const allowed = new Set(authorized.sources.map((s) => s.recordId));
    const target = targetFromGeneration(
        this.config.elasticsearch.indexPrefix,
        generation,
      ),
      hints = new Map<string, LexicalHighlightHint[]>();
    const signal = AbortSignal.any([
      parent,
      AbortSignal.timeout(Math.min(1000, this.config.elasticsearch.timeoutMs)),
    ]);
    try {
      for (const kind of ['metadata', 'pages'] as const) {
        const refs = references.filter(
          (r) =>
            allowed.has(r.id) &&
            (r.record.kind === 'metadata') === (kind === 'metadata'),
        );
        if (!refs.length) continue;
        const scopes = authorized.scopes.filter((s) =>
          refs.some((r) => r.record.projectionId === s.projectionId),
        );
        const hits = await this.store.query(
          target,
          kind,
          {
            userId,
            scopes,
            text: input.query,
            mode: input.match ?? 'terms',
            recordIds: refs.map((r) => r.id),
            limit: refs.length,
          },
          signal,
        );
        for (const h of hits)
          if (allowed.has(h.id)) hints.set(h.id, h.highlights ?? []);
      }
    } catch (error) {
      if (!(error instanceof SearchStoreFailure) && !signal.aborted)
        throw error;
      this.logger.event('warn', 'search.highlights.omitted', {
        category: 'OPTIONAL_HINTS_UNAVAILABLE',
      });
      return new Map();
    }
    return hints;
  }
  private admit(userId: string) {
    const p = this.config.keywordSearch;
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
    input: KeywordSearchDto,
    signal: AbortSignal,
    budget?: number,
  ): Promise<KeywordCandidateBatch> {
    const policy = this.config.keywordSearch,
      limit = budget ?? input.limit ?? 10;
    await this.repository.authorizeDocuments(userId, input.documentIds);
    const generation = await this.repository.generation();
    if (!generation || generation.fingerprint !== policy.generationFingerprint)
      throw new ServiceUnavailableException();
    const target = targetFromGeneration(
      this.config.elasticsearch.indexPrefix,
      generation,
    );
    const initial = await this.repository.scope(
      userId,
      generation.id,
      input,
      policy.maxScopes,
    );
    await this.store.availability(signal);
    for (const kind of ['metadata', 'pages'] as const) {
      const index = await this.store.inspect(target, kind, signal);
      if (!index.exists || !index.compatible)
        throw new ServiceUnavailableException();
    }
    if (signal.aborted) throw new GatewayTimeoutException();
    const hits: LexicalHit[] = [];
    const seen = new Set<string>();
    // Full internal page sources can reach 32 KiB of UTF-8 text plus envelope fields.
    // Respect the existing transport response budget before requesting candidates.
    const pageLimit = Math.min(
      policy.rawHitLimit,
      Math.max(
        1,
        Math.floor((this.config.elasticsearch.maxResponseBytes - 4096) / 40000),
      ),
    );
    for (const kind of ['metadata', 'pages'] as const) {
      const scopes =
        kind === 'metadata'
          ? initial.scopes
          : initial.scopes.filter((s) => s.textCoverage === 'READY');
      if (!scopes.length) continue;
      const found = await this.store.query(
        target,
        kind,
        {
          userId,
          scopes,
          text: input.query,
          mode: input.match ?? 'terms',
          limit: kind === 'pages' ? pageLimit : policy.rawHitLimit,
        },
        signal,
      );
      if (found.length > (kind === 'pages' ? pageLimit : policy.rawHitLimit))
        throw new SearchStoreFailure('SEARCH_CONTRACT_INVALID');
      for (const hit of found) {
        recordValid(hit.record, target);
        if (
          seen.has(hit.id) ||
          (hit.record.kind === 'metadata') !== (kind === 'metadata')
        )
          throw new SearchStoreFailure('SEARCH_CONTRACT_INVALID');
        seen.add(hit.id);
        if (
          recordId(hit.record) !== hit.id ||
          !Number.isFinite(hit.score) ||
          hit.score < 0
        )
          throw new SearchStoreFailure('SEARCH_CONTRACT_INVALID');
        // SQL remains the final authority even if a transport or stale index returns a foreign tuple.
        if (
          hit.record.userId !== userId ||
          !scopes.some(
            (s) =>
              s.projectionId === hit.record.projectionId &&
              s.documentId === hit.record.documentId &&
              s.documentVersionId === hit.record.documentVersionId &&
              s.revision === hit.record.revision,
          )
        )
          continue;
        hits.push(hit);
      }
    }
    const final = await this.repository.finalize(
      userId,
      generation.id,
      input,
      policy.maxScopes,
      hits,
    );
    if (signal.aborted) throw new GatewayTimeoutException();
    const scores = new Map(hits.map((h) => [h.id, h.score])),
      groups = new Map<
        string,
        {
          source: CanonicalKeywordHit;
          score: number;
          matches: KeywordMatchDto[];
        }
      >();
    // Consume only SQL-returned canonical content. Unverified hit metadata/text never enter the response.
    const ranked = final.sources
      .map((source) => ({ source, score: scores.get(source.recordId) ?? -1 }))
      .filter((row) => row.score >= 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          (a.source.recordId < b.source.recordId
            ? -1
            : a.source.recordId > b.source.recordId
              ? 1
              : 0),
      );
    for (const row of ranked) {
      const existing = groups.get(row.source.documentId);
      if (existing) {
        if (existing.matches.length < 3)
          existing.matches.push(
            keywordMatch(
              row.source,
              input.query,
              input.match ?? 'terms',
              hits.find((h) => h.id === row.source.recordId)?.highlights,
            ),
          );
      } else
        groups.set(row.source.documentId, {
          ...row,
          matches: [
            keywordMatch(
              row.source,
              input.query,
              input.match ?? 'terms',
              hits.find((h) => h.id === row.source.recordId)?.highlights,
            ),
          ],
        });
    }
    const results: KeywordResultDto[] = [...groups.values()]
      .sort(
        (a, b) =>
          b.score - a.score ||
          (a.source.documentId < b.source.documentId
            ? -1
            : a.source.documentId > b.source.documentId
              ? 1
              : 0),
      )
      .slice(0, limit)
      .map(({ source: s, matches }, ordinal) =>
        lexicalResult(s, matches, ordinal + 1),
      );
    const candidates: LexicalDocumentCandidate[] = results.map((result) => ({
      source: 'lexical',
      userId,
      documentId: result.documentId,
      documentVersionId: result.documentVersionId,
      sourceRank: result.rank,
      score: groups.get(result.documentId)!.score,
      result,
      references: ranked
        .filter((r) => r.source.documentId === result.documentId)
        .slice(0, 3)
        .map(({ source }) => {
          const h = hits.find((h) => h.id === source.recordId)!;
          const r = h.record;
          return {
            id: h.id,
            record: {
              projectionId: r.projectionId,
              documentId: r.documentId,
              documentVersionId: r.documentVersionId,
              revision: r.revision,
              sourceHash: r.sourceHash,
              kind: r.kind,
              ...(r.kind === 'page'
                ? {
                    pageNumber: r.pageNumber,
                    segment: r.segment,
                    startOffset: r.startOffset,
                    endOffset: r.endOffset,
                  }
                : {}),
            },
          };
        }),
    }));
    const authorizedHits = new Set(final.sources.map((s) => s.recordId));
    const saturated = ['metadata', 'page'].some(
      (kind) =>
        hits.filter((h) => h.record.kind === kind && authorizedHits.has(h.id))
          .length >= (kind === 'page' ? pageLimit : policy.rawHitLimit),
    );
    return {
      generationId: generation.id,
      candidates,
      highlights: new Map(hits.map((h) => [h.id, h.highlights ?? []])),
      response: {
        results,
        coverage: final.coverage,
        pagination: {
          nextCursor: null,
          hasMore: groups.size > limit,
          paginationAvailable: false,
          truncated:
            saturated ||
            groups.size > limit ||
            initial.scopes
              .map((s) => s.projectionId)
              .sort()
              .join(',') !==
              final.scopes
                .map((s) => s.projectionId)
                .sort()
                .join(','),
        },
      },
    };
  }
}
