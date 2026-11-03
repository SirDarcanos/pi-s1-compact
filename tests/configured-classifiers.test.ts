import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseClassifierCatalog, registerConfiguredClassifiers } from "../src/configured-classifiers.ts";
import { authenticateClassifier, defaultSettings, guardedFetch, resolveClassifier, scoreClassifier, selectionWithAuth } from "../src/classifier.ts";
import { configuration } from "../src/pruning.ts";
import { harness, memoryStore, messages, config, flush } from "./harness.ts";
import { candidates, ledger } from "../src/pruning.ts";

const clef = { name: "clef", protocol: "ollama-systemone", model: "clef:latest",
  endpoint: "http://127.0.0.1:11434/v1/systemone", contextWindow: 8192 };
const pplx = { ...clef, name: "pplx", model: "pplx-decider:latest" };
const catalog = (classifiers: unknown[] = [clef, pplx]) => ({ version: 1, classifiers });
function sandbox(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "s1-catalog-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function file(dir: string, value: unknown) {
  const path = join(dir, "classifiers.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}

test("catalog accepts named System One classifiers and rejects unsupported configuration without echoing secrets", () => {
  assert.equal(parseClassifierCatalog(catalog()).length, 2);
  for (const value of [null, [], {}, { ...catalog(), version: 2 }, { ...catalog(), extra: true },
    catalog([clef, clef]), catalog([{ ...clef, name: "../escape" }]), catalog([{ ...clef, model: "" }]),
    catalog([{ ...clef, contextWindow: 1999 }]), catalog([{ ...clef, contextWindow: 2.5 }]),
    catalog([{ ...clef, endpoint: "http://remote.example/v1/systemone" }]),
    catalog([{ ...clef, endpoint: "https://user:PRIVATE@host/v1/systemone" }]),
    catalog([{ ...clef, endpoint: clef.endpoint + "?key=PRIVATE" }]),
    catalog([{ ...clef, endpoint: "http://localhost:11434/v1/chat/completions" }]),
    catalog([{ ...clef, apiKey: "PRIVATE" }]), catalog([{ ...clef, apiKeyEnv: "!PRIVATE" }]),
    catalog([{ ...clef, images: true }])]) {
    assert.throws(() => parseClassifierCatalog(value), error => {
      assert.match(String(error), /Classifier catalog/); assert.doesNotMatch(String(error), /PRIVATE/); return true;
    });
  }
  assert.throws(() => parseClassifierCatalog(catalog([{ ...clef, protocol: "openai-chat" }])), /supported protocol is ollama-systemone/);
});

test("absent catalog leaves defaults alone; malformed catalogs and missing credentials never partially register", t => {
  const dir = sandbox(t), calls: string[] = [];
  const pi = { registerProvider: (id: string) => calls.push(id) } as unknown as ExtensionAPI;
  assert.equal(registerConfiguredClassifiers(pi, join(dir, "absent")), undefined);
  assert.deepEqual(defaultSettings(configuration({})).classifier.id, "nimble");
  assert.match(registerConfiguredClassifiers(pi, file(dir, catalog([clef, { ...pplx, apiKeyEnv: "MISSING" }])), {})!, /credential.*unavailable/);
  assert.match(registerConfiguredClassifiers(pi, file(dir, catalog([clef, { ...pplx, protocol: "chat" }])) )!, /supported protocol/);
  const path = file(dir, {}); writeFileSync(path, "PRIVATE invalid JSON");
  assert.match(registerConfiguredClassifiers(pi, path)!, /invalid JSON/);
  assert.match(registerConfiguredClassifiers(pi, dir)!, /unreadable/);
  assert.deepEqual(calls, []);
  const keys: unknown[] = [];
  const withKey = { registerProvider: (_id: string, p: { apiKey: unknown }) => keys.push(p.apiKey) } as unknown as ExtensionAPI;
  assert.equal(registerConfiguredClassifiers(withKey, file(dir, catalog([{ ...clef, apiKeyEnv: "LOCAL_KEY" }])), { LOCAL_KEY: "secret-fixture" }), undefined);
  assert.deepEqual(keys, ["secret-fixture"]);
});

test("actual Pi registry authenticates and scores configured Clef/Decider using guarded System One transport", async t => {
  const dir = sandbox(t);
  const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json"), modelsStorePath: join(dir, "store.json") });
  const registry = new ModelRegistry(runtime);
  const pi = { registerProvider: registry.registerProvider.bind(registry) } as unknown as ExtensionAPI;
  assert.equal(registerConfiguredClassifiers(pi, file(dir, catalog())), undefined);
  for (const c of [clef, pplx]) {
    const model = registry.findOfType("classifier", `s1-compact-config-${c.name}`, c.model)!;
    assert.ok(model);
    const confirmed = await selectionWithAuth(registry, model);
    await authenticateClassifier(registry, model, confirmed); // No-network capability probe.
    assert.equal(resolveClassifier(registry, { version: 1, classifier: confirmed, automatic: true }).id, c.model);
    const transcript = messages(), choices = candidates(transcript, new Set(), 2000);
    let calls = 0;
    const fetcher: typeof fetch = async (url, init) => {
      calls++;
      assert.equal(String(url), c.endpoint); assert.equal(init?.redirect, "error");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, c.model);
      assert.ok(Object.values(body.questions).every((q: any) => q.type === "noul"));
      return Response.json({ model: c.model, answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: "noul", noul: 0.01 }])), usage: { input_tokens: 10, output_tokens: 1 } });
    };
    assert.equal((await scoreClassifier(registry, model, transcript, choices, config, new AbortController().signal, fetcher, confirmed)).evaluated, 1);
    assert.equal(calls, 1);
    const context = { state: {}, questions: { keep: { type: "bool" as const, instructions: "Keep?", criteria: { true: "yes", false: "no" } } } };
    for (const returnedModel of ["nimble-fixture", "wrong-model"]) {
      const result = await registry.classify(model, context, { maxRetries: 0, fetch: async () => Response.json({ model: returnedModel, answers: { keep: { type: "noul", noul: 0.01 } }, usage: { input_tokens: 1, output_tokens: 1 } }) });
      assert.equal(result.stopReason, "error", "configured classifiers reject historical Nimble aliases");
    }
    for (const unsupported of [{ ...context, images: [{ type: "image", data: "PRIVATE" }] },
      { state: {}, questions: { q: { type: "label", labels: ["a", "b"] } } }]) {
      let sent = false;
      const result = await registry.classify(model, unsupported as any, { maxRetries: 0, fetch: async () => { sent = true; throw new Error("Unexpected transport"); } });
      assert.equal(result.stopReason, "error"); assert.equal(sent, false);
      assert.match(result.errorMessage!, /text boolean questions only|does not accept image input/);
    }
    await assert.rejects(guardedFetch(model, fetcher)("https://elsewhere.example/systemone"), /confirmed destination/);
  }
});

test("catalog startup and settings preserve Nimble defaults, consent, saved registry choices, and reload selection", async t => {
  const path = file(sandbox(t), catalog());
  const store = memoryStore();
  let h = await harness({ classifierCatalogPath: path, store });
  await h.command("s1-compact-status");
  assert.ok(h.notices.some(n => n.includes("s1-compact-ollama/nimble")));
  // The configured Decider is last in the picker. Cancelling consent cannot select it.
  h.selectAnswers.push("$last", "$first"); h.confirmations.push(false);
  await h.command("s1-compact-settings"); assert.equal(store.value, undefined);
  h.selectAnswers.push("$last", "$first"); h.confirmations.push(true);
  await h.command("s1-compact-settings");
  assert.equal(store.value!.classifier.provider, "s1-compact-config-pplx");
  assert.equal(store.value!.classifier.id, pplx.model);
  assert.doesNotMatch(JSON.stringify(store.value), /apiKey|secret/);
  assert.ok(h.notices.some(n => n.includes("Selected evidence is sent to this destination")));
  h = await harness({ classifierCatalogPath: path, store });
  await h.command("s1-compact-status");
  assert.ok(h.notices.some(n => n.includes(`s1-compact-config-pplx/${pplx.model}`)));
  // Removing a configured model preserves the saved selection and pauses, never uses Nimble.
  writeFileSync(path, JSON.stringify(catalog([])));
  h = await harness({ classifierCatalogPath: path, store });
  await h.command("s1-compact"); await flush();
  assert.equal(h.sent.length, 0); assert.equal(ledger(h.sm.getBranch()).size, 0);
  assert.ok(h.notices.some(n => n.includes("unavailable") && n.includes("no fallback")));
});

test("invalid catalog pauses all new pruning and keeps full output projections", async t => {
  const path = file(sandbox(t), catalog([{ ...clef, protocol: "chat" }]));
  const h = await harness({ classifierCatalogPath: path });
  await h.command("s1-compact"); await h.fire("turn_end"); await flush();
  assert.equal(h.sent.length, 0); assert.equal(ledger(h.sm.getBranch()).size, 0);
  const transcript = messages();
  const projection = await h.fire("context", { messages: transcript });
  assert.deepEqual(projection.messages, transcript, "full original messages remain in the projection");
  assert.ok(h.notices.some(n => n.includes("supported protocol is ollama-systemone")));
});
