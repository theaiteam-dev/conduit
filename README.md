# Conduit

**Conduit runs LLM jobs from a YAML file, with safety, replay, and logging built in.**

Describe the job as stations in `flow.yaml`: a command, one model call, a
coding-agent run, or a wait for a person. Put a critic after any station and
cap how many times it can send work back. Conduit runs the route, keeps the
side effects from happening twice, and records every model call with its
prompt version, model, and cost.

Every completed station is checkpointed under a stamp of the model, prompt
version, inputs, and flow version. Kill a run and resume it, and no finished
model call is billed again. Bump a station's `prompt_version`, and only that
station and the ones downstream of it re-run.

## A Flow With a Loop Inside a Loop

This is trimmed from [`examples/prd-writer/flow.yaml`](./examples/prd-writer/flow.yaml).
The maker is a Claude Code headless run with its own agent loop. Conduit wraps
it in a second loop: a critic on a different model, a back-edge to the maker,
and a cap.

```yaml
flow: prd-writer
flow_version: 1

budgets:
  run:
    wall_clock_minutes: 25
    max_tokens: 2500000
  per_card:
    max_execution_attempts: 3      # 1 first try + 2 reworks

stations:
  - id: draft-prd
    worker:
      kind: harness                # an external agent CLI runs its own tool loop here
      harness: claude-headless
      model: claude-sonnet-5
      tools: [Read, Write]
      prompt_file: prompts/prd-writer.md
      prompt_version: "1"
    inputs: [brief.md, reference-prd.md]
    outputs: [draft-prd.md]
    next: done
    check:                         # Conduit's loop around the harness loop
      kind: gate
      critic:
        harness: claude-headless
        model: claude-haiku-4-5-20251001
        tools: [Read, Write]
        prompt_file: prompts/prd-critic.md
        prompt_version: "1"
      on_reject: draft-prd         # back-edge; the loader rejects a target that is not in the flow
      rework_cap: 2                # after two rejections the cap policy applies
```

What happens at run time:

- The maker writes `draft-prd.md`. The critic reads it and returns `pass` or
  `reject` with findings.
- On reject, the findings go back into the maker's prompt and it runs again.
  A gate can also stop early when the findings stop changing
  (`progress_signal: findings_hash`).
- The second rejection past the cap ends the card: `scrap`, or
  `proceed_with_findings` if the flow says so. The run's token and wall-clock
  budgets halt the whole run. A pending side effect with an unknown outcome,
  or an agent that asks a human a question, moves the card to `hold`.
- Every verdict, every finding, and the reason the card stopped are in the
  journal.

The same shape works with a plain `transform` station (one model call, typed
input and output) as the maker, and the critic can be a cheaper model than the
maker.

## Quickstart

This runs a real fan-out/fan-in flow with ten child lanes and no model calls, API
keys, or external data. It exercises Conduit's loader, deterministic stations,
SQLite state, subprocess worker pool, concurrency cap, and terminal-state
reporting. To exercise model generation and inspection after this smoke test,
follow the [marketing ideas example](./examples/tiktok-shoppable-ideas/README.md).

Prerequisites: [Bun 1.3.11](https://bun.sh/) and
[DuckDB](https://duckdb.org/docs/stable/installation/). Bash and Python 3 are
used by the example's deterministic planning step.

```bash
git clone https://github.com/theaiteam-dev/conduit
cd conduit
bun install --frozen-lockfile

# Keep this run's SQLite state isolated in a temporary directory.
export CONDUIT_QUICKSTART_DIR="$(mktemp -d)"
export CONDUIT_STATE_DB="$CONDUIT_QUICKSTART_DIR/conduit.sqlite"
export CONDUIT_JOURNAL_DB="$CONDUIT_QUICKSTART_DIR/conduit.journal.sqlite"
export CONDUIT_PROJECT_ROOT="$PWD/examples/tiktok-parallel-ideas"

# The pre-flight check requires configured gateway variables. This
# deterministic demo never contacts the values below.
export CONDUIT_API_KEY=unused
export CONDUIT_BASE_URL=unused

bun run src/cli/main.ts run \
  examples/tiktok-parallel-ideas/flow-kernel-demo.yaml \
  --input-inline '{}' --concurrency 5 --run-id quickstart

bun run src/cli/main.ts run status --run quickstart
```

The final command should print:

```text
run quickstart: terminal (outcome=complete)
```

The demo reads the committed DuckDB fixture, which contains only synthetic
product data. Maintainers can rebuild it from
[`build-fixture.sql`](./examples/tiktok-parallel-ideas/fixtures/build-fixture.sql).
For the topology and a measured parallelism demonstration, see the
[example guide](./examples/tiktok-parallel-ideas/README.md) and
[concurrency write-up](./docs/concurrency-demo.md). For model-backed and Docker
deployment paths, continue with the [installation guide](./docs/installation.md).

## What Conduit Handles

### Safety

- **Side effects run once.** A station marked `effectful: true` writes an
  intent record with an idempotency key before it publishes, commits, or bills.
  On resume Conduit checks that record first. A pending intent with an unknown
  outcome goes to `hold` for a person; it is never retried blind.
- **Commands are allowlisted.** Deterministic stations spawn only the
  executables in `security.bash.allow`, with shell metacharacters refused. On
  the supervised harness adapters (`agent-sdk`, `codex-app-server`, `opencode`)
  the kernel decides every tool call before it runs: a tool allowlist, a
  positive allowlist of Bash executables, file writes confined to the card's
  owned paths, and no web tools. Every decision is journaled. The
  [containment profile](./docs/harness-containment.md) states what each adapter
  enforces and what it does not. Landlock write confinement for overlapped
  harness calls is in progress
  ([#129](https://github.com/theaiteam-dev/conduit/pull/129)).
- **Budgets stop runaway loops.** Rework caps per gate, execution-attempt caps
  per card, token and dispatch caps per fan-out wave, token and wall-clock caps
  per run, and a liveness watchdog that halts a run making no progress. These
  are separate mechanisms because they catch different failures.

### Replay

- **Checkpoints carry a binding stamp.** Each completed station is stored
  under `hash(model, prompt version, input artifact hashes, flow version)`.
  The prompt version folds in the content hash of every injected skill and, for
  a named harness agent, the SHA-256 of its agent definition.
- **Resume reuses what still matches.** `conduit resume` skips a station whose
  stamp matches and re-runs the ones whose inputs changed, with invalidation
  cascading downstream. Bump one station's `prompt_version` and only that
  station and its dependents run again; the model calls upstream of it are not
  repeated. Change `flow_version` and `conduit resume --rebind` re-validates
  every stamp.
- **Crash recovery is tested.** Dead worker leases are reclaimed, the outbox is
  checked before any effect is retried, and the crash oracle in the test suite
  kills runs mid-station to prove it.

### Logging

- **The journal records each model call** with its model, input and output
  tokens, cost where the provider reports it, binding stamp, and effective
  prompt version. Harness calls record the agent name and definition hash.
- **The card log records the route**: every lane change with its reason, every
  gate verdict with its findings, and the terminal reason (`done`, a scrap
  reason such as the rework cap, or a hold).
- **Read it from the CLI.** `conduit journal inspect <card>` prints the spans,
  the harness gate decisions, and the card log in order. `conduit journal tail`
  follows a live attempt. `conduit explain <flow.yaml>` prints the topology.
  Both databases are SQLite, so any query tool works on them.

Nitpick, a code reviewer built on Conduit, reviewed 58 of Conduit's own pull
requests between 2026-10-03 and 2026-10-12 on GLM-5.3-Flash via Fireworks for a
median of about 9 cents a review (range $0.016 to $0.22). Those figures come
from the journal's token counts times the price table, not from an estimate.

Autocut, a video flow built on Conduit, averages about $6 per video at API list
prices across 131 runs, attributed per station in the journal.

### Also Included

Per-station model choice, fan-out and fan-in with a concurrency cap, Slack
selection and webhook ingress, and Docker packaging. See
[What You Can Build](#what-you-can-build) and [How It Works](#how-it-works).

## How Much Code a Flow Takes

Nitpick is a private repository, so here is its shape rather than a link. The
flow author wrote the review logic; Conduit supplied the job machinery.

| Written by the flow author | Lines |
|---|---|
| `flow.yaml` (stations, gates, caps, budgets) | 334 |
| prompts | about 375 |
| deterministic domain scripts: diff classification, import-graph spider, shard planning, evidence gathering, finding anchoring, spend projection | about 2,900 |

None of those 2,900 lines do retries, rework routing, caps, fan-out
scheduling, checkpointing, journaling, or cost accounting. Conduit does. The
count excludes tests and a local harness that exists only to run the scripts
without Conduit.

<!-- Demo slots (to record): replay (kill + resume, zero re-billed calls; bump one
prompt_version, only downstream re-runs); logging (`conduit journal inspect` on the
Nitpick run where the critic rejected a false finding twice and the cap stopped it);
safety (agent write outside owned paths denied; crash mid-publish does not double-post). -->

## Compared With Temporal

Temporal and Conduit both record what a job did so a crash does not repeat
paid work. The difference is what each one knows about the work.

| | Temporal | Conduit |
|---|---|---|
| Unit of work | an activity in workflow code | a station in `flow.yaml` |
| What a completed step is keyed by | its position in the event history | a stamp of model, prompt version, input hashes, and flow version |
| After a prompt change | you reset the workflow to an event ID by hand, or build the tracking | the affected station and its dependents re-run; the rest is reused |
| What the history holds | activity inputs and results | model, tokens, cost, prompt version, verdicts, findings, terminal reason |
| Critic, rework cap, token budget, command allowlist | workflow and activity code you write | configuration the kernel enforces |
| Scale | multi-host, durable timers, signals, schedules, years of production use | one host, SQLite, developer preview |

Temporal is the right choice when the job is a long-running business process
across services and the model call is one activity among many. Conduit is
the right choice when the job is mostly model calls and the questions you
will ask later are "which prompt produced this, what did it cost, and why was
it accepted." The two compose: Temporal can own the outer process and start a
Conduit run for the model-heavy stage.

n8n connects SaaS APIs on a visual canvas; use it for glue, and hand the
maker-critic section to Conduit. LangGraph gives an agent dynamic control of its
own route; Conduit keeps the route fixed and lets a LangGraph or Claude Code
agent do the work inside one station. The longer version, with links to each
tool's documentation, is in [Why Conduit?](./docs/why-conduit.md).

## Status

Conduit is a developer preview. Shipped: deterministic, transform, and harness
stations; gates with bounded rework; binding-stamped checkpoints and resume;
fan-out, fan-in, and concurrency; Slack selection and ingress; Docker packaging.

Planned, not shipped: War Room, the live run view (a read-only `conduit watch`
TUI is in [#104](https://github.com/theaiteam-dev/conduit/pull/104)); the
in-kernel agentic Tool-Bridge (`kind: agentic`) with per-call gating for every
harness; kaizen and outcome learning, including `output.tag_assets`. The
[roadmap](./ROADMAP.md) has the order; the
[feedback-loop design](./docs/feedback-loops.md) has the learning proposal.

## Docker Image Channels

Conduit publishes `ghcr.io/theaiteam-dev/conduit-engine` with two distinct
meanings:

| Tag | Meaning |
|---|---|
| `main` | Rolling image from the newest commit on the default branch; it may contain unreleased changes. |
| `sha-<commit>` | Immutable image for a specific commit on `main`. |
| `latest` | Newest stable release. |
| `1`, `1.0`, `1.0.0` | Stable release aliases at major, minor, and exact-version precision. Pin the exact version for reproducible deployments. |

Release-worthy conventional commits on `main` are verified and processed by
semantic-release. That workflow creates the Git tag and GitHub Release, then
publishes the version aliases and advances `latest`. Manually pushing a Git tag
does not publish a container image.

```bash
docker pull ghcr.io/theaiteam-dev/conduit-engine:1.0.0
```

## What You Can Build

Conduit is for workflows where AI creates or evaluates artifacts and mistakes
need to be visible, recoverable, and bounded.

| Flow | Starts With | Produces |
|---|---|---|
| **A(i)-Team** | a PRD | tested code |
| **Studio** | an idea | campaign assets and a Meta ads CSV |
| **Autocut** | raw footage | a polished YouTube video |
| **Research** | a question | a checked report |
| **Enrichment** | raw records | validated structured data |

These are different products, but they share the same shape: work moves through
stations, gates check it, and the kernel records the path.

## How It Works

The kernel follows the declared route and enforces its limits. Models produce
and inspect artifacts at stations. The shipped worker kinds are:

- **Deterministic stations** run known work with no LLM, such as SQL queries, API
  calls, `ffmpeg`, CSV export, validation, or delivery.
- **Transformation stations** (`transform` in `flow.yaml`) make one model call
  with typed input and typed output. They are good for drafting, summarizing,
  classifying, ranking, and critique.
- **Harness stations** (`harness` in `flow.yaml`) delegate tool-using work to a
  supported external agent harness. Containment depends on the adapter.

The kernel itself stays deterministic. It uses Bun, TypeScript, SQLite, atomic
claims, checkpoint binding stamps, an outbox for declared effects, and a journal
of execution history. The state database tracks current work; the journal
records how it got there.

An inspected production step follows this loop:

```text
work -> gate -> bounded rework -> pass | scrap | hold
```

A passing verdict advances work. Rejection can send it back for revision;
exhausting a cap applies the configured policy, usually scrap. Human selection
and recovery holds pause work for different reasons, recorded in the journal.

## Design Commitments

- **Deterministic flow, non-deterministic labor.** The kernel decides what is
  legal next; LLMs only produce and judge.
- **The check is the quality engine.** `work -> gate -> bounded rework`, with
  maker and inspector separated.
- **Use the cheapest faithful check.** Check a plan or prompt before rendering an
  expensive artifact when that proxy is good enough.
- **Checkpoint with proof.** A completed station is skipped on resume only when
  its binding stamp still matches the model, prompt, upstream artifacts, and flow
  version.
- **Treat side effects as dangerous.** Publishing, committing, and billed calls
  need an intent log and idempotency key.
- **Bound the loop more than one way.** Rework caps, execution-attempt caps,
  progress checks on findings, budgets, and liveness watchdogs cover different
  failure modes.
- **Keep provider lock-in out of the kernel.** Conduit is not built on Claude
  Code, Codex, or any single agent host. Model calls go through an
  OpenAI-compatible adapter, with LiteLLM as the default gateway in the example.

## Repository Map

```text
conduit/
├── README.md              # orientation and pitch
├── CHANGELOG.md           # release notes
├── SPEC.md                # full design specification
├── src/                   # Bun/TypeScript/SQLite kernel
│   ├── flow/              # loader, validator, prompts, schemas
│   ├── controller/        # deterministic tick planner and executor
│   ├── dag/               # fan-out / fan-in expansion and merge
│   ├── worker/            # deterministic and transformation runtimes
│   ├── checkpoint/        # binding stamps and outbox
│   ├── quality/           # gates, rework, and rank QC
│   ├── control/           # budgets, watchdog, andon
│   ├── channels/          # Slack egress
│   ├── ingress/           # webhook and Slack adapters
│   ├── packaging/         # Docker engine image and compose stacks
│   └── cli/               # run, resume, doctor, journal, reply, listen, build, explain
├── blackbox/              # black-box suite: spawns the shipped binary, no src/ imports
├── scripts/               # development spikes and renderer experiments
├── examples/              # runnable flows
│   └── tiktok-shoppable-ideas/
├── docs/                  # philosophy, glossary, diagrams, build order
├── prd/                   # done, ready, and draft product notes
└── adr/                   # architecture decision records
```

## Start Here

- Read [`docs/philosophy.md`](./docs/philosophy.md) for the worldview.
- Read [`docs/why-conduit.md`](./docs/why-conduit.md) for the decision guide
  against Temporal, n8n, and LangGraph.
- Read [`docs/glossary.md`](./docs/glossary.md) for the precise vocabulary.
- Read [`docs/diagrams.md`](./docs/diagrams.md) for the state machine and quality
  loop.
- Use `conduit explain <flow.yaml>` for the shipped read-only topology view; see
  [`docs/diagrams.md`](./docs/diagrams.md#rendering-flowyaml) for details.
- Try [`examples/tiktok-shoppable-ideas`](./examples/tiktok-shoppable-ideas) for
  a real flow with deterministic fetch, transformation, and gate rework.
- Read [`docs/local-openai-vlms.md`](./docs/local-openai-vlms.md) when running
  multimodal stations against local OpenAI-compatible VLM servers.
- Read [`SPEC.md`](./SPEC.md) when you want the full kernel contract.
- See [`ROADMAP.md`](./ROADMAP.md) for the public development direction.
- See [`CONTRIBUTING.md`](./CONTRIBUTING.md) before opening a pull request and
  [`SECURITY.md`](./SECURITY.md) for private vulnerability reporting.

Conduit is available under the [MIT License](./LICENSE).
