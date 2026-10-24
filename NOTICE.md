# Upstream attribution

This repository contains adapted MIT-licensed source code and tests from both projects below. The original license texts are included verbatim in `licenses/` and are shipped in the package.

## pi-nimble-compact

- Maintainer: Nicola Mustone (SirDarcanos)
- Repository: <https://github.com/SirDarcanos/pi-nimble-compact>
- Reference revision: `db9ec3d805f9d2ae0f29d0c05101efd1c53a9fe4`
- Original notice: Copyright (c) 2026 SirDarcanos
- Original license: [`licenses/pi-nimble-compact-MIT.txt`](licenses/pi-nimble-compact-MIT.txt)

The pruning policy, engine, lifecycle integration, and regression fixtures are adapted from this predecessor. The predecessor remains an independent, unchanged project. The successor adds registry-based classifier transport, persistent user settings, classifier-specific request policy, cancellation on settings/model changes, and provenance-based coexistence checks. The legacy lifecycle under `tests/fixtures/` is an offline activation fixture, not a shipped extension.

## pi-jev-compaction

- Author: [Nour Helmi](https://github.com/nourhelmi)
- Repository: <https://github.com/nourhelmi/pi-jev-compaction>
- Imported revision: `b859945bb88cbcace4dde85192a28838ab0547aa`
- Copyright (c) 2026 Nour Helmi
- Original license: [`licenses/pi-jev-compaction-MIT.txt`](licenses/pi-jev-compaction-MIT.txt)

The predecessor's `extensions/nimble.ts` (adapted here as `extensions/s1-compact.ts`), `src/pruning.ts`, and the Pi lifecycle, SDK, and package tests are copied and adapted from this project. Its automatic clearing lifecycle, safety exclusions, supersession rules, cache-payback gate, branch-local ledger, editor status, and original-output retrieval form the Pi integration.

## fast-jev-compaction

- Original project author/account: [tamaratran](https://github.com/tamaratran)
- Repository: <https://github.com/tamaratran/fast-jev-compaction>
- Imported revision: `e3f262a7f4d42bd8dd32ced30d26176f7cb545b0`
- Original copyright notice: Copyright (c) 2025
- Original license: [`licenses/fast-jev-compaction-MIT.txt`](licenses/fast-jev-compaction-MIT.txt)

`src/engine/` is copied and adapted from this project's complete TypeScript library. `tests/engine.test.ts` is adapted from its library tests. The Pi adapter directly uses its tool-call collection, staged whole-history fitting, and request token estimator. The standalone call/result compaction helpers are retained, but the Pi adapter deliberately does not delete tool calls or recommend rerunning commands to recover output. The Claude Code-specific hook and plugin manifest are not included: this package is a Pi extension.

## Changes in this repository

The adaptation by SirDarcanos replaces Jev transport and configuration with Bespoke Nimble, adds local Ollama decision-API defaults, optional authentication and endpoint selection, reduces request budgets for Nimble's smaller context window, combines the original history fitter with the Pi-safe result-only projection, and adds Nimble integration tests and documentation.

[Bespoke Nimble](https://github.com/bespokelabsai/nimble), by Bespoke Labs, is the external scoring service/model. No Nimble model weights or server code are bundled. Its service and model licenses apply separately from this plugin's MIT license.
