import {
  BadRequestException,
  GatewayTimeoutException,
  HttpException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ConfigurationService } from '../../configuration/configuration.module';
import { RequestContext } from '../../common/request-context';
import { StructuredLogger } from '../../common/structured-logger';
import { AiOutputInvalidException } from '../../common/ai-output-invalid.exception';
import { SemanticSearchService } from '../search/semantic-search.service';
import {
  GENERATION_PROVIDER,
  GenerationFailure,
  type GenerationProvider,
} from './generation-provider';
import { buildRagContext, RAG_PROMPT_VERSION } from './rag-context';
import { validateRagOutput, type RagAnswer } from './rag-citations';

export interface RagAnswerInput {
  question: string;
  documentIds?: string[];
}
@Injectable()
export class RagAnswerService {
  private active = 0;
  private resetAt = 0;
  private total = 0;
  private readonly users = new Map<string, number>();
  constructor(
    private readonly search: SemanticSearchService,
    private readonly configuration: ConfigurationService,
    @Inject(GENERATION_PROVIDER)
    private readonly generation: GenerationProvider,
    private readonly logger: StructuredLogger,
    private readonly context: RequestContext,
  ) {}
  async answer(userId: string, input: RagAnswerInput): Promise<RagAnswer> {
    const question =
      typeof input.question === 'string' ? input.question.trim() : '';
    if (
      !question ||
      question.length > 4000 ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
        question,
      )
    )
      throw new BadRequestException();
    const p = this.configuration.rag;
    if (!p.enabled) throw new ServiceUnavailableException();
    if (Date.now() >= this.resetAt) {
      this.resetAt = Date.now() + 60000;
      this.total = 0;
      this.users.clear();
    }
    const userCount = this.users.get(userId) ?? 0;
    if (
      this.active >= p.concurrency ||
      userCount >= p.perUserPerMinute ||
      this.total >= p.globalPerMinute
    )
      throw new HttpException('Too Many Requests', 429);
    this.active++;
    this.total++;
    this.users.set(userId, userCount + 1);
    const start = performance.now();
    const abort = new AbortController();
    const requestId = this.context.correlationId ?? randomUUID();
    let timer: NodeJS.Timeout | undefined;
    const work = this.execute(
      userId,
      { ...input, question },
      requestId,
      abort.signal,
    ).finally(() => this.active--);
    try {
      const result = await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            abort.abort();
            reject(new GatewayTimeoutException());
          }, p.timeoutMs);
        }),
      ]);
      this.logger.event('info', 'ai.rag.completed', {
        outcome: result.outcome,
        citationCount: result.citations.length,
        inputLength: question.length,
        promptVersion: RAG_PROMPT_VERSION,
        durationMs: Math.round(performance.now() - start),
      });
      return result;
    } catch (error) {
      this.logger.event('warn', 'ai.rag.failed', {
        category:
          error instanceof GenerationFailure
            ? error.code
            : error instanceof AiOutputInvalidException
              ? 'AI_OUTPUT_INVALID'
              : 'RAG_FAILED',
        durationMs: Math.round(performance.now() - start),
      });
      if (error instanceof HttpException) throw error;
      if (error instanceof GenerationFailure) {
        if (error.code === 'AI_OUTPUT_INVALID')
          throw new AiOutputInvalidException();
        if (error.code === 'GENERATION_TIMEOUT')
          throw new GatewayTimeoutException();
        if (error.code === 'GENERATION_RATE_LIMITED')
          throw new HttpException('Too Many Requests', 429);
      }
      throw new ServiceUnavailableException();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  private async execute(
    userId: string,
    input: RagAnswerInput,
    requestId: string,
    signal: AbortSignal,
  ): Promise<RagAnswer> {
    const insufficient = (
      reason: Extract<
        RagAnswer,
        { outcome: 'insufficient_evidence' }
      >['reason'],
    ): RagAnswer => ({
      outcome: 'insufficient_evidence',
      answer: null,
      citations: [],
      reason,
      requestId,
    });
    const found = await this.search.search(
      userId,
      {
        query: input.question,
        documentIds: input.documentIds,
        limit: this.configuration.rag.maxSources,
      },
      signal,
    );
    signal.throwIfAborted();
    const minScore = this.configuration.semanticSearch.minScore;
    if (minScore === undefined) throw new ServiceUnavailableException();
    const eligible = found.results.filter(
      (s) => Number.isFinite(s.score) && s.score >= minScore,
    );
    if (!eligible.length) return insufficient('no_authorized_evidence');
    const fresh = await this.search.revalidate(userId, eligible);
    signal.throwIfAborted();
    if (fresh.length !== eligible.length)
      return insufficient('evidence_changed');
    const context = buildRagContext(
      input.question,
      fresh,
      this.configuration.rag,
      this.configuration.generation.maxOutputTokens,
      this.configuration.generation.tokenizer,
    );
    if (!context.sources.length) return insufficient('context_budget');
    const generationStarted = performance.now();
    const generated = await this.generation.generate({
      messages: context.messages,
      signal,
    });
    signal.throwIfAborted();
    const finalSources = await this.search.revalidate(
      userId,
      context.sources.map((s) => s.source),
    );
    signal.throwIfAborted();
    if (finalSources.length !== context.sources.length)
      return insufficient('evidence_changed');
    const validated = validateRagOutput(
      generated.content,
      context.sources.map((s, i) => ({
        token: s.token,
        source: finalSources[i],
      })),
    );
    this.logger.event('info', 'ai.rag.generation', {
      provider: this.configuration.generation.provider,
      model: this.configuration.generation.model,
      sourceCount: context.sources.length,
      generationDurationMs: Math.round(performance.now() - generationStarted),
      embeddingProfileId: context.sources[0].source.embeddingProfileId,
      inputTokenEstimate: context.inputTokens,
      usage: generated.usage,
    });
    if (validated.outcome === 'insufficient_evidence')
      return insufficient('model_insufficient_evidence');
    return {
      outcome: 'answered',
      answer: validated.claims
        .map(
          (c) => `${c.text} ${c.citationIds.map((id) => `[${id}]`).join(' ')}`,
        )
        .join('\n\n'),
      claims: validated.claims,
      citations: validated.citations,
      requestId,
    };
  }
}
