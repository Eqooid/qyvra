import {
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@qyvra/database';
import { PrismaService } from '../../database/prisma.service';
import type { VectorCandidate } from '../ai/vector-store';

export interface SearchSource {
  chunkId: string;
  documentId: string;
  documentVersionId: string;
  chunkSetId: string;
  indexManifestId: string;
  embeddingProfileId: string;
  chunkOrdinal: number;
  title: string;
  originalFilename: string;
  versionNumber: number;
  excerpt: string;
  excerptHash: string;
  startOffset: number;
  endOffset: number;
  pageSpans: Prisma.JsonValue;
}

/** SQL owns scope and provenance. Remote payloads can never authorize content reads. */
@Injectable()
export class SemanticSearchRepository {
  constructor(private readonly prisma: PrismaService) {}
  async profile() {
    return (
      await this.prisma.client.aiServingProfile.findUnique({
        where: { id: 1 },
        include: { profile: true },
      })
    )?.profile;
  }
  async authorizeDocuments(
    userId: string,
    ids?: readonly string[],
  ): Promise<void> {
    if (!ids) return;
    const count = await this.prisma.client.document.count({
      where: {
        id: { in: [...ids] },
        userId,
        deletedAt: null,
        isArchived: false,
      },
    });
    if (count !== ids.length) throw new NotFoundException();
  }
  async scope(
    userId: string,
    profileId: string,
    max: number,
    ids?: readonly string[],
  ): Promise<string[]> {
    const rows = await this.prisma.client.$queryRaw<
      { id: string }[]
    >(Prisma.sql`
      SELECT i.id FROM version_ready_indexes r
      JOIN version_vector_indexes i ON i.id = r.vector_index_id
      JOIN chunk_sets s ON s.id = i.chunk_set_id
      JOIN document_versions v ON v.id = r.document_version_id
      JOIN documents d ON d.id = v.document_id
      JOIN ai_serving_profile a ON a.embedding_profile_id = r.embedding_profile_id
      WHERE r.user_id = ${userId}::uuid AND d.user_id = ${userId}::uuid
        AND r.embedding_profile_id = ${profileId}::uuid AND i.embedding_profile_id = r.embedding_profile_id
        AND i.status = 'READY' AND s.complete AND d.deleted_at IS NULL AND NOT d.is_archived
        AND NOT EXISTS (SELECT 1 FROM document_versions n WHERE n.document_id = v.document_id AND n.version_number > v.version_number)
        ${ids ? Prisma.sql`AND d.id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})` : Prisma.empty}
      ORDER BY i.id LIMIT ${max + 1}`);
    if (rows.length > max)
      throw new ServiceUnavailableException('Narrow the document scope.');
    return rows.map((row) => row.id);
  }
  async hydrate(
    userId: string,
    profileId: string,
    candidates: readonly VectorCandidate[],
  ): Promise<SearchSource[]> {
    if (!candidates.length) return [];
    // The tuple binds every candidate reference to SQL; text is selected only through
    // current owned READY mappings. This single statement also rechecks serving selection.
    const tuples = candidates.map(
      (c) =>
        Prisma.sql`(${c.chunkId}::uuid, ${c.indexManifestId}::uuid, ${c.documentId}::uuid, ${c.documentVersionId}::uuid, ${c.chunkSetId}::uuid)`,
    );
    return this.prisma.client.$queryRaw<SearchSource[]>(Prisma.sql`
      SELECT c.id AS "chunkId", c.document_id AS "documentId", c.document_version_id AS "documentVersionId",
        c.chunk_set_id AS "chunkSetId", i.id AS "indexManifestId", i.embedding_profile_id AS "embeddingProfileId",
        c.ordinal AS "chunkOrdinal", c.text AS excerpt, c.text_hash AS "excerptHash",
        c.start_offset AS "startOffset", c.end_offset AS "endOffset", c.page_spans AS "pageSpans",
        d.title, v.original_filename AS "originalFilename", v.version_number AS "versionNumber"
      FROM (VALUES ${Prisma.join(tuples)}) AS candidate(chunk_id, manifest_id, document_id, version_id, set_id)
      JOIN document_chunks c ON c.id = candidate.chunk_id AND c.chunk_set_id = candidate.set_id
        AND c.document_id = candidate.document_id AND c.document_version_id = candidate.version_id
      JOIN version_vector_indexes i ON i.id = candidate.manifest_id AND i.chunk_set_id = c.chunk_set_id
        AND i.document_version_id = c.document_version_id AND i.user_id = c.user_id
      JOIN version_ready_indexes r ON r.vector_index_id = i.id AND r.embedding_profile_id = i.embedding_profile_id
      JOIN chunk_sets s ON s.id = c.chunk_set_id
      JOIN document_versions v ON v.id = c.document_version_id
      JOIN documents d ON d.id = c.document_id
      JOIN ai_serving_profile a ON a.embedding_profile_id = i.embedding_profile_id
      WHERE c.user_id = ${userId}::uuid AND d.user_id = ${userId}::uuid AND r.user_id = ${userId}::uuid
        AND i.embedding_profile_id = ${profileId}::uuid AND i.status = 'READY' AND s.complete
        AND d.deleted_at IS NULL AND NOT d.is_archived
        AND NOT EXISTS (SELECT 1 FROM document_versions n WHERE n.document_id = v.document_id AND n.version_number > v.version_number)`);
  }
}
