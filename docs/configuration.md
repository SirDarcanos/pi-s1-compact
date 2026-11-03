# Configuration reference

Use `/s1-compact-settings` to select a classifier, toggle automatic pruning, and confirm the destination before saving. The selection is independent of your coding model; no command accepts a per-request classifier. Settings dialogs require an interactive or compatible RPC UI. Registry refresh, classifier enumeration, and destination authentication have deadlines and can be cancelled.

The picker uses Pi's available classifier registry (configured authentication, not proof of server/model reachability). It shows provider/model and endpoint. Loopback hosts are labeled local; other endpoints are labeled remote/hosted, not assigned a guessed geographic location. Local proxies can forward remotely: review your provider configuration. The confirmation resolves Pi's authentication destination metadata, so it shows the effective endpoint rather than only catalog metadata. Saving confirms evidence disclosure to that destination; hosted calls can incur charges.

## Saved settings

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

## Local Nimble registry exposure

The extension registers the narrowly scoped provider `s1-compact-ollama`, model `nimble`, with an Ollama adapter behind Pi's classifier registry at `http://127.0.0.1:11434/v1`. The adapter maps public boolean questions to the `noul` wire format used by Ollama's `/v1/systemone` and preserves strict raw-response model/schema validation before normalization. This avoids Pi's extension-loader limitation on API subpath imports. A dummy `ollama` key makes the keyless local provider available. Other classifiers use Pi's existing models and authentication; codemode is not required.

The default local provider and second registry transport have offline wire-contract tests. Those prove integration behavior, **not live model availability, calibration, or pruning quality**. No hosted inference is needed for the test suite.

## Environment configuration and precedence

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

See [safety and classifier policy](safety.md) for evidence handling and transport restrictions, or return to the [README](../README.md).
