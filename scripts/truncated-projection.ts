/** Experimental projection only. Production masking and persisted decisions unchanged. */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { reference, textOf, type Candidate } from "../src/pruning.ts";

export function projectTruncated(messages: readonly AgentMessage[], refs: ReadonlySet<string>): AgentMessage[] {
  return messages.map(message => {
    if (message.role !== "toolResult" || !refs.has(reference(message))) return message;
    const text = textOf(message);
    if (text.length <= 600) return message;
    const ref = reference(message);
    const marker = `[pi-nimble experiment: ${text.length - 600} characters omitted from this tool output; `
      + `full original retained in this session. Retrieve with nimble_read({"ref":"${ref}"}). `
      + "Do not rerun a side-effecting command to recover its output.]";
    const shortened = `${text.slice(0, 300)}\n${marker}\n${text.slice(-300)}`;
    if (shortened.length >= text.length) return message;
    return { ...message, content: [{ type: "text", text: shortened }] };
  });
}

/** Same newest-first policy and cache assumptions as affordable(), using a supplied projection. */
export function experimentalPayback(
  messages: readonly AgentMessage[], refs: ReadonlySet<string>, proposed: readonly Candidate[],
  maxPaybackTurns: number,
  project: (messages: readonly AgentMessage[], refs: ReadonlySet<string>) => AgentMessage[],
): Candidate[] {
  const positions = new Map(messages.flatMap((m, i) => m.role === "toolResult" ? [[reference(m), i] as const] : []));
  const ordered = proposed.filter(c => positions.has(c.ref)).toSorted((a, b) => positions.get(b.ref)! - positions.get(a.ref)!);
  let best: Candidate[] = [];
  let bestSaved = 0;
  for (let count = 1; count <= ordered.length; count++) {
    const subset = ordered.slice(0, count);
    const masked = project(messages, new Set([...refs, ...subset.map(c => c.ref)]));
    const rewritten = masked.slice(positions.get(subset.at(-1)!.ref)!).reduce((sum, m) => sum + estimateTokens(m), 0);
    const saved = subset.reduce((sum, c) => sum + estimateTokens(c.result) - estimateTokens(masked[positions.get(c.ref)!]!), 0);
    if (saved > bestSaved && 1.15 * rewritten <= maxPaybackTurns * 0.1 * saved) {
      best = subset;
      bestSaved = saved;
    }
  }
  return best;
}
