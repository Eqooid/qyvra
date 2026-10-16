import { randomBytes } from 'node:crypto';
import { decodeHighlight, HIGHLIGHT_FIELDS } from './highlight-hints';
import { X509Certificate } from 'node:crypto';
import { canonicalJson } from '../extraction/pdf-extraction';
import { Client, estypes } from '@elastic/elasticsearch';
import { readFileSync, statSync } from 'node:fs';
import { ApiConfiguration } from '../../configuration/settings';
import {
  LexicalStore,
  LexicalQuery,
  LexicalHit,
  SearchGenerationTarget,
  SearchIndexKind,
  SearchProjectionScope,
  SearchRecord,
  SearchStoreFailure,
} from './lexical-store';
import {
  contract,
  indexDefinition,
  indexName,
  positive,
  recordId,
  searchRecordSource,
  recordValid,
  scopeValid,
  targetValid,
  uuid,
} from './search-index';

type Settings = ApiConfiguration['elasticsearch'];
function file(path: string, max: number): string {
  try {
    if (!statSync(path).isFile() || statSync(path).size > max) contract();
    const value = readFileSync(path, 'utf8').trim();
    if (!value || value.includes('\u0000')) contract();
    return value;
  } catch {
    throw new SearchStoreFailure('SEARCH_CONTRACT_INVALID');
  }
}
export function normalizeSearchError(error: unknown): SearchStoreFailure {
  if (error instanceof SearchStoreFailure) return error;
  const e = error as {
    name?: string;
    code?: string;
    cause?: { code?: string; cause?: { code?: string } };
    meta?: { statusCode?: number };
    statusCode?: number;
  };
  const status = e?.meta?.statusCode ?? e?.statusCode;
  return new SearchStoreFailure(
    [
      'CERT_HAS_EXPIRED',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'ERR_TLS_CERT_ALTNAME_INVALID',
      'SELF_SIGNED_CERT_IN_CHAIN',
    ].includes(e?.cause?.cause?.code ?? e?.cause?.code ?? e?.code ?? '')
      ? 'SEARCH_TLS_FAILED'
      : e?.name === 'RequestAbortedError' || e?.name === 'AbortError'
        ? 'SEARCH_CANCELLED'
        : e?.name === 'TimeoutError'
          ? 'SEARCH_TIMEOUT'
          : status === 401 || status === 403
            ? 'SEARCH_AUTH_FAILED'
            : status === 404
              ? 'SEARCH_INDEX_MISSING'
              : status === 409
                ? 'SEARCH_CONFLICT'
                : status === 429
                  ? 'SEARCH_RATE_LIMITED'
                  : status && status >= 400 && status < 500
                    ? 'SEARCH_CONTRACT_INVALID'
                    : e?.name === 'ProductNotSupportedError' ||
                        e?.name === 'DeserializationError'
                      ? 'SEARCH_INDEX_INCOMPATIBLE'
                      : 'SEARCH_UNAVAILABLE',
  );
}
function matches(
  scope: SearchProjectionScope,
  userId: string,
  r: SearchRecord,
) {
  return (
    r.userId === userId &&
    r.documentId === scope.documentId &&
    r.documentVersionId === scope.documentVersionId &&
    r.projectionId === scope.projectionId &&
    r.revision === scope.revision
  );
}
/** Compare all explicit contract options; tolerate only server-added default options. */
function subset(expected: unknown, actual: unknown): boolean {
  if (!expected || typeof expected !== 'object') return expected === actual;
  if (Array.isArray(expected))
    return JSON.stringify(expected) === JSON.stringify(actual);
  if (!actual || typeof actual !== 'object' || Array.isArray(actual))
    return false;
  return Object.entries(expected).every(([key, value]) =>
    subset(value, (actual as Record<string, unknown>)[key]),
  );
}

/** Elasticsearch omits true defaults and serializes scalar copy_to as an array. */
function normalizedMapping(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const mapping = value as Record<string, unknown>;
  const source = mapping._source;
  const properties = mapping.properties;
  if (
    !properties ||
    typeof properties !== 'object' ||
    Array.isArray(properties)
  )
    return value;
  return {
    ...mapping,
    _source:
      source === undefined
        ? { enabled: true }
        : source && typeof source === 'object' && !Array.isArray(source)
          ? { enabled: true, ...source }
          : source,
    properties: Object.fromEntries(
      Object.entries(properties).map(([name, value]) => {
        if (!value || typeof value !== 'object' || Array.isArray(value))
          return [name, value];
        const field = value as Record<string, unknown>;
        return [
          name,
          {
            ...(field.type === 'keyword'
              ? { index: true, doc_values: true }
              : {}),
            ...field,
            ...(typeof field.copy_to === 'string'
              ? { copy_to: [field.copy_to] }
              : {}),
          },
        ];
      }),
    ),
  };
}

/** Only this infrastructure boundary imports the official client or Elasticsearch DSL types. */
export class ElasticsearchStore implements LexicalStore {
  private readonly client?: Client;
  private active = 0;
  private readonly shutdown = new AbortController();
  constructor(
    private readonly settings: Settings,
    client?: Client,
  ) {
    if (!settings.enabled) return;
    const password = settings.passwordFile
      ? file(settings.passwordFile, 8192)
      : settings.password;
    const apiKey = settings.apiKeyFile
      ? file(settings.apiKeyFile, 8192)
      : settings.apiKey;
    const ca = settings.caFile ? file(settings.caFile, 1048576) : undefined;
    if (ca) {
      try {
        const certificates = ca.match(
          /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
        );
        if (!certificates?.length) contract();
        for (const certificate of certificates)
          new X509Certificate(certificate);
      } catch {
        throw new SearchStoreFailure('SEARCH_CONTRACT_INVALID');
      }
    }
    try {
      this.client =
        client ??
        new Client({
          node: settings.url,
          auth: apiKey
            ? { apiKey }
            : { username: settings.username!, password: password! },
          tls: { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
          maxRetries: 0,
          requestTimeout: settings.timeoutMs,
          sniffOnStart: false,
          sniffOnConnectionFault: false,
          sniffInterval: false,
          resurrectStrategy: 'optimistic',
          maxResponseSize: settings.maxResponseBytes,
          maxCompressedResponseSize: settings.maxResponseBytes,
          agent: { connections: settings.concurrency },
          enableMetaHeader: false,
        });
    } catch {
      throw new SearchStoreFailure('SEARCH_CONTRACT_INVALID');
    }
  }
  private async operation<T>(
    signal: AbortSignal | undefined,
    action: (
      client: Client,
      options: {
        signal: AbortSignal;
        requestTimeout: number;
        maxRetries: number;
        retryOnTimeout: boolean;
      },
    ) => Promise<T>,
  ): Promise<T> {
    if (!this.client) throw new SearchStoreFailure('SEARCH_NOT_CONFIGURED');
    if (this.active >= this.settings.concurrency)
      throw new SearchStoreFailure('SEARCH_CAPACITY');
    const timeout = AbortSignal.timeout(this.settings.timeoutMs);
    const joined = AbortSignal.any([
      timeout,
      this.shutdown.signal,
      ...(signal ? [signal] : []),
    ]);
    if (joined.aborted) throw new SearchStoreFailure('SEARCH_CANCELLED');
    this.active++;
    try {
      const result = await action(this.client, {
        signal: joined,
        requestTimeout: this.settings.timeoutMs,
        maxRetries: 0,
        retryOnTimeout: false,
      });
      if (joined.aborted) throw new SearchStoreFailure('SEARCH_CANCELLED');
      return result;
    } catch (error) {
      if (timeout.aborted) throw new SearchStoreFailure('SEARCH_TIMEOUT');
      if (joined.aborted) throw new SearchStoreFailure('SEARCH_CANCELLED');
      throw normalizeSearchError(error);
    } finally {
      this.active--;
    }
  }
  private name(target: SearchGenerationTarget, kind: SearchIndexKind) {
    return indexName(this.settings.indexPrefix, target, kind);
  }
  private bounded(value: unknown) {
    if (
      Buffer.byteLength(JSON.stringify(value), 'utf8') >
      this.settings.maxRequestBytes
    )
      contract();
  }
  async availability(signal?: AbortSignal) {
    return this.operation(signal, async (c, o) => {
      const info = await c.info({}, o);
      if (!/^9\.4\.\d+$/.test(info.version.number))
        throw new SearchStoreFailure('SEARCH_INDEX_INCOMPATIBLE');
      const configuration = await c.cluster.getSettings(
        { include_defaults: true },
        o,
      );
      const settings = configuration as unknown as {
        persistent: { action?: { auto_create_index?: unknown } };
        transient: { action?: { auto_create_index?: unknown } };
        defaults?: { action?: { auto_create_index?: unknown } };
      };
      const auto =
        settings.transient.action?.auto_create_index ??
        settings.persistent.action?.auto_create_index ??
        settings.defaults?.action?.auto_create_index;
      if (auto !== false && auto !== 'false')
        throw new SearchStoreFailure('SEARCH_INDEX_INCOMPATIBLE');
      const health = await c.cluster.health(
        { wait_for_status: 'yellow', timeout: `${this.settings.timeoutMs}ms` },
        o,
      );
      if (health.timed_out || health.status === 'red')
        throw new SearchStoreFailure('SEARCH_UNAVAILABLE');
      return { available: true as const, version: info.version.number };
    });
  }
  async inspect(
    target: SearchGenerationTarget,
    kind: SearchIndexKind,
    signal?: AbortSignal,
  ) {
    const index = this.name(target, kind);
    return this.operation(signal, async (c, o) => {
      if (!(await c.indices.exists({ index }, o)))
        return { exists: false, compatible: false };
      const result = await c.indices.get({ index }, o);
      const expected = indexDefinition(target, kind),
        found = result[index];
      const compatible =
        Object.keys(result).length === 1 &&
        !!found &&
        Object.keys(found.aliases ?? {}).length === 0 &&
        subset(
          normalizedMapping(expected.mappings),
          normalizedMapping(found.mappings),
        ) &&
        Object.keys(found.mappings?.properties ?? {}).length ===
          Object.keys(expected.mappings.properties).length &&
        subset(expected.settings.analysis, found.settings?.index?.analysis);
      return { exists: true, compatible };
    });
  }
  async createIndexes(target: SearchGenerationTarget, signal?: AbortSignal) {
    await this.availability(signal);
    for (const kind of ['metadata', 'pages'] as const) {
      const checked = await this.inspect(target, kind, signal);
      if (checked.exists) {
        if (!checked.compatible)
          throw new SearchStoreFailure('SEARCH_INDEX_INCOMPATIBLE');
        continue;
      }
      const definition = indexDefinition(target, kind);
      try {
        await this.operation(signal, (c, o) =>
          c.indices.create(
            {
              index: this.name(target, kind),
              settings: definition.settings as estypes.IndicesIndexSettings,
              mappings: definition.mappings as estypes.MappingTypeMapping,
            },
            o,
          ),
        );
      } catch (error) {
        // Concurrent create is safe only after inspecting the exact mapping contract.
        if (!(
          error instanceof SearchStoreFailure &&
          error.code === 'SEARCH_CONTRACT_INVALID'
        ))
          throw error;
        const existing = await this.inspect(target, kind, signal);
        if (!existing.exists || !existing.compatible) throw error;
      }
    }
  }
  async upsert(
    target: SearchGenerationTarget,
    records: readonly SearchRecord[],
    signal?: AbortSignal,
  ) {
    targetValid(target);
    positive(records.length, this.settings.bulkSize);
    const ids = new Set<string>();
    const operations: object[] = [];
    for (const r of records) {
      recordValid(r, target);
      const id = recordId(r);
      if (ids.has(id)) contract();
      ids.add(id);
      operations.push(
        {
          index: {
            _index: this.name(
              target,
              r.kind === 'metadata' ? 'metadata' : 'pages',
            ),
            _id: id,
          },
        },
        searchRecordSource(r),
      );
    }
    this.bounded(operations);
    await this.availability(signal);
    for (const kind of new Set(
      records.map((r) =>
        r.kind === 'metadata' ? 'metadata' : 'pages',
      ) as SearchIndexKind[],
    )) {
      const inspected = await this.inspect(target, kind, signal);
      if (!inspected.exists)
        throw new SearchStoreFailure('SEARCH_INDEX_MISSING');
      if (!inspected.compatible)
        throw new SearchStoreFailure('SEARCH_INDEX_INCOMPATIBLE');
    }
    await this.operation(signal, async (c, o) => {
      const result = await c.bulk({ operations, refresh: 'wait_for' }, o);
      if (
        !Array.isArray(result.items) ||
        result.items.length !== records.length
      )
        throw new SearchStoreFailure('SEARCH_CONTRACT_INVALID');
      for (let i = 0; i < result.items.length; i++) {
        const item = result.items[i].index;
        if (
          !item ||
          item._id !== recordId(records[i]) ||
          item._index !==
            this.name(
              target,
              records[i].kind === 'metadata' ? 'metadata' : 'pages',
            )
        )
          contract();
        if (item.error && item.status >= 200 && item.status < 300) contract();
        if (item.error || item.status < 200 || item.status >= 300)
          throw normalizeSearchError({ statusCode: item.status });
      }
      if (result.errors)
        throw new SearchStoreFailure('SEARCH_CONTRACT_INVALID');
    });
  }
  private ids(
    kind: SearchIndexKind,
    scope: SearchProjectionScope,
    ids: readonly string[],
  ) {
    scopeValid(scope);
    positive(ids.length, this.settings.bulkSize);
    if (new Set(ids).size !== ids.length) contract();
    const pattern = new RegExp(
      `^${scope.projectionId}:${kind === 'metadata' ? 'metadata' : 'page:[1-9][0-9]{0,9}:(0|[1-9][0-9]{0,9})'}$`,
    );
    if (ids.some((id) => !pattern.test(id))) contract();
  }
  private decoded(
    value: unknown,
    target: SearchGenerationTarget,
  ): SearchRecord {
    if (!value || typeof value !== 'object' || Array.isArray(value)) contract();
    const { referenceExact, ...r } = value as Record<string, unknown>;
    const record = r as unknown as SearchRecord;
    recordValid(record, target);
    if (
      referenceExact !== undefined &&
      (record.kind !== 'metadata' ||
        referenceExact !==
          record.referenceNumber?.normalize('NFKC').trim().toLowerCase())
    )
      contract();
    return record;
  }
  async verify(
    target: SearchGenerationTarget,
    kind: SearchIndexKind,
    userId: string,
    scope: SearchProjectionScope,
    ids: readonly string[],
    signal?: AbortSignal,
  ) {
    uuid(userId);
    this.ids(kind, scope, ids);
    const index = this.name(target, kind);
    return this.operation(signal, async (c, o) => {
      const result = await c.mget<SearchRecord>({ index, ids: [...ids] }, o);
      if (!Array.isArray(result.docs) || result.docs.length !== ids.length)
        contract();
      const found: SearchRecord[] = [];
      for (let i = 0; i < result.docs.length; i++) {
        const item = result.docs[i];
        if (item._id !== ids[i] || item._index !== index || 'error' in item)
          contract();
        if (!item.found) continue;
        const record = this.decoded(item._source, target);
        if (
          !matches(scope, userId, record) ||
          recordId(record) !== item._id ||
          (record.kind === 'metadata') !== (kind === 'metadata')
        )
          contract();
        found.push(record);
      }
      return found;
    });
  }
  async verifyPublication(
    target: SearchGenerationTarget,
    userId: string,
    scope: SearchProjectionScope,
    records: readonly SearchRecord[],
    signal?: AbortSignal,
  ): Promise<void> {
    uuid(userId);
    scopeValid(scope);
    positive(records.length, 10000);
    const expectedIds = new Set(records.map(recordId));
    if (expectedIds.size !== records.length) contract();
    for (const record of records) {
      recordValid(record, target);
      if (!matches(scope, userId, record)) contract();
    }
    const filters: estypes.QueryDslQueryContainer[] = [
      { term: { userId } },
      { term: { indexGenerationId: target.id } },
      { term: { documentId: scope.documentId } },
      { term: { documentVersionId: scope.documentVersionId } },
      { term: { projectionId: scope.projectionId } },
      { term: { revision: scope.revision } },
    ];
    for (const kind of ['metadata', 'pages'] as const) {
      const expected = records.filter(
        (r) => (r.kind === 'metadata') === (kind === 'metadata'),
      );
      const index = this.name(target, kind);
      const checked = await this.inspect(target, kind, signal);
      if (!checked.exists || !checked.compatible)
        throw new SearchStoreFailure('SEARCH_INDEX_INCOMPATIBLE');
      await this.operation(signal, async (c, o) => {
        const result = await c.search(
          {
            index,
            size: 0,
            track_total_hits: true,
            allow_partial_search_results: false,
            query: { bool: { filter: filters } },
          },
          o,
        );
        const total = result.hits.total;
        if (
          result.timed_out ||
          result._shards.failed ||
          !total ||
          typeof total === 'number' ||
          total.relation !== 'eq' ||
          total.value !== expected.length
        )
          throw new SearchStoreFailure('SEARCH_UNAVAILABLE');
      });
      for (
        let start = 0;
        start < expected.length;
        start += this.settings.bulkSize
      ) {
        const batch = expected.slice(start, start + this.settings.bulkSize);
        await this.operation(signal, async (c, o) => {
          const result = await c.search(
            {
              index,
              size: batch.length,
              track_total_hits: true,
              allow_partial_search_results: false,
              query: {
                bool: {
                  filter: [
                    ...filters,
                    { ids: { values: batch.map(recordId) } },
                  ],
                },
              },
            },
            o,
          );
          const total = result.hits.total;
          if (
            result.timed_out ||
            result._shards.failed ||
            !total ||
            typeof total === 'number' ||
            total.relation !== 'eq' ||
            total.value !== batch.length ||
            result.hits.hits.length !== batch.length
          )
            throw new SearchStoreFailure('SEARCH_UNAVAILABLE');
          const found = new Map<string, SearchRecord>();
          for (const hit of result.hits.hits) {
            if (!hit._id || hit._index !== index || found.has(hit._id))
              contract();
            const record = this.decoded(hit._source, target);
            if (!matches(scope, userId, record) || recordId(record) !== hit._id)
              contract();
            found.set(hit._id, record);
          }
          for (const record of batch)
            if (
              canonicalJson(found.get(recordId(record))) !==
              canonicalJson(record)
            )
              throw new SearchStoreFailure('SEARCH_UNAVAILABLE');
        });
      }
    }
  }
  async remove(
    target: SearchGenerationTarget,
    kind: SearchIndexKind,
    userId: string,
    scope: SearchProjectionScope,
    ids: readonly string[],
    signal?: AbortSignal,
  ) {
    // Read and validate owned lineage before exact-ID removal. No delete-by-query.
    await this.verify(target, kind, userId, scope, ids, signal);
    const index = this.name(target, kind);
    const operations = ids.map((id) => ({
      delete: { _index: index, _id: id },
    }));
    this.bounded(operations);
    await this.operation(signal, async (c, o) => {
      const result = await c.bulk({ operations, refresh: 'wait_for' }, o);
      if (!Array.isArray(result.items) || result.items.length !== ids.length)
        contract();
      result.items.forEach((value, i) => {
        const item = value.delete;
        if (!item || item._id !== ids[i] || item._index !== index) contract();
        if (
          item.status !== 404 &&
          (item.error || item.status < 200 || item.status >= 300)
        )
          throw normalizeSearchError({ statusCode: item.status });
      });
    });
  }
  async scan(
    target: SearchGenerationTarget,
    kind: SearchIndexKind,
    userId: string,
    after: readonly (string | number)[] | undefined,
    limit: number,
    signal?: AbortSignal,
  ) {
    uuid(userId);
    if (after) uuid(String(after[0]));
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (after &&
        (after.length !== (kind === 'metadata' ? 1 : 3) ||
          typeof after[0] !== 'string' ||
          after
            .slice(1)
            .some(
              (v) => typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0,
            )))
    )
      contract();
    return this.operation(signal, async (c, o) => {
      const result = await c.search(
        {
          index: this.name(target, kind),
          size: limit,
          track_total_hits: false,
          allow_partial_search_results: false,
          _source: [
            'userId',
            'documentId',
            'documentVersionId',
            'projectionId',
            'revision',
            'sourceHash',
          ],
          query: {
            bool: {
              filter: [
                { term: { userId } },
                { term: { indexGenerationId: target.id } },
              ],
            },
          },
          sort:
            kind === 'metadata'
              ? [{ projectionId: 'asc' }]
              : [
                  { projectionId: 'asc' },
                  { pageNumber: 'asc' },
                  { segment: 'asc' },
                ],
          ...(after ? { search_after: [...after] } : {}),
        },
        o,
      );
      if (result.timed_out || result._shards.failed)
        throw new SearchStoreFailure('SEARCH_UNAVAILABLE');
      const records = result.hits.hits.map((hit) => {
        const r = hit._source as
          | {
              userId: string;
              documentId: string;
              documentVersionId: string;
              projectionId: string;
              revision: number;
              sourceHash: string;
            }
          | undefined;
        if (
          !r ||
          r.userId !== userId ||
          !hit._id ||
          !hit._id.startsWith(`${r.projectionId}:`) ||
          hit._index !== this.name(target, kind)
        )
          contract();
        scopeValid(r);
        if (!/^[0-9a-f]{64}$/.test(r.sourceHash)) contract();
        return {
          id: hit._id,
          userId: r.userId,
          documentId: r.documentId,
          documentVersionId: r.documentVersionId,
          projectionId: r.projectionId,
          revision: r.revision,
          sourceHash: r.sourceHash,
        };
      });
      const sort = result.hits.hits.at(-1)?.sort;
      if (
        records.length === limit &&
        (!sort ||
          sort.length !== (kind === 'metadata' ? 1 : 3) ||
          sort[0] !== records.at(-1)?.projectionId)
      )
        contract();
      if (
        sort &&
        sort.some((v) => typeof v !== 'string' && typeof v !== 'number')
      )
        contract();
      return {
        records,
        next:
          records.length === limit && sort
            ? (sort as (string | number)[])
            : null,
      };
    });
  }
  async query(
    target: SearchGenerationTarget,
    kind: SearchIndexKind,
    input: LexicalQuery,
    signal?: AbortSignal,
  ): Promise<LexicalHit[]> {
    uuid(input.userId);
    positive(input.scopes.length, this.settings.maxScopes);
    positive(input.limit, input.mode === 'prefix' ? 50 : 200);
    if (
      typeof input.text !== 'string' ||
      !input.text.trim() ||
      input.text.length > (input.mode === 'prefix' ? 256 : 4000) ||
      !['terms', 'phrase', 'prefix'].includes(input.mode) ||
      (input.mode === 'prefix' && kind !== 'metadata')
    )
      contract();
    input.scopes.forEach(scopeValid);
    const filters: estypes.QueryDslQueryContainer[] = [
      { term: { userId: input.userId } },
      { term: { indexGenerationId: target.id } },
      {
        bool: {
          minimum_should_match: 1,
          should: input.scopes.map((s) => ({
            bool: {
              filter: [
                { term: { documentId: s.documentId } },
                { term: { documentVersionId: s.documentVersionId } },
                { term: { projectionId: s.projectionId } },
                { term: { revision: s.revision } },
              ],
            },
          })),
        },
      },
    ];
    if (input.recordIds) {
      if (
        !input.recordIds.length ||
        input.recordIds.length > 200 ||
        new Set(input.recordIds).size !== input.recordIds.length ||
        input.recordIds.some((id) => typeof id !== 'string' || id.length > 128)
      )
        contract();
      filters.push({ ids: { values: [...input.recordIds] } });
    }
    const fields =
      input.mode === 'prefix'
        ? ['title', 'issuer', 'referenceNumber']
        : kind === 'pages'
          ? ['text']
          : [
              'title^3',
              'description',
              'issuer^2',
              'referenceNumber^3',
              'filename^2',
            ];
    const lexical: estypes.QueryDslQueryContainer = {
      multi_match: {
        query: input.text,
        fields,
        type:
          input.mode === 'phrase'
            ? 'phrase'
            : input.mode === 'prefix'
              ? 'bool_prefix'
              : 'best_fields',
        operator: 'and',
      },
    };
    const clauses: estypes.QueryDslQueryContainer[] = [lexical];
    if (kind === 'metadata' && input.mode !== 'prefix')
      clauses.push({
        term: {
          referenceExact: {
            value: input.text.normalize('NFKC').trim().toLowerCase(),
            boost: 8,
          },
        },
      });
    if (input.mode === 'terms')
      clauses.push({
        multi_match: { query: input.text, fields, type: 'phrase', boost: 2 },
      });
    const query: estypes.QueryDslQueryContainer =
      input.mode === 'prefix'
        ? { bool: { filter: filters, must: [lexical] } }
        : {
            bool: { filter: filters, minimum_should_match: 1, should: clauses },
          };
    const sort: estypes.SortCombinations[] = [
      { _score: { order: 'desc' } },
      { documentId: 'asc' },
      { projectionId: 'asc' },
    ];
    if (kind === 'pages') sort.push({ pageNumber: 'asc' }, { segment: 'asc' });
    const request: estypes.SearchRequest = {
      index: this.name(target, kind),
      query,
      size: input.limit,
      sort,
      track_total_hits: false,
      allow_partial_search_results: false,
      timeout: `${this.settings.timeoutMs}ms`,
    };
    const marker = randomBytes(16).toString('hex'),
      open = `[qyvra:${marker}:start]`,
      close = `[qyvra:${marker}:end]`;
    if (input.mode !== 'prefix')
      request.highlight = {
        type: 'unified',
        pre_tags: [open],
        post_tags: [close],
        encoder: 'default',
        require_field_match: true,
        fields: Object.fromEntries(
          (kind === 'pages'
            ? ['text']
            : HIGHLIGHT_FIELDS.filter((f) => f !== 'text')
          ).map((field) => [
            field,
            {
              number_of_fragments: 1,
              fragment_size: 200,
              max_analyzed_offset: 100000,
            },
          ]),
        ),
      };
    this.bounded(request);
    return this.operation(signal, async (c, o) => {
      let result: estypes.SearchResponse<SearchRecord>;
      try {
        result = await c.search<SearchRecord>(request, o);
      } catch (error) {
        const code = normalizeSearchError(error).code;
        if (
          !request.highlight ||
          signal?.aborted ||
          !['SEARCH_CAPACITY', 'SEARCH_CONTRACT_INVALID'].includes(code)
        )
          throw error;
        // One bounded plain-snippet attempt if optional highlighting exceeds transport/server limits.
        const { highlight: _highlight, ...plain } = request;
        void _highlight;
        result = await c.search<SearchRecord>(plain, o);
      }
      if (
        !result._shards ||
        !result.hits ||
        !Array.isArray(result.hits.hits) ||
        typeof result.timed_out !== 'boolean' ||
        typeof result._shards.failed !== 'number'
      )
        contract();
      if (result.timed_out || result._shards.failed)
        throw new SearchStoreFailure('SEARCH_UNAVAILABLE');
      if (result.hits.hits.length > input.limit) contract();
      return result.hits.hits.map((hit) => {
        const record = this.decoded(hit._source, target);
        if (
          hit._index !== request.index ||
          hit._id !== recordId(record) ||
          !Number.isFinite(hit._score) ||
          !input.scopes.some((s) => matches(s, input.userId, record)) ||
          (record.kind === 'metadata') !== (kind === 'metadata')
        )
          contract();
        const highlights =
          input.mode === 'prefix'
            ? []
            : HIGHLIGHT_FIELDS.flatMap((field) => {
                const fragments = hit.highlight?.[field];
                if (
                  !Array.isArray(fragments) ||
                  fragments.length !== 1 ||
                  (kind === 'pages') !== (field === 'text')
                )
                  return [];
                const hint = decodeHighlight(field, fragments[0], open, close);
                return hint ? [hint] : [];
              });
        return { id: hit._id!, score: hit._score!, record, highlights };
      });
    });
  }
  async close() {
    this.shutdown.abort();
    await this.client?.close();
  }
  async onApplicationShutdown() {
    await this.close();
  }
}
