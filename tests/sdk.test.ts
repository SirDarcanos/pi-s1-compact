import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssistantMessageEventStream, type Credential, type CredentialStore } from "@earendil-works/pi-ai";
import { classify as classifySystemOne } from "@earendil-works/pi-ai/api/typesafe-system-one";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai/compat";
import {
  buildSessionContext, createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerS1 } from "../extensions/s1-compact.ts";
import { memoryStore, second, messages, harness } from "./harness.ts";
import { selection, selectionWithAuth, authenticateClassifier, resolveClassifier, guardedFetch, registerLocalNimble, scoreClassifier } from "../src/classifier.ts";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { registerNimble } from "./fixtures/legacy-nimble.ts";
import { nimbleClassifier } from "../src/nimble-registry.ts";
import { candidates, superseded, configuration, ledger } from "../src/pruning.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const sdkPackages = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-agent-core", "@earendil-works/pi-ai"];
const sdkVersions = sdkPackages.map(name => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.resolve(name)), "utf8"));
  assert.equal(manifest.name, name);
  return manifest.version as string;
});
const piVersion = sdkVersions[0]!;
test("SDK resolution matches the requested compatibility target", () => {
  const expected = process.env.S1_COMPACT_EXPECT_PI_VERSION ?? piVersion;
  assert.deepEqual(sdkVersions, sdkPackages.map(() => expected));
});
function sandbox(t: { after(fn: () => void): void }) {
  const path = mkdtempSync(join(tmpdir(), "pi-nimble-sdk-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

test("Nimble's text-only guard works with older and newer SDK image fields", async () => {
  const model = { ...second, id: "nimble" };
  for (const images of [undefined, [], [{ type: "image", data: "PRIVATE_IMAGE", mimeType: "image/png" }], null, {}, "invalid"]) {
    const context: Parameters<typeof nimbleClassifier.classify>[1] = {
      state: { evidence: "synthetic" }, questions: { q: { type: "bool", instructions: "Keep?", criteria: { true: "keep", false: "retrieve" } } },
    };
    if (images !== undefined) Reflect.set(context, "images", images);
    let calls = 0;
    const result = await nimbleClassifier.classify(model, context, { fetch: async (_url, init) => {
      calls++;
      assert.doesNotMatch(String(init?.body), /PRIVATE_IMAGE|"images"/);
      return Response.json({ model: "nimble", answers: { q: { type: "noul", noul: 0.01 } }, usage: { input_tokens: 1, output_tokens: 1 } });
    } });
    const allowed = images === undefined || (Array.isArray(images) && images.length === 0);
    assert.equal(result.stopReason, allowed ? "stop" : "error");
    assert.equal(calls, allowed ? 1 : 0, "images must be rejected before transport");
  }
});

test("Pi's resource loader loads the actual package entrypoint", async t => {
  const dir = sandbox(t);
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager: SettingsManager.inMemory(),
    additionalExtensionPaths: [join(root, "extensions/s1-compact.ts")],
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  assert.ok(loaded.extensions[0]!.tools.has("nimble_read"));
  assert.ok(loaded.extensions[0]!.handlers.has("turn_end"));
});

test("active Pi tool loop scores concurrently and prunes a later model request", async t => {
  const dir = sandbox(t);
  const sm = SessionManager.inMemory(dir);
  const model: Model<"openai-responses"> = {
    id: "fixture", name: "Fixture", provider: "openai", api: "openai-responses", baseUrl: "https://example.invalid",
    reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 4_096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const assistant = (content: AssistantMessage["content"], input = 0, stopReason: "stop" | "toolUse" = "stop"): AssistantMessage => ({
    role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
    stopReason, timestamp: Date.now(),
    usage: { input, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: input + 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  sm.appendMessage({ role: "user", content: "Inspect source then fix it", timestamp: 0 });
  sm.appendMessage(assistant([{ type: "toolCall", id: "old-read", name: "read", arguments: { path: "old.ts" } }]));
  const evidence = { role: "toolResult" as const, toolCallId: "old-read", toolName: "read",
    content: [{ type: "text" as const, text: "ORIGINAL_EVIDENCE\n" + "line\n".repeat(2_000) }], isError: false, timestamp: 1 };
  sm.appendMessage(evidence);
  sm.appendMessage({ role: "user", content: "Latest context " + "recent ".repeat(2_000), timestamp: 2 });
  let evaluations = 0;
  let releaseEvaluation!: () => void;
  const evaluationGate = new Promise<void>(resolve => { releaseEvaluation = resolve; });
  const settings = SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager: settings,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [
      pi => pi.registerTool({
        name: "fixture_output", label: "Fixture output", description: "Return fixture output.",
        parameters: Type.Object({}),
        async execute() { return { content: [{ type: "text" as const, text: "fresh output" }], details: {} }; },
      }),
      pi => registerS1(pi, {
        store: memoryStore(),
        // This test covers asynchronous persistence/projection, not cache economics.
        // SDK-generated system prompts vary with the installation layout; use a
        // generous payback horizon here. Dedicated pruning tests cover the gate.
        config: { ...configuration({}), endpoint: "http://127.0.0.1:8000/v1/systemone", apiKey: "fixture",
          keepRecentTokens: 2_000, maxPaybackTurns: 1_000 },
        fetch: (async (_url, init) => {
          evaluations++;
          const request = JSON.parse(String(init?.body));
          await evaluationGate;
          return Response.json({
            model: "nimble-fixture",
            answers: Object.fromEntries(Object.keys(request.questions).map(key => [key, { type: "noul", noul: 0.01 }])),
            usage: { input_tokens: 1, output_tokens: 1 },
          });
        }) as typeof fetch,
      }),
    ],
  });
  await loader.reload();
  const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json"), modelsStorePath: join(dir, "models-store.json") });
  await runtime.setRuntimeApiKey("openai", "offline-fixture-key");
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, model, modelRuntime: runtime,
    resourceLoader: loader, sessionManager: sm, settingsManager: settings, noTools: "builtin", thinkingLevel: "off" });
  t.after(() => session.dispose());
  await session.bindExtensions({ mode: "json" });
  const sent: string[] = [];
  session.agent.streamFunction = (_model, context) => {
    sent.push(JSON.stringify(context.messages));
    const stream = createAssistantMessageEventStream();
    const request = sent.length;
    const toolUse = request < 3;
    const message = toolUse
      ? assistant([{ type: "toolCall", id: `live-call-${request}`, name: "fixture_output", arguments: {} }], request === 1 ? 70_000 : 0, "toolUse")
      : assistant([{ type: "text", text: "Finished." }]);
    const finish = () => {
      stream.push({ type: "done", reason: toolUse ? "toolUse" : "stop", message });
      stream.end(message);
    };
    if (request === 2) {
      releaseEvaluation();
      setImmediate(() => setImmediate(finish));
    } else finish();
    return stream;
  };
  await session.prompt("Continue the work.");
  assert.equal(sent.length, 3);
  assert.equal(evaluations, 1);
  assert.equal(ledger(sm.getBranch()).size, 1);
  assert.match(sent[0]!, /ORIGINAL_EVIDENCE/);
  assert.match(sent[1]!, /ORIGINAL_EVIDENCE/, "the next request must not wait for unfinished scoring");
  assert.doesNotMatch(sent[2]!, /ORIGINAL_EVIDENCE/);
  assert.match(sent[2]!, /nimble_read/);
  assert.match(evidence.content[0]!.text, /ORIGINAL_EVIDENCE/);
});

for (const backend of ["nimble", "second"] as const) {
  test(`actual Pi ${piVersion} registry ${backend} transport maps bool to noul without a model call`, async t => {
    const dir = sandbox(t);
    const runtime = await ModelRuntime.create({ authPath: join(dir,"auth.json"), modelsPath:join(dir,"models.json"), modelsStorePath:join(dir,"models-store.json") });
    const registry = new ModelRegistry(runtime);
    registerLocalNimble({ registerProvider: registry.registerProvider.bind(registry) } as any, configuration({}));
    registry.registerProvider(second.provider, { apiKey:"fixture-key", baseUrl:second.baseUrl,
      classifiers:{"typesafe-system-one":{classify:classifySystemOne}},
      models:[{type:"classifier",id:second.id,name:second.name,api:second.api,input:["text"],contextWindow:second.contextWindow,cost:second.cost}] });
    const model = registry.findOfType("classifier", backend === "nimble" ? "s1-compact-ollama" : second.provider, backend === "nimble" ? "nimble" : second.id)!;
    assert.ok(model);
    const available = await registry.getAvailableOfType("classifier");
    assert.ok(available.some(m=>m.provider===model.provider && m.id===model.id));
    let requests=0;
    const result = await registry.classify(model, {state:{evidence:"synthetic"},questions:{keep:{type:"bool",instructions:"Keep?",criteria:{true:"keep",false:"retrieve"}}}}, {
      maxRetries:0,
      fetch:guardedFetch(model, (async (url,init)=>{
        requests++;
        assert.equal(String(url),model.baseUrl.replace(/\/+$/,"")+"/systemone");
        const request=JSON.parse(String(init?.body));assert.equal(request.questions.keep.type,"noul");
        assert.equal(init?.redirect,"error");
        return Response.json({model:model.id,answers:{keep:{type:"noul",noul:0.01}},usage:{input_tokens:10,output_tokens:1}});
      }) as typeof fetch),
    });
    assert.equal(result.stopReason,"stop", result.errorMessage);assert.equal(result.answers.keep?.type,"bool");assert.equal(requests,1);
  });
}

test("production registry scoring preserves strict Nimble raw model/schema/usage checks",async t=>{
  const dir=sandbox(t),runtime=await ModelRuntime.create({authPath:join(dir,"auth.json"),modelsPath:join(dir,"models.json"),modelsStorePath:join(dir,"models-store.json")});
  const registry=new ModelRegistry(runtime),config={...configuration({}),keepRecentTokens:2000};
  registerLocalNimble({registerProvider:registry.registerProvider.bind(registry)} as any,config);
  const model=registry.findOfType("classifier","s1-compact-ollama","nimble")!;
  const transcript=messages(), choices=candidates(transcript,new Set(),2000);
  assert.equal(choices.length,1);
  for(const mutate of [
    (r:any)=>({...r,model:"gpt-4"}),
    (r:any)=>({...r,extra:true}),
    (r:any)=>({...r,usage:{input_tokens:-1,output_tokens:1}}),
    (r:any)=>({...r,answers:{...r.answers,unexpected:{type:"noul",noul:0}}}),
    (r:any)=>({...r,answers:{r0:{type:"noul",noul:0,unexpected:true}}}),
    (r:any)=>({...r,prompt_eval_cached_count:-1}),
  ]) {
    let calls=0;
    await assert.rejects(scoreClassifier(registry,model,transcript,choices,config,new AbortController().signal,
      (async(_url,init)=>{calls++;const req=JSON.parse(String(init?.body));return Response.json(mutate({model:"nimble",answers:Object.fromEntries(Object.keys(req.questions).map(id=>[id,{type:"noul",noul:0}])),usage:{input_tokens:1,output_tokens:1}}));}) as typeof fetch),/Invalid Nimble/);
    assert.equal(calls,1);
  }
});

test("actual Pi auth destination overrides require renewed path consent before any disclosure",async t=>{
  const dir=sandbox(t),runtime=await ModelRuntime.create({authPath:join(dir,"auth.json"),modelsPath:join(dir,"models.json"),modelsStorePath:join(dir,"models-store.json")});
  const registry=new ModelRegistry(runtime),base="https://gateway.example/tenant-a/v1";
  registry.registerProvider(second.provider,{apiKey:"fixture",baseUrl:base,classifiers:{"typesafe-system-one":{classify:classifySystemOne}},
    models:[{type:"classifier",id:second.id,name:second.name,api:second.api,input:["text"],contextWindow:second.contextWindow,cost:second.cost}]});
  const catalog=registry.findOfType("classifier",second.provider,second.id)!;
  const auth=runtime.getAuth.bind(runtime);
  let effective: string | undefined="https://gateway.example/tenant-b/v1";
  (runtime as any).getAuth=async(...args:any[])=>{
    const resolved=await (auth as any)(...args);
    return resolved?{...resolved,auth:{...resolved.auth,baseUrl:effective}}:resolved;
  };
  const transcript=messages(),choices=candidates(transcript,new Set(),2000),config={...configuration({}),keepRecentTokens:2000};
  let calls=0;
  const fetcher=(async(url:unknown,init?:RequestInit)=>{
    calls++;assert.equal(String(url),effective+"/systemone");const body=JSON.parse(String(init?.body));
    return Response.json({model:second.id,answers:Object.fromEntries(Object.keys(body.questions).map(id=>[id,{type:"noul",noul:0}])),usage:{input_tokens:1,output_tokens:1}});
  }) as typeof fetch;
  await assert.rejects(scoreClassifier(registry,catalog,transcript,choices,config,new AbortController().signal,fetcher),/Effective classifier destination/);
  assert.equal(calls,0,"auth changed only the same-origin tenant path; no evidence may be sent");
  const confirmed=await selectionWithAuth(registry,catalog);
  assert.equal(confirmed.registryDestination,base);assert.equal(confirmed.destination,effective);
  const selected=resolveClassifier(registry,{version:1,automatic:true,classifier:confirmed});
  const result=await scoreClassifier(registry,selected,transcript,choices,config,new AbortController().signal,fetcher,confirmed);
  assert.equal(result.refs.length,1);assert.equal(calls,1);
  effective="https://gateway.example/tenant-c/v1";
  await assert.rejects(scoreClassifier(registry,selected,transcript,choices,config,new AbortController().signal,fetcher,confirmed),/Effective classifier destination/);
  assert.equal(calls,1,"a later auth change needs fresh confirmation too");
  effective=undefined;
  await assert.rejects(scoreClassifier(registry,selected,transcript,choices,config,new AbortController().signal,fetcher,confirmed),/Effective classifier destination/);
  assert.equal(calls,1,"removing an auth override must not retain the old endpoint");
  assert.equal(selected.baseUrl,base,"registry dispatch must preserve the raw catalog model");
});

for(const hook of [true,false]) {
  test(`catalog changes during provider dispatch block disclosure ${hook?"with":"without"} its payload hook`,async t=>{
    const dir=sandbox(t),runtime=await ModelRuntime.create({authPath:join(dir,"auth.json"),modelsPath:join(dir,"models.json"),modelsStorePath:join(dir,"models-store.json")});
    const registry=new ModelRegistry(runtime);
    const configFor=(baseUrl:string)=>({apiKey:"offline-fixture",baseUrl,
      models:[{type:"classifier" as const,id:second.id,name:second.name,api:second.api,input:["text" as const],contextWindow:second.contextWindow,cost:second.cost}],
      classifiers:{"typesafe-system-one":{classify:classifySystemOne}}});
    registry.registerProvider(second.provider,{...configFor(second.baseUrl),classifiers:{"typesafe-system-one":{async classify(model,c,options){
      registry.registerProvider(second.provider,configFor("https://classifier.example/different-tenant/v1"));
      return classifySystemOne(model,c,hook?options:{...options,onPayload:undefined});
    }}}});
    const model=registry.findOfType("classifier",second.provider,second.id)!;
    const transcript=messages(),choices=candidates(transcript,new Set(),2000);
    let calls=0;
    await assert.rejects(scoreClassifier(registry,model,transcript,choices,{...configuration({}),keepRecentTokens:2000},new AbortController().signal,
      (async()=>{calls++;throw new Error("Unexpected transport");}) as typeof fetch),/catalog destination\/API changed before dispatch/);
    assert.equal(calls,0);
  });
}

test("built-in Workers AI resolves authenticated account placeholders before confirmation and dispatch",async t=>{
  const dir=sandbox(t),authPath=join(dir,"auth.json");
  writeFileSync(authPath,JSON.stringify({"cloudflare-workers-ai":{type:"api_key",key:"offline-fixture",env:{CLOUDFLARE_ACCOUNT_ID:"account-a"}}}));
  const runtime=await ModelRuntime.create({authPath,modelsPath:join(dir,"models.json"),modelsStorePath:join(dir,"models-store.json")});
  const registry=new ModelRegistry(runtime);
  // Catalog IDs differ across Pi versions; exercise the actual built-in API on both.
  const catalog=registry.findOfType("classifier","cloudflare-workers-ai","@cf/cloudflare/clef")
    ?? registry.getModelsOfType("classifier","cloudflare-workers-ai")
      .find(model=>model.api==="cloudflare-workers-ai-system-one");
  assert.ok(catalog,"a built-in Workers AI classifier is required");
  assert.ok(catalog.baseUrl.includes("{CLOUDFLARE_ACCOUNT_ID}"));
  const confirmed=await selectionWithAuth(registry,catalog);
  assert.equal(confirmed.destination,"https://api.cloudflare.com/client/v4/accounts/account-a/ai");
  assert.ok(confirmed.registryDestination?.includes("%7BCLOUDFLARE_ACCOUNT_ID%7D"));
  const selected=resolveClassifier(registry,{version:1,automatic:true,classifier:confirmed});
  const transcript=messages(),choices=candidates(transcript,new Set(),2000),config={...configuration({}),keepRecentTokens:2000};
  let calls=0,expected=confirmed.destination;
  const fetcher=(async(url:unknown,init?:RequestInit)=>{
    calls++;assert.equal(String(url),expected+"/run");const request=JSON.parse(String(init?.body));
    const output={model:catalog.id,answers:Object.fromEntries(Object.keys(request.input.questions).map(id=>[id,{type:"noul",noul:0}])),usage:{input_tokens:1,output_tokens:1}};
    // TypeSafe models use a Completed run envelope; newer Cloudflare-hosted Clef returns output directly.
    return Response.json({success:true,result:catalog.id.startsWith("@cf/cloudflare/clef")?output:{state:"Completed",result:output}});
  }) as typeof fetch;
  const result=await scoreClassifier(registry,selected,transcript,choices,config,new AbortController().signal,fetcher,confirmed);
  assert.equal(result.refs.length,1);assert.equal(calls,1);
  const auth=runtime.getAuth.bind(runtime);
  (runtime as any).getAuth=async(...args:any[])=>{
    const resolved=await (auth as any)(...args);
    return resolved?{...resolved,env:{...resolved.env,CLOUDFLARE_ACCOUNT_ID:"account-b"}}:resolved;
  };
  await assert.rejects(scoreClassifier(registry,selected,transcript,choices,config,new AbortController().signal,fetcher,confirmed),/Effective classifier destination/);
  assert.equal(calls,1,"changed account must not receive evidence until reconfirmed");
  const updated=await selectionWithAuth(registry,catalog);expected=updated.destination;
  await scoreClassifier(registry,selected,transcript,choices,config,new AbortController().signal,fetcher,updated);
  assert.equal(calls,2);assert.ok(expected.includes("/account-b/"));
});

test("real OpenAI OAuth availability filter pauses saved Decisions selection before deterministic reductions",async t=>{
  const dir=sandbox(t),credentials=new Map<string,Credential>([["openai",{type:"api_key",key:"offline-fixture"}]]);
  const store:CredentialStore={
    async read(id){return credentials.get(id);},
    async list(){return [...credentials].map(([providerId,c])=>({providerId,type:c.type}));},
    async modify(id,fn){const next=await fn(credentials.get(id));if(next!==undefined)credentials.set(id,next);return credentials.get(id);},
    async delete(id){credentials.delete(id);},
  };
  const runtime=await ModelRuntime.create({credentials:store,authPath:join(dir,"auth.json"),modelsPath:join(dir,"models.json"),modelsStorePath:join(dir,"models-store.json"),refreshOnCreate:false});
  const registry=new ModelRegistry(runtime),model=registry.findOfType("classifier","openai","gpt-6-luna")!;
  if (piVersion === "1.0.0") {
    assert.equal(model,undefined,"Pi 1.0.0 predates the built-in Decisions backend");
    t.skip("OpenAI Decisions is not part of Pi 1.0.0; shared auth/availability regressions still run");
    return;
  }
  assert.ok(model);assert.ok((await registry.getAvailableOfType("classifier","openai")).some(m=>m.id===model.id));
  const confirmed=await selectionWithAuth(registry,model);
  let transport=0;
  const h=await harness({store:memoryStore({version:1,automatic:true,classifier:confirmed}),fetch:(async()=>{transport++;throw new Error("Unexpected classifier transport");}) as typeof fetch});
  (h.ctx as any).modelRegistry=registry;await h.fire("session_start");
  const reread=messages("reread").slice(1,3);
  (reread[0] as any).content[0].arguments.path="old.ts";
  (reread[1] as any).content=[{type:"text",text:"Complete short read"}];(reread[1] as any).details={metrics:{truncated:false}};
  for(const message of reread)h.sm.appendMessage(message);
  const transcript=buildSessionContext(h.sm.getBranch()).messages,choices=candidates(transcript,new Set(),2000);
  assert.equal(choices.length,1);assert.equal(superseded(transcript,choices).size,1);
  credentials.set("openai",{type:"oauth",access:"offline-oauth",refresh:"offline-refresh",expires:Date.now()+3600000});
  assert.equal((await registry.getProviderAuth("openai"))?.auth.apiKey,"offline-oauth");
  assert.equal((await registry.getAvailableOfType("classifier","openai")).length,0);
  await h.command("s1-compact");assert.equal(ledger(h.sm.getBranch()).size,0);assert.equal(transport,0);
  await h.command("s1-compact-status");assert.match(h.notices.at(-1)!,/Scoring: paused .*not authorized for classification/);
});

test("real SDK API/implementation mismatch cannot authorize deterministic reductions",async t=>{
  const dir=sandbox(t),runtime=await ModelRuntime.create({authPath:join(dir,"auth.json"),modelsPath:join(dir,"models.json"),modelsStorePath:join(dir,"models-store.json")});
  const registry=new ModelRegistry(runtime),provider="unmapped-classifier-api";
  registry.registerProvider(provider,{baseUrl:"https://unmapped.example/v1",apiKey:"offline-fixture",
    models:[{type:"classifier",id:"unmapped",name:"Unmapped API",api:"openai-decisions",input:["text"],contextWindow:8192,cost:second.cost}],
    classifiers:{"typesafe-system-one":{classify:classifySystemOne}}});
  const model=registry.findOfType("classifier",provider,"unmapped")!;
  assert.ok((await registry.getAvailableOfType("classifier",provider)).some(m=>m.id===model.id));
  let transport=0;const fetcher=(async()=>{transport++;throw new Error("Unexpected transport");}) as typeof fetch;
  const unavailable=await registry.classify(model,{state:{},questions:{q:{type:"bool",instructions:"test",criteria:{true:"yes",false:"no"}}}},{fetch:fetcher});
  assert.equal(unavailable.stopReason,"error");assert.match(unavailable.errorMessage!,/no classifier implementation/);assert.equal(transport,0);
  const h=await harness({store:memoryStore({version:1,automatic:true,classifier:selection(model)}),fetch:fetcher});
  (h.ctx as any).modelRegistry=registry;await h.fire("session_start");
  const reread=messages("reread").slice(1,3);(reread[0] as any).content[0].arguments.path="old.ts";
  (reread[1] as any).content=[{type:"text",text:"Complete short read"}];(reread[1] as any).details={metrics:{truncated:false}};
  for(const message of reread)h.sm.appendMessage(message);
  const transcript=buildSessionContext(h.sm.getBranch()).messages,choices=candidates(transcript,new Set(),2000);
  assert.equal(choices.length,1);assert.equal(superseded(transcript,choices).size,1);
  await h.command("s1-compact");assert.equal(ledger(h.sm.getBranch()).size,0);assert.equal(transport,0);
  await h.command("s1-compact-status");assert.match(h.notices.at(-1)!,/Scoring: paused .*API implementation unavailable/);
});

test("native provider classifier API declarations remain supported",async t=>{
  const dir=sandbox(t),runtime=await ModelRuntime.create({authPath:join(dir,"auth.json"),modelsPath:join(dir,"models.json"),modelsStorePath:join(dir,"models-store.json")});
  const registry=new ModelRegistry(runtime),model={...second,provider:"native-classifier",id:"native",baseUrl:"https://native.example/v1"};
  const native={id:model.provider,name:"Native fixture",auth:{apiKey:{name:"Offline",resolve:async()=>({auth:{apiKey:"offline-fixture"},source:"fixture"})}},
    getModels:()=>[],getAllModels:()=>[model],
    stream(){throw new Error("No chat implementation");},streamSimple(){throw new Error("No chat implementation");},classify:classifySystemOne};
  registry.registerProvider(native);
  const confirmed=await selectionWithAuth(registry,model);
  assert.equal(resolveClassifier(registry,{version:1,automatic:true,classifier:confirmed}).id,"native");
  await authenticateClassifier(registry,model,confirmed,new AbortController().signal);
  const mismatch={...model,api:"openai-decisions"};
  registry.registerProvider({...native,getAllModels:()=>[mismatch]});
  const mismatchedSelection=await selectionWithAuth(registry,mismatch);
  assert.ok((await registry.getAvailableOfType("classifier",model.provider)).some(m=>m.api==="openai-decisions"));
  await assert.rejects(authenticateClassifier(registry,mismatch,mismatchedSelection,new AbortController().signal),/API implementation unavailable/);
});

test("guarded fetch enforces API paths even without a provider payload hook",async()=>{
  let calls=0;
  const model={...second,baseUrl:"https://gateway.example/tenant-a/v1"};
  const fetcher=guardedFetch(model,(async()=>{calls++;return Response.json({});}) as typeof fetch);
  for(const path of ["/tenant-b/v1/systemone","/tenant-a/v10/systemone","/tenant-a/v1/unapproved","/tenant-a/v1/%2f../tenant-b/systemone"]) {
    await assert.rejects(fetcher(`https://gateway.example${path}`),/confirmed destination\/path/);
  }
  assert.equal(calls,0);
  await fetcher("https://gateway.example/tenant-a/v1/systemone");assert.equal(calls,1);
  for(const [api,path] of [["cloudflare-workers-ai-system-one","/tenant-a/v1/run"],["openai-decisions","/tenant-a/v1/decisions"],
    ["llama-cpp-classify","/tenant-a/tokenize"],["llama-cpp-classify","/tenant-a/apply-template"],["llama-cpp-classify","/tenant-a/completion"]]) {
    await guardedFetch({...model,api:api!},(async()=>Response.json({})) as typeof fetch)(`https://gateway.example${path}`);
  }
});

test("actual registry missing credentials fails before transport without fallback",async t=>{
  const dir=sandbox(t);
  const runtime=await ModelRuntime.create({authPath:join(dir,"auth.json"),modelsPath:join(dir,"models.json"),modelsStorePath:join(dir,"models-store.json")});
  const registry=new ModelRegistry(runtime);
  registry.registerProvider("s1-missing-auth-fixture",{baseUrl:"https://missing.example/v1",apiKey:"$S1_COMPACT_MISSING_AUTH_FIXTURE_KEY",
    models:[{type:"classifier",id:"missing",name:"Missing auth",api:"typesafe-system-one",input:["text"],contextWindow:8192,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]});
  let calls=0;
  const model=registry.findOfType("classifier","s1-missing-auth-fixture","missing")!;
  const result=await registry.classify(model,{state:{},questions:{q:{type:"bool",instructions:"test",criteria:{true:"yes",false:"no"}}}},
    {fetch:(async()=>{calls++;throw new Error("Unexpected transport");}) as typeof fetch,maxRetries:0});
  assert.equal(result.stopReason,"error");assert.equal(calls,0);
});

for (const order of ["legacy-first","successor-first"] as const) {
  test(`real Pi SDK keeps successor in standby with renamed legacy extension: ${order}`, async t => {
    const dir=sandbox(t), sm=SessionManager.inMemory(dir), calls={legacy:0,successor:0};
    for (const message of messages()) sm.appendMessage(message);
    const model: Model<"openai-responses">={id:"fixture",name:"Fixture",provider:"openai",api:"openai-responses",baseUrl:"https://example.invalid",
      reasoning:false,input:["text"],contextWindow:100000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
    const fixtureFetch=(owner:keyof typeof calls)=>(async (_url:unknown,init?:RequestInit)=>{
      calls[owner]++;const request=JSON.parse(String(init?.body));
      return Response.json({model:"nimble",answers:Object.fromEntries(Object.keys(request.questions).map(id=>[id,{type:"noul",noul:0.01}])),usage:{input_tokens:1,output_tokens:1}});
    }) as typeof fetch;
    const config={...configuration({}),keepRecentTokens:2000,maxPaybackTurns:1000};
    const legacy=(pi:any)=>registerNimble(pi,{config,fetch:fixtureFetch("legacy")});
    const successor=(pi:any)=>registerS1(pi,{config,store:memoryStore(),fetch:fixtureFetch("successor")});
    const factories=order==="legacy-first"?[legacy,successor]:[successor,legacy];
    const settings=SettingsManager.inMemory({compaction:{enabled:true},retry:{enabled:false}});
    const loader=new DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager:settings,extensionFactories:factories,
      noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true});
    await loader.reload();
    assert.equal(loader.getExtensions().extensions.length,2);
    assert.equal(loader.getExtensions().errors.length,1);
    assert.match(loader.getExtensions().errors[0]!.error,/Tool "nimble_read" conflicts/);
    const runtime=await ModelRuntime.create({authPath:join(dir,"auth.json"),modelsPath:join(dir,"models.json"),modelsStorePath:join(dir,"models-store.json")});
    const {session}=await createAgentSession({cwd:dir,agentDir:dir,model,resourceLoader:loader,modelRuntime:runtime,
      sessionManager:sm,settingsManager:settings,noTools:"builtin"});
    t.after(()=>session.dispose());await session.bindExtensions({mode:"json"});
    const runner=(session as any)._extensionRunner;
    assert.ok(runner,"SDK extension runner is bound");
    const commands=runner.getRegisteredCommands();
    assert.equal(commands.filter((c:any)=>c.name==="nimble-compact").length,2);
    const successorCommand=commands.find((c:any)=>c.name==="s1-compact");
    const context=runner.createContext();
    await successorCommand.handler("",{...context,waitForIdle:async()=>{}});
    assert.equal(calls.successor,0);
    const before=sm.getBranch().length;
    const result=await runner.emitContext([]);
    assert.equal(calls.successor,0);assert.equal(sm.getBranch().length,before);
    assert.ok(result);
    const legacyCommand=commands.find((c:any)=>c.name==="nimble-compact" && c.sourceInfo.path!==successorCommand.sourceInfo.path);
    assert.ok(legacyCommand);
    await legacyCommand.handler("",{...context,waitForIdle:async()=>{}});
    assert.equal(calls.legacy,1,"unmodified legacy pruner remains operational");
    assert.equal(calls.successor,0);
    assert.equal(ledger(sm.getBranch()).size,1);
  });
}
