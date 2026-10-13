/** Qyvra-owned, ephemeral generation contract; independent of embedding profiles. */
export interface GenerationMessage {
  role: 'system' | 'user';
  content: string;
}
export interface GenerationRequest {
  messages: readonly GenerationMessage[];
  signal: AbortSignal;
}
export interface GenerationResult {
  content: string;
  usage?: { inputTokens: number; outputTokens: number };
}
export interface GenerationProvider {
  /** Provider-specific input budgeting; includes conservative framing/schema reserve. */
  countInputTokens?(messages: readonly GenerationMessage[]): number;
  generate(request: GenerationRequest): Promise<GenerationResult>;
}
export class GenerationFailure extends Error {
  constructor(
    readonly code:
      | 'GENERATION_UNAVAILABLE'
      | 'GENERATION_TIMEOUT'
      | 'GENERATION_RATE_LIMITED'
      | 'AI_OUTPUT_INVALID',
    readonly retryable = false,
  ) {
    super(code);
    this.name = 'GenerationFailure';
  }
}
export const GENERATION_PROVIDER = Symbol('GENERATION_PROVIDER');
export const RAG_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['outcome', 'claims'],
  properties: {
    outcome: { type: 'string', enum: ['answered', 'insufficient_evidence'] },
    claims: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'sourceTokens'],
        properties: {
          text: { type: 'string' },
          sourceTokens: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} as const;
