# Auxiliary assessment policy

## Authority and scope

Approved by SirDarcanos in the setup conversation: automatic local use with the bounds below; Jev requires explicit approval each time. This policy lasts until explicitly changed by the owner. It governs optional bounded classifications, routing, evidence-support checks, and rubric judgments—not implementation agents or independent reviewers. Results are advisory; deterministic checks and engineering verification remain ordinary agent work.

## Allowed automatic routes

| Skill | Exact Ollama model | Endpoint |
| --- | --- | --- |
| `ask-clef` | `clef` | `http://127.0.0.1:11434/v1/systemone` |
| `ask-clef-flash` | `clef-flash` | `http://127.0.0.1:11434/v1/systemone` |
| `ask-nimble` | `nimble` | `http://127.0.0.1:11434/v1/systemone` |
| `ask-pplx` | `pplx-decider` | `http://127.0.0.1:11434/v1/systemone` |

Permission covers these exact local tags, not other models, recipients, or hosted variants. Record the installed model digest during authorized discovery. Availability is unknown; setup performed no model calls or service probes.

Send only minimal sanitized task-relevant code, requirements, and evidence excerpts. Exclude secrets, credentials, personal data, unrelated files, unnecessary private paths, and sensitive/private material not authorized for disclosure. Retain no payload/response files; summarize usage and conclusions in the conversation. No paid service use is authorized for automatic assessments.

## Shared limits and accounting

Per user-requested work item, all four routes and all delegated workers share at most **8 attempted requests**, including failed/unknown-outcome attempts and corrections. Each assessment allows at most one evidence-corrected request; no automatic transport or malformed-response retries. At most four questions per request under the packages' bounds. Apply stricter package/runtime limits. No dependent decision loops or resets from model changes, delegation, new sessions, or resume.

The lead owns the root conversation ledger: approval source, work-item scope, attempted/spent requests, exclusive reservations, corrections, and uncertain operations. Reserve before dispatch; workers request allocations and reconcile use. Release only confirmed unused reservations, not attempted calls. Unknown prior usage blocks further calls until reconciled. The allowance expires when the work item ends; only the user can expand/reset it. Automatic spending allowance is **USD 0**.

## Lifecycle and fallback

Reuse an already-running loopback Ollama service only; leave it untouched. No startup, shutdown, installation, upgrades, downloads, credentials, or alternative service actions are authorized. Ask separately if startup or installation is needed.

When a route is unavailable, denied, exhausted, or insufficiently supported, continue ordinary agent work where sufficient; report material evidence gaps otherwise. Never silently substitute a model or keep retrying for a favorable verdict. A separately chosen allowed route still needs its own bounded purpose and reservation.

## Jev and explicit requests

`ask-jev` sends selected evidence to TypeSafe's hosted Jev service at `https://api.typesafe.ai/v1/systemone` and may incur charges. It has **zero automatic requests, retries, or spend**. Obtain SirDarcanos's explicit approval for each bounded assessment, including exact model/alias, disclosure, verified spending reservation, attempt limits, retention, and fallback before sending. No credentials or hosted probes are authorized merely by this policy.

Explicit named local requests remain subject to these shared limits and package gates. Expanded disclosure, startup, paid use, retained records, or other recipients require separate approval. The lead checks policy fit and reserves allowance; the assessment owner independently rechecks authority, actual payload, transport, and remaining limits immediately before sending. Missing/ambiguous permission means no call.

## Maintenance

The owner approves changes; maintain provenance and spent allowances without permission imported from skill upgrades. Policy publication is not proof of runtime/package enforcement. Read [the working agreement](../../AGENTS.md) for ordinary workflow authority.
