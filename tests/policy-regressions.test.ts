import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { JsonObject } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionAPI, type ExtensionContext, type ExtensionToolContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  applyPruning, candidates, configuration, ENTRY_TYPE, ledger, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES,
  affordable, affordableReductions, original, reference, requestBody, score, superseded, textOf,
  truncationLedger, type Config, type ToolResult,
} from "../src/pruning.ts";

// The payback gate has its own tests; elsewhere it would only obscure which outputs a rule selects.
const config: Config = { ...configuration({}), endpoint: "http://127.0.0.1:8000/v1/systemone", apiKey: "test-key", keepRecentTokens: 2_000, maxPaybackTurns: 1_000 };
type StoredMessage = Parameters<SessionManager["appendMessage"]>[0];
function pair(id: string, name = "read", input: Record<string, unknown> = { path: `${id}.ts` }): StoredMessage[] {
  return [{
    role: "assistant", content: [
      { type: "thinking", thinking: "PRIVATE_REASONING", thinkingSignature: "PRIVATE_SIGNATURE" },
      { type: "text", text: `Inspect ${id}`, textSignature: "KEEP_SIGNATURE" },
      { type: "toolCall", id, name, arguments: input as JsonObject },
    ], api: "openai-responses", provider: "openai", model: "test", stopReason: "toolUse", timestamp: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  }, { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: `BEGIN_${id}\n${"old code\n".repeat(600)}END_${id}` }],
    details: { private: "PRIVATE_DETAILS" }, isError: false, timestamp: 2 }];
}
function transcript(): StoredMessage[] {
  return [{ role: "user", content: "Fix the parser. Keep the public API unchanged.", timestamp: 0 },
    ...pair("old"), ...pair("also-old"),
    { role: "custom", customType: "checkpoint", content: "PRIVATE_CHECKPOINT", display: false, timestamp: 3 },
    { role: "user", content: "Current task: finish the parser. " + "recent work ".repeat(1_000), timestamp: 4 }];
}
function response(body: Record<string, any>, probability = 0.1): Record<string, unknown> {
  return {
    model: "nimble-1.13.0",
    answers: Object.fromEntries(Object.keys(body.questions).map(key => [key, { type: "noul", noul: probability }])),
    usage: { input_tokens: 100, output_tokens: 10 },
  };
}
function fakeFetch(probability = 0.1, inspect?: (body: Record<string, any>, init: RequestInit) => void): typeof fetch {
  return (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    inspect?.(body, init!);
    return Response.json(response(body, probability));
  }) as typeof fetch;
}

test("mixed payback preserves clearing, shortening and incremental upgrade semantics", () => {
  const messages = transcript();
  const choices = candidates(messages, new Set(), 2_000);
  const refs = new Set<string>();
  const clearOnly = affordableReductions(messages, refs, refs, choices, [], 1_000);
  assert.deepEqual(clearOnly.cleared, affordable(messages, refs, choices, 1_000));
  const mixed = affordableReductions(messages, refs, refs, [choices[0]!], [choices[1]!], 1_000);
  assert.equal(mixed.cleared.length, 1);
  assert.equal(mixed.truncated.length, 1);
  const oldShort = new Set([choices[0]!.ref]);
  const upgraded = affordableReductions(messages, refs, oldShort, [choices[0]!], [], 1_000);
  assert.equal(upgraded.cleared.length, 1);
  const projected = applyPruning(messages, new Set([choices[0]!.ref]), oldShort);
  const upgradedResult = projected.find(m => m.role === "toolResult" && m.toolCallId === choices[0]!.result.toolCallId) as ToolResult;
  assert.match(textOf(upgradedResult), /cleared/);
  assert.doesNotMatch(textOf(upgradedResult), /BEGIN_/);
});


test("candidate selection protects recent batches, errors, skills, images, tool loading, coordination and ambiguous pairs", () => {
  const messages = transcript();
  assert.equal(candidates(messages, new Set(), 2_000).length, 2);
  const error = pair("error"); (error[1] as ToolResult).isError = true;
  const image = pair("image"); (image[1] as ToolResult).content.push({ type: "image", data: "PRIVATE_IMAGE", mimeType: "image/png" });
  const loaded = pair("loaded"); Object.assign(loaded[1]!, { addedToolNames: ["new_tool"] });
  const reversed = pair("reversed");
  const mismatch = pair("mismatch"); (mismatch[1] as ToolResult).toolName = "bash";
  const separated = pair("separated");
  const malformedDuplicates = [null, [], "bad"].flatMap((arguments_, index) => {
    const messages = pair(`malformed-${index}`);
    (messages[0] as Extract<AgentMessage, { role: "assistant" }>).content.push({
      type: "toolCall", id: `malformed-${index}`, name: "read", arguments: arguments_ as any,
    });
    return messages;
  });
  const secretOutput = pair("secret-output");
  (secretOutput[1] as ToolResult).content = [{ type: "text", text: `apiKey=sk-${"x".repeat(32)}\n${"data\n".repeat(600)}` }];
  const partialKey = pair("partial-key", "read", { path: "dump.txt" });
  (partialKey[1] as ToolResult).content = [{ type: "text", text: `-----BEGIN PRIVATE KEY-----\n${"A".repeat(2_500)}` }];
  const skipped = [...error, ...image, ...loaded, ...pair("skill", "read", { path: "/skills/test/SKILL.md" }),
    ...pair("environment", "read", { path: "/repo/.env.production" }),
    ...pair("at-environment", "read", { path: "@.env" }),
    ...pair("pem", "read", { path: "tls/server.pem", limit: 40 }),
    ...pair("api-field", "read", { apiKey: "opaquecredential123456" }),
    ...pair("nested-field", "read", { credentials: { password: "correct horse battery staple" } }),
    ...pair("env-field", "read", { env: { NIMBLE_API_KEY: "opaquecredential123456" } }),
    ...pair("credential", "bash", { command: "cat ~/.aws/credentials" }), ...secretOutput, ...partialKey,
    ...pair("job", "bg_agent"), ...pair("retrieval", "nimble_read"), ...pair("orphan").slice(1),
    reversed[1]!, reversed[0]!, mismatch[0]!, mismatch[1]!, separated[0]!,
    { role: "user" as const, content: "unrelated turn", timestamp: 2 }, separated[1]!,
    ...pair("duplicate"), ...pair("duplicate"), ...malformedDuplicates, messages.at(-1)!];
  assert.deepEqual(candidates(skipped, new Set(), 2_000), []);
  const batch = pair("one");
  (batch[0] as Extract<AgentMessage, { role: "assistant" }>).content.push({ type: "toolCall", id: "two", name: "read", arguments: {} });
  const last = pair("two")[1] as ToolResult; last.content = [{ type: "text", text: "x".repeat(20_000) }];
  assert.deepEqual(candidates([...batch, last], new Set(), 2_000), [], "protect the whole latest parallel batch");
});


test("only complete same-file rereads and identical successful test reruns supersede old output", () => {
  const oldRead = pair("read-old", "read", { path: "src/parser.ts" });
  const newRead = pair("read-new", "read", { path: "src/parser.ts" });
  (newRead[1] as ToolResult).details = { snapshotId: "new", metrics: { truncated: false } };
  const oldTest = pair("test-old", "bg_run", { command: "npm test", cwd: "/repo" });
  const newTest = pair("test-new", "bg_run", { command: "npm test", cwd: "/repo" });
  for (const item of [oldTest[1], newTest[1]] as ToolResult[]) item.details = { status: "exited", exitCode: 0, promoted: false };
  const tail: StoredMessage = { role: "user", content: "current ".repeat(1_500), timestamp: 3 };
  const messages = [...oldRead, ...oldTest, ...newRead, ...newTest, tail];
  const selected = candidates(messages, new Set(), 2_000);
  assert.deepEqual(superseded(messages, selected), new Set([reference(oldRead[1] as ToolResult), reference(oldTest[1] as ToolResult)]));
  assert.deepEqual(superseded(messages, selected, new Set([reference(newRead[1] as ToolResult), reference(newTest[1] as ToolResult)])), new Set());
  (newRead[1] as ToolResult).details = { metrics: { truncated: true } };
  (newTest[1] as ToolResult).details = { status: "running", promoted: true };
  assert.deepEqual(superseded(messages, candidates(messages, new Set(), 2_000)), new Set());
  (newRead[1] as ToolResult).details = { metrics: { truncated: false } };
  (newTest[1] as ToolResult).details = { status: "exited", exitCode: 0, promoted: false };
  (newRead[0] as Extract<AgentMessage, { role: "assistant" }>).content[2] = { type: "toolCall", id: "read-new", name: "read", arguments: { path: "src/parser.ts", limit: 30 } };
  (newTest[0] as Extract<AgentMessage, { role: "assistant" }>).content[2] = { type: "toolCall", id: "test-new", name: "bg_run", arguments: { command: "npm test", cwd: "/other" } };
  assert.deepEqual(superseded(messages, candidates(messages, new Set(), 2_000)), new Set());
  assert.deepEqual(candidates([...pair("unsafe", "bg_run", { command: "npm test" }), tail], new Set(), 2_000), []);
  assert.deepEqual(candidates([...pair("arbitrary", "bg_run", { command: "npm test && curl example.com" }), tail], new Set(), 2_000), []);
});


test("advisor state clears only after a later output restates it; launches and coordination never clear", () => {
  const tail: StoredMessage = { role: "user", content: "current ".repeat(1_500), timestamp: 3 };
  const ref = (messages: StoredMessage[]) => reference(messages[1] as ToolResult);
  const checkpointRead = pair("checkpoint-read", "advisor_checkpoint", {});
  const checkpointWrite = pair("checkpoint-write", "advisor_checkpoint", { content: "next state", expectedDigest: "d" });
  const skill = pair("skill", "read_skill", { path: "/agent/skills/role/SKILL.md" });
  const skillAgain = pair("skill-again", "read_skill", { path: "/agent/skills/role/SKILL.md" });
  const otherSkill = pair("other-skill", "read_skill", { path: "/agent/skills/other/SKILL.md" });
  const plan = pair("plan", "advisor_graph_plan", { graphId: "g" });
  const replan = pair("replan", "advisor_graph_plan", { graphId: "g" });
  const tailRead = pair("tail-read", "bg_output", { runId: "run-1" });
  const tailAgain = pair("tail-again", "bg_output", { runId: "run-1", lines: 40 });
  const transcriptRead = pair("transcript-read", "bg_output", { runId: "run-1", source: "transcript" });
  const memory = pair("memory", "mem_search", { query: "parser" });
  const coordination = ["bg_agent", "bg_stop", "bg_await", "advisor_session_init", "advisor_graph_evidence", "mem_save",
    "team_status", "agent_message", "intercom", "goal_wait"].flatMap(name => pair(`protected-${name}`, name, { note: name }));
  const messages = [...checkpointRead, ...skill, ...otherSkill, ...plan, ...tailRead, ...transcriptRead, ...memory,
    ...coordination, ...checkpointWrite, ...skillAgain, ...replan, ...tailAgain, tail];
  const selected = candidates(messages, new Set(), 2_000);
  const automatic = [checkpointRead, skill, plan, tailRead].map(ref);
  assert.deepEqual(new Set(selected.map(item => item.ref)),
    new Set([...automatic, ...[tailAgain, transcriptRead, memory].map(ref)]), "latest state stays unless Nimble judges it");
  assert.deepEqual(superseded(messages, selected), new Set(automatic));
});


test("completed foreground bg_run output is ordinary evidence; promoted receipts are not", () => {
  const tail: StoredMessage = { role: "user", content: "current ".repeat(1_500), timestamp: 3 };
  const finished = pair("finished", "bg_run", { command: "git log -p" });
  (finished[1] as ToolResult).details = { status: "exited", exitCode: 1, promoted: false };
  const promoted = pair("promoted", "bg_run", { command: "npm run dev" });
  (promoted[1] as ToolResult).details = { status: "running", promoted: true };
  assert.deepEqual(candidates([...finished, ...promoted, tail], new Set(), 2_000).map(item => item.ref),
    [reference(finished[1] as ToolResult)]);
});


test("clearing waits for a batch whose savings repay the cache rewrite", () => {
  const tail: StoredMessage = { role: "user", content: "current ".repeat(1_500), timestamp: 3 };
  const small = pair("small", "bash", { command: "ls -R" });
  const middle: StoredMessage = { role: "user", content: "context ".repeat(25_000), timestamp: 2 };
  const large = pair("large", "bash", { command: "git log -p" });
  (large[1] as ToolResult).content = [{ type: "text", text: "diff\n".repeat(20_000) }];
  const messages = [...small, middle, ...large, tail];
  const all = candidates(messages, new Set(), 2_000);
  assert.equal(all.length, 2);
  assert.deepEqual(affordable(messages, new Set(), all, 20).map(item => item.ref), [reference(large[1] as ToolResult)],
    "a small old output would invalidate ~50k cached tokens to save ~1k");
  assert.deepEqual(affordable([...small, middle, tail], new Set(), all, 20), []);
  assert.equal(affordable(messages, new Set(), all, 1_000).length, 2);
});


test("proven supersession wins the 16-candidate budget over larger unrelated outputs", () => {
  const old = pair("earlier", "read", { path: "src/a.ts" });
  const newer = pair("later", "read", { path: "src/a.ts" });
  (newer[1] as ToolResult).details = { metrics: { truncated: false } };
  const noise = Array.from({ length: 16 }, (_, i) => {
    const messages = pair(`noise-${i}`, "bash", { command: `git show ${i}` });
    (messages[1] as ToolResult).content = [{ type: "text", text: "diff\n".repeat(6_000) }];
    return messages;
  }).flat();
  const messages = [...old, ...noise, ...newer, { role: "user" as const, content: "current ".repeat(1_500), timestamp: 3 }];
  assert.ok(candidates(messages, new Set(), 2_000).some(item => item.ref === reference(old[1] as ToolResult)));
});


test("projection keeps message order, calls, signatures, metadata and originals; stable replay is idempotent", () => {
  const messages = transcript();
  const before = structuredClone(messages);
  const candidate = candidates(messages, new Set(), 2_000)[0]!;
  const projected = applyPruning(messages, new Set([candidate.ref]));
  assert.deepEqual(messages, before);
  assert.equal(projected.length, messages.length);
  for (let i = 0; i < messages.length; i++) {
    if (messages[i] !== candidate.result) assert.equal(projected[i], messages[i]);
    else {
      assert.deepEqual({ ...projected[i], content: [] }, { ...messages[i], content: [] });
      assert.match(textOf(projected[i] as ToolResult), /nimble_read/);
      assert.match(textOf(projected[i] as ToolResult), /Do not rerun/);
    }
  }
  assert.deepEqual(applyPruning(projected, new Set([candidate.ref])), projected);
});


test("Nimble requests contain bounded excerpts, not private reasoning, images, metadata or custom messages", () => {
  const messages = transcript();
  const choices = candidates(messages, new Set(), 2_000);
  const request = requestBody(messages, choices, config.model);
  assert.ok(Buffer.byteLength(request.body) <= MAX_REQUEST_BYTES);
  assert.match(request.body, /BEGIN_old/);
  assert.match(request.body, /END_old/);
  assert.doesNotMatch(request.body, /PRIVATE_|KEEP_SIGNATURE/);
  const secret = `sk-${"a".repeat(32)}`;
  const prefixed = "credential-value-without-a-known-token-prefix";
  const phrase = "correct horse battery staple";
  const apiField = "opaque-api-field-credential";
  const nestedField = "opaque-nested-field-credential";
  const envField = "opaque-env-field-credential";
  const partialKey = `-----BEGIN PRIVATE KEY-----\n${"A".repeat(200)}`;
  const redacted = requestBody([
    ...messages, { role: "user", content: `Authorization: Bearer ${secret}\nNIMBLE_API_KEY="${prefixed}"\nAWS_SECRET_ACCESS_KEY=${prefixed}`, timestamp: 5 },
  ], [{ ...choices[0]!, input: {
    note: `PASSWORD="${phrase}"`, apiKey: apiField,
    credentials: { password: nestedField }, env: { NIMBLE_API_KEY: envField },
  }, result: {
    ...choices[0]!.result, content: [{ type: "text" as const, text: `password=${secret}\n${partialKey}` }],
  } }], config.model).body;
  for (const value of [secret, prefixed, phrase, apiField, nestedField, envField, partialKey]) {
    assert.doesNotMatch(redacted, new RegExp(value));
  }
  assert.match(redacted, /redacted/);
  const unicode = choices.map((item, i) => ({ ...item, ref: String(i), input: { path: "漢字".repeat(4_000) }, result: { ...item.result, content: [{ type: "text" as const, text: "漢字".repeat(5_000) }] } }));
  const many = Array.from({ length: 16 }, (_, i) => unicode[i % unicode.length]!);
  const bounded = requestBody(messages, many, config.model);
  assert.ok(Buffer.byteLength(bounded.body) <= MAX_REQUEST_BYTES);
  assert.ok(bounded.choices.length < 16);
});


test("scoring accepts only the documented closed response schema", async () => {
  const messages = transcript(), choices = candidates(messages, new Set(), 2_000);
  assert.equal((await score(messages, choices, config, undefined, fakeFetch())).refs.length, 2);
  const kept = await score(messages, choices, config, undefined, fakeFetch(0.9));
  assert.equal(kept.refs.length, 0);
  assert.deepEqual(kept.keptRefs, requestBody(messages, choices, config.model).choices.map(c => c.ref));
  const body = JSON.parse(requestBody(messages, choices, config.model).body);
  const valid = response(body);
  const answer = { type: "noul", noul: 0 };
  const invalid = [
    {},
    { ...valid, extra: true },
    { ...valid, model: "gpt-4" },
    { ...valid, answers: {} },
    { ...valid, answers: { r0: answer, r1: { noul: 0 } } },
    { ...valid, answers: { r0: answer, r1: { ...answer, confidence: 1 } } },
    { ...valid, answers: { r0: answer, r1: { ...answer, noul: 2 } } },
    { ...valid, usage: { input_tokens: 1 } },
    { ...valid, usage: { input_tokens: 1.5, output_tokens: 1 } },
  ];
  for (const value of invalid) {
    await assert.rejects(score(messages, choices, config, undefined, (async () => Response.json(value)) as typeof fetch));
  }
  await assert.rejects(score(messages, choices, config, undefined,
    (async () => new Response("secret echoed by provider", { status: 429 })) as typeof fetch),
  error => String(error).includes("429") && !String(error).includes("secret"));
  await assert.rejects(score(messages, choices, config, undefined,
    (async () => new Response("not json")) as typeof fetch), { message: "Invalid Nimble response JSON" });
});


test("transport refuses redirects, bounds streamed responses, and cancels aborted bodies", async () => {
  const messages = transcript(), choices = candidates(messages, new Set(), 2_000);
  let inspected = false;
  await score(messages, choices, config, undefined, fakeFetch(0.1, (_body, init) => {
    inspected = true;
    assert.equal(init.redirect, "error");
    assert.equal((init.headers as Record<string, string>).accept, "application/json");
    assert.ok(init.signal);
  }));
  assert.equal(inspected, true);

  await assert.rejects(score(messages, choices, config, undefined, (async () => new Response("x", {
    headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) },
  })) as typeof fetch), /byte budget/);

  let oversizedCancelled = false;
  const oversized = new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(new Uint8Array(MAX_RESPONSE_BYTES));
      stream.enqueue(new Uint8Array(1));
    },
    cancel() { oversizedCancelled = true; },
  });
  await assert.rejects(score(messages, choices, config, undefined,
    (async () => new Response(oversized)) as typeof fetch), /byte budget/);
  assert.equal(oversizedCancelled, true);

  let abortedCancelled = false;
  const waiting = new ReadableStream<Uint8Array>({ cancel() { abortedCancelled = true; } });
  const controller = new AbortController();
  const pending = score(messages, choices, config, controller.signal,
    (async () => new Response(waiting)) as typeof fetch);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(abortedCancelled, true);
});


test("HTTP requests have a deadline and propagate abort", async () => {
  const messages = transcript(), choices = candidates(messages, new Set(), 2_000);
  const waiting = (async (_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    if (init.signal?.aborted) reject(init.signal.reason);
    init.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  })) as typeof fetch;
  const keepAlive = setTimeout(() => {}, 1_000);
  try {
    await assert.rejects(score(messages, choices, { ...config, timeoutMs: 10 }, undefined, waiting), { name: "TimeoutError" });
    const controller = new AbortController(); controller.abort();
    await assert.rejects(score(messages, choices, config, controller.signal, waiting), { name: "AbortError" });
  } finally { clearTimeout(keepAlive); }
});


