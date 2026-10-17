---
missionId: ~
---

# Conduit — The Kaizen Pipe

**Author:** Josh Owens  **Date:** 2026-05-31  **Revised:** 2026-06-29  **Status:** Draft

> **Implementation proposal (2026-10-08):**
> [Building Kaizen from Delivered Outcomes](../../docs/kaizen-implementation.md)
> proposes a Nitpick-first sequence, explicit artifact/delivery attribution, and
> project-specific evaluation policies. Its staged promotion and evidence rules
> differ from this draft; those differences are listed for public review rather
> than silently superseding this document's Acceptance Bar.

> Scope note: this is a **post-MVP** PRD covering **build-order step 10**
> ([`docs/build-order.md`](../../docs/build-order.md#after-the-mvp)) — the continuous-improvement
> loop that turns a producing flow-shop into a *self-tuning* one. It **depends on the shipped MVP
> kernel** ([`mvp-kernel.md`](../done/mvp-kernel.md)): the kaizen pipe learns from the journal,
> provenance chain, and decisions the kernel already records — it adds no new control surface
> to the kernel. This document defines *what must be true* and *why*, and stays implementation-free;
> the *how* lives in [`SPEC.md §13`](../../SPEC.md#13-continuous-improvement-kaizen) and
> [`docs/feedback-loops.md`](../../docs/feedback-loops.md).

> **2026-06-29 revision.** Three changes to the model: (1) kaizen is **not restricted to HITL** —
> it is an **open signal bus**, of which HITL preference is one trigger; (2) mutations move along
> **two axes**, not one — **taste calibration** (the critic→human→market cascade) *and* **defect
> closure** (escaped-defect signals such as code review, CI, and incidents that **tighten** a check);
> (3) every mutation, regardless of trigger or axis, must clear **one explicit Acceptance Bar**
> before it is applied — a quantitative promotion threshold, not a judgement call. See §5a (the
> Acceptance Bar) and §5 Phase 3 (defect closure).

## 1. Context & Background

Conduit *produces*; the kaizen pipe is how it *learns*. Quality in Conduit comes from
`work → check → bounded rework` ([SPEC §6](../../SPEC.md#6-the-quality-system)) — but the **check
itself can get better over time** if real signal is fed back into it. That is the difference
between a flow-shop and a *self-tuning* flow-shop.

The whole of kaizen runs on **one pipe** ([SPEC §13](../../SPEC.md#13-continuous-improvement-kaizen)):

```
observe → propose mutation → Acceptance Bar → human-gate → apply (versioned, canary, watch for regression)
```

The pipe is **signal-agnostic**: it is an **open signal bus**, not a fixed set of three loops. Any
observation that can be **joined to provenance** and proposes a bounded change is a valid trigger —
repetition, human preference, an escaped defect, market outcome, and others not yet named (cost
regressions, parse-miss spikes). The pipe and its terminal gates are shared; only the **trigger**
and the **evidence shape** differ. The pipe is driven by the **Analyst** — and the Analyst is not
special infrastructure: it is **a flow Conduit runs on itself** (eat signal → analyze → propose →
route to the Acceptance Bar and a `hold` gate). Conduit dogfoods its own kaizen
([`docs/feedback-loops.md §7`](../../docs/feedback-loops.md)).

**Two axes, not one.** Signals improve a flow in two orthogonal directions, and the distinction is
load-bearing because it maps onto taste-vs-risk (§6):

- **Taste calibration** — the critic→human→market **calibration cascade**: each cheaper, faster
  signal is a learned proxy for the next, truer one (tune the critic to predict the human's picks;
  calibrate the human against the market). Adjusts **market-replaceable `taste` gates**, and is
  **bidirectional** — it can loosen *or* retire a taste gate as the cheap signal proves it tracks
  the truer one.
- **Defect closure** — **escaped-defect** signals (a code-review finding, a CI failure, a
  production incident) that reveal a defect class the in-flow check *missed*. Adjusts the **check**
  (rubric or a new deterministic Hook), and is **monotonic-tightening only** — it never loosens.

The cascade is the first axis read as a *learning hierarchy* ([SPEC Principle
3](../../SPEC.md#2-design-principles)); defect closure is the second, and the older "three loops"
framing was the first axis mistaken for the whole.

**Why now.** The MVP ships a kernel that records a chain-of-custody (`work_summaries`, per-station
provenance), journals every HITL decision keyed by correlation ID, and — via the MARK_DONE
integrity gate ([SPEC §6](../../SPEC.md#6-the-quality-system)) — knows the **exact files each card
wrote**. That data is already on disk and already joined to the decisions that produced it. The
cheapest kaizen loops need **no new ingestion infra** — only a consumer of what the kernel already
writes. Building the consumer is what converts that latent signal into compounding quality.

**Why phased.** Triggers differ by an order of magnitude in cost-to-capture. Frequency needs only
the journal; HITL preference needs the journal plus captured operator identity; defect closure needs
the journaled write-set plus a small capture path for findings; market feedback needs attribution
infrastructure *and* a flow that reliably produces cheap assets. This PRD ships them in cost order
and explicitly defers the expensive one.

## 2. Problem Statement

A producing Conduit flow accumulates exactly the signal needed to improve itself — repeated
low-variance work that could be crystallized into standard work, journaled human selections that
reveal real taste, and **defects that escape the in-flow check only to be caught later** (in a
post-hoc code review, in CI, in production) — but **nothing harvests any of it**. Improvements are
made by hand: a builder notices a station doing the same thing forty times and templates it; notices
the critic getting overruled and rewrites the rubric; notices the reviewer flagging the same defect
class run after run and never strengthens the check that should have caught it. This does not
compound, it is slow, and it has **no consistent acceptance bar** — a hand-edited rubric ships with
no backtest, no canary, no regression watch, accepted on a hunch.

Conduit needs a **bounded, human-gated** loop that observes the signal it already records across
**both axes**, proposes improvements, holds each to **one explicit, quantitative Acceptance Bar**,
and applies them safely — **without ever letting a feedback loop silently rewrite itself**, and
**without ever loosening a risk gate**.

## 3. Target Users & Use Cases

**Primary user — the flow builder (engineer).** Owns the flow's quality over time. Wants the
Analyst to surface "this work is crystallizable," "the critic is miscalibrated against the human,"
and "this defect class keeps escaping the check" as **proposed, reviewable mutations** — versioned,
canary'd, reversible — not as silent edits. Cares about the candidate filter, the **Acceptance
Bar**, and the rollback path.

**Secondary user — the flow operator (a customer).** Makes the HITL selections and rejects that
*are* the preference signal. Served *through* the kaizen loop: it learns from their picks so the
critic's pre-filter sharpens and they are bothered less over time.

**Secondary user — the reviewer (human or agent).** Runs the post-hoc review (e.g. a branch-vs-main
code review, an LLM reviewer, a CI gate). Their findings are the **defect-closure** signal. The loop
records *who/what* reviewed (reviewer identity — human or model/tool) and uses recurring findings to
strengthen the in-flow check, so the post-hoc review finds *less* over time.

**Approver — the human gate.** A human (often the builder) who reviews every proposed mutation that
has cleared the Acceptance Bar before it is applied. No mutation reaches a flow without passing both.

**Key use cases:**

- A builder needs the Analyst to **spot repeated low-variance work** and propose **promoting it to
  standard work**, gated so *frequency alone* never promotes (frequency ≠ value).
- A builder needs **accumulated human selections** turned into a proposed **rubric tune** for the
  critic, gated on enough volume and consistency that it is not one operator's Tuesday.
- A builder needs a **defect class that repeatedly escapes the in-flow check** (caught only by
  post-hoc review / CI) turned into a proposed **check-strengthening** mutation — a sharper rubric or
  a new deterministic Hook — *tightening only*, never a loosening.
- An operator needs the HITL gate to **retire itself** once the critic reliably predicts their picks.
- A builder needs **every applied mutation to clear the same Acceptance Bar** (sufficient signal →
  class-correct → backtested improvement over the incumbent on held-out data → human gate → canary
  with a rollback threshold) and to be **reversible** in one step.

## 4. Goals & Success Metrics

The kaizen pipe is graded on **safe, compounding improvement** — never on raw mutation volume. A
loop that proposes many mutations is not better; a loop that ships a regression is a failure.

| Goal | Metric | Target |
|------|--------|--------|
| Crystallize repeated work | Repeated low-variance work units the Analyst surfaces as skill candidates, vs. hand-spotted | Analyst surfaces them first |
| Frequency ≠ value is enforced | Frequent-but-high-variance candidates proposed for promotion | 0 |
| Defects get closed at the check | Recurring escaped-defect classes that trend **down** in escape rate after a closure mutation | trend down |
| Every mutation clears the bar | Mutations applied without clearing the full Acceptance Bar (signal + backtest + human gate + canary) | 0 |
| No grading on training signal | Mutations that improved on the signal they were derived from but **regressed on held-out backtest** and shipped anyway | 0 |
| No churn | Mutations that fail to beat the incumbent by the declared margin but ship anyway | 0 |
| No silent mutation | Mutations applied to a flow without passing the human gate | 0 |
| Risk gates never loosened | `risk`-class gates (brand/safety/legal) **loosened or retired** by any learning loop | 0 |
| Safe rollout | Promoted mutations that regress check-pass / rework rate and are **not** auto-flagged + rollback-able | 0 |
| HITL loop measures itself | HITL flows where the loop cannot report whether the critic predicts the human (and thus whether the gate can retire) | 0 |

**Explicitly NOT a goal:** the operator-weighting math (parked until multi-operator data exists),
market-feedback learning, and any attribution infrastructure. These must not regress the above; they
are not measured here.

## 5. Scope

The pipe is **one mechanism** with **one Acceptance Bar**; scope is governed by which **trigger**
ships when. Triggers ship in cost-to-capture order, and within each, **observe before mutate**.

### 5a. The Acceptance Bar (applies to every trigger)

Every proposed mutation — frequency, HITL, defect closure, or any future trigger — clears the **same
five-stage bar** before it is applied. The bar is **trigger-independent**; only the *evidence* that
feeds each stage differs. Thresholds are **declared config per flow**, not hardcoded vibes.

1. **Signal sufficiency.** The trigger must clear a minimum evidence bar: **recurrence** (≥ N
   independent occurrences — a one-off finding is fixed as object-level rework, §6, not a mutation),
   **volume + consistency**, and — for **noisy sources** (an LLM reviewer, a flaky CI signal) — a
   **verification/confidence pass** so a hallucinated or flaky signal cannot mutate a flow.
2. **Class correctness.** A **taste** mutation may touch only `taste`-class gates; a **defect-
   closure** mutation may only **tighten** a check (rubric or new Hook) and **never** loosen or
   retire a `risk` gate (§6). A proposal that would change a class it is not entitled to is rejected
   here, before any evaluation.
3. **Backtested improvement (held-out).** The candidate is evaluated in the **Skill Lab**
   ([SPEC §14](../../SPEC.md#14-the-work-bench)) against journal/fixture data it was **not** derived
   from, and must (a) **beat the incumbent by a declared margin beyond noise** on the target metric
   (critic↔human agreement for a taste tune; defect-escape rate for a closure) **and** (b) **not
   regress** the others (cost, rework rate, other defect classes). Grading a mutation on the signal
   that produced it is forbidden — improvement must generalize.
4. **Human gate.** A human approves, with the **lesson (provenance)** shown — which prompt
   version / rubric / model / skill / check the proposal derives from — so they approve a reason, not
   a diff.
5. **Canary + regression threshold.** The approved mutation rolls out behind a **canary** on a
   bounded fraction of cards/waves, watched against a **pre-declared regression threshold**; a breach
   triggers **auto-rollback** to the prior version (one step). Only a canary that holds is fully
   promoted.

A mutation that fails any stage is not applied; if it fails on ambiguity rather than a clear
threshold, the Analyst escalates to `hold` with a `needsJudgment` payload and proposes nothing
(Principle 9). The bar is **monotone**: passing a later stage never excuses failing an earlier one.

### In Scope — Phase 1: Skill crystallization (frequency-triggered)

The first kaizen loop; journal-only ([SPEC §13](../../SPEC.md#13-continuous-improvement-kaizen),
[`docs/feedback-loops.md §8`](../../docs/feedback-loops.md)).

- **The one pipe** — `observe → propose → Acceptance Bar → human-gate → apply`, the `mutations`
  table, and the Analyst-as-a-flow.
- **Frequency trigger** — the Analyst watches the journal for **repeated work** and proposes
  promoting it to **standard work** (a named skill, ideally deterministic/templated). The automated
  "$3 → $0.21" move.
- **The substitutability-gated candidate filter** — candidate score = **cost × repetition**, gated
  by a **substitutability** signal (Acceptance Bar stage 1+3): propose only where output **variance**
  across repetitions is low *and* the Skill-Lab check-pass-rate stays high. Frequency ≠ value.
- **Post-mortems** — the Analyst distills each run's journal into a `post_mortems` row the candidate
  filter reads.

### In Scope — Phase 2: HITL preference loop (selection-triggered, taste axis)

The cheap middle; the data is already journaled, so it needs **no new ingestion infra** and is
available from day one of any HITL flow. Build it **before** market
([`docs/feedback-loops.md §4`](../../docs/feedback-loops.md)).

- **HITL trigger** — already-journaled human decisions (`hold` selections, `rank` picks, and
  **reject + reason/managerial note**, keyed to the card by correlation ID) become a proposed
  **rubric tune** for the critic (toward what humans keep picking), and may tune the `rank` shortlist.
- **Capture operator identity** — record *who* made each HITL decision (non-backfillable insurance).
- **The loop retires its own gate** — when the human stops overriding the critic, the loop proposes
  dropping the `hold` to auto-proceed; when overrides persist, it surfaces the miscalibration and the
  gate stays. (Gate retirement is itself a mutation and clears the Acceptance Bar — §10 open Q.)

### In Scope — Phase 3: Defect closure (escaped-defect-triggered, correctness axis)

The second axis. Also journal/VCS-only — no attribution infra — so it is **cheap and ships before
market**. The signal is a **defect that escaped the in-flow check** and was caught later.

- **Defect trigger** — a structured finding (a code-review item, a CI failure, an incident) is
  joined to the **card** that produced the offending code, and through the card to **the check that
  passed it**. A defect *class* that **recurs** across runs proposes **strengthening that check** — a
  sharper rubric clause or a new **deterministic Hook** — *tightening only*.
- **The capture path (worked example — code review over a squashed PR).** Conduit's coding flows
  (A(i)-Team) emit **one squashed commit per PR**, which erases per-card attribution from `main`. So
  defect closure relies on two captures, neither of which depends on git history surviving the squash:
  - **Durable map — the journaled write-set.** The MARK_DONE integrity gate already computes each
    card's *actual* file write-set (writes ⊆ `owned_paths`). Journaling that write-set gives a
    permanent `file → card` map, independent of git. This is the source of truth.
  - **Capture-time convenience — the `Card:` micro-commit trailer.** Each card's loop may end with a
    **micro-commit on the feature branch** carrying a `Card: <correlation-id>` (+ `Attempt:`,
    `Station:`) trailer — *the same correlation ID the journal uses*, so git and journal share one
    join key. While the branch is unsquashed, `git blame` → micro-commit → card gives **ground-truth,
    line-level** attribution (finer than `owned_paths`, which is declared intent). The squash to
    `main` keeps history clean; nothing durable is lost because the write-set + finding are already
    journaled. (A `git commit` is **effectful** → route it through the outbox + idempotency key
    `card_id+attempt` so replay never double-commits — [SPEC §5](../../SPEC.md#5-cards-the-station-transaction--checkpoint-soundness).)
- **Reviewer identity (human or agent).** Record *who/what* produced each finding — the
  defect-axis analogue of operator identity — because an LLM reviewer has its own
  hallucination/bias profile worth recency-weighting and verifying (Acceptance Bar stage 1).
- **Object vs. meta — do not conflate.** A *single* finding is fixed as ordinary `check → rework`
  (§6, already covered by the kernel). Only a **recurring** defect class becomes a *meta* mutation
  that strengthens the check. Only the meta signal goes through the pipe.

### Out of Scope (deferred)

- **Market-feedback learning (outcome-triggered).** Needs attribution infrastructure *and* a flow
  that reliably produces cheap assets. When it lands it starts with the **deterministic CSV-first
  push ingest** (schema-validated, no agentic surface), and **ingest/observe ships before mutate**.
  Fully specified in [`docs/feedback-loops.md §5`](../../docs/feedback-loops.md).
- **The `market` check kind** and any external grader / attribution plumbing
  ([SPEC §17 F3](../../SPEC.md#17-future-watch-tracked-not-yet-designed)).
- **The operator-weighting math** — the decay / weighting of a noisy, drifting human signal; parked
  until real multi-operator data exists (capture identity now, do the math later).
- **Any loosening or retirement of a `risk` gate.** Out of scope by design, permanently.

## 6. Requirements

Requirements describe observable *behavior*; mechanism lives in `SPEC.md §13` and
`docs/feedback-loops.md`.

### Functional Requirements

1. The Analyst **shall** observe the journal / `post_mortems` / joined signals and emit proposed
   improvements as rows in the `mutations` table; it **shall not** alter a flow directly — every
   change goes through the pipe.
2. A proposed mutation **shall** clear the **Acceptance Bar** (FR-11) **and** a human `hold` gate
   before it is applied to a flow. No code path **shall** apply a mutation that skips either.
3. The frequency trigger **shall** identify **repeated** work units and score candidates by
   **cost × repetition**, and **shall** propose promotion only for candidates whose output
   **variance** is low **and** whose Skill-Lab check-pass-rate stays high. Frequency alone **shall
   not** promote.
4. An approved mutation **shall** be **versioned**, rolled out behind a **canary**, and **watched**
   post-promotion for check-pass / rework-rate regression, with a **rollback path** that restores the
   prior version in one step.
5. The HITL-preference trigger **shall** read already-journaled human decisions keyed by correlation
   ID and **shall** require **no new ingestion infrastructure**.
6. Every HITL decision **shall** record the **identity of the operator**, and every defect finding
   **shall** record the **identity of the reviewer** (human or model/tool), captured at decision
   time (non-backfillable).
7. A HITL-driven proposal **shall** be gated on **volume + consistency**; a defect-closure proposal
   **shall** be gated on **recurrence** of the defect class. Neither **shall** be raised from a single
   occurrence.
8. A **taste** mutation **shall** tune only the critic's rubric / generator prompts / `rank`
   shortlist; a **defect-closure** mutation **shall** only **strengthen** a check (rubric clause or
   new Hook). Neither **shall** alter routing, bounds, or the Law, and **no** mutation **shall**
   loosen or retire a `risk` gate.
9. The HITL loop **shall** measure its own necessity: it **shall** be able to propose **retiring its
   own gate** when the human consistently picks the critic's top choice, and **shall** surface
   miscalibration (gate stays) when the human consistently overrides.
10. Mutations **shall** record provenance (which prompt version / rubric / model / skill / **check**
    the proposal derives from) so an approver sees the lesson, not just the change.
11. Every mutation **shall** clear the five-stage **Acceptance Bar** (§5a) — signal sufficiency
    (incl. verification of noisy signals), class correctness, **backtested improvement over the
    incumbent on held-out data**, human gate, and canary with a regression threshold — **regardless
    of which trigger raised it**. A mutation that improves only on the signal it was derived from
    **shall not** be promoted.

### Non-Functional Requirements

1. **Mutations are never auto-applied** ([SPEC §13 M7](../../SPEC.md#13-continuous-improvement-kaizen)).
   Every mutation **shall** be human-gated, versioned, canary'd, watched for regression, and
   reversible. A loop that silently rewrites itself is a release blocker.
2. **Learning tunes taste and tightens checks; it never loosens risk.** Taste mutations **shall**
   adjust only `taste`-class gates. Defect-closure mutations **shall** only **tighten** a check —
   *tightening a check because a defect escaped is the point of the loop, and is permitted on any
   class.* What is forbidden is **loosening or retiring a `risk` gate** (brand/safety/legal/
   compliance), which **shall** stay hard regardless of signal strength. "It converts / a human liked
   it" **shall never** override a risk reject.
3. **Observe before mutate.** Within every trigger, getting the signal in and joined **shall** be
   useful on its own and **shall** ship before the mutation step that acts on it.
4. **No promotion on a narrow signal.** A single passing Hook-test, a single pick, or a single
   finding **shall not** alone justify a promotion; the Acceptance Bar (recurrence + backtest) and the
   human gate both apply (reconcile with Principle 9 — fail-closed escalation).
5. **The journal is read, not corrupted.** The pipe **shall** consume the append-only journal and
   **shall not** mutate historical journal rows; fitness/cross-run state lives **outside** the per-run
   journal.
6. **Reversibility is mandatory.** Any applied mutation **shall** be rollback-able to the prior
   version in one step, and a regression watch **shall** flag a promotion that degrades check-pass /
   rework rate.
7. **Acceptance thresholds are explicit and declared.** The Acceptance Bar's thresholds (recurrence
   N, margin-over-incumbent, canary fraction, regression trip) **shall** be **declared config**,
   inspectable and per-flow tunable — never implicit constants buried in the Analyst.

### Edge Cases & Error States

- **Frequent-but-high-variance candidate** → substitutability gate **rejects** the promotion.
- **A promoted mutation regresses check-pass rate** → canary regression watch flags it → **rollback**.
- **A proposal off one operator's few picks / one reviewer's single finding** → recurrence +
  volume/consistency gate **blocks** it.
- **An LLM reviewer hallucinates a finding** → the verification/confidence pass (Acceptance Bar
  stage 1) **drops** it before it can mutate a check; unverified findings never promote.
- **A mutation that scores well on its training signal but fails the held-out backtest** → Acceptance
  Bar stage 3 **rejects** it — improvement must generalize.
- **A defect-closure proposal that would loosen/retire a risk gate** → rejected at class-correctness
  (stage 2); defect closure may only tighten.
- **A human reject of an off-brand asset mistaken for taste** → it is a **risk** signal, not taste;
  it **shall not** be folded into a taste-rubric tune (NFR-2).
- **A finding cannot be joined to a card** (write-set missing / squash erased the trailer before
  capture) → the Analyst records the finding unjoined and proposes nothing; surfaces the broken
  capture path rather than guessing a card.
- **Conflicting / unreadable signal** → the Analyst escalates to `hold` with `needsJudgment`
  (Principle 9) and proposes nothing.

## 7. Design Principles

- **The check is the quality engine — so improving the check compounds.** Taste calibration sharpens
  *what* the check rewards; defect closure sharpens *what* it catches. Both improve the exact thing
  that makes the flow-shop produce quality.
- **One bus, two axes.** Kaizen is an open signal bus. Taste calibration moves along the
  critic→human→market cascade (bidirectional); defect closure moves along the escaped-defect axis
  (tightening only). HITL is one trigger on the bus, not the definition of it.
- **The signal is the escape distance.** A defect caught post-hoc that the in-flow check missed is a
  lesson *about the check*. This mirrors HITL "measuring its own necessity" — there, agreement lets a
  gate **retire**; here, an escape tells a gate to **tighten**. Same self-measuring loop, opposite
  direction.
- **Each cheap signal is a proxy for the next, truer one.** Lean on the cheap signal for volume; use
  the expensive one sparingly to keep the cheap one honest
  ([SPEC Principle 3](../../SPEC.md#2-design-principles)).
- **Learning tunes taste and tightens checks; it never loosens risk.** Tightening on an escaped
  defect is the goal; loosening or retiring a risk gate is forbidden regardless of signal strength.
- **One Acceptance Bar, no exceptions.** Every mutation, whatever its trigger, clears the same
  quantitative bar — sufficient (and verified) signal, class-correct, **better than the incumbent on
  held-out data**, human-approved, canary-proven. Acceptance is a threshold, not a hunch.
- **Never auto-apply; escalate ambiguity.** Mutations are proposed, gated, versioned, reversible;
  contradictory or unreadable signal pauses to a human and proposes nothing.
- **Observe before mutate; the loop is just a flow.** Getting signal in and joined is useful on its
  own; the Analyst runs on the same kernel as everything else.

## 8. Solution Approach

Kaizen is **one pipe and one Acceptance Bar over an open signal bus**, built in cost order. The pipe
never changes a flow directly: the Analyst — itself a flow Conduit runs on itself — reads what the
kernel already recorded (the journal, the chain-of-custody, the journaled human decisions, the
integrity-gate write-set), writes proposed improvements into the `mutations` table, and routes each
through the Acceptance Bar to a human `hold` gate. A human approves; only then is the change applied —
versioned, behind a canary, watched for regression, with a rollback path.

**Phase 1** harvests the cheapest signal: **repetition**. Repeated low-variance work becomes a
candidate for **standard work**; the candidate filter scores `cost × repetition` but is gated on
substitutability so work that merely happens often is not promoted.

**Phase 2** harvests **human taste** (the taste axis). Every HITL selection and reject is already on
disk, keyed to its card — no ingestion infra. It tunes the critic's rubric toward what humans keep
picking, gated on volume + consistency, and measures its own necessity.

**Phase 3** harvests **escaped defects** (the correctness axis). A structured finding is joined to
the card (via the journaled write-set; conveniently, the `Card:` micro-commit trailer while the
branch is unsquashed) and to the check that passed it. A *recurring* defect class proposes
**tightening that check** — a sharper rubric clause or a new deterministic Hook. The worked example
is a branch-vs-main code review over A(i)-Team's one-squashed-commit PR; the squash is why the
durable join is the journaled write-set, not git history (§5 Phase 3).

**Market feedback is deferred** — it needs attribution infra and a producing flow; CSV-first push
ingest, ingest before mutate ([`docs/feedback-loops.md §5`](../../docs/feedback-loops.md)).

Throughout, three invariants are absolute: **no mutation is ever auto-applied**, **every mutation
clears the same Acceptance Bar**, and **learning never loosens a risk gate**.

## 9. Technical Considerations / Dependencies

**Depends on the shipped MVP kernel** ([`mvp-kernel.md`](../done/mvp-kernel.md)) for everything it
learns from:

- **The journal + chain-of-custody** (`journal`, `work_summaries`, per-station cost attribution;
  [SPEC §11](../../SPEC.md#11-persistence--the-journal-of-truth-conduitsqlite)) — the **provenance**
  join (`asset ↔ prompt/rubric/model/skill/check`) is already there.
- **The integrity-gate write-set** ([SPEC §6](../../SPEC.md#6-the-quality-system)) — MARK_DONE already
  computes each card's actual file writes (⊆ `owned_paths`); journaling it gives the durable
  `file → card` map defect closure joins findings through (no dependency on git history).
- **The `mutations` and `post_mortems` tables** (journal DB) — proposed mutations and run summaries.
- **The Skill Lab** ([SPEC §14](../../SPEC.md#14-the-work-bench)) — runs a candidate against
  held-out mock/fixture data to measure the **backtested improvement** (Acceptance Bar stage 3) and
  is the substrate for the canary.
- **The HITL channel** ([SPEC §4A](../../SPEC.md#4a-channels--the-flows-edges-triggers-hitl-delivery))
  — selections/picks/rejects already journaled; the loop only needs **operator identity** added.
- **The `hold` lane + `check` stations** — the pipe reuses the kernel's human-gate and check
  primitives; the Analyst is a flow, not new control surface.
- **The effectful outbox** ([SPEC §5](../../SPEC.md#5-cards-the-station-transaction--checkpoint-soundness)) — if the defect-closure
  capture path emits per-card micro-commits, the `git commit` is effectful and rides the outbox +
  idempotency key (`card_id+attempt`) so replay never double-commits.

**Constraints / integration points:**

- **Fitness / cross-run state lives outside the per-run journal** — relevant when the market loop
  lands; never write learning state into the append-only journal.
- **Operator identity and reviewer identity are non-backfillable** — like `tag_assets`, capture them
  now or the signal is lost.
- **Squash erases git-side provenance** — the durable join must be the journaled write-set; the
  `Card:` trailer is a capture-time convenience only, valid pre-squash.
- **Single host** carries over from the kernel; the pipe adds no multi-host assumption.

## 10. Risks & Open Questions

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| A loop silently rewrites itself (no human in the loop) | Low | High | NFR-1 + FR-2: no apply path bypasses the Acceptance Bar **and** `hold` gate; every mutation versioned + reversible |
| Frequency mistaken for value → high-variance station templated, quality drops | Medium | High | Substitutability gate (variance + Skill-Lab check-pass-rate); frequency alone never promotes |
| A mutation graded on its own training signal regresses in production | Medium | High | Acceptance Bar stage 3: backtest on **held-out** data + margin-over-incumbent before any canary |
| A promoted mutation regresses check-pass / rework rate | Medium | High | Canary + post-promotion regression watch + one-step rollback |
| Noisy defect signal (LLM hallucination, CI flake) mutates a check against a phantom defect | Medium | High | Acceptance Bar stage 1: recurrence + verification/confidence pass; single/unverified findings never promote |
| A defect-closure mutation drifts into loosening a risk gate | Low | High | Class-correctness (stage 2) + NFR-2: defect closure may only tighten; risk gates never loosened |
| Rubric overfit to one operator's / one reviewer's noisy taste | Medium | Medium | Capture operator + reviewer identity now; volume/consistency + recurrence gates; recency-weight in principle |
| Findings cannot be joined to cards (capture path broken by squash) | Medium | Medium | Durable join is the journaled write-set, not git; `Card:` trailer captured pre-squash; unjoinable findings surface, never guess |
| Attribution ID lost downstream before the market loop is built | Medium | High | `tag_assets` stamps a stable ID now; verify survival across every hop |

### Open Questions

These overlap the "Still open" items in
[`docs/feedback-loops.md`](../../docs/feedback-loops.md) — parked until a producing flow and real
data exist:

- **The Acceptance Bar thresholds.** The concrete numbers — recurrence N per trigger, the
  margin-over-incumbent that beats noise, the canary fraction and the regression trip that auto-rolls
  back vs. human-flags — to firm up against the first real promotion of each trigger.
- **Verification depth for noisy defect signals.** How hard to verify an LLM/CI finding before it
  counts toward recurrence (single re-check vs. adversarial panel) — calibrate against real
  false-positive rates once a reviewer is feeding the loop.
- **The operator-weighting math.** Decay / weighting of a noisy, drifting, multi-operator (and now
  multi-reviewer) signal needs real data; identity captured now, math deferred.
- **An ADR for the open-signal-bus + two-axis model and HITL-as-a-trigger.**
  [SPEC §13](../../SPEC.md#13-continuous-improvement-kaizen) carries the model; the standalone ADR
  should wait until the first non-frequency trigger is exercised against real signal.
- **Where the gate-retirement decision is gated.** "Retire the HITL gate" is a mutation too; confirm
  it clears the Acceptance Bar (it must) and what evidence bar it carries.

## 11. Rollout & Phasing

Kaizen is **explicitly phased** — triggers ship in cost-to-capture order, and within each,
**observe before mutate**. The Acceptance Bar (§5a) is built **with Phase 1** and reused unchanged by
every later trigger.

- **Phase 1 — Skill crystallization (frequency).** Journal-only. Stand up the Analyst-as-a-flow, the
  `mutations` + `post_mortems` consumption, the substitutability-gated candidate filter, **and the
  Acceptance Bar**. Ship **observe first** (surface candidates a human can read) before **mutate**.
- **Phase 2 — HITL preference (selection, taste axis).** No new ingestion infra. Add **operator
  identity** (non-backfillable — as early as possible), then the volume+consistency-gated rubric-tune,
  then the gate-retirement signal. **Build before market.**
- **Phase 3 — Defect closure (escaped-defect, correctness axis).** Journal/VCS-only. Add the
  **journaled write-set** (`file → card`) and **reviewer identity**; capture structured findings
  (code review / CI), gate on **recurrence + verification**, propose **check-tightening** only.
  The `Card:` micro-commit trailer ships here as a capture-time convenience (effectful → outbox).
  Cheap; ships **before market**.
- **Deferred — Market feedback (outcome).** Not built here. CSV-first push ingest → join on asset ID
  → store fitness outside the journal (latest-wins) — **ingest before mutation**. Fully specified in
  [`docs/feedback-loops.md §5`](../../docs/feedback-loops.md).

**Rollback / stop criteria:** if the human gate, the **Acceptance Bar's held-out backtest**, or the
regression watch + rollback path cannot be made reliable, the pipe is **not shippable** —
auto-applied, ungated, or irreversible mutations are precisely the failure mode this PRD exists to
prevent. No trigger advances until its mutations are provably bar-clearing, human-gated, versioned,
and reversible.
