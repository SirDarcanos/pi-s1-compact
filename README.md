# Pi System One Compact

Prune older tool outputs from Pi's working context while keeping the original evidence available.

Pi System One Compact uses a classifier to decide which eligible outputs can become retrieval markers or shorter excerpts. Choose that classifier once, independently of your coding model. Local Ollama Nimble is the default. Add compatible Ollama classifiers through a user-global JSON catalog, or choose classifiers already in Pi's registry.

[Installation](#installation) · [Quick start](#quick-start) · [Commands](#commands) · [Configuration](#configuration) · [Troubleshooting](#troubleshooting)

## Installation

Requires **Pi 1.0.0 or newer** and **Node.js 24 or newer**. The package has no Pi upper-version cap; compatibility checks currently cover Pi 1.0.0 and 1.4.0, not unreleased versions.

```sh
pi install npm:pi-s1-compact
```

Restart Pi or run `/reload` to load the extension. The extension does not install models, start Ollama, edit Pi authentication, or change your coding model.

## Quick start

1. Have local Ollama with Nimble already running, add compatible Clef/Perplexity Decider models using the [classifier catalog](https://github.com/SirDarcanos/pi-s1-compact/blob/main/docs/configuration.md#configure-additional-ollama-classifiers), or configure another classifier through [Pi's classifier registry](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/docs/models.md#use-classifier-models).
2. Run `/s1-compact-settings`, choose a classifier, review its destination, and save. This dialog needs an interactive or compatible RPC UI.
3. Leave automatic pruning enabled, or turn it off and use `/s1-compact` manually.
4. Run `/s1-compact-status` to inspect the selection, reductions, and latest activity or error.

Without a settings file, automatic pruning defaults on with local Ollama Nimble at `http://127.0.0.1:11434/v1`. Remote bootstrap endpoints require destination confirmation before scoring.

> [!WARNING]
> A hosted classifier receives sanitized conversation and tool-output excerpts, and calls can incur charges. Review the effective destination before saving. A loopback endpoint may be a proxy that forwards remotely; secret screening is not a complete data-loss-prevention system.

## Commands

| Command | What it does |
| --- | --- |
| `/s1-compact` | Evaluate pruning now with the saved classifier |
| `/s1-compact-settings` | Select a classifier, confirm its destination, and toggle automatic pruning |
| `/s1-compact-status` | Show configuration, reductions, and latest activity or error |
| `/s1-compact-reset` | Release clearing and shortening masks on the active session branch |

Manual pruning bypasses automatic pressure and cooldown checks, **not safety or cache-payback checks**. Reset does not erase originals or change sibling branches.

## How it works

1. **Find eligible older outputs.** Protect recent context in whole parallel batches; exclude errors, protected candidates, and candidates flagged by secret screening.
2. **Assess what to retain.** Later complete reads or successful reruns can supersede earlier evidence; other candidates go to the selected classifier within fixed request budgets. Outputs omitted from scoring stay untouched.
3. **Apply reductions only when still valid.** Results must match the current session, task, and settings, and pass the estimated prompt-cache rewrite payback check. Eligible outputs become retrieval markers; explicitly retained long outputs may be shortened.

Tool calls, signatures, message order, and persisted original outputs are not deleted. Pi's normal compaction remains enabled; native Codex checkpoints retain ownership of provider context.

> [!IMPORTANT]
> `s1_compact_read` is the extension's tool for retrieving original output from the current session. It is normally available automatically; if you restrict tools with a custom allowlist, include it. The legacy `nimble_read` name is a compatibility alias for the same handler. New markers prefer an enabled `s1_compact_read` owned by this extension, or use its compatibility alias. A foreign tool with the same name does not count as retrieval support. Without an enabled, owned retrieval tool, full outputs are sent and new pruning pauses. Retrieval remains available after reset; do not rerun side-effecting commands just to recover evidence.

Classifier thresholds are not calibrated across models, and offline tests do not establish live pruning quality. Read the [safety and classifier policy](https://github.com/SirDarcanos/pi-s1-compact/blob/main/docs/safety.md) for protections, request limits, and transport boundaries.

## Configuration

Settings are user-global in **`~/.pi/agent/s1-compact.json`**, not project-local. The file stores the confirmed classifier and automatic-pruning choice, contains no API keys, and survives reloads. Use `/s1-compact-settings` rather than editing it by hand.

- **Saved choices take precedence.** The saved classifier and automatic-pruning choice win over bootstrap defaults. Endpoint/model variables configure the local compatibility provider; policy variables apply independently.
- **Use `PI_S1_COMPACT_*` variables.** Each falls back to its legacy `PI_NIMBLE_*` name only when unset; the API-key fallback is `NIMBLE_API_KEY`.
- **Errors pause scoring, with no fallback.** Missing credentials, unavailable classifiers, invalid responses, or endpoint changes never silently switch models or destinations. Existing reductions and their originals remain available.
- **Restart after shell changes.** Variables are read when the extension loads; `/reload` does not import new exports from another shell.

See the [configuration reference](https://github.com/SirDarcanos/pi-s1-compact/blob/main/docs/configuration.md) for every variable, default, precedence rule, settings format, and local Nimble adapter details.

### Existing Nimble sessions

This is a separate successor to `pi-nimble-compact`, not a rename or deprecation of that package. Historical `pi-nimble-pruning` v1 records and `nimble_read` markers remain readable through the shared retrieval handler. Use `/s1-compact*`; legacy `/nimble-*` command aliases are not registered.

If both pruners are loaded, or command ownership is ambiguous, the successor enters standby instead of competing for context. Unload one extension and reload Pi. It never disables or modifies the predecessor.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| No outputs are reduced | Inspect `/s1-compact-status`; recent-output protection, request budgets, or the cache-payback gate may leave everything intact |
| Scoring is paused | Correct the reported model, credentials, or endpoint issue; then run the manual command or save settings again |
| Destination changed | Reconfirm it in `/s1-compact-settings`, including tenant-path or authentication overrides |
| Settings UI is unavailable | Use an interactive or compatible RPC UI |
| Extension is in standby | Check for another legacy pruner or conflicting command registration; unload one and reload Pi |

## Development

Use **pnpm 11.20.0**. From a checkout:

```sh
pnpm install --ignore-scripts
pnpm check
pi -e ./extensions/s1-compact.ts
```

`pnpm check` runs typechecking, Node tests, and engine tests offline. `pnpm check:compatibility` performs isolated installs and checks against Pi **1.0.0** and **1.4.0**, without replacing working-tree dependencies. It disables dependency lifecycle scripts and live tests; the OpenAI Decisions SDK test is skipped on Pi 1.0.0 because that backend is unavailable there. Live model checks require separate opt-in and are not evidence supplied by the offline suite.

Development and compatibility installs pin patched `undici` and `minimatch` versions through `pnpm-workspace.yaml`. These overrides do not update a user's separately installed Pi host.

Before changing the project, read [AGENTS.md](https://github.com/SirDarcanos/pi-s1-compact/blob/main/AGENTS.md). The [publishing guide](https://github.com/SirDarcanos/pi-s1-compact/blob/main/docs/publishing.md) covers manual CI staging and separate npm 2FA approval; merging code does not publish a release.
