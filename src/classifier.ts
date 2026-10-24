import { nimbleClassifier } from "./nimble-registry.ts";
import type { ClassifierApi, ClassifierContext, ClassifierModel, ClassifierResult, JsonObject } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { NIMBLE_BUDGET, requestBody, type Candidate, type Config } from "./pruning.ts";
import { boundedJson } from "./legacy-nimble.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { validateEndpoint } from "./engine/request.ts";
import { LOCAL_PROVIDER, type Selection, type Settings } from "./settings.ts";

export type Classifier = ClassifierModel<ClassifierApi>;
export type Registry = ExtensionContext["modelRegistry"];
export function destination(model: Classifier): string {
  const url = new URL(validateEndpoint(model.baseUrl));
  return url.href.replace(/\/+$/, "");
}
export function destinationLabel(model: Classifier): string {
  try {
    const url = new URL(destination(model));
    const kind = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ? "local loopback" : "remote/hosted";
    return `${kind}: ${url.origin}${url.pathname}`;
  } catch { return "unknown/invalid destination (cannot select)"; }
}
export function selection(model: Classifier): Selection {
  return { provider: model.provider, id: model.id, destination: destination(model), api: model.api };
}

export function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason ?? new Error("Authentication cancelled")); };
    signal.addEventListener("abort", abort, { once: true });
    operation.then(value => { signal.removeEventListener("abort", abort); resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error); });
    if (signal.aborted) abort();
  });
}

/** Resolve only destination metadata from Pi's auth; never persist credentials. */
export async function selectionWithAuth(registry: Registry, model: Classifier, signal?: AbortSignal): Promise<Selection> {
  signal?.throwIfAborted();
  const catalog = destination(model);
  const auth = await abortable(registry.getProviderAuth(model.provider), signal);
  signal?.throwIfAborted();
  if (!auth) throw new Error(`Selected classifier credentials unavailable: ${model.provider}/${model.id}; no fallback`);
  // Pi materializes Workers AI placeholders from resolved auth.env, not necessarily auth.baseUrl.
  // Keep the raw catalog model intact for Pi's own request-time auth/provider resolution.
  let effective = auth.auth.baseUrl ?? model.baseUrl;
  for (const name of ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID"]) {
    const value = auth.env?.[name];
    if (value !== undefined) effective = effective.replaceAll(`{${name}}`, value);
  }
  if (/[{}]|%7[bd]/i.test(effective)) throw new Error("Classifier destination has unresolved placeholders; check Pi provider authentication");
  const selected = selection({ ...model, baseUrl: effective });
  if (selected.destination !== catalog) selected.registryDestination = catalog;
  return selected;
}

function requireClassifierImplementation(registry: Registry, model: Classifier): void {
  if (typeof registry.getProvider(model.provider)?.classify !== "function") {
    throw new Error(`Selected classifier provider unavailable: ${model.provider}; classification is not supported`);
  }
}

function assertCatalogSnapshot(registry: Registry, model: Classifier): void {
  const current = registry.findOfType("classifier", model.provider, model.id);
  if (!current || current.api !== model.api || destination(current) !== destination(model)) {
    throw new Error("Classifier catalog destination/API changed before dispatch; confirm again in /s1-compact-settings");
  }
}

export const CAPABILITY_QUESTION = "__s1_compact_capability";

/** Exercise the SDK's actual API dispatcher, never its network. No conversation/output evidence is supplied. */
async function verifyClassifierImplementation(registry: Registry, model: Classifier, confirmed: Selection, signal?: AbortSignal): Promise<void> {
  const expected = { ...model, baseUrl: confirmed.destination };
  let reachedTransport = false;
  const blocked: typeof fetch = async () => {
    assertCatalogSnapshot(registry, model);
    reachedTransport = true;
    throw new Error("S1 Compact no-network capability probe");
  };
  const result = await abortable(registry.classify(model, {
    state: {},
    questions: { [CAPABILITY_QUESTION]: { type: "bool", instructions: "Boolean API capability check",
      criteria: { true: "Supported", false: "Unsupported" } } },
  }, {
    signal, maxRetries: 0, fetch: guardedFetch(expected, blocked),
    onPayload: (_payload, effective) => { assertCatalogSnapshot(registry, model); assertRequestModel(expected, effective); },
  }), signal);
  signal?.throwIfAborted();
  assertCatalogSnapshot(registry, model);
  // A known API reached our rejecting fetch, proving local dispatch without sending a request.
  if (reachedTransport) return;
  // In-process native classifiers may answer without any transport.
  const answer = result.answers?.[CAPABILITY_QUESTION];
  if (result.stopReason === "stop" && result.provider === model.provider && result.model === model.id && result.api === model.api
    && answer?.type === "bool" && Number.isFinite(answer.probability) && answer.probability >= 0 && answer.probability <= 1) return;
  throw new Error(`Selected classifier API implementation unavailable: ${model.provider}/${model.id} (${model.api}); ${result.errorMessage || "invalid capability response"}`);
}

export async function authenticateClassifier(registry: Registry, model: Classifier, confirmed: Selection, signal?: AbortSignal): Promise<void> {
  requireClassifierImplementation(registry, model);
  const available = await abortable(registry.getAvailableOfType("classifier", model.provider, { signal }), signal);
  signal?.throwIfAborted();
  if (!available.some(candidate => candidate.provider === model.provider && candidate.id === model.id && candidate.api === model.api)) {
    throw new Error(`Selected classifier credentials unavailable or not authorized for classification: ${model.provider}/${model.id}; no fallback`);
  }
  const current = await selectionWithAuth(registry, model, signal);
  if (current.provider !== confirmed.provider || current.id !== confirmed.id || current.api !== confirmed.api
    || current.destination !== confirmed.destination
    || (current.registryDestination ?? current.destination) !== (confirmed.registryDestination ?? confirmed.destination)) {
    throw new Error("Effective classifier destination/API changed; confirm again in /s1-compact-settings");
  }
  await verifyClassifierImplementation(registry, model, confirmed, signal);
}

function assertRequestModel(expected: Classifier, actual: Classifier): void {
  if (actual.provider !== expected.provider || actual.id !== expected.id || actual.api !== expected.api
    || destination(actual) !== destination(expected)) {
    throw new Error("Effective classifier destination/API changed; confirm again in /s1-compact-settings");
  }
}

function requestPaths(model: Classifier): Set<string> | undefined {
  const base = new URL(destination(model)).pathname.replace(/\/+$/, "");
  switch (model.api) {
    case "typesafe-system-one": return new Set([`${base}/systemone`]);
    case "cloudflare-workers-ai-system-one": return new Set([`${base}/run`]);
    case "openai-decisions": return new Set([`${base}/decisions`]);
    case "llama-cpp-classify": {
      const root = base.replace(/\/v1$/, "");
      return new Set(["tokenize", "apply-template", "completion"].map(p => `${root}/${p}`));
    }
    default: return undefined; // Custom APIs remain confined to the confirmed base-path subtree.
  }
}

/** Register the narrow Ollama wire adapter behind Pi's classifier/authentication registry. */
export function registerLocalNimble(pi: ExtensionAPI, config: Config): string | undefined {
  if (!config.endpoint) return "Pruning disabled by empty PI_NIMBLE_URL";
  try {
    const endpoint = new URL(validateEndpoint(config.endpoint));
    if (!endpoint.pathname.endsWith("/systemone")) throw new Error("PI_NIMBLE_URL must end in /systemone");
    endpoint.pathname = endpoint.pathname.slice(0, -"systemone".length);
    pi.registerProvider(LOCAL_PROVIDER, {
      name: "S1 Compact · Ollama Nimble",
      baseUrl: endpoint.href,
      apiKey: config.apiKey || "ollama",
      classifiers: { "typesafe-system-one": nimbleClassifier },
      models: [{ type: "classifier", id: config.model, name: `Ollama ${config.model}`,
        api: "typesafe-system-one", input: ["text"], contextWindow: 8192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    });
  } catch (error) { return error instanceof Error ? error.message : "Invalid Nimble provider"; }
}
export function defaultSettings(config: Config): Settings {
  const url = new URL(validateEndpoint(config.endpoint));
  url.pathname = url.pathname.replace(/systemone$/, "");
  const base = url.href.replace(/\/+$/, "");
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Legacy remote endpoint needs destination confirmation in /s1-compact-settings");
  }
  return { version: 1, automatic: true,
    classifier: { provider: LOCAL_PROVIDER, id: config.model, destination: base, api: "typesafe-system-one" } };
}
export function resolveClassifier(registry: Registry, settings: Settings): Classifier {
  if (typeof registry?.classify !== "function" || typeof registry.findOfType !== "function") {
    throw new Error("Pi >=1.0.0 with classifier registry support is required");
  }
  const c = settings.classifier;
  const model = registry.findOfType("classifier", c.provider, c.id);
  if (!model) throw new Error(`Selected classifier unavailable: ${c.provider}/${c.id}; no fallback`);
  if (destination(model) !== (c.registryDestination ?? c.destination) || model.api !== c.api) {
    throw new Error("Classifier destination/API changed; confirm again in /s1-compact-settings");
  }
  requireClassifierImplementation(registry, model);
  return { ...model };
}

/** Enforce response bounds and refuse redirects for every registry transport. No retry or fallback. */
export function guardedFetch(expected: Classifier, fetcher: typeof fetch = fetch): typeof fetch {
  const base = new URL(destination(expected));
  const allowedPaths = requestPaths(expected);
  const basePath = base.pathname.replace(/\/+$/, "");
  return (async (input, init) => {
    const target = new URL(validateEndpoint(input instanceof Request ? input.url : String(input)));
    const pathAllowed = allowedPaths ? allowedPaths.has(target.pathname)
      : !/%(?:2e|2f|5c|25)/i.test(target.pathname)
        && (target.pathname === basePath || target.pathname.startsWith(`${basePath}/`));
    if (target.origin !== base.origin || !pathAllowed) throw new Error("Classifier request changed confirmed destination/path");
    const response = await fetcher(input, { ...init, redirect: "error" });
    if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new Error(`Classifier HTTP ${response.status}`); }
    const data = await boundedJson(response, init?.signal ?? new AbortController().signal);
    return Response.json(data, { status: response.status, headers: response.headers });
  }) as typeof fetch;
}

export async function scoreClassifier(
  registry: Registry, model: Classifier, messages: readonly AgentMessage[], choices: readonly Candidate[],
  config: Config, signal: AbortSignal, fetcher?: typeof fetch, confirmed: Selection = selection(model),
): Promise<{ refs: string[]; keptRefs: string[]; evaluated: number; inputTokens: number | null }> {
  const nimble = model.provider === LOCAL_PROVIDER && /^(nimble(?::latest)?|bespokelabs\/Bespoke-Nimble-[\w.-]+)$/.test(model.id);
  // Nimble's measured profile is not transferred to other models. Registry models use a
  // smaller conservative request and retain unless P(unique evidence) < .05. Not calibrated quality evidence.
  const tokens = Math.min(nimble ? NIMBLE_BUDGET.tokens : 4000, Math.floor(model.contextWindow / 2));
  if (!Number.isFinite(tokens) || tokens < 1000) throw new Error("Classifier context window is missing or too small");
  const budget = nimble ? { ...NIMBLE_BUDGET, tokens, stateTokens: Math.min(2000, Math.floor(tokens / 3)) }
    : { tokens, stateTokens: Math.min(1000, Math.floor(tokens / 4)), bytes: tokens * 3, questions: 4 };
  const request = requestBody(messages, choices, model.id, budget);
  const body = JSON.parse(request.body);
  const context: ClassifierContext = { state: body.state as JsonObject,
    questions: Object.fromEntries(Object.entries(body.questions).map(([id, q]) =>
      [id, { ...(q as object), type: "bool" }])) as ClassifierContext["questions"] };
  const expected = { ...model, baseUrl: confirmed.destination };
  const assertCurrentCatalog = () => assertCatalogSnapshot(registry, model);
  const dispatch: typeof fetch = (input, init) => { assertCurrentCatalog(); return (fetcher ?? fetch)(input, init); };
  const result: ClassifierResult = await registry.classify(model, context, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(Math.floor(config.timeoutMs))]),
    timeoutMs: Math.floor(config.timeoutMs), maxRetries: 0, fetch: guardedFetch(expected, dispatch),
    onPayload: (_payload, effectiveModel) => { assertCurrentCatalog(); assertRequestModel(expected, effectiveModel); },
  });
  signal.throwIfAborted();
  if (result.stopReason !== "stop") throw new Error(result.errorMessage || `Classifier ${result.stopReason}; no fallback`);
  const ids = Object.keys(context.questions);
  if (result.provider !== model.provider || result.model !== model.id || result.api !== model.api
    || !result.answers || Object.keys(result.answers).length !== ids.length) throw new Error("Invalid classifier result identity/answers");
  const refs: string[] = [], keptRefs: string[] = [];
  for (const [index, item] of request.choices.entries()) {
    const answer = result.answers[`r${index}`];
    if (answer?.type !== "bool" || !Number.isFinite(answer.probability) || answer.probability < 0 || answer.probability > 1) {
      throw new Error("Invalid classifier probability; context unchanged");
    }
    if (answer.probability < (nimble ? config.keepThreshold : 0.05)) refs.push(item.ref);
    else keptRefs.push(item.ref);
  }
  return { refs, keptRefs, evaluated: request.choices.length, inputTokens: result.usage?.input ?? null };
}
