import assert from "node:assert/strict";
import test from "node:test";
import { requestBody, RequestBudgetError, type Candidate } from "../src/pruning.ts";
import { estimateTokens, fitState, StateBudgetError } from "../src/engine/state.ts";
import { activationConflict } from "../src/activation.ts";

const budget = { tokens: 4000, stateTokens: 1000, bytes: 12000, questions: 4 };
const result = { role: "toolResult" as const, toolCallId: "old", toolName: "read",
  content: [{ type: "text" as const, text: "Unique API evidence" }], isError: false, timestamp: 1 };
const candidate: Candidate = { ref: "old", result, input: { path: "example.ts" } };

for (const length of [1000, 10000, 100000]) {
  test(`growing history (${length} characters) fits the same fixed classifier budget`, () => {
    const content = "漢字".repeat(length / 2);
    const messages = Array.from({ length: 3 }, () => ({ role: "user" as const, content, timestamp: 0 }));
    // This is the original failing stage: pinned prose plus a derived goal do
    // not fit even after the normal history fitter's truncation passes.
    assert.throws(() => fitState(messages.map(m => ({ role: "user", text: m.content, toolUses: [] })), [],
      { maxStateTokens: budget.stateTokens, preserveRecentMessages: 2, goal: "" }), StateBudgetError);
    const request = requestBody(messages, [candidate], "pplx-decider:latest", budget);
    const parsed = JSON.parse(request.body);
    assert.equal(parsed.model, "pplx-decider:latest");
    assert.ok(estimateTokens(request.body) <= budget.tokens);
    assert.ok(Buffer.byteLength(request.body) <= budget.bytes);
    assert.match(parsed.state.instructions, /missing context is not evidence of irrelevance/);
    assert.equal(parsed.state.results[0].excerpt, "Unique API evidence");
    assert.equal(messages[0]!.content, content, "session messages are not mutated");
    assert.equal(request.choices.length, 1);
  });
}

test("request fitting shrinks the batch and leaves budget-omitted outputs unscored", () => {
  const choices = Array.from({ length: 4 }, (_, i) => ({ ...candidate, ref: `ref-${i}`,
    result: { ...result, toolCallId: `call-${i}`, content: [{ type: "text" as const, text: "漢字".repeat(500) }] } }));
  const request = requestBody([], choices, "clef:latest", { ...budget, tokens: 2000 });
  assert.ok(request.choices.length > 0 && request.choices.length < choices.length);
  assert.equal(Object.keys(JSON.parse(request.body).questions).length, request.choices.length);
  assert.ok(estimateTokens(request.body) <= 2000);
  assert.equal(choices.length, 4);
});

test("irreducibly oversized request is skipped with a classifier-neutral budget error", () => {
  assert.throws(() => requestBody([], [candidate], "clef:latest", { ...budget, bytes: 10 }),
    error => error instanceof RequestBudgetError && /Classifier evaluation skipped/.test(error.message)
      && !/Nimble/.test(error.message));
});

test("activation uses native command ownership and still detects foreign legacy pruners", () => {
  const commands = ["s1-compact", "s1-compact-settings", "s1-compact-reset", "s1-compact-status"]
    .map(name => ({ name, source: "extension", sourceInfo: { path: "/successor.ts" } }));
  const pi = { getCommands: () => commands } as unknown as Parameters<typeof activationConflict>[0];
  assert.equal(activationConflict(pi), undefined);
  commands.push({ name: "nimble-status:2", source: "extension", sourceInfo: { path: "/legacy.ts" } });
  assert.match(activationConflict(pi)!, /Legacy pruner active/);
  commands.pop(); commands.pop();
  assert.match(activationConflict(pi)!, /Ambiguous S1 command ownership/);
});
