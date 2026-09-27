# Changelog

All notable public changes to Conduit will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this
project follows [Semantic Versioning](https://semver.org/).

Development notes from before the fresh public repository are preserved in the
[pre-public changelog](./docs/history/pre-public-changelog.md). They are
historical context, not public releases or public repository history.

## [Unreleased]

### Added

- One ingress run per external subject
  ([#36](https://github.com/theaiteam-dev/conduit/issues/36)). A webhook
  binding can declare `run_key`, the ordered JSON paths (with alternatives) or
  headers that identify the subject an event is about, such as a repository
  and a pull-request number. Every event with the same key is then a pass of
  one run instead of a run of its own, so the run's cards, journal, and token
  budget hold the subject's history. Keying is fail-closed: an event whose key
  does not resolve is refused (400, `rejected_run_key`). A new kernel
  operation, `conduit run --append-pass`, seeds the next pass
  (`entry-<run>-p<N>`) into a run whose previous pass concluded (every card in
  `done` or `scrap`, none held, including a pass that scrapped) and refuses any
  other run with exit 3 (75 on a lease conflict). The listener launches a
  finished run's next pass directly, folds events that arrive during a pass
  into one trailing pass (`coalesced`) whose substrate lists every event it
  covers under `events` (at most 50 events and 64 KiB, oldest dropped first,
  flagged by `events_truncated`), keeps events for a
  run holding a card for a human the same way, and refuses a run stopped with
  unfinished cards (`run_not_appendable`) or at the binding's optional
  `max_passes` (`pass_limit`), alerting once per run. A pass that ran and
  scrapped is logged `pass_failed` and alerted, and is not re-driven. A pending pass
  is kept in the new `ingress_keyed_runs` table (schema v11) and survives a
  listener restart. The kernel records which events each pass consumed in the
  new `run_pass_events` table, from `conduit run --pass-event`, in the same
  transaction as the pass's entry card; the listener never launches a
  consumed event again (`already_applied`), even after losing a pass's exit.
  `conduit resume` of a run with more than one pass is capped at the run
  token budget earlier invocations left. A webhook binding can also declare `when`, ANDed
  `header`/`json_path` conditions (`in`, `not_in`, `present`); a delivery that
  does not match is acked and logged `filtered` without being accepted. All
  three fields are webhook-only and validated at boot. Keyed substrates carry
  `run_key`, `pass`, `events` and `events_truncated`; bindings without `run_key` behave exactly as before.
  `commitFanOut` now rejects a child id the run already uses
  (`child_id_collision`) and holds the parent, rather than throwing on insert.

- Fan-out children can read their own copy of a declared input
  ([#51](https://github.com/theaiteam-dev/conduit/issues/51)). A transform or
  harness station can now list inputs under `input_scope: { owned_dir: [...] }`,
  and those names resolve from the card's `owned_paths[0]` instead of the
  project root. Before this, `seed.json` was the only input a child could read
  from its owned directory, so a per-child file such as a patch shard had to
  travel JSON-escaped inside the seed. The effective card-scoped set is the
  declared list plus `seed.json`, so existing flows are unchanged. Load rejects
  names that are not declared inputs, rejects `feedback`, and accepts the block
  only on transform and harness stations (`INVALID_INPUT_SCOPE`). One resolver,
  `src/flow/resolve-input.ts`, now serves prompt rendering, both binding-stamp
  paths, the harness input mounts, the rank ask template and the gate critic,
  so an input cannot be rendered from one location and hashed or mounted from
  another. Sibling children with different shards get different binding
  stamps, and a changed per-child file re-executes that child on resume. A
  card-scoped input that cannot be read fails the render instead of falling
  back to the project-root file of the same name.

- Journal now records the token split and provider capacity per call
  ([#5](https://github.com/theaiteam-dev/conduit/issues/5)). `output_tokens`
  was `0` on every priced row and `cache_read`/`cache_creation` had nowhere to
  go, because the harness path summed all four token classes into a single
  scalar and wrote it to `input_tokens`. The journal gains
  `cache_read_input_tokens` and `cache_creation_input_tokens`, `input_tokens`
  now means UNCACHED input only, and `model` is filled from what the provider
  actually billed. The `claude-headless` adapter reads
  `--output-format stream-json --verbose`, whose `rate_limit_event` records
  per-window utilization and reset times as journal attributes — so "what
  fraction of spend is cache reads" and "what did this run draw against the
  plan" are queries rather than inferences. `model` is attributed to the model
  that consumed the most tokens, since a normal agentic call bills two or more.
  The stream is filtered line-by-line as it arrives, so reading these events
  does not hold an entire multi-minute agent transcript in memory. Additive and
  nullable: existing journals migrate in place, pre-split rows stay readable,
  and run/wave budgets still count the same totals (they sum all four columns).

### Fixed

- A gate critic on a child-entry station can see the child's inputs. The
  critic prompt was rendered with no card scope, so a critic that referenced
  `{{seed.json}}` threw at render and the card went to `hold`. `ownedPaths` and
  `ownedDirInputs` are now required fields on `GateReworkInput` and
  `HarnessGateConfig`, so a construction site that omits them fails to compile.

- Declared input names are confined to the directory they resolve from. Inputs
  were read with a bare `join(projectRoot, name)`, so a station declaring
  `inputs: ['../../../etc/passwd']` read that file. Reads now get the same
  lexical and symlink-aware escape check that output writes already had.

- A provider rate limit no longer destroys a run
  ([#3](https://github.com/theaiteam-dev/conduit/issues/3)). A 429 was
  indistinguishable from a crash — both surfaced as `harness-nonzero-exit`,
  because the adapter bailed on the exit code before parsing the stdout that
  carried the diagnosis — and the retry loop had no delay, so a session cap
  exhausted a card's whole attempt budget in about three seconds, scrapped the
  card, and discarded the paid work from earlier attempts along with it.
  `claude-headless` now classifies a 429 as `harness-rate-limited` and carries
  the provider's reset time; the executor parks the card behind
  `cards.release_at` without consuming an execution attempt, and every other
  retryable class gets bounded exponential backoff. A card gated behind a
  future `release_at` no longer trips the liveness watchdog as a stall — which
  also fixes a latent bug for fan-out staggers longer than
  `no_progress_minutes` — while the consumption andon still halts a run that
  cannot afford to wait the cap out. A single park is capped at one hour, so a
  reset hours away re-checks the budget and refreshes its estimate rather than
  becoming one long blocking sleep. Under the default 10-minute run budget a
  capped run halts on wall clock; what fixes #3 is that the card stays `ready`
  rather than terminal, so `conduit resume` has something to dispatch.

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
