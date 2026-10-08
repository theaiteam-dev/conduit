# Feedback Loops — the calibration cascade

> **Status: design sketch.** This is the fuller treatment behind [SPEC §13
> (Kaizen)](../SPEC.md#13-continuous-improvement-kaizen). §13 now carries the compact
> canonical model — three loops on one pipe (frequency, **HITL preference**, market) plus the
> **calibration cascade** — and points here for the cascade, the joins, the ingest shapes, and
> the open questions, flagged at the end.

Conduit currently uses `work → check → bounded rework` (SPEC §6) to revise
artifacts within a run. It records findings, human selections, and execution
history that developers can inspect when changing their flows.

**The learning system below is planned.** It would connect feedback on delivered
work to its production history, propose improvements, evaluate them, and require
human approval before promotion. Outcome ingestion, attribution, and automated
calibration are not built-in capabilities today. A custom flow can fetch external
data, but its author must supply the collection and analysis logic.

For example, a code-review flow could learn from accepted and dismissed comments;
a video flow could use views and sales. Those signals need interpretation:
dismissal does not always mean a comment was wrong, and video performance also
depends on distribution, audience, and spend. The goal is evidence for evaluated
changes, not automatic prompt updates from a raw metric.

---

## 1. The signal bus — two axes, several signals

Kaizen is an **open signal bus**, not a fixed set of loops: any signal that can be joined to
provenance and proposes a bounded change is a valid trigger. Those signals fall on **two
orthogonal axes**, and the split is load-bearing because it maps onto taste-vs-risk (§6).

**Axis 1 — taste calibration (the cascade).** Up to three sources of signal about whether output is
any *good*, on a latency / fidelity gradient:

| Signal | Latency | Cost to capture | What it measures | Status today |
|---|---|---|---|---|
| **Internal critic** (LLM judge) | instant | cheap | a *proxy* for taste | live — it's the gate (SPEC §6) |
| **HITL selection / reject** | minutes | ~free (already journaled) | real human *taste* | captured, **not harvested** |
| **Market outcome** | days–weeks | needs attribution infra | real *fitness* | deferred (SPEC §13, §17 F3) |

The model is not "three independent loops." The point is that **each cheaper, faster signal
is a learned proxy for the next, truer one:**

- The **critic** is a proxy for the **human** → tune the critic to predict what the human
  picks, and the cheap gate sharpens while the human is bothered less.
- The **human** is a proxy for the **market** → when human taste and market outcome disagree,
  the market is ground truth, and you recalibrate the rubric (and the human's expectations).

This is [SPEC Principle 3](../SPEC.md#2-design-principles) (*check rigor ∝ 1 / (cheapness ·
speed · safety of your external signal)*) read as a **learning hierarchy** rather than just a
check-depth one. Taste calibration is **bidirectional** — it can loosen *or* retire a taste gate as
the cheap signal proves it tracks the truer one.

**Axis 2 — defect closure (escaped defects).** A second, orthogonal kind of signal — not "is this
output to taste?" but "did a *defect* escape the check?":

| Signal | Latency | Cost to capture | What it measures | Status today |
|---|---|---|---|---|
| **Code review / CI / incident** | post-run → days | cheap (journal write-set + VCS/CI) | real *defects* (correctness) | captured ad hoc, **not harvested** |

A defect caught *after* the in-flow check (a branch-vs-main code review, a CI failure, a production
incident — by a human **or an agent**) is a lesson *about the check*: it has a blind spot. Defect
closure adjusts **the check** (a sharper rubric clause or a new deterministic Hook) and is
**monotonic-tightening only** — it never loosens. It is the mirror of the cascade's self-measuring
property: there, agreement lets a gate **retire**; here, an escape tells a gate to **tighten**. Same
loop, opposite direction.

You lean on the cheap signal for volume on both axes, and use the expensive/rarer signal sparingly
to keep the cheap one honest.

---

## 2. One pipe, three triggers

All three feed the same kaizen pipe (SPEC §13):

```
observe → propose mutation → human-gate → apply (versioned, canary, watch for regression)
```

Only the **trigger** differs, and the set is **open** — these are the named ones, not an exhaustive
list:

- **Frequency-triggered** — skill crystallization. Repeated work becomes standard work.
  *(Already specced; needs only the journal.)*
- **HITL-triggered** — accumulated human preference tunes the critic / generator (taste axis).
  *(The cheap middle; see §4.)*
- **Escaped-defect-triggered** — a recurring defect class caught post-hoc (code review / CI /
  incident) tightens the check that missed it (correctness axis). *(Journal/VCS-only, also cheap;
  build before market — see the kaizen PRD §5 Phase 3.)*
- **Outcome-triggered** — market signal drives "more like the winners." *(Deferred; see §5.)*

**Mutations are never auto-applied** (SPEC §13, rev-1 M7), and **every mutation — whatever its
trigger — clears one Acceptance Bar** before it is applied: sufficient (and, for noisy signals,
*verified*) signal → class-correct → **backtested improvement over the incumbent on held-out data** →
human gate → canary with a regression threshold. Acceptance is a declared threshold, not a hunch. A
feedback loop that silently rewrites itself, or one that promotes a change graded only on the signal
that produced it, is a liability, not a feature.

---

## 3. The two joins (the spine)

Learning needs to connect an *outcome* to the *decisions that caused it*. That's two joins,
meeting on a stable asset ID:

1. **Attribution — `outcome ↔ asset`.** Which asset earned which result. This is the **only
   piece that can't be backfilled** (SPEC §17 F3): the stable ID stamped by
   `output.tag_assets` must survive *every* downstream hop (asset → Meta CSV / UTM → ad
   platform → reporting export → back in). Lose it anywhere and you can join nothing — which
   is why tagging is "insurance to take now" even though the loop is deferred.
2. **Provenance — `asset ↔ decisions`.** Which prompt version, rubric, model, and skill
   produced the asset. This already lives in the journal's chain-of-custody (`work_summaries`,
   per-station attribution; SPEC §11) — no new infra.

An outcome on its own (*"this ad won"*) is useless; joined to provenance (*"…and it came from
prompt v7 + the bold-headline rubric"*) it's a lesson. The two joins were designed to
rendezvous on the asset ID — keep them that way.

---

## 4. Loop A — HITL preference (the cheap middle; build this first)

The underrated loop. Everything that makes market feedback expensive, HITL feedback skips:

- **The data already exists.** Every `hold` selection, every `rank` pick, every reject +
  managerial note is already journaled and keyed to the card by correlation ID (SPEC §4A).
  **Zero new ingestion infra.**
- **It's fast and labeled.** Minutes, not weeks — and a **reject reason** is a labeled defect
  *with an explanation*, richer than a market click (an unexplained yes/no). Capture reject
  reasons as structured data, not a bare thumbs-down.
- **It tunes the quality engine directly.** "The check is the quality engine" — learn the
  critic's rubric from human selections and you improve the exact thing that makes the
  flow-shop produce quality.

**What it mutates:** the critic's rubric (so its pre-filter agrees with the human), generator
prompts (toward what humans keep picking), and the `rank` shortlist size / ordering.

**The loop measures its own necessity.** If the human keeps picking the critic's top choice →
the critic is calibrated → the HITL gate can drop to auto-proceed. If the human keeps
*overriding* the critic → it's miscalibrated → surface that. The feedback loop tells you when
to remove the feedback loop.

**Cautions:**

- **Single-operator overfit — capture identity now.** One person's taste isn't ground truth;
  preference is noisy and drifts. Record *who* made each HITL decision (non-backfillable
  insurance, like `tag_assets`); gate mutations on volume + consistency (reuse the
  substitutability filter, §13) and recency-weight. Don't overfit a rubric to one operator's
  Tuesday.
- **Taste only, never risk.** A human *rejecting* an off-brand asset is a hard-constraint
  signal, not a taste preference — see §6.
- **Still human-gated.** "Tune toward the human" is itself a proposed mutation, not an
  automatic rewrite.

---

## 5. Loop B — market outcome (deferred; the data slurp)

The real grader is external — clicks, signups, watch-time. The internal critic degrades to a
cheap **pre-filter**; the fitness function lives downstream. Deferred because it needs
attribution infra *and* a line that reliably produces cheap assets (you can't tune a loop that
isn't producing yet).

**Ingestion has three phases, deferred in increasing-surface order — the same
taxonomy-driven deferral the MVP uses (ADR-0005):**

1. **CSV / Excel export ingest** — a known format, parsed and schema-validated. A
   `deterministic` / `transform` station: **no agentic surface.** Start here (§5a).
2. **API pulls** — poll the ad platform / analytics API. Still mostly deterministic (a known
   API) but adds network egress + auth.
3. **Agentic discovery** — "see what's available, figure out what joins." A tool loop over
   *adversarial external data* (the injection threat model applies) → the **full agentic
   tier**: Law, network namespace, the works. High surface; maybe never.

**Keep even the agentic version Conduit-shaped: bounded sources, discovered contents.** The
builder *declares the sources* (config, validated — "you may read this warehouse / this
export / this feed"); Conduit does discovery *within* those bounds and emits typed output the
kernel validates. Sources are granted and deterministic; relevance-judgment is labor; the join
+ routing is kernel-validated. "Config is validated, not trusted" stays intact — Conduit
doesn't roam, it explores what it's been handed.

### 5a. CSV / Excel ingest — the easy first version

The cheapest useful slice, and the one to build first.

- **It's an outcome-ingress channel, not a new primitive.** A `csv` / `xlsx` adapter on the
  §4A channel model. A file lands (drop folder / upload / email attachment) → triggers a
  **feedback flow** (eat the export → validate → join on asset ID → compute fitness → propose
  mutations → `hold` gate). The learning loop being "just another flow" holds (§7).
- **The join is declared config.** The builder maps columns: *this* is the asset ID (joins to
  `tag_assets`), *these* are the metrics. **Schema-on-read** — a malformed or short export
  **fails loudly**, never silently mis-joins into the fitness store (poka-yoke).
- **Re-imports are the norm.** People re-download reports that overlap prior periods. Reuse
  the `ingress_events` dedup pattern (SPEC §11): key on a row hash `(asset_id, period)` so an
  overlapping re-import is idempotent and never double-counts.
- **Outcome data accrues — store observations, read latest-wins.** The same `asset_id` recurs
  across exports with rising numbers, so append-and-sum silently over-counts. Store each
  observation append-style (timestamped) and have the loop read **latest-wins** per
  `(asset_id, metric)`; the retained observations keep a no-migration path to a time-series if
  richer learning ever wants one.
- **Schema drift fails loud.** A renamed/added column must reject against the declared
  mapping, not guess.
- **Excel is messier than CSV — start with CSV.** xlsx brings sheets, header rows, merged
  cells, `"1,234"`-as-string, date coercion. Treat xlsx as a *normalizing adapter* that emits
  the same internal row schema, with sheet / header-row / column-map declared in config. Don't
  let xlsx-parsing make a deterministic station fragile.
- **Security: never evaluate cells.** Treat every cell as inert data — a value starting with
  `=` / `@` / `+` / `-` is CSV/formula-injection territory. Ingest values; never formulas.

**Decouple "get it in" from "act on it."** The cheap, immediately-useful first slice is just
*ingest → validate → join to provenance → store fitness* — that alone lets a human rank
assets by outcome and see which prompt/rubric produced the winners. The mutation step (propose
"more like the winners," human-gate) is a clean second phase. Don't gate the ingest on the
learning.

---

## 6. Tune taste; tighten checks; never loosen risk

Two directions, one rule. **Taste calibration** tunes **taste** gates (market-replaceable; SPEC §6
`check.class: taste`). **Defect closure** *tightens* a check (any class) when a defect escaped — a
sharper rubric clause or a new deterministic Hook. Both are allowed; **tightening a risk check
because a defect got through is the *point* of the defect-closure loop**, not a violation.

What is forbidden is the *loosening* direction on risk. Learning **never loosens or retires** a
**risk** gate (brand / safety / legal / compliance). You never let "it converts" or "a human liked
it" override a brand-safety reject — an off-brand-but-converting ad is exactly the failure the risk
gate exists to stop, and the market won't catch it in time. So the rule reads precisely:
**loosen/retire ⊆ taste only; tighten ⊆ any class.** Risk gates stay at least as hard as they are,
regardless of how cheap or strong the signal gets.

---

## 7. The loop is a flow

The intended implementation is a feedback flow: ingest outcome or human-review
data, analyze it, emit proposed mutations, evaluate them, and ask for human
sign-off. Existing execution primitives could run those steps, but the ingestion,
attribution, evaluation, and promotion behavior still needs to be built. This is
a proposed use of Conduit, not a shipped kaizen flow.

---

## 8. Sequencing

Where these land relative to [the build order](./build-order.md#after-the-mvp):

1. **Skill crystallization** (frequency) — first kaizen loop; journal-only. Ships the **Acceptance
   Bar** the later triggers reuse.
2. **HITL preference** (taste axis) — the cheap middle; data already journaled, no attribution
   infra, available from day one of any HITL flow. **Build before market.**
3. **Defect closure** (correctness axis) — escaped defects (code review / CI / incidents); journal
   write-set + VCS/CI only, no attribution infra. Recurrence-gated, verification-gated,
   tightening-only. Also **before market**.
4. **Market — CSV/Excel ingest** (Loop B phase 1) — deterministic; ingest + join + store
   before any mutation.
5. **Market — API pulls** (phase 2), then **agentic discovery** (phase 3) — only if the cheaper
   ingest can't keep up.

Within each: **ingest/observe before mutate.** Getting the signal in and joined is useful on
its own; acting on it is a separable, later step.

---

## Resolved (provisional)

Settled 2026-05-31, ahead of a producing flow — revisit when real data exists:

- **Ingest is push, not pull.** Data is pushed at Conduit (file drop / upload / email / a
  webhook) and triggers a feedback flow — no scheduler, no source-polling. Pairs with the
  CSV-first phase; *pull* arrives later with the API-ingest phase (§5).
- **Fitness data lives outside the journal.** A dedicated store keyed by asset ID — a new
  table in the state-DB family, or its own DB — **never** the append-only, retention-compacted,
  per-run journal. Fitness data is cross-run, updatable, and outlives retention; the journal is
  none of those. (Table-vs-own-DB is a build-time detail.)
- **Latest-wins read semantics, observations stored append-style.** Each pushed observation is
  a row (`asset_id, metric, value, observed_at, source`); identical re-imports dedup on
  `(asset_id, period)`; the loop reads **latest-wins**. Keeping the observations preserves a
  no-migration path to trajectory-based learning later, and sidesteps append-and-sum
  over-counting.
- **Operator overfit — capture + guardrails now, weighting math later.** Record **operator
  identity** on every HITL decision (non-backfillable insurance, like `tag_assets`); gate
  mutation proposals on **volume + consistency** (reuse the substitutability filter, §13); and
  **recency-weight** in principle (taste drifts).

## Still open

- **The operator-weighting math** — the actual decay / weighting of a noisy, drifting human
  signal needs real multi-operator data. Parked until a producing flow exists.
- **An ADR for HITL-as-a-kaizen-trigger** — §13 carries the model; the standalone ADR waits
  until the loop is actually exercised.

---

## References

- SPEC: [§13 Kaizen](../SPEC.md#13-continuous-improvement-kaizen) (the one pipe; frequency +
  market triggers), [§6 quality system](../SPEC.md#6-the-quality-system) (check kinds/classes,
  taste vs risk), [§4A channels](../SPEC.md#4a-channels--the-flows-edges-triggers-hitl-delivery)
  (ingress/egress adapters, HITL over a channel), [§11 persistence](../SPEC.md#11-persistence--the-journal-of-truth-conduitsqlite)
  (`ingress_events` dedup, `tag_assets`, journal provenance), [§17 F3](../SPEC.md#17-future-watch-tracked-not-yet-designed)
  (non-backfillable attribution), [Principle 3](../SPEC.md#2-design-principles).
- ADRs: [ADR-0005](../adr/0005-station-taxonomy.md) (why CSV ingest is the cheap tier and
  agentic discovery is deferred), [ADR-0006](../adr/0006-telemetry-and-cost-attribution.md)
  (the journal as the source of fitness/cost truth).
