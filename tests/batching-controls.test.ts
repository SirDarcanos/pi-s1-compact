import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { withoutOlderTestPair } from "../scripts/batching-controls.ts";

function fixture(): AgentMessage[] {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const pairs = ["tests-old", "tests-new"].flatMap((id): AgentMessage[] => [
    { role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: { command: "npm test" } }],
      api: "openai-completions", provider: "ollama", model: "fixture", stopReason: "toolUse", timestamp: 1, usage },
    { role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text: "Tests: passed" }],
      isError: false, timestamp: 2 },
  ]);
  return [{ role: "user", content: "Preserve the latest test counts.", timestamp: 0 }, ...pairs];
}

test("ablation removes only older test pair, preserves current result and source snapshot", () => {
  const original = fixture();
  const before = JSON.stringify(original);
  const ablated = withoutOlderTestPair(original);
  assert.equal(JSON.stringify(original), before);
  assert.deepEqual(ablated, [original[0], original[3], original[4]]);
  assert.strictEqual(ablated[1], original[3]);
});

test("ablation rejects missing pairs and shared assistant content", () => {
  assert.throws(() => withoutOlderTestPair([]));
  const messages = fixture();
  const owner = messages[1];
  assert(owner.role === "assistant");
  owner.content.push({ type: "text", text: "Must not silently remove this prose" });
  assert.throws(() => withoutOlderTestPair(messages), /shared call owner/);
});
