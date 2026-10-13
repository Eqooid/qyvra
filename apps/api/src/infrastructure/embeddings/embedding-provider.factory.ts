import type { ApiConfiguration } from '../../configuration/settings';
import {
  EmbeddingFailure,
  type EmbeddingProvider,
  type EmbeddingRequest,
} from '../../modules/ai/embedding-provider';
import { LocalEmbeddingTokenizer } from './local-tokenizer';
import { OllamaEmbeddingProvider } from './ollama.provider';
import { OpenAiCompatibleEmbeddingProvider } from './openai-compatible.provider';

/** Shared worker/query selection from authoritative SQL identity, never HTTP input. */
export function createEmbeddingProvider(
  config: ApiConfiguration['embedding'],
  transport: typeof fetch = fetch,
): EmbeddingProvider {
  if (!config.enabled)
    return {
      async embed() {
        throw new EmbeddingFailure('EMBEDDING_NOT_CONFIGURED');
      },
    };
  const tokenizer = config.tokenizerPath
    ? new LocalEmbeddingTokenizer(config.tokenizerPath)
    : undefined;
  const compatible = new OpenAiCompatibleEmbeddingProvider(config, transport);
  const ollama = new OllamaEmbeddingProvider(config, tokenizer, transport);
  return {
    async embed(request: EmbeddingRequest) {
      if (request.profile.provider === 'openai-compatible')
        return compatible.embed(request);
      if (request.profile.provider === 'ollama') return ollama.embed(request);
      throw new EmbeddingFailure('EMBEDDING_PROFILE_UNSUPPORTED');
    },
  };
}
