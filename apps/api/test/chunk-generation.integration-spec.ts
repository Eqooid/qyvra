import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import {
  createPrismaClient,
  embeddingProfileFingerprint,
  ProcessingRepository,
  type PrismaClient,
  type AiRunRequest,
  type ProcessingMessage,
} from '@qyvra/database';
import type { Storage } from '@qyvra/storage';
import {
  CHUNK_STRATEGY,
  DeterministicChunker,
  hashText,
} from '../src/modules/ai/deterministic-chunker';
import { ChunkGenerationHandler } from '../src/infrastructure/worker/chunk-generation.handler';
import { ProcessingMessageHandler } from '../src/infrastructure/worker/processing-message-handler';
import {
  PDF_EXTRACTOR,
  IsolatedPdfParser,
} from '../src/infrastructure/extraction/pdf-parser';
import { PdfTextExtractionHandler } from '../src/infrastructure/worker/pdf-text-extraction.handler';
import { StoredFileIntegrityHandler } from '../src/infrastructure/worker/stored-file-integrity.handler';
import { RabbitMqConsumer } from '../src/infrastructure/messaging/rabbitmq.consumer';
import { RabbitMqPublisher } from '../src/infrastructure/messaging/rabbitmq.publisher';

const url = process.env.TEST_DATABASE_URL;
const limits = {
  chunkSize: 512,
  chunkOverlap: 64,
  maxChunks: 10000,
  maxOutputBytes: 40000000,
  timeoutMs: 30000,
};
const pdfLimits = {
  maxBytes: 52428800,
  maxPages: 500,
  maxCharacters: 5000000,
  maxTextBytes: 20000000,
  timeoutMs: 10000,
  heapMb: 256,
};
(url ? describe : describe.skip)(
  'durable chunk generation (real PostgreSQL)',
  () => {
    let db: PrismaClient, repository: ProcessingRepository;
    const users: string[] = [],
      profiles: string[] = [];
    beforeAll(async () => {
      if (!url || !/test/i.test(new URL(url).pathname))
        throw Error('Use a disposable test database');
      db = createPrismaClient({
        url,
        connectTimeoutMs: 2000,
        queryTimeoutMs: 10000,
        poolSize: 4,
      });
      repository = new ProcessingRepository(db);
      await db.$connect();
    });
    afterAll(async () => {
      try {
        await db.document.deleteMany({ where: { userId: { in: users } } });
        await db.user.deleteMany({ where: { id: { in: users } } });
        await db.embeddingProfile.deleteMany({
          where: { id: { in: profiles } },
        });
      } finally {
        await db.$disconnect();
      }
    });
    async function envelope(id: string) {
      const outbox = await db.processingOutbox.findFirstOrThrow({
        where: { processingJobId: id },
        orderBy: { dispatchSequence: 'desc' },
      });
      return outbox.payload as unknown as ProcessingMessage;
    }
    function handler(
      chunker = new DeterministicChunker(),
      timeoutMs = limits.timeoutMs,
    ) {
      return new ChunkGenerationHandler(db, chunker, { ...limits, timeoutMs });
    }
    function input(job: Awaited<ReturnType<ProcessingRepository['claim']>>) {
      return {
        jobId: job.id,
        documentId: job.documentId,
        documentVersionId: job.documentVersionId,
        leaseToken: job.leaseToken!,
        attempt: job.attempts,
      };
    }
    async function fixture(
      text:
        | string
        | undefined = 'Some canonical text for citation provenance. '.repeat(
        100,
      ),
      settings: Partial<AiRunRequest> = {},
      realPdf = false,
    ) {
      const bytes = await readFile(
        resolve(__dirname, 'fixtures/pdf/multi.pdf'),
      );
      const user = await db.user.create({
        data: { email: `${randomUUID()}@example.invalid` },
      });
      users.push(user.id);
      const document = await db.document.create({
        data: { userId: user.id, title: 'Citation document' },
      });
      const id = randomUUID();
      const version = await db.documentVersion.create({
        data: {
          id,
          userId: user.id,
          documentId: document.id,
          versionNumber: 1,
          originalFilename: 'multiple.pdf',
          storageKey: `documents/${user.id}/${document.id}/${id}/original.pdf`,
          mimeType: 'application/pdf',
          fileSize: bytes.length,
          pageCount: 2,
          checksumSha256: createHash('sha256').update(bytes).digest('hex'),
        },
      });
      const stored = version;
      const identity = {
        profileVersion: 1,
        provider: 'test',
        model: randomUUID(),
        modelRevision: 'v1',
        dimensions: 3,
        distance: 'Cosine' as const,
        normalizationVersion: 'v1',
        tokenizer: 'test',
        tokenizerVersion: 'v1',
        documentInstruction: '',
        queryInstruction: '',
      };
      const profile = await db.embeddingProfile.create({
        data: {
          ...identity,
          fingerprint: embeddingProfileFingerprint(identity),
        },
      });
      profiles.push(profile.id);
      const request: AiRunRequest = {
        userId: user.id,
        documentId: document.id,
        documentVersionId: id,
        correlationId: randomUUID(),
        maxAttempts: 3,
        ...PDF_EXTRACTOR,
        ...CHUNK_STRATEGY,
        chunkSize: 32,
        chunkOverlap: 8,
        embeddingProfileId: profile.id,
        ...settings,
      };
      const run = await repository.requestAiProcessing(request);
      const integrity = await db.processingJob.findFirstOrThrow({
        where: { documentVersionId: id, jobType: 'VERIFY_STORED_FILE' },
      });
      const claimed = await repository.claim(integrity.id, new Date(), 60000);
      const storage: Storage = {
        open: jest.fn(async () => Readable.from([bytes])),
        save: jest.fn(),
        metadata: jest.fn(),
        exists: jest.fn(),
        delete: jest.fn(),
      };
      expect(
        await new StoredFileIntegrityHandler(db, storage, 10000).execute(
          input(claimed),
        ),
      ).toEqual({ kind: 'success' });
      await repository.complete(claimed.id, claimed.leaseToken!, new Date());
      const extraction = await db.processingJob.findFirstOrThrow({
        where: { aiRunId: run.id, jobType: 'EXTRACT_TEXT' },
      });
      if (realPdf) {
        const worker = new ProcessingMessageHandler(repository, [
          new PdfTextExtractionHandler(
            db,
            storage,
            new IsolatedPdfParser(pdfLimits),
            pdfLimits,
          ),
        ]);
        expect(await worker.handle(await envelope(extraction.id), false)).toBe(
          'ack',
        );
      } else {
        const claim = await repository.claim(extraction.id, new Date(), 60000);
        const content = text ?? '';
        await repository.complete(
          claim.id,
          claim.leaseToken!,
          new Date(),
          async (tx) => {
            const artifact = await tx.extractedText.create({
              data: {
                userId: user.id,
                documentId: document.id,
                documentVersionId: id,
                extractionFingerprint: hashText(randomUUID()),
                ...PDF_EXTRACTOR,
                sourceChecksum: stored.checksumSha256,
                contentHash: hashText(content),
                text: content,
                characterCount: [...content].length,
                pageCount: 1,
                pageSpans: [
                  {
                    pageNumber: 1,
                    startOffset: 0,
                    endOffset: [...content].length,
                  },
                ],
                outcome: 'COMPLETED',
              },
            });
            return { extractedTextId: artifact.id };
          },
        );
      }
      const chunkJob = await db.processingJob.findFirstOrThrow({
        where: { aiRunId: run.id, jobType: 'GENERATE_CHUNKS' },
      });
      const worker = new ProcessingMessageHandler(repository, [handler()]);
      return {
        user,
        document,
        version: stored,
        request,
        run,
        chunkJob,
        worker,
        message: await envelope(chunkJob.id),
      };
    }
    it('uses real multi-page PDF extraction, preserves owned citation lineage and schedules embeddings atomically', async () => {
      const f = await fixture(undefined, {}, true);
      expect(await f.worker.handle(f.message, false)).toBe('ack');
      const job = await db.processingJob.findUniqueOrThrow({
        where: { id: f.chunkJob.id },
        include: {
          chunkSet: {
            include: {
              chunks: true,
              extraction: true,
              version: { include: { document: true } },
            },
          },
        },
      });
      expect(job.status).toBe('COMPLETED');
      expect(job.chunkSet).toMatchObject({
        complete: true,
        algorithm: 'qyvra-structural',
        algorithmVersion: 'v1',
        tokenizerVersion: 'tiktoken-1.0.22',
        userId: f.user.id,
      });
      expect(job.chunkSet!.version.document.id).toBe(f.document.id);
      expect(
        job.chunkSet!.chunks.flatMap((c) =>
          (c.pageSpans as { pageNumber: number }[]).map((p) => p.pageNumber),
        ),
      ).toContain(2);
      for (const c of job.chunkSet!.chunks) {
        expect(c.documentVersionId).toBe(f.version.id);
        expect(c.userId).toBe(f.user.id);
        expect(c.text).toBe(
          [...job.chunkSet!.extraction.text]
            .slice(c.startOffset, c.endOffset)
            .join(''),
        );
        expect(c.textHash).toBe(hashText(c.text));
      }
      const next = await db.processingJob.findFirstOrThrow({
        where: { aiRunId: f.run.id, jobType: 'GENERATE_EMBEDDINGS' },
      });
      expect(next).toMatchObject({
        status: 'PENDING',
        predecessorJobId: job.id,
        chunkSetId: job.chunkSetId,
      });
      expect((await envelope(next.id)).jobType).toBe('GENERATE_EMBEDDINGS');
      expect(
        await db.chunkEmbedding.count({
          where: { documentVersionId: f.version.id },
        }),
      ).toBe(0);
      expect(
        await db.versionVectorIndex.count({
          where: { documentVersionId: f.version.id },
        }),
      ).toBe(0);
    });
    it('makes concurrent duplicate delivery and completion/redelivery reuse one complete set and successor', async () => {
      const f = await fixture();
      await Promise.all([
        f.worker.handle(f.message, false),
        f.worker.handle(f.message, true),
      ]);
      expect(await f.worker.handle(f.message, true)).toBe('ack');
      const job = await repository.findById(f.chunkJob.id);
      expect(job).toMatchObject({ status: 'COMPLETED', attempts: 1 });
      await repository.complete(job!.id, randomUUID(), new Date(), async () => {
        throw Error('Must not repeat publication');
      });
      expect(
        await db.chunkSet.count({ where: { documentVersionId: f.version.id } }),
      ).toBe(1);
      expect(
        await db.processingJob.count({
          where: { aiRunId: f.run.id, jobType: 'GENERATE_EMBEDDINGS' },
        }),
      ).toBe(1);
    });
    it('rolls back partial publication and recovers the expired execution without duplicate chunks', async () => {
      const f = await fixture();
      const claim = await repository.claim(f.chunkJob.id, new Date(), 60000);
      const result = await handler().execute(input(claim));
      if (result.kind !== 'success' || !result.commit)
        throw Error('Expected prepared chunks');
      await expect(
        repository.complete(
          claim.id,
          claim.leaseToken!,
          new Date(),
          async (tx, job) => {
            await result.commit!(tx, job);
            throw Error('Crash before stage publication');
          },
        ),
      ).rejects.toThrow('Crash before stage publication');
      expect(
        await db.chunkSet.count({ where: { documentVersionId: f.version.id } }),
      ).toBe(0);
      expect(
        await db.processingJob.count({
          where: { aiRunId: f.run.id, jobType: 'GENERATE_EMBEDDINGS' },
        }),
      ).toBe(0);
      const recovered = await repository.recoverInterrupted(
        claim.id,
        claim.leaseToken!,
        new Date(claim.leaseExpiresAt!.getTime() + 1),
      );
      const now = new Date(recovered.availableAt.getTime() + 1);
      const retry = await repository.claim(claim.id, now, 60000);
      const prepared = await handler().execute(input(retry));
      if (prepared.kind !== 'success') throw Error('Expected recovered chunks');
      await repository.complete(
        retry.id,
        retry.leaseToken!,
        now,
        prepared.commit,
      );
      expect(
        await db.chunkSet.count({ where: { documentVersionId: f.version.id } }),
      ).toBe(1);
      expect(await repository.findById(claim.id)).toMatchObject({
        status: 'COMPLETED',
        attempts: 2,
      });
    });
    it.each([' \n\t'])(
      'does not publish meaningless no-text chunks for %j',
      async (text) => {
        const f = await fixture(text);
        expect(await f.worker.handle(f.message, false)).toBe('ack');
        expect(await repository.findById(f.chunkJob.id)).toMatchObject({
          status: 'FAILED',
          lastFailureCode: 'CHUNK_SOURCE_NO_TEXT',
        });
        expect(
          await db.chunkSet.count({
            where: { documentVersionId: f.version.id },
          }),
        ).toBe(0);
        expect(
          await db.processingJob.count({
            where: { aiRunId: f.run.id, jobType: 'GENERATE_EMBEDDINGS' },
          }),
        ).toBe(0);
      },
    );
    it('classifies unsupported strategy and output limits as terminal without downstream advancement', async () => {
      const f = await fixture('text', { chunkAlgorithmVersion: 'future-v2' });
      await f.worker.handle(f.message, false);
      expect(await repository.findById(f.chunkJob.id)).toMatchObject({
        status: 'FAILED',
        lastFailureCode: 'CHUNK_CONFIGURATION_UNSUPPORTED',
      });
      const g = await fixture();
      await new ProcessingMessageHandler(repository, [
        handler(new DeterministicChunker(1)),
      ]).handle(g.message, false);
      expect(await repository.findById(g.chunkJob.id)).toMatchObject({
        status: 'FAILED',
        lastFailureCode: 'CHUNK_LIMIT_EXCEEDED',
      });
    });
    it('uses durable retries for a transient preparation timeout', async () => {
      const f = await fixture();
      await new ProcessingMessageHandler(repository, [
        handler(new DeterministicChunker(), 0),
      ]).handle(f.message, false);
      expect(await repository.findById(f.chunkJob.id)).toMatchObject({
        status: 'RETRYING',
        lastFailureCode: 'CHUNK_TIMEOUT',
        attempts: 1,
      });
      expect(
        await db.chunkSet.count({ where: { documentVersionId: f.version.id } }),
      ).toBe(0);
    });
    it('keeps Redis failure disposable', async () => {
      const f = await fixture();
      const chunks = new ChunkGenerationHandler(
        db,
        new DeterministicChunker(),
        limits,
        {
          report: jest.fn(async () => {
            throw Error('offline');
          }),
          clear: jest.fn(),
          read: jest.fn(),
        },
      );
      await new ProcessingMessageHandler(repository, [chunks]).handle(
        f.message,
        false,
      );
      expect(await repository.findById(f.chunkJob.id)).toMatchObject({
        status: 'COMPLETED',
      });
    });
    it.each(['archive', 'soft-delete', 'new-version'])(
      'fences %s and ownership changes before work and before final publication',
      async (lifecycle) => {
        const f = await fixture();
        const claim = await repository.claim(f.chunkJob.id, new Date(), 60000);
        expect(
          await handler().execute({
            ...input(claim),
            documentId: randomUUID(),
          }),
        ).toMatchObject({
          kind: 'terminal',
          failureCode: 'CHUNK_SOURCE_INVALID',
        });
        const prepared = await handler().execute(input(claim));
        if (prepared.kind !== 'success') throw Error('Expected chunks');
        if (lifecycle === 'new-version') {
          await db.documentVersion.create({
            data: {
              userId: f.user.id,
              documentId: f.document.id,
              versionNumber: 2,
              originalFilename: 'new.pdf',
              storageKey: `documents/${f.user.id}/${f.document.id}/${randomUUID()}/original.pdf`,
              mimeType: 'application/pdf',
              fileSize: f.version.fileSize,
              checksumSha256: hashText('new-version-bytes'),
              pageCount: 3,
            },
          });
        } else
          await db.document.update({
            where: { id: f.document.id },
            data:
              lifecycle === 'archive'
                ? { isArchived: true, status: 'ARCHIVED' }
                : { deletedAt: new Date(), status: 'DELETING' },
          });
        expect(await handler().execute(input(claim))).toMatchObject({
          kind: 'terminal',
          failureCode: 'DOCUMENT_INELIGIBLE',
        });
        await expect(
          repository.complete(
            claim.id,
            claim.leaseToken!,
            new Date(),
            prepared.commit,
          ),
        ).rejects.toMatchObject({ code: 'INELIGIBLE_DOCUMENT' });
        expect(
          await db.chunkSet.count({
            where: { documentVersionId: f.version.id },
          }),
        ).toBe(0);
      },
    );
    it('publishes a large bounded chunk set as one complete result', async () => {
      const f = await fixture(
        'Some larger synthetic canonical text. '.repeat(120000),
        { chunkSize: 512, chunkOverlap: 64 },
      );
      const began = performance.now();
      const bounded = createPrismaClient({
        url: url!,
        connectTimeoutMs: 2000,
        queryTimeoutMs: 500,
        poolSize: 4,
      });
      try {
        const repo = new ProcessingRepository(bounded);
        const chunks = new ChunkGenerationHandler(
          bounded,
          new DeterministicChunker(),
          limits,
        );
        const claim = await repo.claim(f.chunkJob.id, new Date(), 120000);
        const prepared = await chunks.execute(input(claim));
        if (prepared.kind !== 'success')
          throw Error('Expected prepared large set');
        await repo.complete(
          claim.id,
          claim.leaseToken!,
          new Date(),
          prepared.commit,
        );
      } finally {
        await bounded.$disconnect();
      }
      expect(await repository.findById(f.chunkJob.id)).toMatchObject({
        status: 'COMPLETED',
      });
      const set = await db.chunkSet.findFirstOrThrow({
        where: { documentVersionId: f.version.id },
      });
      expect(set.complete).toBe(true);
      expect(set.chunkCount).toBeGreaterThan(400);
      console.info(
        `T05 large-set publication: chunks=${set.chunkCount} elapsedMs=${Math.floor(performance.now() - began)}`,
      );
    }, 60000);
    it('does not extend the chunk lease when publication exceeds its remaining budget', async () => {
      const f = await fixture();
      const claim = await repository.claim(f.chunkJob.id, new Date(), 60000);
      const prepared = await handler().execute(input(claim));
      if (prepared.kind !== 'success' || !prepared.commit)
        throw Error('Expected prepared chunks');
      await db.processingJob.update({
        where: { id: claim.id },
        data: { leaseExpiresAt: new Date(Date.now() + 100) },
      });
      await expect(
        repository.complete(
          claim.id,
          claim.leaseToken!,
          new Date(),
          async (tx, job) => {
            await tx.$executeRaw`SELECT pg_sleep(0.2)`;
            return prepared.commit!(tx, job);
          },
        ),
      ).rejects.toThrow();
      expect(
        await db.chunkSet.count({ where: { documentVersionId: f.version.id } }),
      ).toBe(0);
      expect(
        await db.processingJob.count({
          where: { aiRunId: f.run.id, jobType: 'GENERATE_EMBEDDINGS' },
        }),
      ).toBe(0);
    });
    it('reuses immutable chunks for identical deliberate runs and retains older provenance when settings change', async () => {
      const f = await fixture();
      await f.worker.handle(f.message, false);
      const original = await repository.findById(f.chunkJob.id);
      async function stopEmbedding(runId: string) {
        const embedding = await db.processingJob.findFirstOrThrow({
          where: { aiRunId: runId, jobType: 'GENERATE_EMBEDDINGS' },
        });
        const claim = await repository.claim(embedding.id, new Date(), 60000);
        await repository.fail(
          claim.id,
          claim.leaseToken!,
          new Date(),
          'HANDLER_NOT_IMPLEMENTED',
          false,
        );
      }
      await stopEmbedding(f.run.id);
      async function reprocess(
        settings: Partial<AiRunRequest>,
        freshText?: string,
      ) {
        const run = await repository.requestAiProcessing(
          { ...f.request, ...settings },
          true,
        );
        const extraction = await db.processingJob.findFirstOrThrow({
          where: { aiRunId: run.id, jobType: 'EXTRACT_TEXT' },
        });
        const claim = await repository.claim(extraction.id, new Date(), 60000);
        await repository.complete(
          claim.id,
          claim.leaseToken!,
          new Date(),
          async (tx) => {
            if (freshText === undefined)
              return { extractedTextId: f.chunkJob.extractedTextId! };
            const artifact = await tx.extractedText.create({
              data: {
                userId: f.user.id,
                documentId: f.document.id,
                documentVersionId: f.version.id,
                extractionFingerprint: hashText(
                  JSON.stringify(['test-reextraction', run.extractorVersion]),
                ),
                extractor: run.extractor,
                extractorVersion: run.extractorVersion,
                normalizationVersion: run.normalizationVersion,
                sourceChecksum: f.version.checksumSha256,
                contentHash: hashText(freshText),
                text: freshText,
                characterCount: [...freshText].length,
                pageCount: 1,
                pageSpans: [
                  {
                    pageNumber: 1,
                    startOffset: 0,
                    endOffset: [...freshText].length,
                  },
                ],
                outcome: 'COMPLETED',
              },
            });
            return { extractedTextId: artifact.id };
          },
        );
        const chunks = await db.processingJob.findFirstOrThrow({
          where: { aiRunId: run.id, jobType: 'GENERATE_CHUNKS' },
        });
        await f.worker.handle(await envelope(chunks.id), false);
        return { run, job: await repository.findById(chunks.id) };
      }
      const identical = await reprocess({});
      expect(identical.job!.chunkSetId).toBe(original!.chunkSetId);
      await stopEmbedding(identical.run.id);
      const changed = await reprocess({ chunkSize: 64, chunkOverlap: 0 });
      expect(changed.job!.chunkSetId).not.toBe(original!.chunkSetId);
      expect(
        await db.chunkSet.count({
          where: { documentVersionId: f.version.id, complete: true },
        }),
      ).toBe(2);
      const next = await db.processingJob.findFirstOrThrow({
        where: { aiRunId: changed.run.id, jobType: 'GENERATE_EMBEDDINGS' },
      });
      expect(next.chunkSetId).toBe(changed.job!.chunkSetId);
      expect(
        await db.documentChunk.count({
          where: { chunkSetId: original!.chunkSetId! },
        }),
      ).toBeGreaterThan(0);
      await stopEmbedding(changed.run.id);
      const fresh = await reprocess(
        { extractorVersion: 'future-parser-v2' },
        'New canonical extraction after a parser upgrade.',
      );
      expect(fresh.job).toMatchObject({ status: 'COMPLETED' });
      expect(fresh.job!.chunkSetId).not.toBe(original!.chunkSetId);
      expect(
        await db.chunkSet.count({
          where: { documentVersionId: f.version.id, complete: true },
        }),
      ).toBe(3);
    });
    it('rejects changed or missing canonical source, and mismatched upstream prerequisite, without publishing', async () => {
      const f = await fixture();
      const claim = await repository.claim(f.chunkJob.id, new Date(), 60000);
      // Corruption is blocked by SQL; simulate damaged read results at the repository boundary.
      const original = await db.processingJob.findUniqueOrThrow({
        where: { id: claim.id },
        include: {
          document: true,
          version: { include: { aiState: true } },
          aiRun: true,
          predecessor: true,
          extraction: true,
        },
      });
      const corrupted = { ...original, extraction: null };
      const spy = jest
        .spyOn(db.processingJob, 'findUnique')
        .mockResolvedValueOnce(corrupted);
      try {
        expect(await handler().execute(input(claim))).toMatchObject({
          kind: 'terminal',
          failureCode: 'CHUNK_SOURCE_INVALID',
        });
      } finally {
        spy.mockRestore();
      }
      const missing = { ...original, predecessor: null };
      const second = jest
        .spyOn(db.processingJob, 'findUnique')
        .mockResolvedValueOnce(missing);
      try {
        expect(await handler().execute(input(claim))).toMatchObject({
          kind: 'terminal',
          failureCode: 'CHUNK_PREREQUISITE_MISSING',
        });
      } finally {
        second.mockRestore();
      }
    });
    (process.env.TEST_RABBITMQ_URL ? it : it.skip)(
      'routes duplicate real RabbitMQ chunk messages through one durable publication',
      async () => {
        const f = await fixture();
        const consumer = new RabbitMqConsumer(f.worker, {
          url: process.env.TEST_RABBITMQ_URL,
          connectTimeoutMs: 3000,
          prefetch: 2,
          reconnectDelayMs: 100,
          shutdownTimeoutMs: 1000,
        });
        const publisher = new RabbitMqPublisher({
          url: process.env.TEST_RABBITMQ_URL,
          connectTimeoutMs: 3000,
          confirmTimeoutMs: 5000,
        });
        try {
          await consumer.start();
          await Promise.all([
            publisher.publishProcessing(f.message),
            publisher.publishProcessing(f.message),
          ]);
          for (
            let i = 0;
            i < 100 &&
            (await repository.findById(f.chunkJob.id))?.status !== 'COMPLETED';
            i++
          )
            await new Promise((resolve) => setTimeout(resolve, 50));
          expect(await repository.findById(f.chunkJob.id)).toMatchObject({
            status: 'COMPLETED',
            attempts: 1,
          });
          expect(
            await db.chunkSet.count({
              where: { documentVersionId: f.version.id },
            }),
          ).toBe(1);
        } finally {
          await consumer.stop();
          await publisher.onApplicationShutdown();
        }
      },
    );
  },
);
