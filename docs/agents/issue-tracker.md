# Issue tracker

## Destination and authority

Use GitHub Issues at `SirDarcanos/pi-s1-compact`. Read this before publication, triage, or scheduling; [AGENTS.md](../../AGENTS.md) owns stage/publication and release authority. No backlog, assignments, or relationships are created by setup. Maintain actual mappings here when approved vocabulary changes; preserve unrelated labels and historical titles.

Use descriptive titles without mandatory prefixes. Identify roles from purpose and actual metadata, not title guesses.

## Labels

| Label | Role |
| --- | --- |
| `spec` | Product specification and acceptance criteria |
| `implementation-step` | Bounded design, implementation, or validation ticket |
| `needs-triage` | Scope, routing, or relevance needs examination |
| `needs-info` | Consequential answer or evidence is missing |
| `ready-for-agent` | Actionable criteria/decisions; native blockers still gate execution |
| `ready-for-human` | Human decision or capability needed |
| `wontfix` | Explicitly declined work, with rationale |
| `bug`, `enhancement`, `documentation` | Compatible work-type classifications |
| `duplicate`, `invalid`, `question` | Triage classification |
| `good-first-issue` | Suitable introductory contribution |
| `patch` | Backward-compatible fix |
| `minor` | Backward-compatible functionality |
| `major` | Incompatible public API/behavior change |

`help wanted` is intentionally removed. Release-impact labels apply to delivered PRs, one resolved highest impact per classified PR for this single release unit; non-release work may have none. There is no release-label automation. Labels describe impact, not permission to publish; apply the pre-1.0 bump exception in [the version policy](../../AGENTS.md#versions-and-history).

## Publication, readiness, and completion

Spec creation must apply `spec` and read back its presence. Bounded spec work tickets use `implementation-step`, also read back. These roles are mutually exclusive; do not copy parent readiness/release labels or classify delivery PRs as implementation-step issues. Standalone work need not acquire a speculative hierarchy.

Evaluate readiness separately from publication. A ready parent spec enables coordination of eligible children, not duplicate implementation. A child can be actionable but blocked. Reassess after decisions and merges using actual completion evidence and exact assignment authority; issue closure or a ready label is not proof of implemented/integrated work.

## Native relationships

Discover the installed setup-project package through runtime metadata and read its complete native-tracker library before graph operations. Missing/incompatible native capability blocks that route; no silent text-only replacement or helper installation.

Use native **sub-issues** for parent/spec membership and native **blocked-by/blocking** for execution dependencies. Prose, checklists, labels, and mentions supplement but never replace actual native writes.

Before an unfamiliar operation, read GitHub's live dependency/sub-issue API documentation. Resolve database IDs, inspect existing edges with pagination, preserve unrelated/cross-repository identities, and check hierarchy and blocker cycles separately. Write only approved missing relationships. Conflicting parentage needs approval; do not replace it by default.

Read back intended database IDs in both relationship directions, including all pages. Ambiguous absence/404, missing edges, or unavailable APIs block dependent scheduling. Inspect actual state before retrying partial failures; do not infer graph authority from publication or labels.
