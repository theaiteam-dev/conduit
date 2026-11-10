# Conduit

**A deterministic quality loop for AI workflows.**

Conduit runs AI work through a quality loop: produce, inspect, revise, then
accept, reject, or escalate.

It helps teams build AI workflows that are easier to trust: every step has clear
inputs and outputs, every check leaves a trail, failed work can be retried safely,
and human judgment has a real place in the process.

## The Short Version

Conduit turns AI work into a controlled production line.

- A **flow** is the whole workflow.
- A **station** does one piece of work: fetch data, call an API, ask a model to
  draft something, run a command, or wait for a person.
- A **gate** checks the work and decides what happens next.
- The **kernel** moves work between stations, records what happened, enforces
  limits, and resumes cleanly after failure.

The important part is the loop:

```text
produce -> inspect -> revise -> accept | reject | escalate
```

In Conduit terms, that means a station produces an artifact, a gate evaluates it,
and the kernel either moves it forward, sends it back with feedback under a
rework cap, scraps it, or holds it for human judgment.

That is Conduit's version of loop engineering. The loop is not an agent reasoning
forever. The loop is deterministic quality control around AI labor.

## Why It Exists

Most AI workflow systems make it easy to call a model. That is not the hard part
for production work.

The hard part is knowing what happened, checking whether it was good enough,
retrying without duplicating side effects, keeping costs bounded, and knowing
when to stop or ask a person.

Conduit is built around those concerns:

- **Quality checks.** Maker and checker are separate. Work can be revised with
  specific findings instead of trusted on the first pass.
- **Bounded rework.** A flow can improve work without spinning forever.
- **Deterministic control.** The kernel decides legal routing. LLMs produce and
  judge; they do not drive the conveyor.
- **Cost recovery.** Completed stations are checkpointed with binding stamps, so
  a resume does not repay earlier work unless inputs changed.
- **Safe side effects.** Publishing, committing, and billed calls go through an
  intent log and idempotency keys.
- **Model independence.** Choose the right model per station, from frontier models
  where judgment matters to cheap or local models where it does not.
- **Human approval.** Human-in-the-loop decisions are durable state, not a vague
  prompt instruction.

If you are deciding between Conduit and a general workflow or agent framework,
read [Why Conduit?](./docs/why-conduit.md). It explains where Temporal, n8n, and
LangGraph are stronger—and the narrower problem Conduit is designed to solve.

## Quickstart

This runs a real fan-out/fan-in flow with ten child lanes and no model calls, API
keys, or external data. It exercises Conduit's loader, deterministic stations,
SQLite state, subprocess worker pool, concurrency cap, and terminal-state
reporting.

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

## Docker Image Channels

Conduit publishes `ghcr.io/theaiteam-dev/conduit-engine` with two distinct
meanings:

| Tag | Meaning |
|---|---|
| `main` | Rolling image from the newest commit on the default branch; it may contain unreleased changes. |
| `sha-<commit>` | Immutable image for a specific commit on `main`. |
| `latest` | Newest stable release. |
| `1`, `1.0`, `1.0.0` | Stable release aliases at major, minor, and exact-version precision. Pin the exact version for reproducible deployments. |

A release happens when a maintainer merges a release PR, which sets the
version in `package.json` (see [Releasing](./docs/releasing.md)). The Release
workflow then verifies the merged commit, creates the Git tag and GitHub
Release, publishes the version aliases and advances `latest`. Manually pushing
a Git tag does not publish a container image.

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

Stop thinking "one agent that reasons about everything." Think **stations on a
line**.

Stations come in three execution kinds:

- **Deterministic stations** run known work with no LLM, such as SQL queries, API
  calls, `ffmpeg`, CSV export, validation, or delivery.
- **Transformation stations** (`transform` in `flow.yaml`) make one model call
  with typed input and typed output. They are good for drafting, summarizing,
  classifying, ranking, and critique.
- **Agentic stations** use an LLM with tools in a multi-turn loop. This is the
  highest-risk surface and is only needed for work that truly requires open-ended
  tool use.

The kernel itself stays deterministic. It uses Bun, TypeScript, SQLite, atomic
claims, checkpoint binding stamps, an outbox for side effects, and a journal as
the source of truth. No LLM sits in the control loop.

The quality loop is where the leverage comes from:

```text
work -> gate -> bounded rework -> pass | scrap | hold
```

For users, that reads as accept, reject, and escalate. In the kernel, those map
to pass, scrap, and hold. Both describe the same thing: every loop has a gate, a
bound, and an explicit outcome.

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

## Current Status

The MVP kernel, real-run path, and production worker pool are implemented.
Conduit is ready for deterministic, transformation, and harness-delegated flows:

- flow loading and validation
- real model calls through an OpenAI-compatible adapter
- deterministic worker commands
- typed prompts and output schemas
- checkpoint binding stamps
- bounded gate rework
- deterministic fan-out and fan-in
- Slack human-in-the-loop rank selection
- multimodal image inputs for transformation stations
- webhook and Slack event ingress
- Docker-first distribution (non-root engine image, per-flow `conduit build`)
- harness adapters for external headless agent CLIs, with explicit containment
  limits documented separately from the planned Law-grade agentic tier
- **per-child seeded fan-out inputs** with `{{seed.json}}` prompt rendering
- **bounded concurrent execution** — `conduit run --concurrency K` runs fan-out lanes K-at-a-time as real out-of-process workers (START_WORK/MARK_DONE/HEARTBEAT over Bun IPC), bounded by `min(K, station.wip)`
- **dead-PID detection** for robust worker reclaim under concurrency
- **multi-run shared-database support** — `conduit run --run-id <id>` isolates concurrent jobs against a single SQLite database with zero cross-contamination (schema v10, run registry, all per-run tables scoped by run_id)
- crash/resume recovery tested by the crash oracle

**Step 9a status:** the worker pool is wired into the production binary — `conduit run --concurrency K>1`
spawns real `conduit __worker` subprocesses (`Bun.spawn` ↔ harness) that run deterministic stations and
report over IPC, with the kernel as the sole DB writer. The synchronous single-worker path (`concurrency=1`)
is unchanged. See [`docs/concurrency-demo.md`](./docs/concurrency-demo.md) for a measured, reproducible proof.

**Run namespacing status:** Multiple `conduit run --run-id job-A` and `conduit run --run-id job-B` jobs can safely share one database. Each `--run-id` is a partition; legacy runs auto-adopt a stable default run ID for backward compatibility.

The Law-grade agentic Tool-Bridge (step 9b) and kaizen loop (step 10) remain
post-MVP work. The shipped `kind: harness` precursor tier is step 9c and makes a
deliberately narrower containment claim.
See [`docs/build-order.md`](./docs/build-order.md) for the implementation sequence
and [`CHANGELOG.md`](./CHANGELOG.md) for release notes.

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

> The flow is config. The kernel is the product.
