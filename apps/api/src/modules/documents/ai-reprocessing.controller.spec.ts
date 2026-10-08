import { ValidationPipe } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  AiReprocessingController,
  AiReprocessingDto,
} from './ai-reprocessing.controller';
import { AiIngestionService } from '../ai/ai-ingestion.service';
import type { AuthenticatedUser } from '../auth';

describe('owned AI reprocessing contract', () => {
  const reprocess = jest.fn();
  const controller = new AiReprocessingController({
    reprocess,
  } as unknown as AiIngestionService);
  const user = { id: randomUUID() } as AuthenticatedUser;
  const document = randomUUID(),
    version = randomUUID();
  const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  it('accepts only bounded stage modes and rejects ownership/provider configuration injection', async () => {
    const metadata = { type: 'body' as const, metatype: AiReprocessingDto };
    expect(await pipe.transform({}, metadata)).toMatchObject({
      mode: 'repair',
    });
    for (const body of [
      { mode: 'rag' },
      { userId: randomUUID() },
      { provider: 'external' },
      { mode: 'index', fingerprint: 'x' },
    ])
      await expect(pipe.transform(body, metadata)).rejects.toThrow();
  });
  it('requires UUIDv4 key and derives ownership from the authenticated context', () => {
    expect(() =>
      controller.reprocess(
        user,
        document,
        version,
        'bad-key',
        new AiReprocessingDto(),
      ),
    ).toThrow();
    const key = randomUUID();
    controller.reprocess(user, document, version, key, new AiReprocessingDto());
    expect(reprocess).toHaveBeenCalledWith(
      user.id,
      document,
      version,
      'repair',
      key,
    );
  });
});
