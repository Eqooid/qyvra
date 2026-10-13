import { readFileSync, statSync } from 'node:fs';
import { Tokenizer } from '@huggingface/tokenizers';
import {
  GenerationFailure,
  RAG_OUTPUT_SCHEMA,
  type GenerationMessage,
} from '../../modules/ai/generation-provider';

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
interface Framing {
  systemPrefix: string;
  systemSuffix: string;
  userPrefix: string;
  userSuffix: string;
  assistantPrefix: string;
}

/** Restricted, operator-certified chat framing. No template execution or downloads. */
export class LocalGenerationTokenizer {
  readonly model: string;
  readonly digest: string;
  private readonly tokenizer: Tokenizer;
  private readonly framing: Framing;
  private readonly addSpecialTokens: boolean;
  constructor(
    path: string,
    model: string,
    contextTokens: number,
    think: boolean,
  ) {
    try {
      const stat = statSync(path);
      if (!stat.isFile() || stat.size > 64000000) throw Error();
      const bytes = readFileSync(path);
      if (bytes.length > 64000000) throw Error();
      const b: unknown = JSON.parse(bytes.toString('utf8'));
      if (
        !object(b) ||
        b.schemaVersion !== 1 ||
        b.model !== model ||
        typeof b.modelRevision !== 'string' ||
        !/^sha256:[a-f0-9]{64}$/.test(b.modelRevision) ||
        b.think !== think ||
        !Number.isSafeInteger(b.contextLimit) ||
        Number(b.contextLimit) < contextTokens ||
        typeof b.addSpecialTokens !== 'boolean' ||
        !object(b.tokenizerJson) ||
        !object(b.tokenizerConfig) ||
        !object(b.framing) ||
        !Array.isArray(b.parity) ||
        b.tokenizerJson.truncation != null ||
        b.tokenizerJson.padding != null
      )
        throw Error();
      const f = b.framing;
      const fields = [
        'systemPrefix',
        'systemSuffix',
        'userPrefix',
        'userSuffix',
        'assistantPrefix',
      ] as const;
      for (const field of fields)
        if (typeof f[field] !== 'string' || f[field].length > 8192)
          throw Error();
      this.framing = f as unknown as Framing;
      this.model = model;
      this.digest = b.modelRevision.slice(7);
      this.addSpecialTokens = b.addSpecialTokens;
      this.tokenizer = new Tokenizer(b.tokenizerJson, b.tokenizerConfig);
      const categories = new Set<string>();
      for (const p of b.parity) {
        if (
          !object(p) ||
          typeof p.category !== 'string' ||
          typeof p.text !== 'string' ||
          !Array.isArray(p.ids) ||
          !p.ids.every(
            (id: unknown) => Number.isSafeInteger(id) && Number(id) >= 0,
          ) ||
          JSON.stringify(this.encode(p.text)) !== JSON.stringify(p.ids)
        )
          throw Error();
        categories.add(p.category);
      }
      if (['ascii', 'unicode', 'prompt'].some((c) => !categories.has(c)))
        throw Error();
      // Certify rendering as well as tokenization against a trusted reference prompt.
      const promptParity = b.promptParity;
      if (
        !object(promptParity) ||
        !Array.isArray(promptParity.messages) ||
        !this.validMessages(promptParity.messages) ||
        typeof promptParity.text !== 'string' ||
        this.render(promptParity.messages) !== promptParity.text ||
        !b.parity.some(
          (p: unknown) =>
            object(p) &&
            p.category === 'prompt' &&
            p.text === promptParity.text,
        )
      )
        throw Error();
    } catch {
      throw new GenerationFailure('GENERATION_UNAVAILABLE');
    }
  }
  private validMessages(messages: unknown[]): messages is GenerationMessage[] {
    return (
      messages.length === 2 &&
      messages.every(
        (m, i) =>
          object(m) &&
          m.role === (i === 0 ? 'system' : 'user') &&
          typeof m.content === 'string',
      )
    );
  }
  private render(messages: readonly GenerationMessage[]): string {
    return (
      messages
        .map((m) =>
          m.role === 'system'
            ? this.framing.systemPrefix + m.content + this.framing.systemSuffix
            : this.framing.userPrefix + m.content + this.framing.userSuffix,
        )
        .join('') + this.framing.assistantPrefix
    );
  }
  private encode(text: string): number[] {
    return this.tokenizer.encode(text, {
      add_special_tokens: this.addSpecialTokens,
    }).ids;
  }
  promptTokens(messages: readonly GenerationMessage[]): number {
    try {
      if (!this.validMessages([...messages])) throw Error();
      return this.encode(this.render(messages)).length;
    } catch {
      throw new GenerationFailure('GENERATION_UNAVAILABLE');
    }
  }
  countInputTokens(messages: readonly GenerationMessage[]): number {
    return (
      this.promptTokens(messages) +
      this.encode(JSON.stringify(RAG_OUTPUT_SCHEMA)).length +
      1024
    );
  }
}
