import type { ApiConfiguration } from '../../configuration/settings';
import {
  GenerationFailure,
  RAG_OUTPUT_SCHEMA,
  type GenerationMessage,
  type GenerationProvider,
  type GenerationRequest,
  type GenerationResult,
} from '../../modules/ai/generation-provider';
import { LocalGenerationTokenizer } from './local-tokenizer';

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function modelName(name: string): string {
  return name.includes(':') ? name : `${name}:latest`;
}

/** Native, schema-constrained Ollama chat; one attempt, no tools or model management. */
export class OllamaGenerationProvider implements GenerationProvider {
  private readonly tokenizer: LocalGenerationTokenizer;
  private readonly endpoint: URL;
  constructor(
    private readonly config: ApiConfiguration['generation'],
    private readonly contextTokens: number,
    private readonly transport: typeof fetch = fetch,
  ) {
    if (
      !config.model ||
      !config.endpoint ||
      !config.tokenizerPath ||
      config.tokenizer !== 'huggingface-json'
    )
      throw new GenerationFailure('GENERATION_UNAVAILABLE');
    try {
      this.endpoint = new URL(config.endpoint);
      if (
        !['http:', 'https:'].includes(this.endpoint.protocol) ||
        this.endpoint.username ||
        this.endpoint.password ||
        this.endpoint.search ||
        this.endpoint.hash ||
        !this.endpoint.pathname.endsWith('/api/chat')
      )
        throw Error();
    } catch {
      throw new GenerationFailure('GENERATION_UNAVAILABLE');
    }
    this.tokenizer = new LocalGenerationTokenizer(
      config.tokenizerPath,
      config.model,
      contextTokens,
      config.think ?? false,
    );
  }
  countInputTokens(messages: readonly GenerationMessage[]): number {
    return this.tokenizer.countInputTokens(messages);
  }
  async generate(request: GenerationRequest): Promise<GenerationResult> {
    const inputTokens = this.tokenizer.promptTokens(request.messages);
    if (
      this.countInputTokens(request.messages) + this.config.maxOutputTokens >
      this.contextTokens
    )
      throw new GenerationFailure('GENERATION_UNAVAILABLE');
    const abort = new AbortController();
    const cancel = () => abort.abort();
    request.signal.addEventListener('abort', cancel, { once: true });
    if (request.signal.aborted) abort.abort();
    const timer = setTimeout(cancel, this.config.timeoutMs);
    const headers = {
      'Content-Type': 'application/json',
      ...(this.config.apiKey
        ? { Authorization: `Bearer ${this.config.apiKey}` }
        : {}),
    };
    const load = async (url: URL, body?: unknown): Promise<unknown> => {
      const response = await this.transport(url, {
        method: body === undefined ? 'GET' : 'POST',
        redirect: 'error',
        headers,
        signal: abort.signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new GenerationFailure(
          response.status === 429
            ? 'GENERATION_RATE_LIMITED'
            : 'GENERATION_UNAVAILABLE',
          response.status === 408 ||
            response.status === 429 ||
            response.status >= 500,
        );
      }
      const reader = response.body?.getReader();
      if (!reader) throw new GenerationFailure('AI_OUTPUT_INVALID');
      const parts: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 262144) throw new GenerationFailure('AI_OUTPUT_INVALID');
          parts.push(part.value);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      try {
        return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown;
      } catch {
        throw new GenerationFailure('AI_OUTPUT_INVALID');
      }
    };
    const verifyModel = async () => {
      const tags = new URL(this.endpoint);
      tags.pathname = tags.pathname.slice(0, -4) + 'tags';
      const catalog = await load(tags);
      if (
        !object(catalog) ||
        !Array.isArray(catalog.models) ||
        !catalog.models.some(
          (m: unknown) =>
            object(m) &&
            typeof m.name === 'string' &&
            modelName(m.name) === modelName(this.tokenizer.model) &&
            m.digest === this.tokenizer.digest,
        )
      )
        throw new GenerationFailure('GENERATION_UNAVAILABLE');
    };
    try {
      await verifyModel();
      const body = await load(this.endpoint, {
        model: this.config.model,
        messages: request.messages,
        stream: false,
        truncate: false,
        shift: false,
        think: this.config.think ?? false,
        format: RAG_OUTPUT_SCHEMA,
        options: {
          num_ctx: this.contextTokens,
          num_predict: this.config.maxOutputTokens,
          temperature: this.config.temperature,
        },
      });
      if (
        !object(body) ||
        typeof body.model !== 'string' ||
        modelName(body.model) !== modelName(this.tokenizer.model) ||
        body.done !== true ||
        body.done_reason !== 'stop' ||
        !object(body.message) ||
        body.message.role !== 'assistant' ||
        body.message.tool_calls ||
        typeof body.message.content !== 'string' ||
        !body.message.content.trim() ||
        body.message.content.length > 65536 ||
        body.prompt_eval_count !== inputTokens ||
        !Number.isSafeInteger(body.eval_count) ||
        Number(body.eval_count) < 0 ||
        Number(body.eval_count) > this.config.maxOutputTokens
      )
        throw new GenerationFailure('AI_OUTPUT_INVALID');
      await verifyModel();
      // Only final content participates in RAG parsing. Never expose message.thinking.
      return {
        content: body.message.content,
        usage: { inputTokens, outputTokens: Number(body.eval_count) },
      };
    } catch (error) {
      if (error instanceof GenerationFailure) throw error;
      throw new GenerationFailure(
        abort.signal.aborted ? 'GENERATION_TIMEOUT' : 'GENERATION_UNAVAILABLE',
        true,
      );
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', cancel);
    }
  }
}
