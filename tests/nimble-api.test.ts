import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { applyPruning, candidates, configuration, MAX_REQUEST_BYTES, MAX_REQUEST_TOKENS, requestBody, score, type Config } from "../src/pruning.ts";
import { estimateTokens } from "../src/engine/state.ts";
import { validateEndpoint } from "../src/engine/request.ts";

const config: Config = { ...configuration({}), keepRecentTokens: 2_000 };
function history(): AgentMessage[] {
  return [
    { role: "user", content: "Never change the public parser API. Keep src/generated untouched.", timestamp: 1 },
    { role: "assistant", content: [
      { type: "thinking", thinking: "PRIVATE_REASONING", thinkingSignature: "PRIVATE_SIGNATURE" },
      { type: "toolCall", id: "old", name: "bash", arguments: { command: "git log -p" } },
    ], api: "openai-responses", provider: "openai", model: "fixture", stopReason: "toolUse", timestamp: 2,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
    { role: "toolResult", toolCallId: "old", toolName: "bash", content: [{ type: "text", text: "old diff\n".repeat(600) }],
      details: { private: "PRIVATE_DETAILS" }, isError: false, timestamp: 3 },
    ...Array.from({ length: 10 }, (_, i): AgentMessage => ({ role: "user", content: `Next step ${i}: finish the parser`, timestamp: 4 + i })),
    { role: "user", content: "Recent work. ".repeat(2_000), timestamp: 20 },
  ];
}

test("Nimble defaults to local Ollama without a key and never uses Jev credentials", () => {
  const cfg = configuration({ TYPESAFE_API_KEY: "do-not-use", JEV_API_KEY: "do-not-use" });
  assert.equal(cfg.endpoint, "http://127.0.0.1:11434/v1/systemone");
  assert.equal(cfg.apiKey, "");
  assert.equal(cfg.model, "nimble");
  assert.equal(cfg.timeoutMs, 30_000);
  const local = configuration({ PI_NIMBLE_URL: " http://127.0.0.1:8000/v1/systemone ", NIMBLE_API_KEY: " optional " });
  assert.equal(local.endpoint, "http://127.0.0.1:8000/v1/systemone");
  assert.equal(configuration({ PI_NIMBLE_URL: "" }).endpoint, "", "explicit empty URL disables clearing");
  assert.equal(configuration({ PI_NIMBLE_MODEL: "nimble:q8_0" }).model, "nimble:q8_0");
  assert.equal(local.apiKey, "optional");
});

test("endpoints allow HTTPS and loopback HTTP, not insecure remote URLs or embedded credentials", () => {
  for (const url of [config.endpoint, "http://localhost:8000/v1/systemone", "http://[::1]:8000/v1/systemone", "https://nimble.example/v1/systemone"]) {
    assert.equal(validateEndpoint(url), url);
  }
  for (const url of ["", "not-a-url", "http://nimble.example/v1/systemone", "ftp://localhost/api", "https://user:password@nimble.example/api", "https://nimble.example/api?key=secret", "https://nimble.example/api#fragment"]) {
    assert.throws(() => validateEndpoint(url), /Nimble endpoint/);
  }
});

test("Pi uses the original engine's whole-history fitting within Nimble request limits", () => {
  const messages = history();
  const choices = candidates(messages, new Set(), config.keepRecentTokens);
  const request = requestBody(messages, choices, config.model);
  const body = JSON.parse(request.body);
  assert.match(JSON.stringify(body.state.conversation), /Never change the public parser API/);
  assert.match(JSON.stringify(body.state.conversation), /src\/generated/);
  assert.ok(Array.isArray(body.state.conversation.history));
  assert.match(JSON.stringify(body.state.conversation), /git log -p/);
  assert.match(JSON.stringify(body.state.conversation), /5400 chars \(omitted\)/);
  assert.doesNotMatch(request.body, /PRIVATE_|typesafe\.ai|jev_read/);
  assert.ok(Buffer.byteLength(request.body) <= MAX_REQUEST_BYTES);
  assert.ok(estimateTokens(request.body) <= MAX_REQUEST_TOKENS);
  assert.equal(body.questions.r0.type, "noul");
  assert.equal(body.model, "nimble");
});

test("long tool histories fit without losing candidate metadata or user constraints", async () => {
  const messages = history();
  const choices = candidates(messages, new Set(), config.keepRecentTokens);
  const assistant = messages[1] as Extract<AgentMessage, { role: "assistant" }>;
  const result = messages[2] as Extract<AgentMessage, { role: "toolResult" }>;
  const extra = Array.from({ length: 150 }, (_, i): AgentMessage[] => [
    { ...assistant, content: [{ type: "toolCall", id: `extra-${i}`, name: "read", arguments: { path: `module-${i}.ts` } }] },
    { ...result, toolCallId: `extra-${i}`, toolName: "read", content: [{ type: "text", text: "small" }] },
  ]).flat();
  messages.splice(3, 0, ...extra);
  const snapshot = structuredClone(messages);
  let called = false;
  await score(messages, choices, config, undefined, (async (_url, init) => {
    called = true;
    const body = JSON.parse(String(init?.body));
    assert.ok(estimateTokens(JSON.stringify(body.state.conversation)) <= 2_000);
    assert.ok(estimateTokens(String(init?.body)) <= MAX_REQUEST_TOKENS);
    assert.ok(Buffer.byteLength(String(init?.body)) <= MAX_REQUEST_BYTES);
    assert.match(JSON.stringify(body.state.conversation), /Never change the public parser API/);
    assert.match(JSON.stringify(body.state.conversation), /git log -p/);
    assert.doesNotMatch(JSON.stringify(body.state.conversation), /module-149/);
    return Response.json({ model: "nimble", answers: { r0: { type: "noul", noul: 0.9 } },
      usage: { input_tokens: 100, output_tokens: 1 } });
  }) as typeof fetch);
  assert.ok(called);
  assert.deepEqual(messages, snapshot);
});

test("real HTTP transport works with a keyless Nimble-compatible server and checkpoint model ID", async t => {
  const messages = history();
  const choices = candidates(messages, new Set(), config.keepRecentTokens);
  let called = false;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    called = true;
    assert.equal(req.url, "/v1/systemone");
    assert.equal(req.method, "POST");
    assert.equal(req.headers.authorization, undefined);
    assert.equal(body.model, "nimble");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ model: "bespokelabs/Bespoke-Nimble-9B", answers: Object.fromEntries(
      Object.keys(body.questions).map(id => [id, { type: "noul", noul: 0.1 }])), usage: { input_tokens: 1200, output_tokens: 2 } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const scored = await score(messages, choices, { ...config, endpoint: `http://127.0.0.1:${address.port}/v1/systemone` });
  assert.ok(called);
  assert.deepEqual(scored.refs, choices.map(item => item.ref));
});

test("Ollama's documented response and canonical latest tag are accepted without a key", async () => {
  const messages = history(), choices = candidates(messages, new Set(), config.keepRecentTokens);
  const scored = await score(messages, choices, config, undefined, (async (url, init) => {
    assert.equal(url, "http://127.0.0.1:11434/v1/systemone");
    assert.equal((init?.headers as Record<string, string>).authorization, undefined);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "nimble");
    // Ollama can return the requested alias or its canonical tag.
    return Response.json({ model: "nimble:latest", answers: { r0: { type: "noul", noul: 0.1 } },
      usage: { input_tokens: 841, output_tokens: 1 } });
  }) as typeof fetch);
  assert.deepEqual(scored.refs, choices.map(item => item.ref));
  assert.equal(scored.inputTokens, 841);
});

test("Ollama's optional cache count is accepted without changing scoring", async () => {
  const messages = history(), choices = candidates(messages, new Set(), config.keepRecentTokens);
  for (const cached of [0, 100]) {
    const result = await score(messages, choices, config, undefined, (async () => Response.json({
      model: "nimble", answers: { r0: { type: "noul", noul: 0.1 } },
      usage: { input_tokens: 841, output_tokens: 0 }, prompt_eval_cached_count: cached,
    })) as typeof fetch);
    assert.deepEqual(result.refs, choices.map(item => item.ref));
    assert.equal(result.inputTokens, 841);
  }
});

test("malformed cache counts and unrelated response fields still fail closed", async () => {
  const messages = history(), choices = candidates(messages, new Set(), config.keepRecentTokens);
  for (const extra of [
    ...[null, "0", -1, 0.5, Number.MAX_SAFE_INTEGER + 1].map(prompt_eval_cached_count => ({ prompt_eval_cached_count })),
    { prompt_eval_cached_count: 0, unexpected: true },
  ]) {
    await assert.rejects(score(messages, choices, config, undefined, (async () => Response.json({
      model: "nimble", answers: { r0: { type: "noul", noul: 0.1 } },
      usage: { input_tokens: 841, output_tokens: 0 }, ...extra,
    })) as typeof fetch), { message: "Invalid Nimble response" });
  }
});

test("Nimble keys are optional and sent only to the configured endpoint", async () => {
  const messages = history(), choices = candidates(messages, new Set(), config.keepRecentTokens);
  let called = false;
  await score(messages, choices, { ...config, apiKey: "fixture" }, undefined, (async (url, init) => {
    called = true;
    assert.equal(url, config.endpoint);
    assert.equal((init?.headers as Record<string, string>).authorization, "Bearer fixture");
    assert.equal(init?.redirect, "error");
    const body = JSON.parse(String(init?.body));
    return Response.json({ model: body.model, answers: Object.fromEntries(Object.keys(body.questions)
      .map(id => [id, { type: "noul", noul: 0.8 }])), usage: { input_tokens: 100, output_tokens: 2 } });
  }) as typeof fetch);
  assert.ok(called);
});

test("live local Ollama accepts the plugin's actual Nimble request", { skip: process.env.PI_NIMBLE_LIVE !== "1" }, async t => {
  // Deliberately ignore endpoint/key environment overrides: only synthetic data
  // goes to local Ollama, never a remote service or the user's active session.
  const local = { ...configuration({}), keepRecentTokens: 2_000, timeoutMs: 120_000 };
  const messages = history();
  const choices = candidates(messages, new Set(), local.keepRecentTokens);
  const result = await score(messages, choices, local);
  assert.equal(result.evaluated, choices.length);
  assert.ok(result.inputTokens !== null && result.inputTokens > 0);
  assert.ok(result.refs.every(ref => choices.some(item => item.ref === ref)));
  const projected = applyPruning(messages, new Set(result.refs));
  assert.equal(projected.length, messages.length);
  assert.equal(projected[0], messages[0], "user constraints stay verbatim");
  t.diagnostic(`Ollama accepted ${result.evaluated} candidate(s); ${result.refs.length} below keep threshold; ${result.inputTokens} input tokens`);
});

test("busy and cold-start responses fail closed without retrying or falling back to Jev", async () => {
  const messages = history(), choices = candidates(messages, new Set(), config.keepRecentTokens);
  for (const status of [401, 503, 529]) {
    let calls = 0;
    await assert.rejects(score(messages, choices, config, undefined, (async () => {
      calls++;
      return new Response("private server error detail", { status });
    }) as typeof fetch), { message: `Nimble HTTP ${status}` });
    assert.equal(calls, 1);
  }
});
