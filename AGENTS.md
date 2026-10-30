# Working agreement

## Context and ownership

Pi System One Compact (`pi-s1-compact`) is a general-purpose Pi compaction extension, similar to pi-nimble-compact. SirDarcanos confirms product intent, permission changes, and consequential commitments. The approved handoff builds a separate local successor using Pi's classifier registry, retaining local Ollama Nimble by default and predecessor session/tool/environment compatibility. Expose only `/s1-compact*` user commands; predecessor `/nimble-*` command aliases are excluded. Keep `nimble_read` and historical evidence/session support so existing retrieval markers remain usable. The predecessor repository is read-only; publishing, migration announcements, and deprecation are excluded. Maintenance resources and unconfirmed operating constraints remain unknown.

Read this agreement before project work. Maintain confirmed policy here and update affected documentation during authorized changes. The TypeScript extension targets Pi >=1.0.0 <2 and Node >=22.19. Use pnpm (not npm): `pnpm install --ignore-scripts`, `pnpm typecheck`, `pnpm test`, `pnpm test:engine`, `pnpm check`, or `pnpm check:compatibility` (isolated Pi 1.0.0/1.4.0 installs); package.json is authoritative. Local dependency installation was approved for this build. No CI or publishing automation is configured. Tests are offline; live classifier quality, service startup, and hosted spending require their own authority.

## Scope and safety

The user selects workflow stages; agents choose routine engineering methods and checks within the request. Inspection, planning, implementation, safe local checks, bounded delegation through the configured runtime, independent review, and lead-owned repairs are allowed by default within that scope. Ask about unresolved intent, scope, risk, cost, or permission—not routine test seams or worker allocation.

Preserve unrelated work, index state, file modes, links, and history. Never commit credentials, personal profiles, local runtime artifacts, or unnecessary private data. New sensitive disclosure, spending, installation/downloads, credential changes, destructive actions, deployment, merge, and release require explicit approval. Unknown permission remains ungranted.

Configured spec/ticket requests select scoped publication without a second approval of unchanged commitments; draft/local/review-only requests override publication. New commitments, assignment/relationship mutations outside the requested scope, and other consequential effects need exact authority. Publication does not establish readiness.

Ordinary delivery ends with verified/partial/blocked results before PR preparation or publication. Offer the next stage without invoking it. Explicit compound requests may select multiple stages; later PR work reuses current evidence. Branch/commit/push authority does not authorize PR publication, merge, or release. A standalone review stays read-only unless repair is requested.

## Git and review

The setup bootstrap commit/push is the one agreed exception to the subsequent branch-to-PR flow. Work on short-lived branches targeting `main`; direct updates to `main` are to be blocked with no bypasses, no required approval count, and no required status checks until separately configured. Merged branches are to be deleted automatically. Treat remote enforcement as unverified until settings read-back confirms it; report unavailable controls rather than claiming enforcement.

Use risk-appropriate checks for distinct failure modes; no blanket test-first requirement or test quota. Material missing/failed checks and unresolved material findings block acceptance. Obtain applicable independent standards/specification review during delivery. Reviewers are read-only, separate from authors and each other's conclusions, and return separately inspectable findings; they cannot repair their findings or delegate recursively.

The lead owns integration, findings, and acceptance recommendations. Inspect findings, repair valid in-scope defects, rerun affected checks, and renew affected review after significant changes. Allow at most two automatic repair cycles per acceptance checkpoint, preserving finding lineage and spent cycles across methods, workers, and resume. Defer nonessential suggestions explicitly with reasons; return scope/product changes to the user. Bound each worker assignment by scope and finite runtime/turn limits before launch. The lead chooses concurrency from ownership, eligibility, and actual resources.

## Conditional guidance

- Before tracker publication, labels, or scheduling, read [tracker guidance](docs/agents/issue-tracker.md).
- Before auxiliary model proposals/calls or service lifecycle actions, read [model policy](docs/agents/model-use.md). Ordinary implementer/reviewer agents are distinct from auxiliary assessments.
- Before history/release-impact work, read the version policy below and [CHANGELOG.md](CHANGELOG.md).
- Discover needed companion skills through the runtime; read complete entries and relevant references, verify source identity and semantic compatibility, recover truncated reads, and resolve relative links from their containing document. Missing/incompatible capabilities block their dependent route, without installation or silent substitution.
- No domain glossary or ADR is established yet. Confirm domain meanings through the domain-modeling companion when needed; ADR creation/supersession needs explicit agreement, preserving rationale and history.

## Versions and history

Use one repository-wide Semantic Versioning release unit. Before 1.0, breaking changes increment minor; compatible additions and fixes increment patch. At/after 1.0, incompatible public changes increment major, compatible functionality minor, and compatible fixes patch. Choose impact from delivered behavior, not merely issue type. package.json owns package metadata but intentionally has no release version and is private during local successor work. No release automation is configured; version assignment still needs approval.

Maintain [CHANGELOG.md](CHANGELOG.md) manually with Keep a Changelog-style categories and notable user-facing changes under Unreleased. Non-user-facing work may omit an entry with a reason. Preserve released history; release preparation evaluates aggregate impact and the pre-1.0 exception. SirDarcanos must explicitly approve version bumps, tags, GitHub releases, package publishing, and deployment; labels never grant that authority.

## Evidence and continuation

Report actual checks and documentation impact, separating static inspection, agent walkthroughs, and live verification. Conversation evidence is sufficient within a session; durable handoffs, tickets, draft PRs, and run reports are user-selected, not mandatory. Active ownership, uncertain effects, and spent repair/model allowances must survive interruptions; unavailable history cannot reset them.

Existing legacy skills may still require ticket-first diagnosis or delivery-to-PR endpoints. Those routes are not silently equivalent to this agreement: report an incompatibility when they would force an unselected stage. Do not auto-publish artifacts or modify installed skills to reconcile it.
