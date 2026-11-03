import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Type } from "typebox";
import { buildSessionContext, createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai/compat";
import { registerS1 } from "../extensions/s1-compact.ts";
import { ownedRetrievalTool } from "../src/activation.ts";
import { configuration, ledger, reference, textOf } from "../src/pruning.ts";
import { flush, harness, memoryStore, messages } from "./harness.ts";

test("retrieval ownership rejects missing, ambiguous, and unavailable metadata", async () => {
  const h = await harness();
  assert.equal(ownedRetrievalTool(h.pi), "s1_compact_read");
  h.toolOwner("s1_compact_read", "/foreign.ts");
  assert.equal(ownedRetrievalTool(h.pi), "nimble_read");
  h.toolOwner("nimble_read", "/foreign.ts");
  assert.equal(ownedRetrievalTool(h.pi), undefined);
  const getAllTools = h.pi.getAllTools;
  h.pi.getAllTools = () => { throw new Error("not available"); };
  assert.equal(ownedRetrievalTool(h.pi), undefined);
  h.pi.getAllTools = () => getAllTools().map(tool => ({ ...tool, sourceInfo: undefined as any }));
  assert.equal(ownedRetrievalTool(h.pi), undefined);
  h.pi.getAllTools = () => [...getAllTools(), ...getAllTools()];
  assert.equal(ownedRetrievalTool(h.pi), undefined);
});

test("ownership loss during inference prevents late reductions even with both names active", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const h = await harness({ classify: async (model, context) => {
    await gate;
    return { provider: model.provider, model: model.id, api: model.api, stopReason: "stop", timestamp: 0,
      answers: Object.fromEntries(Object.keys(context.questions).map(id => [id, { type: "bool", probability: 0 }])) };
  } });
  await h.fire("turn_end"); assert.equal(h.sent.length, 1);
  h.toolOwner("s1_compact_read", "/foreign.ts"); h.toolOwner("nimble_read", "/foreign.ts");
  release(); await flush();
  assert.equal(ledger(h.sm.getBranch()).size, 0);
  assert.equal(await h.fire("context", { messages: buildSessionContext(h.sm.getBranch()).messages }), undefined);
});

const cases = [
  { foreign: ["s1_compact_read"], active: ["s1_compact_read", "nimble_read"], expected: "nimble_read", first: true },
  { foreign: ["s1_compact_read"], active: ["s1_compact_read"], expected: undefined, first: true },
  { foreign: ["nimble_read"], active: ["s1_compact_read", "nimble_read"], expected: "s1_compact_read", first: true },
  { foreign: ["s1_compact_read", "nimble_read"], active: ["s1_compact_read", "nimble_read"], expected: undefined, first: true },
  { foreign: ["s1_compact_read"], active: ["s1_compact_read", "nimble_read"], expected: "s1_compact_read", first: false },
];
for (const scenario of cases) {
  test(`real SDK collision: foreign ${scenario.foreign}, active ${scenario.active}, foreign-first=${scenario.first}`, async t => {
    const dir = mkdtempSync(join(tmpdir(), "s1-tool-owner-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const sm = SessionManager.inMemory(dir);
    for (const message of messages()) sm.appendMessage(message);
    let scoring = 0, foreignCalls = 0;
    const config = { ...configuration({}), keepRecentTokens: 2000, maxPaybackTurns: 1000 };
    const foreign = (pi: any) => {
      for (const name of scenario.foreign) pi.registerTool({ name, label: "Foreign tool", description: "Unrelated tool",
        parameters: Type.Object({}), async execute() { foreignCalls++; throw new Error("Foreign tool cannot retrieve session refs"); } });
    };
    const successor = (pi: any) => registerS1(pi, { config, store: memoryStore(), fetch: async (_url, init) => {
      scoring++;
      const body = JSON.parse(String(init?.body));
      return Response.json({ model: "nimble", answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: "noul", noul: 0 }])),
        usage: { input_tokens: 1, output_tokens: 1 } });
    } });
    const settings = SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings,
      extensionFactories: scenario.first ? [foreign, successor] : [successor, foreign],
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await loader.reload();
    assert.equal(loader.getExtensions().errors.length, scenario.foreign.length);
    const model: Model<"openai-responses"> = { id: "fixture", name: "Fixture", provider: "openai", api: "openai-responses",
      baseUrl: "https://example.invalid", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json"), modelsStorePath: join(dir, "models-store.json") });
    const { session } = await createAgentSession({ cwd: dir, agentDir: dir, model, modelRuntime: runtime, resourceLoader: loader,
      sessionManager: sm, settingsManager: settings, noTools: "builtin" });
    t.after(() => session.dispose());
    await session.bindExtensions({ mode: "json" });
    session.setActiveToolsByName(scenario.active);
    const runner = (session as any)._extensionRunner;
    const commands = runner.getRegisteredCommands();
    const ctx = { ...runner.createContext(), waitForIdle: async () => {} };
    await commands.find((c: any) => c.name === "s1-compact").handler("", ctx);
    assert.equal(scoring, scenario.expected ? 1 : 0);
    assert.equal(ledger(sm.getBranch()).size, scenario.expected ? 1 : 0);
    const original = buildSessionContext(sm.getBranch()).messages.find(m => m.role === "toolResult")!;
    assert.equal(original.role, "toolResult");
    // Historical masks also must not direct retrieval to a foreign tool.
    if (!scenario.expected) sm.appendCustomEntry("pi-nimble-pruning", { version: 1, refs: [reference(original)] });
    const projected = await runner.emitContext(buildSessionContext(sm.getBranch()).messages);
    const output = projected.find((m: any) => m.role === "toolResult");
    if (scenario.expected) assert.match(textOf(output), new RegExp(`Retrieve with ${scenario.expected}\\(`));
    else assert.equal(textOf(output), textOf(original));
    assert.equal(foreignCalls, 0);
  });
}
