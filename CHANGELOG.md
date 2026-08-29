# Changelog

All notable public changes to Conduit will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this
project follows [Semantic Versioning](https://semver.org/).

Development notes from before the fresh public repository are preserved in the
[pre-public changelog](./docs/history/pre-public-changelog.md). They are
historical context, not public releases or public repository history.

## [Unreleased]

### Fixed

- Scoped the bounded-rework cap to each gate instead of the whole card
  ([#1](https://github.com/theaiteam-dev/conduit/issues/1)). `rework_cap` is
  declared per gate, but it was compared against `cards.rework_count` — a single
  lifetime counter incremented on every rework anywhere in the flow — so reworks
  spent at an early gate silently consumed every later gate's budget. A gate
  declaring `rework_cap: 3` could behave as 2, 1, or 0 depending on unrelated
  upstream history, and under the default `cap_policy: scrap` a gate whose budget
  was already spent upstream scrapped the card on its first rejection, destroying
  work that never received the rework cycles the flow promised it. Each gate now
  gets its full declared budget, on both the synchronous and the pooled
  (`--concurrency` greater than 1) paths. `cards.rework_count` is unchanged and
  remains the card's lifetime total.

## [1.0.0] - 2026-08-27

### Added

- Released the deterministic Conduit kernel with explicit station transitions,
  quality gates, bounded rework, terminal outcomes, and durable journal state.
- Added deterministic, transformation, and harness-delegated stations with
  typed inputs and outputs, provider-independent OpenAI-compatible model calls,
  and per-call usage attribution.
- Added binding-stamped checkpoints, crash-safe resume, an idempotent outbox for
  side effects, and shared-database isolation across concurrent runs.
- Added deterministic fan-out/fan-in, bounded worker concurrency, ingress
  listeners, and durable Slack human-in-the-loop decisions.
- Added a non-root, multi-architecture Docker distribution for Linux amd64 and
  arm64, published at `ghcr.io/theaiteam-dev/conduit-engine`.
- Prepared the fresh open-source repository, community policies, public
  documentation, and repository metadata for the initial public release.
- Added a locally verified, model-free README quickstart and a decision guide
  comparing Conduit with Temporal, n8n, and LangGraph.

[Unreleased]: https://github.com/theaiteam-dev/conduit/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/theaiteam-dev/conduit/releases/tag/v1.0.0
