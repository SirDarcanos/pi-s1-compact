# Changelog

Record notable user-facing changes here under Unreleased as they are implemented.
Use Keep a Changelog-style categories and the version policy in [AGENTS.md](https://github.com/SirDarcanos/pi-s1-compact/blob/main/AGENTS.md#versions-and-history).
Version 0.1.0 is prepared for npm publication; registry availability is verified separately.

## Unreleased

## [0.1.0] - 2026-11-03

### Added

- npm package metadata and installation instructions, including the `pi-package` keyword for Pi gallery discovery.
- Manual, main-only CI staging with offline checks, verified package contents, tokenless npm authentication, and separate maintainer approval before publication.
- Separate Pi System One Compact extension with saved classifier selection, automatic-pruning controls, status, and reset commands.
- Pi 1.0.0+ classifier registry integration with local Ollama Nimble defaults and destination confirmation before saving.
- `PI_S1_COMPACT_*` environment configuration names, taking precedence over legacy names while preserving unset-only fallbacks.
- Historical Nimble session/retrieval compatibility and fail-closed standby when another legacy pruner is loaded.

- Bounded classifier request budgets that retain tool outputs when a scoring request cannot fit.
- Classifier requests bound to confirmed authenticated endpoints and API paths, including same-host tenant changes.
