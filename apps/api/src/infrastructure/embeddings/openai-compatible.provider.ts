import { get_encoding } from 'tiktoken';
import type { ApiConfiguration } from '../../configuration/settings';
import {
  EmbeddingFailure,
  embeddingText,
  validateEmbeddingResults,
  type EmbeddingProvider,
  type EmbeddingRequest,
  type EmbeddingResult,
} from '../../modules/ai/embedding-provider';

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One HTTP attempt; PostgreSQL, not this adapter, schedules retries. */
export class OpenAiCompatibleEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private readonly config: ApiConfiguration['embedding'],
    private readonly transport: typeof fetch = fetch,
  ) {}

  async embed(request: EmbeddingRequest): Promise<readonly EmbeddingResult[]> {
    const { profile, inputs, purpose, signal } = request;
    if (!this.config.enabled || !this.config.endpoint)
      throw new EmbeddingFailure('EMBEDDING_NOT_CONFIGURED');
    if (
      profile.provider !== 'openai-compatible' ||
      profile.tokenizer !== 'cl100k_base' ||
      profile.tokenizerVersion !== 'tiktoken-1.0.22'
    )
      throw new EmbeddingFailure('EMBEDDING_PROFILE_UNSUPPORTED');
    if (
      !inputs.length ||
      inputs.length > this.config.batchSize ||
      new Set(inputs.map((input) => input.id)).size !== inputs.length
    )
      throw new EmbeddingFailure('EMBEDDING_INVALID_INPUT');
    const text = inputs.map((input) =>
      embeddingText(input.text, profile, purpose),
    );
    const tokenizer = get_encoding('cl100k_base');
    try {
      let total = 0;
      for (const input of text) {
        const count = tokenizer.encode(input, [], []).length;
        if (count > this.config.maxInputTokens)
          throw new EmbeddingFailure('EMBEDDING_INPUT_LIMIT');
        total += count;
      }
      if (total > this.config.maxBatchTokens)
        throw new EmbeddingFailure('EMBEDDING_INPUT_LIMIT');
    } finally {
      tokenizer.free();
    }
    try {
      const response = await this.transport(this.config.endpoint, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.apiKey
            ? { Authorization: `Bearer ${this.config.apiKey}` }
            : {}),
        },
        body: JSON.stringify({
          model: profile.model,
          input: text,
          encoding_format: 'float',
          ...(this.config.sendDimensions
            ? { dimensions: profile.dimensions }
            : {}),
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        const retryable =
          response.status === 429 ||
          response.status === 408 ||
          response.status >= 500;
        const raw = response.headers.get('retry-after');
        const delay =
          raw === null
            ? 0
            : /^\d+(\.\d+)?$/.test(raw)
              ? Number(raw) * 1000
              : Date.parse(raw) - Date.now();
        throw new EmbeddingFailure(
          response.status === 429
            ? 'EMBEDDING_RATE_LIMITED'
            : retryable
              ? 'EMBEDDING_PROVIDER_UNAVAILABLE'
              : response.status === 401 || response.status === 403
                ? 'EMBEDDING_AUTH_FAILED'
                : 'EMBEDDING_REQUEST_REJECTED',
          retryable,
          Number.isFinite(delay) && delay > 0
            ? Math.min(delay, 3600000)
            : undefined,
        );
      }
      // Bound even a chunked/malicious response; the same signal covers body reads.
      const reader = response.body?.getReader();
      if (!reader) throw new EmbeddingFailure('EMBEDDING_INVALID_OUTPUT');
      const parts: Uint8Array[] = [];
      let bytes = 0;
      const maxBytes = Math.min(
        32000000,
        inputs.length * profile.dimensions * 32 + 65536,
      );
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > maxBytes)
            throw new EmbeddingFailure('EMBEDDING_OUTPUT_LIMIT');
          parts.push(part.value);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(parts).toString('utf8'));
      } catch {
        throw new EmbeddingFailure('EMBEDDING_INVALID_OUTPUT');
      }
      if (
        !object(body) ||
        body.model !== profile.model ||
        !Array.isArray(body.data) ||
        body.data.length !== inputs.length
      )
        throw new EmbeddingFailure('EMBEDDING_INVALID_OUTPUT');
      const mapped: EmbeddingResult[] = body.data.map((item: unknown) => {
        if (
          !object(item) ||
          typeof item.index !== 'number' ||
          !Number.isInteger(item.index) ||
          item.index < 0 ||
          item.index >= inputs.length ||
          !Array.isArray(item.embedding)
        )
          throw new EmbeddingFailure('EMBEDDING_INVALID_OUTPUT');
        // Numeric validation is performed on every element at the owned boundary.
        return {
          id: inputs[item.index].id,
          vector: item.embedding as number[],
        };
      });
      return validateEmbeddingResults(inputs, mapped, profile.dimensions);
    } catch (error) {
      if (error instanceof EmbeddingFailure) throw error;
      throw new EmbeddingFailure(
        signal.aborted ? 'EMBEDDING_TIMEOUT' : 'EMBEDDING_NETWORK',
        true,
      );
    }
  }
}
