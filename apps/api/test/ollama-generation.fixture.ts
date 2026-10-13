import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ollamaFixture } from './ollama.fixture';
import { LocalGenerationTokenizer } from '../src/infrastructure/generation/local-tokenizer';
import type { ApiConfiguration } from '../src/configuration/settings';
import type { GenerationMessage } from '../src/modules/ai/generation-provider';

/** Synthetic framing and tiny tokenizer only; not certification for a real Qwen model. */
export function ollamaGenerationFixture() {
  const embedding = ollamaFixture();
  const path = join(embedding.root, 'generation.json');
  const bundle = {
    ...embedding.bundle,
    think: false,
    contextLimit: 8192,
    framing: {
      systemPrefix: '',
      systemSuffix: ' ',
      userPrefix: '',
      userSuffix: ' ',
      assistantPrefix: '',
    },
    parity: [
      { category: 'ascii', text: 'Hello world', ids: [1, 2] },
      { category: 'unicode', text: 'é 文 😀', ids: [3, 4, 5] },
      { category: 'prompt', text: 'Hello world ', ids: [1, 2] },
    ],
    promptParity: {
      messages: [
        { role: 'system', content: 'Hello' },
        { role: 'user', content: 'world' },
      ],
      text: 'Hello world ',
    },
  };
  writeFileSync(path, JSON.stringify(bundle));
  const config: ApiConfiguration['generation'] = {
    provider: 'ollama',
    tokenizer: 'huggingface-json',
    tokenizerPath: path,
    endpoint: 'http://localhost:11434/api/chat',
    model: bundle.model,
    think: false,
    timeoutMs: 1000,
    maxOutputTokens: 1024,
    temperature: 0,
    outputTokenField: 'max_completion_tokens',
  };
  const tokenizer = new LocalGenerationTokenizer(
    path,
    bundle.model,
    8192,
    false,
  );
  const content = JSON.stringify({
    outcome: 'answered',
    claims: [{ text: 'Hello world.', sourceTokens: ['S1'] }],
  });
  const response = (
    messages: readonly GenerationMessage[],
    finalContent = content,
  ) => ({
    model: config.model,
    done: true,
    done_reason: 'stop',
    message: {
      role: 'assistant',
      content: finalContent,
      thinking: 'PRIVATE REASONING S999',
    },
    prompt_eval_count: tokenizer.promptTokens(messages),
    eval_count: 24,
  });
  const transport: typeof fetch = async (_url, init) =>
    new Response(
      JSON.stringify(
        init?.method === 'GET'
          ? {
              models: [
                { name: config.model, digest: bundle.modelRevision.slice(7) },
              ],
            }
          : response(
              JSON.parse(String(init?.body)).messages as GenerationMessage[],
            ),
      ),
    );
  return {
    ...embedding,
    path,
    bundle,
    config,
    tokenizer,
    content,
    response,
    transport,
  };
}
