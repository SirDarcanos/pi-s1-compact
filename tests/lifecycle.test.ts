import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildSessionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { applyPruning, candidates, superseded, ENTRY_TYPE, ledger, original, reference, textOf, truncationLedger, RequestBudgetError } from "../src/pruning.ts";
import { fileSettingsStore, parseSettings } from "../src/settings.ts";
import { defaultSettings, selection } from "../src/classifier.ts";
import { config, flush, harness, memoryStore, messages, second } from "./harness.ts";

const context = (h: Awaited<ReturnType<typeof harness>>) => buildSessionContext(h.sm.getBranch()).messages;

test("only S1 commands are registered; historical retrieval remains available", async () => {
  const h = await harness();
  assert.deepEqual([...h.commands.keys()].sort(), ["s1-compact", "s1-compact-reset", "s1-compact-settings", "s1-compact-status"]);
  assert.ok(h.tools.has("nimble_read"));
  await h.command("s1-compact");
  assert.equal(h.sent.length, 1, "native commands activate pruning without legacy aliases");
});

test("settings are atomic, user-global, strict, and survive reload; corrupt JSON pauses without fallback", async t => {
  const dir = await mkdtemp(join(tmpdir(), "s1-store-")); t.after(()=>rm(dir,{recursive:true}));
  const path = join(dir,"s1-compact.json"), store=fileSettingsStore(path);
  assert.equal(await store.load(),undefined);
  const saved={version:1 as const,automatic:false,classifier:selection(second)};
  await store.save(saved);
  assert.deepEqual(await fileSettingsStore(path).load(),saved);
  assert.equal((await stat(path)).mode & 0o777,0o600);
  const h=await harness({store}); await h.fire("turn_end"); await flush(); assert.equal(h.sent.length,0);
  await h.command("s1-compact-status"); assert.match(h.notices.at(-1)!,/second\/classifier-v2/);
  assert.throws(()=>parseSettings({...saved,projectOverride:true}));
  await writeFile(path,"{broken");
  await h.fire("session_start"); await h.command("s1-compact"); assert.equal(h.sent.length,0);
  assert.match(h.notices.at(-1)!,/Invalid s1-compact settings/);
  assert.equal(await readFile(path,"utf8"),"{broken");
});

test("settings picker lists destinations, confirms before saving, changes scoring independently of main model", async () => {
  const store=memoryStore(), h=await harness({store});
  h.selectAnswers.push("$first","Off"); h.confirmations.push(false);
  await h.command("s1-compact-settings"); assert.equal(store.value,undefined);
  h.selectAnswers.push("$first","On"); h.confirmations.push(true);
  await h.command("s1-compact-settings");
  assert.equal((await store.load())?.classifier.provider,"second"); assert.match(h.notices.join("\n"),/remote\/hosted: https:\/\/classifier.example\/v1/);
  await h.command("s1-compact"); assert.equal(ledger(h.sm.getBranch()).size,1);
  assert.equal((h.ctx.model as any).provider,undefined,"main model untouched");
  await h.fire("session_start"); await h.command("s1-compact-status"); assert.match(h.notices.at(-1)!,/second\/classifier-v2/);
});

test("picker confirms the effective auth endpoint and pins catalog metadata separately",async()=>{
  const store=memoryStore(),h=await harness({store,probability:1,config:{...config,truncateMinChars:0}});
  h.authDestination(second.provider,"https://classifier.example/tenant-b/v1");
  h.selectAnswers.push("$first","On");h.confirmations.push(true);
  await h.command("s1-compact-settings");
  const saved=await store.load();assert.equal(saved?.classifier.destination,"https://classifier.example/tenant-b/v1");
  assert.equal(saved?.classifier.registryDestination,"https://classifier.example/v1");
  assert.ok(h.notices.some(n=>n.includes("remote/hosted: https://classifier.example/tenant-b/v1")));
  assert.deepEqual(parseSettings(saved),saved);
  assert.throws(()=>parseSettings({...saved,classifier:{...saved!.classifier,registryDestination:4}}));
  await h.fire("session_start");await h.command("s1-compact");assert.equal(h.sent.length,1);
  h.authDestination(second.provider,"https://classifier.example/tenant-c/v1");
  await h.command("s1-compact");assert.match(h.notices.at(-1)!,/Effective classifier destination/);
  assert.equal(ledger(h.sm.getBranch()).size,0);
});

for(const stage of ["refresh","availability"] as const) {
  for(const cancel of [false,true]) {
    test(`settings ${stage} ${cancel?"cancellation":"timeout"} releases edit ownership and permits recovery`,async()=>{
      const store=memoryStore(),h=await harness({store,config:{...config,timeoutMs:cancel?1000:100}});
      const refresh=h.registry.refresh.bind(h.registry),available=h.registry.getAvailableOfType.bind(h.registry);
      let captured:AbortSignal|undefined,entered!:()=>void;
      const started=new Promise<void>(r=>entered=r);
      if(stage==="refresh")h.registry.refresh=async options=>{captured=options?.signal;entered();await new Promise<never>(()=>{});};
      else h.registry.getAvailableOfType=async(_type,_provider,options)=>{captured=options?.signal;entered();return await new Promise<never>(()=>{});};
      const keepAlive=setTimeout(()=>{},2000);
      try {
        const editing=h.command("s1-compact-settings");await started;
        if(cancel)await h.fire("session_tree");
        await editing;
      }finally{clearTimeout(keepAlive);}
      assert.equal(captured?.aborted,true);assert.equal(await store.load(),undefined);
      if(!cancel)assert.match(h.notices.at(-1)!,/timeout/);
      h.registry.refresh=refresh;h.registry.getAvailableOfType=available;
      h.selectAnswers.push("$last","Off");h.confirmations.push(true);
      await h.command("s1-compact-settings");
      assert.equal((await store.load())?.classifier.provider,"s1-compact-ollama");assert.equal((await store.load())?.automatic,false);
    });
  }
}

test("one unavailable classifier destination does not block selecting another registry classifier",async()=>{
  const store=memoryStore(),h=await harness({store});
  h.modelList.unshift({...second,id:"broken-destination",baseUrl:"ftp://unsafe.example/v1"});
  h.selectAnswers.push("$first");await h.command("s1-compact-settings");
  assert.equal(await store.load(),undefined);assert.match(h.notices.at(-1)!,/Selected classifier destination unavailable/);
  h.selectAnswers.push("$last","Off");h.confirmations.push(true);
  await h.command("s1-compact-settings");assert.equal((await store.load())?.classifier.provider,"s1-compact-ollama");
});

test("status reports retrieval, native checkpoints, missing main model and in-flight scoring truthfully",async()=>{
  const h=await harness();h.active([]);
  await h.command("s1-compact-status");assert.match(h.notices.at(-1)!,/Scoring: paused · nimble_read inactive/);
  h.active(["nimble_read"]);(h.ctx as any).model=undefined;
  await h.command("s1-compact-status");assert.match(h.notices.at(-1)!,/Scoring: paused · No model selected/);
  (h.ctx as any).model={contextWindow:100000};
  h.sm.appendCustomEntry("openai-codex-native-compaction",{});
  await h.command("s1-compact-status");assert.match(h.notices.at(-1)!,/Scoring: paused · Codex checkpoint/);
  let release!:()=>void;const gate=new Promise<void>(r=>release=r);
  const pending=await harness({classify:async(model,c)=>{await gate;return {provider:model.provider,model:model.id,api:model.api,stopReason:"stop",timestamp:0,answers:Object.fromEntries(Object.keys(c.questions).map(id=>[id,{type:"bool",probability:1}]))};}});
  await pending.fire("turn_end");await pending.command("s1-compact-status");assert.match(pending.notices.at(-1)!,/Scoring: checking…/);
  await pending.fire("session_tree");release();await flush();
  await pending.command("s1-compact-status");assert.match(pending.notices.at(-1)!,/Scoring: ready/);
});

test("failed settings writes preserve prior selection; automatic off still allows manual pruning", async () => {
  const store=memoryStore(defaultSettings(config)); store.failure=true;
  const h=await harness({store}); h.selectAnswers.push("$first","Off");h.confirmations.push(true);
  await h.command("s1-compact-settings"); assert.equal(store.value?.classifier.provider,"s1-compact-ollama");
  assert.match(h.notices.at(-1)!,/Storage failure/);
  store.failure=false;h.selectAnswers.push("$last","Off");h.confirmations.push(true);
  await h.command("s1-compact-settings");await h.fire("turn_end");await flush();assert.equal(h.sent.length,0);
  await h.command("s1-compact");assert.equal(ledger(h.sm.getBranch()).size,1);
});

test("selected missing model/credentials pause scoring, never fallback or retry; historical masks still retrieve", async () => {
  const store=memoryStore({version:1,automatic:true,classifier:selection(second)}), h=await harness({store});
  h.unavailable();await h.command("s1-compact");assert.equal(h.sent.length,0);assert.equal(ledger(h.sm.getBranch()).size,0);
  await h.fire("turn_end");await flush();assert.equal(h.sent.length,0);
  await h.command("s1-compact-status");assert.match(h.notices.at(-1)!,/Selected classifier credentials unavailable/);
  h.modelList.splice(0,h.modelList.length);await h.command("s1-compact");assert.equal(h.sent.length,0);assert.match(h.notices.at(-1)!,/Selected classifier unavailable/);
});

test("missing credentials also pause deterministic-only supersession without writing masks",async()=>{
  const h=await harness({store:memoryStore({version:1,automatic:true,classifier:selection(second)})});
  const reread=messages("reread").slice(1,3);
  (reread[0] as any).content[0].arguments.path="old.ts";
  (reread[1] as any).content=[{type:"text",text:"Current complete short read"}];
  (reread[1] as any).details={metrics:{truncated:false}};
  for(const message of reread)h.sm.appendMessage(message);
  const choices=candidates(context(h),new Set(),config.keepRecentTokens);
  assert.equal(choices.length,1);assert.equal(superseded(context(h),choices).size,1);
  h.unavailable();await h.fire("turn_end");await flush();
  assert.equal(ledger(h.sm.getBranch()).size,0);assert.equal(h.sent.length,0);
  await h.command("s1-compact-status");assert.match(h.notices.at(-1)!,/Scoring: paused · Selected classifier credentials unavailable/);
  await h.command("s1-compact");assert.equal(ledger(h.sm.getBranch()).size,0);assert.equal(h.sent.length,0);
});

test("availability loss during classifier work cannot commit new reductions",async()=>{
  let release!:()=>void;const gate=new Promise<void>(r=>release=r);
  const h=await harness({classify:async(model,c)=>{await gate;return {provider:model.provider,model:model.id,api:model.api,stopReason:"stop",timestamp:0,answers:Object.fromEntries(Object.keys(c.questions).map(id=>[id,{type:"bool",probability:0}]))};}});
  await h.fire("turn_end");await flush();assert.equal(h.sent.length,1);
  h.unavailable();release();await flush();
  assert.equal(ledger(h.sm.getBranch()).size,0);await h.command("s1-compact-status");assert.match(h.notices.at(-1)!,/not authorized for classification/);
});

test("authentication preflight is cancellable and stale auth completion cannot start scoring",async()=>{
  const h=await harness();let release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
  const auth=h.registry.getProviderAuth.bind(h.registry);
  h.registry.getProviderAuth=async provider=>{entered();await gate;return auth(provider);};
  await h.fire("turn_end");await started;assert.equal(h.sent.length,0);
  await h.fire("session_tree");release();await flush();
  assert.equal(h.sent.length,0);assert.equal(ledger(h.sm.getBranch()).size,0);
});

test("authentication preflight has a deadline and unsupported providers cannot prune",async()=>{
  const h=await harness({config:{...config,timeoutMs:100}});
  h.registry.getProviderAuth=()=>new Promise(()=>{});
  const keepAlive=setTimeout(()=>{},1000);
  try {await h.command("s1-compact");}finally{clearTimeout(keepAlive);}
  assert.equal(h.sent.length,0);assert.equal(ledger(h.sm.getBranch()).size,0);assert.match(h.notices.at(-1)!,/timeout/);
  const unsupported=await harness();unsupported.registry.getProvider=()=>undefined;
  await unsupported.command("s1-compact");assert.equal(unsupported.sent.length,0);assert.match(unsupported.notices.at(-1)!,/classification is not supported/);
});

test("status reports submitted classifier coverage rather than budget-omitted candidates",async()=>{
  const h=await harness({probability:1,config:{...config,truncateMinChars:0},store:memoryStore({version:1,automatic:true,classifier:selection(second)})});
  for(let i=0;i<6;i++)for(const message of messages(`extra-${i}`))h.sm.appendMessage(message);
  const total=candidates(context(h),new Set(),config.keepRecentTokens).length;
  await h.command("s1-compact");const evaluated=Object.keys(h.sent[0]!.questions).length;
  assert.ok(evaluated>0&&evaluated<=4&&evaluated<total);
  assert.ok(h.notices.at(-1)!.includes(`${evaluated} outputs classified; 0 deterministic supersessions considered`));
  assert.ok(!h.notices.at(-1)!.includes(`${total} outputs classified`));
});

test("destination changes under same registry identity require confirmation before any new scoring", async () => {
  const h=await harness({store:memoryStore({version:1,automatic:true,classifier:selection(second)})});
  h.modelList[0]!.baseUrl="https://different.example/v1";
  await h.command("s1-compact");assert.equal(h.sent.length,0);assert.match(h.notices.at(-1)!,/destination\/API changed/);
});

test("classifier changes invalidate in-flight scoring even when transport ignores abort; preserve existing masks", async () => {
  let release!:()=>void, signal:AbortSignal|undefined;
  const gate=new Promise<void>(r=>release=r);
  const h=await harness({classify:async(model,context,opts)=>{signal=opts?.signal;await gate;return {provider:model.provider,model:model.id,api:model.api,answers:Object.fromEntries(Object.keys(context.questions).map(id=>[id,{type:"bool",probability:0}])),stopReason:"stop",timestamp:0};}});
  await h.fire("turn_end");assert.equal(h.sent.length,1);
  h.selectAnswers.push("$first","On");h.confirmations.push(true);await h.command("s1-compact-settings");
  assert.equal(signal?.aborted,true);release();await flush();assert.equal(ledger(h.sm.getBranch()).size,0);
  assert.equal((h.store as any).value.classifier.provider,"second");
});

test("coding-model change during settings save still installs the confirmed classifier and automatic toggle", async()=>{
  const store=memoryStore(defaultSettings(config));
  let release!:()=>void, entered!:()=>void;
  const started=new Promise<void>(r=>entered=r), gate=new Promise<void>(r=>release=r);
  const save=store.save.bind(store);
  store.save=async next=>{entered();await gate;await save(next);};
  const h=await harness({store});
  await h.command("s1-compact");const refs=[...ledger(h.sm.getBranch())];
  h.selectAnswers.push("$first","Off");h.confirmations.push(true);
  const command=h.command("s1-compact-settings");await started;await h.fire("model_select");release();await command;
  assert.equal(store.value?.classifier.provider,"second");assert.equal(store.value?.automatic,false);
  await h.command("s1-compact-status");assert.match(h.notices.at(-1)!,/second\/classifier-v2/);assert.match(h.notices.at(-1)!,/Automatic pruning: off/);
  const calls=h.sent.length;await h.fire("turn_end");await flush();assert.equal(h.sent.length,calls);
  assert.deepEqual([...ledger(h.sm.getBranch())],refs);assert.ok(original(h.sm.getBranch(),refs[0]!));
});

for (const transition of ["session_start", "shutdown-reload"] as const) {
  for (const fail of [false,true]) {
    test(`pending settings ${fail ? "failure" : "save"} settles before ${transition} can load or edit`,async()=>{
      const store=memoryStore(defaultSettings(config));store.failure=fail;
      let release!:()=>void, entered!:()=>void;
      const started=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
      let saves=0;const save=store.save.bind(store);
      store.save=async next=>{saves++;entered();await gate;await save(next);};
      const h=await harness({store});
      h.selectAnswers.push("$first","Off");h.confirmations.push(true);
      const editing=h.command("s1-compact-settings");await started;
      let settled=false;
      const replacing=h.fire(transition==="session_start"?"session_start":"session_shutdown").then(()=>{settled=true;});
      await flush();assert.equal(settled,false,"lifecycle must wait for persistence");
      await h.command("s1-compact-settings");assert.match(h.notices.at(-1)!,/already being edited/);assert.equal(saves,1);
      release();await Promise.all([editing,replacing]);
      if(transition==="shutdown-reload")await h.fire("session_start");
      await h.command("s1-compact-status");
      const expected=fail?"s1-compact-ollama/nimble":"second/classifier-v2";
      assert.ok(h.notices.at(-1)!.includes(expected));
      assert.equal(store.value?.classifier.provider,fail?"s1-compact-ollama":"second");
      assert.equal(store.value?.automatic,fail);
      assert.match(h.notices.at(-1)!,fail?/Automatic pruning: on/:/Automatic pruning: off/);
      if(!fail){const before=h.sent.length;await h.fire("turn_end");await flush();assert.equal(h.sent.length,before);}
    });
  }
}

test("legacy session replay, exact paged retrieval, branch reset and disabled retrieval preserve originals", async () => {
  const h=await harness(); const result=context(h).find(m=>m.role==="toolResult")! as any;
  const ref=reference(result), bytes=textOf(result);
  h.sm.appendCustomEntry(ENTRY_TYPE,{version:1,refs:[ref]});
  let projected=await h.fire("context",{messages:context(h)});assert.match(JSON.stringify(projected.messages),/nimble_read/);
  const got=await h.tools.get("nimble_read")!.execute("read",{ref,offset:12,limit:40},undefined as any,undefined as any,h.ctx as any);
  assert.ok((got.content[0] as any).text.endsWith(bytes.slice(12,52)));
  assert.equal(original(h.sm.getBranch(),ref)?.content[0]!.type,"text");
  h.active([]);projected=await h.fire("context",{messages:context(h)});assert.equal(projected,undefined);
  h.active(["nimble_read"]);await h.command("s1-compact-reset");assert.equal(ledger(h.sm.getBranch()).size,0);
  assert.equal(textOf(original(h.sm.getBranch(),ref)!),bytes);
});

test("unscored candidates are never truncated; retained candidates shorten and reset releases both tiers", async () => {
  const h=await harness({probability:0.99});await h.command("s1-compact");
  assert.equal(truncationLedger(h.sm.getBranch()).size,1);assert.equal(ledger(h.sm.getBranch()).size,0);
  assert.match(JSON.stringify(applyPruning(context(h),ledger(h.sm.getBranch()),truncationLedger(h.sm.getBranch()))),/truncated/);
  await h.command("s1-compact-reset");assert.equal(truncationLedger(h.sm.getBranch()).size,0);
});

for(const boundary of ["session_tree","session_before_compact","session_compact","model_select","session_shutdown"]){
  test(`late scoring cannot commit across ${boundary}`,async()=>{
    let release!:()=>void;const gate=new Promise<void>(r=>release=r);
    const h=await harness({classify:async(model,c)=>{await gate;return {provider:model.provider,model:model.id,api:model.api,stopReason:"stop",timestamp:0,answers:Object.fromEntries(Object.keys(c.questions).map(id=>[id,{type:"bool",probability:0}]))};}});
    await h.fire("turn_end");await h.fire(boundary);release();await flush();assert.equal(ledger(h.sm.getBranch()).size,0);
  });
}

test("new user message invalidates late result; async context hook does not wait",async()=>{
  let release!:()=>void;const gate=new Promise<void>(r=>release=r);
  const h=await harness({classify:async(model,c)=>{await gate;return {provider:model.provider,model:model.id,api:model.api,stopReason:"stop",timestamp:0,answers:Object.fromEntries(Object.keys(c.questions).map(id=>[id,{type:"bool",probability:0}]))};}});
  await h.fire("context",{messages:context(h)});assert.equal(h.sent.length,1);
  h.sm.appendMessage({role:"user",content:"New task",timestamp:9});release();await flush();assert.equal(ledger(h.sm.getBranch()).size,0);
});

test("foreign legacy registrations pause projection, manual/automatic scoring and reset, including in-flight work",async()=>{
  const h=await harness();h.foreign();
  await h.command("s1-compact");await h.fire("turn_end");assert.equal(h.sent.length,0);
  const result=context(h).find(m=>m.role==="toolResult")! as any;h.sm.appendCustomEntry(ENTRY_TYPE,{version:1,refs:[reference(result)]});
  assert.equal(await h.fire("context",{messages:context(h)}),undefined);
  await h.command("s1-compact-reset");assert.equal(ledger(h.sm.getBranch()).size,1);assert.match(h.notices.at(-1)!,/Legacy pruner active/);
});

test("failed persistence rolls back in-memory leaf and cannot activate reductions",async()=>{
  const h=await harness();const leaf=h.sm.getLeafId();
  (h.pi as any).appendEntry=(type:string,data:unknown)=>{h.sm.appendCustomEntry(type,data);throw new Error("Disk full");};
  await h.command("s1-compact");assert.equal(h.sm.getLeafId(),leaf);assert.equal(ledger(h.sm.getBranch()).size,0);
  assert.match(h.notices.at(-1)!,/Disk full/);
});

test("Codex native compaction owns provider context without disabling historical retrieval",async()=>{
  const h=await harness();h.sm.appendCustomEntry("openai-codex-native-compaction",{});
  await h.command("s1-compact");assert.equal(h.sent.length,0);assert.equal(await h.fire("context",{messages:context(h)}),undefined);
  assert.ok(h.tools.has("nimble_read"));
});

test("persisted legacy-compatible reductions survive reopen and reset remains branch-local",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"s1-replay-"));t.after(()=>rm(dir,{recursive:true}));
  const sm=SessionManager.create(dir,dir),h=await harness({manager:sm,probability:0.99});
  await h.command("s1-compact");
  const reopened=SessionManager.open(sm.getSessionFile()!);
  assert.equal(truncationLedger(reopened.getBranch()).size,1);
  const ref=[...truncationLedger(reopened.getBranch())][0]!,saved=textOf(original(reopened.getBranch(),ref)!);
  const leaf=reopened.getLeafId()!;
  reopened.appendCustomEntry(ENTRY_TYPE,{version:1,refs:[],reset:true});
  assert.equal(truncationLedger(reopened.getBranch()).size,0);
  reopened.branch(leaf);assert.equal(truncationLedger(reopened.getBranch()).size,1);
  assert.equal(textOf(original(reopened.getBranch(),ref)!),saved);
});

test("failed reset persistence preserves both masks and branch leaf",async()=>{
  const h=await harness({probability:0.99});await h.command("s1-compact");const leaf=h.sm.getLeafId();
  (h.pi as any).appendEntry=(type:string,data:unknown)=>{h.sm.appendCustomEntry(type,data);throw new Error("Disk full");};
  await h.command("s1-compact-reset");assert.equal(h.sm.getLeafId(),leaf);assert.equal(truncationLedger(h.sm.getBranch()).size,1);
});

test("registry scoring fits long Unicode history without increasing its history budget", async () => {
  const h = await harness({ probability: 1, store: memoryStore({ version: 1, automatic: true, classifier: selection(second) }) });
  for (let i = 0; i < 3; i++) h.sm.appendMessage({ role: "user", content: "漢字".repeat(5000), timestamp: 10 + i });
  await h.command("s1-compact");
  assert.equal(h.sent.length, 1);
  assert.ok(!h.notices.some(notice => /Scoring paused|history too large/.test(notice)));
  assert.equal(ledger(h.sm.getBranch()).size, 0, "retained evidence is not cleared");
});

test("budget skips retain outputs without pausing future scoring", async () => {
  const h = await harness({ classify: async () => { throw new RequestBudgetError("Classifier evaluation skipped: fixed context budget"); } });
  await h.command("s1-compact");
  assert.equal(ledger(h.sm.getBranch()).size, 0);
  assert.equal(truncationLedger(h.sm.getBranch()).size, 0);
  await h.command("s1-compact-status");
  assert.match(h.notices.at(-1)!, /Scoring: ready/);
  assert.match(h.notices.at(-1)!, /Classifier evaluation skipped/);
  assert.ok(!h.notices.some(notice => /Scoring paused/.test(notice)));
  const attempts = h.sent.length;
  await h.fire("turn_end"); await flush();
  assert.equal(h.sent.length, attempts, "unchanged history does not spin on a size skip");
  h.sm.appendMessage({ role: "user", content: "additional context ".repeat(10000), timestamp: 10 });
  await h.fire("turn_end"); await flush();
  assert.equal(h.sent.length, attempts + 1, "growth can trigger another evaluation after a size skip");
});

test("local versus registry thresholds and budgets are not transferred between classifiers",async()=>{
  const local=await harness({probability:0.1,config:{...config,truncateMinChars:0}});await local.command("s1-compact");
  assert.equal(ledger(local.sm.getBranch()).size,1);
  const remote=await harness({probability:0.1,config:{...config,truncateMinChars:0},store:memoryStore({version:1,automatic:true,classifier:selection(second)})});
  await remote.command("s1-compact");assert.equal(ledger(remote.sm.getBranch()).size,0);assert.equal(truncationLedger(remote.sm.getBranch()).size,0);
  assert.ok(Object.keys(remote.sent[0]!.questions).length<=4);
});
