import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** History-only ablation. Does not modify replay source messages or applied masks. */
export function withoutOlderTestPair(messages: readonly AgentMessage[]): AgentMessage[] {
  const id = "tests-old";
  const result = messages.filter(m => m.role === "toolResult" && m.toolCallId === id);
  const owners = messages.filter(m => m.role === "assistant" && m.content.some(c => c.type === "toolCall" && c.id === id));
  assert.equal(result.length, 1, "Ablation requires exactly one older test result");
  assert.equal(owners.length, 1, "Ablation requires exactly one older test call owner");
  const owner = owners[0];
  assert(owner.role === "assistant" && owner.content.length === 1,
    "Cannot remove a shared call owner or assistant prose");
  assert(owner.content[0].type === "toolCall" && owner.content[0].name === "bash");
  assert(result[0].role === "toolResult" && result[0].toolName === "bash");
  return messages.filter(m => m !== owner && m !== result[0]);
}
