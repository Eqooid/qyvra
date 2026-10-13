import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { Tokenizer } from '@huggingface/tokenizers';
import type { EmbeddingProfileIdentity } from '@qyvra/database';
import { EmbeddingFailure } from '../../modules/ai/embedding-provider';

export const LOCAL_TOKENIZER = 'huggingface-json';
export const LOCAL_TOKENIZER_VERSION = 'hf-tokenizers-0.2.0:sha256:';

export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Operator-provisioned data only. No network, model execution or automatic assets. */
export class LocalEmbeddingTokenizer {
  readonly version: string;
  private readonly tokenizer: Tokenizer;
  private readonly bundle: Record<string, unknown>;
  constructor(path: string) {
    try {
      const stat = statSync(path);
      if (!stat.isFile() || stat.size > 64000000) throw Error();
      const bytes = readFileSync(path);
      if (bytes.length > 64000000) throw Error();
      this.version =
        LOCAL_TOKENIZER_VERSION +
        createHash('sha256').update(bytes).digest('hex');
      const bundle: unknown = JSON.parse(bytes.toString('utf8'));
      if (
        !object(bundle) ||
        bundle.schemaVersion !== 1 ||
        typeof bundle.model !== 'string' ||
        !bundle.model.trim() ||
        typeof bundle.modelRevision !== 'string' ||
        !/^sha256:[a-f0-9]{64}$/.test(bundle.modelRevision) ||
        typeof bundle.addSpecialTokens !== 'boolean' ||
        !object(bundle.tokenizerJson) ||
        !object(bundle.tokenizerConfig) ||
        !Array.isArray(bundle.parity)
      )
        throw Error();
      if (
        bundle.tokenizerJson.truncation != null ||
        bundle.tokenizerJson.padding != null
      )
        throw Error();
      this.bundle = bundle;
      this.tokenizer = new Tokenizer(
        bundle.tokenizerJson,
        bundle.tokenizerConfig,
      );
      const categories = new Set<string>();
      for (const test of bundle.parity) {
        if (
          !object(test) ||
          typeof test.category !== 'string' ||
          typeof test.text !== 'string' ||
          !Array.isArray(test.ids) ||
          !test.ids.every(
            (id: unknown) => Number.isSafeInteger(id) && Number(id) >= 0,
          )
        )
          throw Error();
        const ids = this.encode(test.text);
        if (JSON.stringify(ids) !== JSON.stringify(test.ids)) throw Error();
        categories.add(test.category);
      }
      if (
        ['ascii', 'unicode', 'document', 'query'].some(
          (category) => !categories.has(category),
        )
      )
        throw Error();
    } catch {
      // Never include asset paths or contents in operational failures.
      throw new EmbeddingFailure('EMBEDDING_TOKENIZER_INVALID');
    }
  }

  validate(profile: EmbeddingProfileIdentity) {
    if (
      profile.tokenizer !== LOCAL_TOKENIZER ||
      profile.tokenizerVersion !== this.version ||
      profile.model !== this.bundle.model ||
      profile.modelRevision !== this.bundle.modelRevision
    )
      throw new EmbeddingFailure('EMBEDDING_PROFILE_UNSUPPORTED');
  }

  private encode(text: string): number[] {
    return this.tokenizer.encode(text, {
      add_special_tokens: this.bundle.addSpecialTokens === true,
    }).ids;
  }
  count(text: string): number {
    try {
      return this.encode(text).length;
    } catch {
      throw new EmbeddingFailure('EMBEDDING_TOKENIZER_INVALID');
    }
  }
}
