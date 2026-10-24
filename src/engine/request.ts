import type { NimbleAnswer, NimbleQuestions, NimbleResponse, NimbleState } from './types.js';

export const SYSTEM_ONE_URL = 'http://127.0.0.1:11434/v1/systemone';

/** Plain HTTP is allowed only on loopback; never send evidence or keys to an insecure remote. */
export function validateEndpoint(endpoint: string): string {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error('Invalid Nimble endpoint'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username || url.password || url.search || url.hash) {
    throw new Error('Nimble endpoint requires HTTPS (or loopback HTTP), without credentials, query, or fragment');
  }
  return url.href;
}
export const DEFAULT_MODEL = 'nimble';

export interface NimbleRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

/** The HTTP request for one Nimble call, for any fetch-like transport. */
export function buildNimbleRequest(
  params: {
    apiKey?: string;
    model?: string;
    baseUrl?: string;
  },
  state: NimbleState,
  questions: NimbleQuestions,
): NimbleRequest {
  return {
    url: validateEndpoint(params.baseUrl ?? SYSTEM_ONE_URL),
    method: 'POST',
    headers: {
      ...(params.apiKey ? { authorization: `Bearer ${params.apiKey}` } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: params.model ?? DEFAULT_MODEL,
      state,
      questions,
    }),
  };
}

/** Validates a Nimble response body; throws on anything but an `answers` object. */
export function parseNimbleResponse(
  status: number,
  ok: boolean,
  text: string,
): NimbleResponse {
  if (!ok) {
    throw new Error(`Nimble request failed (${status})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Nimble returned malformed JSON');
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !('answers' in parsed) ||
    parsed.answers === null ||
    typeof parsed.answers !== 'object'
  ) {
    throw new Error('Nimble response is missing answers');
  }
  return parsed as NimbleResponse;
}

/** The `noul` probability of one answer; throws when it is not there. */
export function noulAnswer(
  answers: Record<string, NimbleAnswer>,
  name: string,
): number {
  const answer = answers[name];
  if (
    !answer ||
    !('noul' in answer) ||
    typeof answer.noul !== 'number' ||
    !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1
  ) {
    throw new Error(`Invalid Nimble answer for ${name}`);
  }
  return answer.noul;
}
