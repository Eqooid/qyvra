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
import { Storage, StorageError } from '@qyvra/storage';
import {
  IsolatedPdfParser,
  PDF_EXTRACTOR,
} from '../src/infrastructure/extraction/pdf-parser';
import { PdfTextExtractionHandler } from '../src/infrastructure/worker/pdf-text-extraction.handler';
import { StoredFileIntegrityHandler } from '../src/infrastructure/worker/stored-file-integrity.handler';
import { ProcessingMessageHandler } from '../src/infrastructure/worker/processing-message-handler';
import { RabbitMqConsumer } from '../src/infrastructure/messaging/rabbitmq.consumer';
import { RabbitMqPublisher } from '../src/infrastructure/messaging/rabbitmq.publisher';

const url = process.env.TEST_DATABASE_URL;
const limits = {
  maxBytes: 52428800,
  maxPages: 500,
  maxCharacters: 5000000,
  maxTextBytes: 20000000,
  timeoutMs: 10000,
  heapMb: 256,
};
(url ? describe : describe.skip)(
  'durable PDF extraction (real PostgreSQL and parser)',
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
    async function fixture(file = 'single.pdf', mimeType = 'application/pdf') {
      const bytes = await readFile(resolve(__dirname, 'fixtures/pdf', file));
      const user = await db.user.create({
        data: { email: `${randomUUID()}@example.invalid` },
      });
      users.push(user.id);
      const document = await db.document.create({
        data: { userId: user.id, title: 'PDF extraction test' },
      });
      const id = randomUUID();
      const version = await db.documentVersion.create({
        data: {
          id,
          userId: user.id,
          documentId: document.id,
          versionNumber: 1,
          originalFilename: file,
          storageKey: `documents/${user.id}/${document.id}/${id}/original.pdf`,
          mimeType,
          fileSize: bytes.length,
          pageCount: mimeType === 'application/pdf' ? 1 : null,
          checksumSha256: createHash('sha256').update(bytes).digest('hex'),
        },
      });
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
        documentVersionId: version.id,
        correlationId: randomUUID(),
        maxAttempts: 3,
        ...PDF_EXTRACTOR,
        chunkAlgorithm: 'planned',
        chunkAlgorithmVersion: 'v1',
        tokenizer: 'planned',
        tokenizerVersion: 'v1',
        chunkSize: 512,
        chunkOverlap: 64,
        embeddingProfileId: profile.id,
      };
      const run = await repository.requestAiProcessing(request);
      const storage: Storage = {
        open: jest.fn(async () => Readable.from([bytes])),
        save: jest.fn(),
        metadata: jest.fn(),
        exists: jest.fn(),
        delete: jest.fn(),
      };
      const verification = await db.processingJob.findFirstOrThrow({
        where: { documentVersionId: id, jobType: 'VERIFY_STORED_FILE' },
      });
      expect(
        await db.processingJob.count({
          where: { aiRunId: run.id, jobType: 'EXTRACT_TEXT' },
        }),
      ).toBe(0);
      const claim = await repository.claim(verification.id, new Date(), 60000);
      expect(
        await new StoredFileIntegrityHandler(db, storage, 10000).execute({
          jobId: claim.id,
          documentId: document.id,
          documentVersionId: id,
          leaseToken: claim.leaseToken!,
          attempt: claim.attempts,
        }),
      ).toEqual({ kind: 'success' });
      await repository.complete(claim.id, claim.leaseToken!, new Date());
      const extraction = await db.processingJob.findFirstOrThrow({
        where: { aiRunId: run.id, jobType: 'EXTRACT_TEXT' },
      });
      const outbox = await db.processingOutbox.findFirstOrThrow({
        where: { processingJobId: extraction.id },
      });
      const message = outbox.payload as unknown as ProcessingMessage;
      const parser = new IsolatedPdfParser(limits);
      const handler = new PdfTextExtractionHandler(db, storage, parser, limits);
      const worker = new ProcessingMessageHandler(repository, [handler]);
      return {
        bytes,
        user,
        document,
        version,
        run,
        request,
        storage,
        extraction,
        message,
        parser,
        handler,
        worker,
      };
    }
    (process.env.TEST_RABBITMQ_URL ? it : it.skip)(
      'routes duplicate v2 extraction envelopes through real RabbitMQ into the durable handler',
      async () => {
        const f = await fixture();
        const brokerUrl = process.env.TEST_RABBITMQ_URL;
        const consumer = new RabbitMqConsumer(f.worker, {
          url: brokerUrl,
          connectTimeoutMs: 3000,
          prefetch: 2,
          reconnectDelayMs: 100,
          shutdownTimeoutMs: 1000,
        });
        const publisher = new RabbitMqPublisher({
          url: brokerUrl,
          connectTimeoutMs: 3000,
          confirmTimeoutMs: 5000,
        });
        try {
          await consumer.start();
          // These identifiers are loaded from the transactionally persisted outbox.
          await Promise.all([
            publisher.publishProcessing(f.message),
            publisher.publishProcessing(f.message),
          ]);
          for (let index = 0; index < 100; index++) {
            if (
              (await repository.findById(f.extraction.id))?.status ===
              'COMPLETED'
            )
              break;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          expect(await repository.findById(f.extraction.id)).toMatchObject({
            status: 'COMPLETED',
            attempts: 1,
          });
          expect(
            await db.extractedText.count({
              where: { documentVersionId: f.version.id },
            }),
          ).toBe(1);
          expect(
            await db.processingJob.count({
              where: { aiRunId: f.run.id, jobType: 'GENERATE_CHUNKS' },
            }),
          ).toBe(1);
        } finally {
          await consumer.stop();
          await publisher.onApplicationShutdown();
        }
      },
    );
    it('persists canonical content, provenance and completion atomically; duplicate concurrent delivery schedules one chunk job', async () => {
      const f = await fixture('multi.pdf');
      const decisions = await Promise.all([
        f.worker.handle(f.message, false),
        f.worker.handle(f.message, true),
      ]);
      expect(decisions).toContain('ack');
      expect(await f.worker.handle(f.message, true)).toBe('ack');
      const job = await repository.findById(f.extraction.id);
      expect(job).toMatchObject({ status: 'COMPLETED', attempts: 1 });
      const content = await db.extractedText.findUniqueOrThrow({
        where: { id: job!.extractedTextId! },
      });
      expect(content).toMatchObject({
        ...PDF_EXTRACTOR,
        documentVersionId: f.version.id,
        documentId: f.document.id,
        userId: f.user.id,
        sourceChecksum: f.version.checksumSha256,
        text: 'First page\n\n\n\nThird page',
        characterCount: 24,
        pageCount: 3,
      });
      expect(content.contentHash).toBe(
        createHash('sha256').update(content.text).digest('hex'),
      );
      expect(content.pageSpans).toEqual([
        { pageNumber: 1, startOffset: 0, endOffset: 10 },
        { pageNumber: 2, startOffset: 12, endOffset: 12 },
        { pageNumber: 3, startOffset: 14, endOffset: 24 },
      ]);
      expect(
        await db.documentVersion.findUnique({ where: { id: f.version.id } }),
      ).toMatchObject({ extractionStatus: 'COMPLETED' });
      const chunks = await db.processingJob.findMany({
        where: { aiRunId: f.run.id, jobType: 'GENERATE_CHUNKS' },
        include: { outbox: true },
      });
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toMatchObject({
        extractedTextId: content.id,
        predecessorJobId: job!.id,
      });
      expect(chunks[0].outbox).toHaveLength(1);
      expect(
        await db.chunkSet.count({ where: { documentVersionId: f.version.id } }),
      ).toBe(0);
      expect(
        await db.extractedText.count({
          where: { documentVersionId: f.version.id },
        }),
      ).toBe(1);
      // A retry of the completion transaction cannot insert another artifact or intent.
      await repository.complete(job!.id, randomUUID(), new Date(), async () => {
        throw Error('Must not execute committed callback');
      });
    });
    it.each([
      ['empty.pdf', 'application/pdf', 'OCR_REQUIRED', 'UNSUPPORTED'],
      ['graphics.pdf', 'application/pdf', 'OCR_REQUIRED', 'UNSUPPORTED'],
      ['image-only.pdf', 'application/pdf', 'OCR_REQUIRED', 'UNSUPPORTED'],
      ['encrypted.pdf', 'application/pdf', 'PDF_ENCRYPTED', 'UNSUPPORTED'],
      ['malformed.pdf', 'application/pdf', 'PDF_MALFORMED', 'FAILED'],
      ['single.pdf', 'image/png', 'UNSUPPORTED_FORMAT', 'UNSUPPORTED'],
    ])(
      'stops %s without artifacts or downstream work',
      async (file, mime, code, status) => {
        const f = await fixture(file, mime);
        expect(await f.worker.handle(f.message, false)).toBe('ack');
        expect(await repository.findById(f.extraction.id)).toMatchObject({
          status: 'FAILED',
          lastFailureCode: code,
          attempts: 1,
        });
        expect(
          await db.aiProcessingRun.findUnique({ where: { id: f.run.id } }),
        ).toMatchObject({ status: 'FAILED', lastFailureCode: code });
        expect(
          await db.documentVersion.findUnique({ where: { id: f.version.id } }),
        ).toMatchObject({ extractionStatus: status });
        expect(
          await db.extractedText.count({
            where: { documentVersionId: f.version.id },
          }),
        ).toBe(0);
        expect(
          await db.processingJob.count({
            where: { aiRunId: f.run.id, jobType: 'GENERATE_CHUNKS' },
          }),
        ).toBe(0);
      },
    );
    it('bounds a stalled storage open and destroys a stream arriving after timeout', async () => {
      const f = await fixture();
      const source = Readable.from([f.bytes]);
      jest
        .spyOn(f.storage, 'open')
        .mockImplementation(
          () =>
            new Promise((resolve) => setTimeout(() => resolve(source), 700)),
        );
      const claim = await repository.claim(f.extraction.id, new Date(), 60000);
      const handler = new PdfTextExtractionHandler(db, f.storage, f.parser, {
        ...limits,
        timeoutMs: 500,
      });
      expect(
        await handler.execute({
          jobId: claim.id,
          documentId: f.document.id,
          documentVersionId: f.version.id,
          leaseToken: claim.leaseToken!,
          attempt: claim.attempts,
        }),
      ).toEqual({ kind: 'retryable', failureCode: 'STORAGE_READ_FAILED' });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(source.destroyed).toBe(true);
    });
    it('publishes only one artifact for repeated simultaneous handler executions', async () => {
      const f = await fixture();
      const claim = await repository.claim(f.extraction.id, new Date(), 60000);
      const input = {
        jobId: claim.id,
        documentId: f.document.id,
        documentVersionId: f.version.id,
        leaseToken: claim.leaseToken!,
        attempt: claim.attempts,
      };
      const outputs = await Promise.all([
        f.handler.execute(input),
        f.handler.execute(input),
      ]);
      for (const result of outputs) {
        expect(result.kind).toBe('success');
        if (result.kind !== 'success') throw Error();
        await repository.complete(
          claim.id,
          claim.leaseToken!,
          new Date(),
          result.commit,
        );
      }
      expect(
        await db.extractedText.count({
          where: { documentVersionId: f.version.id },
        }),
      ).toBe(1);
      expect(
        await db.processingJob.count({
          where: { aiRunId: f.run.id, jobType: 'GENERATE_CHUNKS' },
        }),
      ).toBe(1);
    });
    it('does not read source bytes for forged ownership or lifecycle-ineligible work', async () => {
      const f = await fixture();
      const claim = await repository.claim(f.extraction.id, new Date(), 60000);
      const open = jest.spyOn(f.storage, 'open');
      open.mockClear();
      const input = {
        jobId: claim.id,
        documentId: f.document.id,
        documentVersionId: f.version.id,
        leaseToken: claim.leaseToken!,
        attempt: claim.attempts,
      };
      expect(
        await f.handler.execute({ ...input, documentId: randomUUID() }),
      ).toEqual({ kind: 'terminal', failureCode: 'EXTRACTION_SOURCE_INVALID' });
      await db.document.update({
        where: { id: f.document.id },
        data: { deletedAt: new Date() },
      });
      expect(await f.handler.execute(input)).toEqual({
        kind: 'terminal',
        failureCode: 'DOCUMENT_INELIGIBLE',
      });
      expect(open).not.toHaveBeenCalled();
    });
    it('never publishes partial output after a configured extraction limit', async () => {
      const f = await fixture('multi.pdf');
      const handler = new PdfTextExtractionHandler(
        db,
        f.storage,
        new IsolatedPdfParser({ ...limits, maxPages: 1 }),
        limits,
      );
      expect(
        await new ProcessingMessageHandler(repository, [handler]).handle(
          f.message,
          false,
        ),
      ).toBe('ack');
      expect(await repository.findById(f.extraction.id)).toMatchObject({
        status: 'FAILED',
        lastFailureCode: 'EXTRACTION_LIMIT_EXCEEDED',
      });
      expect(
        await db.extractedText.count({
          where: { documentVersionId: f.version.id },
        }),
      ).toBe(0);
      expect(
        await db.processingJob.count({
          where: { aiRunId: f.run.id, jobType: 'GENERATE_CHUNKS' },
        }),
      ).toBe(0);
    });
    it('uses existing bounded retry and recovery after a temporary storage failure', async () => {
      const f = await fixture();
      jest
        .spyOn(f.storage, 'open')
        .mockRejectedValueOnce(new StorageError('UNAVAILABLE'));
      expect(await f.worker.handle(f.message, false)).toBe('ack');
      const failed = await repository.findById(f.extraction.id);
      expect(failed).toMatchObject({
        status: 'RETRYING',
        lastFailureCode: 'STORAGE_READ_FAILED',
      });
      const at = new Date(failed!.availableAt.getTime() + 1);
      await repository.scheduleRetryDispatch(failed!.id, at);
      const recovered = await repository.claim(failed!.id, at, 60000);
      const result = await f.handler.execute({
        jobId: recovered.id,
        documentId: f.document.id,
        documentVersionId: f.version.id,
        leaseToken: recovered.leaseToken!,
        attempt: recovered.attempts,
      });
      expect(result.kind).toBe('success');
      if (result.kind !== 'success') throw Error('Expected extraction');
      await repository.complete(
        recovered.id,
        recovered.leaseToken!,
        at,
        result.commit,
      );
      expect(await repository.findById(recovered.id)).toMatchObject({
        status: 'COMPLETED',
        attempts: 2,
      });
    });
    it('treats missing storage and changed source bytes as permanent failures', async () => {
      for (const missing of [true, false]) {
        const f = await fixture();
        if (missing)
          jest
            .spyOn(f.storage, 'open')
            .mockRejectedValue(new StorageError('NOT_FOUND'));
        else
          jest
            .spyOn(f.storage, 'open')
            .mockResolvedValue(
              Readable.from([Buffer.alloc(f.bytes.length, 0)]),
            );
        await f.worker.handle(f.message, false);
        expect(await repository.findById(f.extraction.id)).toMatchObject({
          status: 'FAILED',
          lastFailureCode: missing
            ? 'FILE_NOT_FOUND'
            : 'FILE_CHECKSUM_MISMATCH',
        });
      }
    });
    it('rolls back artifact publication if lifecycle changes after parsing and before completion', async () => {
      const f = await fixture();
      const claimed = await repository.claim(
        f.extraction.id,
        new Date(),
        60000,
      );
      const result = await f.handler.execute({
        jobId: claimed.id,
        documentId: f.document.id,
        documentVersionId: f.version.id,
        leaseToken: claimed.leaseToken!,
        attempt: claimed.attempts,
      });
      expect(result.kind).toBe('success');
      if (result.kind !== 'success') throw Error();
      await db.document.update({
        where: { id: f.document.id },
        data: { isArchived: true, status: 'ARCHIVED' },
      });
      await expect(
        repository.complete(
          claimed.id,
          claimed.leaseToken!,
          new Date(),
          result.commit,
        ),
      ).rejects.toThrow();
      expect(
        await db.extractedText.count({
          where: { documentVersionId: f.version.id },
        }),
      ).toBe(0);
      expect(
        await f.handler.execute({
          jobId: claimed.id,
          documentId: f.document.id,
          documentVersionId: f.version.id,
          leaseToken: claimed.leaseToken!,
          attempt: claimed.attempts,
        }),
      ).toMatchObject({ kind: 'terminal', failureCode: 'DOCUMENT_INELIGIBLE' });
    });
    it('reuses immutable content on intentional reprocessing and cascades only subordinate records on deletion', async () => {
      const f = await fixture();
      await f.worker.handle(f.message, false);
      const artifact = await db.extractedText.findFirstOrThrow({
        where: { documentVersionId: f.version.id },
      });
      const chunk = await db.processingJob.findFirstOrThrow({
        where: { aiRunId: f.run.id, jobType: 'GENERATE_CHUNKS' },
      });
      const claim = await repository.claim(chunk.id, new Date(), 60000);
      await repository.fail(
        claim.id,
        claim.leaseToken!,
        new Date(),
        'HANDLER_NOT_IMPLEMENTED',
        false,
      );
      const run = await repository.requestAiProcessing(f.request, true);
      const extraction = await db.processingJob.findFirstOrThrow({
        where: { aiRunId: run.id, jobType: 'EXTRACT_TEXT' },
      });
      const reclaimed = await repository.claim(
        extraction.id,
        new Date(),
        60000,
      );
      const parse = jest.spyOn(f.parser, 'parse');
      const open = jest.spyOn(f.storage, 'open');
      open.mockClear();
      const result = await f.handler.execute({
        jobId: reclaimed.id,
        documentId: f.document.id,
        documentVersionId: f.version.id,
        leaseToken: reclaimed.leaseToken!,
        attempt: reclaimed.attempts,
      });
      expect(result.kind).toBe('success');
      if (result.kind !== 'success') throw Error();
      await repository.complete(
        reclaimed.id,
        reclaimed.leaseToken!,
        new Date(),
        result.commit,
      );
      expect(parse).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      expect(await repository.findById(reclaimed.id)).toMatchObject({
        extractedTextId: artifact.id,
      });
      expect(
        await db.extractedText.count({
          where: { documentVersionId: f.version.id },
        }),
      ).toBe(1);
      await db.document.delete({ where: { id: f.document.id } });
      expect(
        await db.extractedText.findUnique({ where: { id: artifact.id } }),
      ).toBeNull();
      expect(
        await db.user.findUnique({ where: { id: f.user.id } }),
      ).not.toBeNull();
    });
  },
);
