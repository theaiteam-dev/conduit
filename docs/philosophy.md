# The Conduit Philosophy

Why this thing is shaped the way it is. [`SPEC.md`](../SPEC.md) is the *what*; this is the
*why*. If a design decision ever seems arbitrary, it should trace back to one of the beliefs
below.

## The Product Promise

**Conduit makes recurring AI work configurable, inspectable, and repeatable.**

The flow definition, prompts, and scripts capture how a piece of work should be
produced and checked. The runtime executes that process, records its path, and
bounds revision. Domain expertise lives in the flow; Conduit supplies the
execution and inspection machinery.

Today, improvement means revising work within a run and helping a developer
understand what to change next. Learning from delivered outcomes is planned;
see the [feedback-loop design](./feedback-loops.md).

---

## The core bet: LLMs are labor, not a brain in the loop

The dominant way to build with LLMs right now is "one smart agent that reasons about
everything, with tools." Conduit bets the opposite: **the LLM is a worker at a station, not
the intelligence running the system.** The orchestration — what runs next, when, with what
capacity — is a deterministic state machine. The model only does two things: *work* (produce
something) and *check* (judge something).

This isn't a stylistic preference. We watched an LLM-driven orchestration loop run away for
40 hours without converging. The control flow of a work pipeline is a finite state machine;
paying a model to re-derive that FSM every cycle is expensive, slow, and — as it turns out —
unreliable. So we took the reasoning *out of the loop* and concentrated it where it earns
its keep: the work and the checks.

> **The conveyor is dumb on purpose.** Intelligence at the stations; determinism on the flow.

---

## It's a factory, not a chatbot — and not a DAG

Two camps own the agent conversation today: chat loops (agents talking until they stop) and
DAG pipelines (a fixed graph of prompt calls). Conduit is neither. It's a **flow-shop** — an
assembly line:

- work flows through **stations**, each with a worker and (sometimes) a quality gate;
- **WIP limits** cap how much is in each station at once;
- work is **pulled** when a station has capacity, not pushed;
- a failed quality check sends a piece **back down the flow** for rework;
- a piece that can't pass enough times goes to the **scrap bin** for a human;
- a runaway flow is stopped by an **andon cord**.

That vocabulary isn't decoration. Toyota solved the hard problems of high-throughput,
quality-controlled production decades ago — bounded rework, pull systems, stop-the-flow on
defect, mistake-proofing. The 40-hour runaway was simply *a flow with no andon cord and no
scrap bin*. We are porting lean manufacturing to knowledge work, not inventing orchestration
from scratch.

Crucially, a DAG **can't** express the most important part: the back-edge. `work → check →
reject → rework` is a *cycle*. DAG engines forbid cycles by construction, which is why
Conduit is a state machine, not Airflow.

---

## Every flow is a metabolism

A flow eats a raw substrate and excretes a finished product:

- A(i)-Team eats a PRD, excretes tested code.
- Studio eats an idea, excretes campaign assets.
- Autocut eats raw footage, excretes a polished video.

Same anatomy, different metabolism. The unit of value is the **transformation**, not the
intelligence. The engine doesn't care whether a station writes code, generates an image, or
runs `ffmpeg` — a station is just a transform with a contract. That indifference is exactly
what lets one kernel run any flow.

---

## Quality comes from the flow, not the model

This is the belief that makes everything else pay off. You do not get quality from a single
smart call; you get it from **make → inspect → revise**, with the maker and the inspector
kept separate (different prompt, often different model). The back-edge is what makes output
*converge* toward good instead of merely *happening once*.

This also gives you a way to evaluate **cheaper models**. Assign a cheaper maker
and a stronger critic, then measure accepted output quality and total cost,
including revisions. Savings depend on the task and the checks; the architecture
does not guarantee that a cheaper model will produce acceptable work. Eventually,
feedback from delivered artifacts could help evaluate those choices across runs.

---

## The law of checks

> **Check rigor is inversely proportional to how cheap, fast, and safe your external signal
> is.**

If reality grades you cheaply and quickly (an ad gets clicks or it doesn't), your internal
checks can be light — ship many, let the market sort them. If reality grades you slowly and
expensively (a bug reaches production), your internal checks must be heavy, because you can't
afford to "ship and measure." This single rule *predicts* the three flows: A(i)-Team has four
heavy gates (code's outer loop is brutal); Studio has two light ones (clicks are cheap);
Autocut sits in between.

One hard floor: the market only grades what it can see. It judges *taste* brilliantly and
*risk* not at all — an off-brand or non-compliant asset that happens to convert is still a
disaster. So checks split: **taste checks** thin as your signal cheapens; **risk checks**
(brand, safety, legal) stay mandatory regardless.

---

## Model independence is a first principle, not a feature

Frontier-only is a dead end for high-volume work — on cost, and on lock-in. Conduit drives
*any* model, chosen **per station**: frontier where judgment lives, cheap or local where it
doesn't. That's also a cost-engineering lever, because the cost of an LLM flow is dominated
by *input context and expensive-artifact output*, not reasoning — so you spend tokens where
they buy quality and starve them everywhere else.

This is why Conduit is its own runtime and not a plugin on someone else's harness. A flow you
can't run on the model you choose, at the cost you need, isn't yours.

---

## The Unix lineage

A transform station is a Unix filter: `stdin → process → stdout`, composable, testable with a
fixture, cacheable. A flow is a declarative pipe: `idea | brief | direct | generate |
assemble > campaign.csv`. Conduit is **Unix pipes plus the three things pipes can't do** —
quality gates, bounded back-edges, and WIP. Where the pipe analogy breaks is the one station
that's stateful and interactive (the agentic, tool-using worker); everything else is a
filter in a stream. Keep the filters pure and the flow stays simple.

---

## Escalate ambiguity; never guess. The Law is load-bearing.

When recovery is ambiguous, the kernel can **hold work for operator attention**.
Configured Slack selection steps have a reply-and-resume path; an operational
hold may instead require manual diagnosis and reconciliation. Forward-only
across waves; no "nuclear reversal" that rots state.

Containment needs enforceable boundaries: tool gates, path ownership, process
limits, and deployment isolation. The shipped harness adapters provide different
levels of control, documented in the [containment profile](./harness-containment.md).
The full in-kernel Tool-Bridge remains planned. Describe a deployment's guarantees
in terms of the adapter and isolation it actually uses.

---

## The moat is flow design

If quality comes from the flow and the model is interchangeable, then the durable advantage
isn't the prompts and isn't the model — it's the **flow**: which stations, what each one's
definition-of-done is, where the checks sit, how rework routes. Domain expertise gets
encoded as topology, prompts, and check rubrics. **The product is a configurable
production process you can run and inspect.** The kernel supports that promise
by executing the rules and recording what happened.

---

## What Conduit is *not* (anti-goals)

- **Not an autonomous agent.** No model decides what the system does next; the kernel does.
- **Not a chatbot.** State lives in a database and a board, not a conversation transcript.
- **Not a DAG runner.** The rework back-edge is the point; acyclic engines can't express it.
- **Not frontier-only.** Cheap-model viability is a design target, not an afterthought.
- **Not host-locked.** It owns its runtime so it can own its model and its cost.
- **Not self-modifying.** The planned kaizen system would propose improvements,
  evaluate them, and require human approval before promotion. Today, developers
  make those changes themselves.

---

## Lineage

Conduit didn't start as a theory. It's the kernel that three independently-built systems —
A(i)-Team (code), Studio (marketing images), Autocut (video) — converged on without trying:
the same deterministic controller, the same lane-in-a-state-file, the same resume-reconcile,
the same capped creator/critic rework. When you build the same architecture three times for
three unrelated domains, that's not a coincidence; it's a kernel asking to be extracted.
Conduit is the extraction.
