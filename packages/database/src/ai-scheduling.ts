import {
  Prisma,
  AiProcessingRun,
  ProcessingJob,
} from './generated/prisma/client';
import { createHash } from 'node:crypto';

export type AiProcessingStart =
  'repair' | 'extraction' | 'chunking' | 'embedding' | 'index';

/** Reuse only complete, compatible, immutable artifacts. SQL rechecks all lineage. */
export async function reuseAiArtifacts(
  tx: Prisma.TransactionClient,
  run: AiProcessingRun,
  verification: ProcessingJob,
  startAt: AiProcessingStart,
  now: Date,
) {
  if (startAt === 'extraction') return verification;
  const version = await tx.documentVersion.findUniqueOrThrow({
    where: { id: run.documentVersionId },
    select: { id: true, checksumSha256: true },
  });
  const extraction = await tx.extractedText.findFirst({
    where: {
      documentVersionId: version.id,
      extractionFingerprint: createHash('sha256')
        .update(
          JSON.stringify([
            'qyvra.extraction.v1',
            version.checksumSha256,
            run.extractor,
            run.extractorVersion,
            run.normalizationVersion,
          ]),
        )
        .digest('hex'),
      outcome: 'COMPLETED',
      sourceChecksum: version.checksumSha256,
      extractor: run.extractor,
      extractorVersion: run.extractorVersion,
      normalizationVersion: run.normalizationVersion,
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    select: { id: true, contentHash: true },
  });
  if (!extraction) return verification;
  const set =
    startAt === 'chunking'
      ? null
      : await tx.chunkSet.findFirst({
          where: {
            documentVersionId: version.id,
            fingerprint: createHash('sha256')
              .update(
                JSON.stringify([
                  'qyvra.chunk-set.v1',
                  extraction.id,
                  extraction.contentHash,
                  run.chunkAlgorithm,
                  run.chunkAlgorithmVersion,
                  run.tokenizer,
                  run.tokenizerVersion,
                  run.chunkSize,
                  run.chunkOverlap,
                ]),
              )
              .digest('hex'),
            extractedTextId: extraction.id,
            complete: true,
            extractionHash: extraction.contentHash,
            algorithm: run.chunkAlgorithm,
            algorithmVersion: run.chunkAlgorithmVersion,
            tokenizer: run.tokenizer,
            tokenizerVersion: run.tokenizerVersion,
            chunkSize: run.chunkSize,
            chunkOverlap: run.chunkOverlap,
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          select: { id: true, chunkCount: true },
        });
  let predecessor = verification;
  const types = [
    'EXTRACT_TEXT',
    'GENERATE_CHUNKS',
    'GENERATE_EMBEDDINGS',
  ] as const;
  for (const type of types) {
    if (type !== 'EXTRACT_TEXT' && !set) break;
    if (type === 'GENERATE_EMBEDDINGS') {
      if (startAt === 'embedding') break;
      const [valid] = await tx.$queryRaw<{ count: bigint }[]>`
        SELECT count(*) FROM chunk_embeddings e
        JOIN document_chunks c ON c.id = e.chunk_id
        JOIN embedding_profiles p ON p.id = e.embedding_profile_id
        WHERE c.chunk_set_id = ${set!.id}::uuid AND p.id = ${run.embeddingProfileId}::uuid
          AND p.normalization_version = 'qyvra-embedding-input/v1'
          AND e.input_hash = encode(sha256(convert_to(
            CASE WHEN p.document_instruction = '' THEN c.text
              ELSE p.document_instruction || chr(10) || c.text END, 'UTF8')), 'hex')
      `;
      if (Number(valid.count) !== set!.chunkCount) break;
    }
    const latest = await tx.processingJob.findFirst({
      where: { documentVersionId: version.id, jobType: type },
      orderBy: { generation: 'desc' },
    });
    predecessor = await tx.processingJob.create({
      data: {
        userId: run.userId,
        documentId: run.documentId,
        documentVersionId: version.id,
        aiRunId: run.id,
        predecessorJobId: predecessor.id,
        jobType: type,
        generation: (latest?.generation ?? 0) + 1,
        maxAttempts: verification.maxAttempts,
        correlationId: run.id,
        status: 'COMPLETED',
        completedAt: now,
        extractedTextId: extraction.id,
        ...(type === 'EXTRACT_TEXT' ? {} : { chunkSetId: set!.id }),
      },
    });
    if (type === 'EXTRACT_TEXT') {
      await tx.versionAiState.update({
        where: { documentVersionId: version.id },
        data: { lastExtractionJobId: predecessor.id },
      });
      await tx.documentVersion.update({
        where: { id: version.id },
        data: { extractionStatus: 'COMPLETED' },
      });
    }
  }
  return predecessor;
}
