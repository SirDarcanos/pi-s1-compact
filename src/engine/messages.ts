import { NimbleClient, type NimbleClientOptions } from './client.js';
import { compact } from './compact.js';
import type { CompactOptions, CompactResult, Message } from './types.js';

export type CompactMessagesOptions = CompactOptions & NimbleClientOptions;

/** `compact` with a `NimbleClient` built from the options (key from `PI_S1_COMPACT_API_KEY`, with `NIMBLE_API_KEY` fallback). */
export function compactMessages(
  messages: readonly Message[],
  options: CompactMessagesOptions = {},
): Promise<CompactResult> {
  return compact(messages, new NimbleClient(options), options);
}
