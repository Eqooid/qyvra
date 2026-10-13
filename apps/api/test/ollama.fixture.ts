import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiConfiguration } from '../src/configuration/settings';
import {
  LocalEmbeddingTokenizer,
  LOCAL_TOKENIZER,
  LOCAL_TOKENIZER_VERSION,
} from '../src/infrastructure/embeddings/local-tokenizer';

/** Tiny synthetic tokenizer, not a downloaded or certified production model asset. */
export function ollamaFixture() {
  const root = mkdtempSync(join(tmpdir(), 'qyvra-ollama-'));
  const path = join(root, 'tokenizer-bundle.json');
  const bundle = {
    schemaVersion: 1,
    model: 'fixture:latest',
    modelRevision: `sha256:${'a'.repeat(64)}`,
    addSpecialTokens: true,
    tokenizerJson: {
      version: '1.0',
      truncation: null,
      padding: null,
      added_tokens: [],
      normalizer: null,
      pre_tokenizer: { type: 'WhitespaceSplit' },
      post_processor: null,
      decoder: null,
      model: {
        type: 'WordLevel',
        vocab: {
          '[UNK]': 0,
          Hello: 1,
          world: 2,
          é: 3,
          文: 4,
          '😀': 5,
          'search_document:': 6,
          'search_query:': 7,
        },
        unk_token: '[UNK]',
      },
    },
    tokenizerConfig: {},
    parity: [
      { category: 'ascii', text: 'Hello world', ids: [1, 2] },
      { category: 'unicode', text: 'é 文 😀', ids: [3, 4, 5] },
      { category: 'document', text: 'search_document: Hello', ids: [6, 1] },
      { category: 'query', text: 'search_query: Hello', ids: [7, 1] },
    ],
  };
  const bytes = JSON.stringify(bundle);
  writeFileSync(path, bytes);
  const profile = {
    provider: 'ollama',
    model: bundle.model,
    modelRevision: bundle.modelRevision,
    dimensions: 3,
    distance: 'Cosine' as const,
    profileVersion: 1,
    normalizationVersion: 'qyvra-embedding-prefix/v1',
    tokenizer: LOCAL_TOKENIZER,
    tokenizerVersion:
      LOCAL_TOKENIZER_VERSION +
      createHash('sha256').update(bytes).digest('hex'),
    documentInstruction: 'search_document: ',
    queryInstruction: 'search_query: ',
  };
  const config: ApiConfiguration['embedding'] = {
    enabled: true,
    endpoint: 'http://127.0.0.1:11434/api/embed',
    tokenizerPath: path,
    batchSize: 2,
    maxInputTokens: 100,
    maxBatchTokens: 200,
    timeoutMs: 1000,
    sendDimensions: true,
  };
  return {
    root,
    path,
    bundle,
    profile,
    config,
    tokenizer: new LocalEmbeddingTokenizer(path),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}
