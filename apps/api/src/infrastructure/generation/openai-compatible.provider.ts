import type { ApiConfiguration } from '../../configuration/settings';
import {
  GenerationFailure,
  RAG_OUTPUT_SCHEMA,
  type GenerationProvider,
  type GenerationRequest,
  type GenerationResult,
} from '../../modules/ai/generation-provider';

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** One bounded, non-streaming HTTP attempt. No tools, history or provider-managed storage. */
export class OpenAiCompatibleGenerationProvider implements GenerationProvider {
  constructor(
    private readonly config: ApiConfiguration['generation'],
    private readonly transport: typeof fetch = fetch,
  ) {}
  async generate(request: GenerationRequest): Promise<GenerationResult> {
    if (!this.config.endpoint || !this.config.model)
      throw new GenerationFailure('GENERATION_UNAVAILABLE');
    const abort = new AbortController();
    const cancel = () => abort.abort();
    request.signal.addEventListener('abort', cancel, { once: true });
    if (request.signal.aborted) abort.abort();
    const timer = setTimeout(cancel, this.config.timeoutMs);
    try {
      const response = await this.transport(this.config.endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: abort.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.apiKey
            ? { Authorization: `Bearer ${this.config.apiKey}` }
            : {}),
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: request.messages,
          temperature: this.config.temperature,
          [this.config.outputTokenField]: this.config.maxOutputTokens,
          stream: false,
          store: false,
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'qyvra_rag_v1',
              strict: true,
              schema: RAG_OUTPUT_SCHEMA,
            },
          },
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new GenerationFailure(
          response.status === 429
            ? 'GENERATION_RATE_LIMITED'
            : 'GENERATION_UNAVAILABLE',
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
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(parts).toString('utf8'));
      } catch {
        throw new GenerationFailure('AI_OUTPUT_INVALID');
      }
      if (
        !object(body) ||
        !Array.isArray(body.choices) ||
        body.choices.length !== 1
      )
        throw new GenerationFailure('AI_OUTPUT_INVALID');
      const choice: unknown = body.choices[0];
      if (
        !object(choice) ||
        choice.finish_reason !== 'stop' ||
        !object(choice.message) ||
        choice.message.refusal ||
        choice.message.tool_calls ||
        typeof choice.message.content !== 'string' ||
        !choice.message.content.length ||
        choice.message.content.length > 65536
      )
        throw new GenerationFailure('AI_OUTPUT_INVALID');
      const usage = body.usage;
      const counts =
        object(usage) &&
        Number.isSafeInteger(usage.prompt_tokens) &&
        Number.isSafeInteger(usage.completion_tokens) &&
        Number(usage.prompt_tokens) >= 0 &&
        Number(usage.completion_tokens) >= 0
          ? {
              inputTokens: Number(usage.prompt_tokens),
              outputTokens: Number(usage.completion_tokens),
            }
          : undefined;
      return { content: choice.message.content, usage: counts };
    } catch (error) {
      if (error instanceof GenerationFailure) throw error;
      throw new GenerationFailure(
        abort.signal.aborted ? 'GENERATION_TIMEOUT' : 'GENERATION_UNAVAILABLE',
      );
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', cancel);
    }
  }
}
