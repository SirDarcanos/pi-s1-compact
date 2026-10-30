# Pi System One Compact

A Pi extension that prunes older tool outputs while keeping the conversation and original evidence. Choose a classifier independently of your coding model, once in settings—not on every request.

**Local successor under development.** This repository does not replace, rename, release, or deprecate `pi-nimble-compact`. Nothing is published by this work.

## Requirements and local development

- Pi **1.0.0 or newer, below 2.0**. Pi 0.99.2 is not supported by this successor.
- Node.js 22.19 or newer; pnpm 11.20.0.
- A classifier configured through Pi, or an already-running local Ollama with Nimble.

```sh
pnpm install --ignore-scripts
pnpm check
pi -e ./extensions/s1-compact.ts
```

Run `pnpm check:compatibility` for isolated Pi 1.0.0 and 1.4.0 installs and full offline checks, without changing your working-tree dependencies. Dependency lifecycle scripts and the opt-in live Ollama test are disabled. The OpenAI Decisions SDK test is skipped on 1.0.0 because that backend is not available there; classifier availability depends on your installed Pi version.

The extension does not install models, start Ollama, edit Pi authentication, or change your coding model. See [Pi classifier documentation](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/docs/models.md#use-classifier-models).

## Commands

| Command | Action |
| --- | --- |
| `/s1-compact` | Prune now with the saved classifier; bypass automatic pressure/cooldown, not safety or cache-payback checks |
| `/s1-compact-settings` | Pick a registry classifier, toggle automatic pruning, and confirm the destination before saving |
| `/s1-compact-status` | Show classifier, destination, configuration, reductions, and latest activity/error |
| `/s1-compact-reset` | Release clearing and shortening masks on the active session branch |

Use the `/s1-compact*` commands above; the predecessor’s `/nimble-*` command aliases are not registered. The `nimble_read` retrieval tool remains available for existing and new evidence markers. No command accepts a per-request classifier. Settings dialogs need an interactive or compatible RPC UI. Registry refresh, availability enumeration, and destination authentication are bounded and cancellable; a stalled provider releases the edit instead of permanently blocking settings.

The picker uses Pi's available classifier registry (configured authentication, not proof of server/model reachability). It shows provider/model and endpoint. Loopback hosts are labeled local; other endpoints are labeled remote/hosted, not assigned a guessed geographic location. Local proxies can forward remotely: review your provider configuration. The confirmation resolves Pi's authentication destination metadata, so it shows the effective endpoint rather than only catalog metadata. Saving confirms evidence disclosure to that destination; hosted calls can incur charges.

## Persistent configuration

Settings live only in **`~/.pi/agent/s1-compact.json`**, not the project or session. Reloading Pi restores them. The file is atomically replaced with mode `0600`; it contains no API keys.

```json
{
  "version": 1,
  "classifier": {
    "provider": "s1-compact-ollama",
    "id": "nimble",
    "destination": "http://127.0.0.1:11434/v1",
    "api": "typesafe-system-one"
  },
  "automatic": true
}
```

When Pi authentication overrides or materializes the base URL (including Workers AI account placeholders), the file also records `classifier.registryDestination` to pin the original catalog URL separately from the confirmed effective `destination`. No authentication secrets are stored. Catalog changes, added/removed auth overrides, and account/destination changes require renewed confirmation, including different tenant paths on the same host.

Use the command rather than hand-editing. Invalid files pause scoring without overwriting the file or selecting a default. Missing models, credentials, endpoint changes, and malformed responses pause scoring with a status error; **there is no fallback**, especially local-to-hosted. Reconfirm changed endpoint/API metadata in settings. A scoring error stops automatic retries; use the manual command or save settings after correcting the cause.

Changing settings immediately aborts/invalidates in-flight scoring. Saving succeeds before the new selection becomes active. Existing reductions and their originals remain available, including when the new classifier is unavailable. Automatic pruning can be disabled while manual pruning and historical retrieval remain available.

### Local Nimble registry exposure

The extension registers the narrowly scoped provider `s1-compact-ollama`, model `nimble`, with an Ollama adapter behind Pi's classifier registry at `http://127.0.0.1:11434/v1`. The adapter maps public boolean questions to the `noul` wire format used by Ollama's `/v1/systemone` and preserves strict raw-response model/schema validation before normalization. This avoids Pi's extension-loader limitation on API subpath imports. A dummy `ollama` key makes the keyless local provider available. Other classifiers use Pi's existing models and authentication; codemode is not required.

The default local provider and second registry transport have offline wire-contract tests. Those prove integration behavior, **not live model availability, calibration, or pruning quality**. No hosted inference is needed for the test suite.

### Environment configuration and precedence

1. A valid persisted classifier/automatic choice wins. No project-level override exists.
2. Without a settings file, the endpoint/model environment selects the bootstrap local Nimble provider; automatic pruning defaults on. Remote bootstrap endpoints require confirmation through the settings UI before scoring.
3. Otherwise, use loopback Ollama Nimble.

Use `PI_S1_COMPACT_*` names for new configuration. Each variable takes precedence over its matching `PI_NIMBLE_*` fallback; `PI_S1_COMPACT_API_KEY` falls back to `NIMBLE_API_KEY`. Fallback applies only when the new variable is unset. An empty or invalid new value is validated/defaulted normally, without consulting the legacy value.

`PI_S1_COMPACT_URL` (default `http://127.0.0.1:11434/v1/systemone`), `PI_S1_COMPACT_MODEL` (default `nimble`), and `PI_S1_COMPACT_API_KEY` configure only the compatibility provider, never another selected provider. The URL must end in `/systemone`; HTTPS or loopback HTTP only, with no embedded credentials, query, or fragment. An empty URL disables that provider; it does not disable an explicitly selected unrelated registry classifier. Pi's normal provider overrides/authentication still apply and a changed destination requires confirmation.

These policy variables apply independently of classifier selection:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_S1_COMPACT_THRESHOLD` | `0.45` | Automatic context-window fraction |
| `PI_S1_COMPACT_TRIGGER_TOKENS` | `120000` | Absolute automatic trigger ceiling |
| `PI_S1_COMPACT_KEEP_RECENT_TOKENS` | `12000` | Protected recent context, expanded to whole parallel batches |
| `PI_S1_COMPACT_MAX_PAYBACK_TURNS` | `20` | Cache-rewrite payback horizon |
| `PI_S1_COMPACT_TIMEOUT_MS` | `30000` | Scoring deadline |
| `PI_S1_COMPACT_TRUNCATE_MIN_CHARS` | `4000` | Shorten explicitly retained long outputs; `0` disables |
| `PI_S1_COMPACT_KEEP_THRESHOLD` | `0.25` | Nimble-profile keep threshold only; not transferred to other models |

Invalid numeric environment values use bounded defaults, as in the predecessor. Environment settings are read when the extension is loaded; after editing shell exports, start Pi from a new terminal (or source the exports before restarting Pi). `/reload` does not refresh the parent shell environment.

The opt-in live test uses `PI_S1_COMPACT_LIVE=1` (`PI_NIMBLE_LIVE` remains a fallback). Offline compatibility checks force both opt-in variables off.

## Safety and compatibility

- Candidate protections, secret screening, strict call/result pairing, recent-output protection, and complete parallel batches remain in the pruning policy.
- Scoring runs asynchronously. Results must still match the session branch, user task, settings generation, eligibility, retrieval availability, and compaction state before commit.
- Reductions must pass the cache-payback gate. Only validly scored retained candidates can be shortened; budget-omitted candidates remain untouched.
- Tool calls, signatures, message order, and persisted original outputs are not deleted. Normal Pi compaction stays enabled; provider-native Codex checkpoints take ownership of provider context.
- Historical `pi-nimble-pruning` v1 records and reference hashes remain readable. Reset appends a branch-local release record; it does not erase originals or alter sibling branches.
- **Keep `nimble_read` in your tool allowlist.** Historical and new markers use it for exact original text retrieval, even after reset. With retrieval inactive, full outputs are sent and new pruning pauses. Do not rerun side-effecting commands to recover evidence.

### Both extensions loaded

The successor inspects foreign `/nimble-*` command registrations and its own `/s1-compact*` command ownership, including source provenance and collision suffixes. If it finds a foreign legacy pruner or ambiguous ownership, it enters standby: no scoring, projection, reset writes, or reduction writes. Read-only status/retrieval remain available where registration permits.

This does not rely on package filenames or a lock the old extension cannot honor. Unload one extension and reload Pi to activate the successor. Pi may suffix colliding command names; use the command list to reach status. The successor never disables or modifies the old extension.

## Classifier-specific policy and evidence

Pruning policy and classifier transport are separate. The recognized local Nimble profile retains its legacy threshold and bounded excerpts; the request also fits within half the registry context window. Other registry models use a smaller context-derived request, at most four questions, and clear only when the probability that unique verbatim evidence is needed is below `0.05`. This conservative threshold is **not calibrated across models** and is not a quality guarantee. All other valid answers retain the output (subject to configured shortening).

Authenticated classifier availability and effective-destination checks gate deterministic supersession as well as classifier scoring, and are rechecked before committing reductions. Provider credentials alone are not enough: for example, ChatGPT OAuth does not authorize OpenAI Decisions classifiers. Preflight also exercises the selected SDK API dispatcher with empty state and a transport that rejects before network I/O, so a misregistered API cannot authorize deterministic pruning. This verifies local adapter wiring—not server reachability or live model quality. Pi may still refresh credentials through its normal authentication flow. In-process native classifiers may answer that small capability question locally. Status reports the submitted classifier count separately from deterministic supersessions; request-budget omissions are not counted as classified. History excerpts (including the task goal) are progressively abridged and candidate batches reduced to fit fixed history, request-token, and byte limits. If even a minimum request cannot fit, that evaluation is skipped without clearing or shortening outputs or pausing future scoring; the normal context-growth gate still prevents immediate automatic retries. These limits are estimates, not a guarantee of server tokenizer or context-window compatibility.

Requests exclude private reasoning, images, tool-result metadata, and protected/secret-bearing candidates. This is defense in depth, not a complete data-loss-prevention system. Hosted selection sends sanitized conversation excerpts and selected output excerpts to the chosen provider. The effective request model is checked before payload dispatch. Supported Pi classifier APIs are restricted to their known request paths (including llama.cpp's native routes); custom APIs are restricted to the confirmed base-path subtree. Redirects, invalid responses, oversized responses, and destination/path changes fail closed; automatic transport retries are disabled. Custom provider implementations must honor Pi's request hooks and supplied fetch transport; extensions run as trusted code, not in a network sandbox.

## License and contribution guidance

[MIT](LICENSE) © 2026 **Nicola Mustone**. Reused code retains predecessor and upstream attribution in [NOTICE.md](NOTICE.md) and [licenses/](licenses/).

Read [AGENTS.md](AGENTS.md) before project work. Record notable implemented changes in [CHANGELOG.md](CHANGELOG.md). This local build has no release version, publishing workflow, or migration announcement.
