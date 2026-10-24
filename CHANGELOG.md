# Changelog

Record notable user-facing changes here under Unreleased as they are implemented.
Use Keep a Changelog-style categories and the version policy in [AGENTS.md](AGENTS.md#versions-and-history).
No releases have been published.

## Unreleased

### Added

- Separate Pi System One Compact extension with saved classifier selection, automatic-pruning controls, status, and reset commands.
- Pi 1.0.0+ classifier registry integration with local Ollama Nimble defaults and destination confirmation before saving.
- Historical Nimble session/retrieval compatibility, command aliases, and fail-closed standby when another legacy pruner is loaded.

### Security

- Bind classifier requests to confirmed authenticated endpoints and API paths, including same-host tenant changes.
