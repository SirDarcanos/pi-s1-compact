import { buildNimbleRequest, parseNimbleResponse } from './request.js';
import type { NimbleAsker, NimbleQuestions, NimbleResponse, NimbleState } from './types.js';

export interface NimbleClientOptions {
  /** Defaults to `process.env.NIMBLE_API_KEY`. */
  apiKey?: string;
  /** Defaults to PI_NIMBLE_MODEL or Ollama's `nimble`. */
  model?: string;
  /** Defaults to PI_NIMBLE_URL or Ollama's loopback System One endpoint. */
  baseUrl?: string;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Asks Nimble over HTTP with the global `fetch` (or an injected one). */
export class NimbleClient implements NimbleAsker {
  private readonly apiKey: string;
  private readonly model: string | undefined;
  private readonly baseUrl: string | undefined;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: NimbleClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.NIMBLE_API_KEY ?? '';
    this.model = options.model ?? process.env.PI_NIMBLE_MODEL;
    this.baseUrl = options.baseUrl ?? process.env.PI_NIMBLE_URL;
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async ask(state: NimbleState, questions: NimbleQuestions): Promise<NimbleResponse> {
    const request = buildNimbleRequest(
      { apiKey: this.apiKey, model: this.model, baseUrl: this.baseUrl },
      state,
      questions,
    );
    const response = await this.fetcher(request.url, {
      method: request.method,
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: request.headers,
      body: request.body,
    });
    return parseNimbleResponse(response.status, response.ok, await response.text());
  }
}
