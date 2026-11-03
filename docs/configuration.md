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

The extension registers the narrowly scoped provider `s1-compact-ollama`, model `nimble`, with an Ollama adapter behind Pi's classifier registry at `http://127.0.0.1:11434/v1`. The adapter maps public boolean questions to the `noul` wire format used by Ollama's `/v1/systemone` and preserves strict raw-response model/schema validation before normalization. This avoids Pi's extension-loader limitation on API subpath imports. A dummy `ollama` key makes the keyless local provider available. Additional classifiers can use the catalog below or Pi's existing models and authentication; codemode is not required.

The default local provider and second registry transport have offline wire-contract tests. Those prove integration behavior, **not live model availability, calibration, or pruning quality**. No hosted inference is needed for the test suite.

## Configure additional Ollama classifiers

Create **`~/.pi/agent/s1-compact-classifiers.json`** to register compatible classifiers without a TypeScript extension. This user-global catalog is separate from saved selection settings; project-local catalogs are not read. The file is optional and does not change the default Nimble selection.

```json
{
  "version": 1,
  "classifiers": [
    {
      "name": "clef",
      "protocol": "ollama-systemone",
      "model": "clef:latest",
      "endpoint": "http://127.0.0.1:11434/v1/systemone",
      "contextWindow": 8192
    },
    {
      "name": "pplx",
      "protocol": "ollama-systemone",
      "model": "pplx-decider:latest",
      "endpoint": "http://127.0.0.1:11434/v1/systemone",
      "contextWindow": 8192
    }
  ]
}
```

Replace each `model` with the exact installed model ID and set `contextWindow` to its supported token capacity (integer, at least 2000). The IDs above are examples, not model installation commands or claims of live compatibility. `name` must be unique, start with a lowercase letter, and contain only lowercase letters, digits, and hyphens (48 characters maximum). At most 32 entries are accepted; unknown fields are rejected.

Run `/reload`, then `/s1-compact-settings`. Select `s1-compact-config-clef/clef:latest` or the corresponding provider/model, review the effective destination, and save. Providers are registered through Pi's classifier registry as `s1-compact-config-<name>`; existing registry classifiers remain available. These provider IDs are reserved for this catalog: do not register them in a personal extension too. The package contains its own adapter, so npm installations need no imports into a Git checkout or installation internals.

### Supported protocol and capabilities

`ollama-systemone` is the only catalog protocol currently supported. The endpoint must end in `/systemone` and use HTTPS or loopback HTTP, without credentials, query, or fragment. The adapter sends `POST` with `model`, `state`, and `questions`, mapping text boolean questions to `{ "type": "noul", ... }`. Responses must identify the exact configured model and contain one `{ "type": "noul", "noul": 0.0 }` probability per question, between 0 and 1, plus nonnegative integer `usage.input_tokens` and `usage.output_tokens`. The only optional top-level response field is nonnegative integer `prompt_eval_cached_count`; unexpected fields or missing answers are rejected.

Clef and Perplexity Decider can use this path when their Ollama deployment implements that contract. A chat/completions endpoint, arbitrary model API, label-only classifier, or image input is not supported by this adapter. For another protocol, use an appropriate Pi classifier provider rather than changing the protocol label. Offline tests prove transport and selection behavior, not live model availability or pruning quality. Configured classifiers use the conservative non-Nimble request budget and threshold described in [safety](safety.md).

### Credentials and reload errors

Keyless local Ollama needs no extra field. If authentication is required, add `"apiKeyEnv": "MY_CLASSIFIER_KEY"` to that entry and export that environment variable before starting Pi. Put the secret in the environment, not the catalog; literal keys, headers, and shell commands are not accepted catalog fields. The resolved key is passed to Pi's provider registration in memory, not written to S1 Compact settings. Pi's normal authentication overrides still apply, and effective destination changes need renewed confirmation. A missing or empty named variable is an error, not permission to use the dummy local key.

Catalog changes take effect on `/reload` or restart. Shell exports require restarting Pi from the updated environment. Invalid JSON, unsupported protocols/fields, missing credentials, or unreadable catalogs pause all new pruning and block settings edits until the catalog is repaired and reloaded. Existing reductions remain retrievable. Removing a selected entry leaves that saved selection unavailable; it never selects Nimble or another provider in its place.

### Replace a personal registration shim

1. Copy its exact model ID, System One endpoint, and supported context capacity into the catalog. Keep credentials in the environment using `apiKeyEnv` if needed.
2. Remove the personal shim from Pi's extension configuration, then reload. Do not import the adapter from this package's internal files.
3. Select the new `s1-compact-config-<name>` entry in `/s1-compact-settings` and confirm the destination. A saved selection under the old shim's provider ID is not automatically migrated.

Existing independently registered Pi providers remain supported; migration is optional for them. This catalog does not install models, start services, edit Pi authentication, or authorize hosted calls.

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
