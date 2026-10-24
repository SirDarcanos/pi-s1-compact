// Narrow legacy wire-contract adapter retained for regression/compatibility checks; runtime uses registry classifiers.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { requestBody, MAX_RESPONSE_BYTES, type Candidate, type Config } from "./pruning.ts";
import { validateEndpoint } from "./engine/request.ts";
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }

export async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new Error("Invalid Nimble response body");
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    void response.body.cancel().catch(() => {});
    throw new Error("Nimble response exceeds the byte budget");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let abort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => {
      void reader.cancel().catch(() => {});
      reject(signal.reason ?? new Error("Nimble request aborted"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await Promise.race([reader.read(), aborted]);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error("Nimble response exceeds the byte budget");
      chunks.push(chunk.value);
    }
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    } catch {
      throw new Error("Invalid Nimble response JSON");
    }
  } finally {
    signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
  }
}

export function parseNimbleWire(data: unknown, model: string, ids: readonly string[]): { probabilities: Record<string, number>; inputTokens: number; outputTokens: number } {
  if (!record(data) || !exactKeys(data, ["model", "answers", "usage",
    ...(Object.hasOwn(data, "prompt_eval_cached_count") ? ["prompt_eval_cached_count"] : [])])
    || (Object.hasOwn(data, "prompt_eval_cached_count")
      && (typeof data.prompt_eval_cached_count !== "number" || !Number.isSafeInteger(data.prompt_eval_cached_count)
        || data.prompt_eval_cached_count < 0))
    || typeof data.model !== "string" || !(data.model === model
      || (model === "nimble" && data.model === "nimble:latest")
      || (model === "nimble:latest" && data.model === "nimble")
      || /^nimble-[a-z0-9.-]{1,100}$/i.test(data.model)
      || /^bespokelabs\/Bespoke-Nimble-[a-z0-9.-]{1,100}$/i.test(data.model))
    || !record(data.answers) || !exactKeys(data.answers, ids)
    || !record(data.usage) || !exactKeys(data.usage, ["input_tokens", "output_tokens"])) {
    throw new Error("Invalid Nimble response");
  }
  const inputTokens = data.usage.input_tokens;
  const outputTokens = data.usage.output_tokens;
  if (typeof inputTokens !== "number" || !Number.isSafeInteger(inputTokens) || inputTokens < 0
    || typeof outputTokens !== "number" || !Number.isSafeInteger(outputTokens) || outputTokens < 0) {
    throw new Error("Invalid Nimble usage");
  }
  const probabilities: Record<string, number> = {};
  for (const id of ids) {
    const answer = data.answers[id];
    if (!record(answer) || !exactKeys(answer, ["type", "noul"]) || answer.type !== "noul"
      || typeof answer.noul !== "number" || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) {
      throw new Error("Invalid Nimble probability");
    }
    probabilities[id] = answer.noul;
  }
  return { probabilities, inputTokens, outputTokens };
}

export async function score(
  messages: readonly AgentMessage[], choices: readonly Candidate[], config: Config,
  signal?: AbortSignal, fetcher: typeof fetch = fetch,
): Promise<{ refs: string[]; keptRefs: string[]; evaluated: number; inputTokens: number | null }> {
  const request = requestBody(messages, choices, config.model);
  const timeout = AbortSignal.timeout(Math.floor(config.timeoutMs));
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetcher(validateEndpoint(config.endpoint), {
    method: "POST", redirect: "error",
    headers: { accept: "application/json", ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}), "content-type": "application/json" },
    body: request.body, signal: requestSignal,
  });
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new Error(`Nimble HTTP ${response.status}`);
  }
  const data = await boundedJson(response, requestSignal);
  const ids = request.choices.map((_item, index) => `r${index}`);
  const { probabilities, inputTokens } = parseNimbleWire(data, config.model, ids);
  const refs: string[] = [], keptRefs: string[] = [];
  for (const [index, item] of request.choices.entries()) {
    if (probabilities[`r${index}`]! < config.keepThreshold) refs.push(item.ref);
    else keptRefs.push(item.ref);
  }
  return { refs, keptRefs, evaluated: request.choices.length, inputTokens };
}
