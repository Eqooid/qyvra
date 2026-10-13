import { resolve } from 'node:path';
import { embeddingProfileFingerprint } from '@qyvra/database';
import { validateEnvironment } from './environment';
import { storageTestRoot } from '../../test/configuration.fixture';
import { ollamaFixture } from '../../test/ollama.fixture';
import { ollamaGenerationFixture } from '../../test/ollama-generation.fixture';
import { createEmbeddingProvider } from '../infrastructure/embeddings/embedding-provider.factory';
import { createGenerationProvider } from '../infrastructure/generation/generation-provider.factory';

const base = {
  DATABASE_URL: 'postgresql://localhost/local_provider_test',
  LOCAL_STORAGE_ROOT: storageTestRoot,
};
const enabled = {
  ...base,
  EMBEDDING_ENABLED: 'true',
  EMBEDDING_PROFILE_FINGERPRINT: 'a'.repeat(64),
  VECTOR_INDEX_ENABLED: 'true',
  QDRANT_URL: 'http://qdrant:6333',
  SEMANTIC_SEARCH_ENABLED: 'true',
  SEMANTIC_SEARCH_MIN_SCORE: '0.8',
  RAG_ENABLED: 'true',
};

describe('shared API/worker local-provider configuration', () => {
  it.each([
    ['openai-compatible', 'openai-compatible'],
    ['ollama', 'openai-compatible'],
    ['openai-compatible', 'ollama'],
    ['ollama', 'ollama'],
  ] as const)(
    'configures %s embeddings independently of %s generation',
    (embedding, generation) => {
      const env = {
        ...enabled,
        EMBEDDING_ENDPOINT:
          embedding === 'ollama'
            ? 'http://ollama:11434/api/embed'
            : 'https://api.openai.com/v1/embeddings',
        EMBEDDING_ALLOW_HTTP: embedding === 'ollama' ? 'true' : 'false',
        EMBEDDING_API_KEY:
          embedding === 'ollama' ? '' : 'synthetic-embedding-key',
        EMBEDDING_TOKENIZER_PATH:
          embedding === 'ollama'
            ? resolve(storageTestRoot, 'embedding.json')
            : '',
        GENERATION_PROVIDER: generation,
        GENERATION_ENDPOINT:
          generation === 'ollama'
            ? 'http://ollama:11434/api/chat'
            : 'https://api.openai.com/v1/chat/completions',
        GENERATION_ALLOW_HTTP: generation === 'ollama' ? 'true' : 'false',
        GENERATION_MODEL:
          generation === 'ollama'
            ? 'configured-local-chat'
            : 'configured-cloud-chat',
        GENERATION_API_KEY:
          generation === 'ollama' ? '' : 'synthetic-generation-key',
        GENERATION_TOKENIZER:
          generation === 'ollama' ? 'huggingface-json' : 'o200k_base',
        GENERATION_TOKENIZER_PATH:
          generation === 'ollama'
            ? resolve(storageTestRoot, 'generation.json')
            : '',
      };
      const api = validateEnvironment(env),
        worker = validateEnvironment(env);
      expect(api.embedding).toEqual(worker.embedding);
      expect(api.generation.provider).toBe(generation);
      expect(api.embedding.apiKey).toBe(
        embedding === 'ollama' ? undefined : env.EMBEDDING_API_KEY,
      );
      expect(api.generation.apiKey).toBe(
        generation === 'ollama' ? undefined : env.GENERATION_API_KEY,
      );
      const changedGeneration = validateEnvironment({
        ...env,
        GENERATION_MODEL: 'another-generation-model',
        GENERATION_TIMEOUT_MS: '30000',
      });
      expect(changedGeneration.embedding).toEqual(api.embedding);
      expect(changedGeneration.aiIngestion).toEqual(api.aiIngestion);
    },
  );
  it.each(['EMBEDDING', 'GENERATION'] as const)(
    'requires the %s key only for enabled official OpenAI operations',
    (operation) => {
      const env = {
        ...enabled,
        EMBEDDING_ENDPOINT: 'https://api.openai.com/v1/embeddings',
        EMBEDDING_API_KEY: 'synthetic-embedding',
        GENERATION_ENDPOINT: 'https://api.openai.com/v1/chat/completions',
        GENERATION_API_KEY: 'synthetic-generation',
        GENERATION_MODEL: 'configured-cloud-model',
      };
      expect(() =>
        validateEnvironment({ ...env, [`${operation}_API_KEY`]: '' }),
      ).toThrow(`${operation}_API_KEY`);
      expect(() =>
        validateEnvironment({
          ...env,
          [`${operation}_ENDPOINT`]: 'http://api.openai.com/v1/example',
          [`${operation}_ALLOW_HTTP`]: 'true',
        }),
      ).toThrow(`${operation}_ENDPOINT`);
      expect(() =>
        validateEnvironment({
          ...env,
          [`${operation}_ENDPOINT`]:
            'https://trusted-compatible.example/operation',
          [`${operation}_API_KEY`]: '',
        }),
      ).not.toThrow();
      expect(() =>
        validateEnvironment({
          ...base,
          [`${operation}_ENDPOINT`]: 'https://api.openai.com/v1/example',
        }),
      ).not.toThrow();
    },
  );
  it.each([
    ['GENERATION_PROVIDER', 'unknown'],
    ['GENERATION_MODEL', ''],
    ['GENERATION_ENDPOINT', 'not-a-url'],
    ['EMBEDDING_ENDPOINT', 'https://user:private@provider.example/embeddings'],
    ['GENERATION_ENDPOINT', 'https://provider.example/chat?key=private'],
    ['EMBEDDING_TIMEOUT_MS', '0'],
    ['GENERATION_TIMEOUT_MS', '60001'],
    ['EMBEDDING_BATCH_SIZE', '0'],
    ['GENERATION_MAX_OUTPUT_TOKENS', '0'],
    ['RAG_CONTEXT_TOKENS', '2048'],
  ])('rejects invalid %s without leaking its supplied value', (key, value) => {
    const env = {
      ...enabled,
      EMBEDDING_ENDPOINT: 'https://trusted.example/embeddings',
      GENERATION_ENDPOINT: 'https://trusted.example/chat',
      GENERATION_MODEL: 'model',
    };
    expect(() => validateEnvironment({ ...env, [key]: value })).toThrow(key);
    if (value.includes('private')) {
      try {
        validateEnvironment({ ...env, [key]: value });
        throw Error('expected configuration failure');
      } catch (error) {
        expect(String(error)).not.toContain('private');
      }
    }
  });
  it('retains disabled defaults and does not load unused local assets or probe providers at startup', async () => {
    const config = validateEnvironment({
      ...base,
      EMBEDDING_TOKENIZER_PATH: resolve(storageTestRoot, 'missing.json'),
    });
    expect(config.embedding.enabled).toBe(false);
    expect(config.rag.enabled).toBe(false);
    expect(config.generation.provider).toBe('openai-compatible');
    const transport = jest.fn(async () => {
      throw Error('must not probe providers');
    });
    const embedding = createEmbeddingProvider(config.embedding, transport);
    const local = ollamaFixture();
    try {
      await expect(
        embedding.embed({
          profile: local.profile,
          inputs: [],
          purpose: 'query',
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: 'EMBEDDING_NOT_CONFIGURED' });
    } finally {
      local.dispose();
    }
    createGenerationProvider(
      config.generation,
      config.rag.contextTokens,
      false,
      transport,
    );
    expect(transport).not.toHaveBeenCalled();
  });
  it('constructs enabled local adapters offline and preserves model/profile compatibility', () => {
    const embedding = ollamaFixture(),
      generation = ollamaGenerationFixture();
    try {
      const transport = jest.fn(async () => {
        throw Error('offline');
      });
      createEmbeddingProvider(embedding.config, transport);
      createGenerationProvider(generation.config, 8192, true, transport);
      expect(transport).not.toHaveBeenCalled();
      const fingerprint = embeddingProfileFingerprint(embedding.profile);
      for (const change of [
        { provider: 'openai-compatible' },
        { model: 'other' },
        { dimensions: 4 },
        { queryInstruction: 'different prefix' },
      ])
        expect(
          embeddingProfileFingerprint({ ...embedding.profile, ...change }),
        ).not.toBe(fingerprint);
      for (const dimensions of [0, -1, 1.5, NaN, Infinity])
        expect(() =>
          embeddingProfileFingerprint({ ...embedding.profile, dimensions }),
        ).toThrow('Invalid embedding profile identity');
    } finally {
      embedding.dispose();
      generation.dispose();
    }
  });
});
