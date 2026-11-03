# Changelog

Record notable user-facing changes here under Unreleased as they are implemented.
Use Keep a Changelog-style categories and the version policy in [AGENTS.md](https://github.com/SirDarcanos/pi-s1-compact/blob/main/AGENTS.md#versions-and-history).
Version 0.1.0 is published on npm. Changes below Unreleased are not part of that immutable package.

## Unreleased

### Added

- `s1_compact_read` as the primary original-output retrieval tool, with `nimble_read` retained as a shared-handler compatibility alias for historical markers and existing allowlists.

### Changed

- Require Node.js 24 or newer and remove the Pi upper-version cap; the minimum Pi version remains 1.0.0.
- Use S1 Compact branding and the active retrieval tool in new output markers.

### Security

- Verify retrieval-tool ownership before pruning, using the owned alias or retaining full outputs when another extension owns a colliding name.
- Override vulnerable development dependencies with undici 8.12.2 and minimatch 11.0.1, including isolated compatibility installs; installed Pi hosts must be updated separately.

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
