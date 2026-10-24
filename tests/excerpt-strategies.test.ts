import assert from "node:assert/strict";
import test from "node:test";
import { evidenceExcerpt } from "../scripts/excerpt-strategies.ts";
import { requestBody, MAX_REQUEST_BYTES, MAX_REQUEST_TOKENS, type Candidate } from "../src/pruning.ts";
import { estimateTokens } from "../src/engine/state.ts";

test("head-tail matches production request excerpt", () => {
  const text = "BEGIN" + "x".repeat(5000) + "END";
  const result = { role: "toolResult" as const, toolCallId: "one", toolName: "read",
    content: [{ type: "text" as const, text }], isError: false, timestamp: 1 };
  const candidate: Candidate = { ref: "one", result, input: { path: "src/example.ts" } };
  const body = JSON.parse(requestBody([result], [candidate], "nimble").body);
  assert.equal(evidenceExcerpt(text, "head-tail"), body.state.results[0].excerpt);
});

test("equal payload view exposes central evidence while full retains all text", () => {
  const text = "h".repeat(2400) + "EXACT_CONTRACT" + "t".repeat(2400);
  assert(!evidenceExcerpt(text, "head-tail").includes("EXACT_CONTRACT"));
  assert(evidenceExcerpt(text, "head-middle-tail").includes("EXACT_CONTRACT"));
  for (const mode of ["head-tail", "head-middle-tail"] as const) {
    const stripped = evidenceExcerpt(text, mode).replaceAll("\n[… omitted …]\n", "");
    assert.equal(stripped.length, 800);
  }
  assert.equal(evidenceExcerpt(text, "full"), text);
  for (const mode of ["head-tail", "head-middle-tail", "full"] as const) {
    assert.equal(evidenceExcerpt("short", mode), "short");
  }
  const body = JSON.stringify({ state: { results: [{ excerpt: evidenceExcerpt(text, "full") }] } });
  assert(Buffer.byteLength(body) < MAX_REQUEST_BYTES);
  assert(estimateTokens(body) < MAX_REQUEST_TOKENS);
});
