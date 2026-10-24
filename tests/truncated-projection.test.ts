import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { reference } from "../src/pruning.ts";
import { projectTruncated } from "../scripts/truncated-projection.ts";

function result(text: string): Extract<AgentMessage, { role: "toolResult" }> {
  return { role: "toolResult", toolCallId: "one", toolName: "read", timestamp: 1,
    content: [{ type: "text", text }], isError: false, details: { metrics: { truncated: false } } };
}

test("retains head/tail and original retrieval ref without mutating evidence", () => {
  const source = result("HEAD" + "x".repeat(3000) + "TAIL Tests: 36 passed, 4 skipped, 0 failed.");
  const original = structuredClone(source);
  const ref = reference(source);
  const [projected] = projectTruncated([source], new Set([ref]));
  assert(projected.role === "toolResult" && projected.content[0].type === "text");
  const text = projected.content[0].text;
  assert(text.startsWith("HEAD"));
  assert(text.endsWith("Tests: 36 passed, 4 skipped, 0 failed."));
  assert(text.includes(`nimble_read({"ref":"${ref}"})`));
  assert.strictEqual(projected.details, source.details);
  assert.equal(projected.toolCallId, source.toolCallId);
  assert.deepEqual(source, original);
  assert(text.length < original.content.map(c => c.type === "text" ? c.text : "").join("").length);
});

test("unselected and short outputs remain unchanged", () => {
  const source = result("short output");
  assert.strictEqual(projectTruncated([source], new Set([reference(source)]))[0], source);
  const long = result("x".repeat(3000));
  assert.strictEqual(projectTruncated([long], new Set())[0], long);
});
