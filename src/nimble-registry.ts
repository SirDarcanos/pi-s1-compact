import type { ProviderClassifier } from "@earendil-works/pi-ai";
import { boundedJson, parseNimbleWire } from "./legacy-nimble.ts";
import { validateEndpoint } from "./engine/request.ts";

/** Narrow Ollama adapter: Pi owns provider selection/auth; preserve the predecessor's raw wire checks.
 * No pi-ai API subpath import: Pi's extension loader aliases the package root to compat.js.
 */
export const nimbleClassifier: ProviderClassifier = {
  async classify(model, context, options) {
    const result = { api: model.api, provider: model.provider, model: model.id, answers: {},
      stopReason: "stop" as "stop" | "error" | "aborted", timestamp: Date.now() };
    try {
      const images: unknown = Reflect.get(context, "images"); // Added to the SDK context after Pi 1.0.
      if ((images !== undefined && (!Array.isArray(images) || images.length > 0))
        || Object.values(context.questions).some(q => q.type !== "bool")) {
        throw new Error("Ollama Nimble adapter accepts text boolean questions only");
      }
      const signal = options?.signal ?? new AbortController().signal;
      signal.throwIfAborted();
      const body = { model: model.id, state: context.state,
        questions: Object.fromEntries(Object.entries(context.questions).map(([id, q]) => [id, { ...q, type: "noul" }])) };
      const transformed = await options?.onPayload?.(body, model);
      const headers = new Headers({ accept: "application/json", "content-type": "application/json" });
      if (options?.apiKey) headers.set("authorization", `Bearer ${options.apiKey}`);
      for (const [key, value] of Object.entries({ ...model.headers, ...options?.headers })) {
        if (typeof value === "string") headers.set(key, value);
      }
      const endpoint = validateEndpoint(new URL("systemone", model.baseUrl.replace(/\/+$/, "") + "/").href);
      const response = await (options?.fetch ?? fetch)(endpoint, { method: "POST", redirect: "error", headers,
        body: JSON.stringify(transformed ?? body), signal });
      if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new Error(`Nimble HTTP ${response.status}`); }
      await options?.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers.entries()) }, model);
      const wire = parseNimbleWire(await boundedJson(response, signal), model.id, Object.keys(context.questions));
      signal.throwIfAborted();
      const input = wire.inputTokens, output = wire.outputTokens;
      return { ...result, answers: Object.fromEntries(Object.entries(wire.probabilities).map(([id, probability]) => [id, { type: "bool" as const, probability }])),
        usage: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    } catch (error) {
      return { ...result, stopReason: options?.signal?.aborted ? "aborted" : "error",
        errorMessage: error instanceof Error ? error.message : "Invalid Nimble response" };
    }
  },
};
