import { HttpException } from '@nestjs/common';

/** Fixed public code only; never exposes a provider body or model text. */
export class AiOutputInvalidException extends HttpException {
  constructor() {
    super('Invalid AI output', 502);
  }
}
