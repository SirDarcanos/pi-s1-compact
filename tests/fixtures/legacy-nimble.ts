// Frozen legacy activation fixture from pi-nimble-compact db9ec3d; see NOTICE.md.
import { Type } from "typebox";
import {
  buildSessionContext, estimateTokens, type ExtensionAPI, type ExtensionContext, type SessionEntry, type SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  affordableReductions, applyPruning, candidates, configuration, ENTRY_TYPE, GROWTH_TOKENS,
  ledger, original, score, superseded, textOf, triggerTokens, truncationLedger, type Config,
} from "../../src/pruning.ts";

function nativeCheckpoint(branch: readonly SessionEntry[]): boolean {
  const latest = branch.findLast(entry => entry.type === "compaction"
    || (entry.type === "custom" && entry.customType === "openai-codex-native-compaction"));
  return latest?.type === "custom" || (latest?.type === "compaction"
    && (latest.details as { kind?: unknown } | undefined)?.kind === "openai-codex-native-compaction");
}
function cumulativeClearedTokens(entries: readonly SessionEntry[]): number {
  let total = 0;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
    const data = entry.data as { version?: unknown; refs?: unknown; truncatedRefs?: unknown; estimatedTokensCleared?: unknown } | undefined;
    if (data?.version !== 1 || !Array.isArray(data.refs)) continue;
    const refs = [...data.refs, ...(Array.isArray(data.truncatedRefs) ? data.truncatedRefs : [])];
    if (!refs.length || !refs.every(ref => typeof ref === "string" && /^[a-f0-9]{24}$/.test(ref))) continue;
    if (typeof data.estimatedTokensCleared === "number"
      && Number.isFinite(data.estimatedTokensCleared) && data.estimatedTokensCleared > 0) total += data.estimatedTokensCleared;
  }
  return total;
}

function restoreLeaf(manager: ExtensionContext["sessionManager"], leaf: string | null): void {
  // SAFETY: ExtensionContext exposes the concrete SessionManager as read-only, but appendEntry
  // mutates that same instance before persistence, so rollback must use its public leaf methods.
  const mutable = manager as unknown as Pick<SessionManager, "branch" | "resetLeaf">;
  if (leaf) mutable.branch(leaf); else mutable.resetLeaf();
}

function compactTokens(tokens: number): string {
  if (tokens < 1_000) return tokens.toLocaleString();
  return `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
}

/** Injectable transport/configuration keep tests entirely offline. */
export function registerNimble(pi: ExtensionAPI, options: { config?: Config; fetch?: typeof fetch } = {}): void {
  const config = options.config ?? configuration();
  let lastAttemptTokens = -Infinity;
  let controller: AbortController | undefined;
  let epoch = 0;
  let lastStatus = "No evaluation yet";
  let warned = false;
  const updateStatus = (ctx: ExtensionContext) => {
    const saved = cumulativeClearedTokens(ctx.sessionManager.getEntries());
    const savings = `Nimble saved ${saved ? `~${compactTokens(saved)}` : "0"} tokens`;
    const active = pi.getActiveTools().includes("nimble_read");
    if (!ctx.hasUI) return;
    if (!config.endpoint) { ctx.ui.setStatus("pi-nimble", `${savings} · dormant`); return; }
    if (!active) { ctx.ui.setStatus("pi-nimble", `${savings} · paused · nimble_read inactive`); return; }
    if (nativeCheckpoint(ctx.sessionManager.getBranch())) {
      ctx.ui.setStatus("pi-nimble", `${savings} · paused · Codex checkpoint owns provider context`);
      return;
    }
    const activity = controller ? " · checking…" : warned ? " · error" : "";
    ctx.ui.setStatus("pi-nimble", `${savings}${activity}`);
  };

  const reset = () => {
    epoch++;
    controller?.abort();
    controller = undefined;
    lastAttemptTokens = -Infinity;
    lastStatus = "No evaluation yet";
    warned = false;
  };
  pi.on("session_start", (_event, ctx) => {
    reset();
    if (!config.endpoint && ctx.hasUI) ctx.ui.notify("pi-nimble is disabled by an empty PI_NIMBLE_URL. Unset it to use local Ollama, then restart Pi. Normal compaction remains enabled.", "info");
    updateStatus(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    reset();
    if (ctx.hasUI) ctx.ui.setStatus("pi-nimble", undefined);
  });
  pi.on("session_tree", (_event, ctx) => { reset(); updateStatus(ctx); });
  pi.on("session_before_compact", (_event, ctx) => { reset(); updateStatus(ctx); });
  pi.on("session_compact", (_event, ctx) => { reset(); updateStatus(ctx); });

  const startEvaluation = (ctx: ExtensionContext, manual = false): Promise<void> | undefined => {
    if (!config.endpoint || controller || !ctx.model || !pi.getActiveTools().includes("nimble_read")) return;
    const branch = ctx.sessionManager.getBranch();
    if (nativeCheckpoint(branch)) return;
    const messages = buildSessionContext(branch).messages;
    const refs = ledger(branch);
    const truncatedRefs = truncationLedger(branch);
    const rawTokens = messages.reduce((sum, message) => sum + estimateTokens(message), 0);
    // Measure what the next request carries: cleared outputs no longer count, so clearing is its own hysteresis.
    const projectedTokens = applyPruning(messages, refs, truncatedRefs).reduce((sum, message) => sum + estimateTokens(message), 0);
    const usageTokens = ctx.getContextUsage()?.tokens ?? 0;
    if (!manual && Math.max(projectedTokens, usageTokens) < triggerTokens(config, ctx.model.contextWindow)) return;
    if (!manual && rawTokens >= lastAttemptTokens && rawTokens - lastAttemptTokens < GROWTH_TOKENS) return;
    lastAttemptTokens = rawTokens;
    const choices = candidates(messages, refs, config.keepRecentTokens);
    if (!choices.length) { lastStatus = "No old eligible outputs"; return; }
    const automatic = superseded(messages, choices, refs);
    const uncertain = choices.filter(item => !automatic.has(item.ref));

    const ownController = new AbortController();
    controller = ownController;
    const ownEpoch = epoch;
    const snapshotLeaf = ctx.sessionManager.getLeafId();
    updateStatus(ctx);

    return (async () => {
      try {
        const result = uncertain.length
          ? await score(applyPruning(messages, refs, truncatedRefs), uncertain, config, ownController.signal, options.fetch)
          : { refs: [] as string[], keptRefs: [] as string[], evaluated: 0, inputTokens: null };
        if (ownController.signal.aborted || epoch !== ownEpoch || !pi.getActiveTools().includes("nimble_read")) return;
        const currentBranch = ctx.sessionManager.getBranch();
        const snapshotIndex = snapshotLeaf ? currentBranch.findIndex(entry => entry.id === snapshotLeaf) : -1;
        if (snapshotLeaf && snapshotIndex < 0) return;
        if (currentBranch.slice(snapshotIndex + 1).some(entry => entry.type === "message" && entry.message.role === "user")) {
          lastAttemptTokens = -Infinity;
          return;
        }
        const currentRefs = ledger(currentBranch);
        const currentTruncated = truncationLedger(currentBranch);
        const currentMessages = buildSessionContext(currentBranch).messages;
        const eligible = new Set(candidates(currentMessages, currentRefs, config.keepRecentTokens).map(item => item.ref));
        const accepted = choices.filter(item => eligible.has(item.ref)
          && (result.refs.includes(item.ref) || (automatic.has(item.ref) && superseded(currentMessages, [item], currentRefs).has(item.ref))));
        // Shorten only results explicitly retained by valid scoring, never an unscored
        // candidate dropped from the request budget or a stale result deferred by economics.
        const toTruncate = config.truncateMinChars > 0 ? choices.filter(item => eligible.has(item.ref)
          && result.keptRefs.includes(item.ref) && !currentTruncated.has(item.ref)
          && textOf(item.result).length > config.truncateMinChars) : [];
        const { cleared, truncated, saved } = affordableReductions(currentMessages, currentRefs,
          currentTruncated, accepted, toTruncate, config.maxPaybackTurns);
        const deferred = accepted.length + toTruncate.length - cleared.length - truncated.length;
        const clearedRefs = new Set(cleared.map(item => item.ref));
        if (cleared.length || truncated.length) {
          const entry = {
            version: 1, refs: [...clearedRefs], truncatedRefs: truncated.map(item => item.ref),
            model: config.model, evaluated: choices.length,
            estimatedTokensCleared: saved, inputTokens: result.inputTokens,
          };
          const commitLeaf = ctx.sessionManager.getLeafId();
          try { pi.appendEntry(ENTRY_TYPE, entry); }
          catch (error) {
            // Pi advances its in-memory leaf before disk I/O. Invalidate the entry and restore the
            // persisted branch head so later writes cannot become children of an unpersisted ID.
            entry.refs = [];
            entry.truncatedRefs = [];
            restoreLeaf(ctx.sessionManager, commitLeaf);
            throw error;
          }
        }
        lastStatus = cleared.length || truncated.length
          ? `${cleared.length} outputs cleared; ${truncated.length} shortened; ~${saved.toLocaleString()} estimated tokens removed (${choices.length} outputs evaluated)`
          : `No additional changes (${choices.length} outputs evaluated)`;
        if (deferred) lastStatus += `; ${deferred} reductions deferred to preserve prompt-cache efficiency`;
        warned = false;
      } catch (error) {
        if (epoch !== ownEpoch || ownController.signal.aborted) return;
        lastStatus = error instanceof Error ? error.message : "Nimble unavailable";
        if (!manual && !warned && ctx.hasUI) ctx.ui.notify(`pi-nimble: ${lastStatus}. Context unchanged; normal compaction remains available.`, "warning");
        warned = true;
      } finally {
        if (controller === ownController) controller = undefined;
        if (epoch === ownEpoch) updateStatus(ctx);
      }
    })();
  };

  pi.on("context", (event, ctx) => {
    if (!config.endpoint) return;
    updateStatus(ctx);
    if (!pi.getActiveTools().includes("nimble_read") || nativeCheckpoint(ctx.sessionManager.getBranch())) return;
    const branch = ctx.sessionManager.getBranch();
    const projected = applyPruning(event.messages, ledger(branch), truncationLedger(branch));
    startEvaluation(ctx);
    return { messages: projected };
  });

  // Launch scoring at each live model/tool boundary, then let the next provider request proceed.
  // A concurrent result is committed only while its candidates remain eligible on this branch.
  pi.on("turn_end", (_event, ctx) => {
    updateStatus(ctx);
    startEvaluation(ctx);
  });

  pi.registerCommand("nimble-compact", {
    description: "Run Nimble output pruning now, bypassing the automatic trigger and cooldown",
    handler: async (args, ctx) => {
      const notify = (message: string, warning = false) => {
        if (ctx.hasUI) ctx.ui.notify(`pi-nimble: ${message}`, warning ? "warning" : "info");
      };
      if (args.trim()) { notify("Usage: /nimble-compact", true); return; }
      await ctx.waitForIdle();
      if (!config.endpoint) { notify("Pruning disabled by an empty PI_NIMBLE_URL", true); return; }
      if (!ctx.model) { notify("No model selected", true); return; }
      if (!pi.getActiveTools().includes("nimble_read")) { notify("Paused: nimble_read must be active", true); return; }
      if (nativeCheckpoint(ctx.sessionManager.getBranch())) {
        notify("Paused: Codex checkpoint owns provider context", true); return;
      }
      if (controller) { notify("An evaluation is already running", true); return; }
      const ownEpoch = epoch;
      await startEvaluation(ctx, true);
      if (epoch !== ownEpoch) { notify("Evaluation cancelled by a session or compaction change"); return; }
      notify(`${lastStatus}${warned ? ". Context unchanged; normal compaction remains available." : ""}`, warned);
      updateStatus(ctx);
    },
  });

  pi.registerTool({
    name: "nimble_read",
    label: "Read original output",
    description: "Retrieve original tool output cleared or truncated by pi-nimble from this session's active branch. Use the ref in its marker. Read original evidence rather than rerunning commands. offset and limit are character counts; maximum page 16000 characters.",
    parameters: Type.Object({
      ref: Type.String({ pattern: "^[a-f0-9]{24}$" }),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16_000 })),
    }),
    async execute(_id, args, _signal, _update, ctx) {
      const result = original(ctx.sessionManager.getBranch(), args.ref);
      if (!result) throw new Error("Original output is not on this session branch");
      const text = textOf(result);
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 8_000;
      if (offset > text.length) throw new Error(`Offset exceeds output length (${text.length})`);
      const end = Math.min(text.length, offset + limit);
      return {
        content: [{ type: "text", text: `[Original ${result.toolName} output; characters ${offset}–${end} of ${text.length}]\n${text.slice(offset, end)}` }],
        details: { ref: args.ref, offset, nextOffset: end < text.length ? end : null, totalCharacters: text.length },
      };
    },
  });

  pi.registerCommand("nimble-reset", {
    description: "Release all Nimble-cleared and truncated outputs on the active branch",
    handler: async (_args, ctx) => {
      const branch = ctx.sessionManager.getBranch();
      const shortened = truncationLedger(branch).size;
      const released = ledger(branch).size + shortened;
      reset();
      if (!released) {
        lastStatus = "No cleared or truncated outputs to release";
        updateStatus(ctx);
        ctx.ui.notify(lastStatus, "info");
        return;
      }
      const entry = { version: 1, refs: [] as string[], reset: true };
      const leaf = ctx.sessionManager.getLeafId();
      try { pi.appendEntry(ENTRY_TYPE, entry); }
      catch {
        entry.reset = false;
        restoreLeaf(ctx.sessionManager, leaf);
        lastStatus = "Could not persist mask reset";
        warned = true;
        updateStatus(ctx);
        ctx.ui.notify(`pi-nimble: ${lastStatus}; existing masks remain active.`, "warning");
        return;
      }
      lastStatus = `${released} ${shortened ? "cleared/truncated" : "cleared"} outputs released on this branch`;
      updateStatus(ctx);
      ctx.ui.notify(`pi-nimble: ${lastStatus}.`, "info");
    },
  });

  pi.registerCommand("nimble-status", {
    description: "Show automatic Nimble context-clearing status",
    handler: async (_args, ctx) => {
      const saved = cumulativeClearedTokens(ctx.sessionManager.getEntries());
      ctx.ui.notify([
        config.endpoint ? `Automatic at ${compactTokens(ctx.model ? triggerTokens(config, ctx.model.contextWindow) : config.triggerTokens)} context tokens (lesser of ${Math.round(config.threshold * 100)}% and ${compactTokens(config.triggerTokens)}) · ${config.model}` : "Disabled: PI_NIMBLE_URL is empty",
        `Endpoint: ${config.endpoint || "(disabled)"}`,
        !pi.getActiveTools().includes("nimble_read") ? "Paused: nimble_read is inactive"
          : nativeCheckpoint(ctx.sessionManager.getBranch()) ? "Paused: Codex checkpoint owns provider context; retrieval active"
          : "Retrieval active",
        `Active on this branch: ${truncationLedger(ctx.sessionManager.getBranch()).size} outputs shortened; ${ledger(ctx.sessionManager.getBranch()).size} cleared`,
        config.truncateMinChars > 0 ? `Retained outputs over ${config.truncateMinChars.toLocaleString()} characters may be truncated to 600 characters plus retrieval marker` : "New retained-output truncation disabled",
        `Session total: ${saved ? `~${compactTokens(saved)}` : "0"} estimated tokens removed from context so far (not billing savings)`,
        `Latest activity: ${lastStatus}`,
      ].join("\n"), "info");
    },
  });
}

export default function nimbleCompaction(pi: ExtensionAPI): void {
  registerNimble(pi);
}
