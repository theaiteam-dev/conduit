# Conduit

**Conduit makes recurring AI work configurable, inspectable, and repeatable.**

Define your production flow in YAML, with prompts and scripts alongside it.
Conduit runs the steps, applies your checks, sends findings back for bounded
revisions, and pauses for human review where configured.

Use it for repeatable work such as code review, marketing assets, video
production, research, and data enrichment. Choose models per step and keep the
production process in version control.

## What You Configure

A **flow** describes the production process. A **station** does one piece of
work: run a command, call a model, delegate to an agent harness, or ask a person
to choose. A **gate** inspects an artifact against the criteria you supply.

For example, this station excerpt from the
[marketing ideas flow](./examples/tiktok-shoppable-ideas/flow.yaml) drafts an idea,
then asks a separate critic to check it:

```yaml
- id: ideate
  worker:
    kind: transform
    model: gemini-flash-lite-latest
    prompt_file: prompts/ideate.md
    prompt_version: "1"
    output_schema:
      fields:
        - { name: featured_variant, type: string, required: true }
        - { name: hook, type: string, required: true }
        - { name: filming_idea, type: string, required: true }
  inputs: [context.json, feedback]
  outputs: [idea.json]
  next: done
  check:
    kind: gate
    critic:
      model: gpt-4o
      prompt_file: prompts/verify.md
      prompt_version: "1"
    on_reject: ideate
    rework_cap: 2
```

If the critic rejects the idea, Conduit passes its findings into the maker's
`{{feedback}}` prompt placeholder and runs the revision. This gate allows at most
two revisions; repeated findings can stop it sooner. Verdicts, findings, and
transitions are recorded for inspection. Your prompts and checks define what
counts as acceptable work.

The full example includes the context-fetching step, budgets, and security
configuration. Models must be available through your configured endpoint; the
example's two providers use a gateway. See the
[example guide](./examples/tiktok-shoppable-ideas/README.md) for setup.

## What Conduit Handles

- **Execution and recovery.** Run commands, typed model calls, and agent
  harnesses. Reuse completed work on resume when checkpoint bindings match.
- **Inspection and revision.** Separate makers from critics, route rejection
  findings back to a maker, and cap revisions and execution attempts.
- **Visibility.** Inspect recorded findings, state transitions, and terminal
  reasons with `conduit journal inspect`; view the flow with `conduit explain`.
- **Human review.** Configure Slack selection steps that wait for a reply and
  resume with the recorded choice. Ambiguous recovery can hold work for operator
  attention.
- **Effect handling.** Stations declared effectful use an intent log and
  idempotency keys. Unresolved effects can require manual reconciliation.
- **Model choice.** Select models per station through an OpenAI-compatible
  endpoint, or use a supported agent harness for tool-using work.

Conduit runs on a single host with Bun and SQLite. You supply the prompts,
checks, scripts, credentials, and any external services your flow needs. Launch
runs from the CLI or configured webhook and Slack triggers; use an external
scheduler for calendar-based runs. Repeatable refers to the process and its
rules; model-generated outputs can vary.

The value is having these production rules available in configuration. If you
already use Temporal or another workflow platform, compare the work needed to
build and maintain your particular flow. Read [Why Conduit?](./docs/why-conduit.md)
for that decision.

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

## Current Status

The runtime supports deterministic, transformation, and harness flows, including:

- YAML loading and validation, typed output schemas, and image inputs
- inspection gates, rejection feedback, and bounded revisions
- checkpoint bindings and crash/resume recovery
- fan-out/fan-in with seeded child inputs and bounded concurrency
- separate run IDs for multiple jobs sharing a state database
- Slack human selection, webhook and Slack triggers, and delivery steps
- Docker packaging and CLI tools for status, inspection, and diagnostics

The operator interface is currently the CLI and configured channels. War Room,
the planned visual run view, is not shipped. The full in-kernel agentic
Tool-Bridge is also planned; the shipped harness adapters have the guarantees
listed in the [containment profile](./docs/harness-containment.md).

See the [concurrency demonstration](./docs/concurrency-demo.md),
[build order](./docs/build-order.md), and [release notes](./CHANGELOG.md) for
details.

## Improving Work Today and Over Time

Today, Conduit uses inspection findings to revise an artifact within a run.
Recorded findings, human selections, and execution history also help you
investigate failures and manually improve prompts, checks, and flow definitions.

**We're building toward flows that improve from feedback on their delivered
work.** Examples include acceptance or dismissal of code-review comments, or
views and sales associated with published videos. Connecting those outcomes to
the producing artifact, evaluating proposed changes, and promoting improvements
is planned work. Conduit does not currently harvest those signals or tune a flow
automatically.

See the [roadmap](./ROADMAP.md) for direction and the
[feedback-loop design](./docs/feedback-loops.md) for the proposed learning system.
The [implementation proposal](./docs/kaizen-implementation.md) describes a
Nitpick-first build sequence and the decisions open for public review.

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
