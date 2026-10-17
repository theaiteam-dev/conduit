# Why Conduit?

**Conduit runs LLM jobs from a YAML file, with safety, replay, and logging built in.**

Define your production flow in YAML, with prompts and scripts alongside it.
Conduit runs the steps, applies your checks, sends findings back for bounded
revisions, and pauses for human review where configured.

Its value is the production process you can configure: choose a maker and a
critic, declare their inputs and outputs, decide where rejected work returns,
and set revision limits. Conduit executes those rules and records what happened.
You supply the domain knowledge that makes the checks useful.

Competitor capabilities below were reviewed against the linked official
documentation on 2026-10-08.

## When Conduit Fits

Consider Conduit when you have a recurring transformation, such as code changes
into review findings, an idea into marketing assets, or footage into a finished
video, and:

- you want the production steps, model choices, checks, and revision limits in
  version-controlled configuration;
- rejected work needs specific feedback and another bounded attempt;
- you need to inspect why work advanced, was rejected, or stopped;
- configured human selection belongs in the process;
- a single-host runtime fits your deployment.

Start with the [marketing ideas example](../examples/tiktok-shoppable-ideas/README.md)
to see generation and inspection together. The
[installation guide](./installation.md) covers the runtime and deployment setup.

## What You Still Build and Operate

YAML defines the production rules. Prompts, schemas, and custom commands define
the work and its checks. You still configure credentials, install the tools your
steps need, retain state, and connect any delivery or review channels.

Conduit provides CLI run, resume, status, journal, and diagnostic commands, plus
webhook and Slack ingress. An external scheduler can launch periodic work;
Conduit has no built-in calendar scheduler. Its current runtime uses Bun and
SQLite on one host. Agent harness containment depends on the
[adapter](./harness-containment.md).

The aim is to reduce the custom orchestration code needed for an inspected
production flow. Whether that is easier for your team depends on the flow and
the infrastructure you already operate.

## Why Not Temporal?" -->

## Why Not Temporal?

[Temporal](https://docs.temporal.io/) gives application code durable execution:
a workflow's event history records every activity it scheduled and the result
it returned, and when a worker dies the workflow replays that history and
continues from the last recorded step. For a long-running business process that
spans services, with timers, signals, and schedules, it is the mature answer and
Conduit does not compete with it there.

Run LLM work on Temporal and the history does one thing well: a crash never
re-bills a completed activity. What the history does not hold is anything about
the model call itself. It records that an activity returned a value, not which
prompt version, model, or inputs produced it, so when you change a prompt
Temporal has no way to say which steps are now stale. You reset the workflow to
an event ID by hand, or you build the dependency tracking in your own code.

Conduit keys each checkpoint by a binding stamp:
`hash(model, prompt version, input artifact hashes, flow version)`, where the
prompt version includes the injected skills and the harness agent definition.
On resume a station runs again only if its stamp changed, and the invalidation
cascades to the stations that consume its output. Bump one `prompt_version` and
only that station and its dependents re-run. The upstream model calls are
reused. Change `flow_version` and `conduit resume --rebind` re-validates every
stamp.

The second difference is what gets recorded. Temporal's history is activity
inputs and outputs. Conduit's journal is the model call's model, tokens, cost,
prompt version, and binding stamp; the card log is every lane change, every
critic verdict with its findings, and the terminal reason. When a run ends you
can answer "why was this accepted" and "what did this cost" from the database,
not from your own logging.

The third is what you have to write. A critic with a rework cap, a token budget,
a command allowlist for an agent's shell calls, and an intent log for a publish
step are all workflow and activity code on Temporal. On Conduit they are keys
in `flow.yaml` that the kernel enforces.

Choose Temporal when the job is a durable business process and the model call
is one activity among many. Choose Conduit when the job is mostly model calls
and you need replay keyed to the prompt, a journal of verdicts and cost, and
bounded loops without writing them. They compose: Temporal can own the outer
process and start a Conduit run for the model-heavy stage. Conduit is one host
on SQLite and a developer preview; Temporal is neither, and that is a reason to
pick Temporal when the surrounding process needs its scale.

## Why Not n8n?

[n8n](https://docs.n8n.io/) combines AI features with business-process automation.
Its visual workflow authoring and integrations are useful when the primary job
is connecting applications and services.

Consider Conduit when you want to maintain the production process as YAML,
prompts, and scripts, and maker/checker separation, revision routing, and recorded
findings are central requirements. General automation tools can implement those
policies too; Conduit supplies a specific model for them.

An existing automation system can trigger a Conduit flow through its configured
webhook ingress. Account for the work needed to connect delivery and results
back to that system.

## Why Not LangGraph?

[LangGraph](https://docs.langchain.com/oss/python/langgraph/overview) provides
orchestration for stateful agents, including durable execution, streaming, and
human intervention. It fits applications that need detailed control over agent
state and interaction in code.

Consider Conduit when a declared production route with explicit inputs, outputs,
checks, and revision caps fits your application. A station can delegate
tool-using work to a supported harness while Conduit manages the surrounding
process. Neither deterministic routing nor quality loops are exclusive to
Conduit; the distinction is the authoring model and the policies supplied by
the runtime.

## What “Improve” Means Today

Conduit can revise an artifact within a run using critic findings. Its recorded
history helps a developer diagnose failures and change prompts or checks for
future runs.

Learning from delivered work is a separate, planned capability. Conduit does
not yet collect code-comment acceptance rates or video performance and use them
to propose, evaluate, and promote changes. See the
[roadmap](../ROADMAP.md) and [feedback-loop design](./feedback-loops.md).

## Try the Decision on One Flow

Pick one real artifact and its acceptance criteria. Configure its maker,
inspection, revision limit, and any human selection. Run it, inspect a rejection,
resume interrupted work, and check how you would operate it after handoff.

Adopt Conduit if that exercise saves meaningful implementation and operating
work for your team. The quality loop and execution history are available today;
learning from external outcomes is the direction we are building toward.
