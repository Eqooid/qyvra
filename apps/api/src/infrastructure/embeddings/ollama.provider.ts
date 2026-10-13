import type { ApiConfiguration } from '../../configuration/settings';
import {
  EmbeddingFailure,
  embeddingText,
  validateEmbeddingResults,
  type EmbeddingProvider,
  type EmbeddingRequest,
  type EmbeddingResult,
} from '../../modules/ai/embedding-provider';
import { LocalEmbeddingTokenizer, object } from './local-tokenizer';

/** Native Ollama, one bounded attempt; durable retries stay in PostgreSQL. */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private readonly config: ApiConfiguration['embedding'],
    private readonly tokenizer: LocalEmbeddingTokenizer | undefined,
    private readonly transport: typeof fetch = fetch,
  ) {}

  async embed(request: EmbeddingRequest): Promise<readonly EmbeddingResult[]> {
    const { profile, inputs, purpose } = request;
    const tokenizer = this.tokenizer;
    if (!this.config.enabled || !this.config.endpoint || !tokenizer)
      throw new EmbeddingFailure('EMBEDDING_NOT_CONFIGURED');
    if (
      profile.provider !== 'ollama' ||
      !/^sha256:[a-f0-9]{64}$/.test(profile.modelRevision)
    )
      throw new EmbeddingFailure('EMBEDDING_PROFILE_UNSUPPORTED');
    tokenizer.validate(profile);
    let endpoint: URL;
    try {
      endpoint = new URL(this.config.endpoint);
      if (
        !endpoint.pathname.endsWith('/api/embed') ||
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash ||
        !['http:', 'https:'].includes(endpoint.protocol)
      )
        throw Error();
    } catch {
      throw new EmbeddingFailure('EMBEDDING_NOT_CONFIGURED');
    }
    if (
      !inputs.length ||
      inputs.length > this.config.batchSize ||
      new Set(inputs.map((input) => input.id)).size !== inputs.length
    )
      throw new EmbeddingFailure('EMBEDDING_INVALID_INPUT');
    const text = inputs.map((input) =>
      embeddingText(input.text, profile, purpose),
    );
    const counts = text.map((input) => tokenizer.count(input));
    const total = counts.reduce((sum, count) => sum + count, 0);
    if (
      counts.some((count) => count > this.config.maxInputTokens) ||
      total > this.config.maxBatchTokens
    )
      throw new EmbeddingFailure('EMBEDDING_INPUT_LIMIT');
    const abort = new AbortController();
    const cancel = () => abort.abort();
    request.signal.addEventListener('abort', cancel, { once: true });
    if (request.signal.aborted) abort.abort();
    const timer = setTimeout(cancel, this.config.timeoutMs);
    const tags = new URL(endpoint);
    tags.pathname = endpoint.pathname.slice(0, -'embed'.length) + 'tags';
    const modelName = profile.model.includes(':')
      ? profile.model
      : `${profile.model}:latest`;
    const verifyDigest = async () => {
      const body = await this.json(
        tags.toString(),
        { method: 'GET', signal: abort.signal },
        4000000,
      );
      if (!object(body) || !Array.isArray(body.models))
        throw new EmbeddingFailure('EMBEDDING_INVALID_OUTPUT');
      const models = body.models.filter(
        (model: unknown) =>
          object(model) &&
          (model.name === modelName || model.model === modelName),
      );
      if (
        models.length !== 1 ||
        !object(models[0]) ||
        models[0].digest !== profile.modelRevision.slice('sha256:'.length)
      )
        throw new EmbeddingFailure('EMBEDDING_MODEL_REVISION_MISMATCH');
    };
    try {
      await verifyDigest();
      const body = await this.json(
        endpoint.toString(),
        {
          method: 'POST',
          signal: abort.signal,
          body: JSON.stringify({
            model: profile.model,
            input: text,
            truncate: false,
            ...(this.config.sendDimensions
              ? { dimensions: profile.dimensions }
              : {}),
          }),
        },
        Math.min(32000000, inputs.length * profile.dimensions * 32 + 65536),
      );
      if (
        !object(body) ||
        (body.model !== profile.model && body.model !== modelName) ||
        !Array.isArray(body.embeddings) ||
        body.embeddings.length !== inputs.length ||
        !Number.isSafeInteger(body.prompt_eval_count) ||
        body.prompt_eval_count !== total
      )
        throw new EmbeddingFailure('EMBEDDING_INVALID_OUTPUT');
      const results = validateEmbeddingResults(
        inputs,
        body.embeddings.map((vector: unknown, index: number) => ({
          id: inputs[index].id,
          vector: vector as number[],
        })),
        profile.dimensions,
      );
      // Detect replacement during inference before publishing any new checkpoint.
      await verifyDigest();
      return results;
    } catch (error) {
      if (error instanceof EmbeddingFailure) throw error;
      throw new EmbeddingFailure(
        abort.signal.aborted ? 'EMBEDDING_TIMEOUT' : 'EMBEDDING_NETWORK',
        true,
      );
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', cancel);
    }
  }

  private async json(
    url: string,
    init: RequestInit,
    maxBytes: number,
  ): Promise<unknown> {
    const response = await this.transport(url, {
      ...init,
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        ...(this.config.apiKey
          ? { Authorization: `Bearer ${this.config.apiKey}` }
          : {}),
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      const retryable =
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500;
      const raw = response.headers.get('retry-after');
      const delay =
        raw && /^\d+(\.\d+)?$/.test(raw)
          ? Number(raw) * 1000
          : raw
            ? Date.parse(raw) - Date.now()
            : 0;
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
    const reader = response.body?.getReader();
    if (!reader) throw new EmbeddingFailure('EMBEDDING_INVALID_OUTPUT');
    const parts: Uint8Array[] = [];
    let bytes = 0;
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
    try {
      return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown;
    } catch {
      throw new EmbeddingFailure('EMBEDDING_INVALID_OUTPUT');
    }
  }
}
