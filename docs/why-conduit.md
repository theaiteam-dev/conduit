# Why Conduit?

**Conduit makes recurring AI work configurable, inspectable, and repeatable.**

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

## Why Not Temporal?

[Temporal](https://docs.temporal.io/) provides durable execution for application
workflows, with self-hosted and managed deployment options. It is also a viable
platform for AI work: its [AI cookbook](https://docs.temporal.io/ai/cookbook)
covers model calls, provider switching, agent loops, structured outputs, human
approval, and guardrails.

You can implement an inspection-and-revision process on Temporal. Choosing
Conduit means adopting an existing configurable production model: stations,
critic findings, bounded back-edges, checkpoint bindings, and recorded outcomes.
The decision is how much of that application behavior you would otherwise build
and maintain yourself.

For example, a marketing flow might draft an asset, reject it with specific
findings, revise it twice at most, and ask a person to choose among candidates.
Conduit exposes those policies in its flow configuration. The prompts and
criteria remain yours.

If your team already runs Temporal and has suitable workflow components,
staying with it may be simpler. Choose it when you need distributed execution
or coordination across services beyond Conduit's single-host scope. Conduit's
checkpoint-and-resume behavior does not establish equivalent durability
guarantees.

For a new deployment, Conduit's Bun/SQLite runtime and per-flow packaging may
fit a smaller operational footprint. Evaluate that benefit against the
integration work and operational familiarity you already have.

Temporal could also own an outer business process that invokes a Conduit run.
That is an integration you would build; Conduit does not ship a dedicated
Temporal integration.

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
