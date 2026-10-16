import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { Prisma, type SearchIndexGeneration } from '@qyvra/database';
import { PrismaService } from '../../database/prisma.service';
import type { SearchProjectionScope } from '../../infrastructure/search/lexical-store';
import type {
  KeywordCoverageDto,
  KeywordSearchDto,
} from './keyword-search.dto';

export interface LexicalReference {
  id: string;
  record: {
    projectionId: string;
    documentId: string;
    documentVersionId: string;
    revision: number;
    sourceHash: string;
    kind: 'metadata' | 'page';
    pageNumber?: number;
    segment?: number;
    startOffset?: number;
    endOffset?: number;
  };
}
export interface FilteredDocument {
  documentId: string;
  documentVersionId: string;
  versionNumber: number;
  title: string;
  originalFilename: string;
  mimeType: string;
  documentType: string;
  status: string;
  categoryId: string | null;
  tagIds: string[];
}
type SqlClient = Pick<Prisma.TransactionClient, '$queryRaw'>;
export interface KeywordScope extends SearchProjectionScope {
  metadataHash: string;
  textCoverage: string;
}
export interface CanonicalKeywordHit {
  recordId: string;
  kind: 'metadata' | 'page';
  documentId: string;
  documentVersionId: string;
  projectionId: string;
  versionNumber: number;
  title: string;
  originalFilename: string;
  mimeType: string;
  documentType: string;
  status: string;
  categoryId: string | null;
  tagIds: string[];
  description: string | null;
  issuer: string | null;
  referenceNumber: string | null;
  excerpt: string | null;
  pageNumber: number | null;
  extractedTextId: string | null;
  startOffset: number | null;
  segment?: number | null;
}
const literal = (text: string) => '%' + text.replace(/[\\%_]/g, '\\$&') + '%';

/** Authorization predicates are applied before top candidates and again before any content reads. */
@Injectable()
export class KeywordSearchRepository {
  constructor(private readonly database: PrismaService) {}
  generation(): Promise<SearchIndexGeneration | null> {
    return this.database.client.searchIndexGeneration.findFirst({
      where: { status: 'SERVING' },
    });
  }
  async authorizeDocuments(userId: string, ids?: readonly string[]) {
    if (!ids) return;
    const count = await this.database.client.document.count({
      where: {
        userId,
        id: { in: [...ids] },
        deletedAt: null,
        isArchived: false,
        status: { notIn: ['ARCHIVED', 'DELETING'] },
      },
    });
    if (count !== ids.length) throw new NotFoundException();
  }
  private eligible(userId: string, input: KeywordSearchDto): Prisma.Sql {
    const f = input.filters ?? {},
      conditions: Prisma.Sql[] = [
        Prisma.sql`d.user_id=${userId}::uuid
      AND d.deleted_at IS NULL AND NOT d.is_archived AND d.status NOT IN ('ARCHIVED','DELETING')`,
      ];
    if (input.documentIds)
      conditions.push(
        Prisma.sql`d.id IN (${Prisma.join(input.documentIds.map((id) => Prisma.sql`${id}::uuid`))})`,
      );
    if (f.categoryId)
      conditions.push(Prisma.sql`d.category_id=${f.categoryId}::uuid`);
    if (f.documentType)
      conditions.push(Prisma.sql`d.document_type=${f.documentType}`);
    if (f.status) conditions.push(Prisma.sql`d.status=${f.status}`);
    if (f.mimeType) conditions.push(Prisma.sql`v.mime_type=${f.mimeType}`);
    if (f.filename)
      conditions.push(
        Prisma.sql`v.original_filename ILIKE ${literal(f.filename)} ESCAPE ${'\\'}`,
      );
    for (const tag of f.tagIds ?? [])
      conditions.push(Prisma.sql`EXISTS (SELECT 1 FROM document_tags dt
      WHERE dt.document_id=d.id AND dt.user_id=${userId}::uuid AND dt.tag_id=${tag}::uuid)`);
    for (const [prefix, column, time] of [
      ['date', 'd.document_date', false],
      ['expiration', 'd.expiration_date', false],
      ['created', 'd.created_at', true],
      ['updated', 'd.updated_at', true],
    ] as const) {
      const from = f[`${prefix}From`],
        to = f[`${prefix}To`],
        field = Prisma.raw(column);
      if (from)
        conditions.push(
          time
            ? Prisma.sql`${field} >= (${from}::date::timestamp AT TIME ZONE 'UTC')`
            : Prisma.sql`${field} >= ${from}::date`,
        );
      if (to)
        conditions.push(
          time
            ? Prisma.sql`${field} < ((${to}::date + INTERVAL '1 day') AT TIME ZONE 'UTC')`
            : Prisma.sql`${field} <= ${to}::date`,
        );
    }
    return Prisma.sql`SELECT d.id AS document_id,v.id AS version_id FROM documents d
      JOIN LATERAL (SELECT * FROM document_versions n WHERE n.document_id=d.id AND n.user_id=d.user_id
        ORDER BY n.version_number DESC LIMIT 1) v ON TRUE WHERE ${Prisma.join(conditions, ' AND ')}`;
  }
  /** Shared full metadata filters before either engine selects candidates. */
  async filteredDocuments(
    userId: string,
    input: KeywordSearchDto,
    max = 100,
    db: SqlClient = this.database.client,
  ): Promise<FilteredDocument[]> {
    const rows = await db.$queryRaw<FilteredDocument[]>(Prisma.sql`
      WITH eligible AS (${this.eligible(userId, input)})
      SELECT d.id AS "documentId",v.id AS "documentVersionId",v.version_number AS "versionNumber",
        d.title,v.original_filename AS "originalFilename",v.mime_type AS "mimeType",
        d.document_type AS "documentType",d.status,d.category_id AS "categoryId",
        ARRAY(SELECT dt.tag_id::text FROM document_tags dt WHERE dt.document_id=d.id AND dt.user_id=d.user_id ORDER BY dt.tag_id) AS "tagIds"
      FROM eligible e JOIN documents d ON d.id=e.document_id JOIN document_versions v ON v.id=e.version_id
      ORDER BY d.id LIMIT ${max + 1}`);
    if (rows.length > max)
      throw new BadRequestException('Narrow the search filters.');
    return rows;
  }
  private ready(
    userId: string,
    generationId: string,
    input: KeywordSearchDto,
  ): Prisma.Sql {
    return Prisma.sql`WITH eligible AS (${this.eligible(userId, input)}), ready AS (
      SELECT p.* FROM eligible e JOIN document_search_states s ON s.document_id=e.document_id
        AND s.user_id=${userId}::uuid AND s.desired_version_id=e.version_id
      JOIN version_search_projections p ON p.id=s.ready_projection_id AND p.document_id=e.document_id
        AND p.document_version_id=e.version_id AND p.user_id=s.user_id AND p.revision=s.desired_revision
      JOIN search_index_generations g ON g.id=p.index_generation_id
      WHERE p.status='READY' AND p.metadata_ready AND p.verified_at IS NOT NULL AND p.records_hash IS NOT NULL
        AND g.status='SERVING' AND g.id=${generationId}::uuid
        AND p.metadata_hash=search_metadata_hash(e.version_id))`;
  }
  private async scopeOn(
    db: SqlClient,
    userId: string,
    generationId: string,
    input: KeywordSearchDto,
    max: number,
  ) {
    const cte = this.ready(userId, generationId, input);
    const scopes = await db.$queryRaw<KeywordScope[]>(Prisma.sql`${cte}
      SELECT document_id AS "documentId",document_version_id AS "documentVersionId",id AS "projectionId",
        revision,metadata_hash AS "metadataHash",text_coverage AS "textCoverage" FROM ready ORDER BY document_id LIMIT ${max + 1}`);
    if (scopes.length > max)
      throw new BadRequestException('Narrow the search filters.');
    const counts = await db.$queryRaw<KeywordCoverageDto[]>(Prisma.sql`${cte}
      SELECT (SELECT count(*)::integer FROM eligible) AS "eligibleDocuments",
        count(*)::integer AS "metadataReadyDocuments",
        count(*) FILTER (WHERE text_coverage='READY')::integer AS "textReadyDocuments" FROM ready`);
    return { scopes, coverage: counts[0] };
  }
  scope(
    userId: string,
    generationId: string,
    input: KeywordSearchDto,
    max: number,
  ) {
    return this.scopeOn(this.database.client, userId, generationId, input, max);
  }
  private async hydrate(
    db: SqlClient,
    userId: string,
    generationId: string,
    input: KeywordSearchDto,
    hits: readonly LexicalReference[],
  ) {
    if (!hits.length) return [];
    const tuples = hits.map((h) => {
      const r = h.record;
      return Prisma.sql`(${h.id}::text,${r.projectionId}::uuid,${r.documentId}::uuid,${r.documentVersionId}::uuid,
        ${r.revision}::integer,${r.sourceHash}::text,${r.kind}::text,
        ${r.kind === 'page' ? r.pageNumber : 0}::integer,${r.kind === 'page' ? r.segment : 0}::integer,
        ${r.kind === 'page' ? r.startOffset : 0}::integer,${r.kind === 'page' ? r.endOffset : 0}::integer)`;
    });
    return db.$queryRaw<
      CanonicalKeywordHit[]
    >(Prisma.sql`${this.ready(userId, generationId, input)}
      SELECT c.record_id AS "recordId",c.kind,d.id AS "documentId",v.id AS "documentVersionId",p.id AS "projectionId",
        v.version_number AS "versionNumber",d.title,v.original_filename AS "originalFilename",v.mime_type AS "mimeType",
        d.document_type AS "documentType",d.status,d.category_id AS "categoryId",
        ARRAY(SELECT dt.tag_id::text FROM document_tags dt WHERE dt.document_id=d.id AND dt.user_id=${userId}::uuid ORDER BY dt.tag_id) AS "tagIds",
        d.description,d.issuer,d.reference_number AS "referenceNumber",
        CASE WHEN c.kind='page' THEN substr(t.text,c.start_offset+1,c.end_offset-c.start_offset) ELSE NULL END AS excerpt,
        CASE WHEN c.kind='page' THEN c.page_number ELSE NULL END AS "pageNumber",
        CASE WHEN c.kind='page' THEN t.id ELSE NULL END AS "extractedTextId",
        CASE WHEN c.kind='page' THEN c.start_offset ELSE NULL END AS "startOffset",
        CASE WHEN c.kind='page' THEN c.segment ELSE NULL END AS segment
      FROM (VALUES ${Prisma.join(tuples)}) c(record_id,projection_id,document_id,version_id,revision,source_hash,kind,page_number,segment,start_offset,end_offset)
      JOIN ready p ON p.id=c.projection_id AND p.document_id=c.document_id AND p.document_version_id=c.version_id AND p.revision=c.revision
      JOIN documents d ON d.id=p.document_id AND d.user_id=${userId}::uuid
      JOIN document_versions v ON v.id=p.document_version_id AND v.user_id=d.user_id
      LEFT JOIN extracted_texts t ON t.id=p.extracted_text_id AND t.user_id=d.user_id AND t.document_version_id=v.id
        AND t.source_checksum=v.checksum_sha256
      LEFT JOIN LATERAL (SELECT span FROM jsonb_array_elements(t.page_spans) span WHERE (span->>'pageNumber')::integer=c.page_number) page ON TRUE
      WHERE p.expected_record_ids ? c.record_id AND (
        (c.kind='metadata' AND c.record_id=p.id::text||':metadata' AND c.source_hash=p.metadata_hash)
        OR (c.kind='page' AND p.text_coverage='READY' AND c.source_hash=t.content_hash
          AND c.record_id=p.id::text||':page:'||c.page_number::text||':'||c.segment::text
          AND c.start_offset=(page.span->>'startOffset')::integer+c.segment::bigint*8192
          AND c.end_offset=least((page.span->>'endOffset')::integer,c.start_offset::bigint+8192)
          AND c.end_offset>c.start_offset))`);
  }
  /** One final SQL snapshot; no external IO, cached text or cached authorization. */
  finalize(
    userId: string,
    generationId: string,
    input: KeywordSearchDto,
    max: number,
    hits: readonly LexicalReference[],
    transaction?: Prisma.TransactionClient,
  ) {
    const read = async (tx: Prisma.TransactionClient) => {
      const generation = await tx.searchIndexGeneration.findFirst({
        where: { status: 'SERVING' },
      });
      if (generation?.id !== generationId)
        throw new ConflictException('Restart search.');
      const current = await this.scopeOn(tx, userId, generationId, input, max);
      const sources = await this.hydrate(tx, userId, generationId, input, hits);
      return { ...current, sources };
    };
    return transaction ? read(transaction) : this.snapshot(read);
  }
  snapshot<T>(read: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.database.client.$transaction(read, {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
  }
}
