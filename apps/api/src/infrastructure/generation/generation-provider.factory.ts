import type { ApiConfiguration } from '../../configuration/settings';
import {
  GenerationFailure,
  type GenerationProvider,
} from '../../modules/ai/generation-provider';
import { OpenAiCompatibleGenerationProvider } from './openai-compatible.provider';
import { OllamaGenerationProvider } from './ollama.provider';

export function createGenerationProvider(
  config: ApiConfiguration['generation'],
  contextTokens: number,
  enabled = true,
  transport: typeof fetch = fetch,
): GenerationProvider {
  if (!enabled)
    return {
      generate: async () => {
        throw new GenerationFailure('GENERATION_UNAVAILABLE');
      },
    };
  return config.provider === 'ollama'
    ? new OllamaGenerationProvider(config, contextTokens, transport)
    : new OpenAiCompatibleGenerationProvider(config, transport);
}
