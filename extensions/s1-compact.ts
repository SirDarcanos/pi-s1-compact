// Adapted from pi-nimble-compact and pi-jev-compaction; see NOTICE.md and licenses/.
import { Type } from "typebox";
import { buildSessionContext, estimateTokens, type ExtensionAPI, type ExtensionContext, type SessionEntry, type SessionManager } from "@earendil-works/pi-coding-agent";
import { affordableReductions, applyPruning, candidates, configuration, ENTRY_TYPE, GROWTH_TOKENS,
  ledger, original, superseded, textOf, triggerTokens, truncationLedger, RequestBudgetError, type Config } from "../src/pruning.ts";
import { abortable, authenticateClassifier, defaultSettings, destinationLabel, registerLocalNimble, resolveClassifier, scoreClassifier, selectionWithAuth } from "../src/classifier.ts";
import { fileSettingsStore, LOCAL_PROVIDER, type Settings, type SettingsStore } from "../src/settings.ts";
import { activationConflict } from "../src/activation.ts";

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
    const d = entry.data as { version?: unknown; refs?: unknown; truncatedRefs?: unknown; estimatedTokensCleared?: unknown } | undefined;
    if (d?.version !== 1 || !Array.isArray(d.refs)) continue;
    const refs = [...d.refs, ...(Array.isArray(d.truncatedRefs) ? d.truncatedRefs : [])];
    if (!refs.length || !refs.every(ref => typeof ref === "string" && /^[a-f0-9]{24}$/.test(ref))) continue;
    if (typeof d.estimatedTokensCleared === "number" && Number.isFinite(d.estimatedTokensCleared) && d.estimatedTokensCleared > 0) total += d.estimatedTokensCleared;
  }
  return total;
}
function restoreLeaf(manager: ExtensionContext["sessionManager"], leaf: string | null): void {
  const mutable = manager as unknown as Pick<SessionManager, "branch" | "resetLeaf">;
  if (leaf) mutable.branch(leaf); else mutable.resetLeaf();
}
const compactTokens = (n: number) => n < 1000 ? n.toLocaleString() : `${(n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, "")}k`;

/** Tests inject storage and fetch; production always uses Pi's registry and user-global settings. */
export function registerS1(pi: ExtensionAPI, options: { config?: Config; fetch?: typeof fetch; store?: SettingsStore } = {}): void {
  const config = options.config ?? configuration();
  const providerError = registerLocalNimble(pi, config);
  const store = options.store ?? fileSettingsStore();
  let settings: Settings | undefined;
  let settingsError = "Settings not loaded; scoring paused";
  let settingsBusy = false;
  let settingsController: AbortController | undefined;
  let pendingSave: Promise<void> | undefined;
  let sessionGeneration = 0;
  let settingsGeneration = 0;
  let lastAttemptTokens = -Infinity;
  let controller: AbortController | undefined;
  let epoch = 0;
  let lastStatus = "No evaluation yet";
  let warned = false;
  const notify = (ctx: ExtensionContext, message: string, warning = false) => {
    if (ctx.hasUI) ctx.ui.notify(`pi-s1-compact: ${message}`, warning ? "warning" : "info");
  };
  const paused = (ctx: ExtensionContext): string | undefined => {
    const conflict = activationConflict(pi);
    if (conflict) return conflict;
    if (settingsBusy) return "Settings change in progress";
    if (settingsError || !settings) return settingsError || "Settings unavailable";
    if (settings.classifier.provider === LOCAL_PROVIDER && providerError) return providerError;
    try { resolveClassifier(ctx.modelRegistry, settings); }
    catch (error) { return error instanceof Error ? error.message : "Classifier unavailable"; }
  };
  const pauseReason = (ctx: ExtensionContext) => paused(ctx)
    || (!pi.getActiveTools().includes("nimble_read") ? "nimble_read inactive"
      : nativeCheckpoint(ctx.sessionManager.getBranch()) ? "Codex checkpoint owns provider context"
      : !ctx.model ? "No model selected" : undefined);
  const scoringActivity = (ctx: ExtensionContext) => {
    const reason = pauseReason(ctx);
    return reason ? `paused · ${reason}` : controller ? "checking…" : warned ? `paused · ${lastStatus}` : "ready";
  };
  const updateStatus = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    const saved = cumulativeClearedTokens(ctx.sessionManager.getEntries());
    const savings = `S1 saved ${saved ? `~${compactTokens(saved)}` : "0"} tokens`;
    const reason = pauseReason(ctx);
    ctx.ui.setStatus("pi-s1-compact", `${savings}${reason ? ` · paused · ${reason}`
      : controller ? " · checking…" : warned ? " · scoring paused · error" : settings?.automatic ? "" : " · automatic off"}`);
  };
  const reset = () => {
    epoch++;
    settingsController?.abort();
    settingsController = undefined;
    controller?.abort();
    controller = undefined;
    lastAttemptTokens = -Infinity;
    lastStatus = "No evaluation yet";
    warned = false;
  };
  pi.on("session_start", async (_event, ctx) => {
    reset();
    sessionGeneration++;
    const loadGeneration = ++settingsGeneration;
    settingsBusy = true;
    settings = undefined; settingsError = "Settings loading; scoring paused";
    try {
      // A completed global save must precede reloading this session's effective settings.
      await pendingSave?.catch(() => {});
      if (settingsGeneration !== loadGeneration) return;
      const loaded = await store.load() ?? defaultSettings(config);
      if (settingsGeneration !== loadGeneration) return;
      settings = loaded; settingsError = "";
    } catch (error) {
      if (settingsGeneration !== loadGeneration) return;
      settings = undefined; settingsError = error instanceof Error ? error.message : "Invalid settings; scoring paused";
    } finally {
      if (settingsGeneration === loadGeneration) settingsBusy = false;
    }
    if (settingsGeneration === loadGeneration) updateStatus(ctx);
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    reset();
    sessionGeneration++; settingsGeneration++; settingsBusy = true;
    // Pi awaits shutdown before replacing the runtime. Do not let an abandoned write
    // race the replacement runtime's load or a subsequent settings edit.
    await pendingSave?.catch(() => {});
    if (ctx.hasUI) ctx.ui.setStatus("pi-s1-compact", undefined);
  });
  const invalidate = (_event: unknown, ctx: ExtensionContext) => { reset(); updateStatus(ctx); };
  pi.on("session_tree", invalidate);
  pi.on("session_before_compact", invalidate);
  pi.on("session_compact", invalidate);
  pi.on("model_select", invalidate);

  const startEvaluation = (ctx: ExtensionContext, manual = false): Promise<void> | undefined => {
    if (paused(ctx) || controller || warned || !ctx.model || !pi.getActiveTools().includes("nimble_read")
      || (!manual && !settings?.automatic)) return;
    const scoringSettings = settings!;
    const classifier = resolveClassifier(ctx.modelRegistry, scoringSettings);
    const branch = ctx.sessionManager.getBranch();
    if (nativeCheckpoint(branch)) return;
    const messages = buildSessionContext(branch).messages;
    const refs = ledger(branch), truncatedRefs = truncationLedger(branch);
    const rawTokens = messages.reduce((sum, m) => sum + estimateTokens(m), 0);
    const projectedTokens = applyPruning(messages, refs, truncatedRefs).reduce((sum, m) => sum + estimateTokens(m), 0);
    const usageTokens = ctx.getContextUsage()?.tokens ?? 0;
    if (!manual && Math.max(projectedTokens, usageTokens) < triggerTokens(config, ctx.model.contextWindow)) return;
    if (!manual && rawTokens >= lastAttemptTokens && rawTokens - lastAttemptTokens < GROWTH_TOKENS) return;
    lastAttemptTokens = rawTokens;
    const choices = candidates(messages, refs, config.keepRecentTokens);
    if (!choices.length) { lastStatus = "No old eligible outputs"; return; }
    const automatic = superseded(messages, choices, refs);
    const uncertain = choices.filter(item => !automatic.has(item.ref));
    const ownController = new AbortController();
    const evaluationSignal = AbortSignal.any([ownController.signal, AbortSignal.timeout(Math.floor(config.timeoutMs))]);
    controller = ownController;
    const ownEpoch = epoch, snapshotLeaf = ctx.sessionManager.getLeafId();
    updateStatus(ctx);
    return (async () => {
      try {
        // Authentication and destination consent gate deterministic pruning as well as classifier calls.
        await authenticateClassifier(ctx.modelRegistry, classifier, scoringSettings.classifier, evaluationSignal);
        if (ownController.signal.aborted || epoch !== ownEpoch || settings !== scoringSettings || paused(ctx)) return;
        const result = uncertain.length
          ? await scoreClassifier(ctx.modelRegistry, classifier, applyPruning(messages, refs, truncatedRefs), uncertain, config, evaluationSignal, options.fetch, scoringSettings.classifier)
          : { refs: [] as string[], keptRefs: [] as string[], evaluated: 0, inputTokens: null };
        if (ownController.signal.aborted || epoch !== ownEpoch || settings !== scoringSettings || paused(ctx)
          || !pi.getActiveTools().includes("nimble_read") || nativeCheckpoint(ctx.sessionManager.getBranch())) return;
        // Credentials/provider availability may change while inference is running.
        await authenticateClassifier(ctx.modelRegistry, classifier, scoringSettings.classifier, evaluationSignal);
        if (ownController.signal.aborted || epoch !== ownEpoch || settings !== scoringSettings || paused(ctx)
          || !pi.getActiveTools().includes("nimble_read") || nativeCheckpoint(ctx.sessionManager.getBranch())) return;
        const currentBranch = ctx.sessionManager.getBranch();
        const snapshotIndex = snapshotLeaf ? currentBranch.findIndex(entry => entry.id === snapshotLeaf) : -1;
        if (snapshotLeaf && snapshotIndex < 0) return;
        if (currentBranch.slice(snapshotIndex + 1).some(entry => entry.type === "message" && entry.message.role === "user")) {
          lastAttemptTokens = -Infinity; return;
        }
        const currentRefs = ledger(currentBranch), currentTruncated = truncationLedger(currentBranch);
        const currentMessages = buildSessionContext(currentBranch).messages;
        const eligible = new Set(candidates(currentMessages, currentRefs, config.keepRecentTokens).map(item => item.ref));
        const accepted = choices.filter(item => eligible.has(item.ref) && (result.refs.includes(item.ref)
          || (automatic.has(item.ref) && superseded(currentMessages, [item], currentRefs).has(item.ref))));
        const toTruncate = config.truncateMinChars > 0 ? choices.filter(item => eligible.has(item.ref)
          && result.keptRefs.includes(item.ref) && !currentTruncated.has(item.ref)
          && textOf(item.result).length > config.truncateMinChars) : [];
        const { cleared, truncated, saved } = affordableReductions(currentMessages, currentRefs, currentTruncated, accepted, toTruncate, config.maxPaybackTurns);
        const deferred = accepted.length + toTruncate.length - cleared.length - truncated.length;
        if (cleared.length || truncated.length) {
          const entry = { version: 1, refs: cleared.map(item => item.ref), truncatedRefs: truncated.map(item => item.ref),
            model: `${classifier.provider}/${classifier.id}`, evaluated: result.evaluated, estimatedTokensCleared: saved, inputTokens: result.inputTokens };
          const commitLeaf = ctx.sessionManager.getLeafId();
          try { pi.appendEntry(ENTRY_TYPE, entry); }
          catch (error) { entry.refs = []; entry.truncatedRefs = []; restoreLeaf(ctx.sessionManager, commitLeaf); throw error; }
        }
        const coverage = `${result.evaluated} outputs classified; ${automatic.size} deterministic supersessions considered`;
        lastStatus = cleared.length || truncated.length
          ? `${cleared.length} outputs cleared; ${truncated.length} shortened; ~${saved.toLocaleString()} estimated tokens removed (${coverage})`
          : `No additional changes (${coverage})`;
        if (deferred) lastStatus += `; ${deferred} reductions deferred to preserve prompt-cache efficiency`;
        warned = false;
      } catch (error) {
        if (epoch !== ownEpoch || ownController.signal.aborted) return;
        lastStatus = error instanceof Error ? error.message : "Classifier unavailable; no fallback";
        if (error instanceof RequestBudgetError) {
          // No evidence-scoring request or reductions occurred. Growth/cooldown still
          // gates automatic attempts; a size skip is not a provider failure.
          warned = false;
          return;
        }
        if (!manual && !warned) notify(ctx, `${lastStatus}. Scoring paused; context unchanged; normal compaction remains available.`, true);
        warned = true;
      } finally {
        if (controller === ownController) controller = undefined;
        if (epoch === ownEpoch) updateStatus(ctx);
      }
    })();
  };
  pi.on("context", (event, ctx) => {
    updateStatus(ctx);
    if (activationConflict(pi)) { reset(); return; }
    if (!pi.getActiveTools().includes("nimble_read") || nativeCheckpoint(ctx.sessionManager.getBranch())) return;
    const branch = ctx.sessionManager.getBranch();
    const projected = applyPruning(event.messages, ledger(branch), truncationLedger(branch));
    void startEvaluation(ctx);
    return { messages: projected };
  });
  pi.on("turn_end", (_event, ctx) => { updateStatus(ctx); void startEvaluation(ctx); });

  const compactCommand: Parameters<ExtensionAPI["registerCommand"]>[1] = {
    description: "Prune old tool outputs now using the saved classifier",
    handler: async (args, ctx) => {
      if (args.trim()) { notify(ctx, "Usage: /s1-compact", true); return; }
      await ctx.waitForIdle();
      const reason = paused(ctx);
      if (reason) { notify(ctx, reason, true); return; }
      if (!ctx.model) { notify(ctx, "No model selected", true); return; }
      if (!pi.getActiveTools().includes("nimble_read")) { notify(ctx, "Paused: nimble_read must be active", true); return; }
      if (nativeCheckpoint(ctx.sessionManager.getBranch())) { notify(ctx, "Paused: Codex checkpoint owns provider context", true); return; }
      if (controller) { notify(ctx, "An evaluation is already running", true); return; }
      warned = false;
      const ownEpoch = epoch;
      await startEvaluation(ctx, true);
      if (epoch !== ownEpoch) { notify(ctx, "Evaluation cancelled by a session, settings, or compaction change"); return; }
      notify(ctx, `${lastStatus}${warned ? ". Scoring paused; context unchanged; normal compaction remains available." : ""}`, warned);
      updateStatus(ctx);
    },
  };
  pi.registerCommand("s1-compact", compactCommand);
  pi.registerTool({
    name: "nimble_read", label: "Read original output",
    description: "Retrieve original tool output cleared or truncated by pi-s1-compact or pi-nimble from this session's active branch. Use the ref in its marker. Read original evidence rather than rerunning commands. offset and limit are character counts; maximum page 16000 characters.",
    parameters: Type.Object({ ref: Type.String({ pattern: "^[a-f0-9]{24}$" }),
      offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16_000 })) }),
    async execute(_id, args, _signal, _update, ctx) {
      const result = original(ctx.sessionManager.getBranch(), args.ref);
      if (!result) throw new Error("Original output is not on this session branch");
      const text = textOf(result), offset = args.offset ?? 0, limit = args.limit ?? 8000;
      if (offset > text.length) throw new Error(`Offset exceeds output length (${text.length})`);
      const end = Math.min(text.length, offset + limit);
      return { content: [{ type: "text", text: `[Original ${result.toolName} output; characters ${offset}–${end} of ${text.length}]\n${text.slice(offset, end)}` }],
        details: { ref: args.ref, offset, nextOffset: end < text.length ? end : null, totalCharacters: text.length } };
    },
  });
  const resetCommand: Parameters<ExtensionAPI["registerCommand"]>[1] = {
    description: "Release existing cleared and shortened outputs on the active branch",
    handler: async (_args, ctx) => {
      const conflict = activationConflict(pi);
      if (conflict) { notify(ctx, conflict, true); return; }
      const branch = ctx.sessionManager.getBranch(), shortened = truncationLedger(branch).size;
      const released = ledger(branch).size + shortened;
      reset();
      if (!released) { lastStatus = "No cleared or truncated outputs to release"; updateStatus(ctx); notify(ctx, lastStatus); return; }
      const entry = { version: 1, refs: [] as string[], reset: true }, leaf = ctx.sessionManager.getLeafId();
      try { pi.appendEntry(ENTRY_TYPE, entry); }
      catch { entry.reset = false; restoreLeaf(ctx.sessionManager, leaf); lastStatus = "Could not persist mask reset";
        warned = true; updateStatus(ctx); notify(ctx, `${lastStatus}; existing masks remain active.`, true); return; }
      lastStatus = `${released} ${shortened ? "cleared/truncated" : "cleared"} outputs released on this branch`;
      updateStatus(ctx); notify(ctx, lastStatus);
    },
  };
  pi.registerCommand("s1-compact-reset", resetCommand);
  const statusCommand: Parameters<ExtensionAPI["registerCommand"]>[1] = {
    description: "Show saved classifier, automatic pruning configuration, and activity",
    handler: async (_args, ctx) => {
      const snapshot = settings, statusEpoch = epoch;
      if (!pauseReason(ctx) && snapshot) {
        try {
          await authenticateClassifier(ctx.modelRegistry, resolveClassifier(ctx.modelRegistry, snapshot), snapshot.classifier,
            AbortSignal.timeout(Math.floor(config.timeoutMs)));
          if (settings !== snapshot || epoch !== statusEpoch) return;
        } catch (error) {
          if (settings !== snapshot || epoch !== statusEpoch) return;
          reset();
          lastStatus = error instanceof Error ? error.message : "Selected classifier authentication unavailable";
          warned = true;
          updateStatus(ctx);
        }
      }
      notify(ctx, [
        `Automatic pruning: ${settings?.automatic ? "on" : "off"}; trigger ${compactTokens(ctx.model ? triggerTokens(config, ctx.model.contextWindow) : config.triggerTokens)} tokens`,
        `Classifier: ${settings ? `${settings.classifier.provider}/${settings.classifier.id}` : "not configured"}`,
        `Destination: ${settings?.classifier.destination || "unknown"}`,
        `Scoring: ${scoringActivity(ctx)}`,
        `Active on this branch: ${truncationLedger(ctx.sessionManager.getBranch()).size} outputs shortened; ${ledger(ctx.sessionManager.getBranch()).size} cleared`,
        config.truncateMinChars > 0 ? `Retained outputs over ${config.truncateMinChars.toLocaleString()} characters may be truncated to 600 characters plus retrieval marker` : "New retained-output truncation disabled",
        `Session total: ~${compactTokens(cumulativeClearedTokens(ctx.sessionManager.getEntries()))} estimated tokens removed (not billing savings)`,
        `Latest activity: ${lastStatus}`,
      ].join("\n"));
    },
  };
  pi.registerCommand("s1-compact-status", statusCommand);
  const settingsCommand: Parameters<ExtensionAPI["registerCommand"]>[1] = {
    description: "Choose and persist a classifier and toggle automatic pruning",
    handler: async (args, ctx) => {
      if (args.trim()) { notify(ctx, "Usage: /s1-compact-settings", true); return; }
      if (!ctx.hasUI) { notify(ctx, "Settings require an interactive or RPC UI", true); return; }
      if (settingsBusy) { notify(ctx, "Settings are already being edited", true); return; }
      settingsBusy = true;
      reset(); // Invalidate immediately; even failed writes or cancelled dialogs cannot commit old scoring.
      const editEpoch = epoch, editSession = sessionGeneration, editGeneration = ++settingsGeneration;
      const editController = new AbortController();
      settingsController = editController;
      const discoverySignal = AbortSignal.any([editController.signal, AbortSignal.timeout(Math.floor(config.timeoutMs))]);
      try {
        await abortable(ctx.modelRegistry.refresh({ signal: discoverySignal }), discoverySignal);
        const available = await abortable(ctx.modelRegistry.getAvailableOfType("classifier", undefined, { signal: discoverySignal }), discoverySignal);
        if (!available.length) { notify(ctx, "No available classifiers. Configure models/authentication in Pi first.", true); return; }
        const selections = await Promise.allSettled(available.map(m => {
          const signal = AbortSignal.any([editController.signal, AbortSignal.timeout(Math.floor(config.timeoutMs))]);
          return selectionWithAuth(ctx.modelRegistry, m, signal);
        }));
        editController.signal.throwIfAborted();
        const labels = available.map((m, index) => {
          const resolved = selections[index]!;
          return `${m.provider}/${m.id} · ${resolved.status === "fulfilled"
            ? destinationLabel({ ...m, baseUrl: resolved.value.destination }) : "destination unavailable (cannot save)"}`;
        });
        const label = await ctx.ui.select("S1 Compact · classifier", labels);
        if (label === undefined) return;
        const model = available[labels.indexOf(label)];
        if (!model) throw new Error("Invalid classifier selection");
        const resolved = selections[labels.indexOf(label)]!;
        if (resolved.status !== "fulfilled") throw new Error("Selected classifier destination unavailable; check Pi provider configuration");
        const classifier = resolved.value;
        const automatic = await ctx.ui.select("Automatic pruning", ["On", "Off"]);
        if (automatic === undefined) return;
        if (!(await ctx.ui.confirm("Save S1 Compact settings?",
          `${classifier.provider}/${classifier.id}\n${destinationLabel({ ...model, baseUrl: classifier.destination })}\nAPI: ${classifier.api}\nAutomatic pruning: ${automatic}\nSelected evidence is sent to this destination. Hosted calls may incur charges. No fallback.`))) return;
        editController.signal.throwIfAborted();
        if (epoch !== editEpoch) throw new Error("Session changed while editing settings; retry");
        // Resolve current metadata again after dialog, before persisting consent.
        resolveClassifier(ctx.modelRegistry, { version: 1, classifier, automatic: automatic === "On" });
        const next: Settings = { version: 1, classifier, automatic: automatic === "On" };
        const saving = store.save(next);
        pendingSave = saving;
        try { await saving; }
        finally { if (pendingSave === saving) pendingSave = undefined; }
        if (sessionGeneration !== editSession || settingsGeneration !== editGeneration) return;
        // Coding-model changes invalidate scoring, not this confirmed global settings write.
        settings = next; settingsError = "";
        notify(ctx, "Settings saved. Existing reductions remain retrievable.");
      } catch (error) {
        if (sessionGeneration === editSession && settingsGeneration === editGeneration) {
          notify(ctx, error instanceof Error ? error.message : "Could not save settings", true);
        }
      }
      finally {
        if (settingsController === editController) settingsController = undefined;
        if (settingsGeneration === editGeneration) settingsBusy = false;
        if (sessionGeneration === editSession && settingsGeneration === editGeneration) updateStatus(ctx);
      }
    },
  };
  pi.registerCommand("s1-compact-settings", settingsCommand);
}
export default function s1Compact(pi: ExtensionAPI): void { registerS1(pi); }
