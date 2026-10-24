import { SessionManager, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ClassifierContext, ClassifierModel, ClassifierApi, ClassifierResult, ModelsClassifierOptions } from "@earendil-works/pi-ai";
import { registerS1 } from "../extensions/s1-compact.ts";
import { configuration, type Config } from "../src/pruning.ts";
import { CAPABILITY_QUESTION, defaultSettings, type Classifier } from "../src/classifier.ts";
import type { Settings, SettingsStore } from "../src/settings.ts";

export const config: Config = { ...configuration({}), keepRecentTokens: 2000, maxPaybackTurns: 1000 };
export const second: Classifier = { provider: "second", id: "classifier-v2", name: "Second classifier", type: "classifier",
  api: "typesafe-system-one", baseUrl: "https://classifier.example/v1", input: ["text"], contextWindow: 16000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
export function messages(id = "old") {
  return [
    { role: "user", content: "Fix parser; preserve public contracts.", timestamp: 0 },
    { role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path: `${id}.ts` } }],
      api: "openai-responses", provider: "openai", model: "fixture", stopReason: "toolUse", timestamp: 1,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
    { role: "toolResult", toolName: "read", toolCallId: id, content: [{ type: "text", text: `ORIGINAL_${id}\n` + "source line\n".repeat(1500) }], timestamp: 2, isError: false },
    { role: "user", content: "Recent task " + "recent context ".repeat(1000), timestamp: 3 },
  ] as Parameters<SessionManager["appendMessage"]>[0][];
}
export function memoryStore(initial?: Settings): SettingsStore & { value?: Settings; failure?: boolean } {
  return { value: initial,
    async load() { return this.value; },
    async save(settings) { if (this.failure) throw new Error("Storage failure"); this.value = structuredClone(settings); } };
}
export async function harness(options: { config?: Config; store?: SettingsStore; probability?: number;
  classify?: (model: Classifier, context: ClassifierContext, opts?: ModelsClassifierOptions) => Promise<ClassifierResult>;
  fetch?: typeof fetch; manager?: SessionManager } = {}) {
  const sm = options.manager ?? SessionManager.inMemory("/tmp/s1-fixture");
  for (const message of messages()) sm.appendMessage(message);
  const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => any>>();
  const commands = new Map<string, any>(), tools = new Map<string, ToolDefinition>();
  const notices: string[] = [], statuses: Array<string | undefined> = [], sent: ClassifierContext[] = [];
  const modelList: Classifier[] = [structuredClone(second)];
  const store = options.store ?? memoryStore();
  let active = ["nimble_read"], extraCommands: any[] = [], unavailable = false;
  const authBaseUrls = new Map<string, string>();
  const selectAnswers: Array<string | undefined> = [], confirmations: boolean[] = [];
  const registry = {
    async refresh(_options?: { signal?: AbortSignal }) {},
    getProvider(provider: string) { return modelList.some(m => m.provider === provider) ? { classify: () => {} } : undefined; },
    findOfType(_type: string, provider: string, id: string) { return modelList.find(m => m.provider === provider && m.id === id); },
    async getAvailableOfType(_type?: string, provider?: string, _options?: { signal?: AbortSignal }) {
      return unavailable ? [] : modelList.filter(m => !provider || m.provider === provider);
    },
    async getProviderAuth(provider: string) { return unavailable ? undefined : { auth: { apiKey: "fixture", baseUrl: authBaseUrls.get(provider) } }; },
    async classify(model: Classifier, context: ClassifierContext, opts?: ModelsClassifierOptions) {
      if (Object.hasOwn(context.questions, CAPABILITY_QUESTION)) return { provider: model.provider, model: model.id, api: model.api,
        stopReason: "stop", timestamp: 0, answers: { [CAPABILITY_QUESTION]: { type: "bool", probability: 1 } } };
      sent.push(context);
      if (options.classify) return options.classify(model, context, opts);
      if (unavailable) return { provider: model.provider, model: model.id, api: model.api, stopReason: "error", errorMessage: "No credentials/model unavailable", answers: {}, timestamp: 0 };
      const fetcher = opts!.fetch!;
      const effective = { ...model, baseUrl: authBaseUrls.get(model.provider) ?? model.baseUrl };
      await opts?.onPayload?.({}, effective);
      const response = await fetcher(new URL("systemone", effective.baseUrl.replace(/\/+$/, "") + "/"), { method: "POST", signal: opts?.signal,
        body: JSON.stringify({ model: model.id, state: context.state, questions: Object.fromEntries(Object.entries(context.questions).map(([k,q])=>[k,{...q,type:"noul"}])) }) });
      const wire = await response.json() as any;
      return { provider: model.provider, model: model.id, api: model.api, stopReason: "stop", timestamp: 0,
        answers: Object.fromEntries(Object.entries(wire.answers).map(([id,a])=>[id,{type:"bool",probability:(a as any).noul}])) };
    },
  };
  const ctx = { sessionManager: sm, model: { contextWindow: 100000 }, modelRegistry: registry,
    getContextUsage: () => ({ tokens: 70000 }), waitForIdle: async () => {}, hasUI: true,
    ui: { notify: (s: string) => notices.push(s), setStatus: (_key: string, s?: string) => statuses.push(s),
      select: async (_title: string, labels: string[]) => { const value = selectAnswers.shift(); return value === "$first" ? labels[0] : value === "$last" ? labels.at(-1) : value; },
      confirm: async (_title: string, prompt: string) => { notices.push(prompt); return confirmations.shift() ?? false; } } } as unknown as ExtensionContext;
  const pi = { on(name: string, fn: any) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
    appendEntry(type: string, data: unknown) { sm.appendCustomEntry(type, data); },
    registerCommand(name: string, c: any) { commands.set(name, c); }, registerTool(t: ToolDefinition) { tools.set(t.name,t); },
    getActiveTools() { return active; },
    getCommands() { return [...commands.keys()].map(name=>({name,source:"extension",sourceInfo:{path:"/successor.ts"}})).concat(extraCommands); },
    registerProvider(provider: string, p: any) {
      modelList.push(...p.models.map((m: any)=>({...m,provider,baseUrl:p.baseUrl} as ClassifierModel<ClassifierApi>)));
    },
  } as unknown as ExtensionAPI;
  const fetcher: typeof fetch = options.fetch ?? (async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    return Response.json({ model: body.model, answers: Object.fromEntries(Object.keys(body.questions).map(id=>[id,{type:"noul",noul:options.probability ?? 0.01}])), usage:{input_tokens:100,output_tokens:1} });
  }) as typeof fetch;
  registerS1(pi, { config: options.config ?? config, store, fetch: fetcher });
  async function fire(name: string, event: any = {}) {
    let result: any;
    for (const fn of handlers.get(name) ?? []) result = await fn(event,ctx);
    // Drain resolved auth-preflight microtasks without awaiting gated classifier work.
    if (name === "turn_end" || name === "context") for (let i = 0; i < 16; i++) await Promise.resolve();
    return result;
  }
  await fire("session_start");
  return { sm, pi, ctx, handlers, commands, tools, notices, statuses, sent, store, modelList, registry, selectAnswers, confirmations, fire,
    command: (name: string, args = "") => commands.get(name).handler(args,ctx),
    active(names: string[]) { active = names; }, unavailable(value = true) { unavailable = value; },
    authDestination(provider: string, baseUrl: string) { authBaseUrls.set(provider, baseUrl); },
    foreign(path = "/renamed-copy.ts") { extraCommands = ["nimble-compact:2","nimble-status:2","nimble-reset:2"].map(name=>({name,source:"extension",sourceInfo:{path}})); },
  };
}
export async function flush() { for (let i=0;i<5;i++) await new Promise<void>(resolve=>setImmediate(resolve)); }
