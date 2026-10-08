import type { ProcessingMessage } from '@qyvra/database';

/** Transport-neutral contract used by the future outbox dispatcher. */
export interface MessagePublisher {
  /** Resolves only after the broker confirms a routed, persistent publication. */
  publishProcessing(message: ProcessingMessage): Promise<void>;
}

export const MESSAGE_PUBLISHER = Symbol('MESSAGE_PUBLISHER');
