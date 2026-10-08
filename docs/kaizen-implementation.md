# Building Kaizen from Delivered Outcomes

**Status: implementation proposal for public review.** No outcome-learning
capability described here is shipped. This proposal builds on the
[feedback-loop design](./feedback-loops.md) and [Kaizen draft](../prd/drafts/kaizen-pipe.md).
It proposes changes to their sequencing and evidence policy; it does not
supersede the specification or authorize automatic changes to production flows.

Discuss the proposal and track implementation in
[issue #119](https://github.com/theaiteam-dev/conduit/issues/119).

Conduit already revises artifacts within a run using inspection findings. Kaizen
would use evidence across runs to help improve the production process itself.
The shared lifecycle is:

```text
observe -> attribute -> diagnose -> propose -> evaluate -> approve -> monitor
```

The implementation should combine a small evidence layer with ordinary Conduit
flows for analysis and evaluation. Each project supplies its signal adapters,
interpretation rules, and acceptance criteria. Adding a new signal should not
require changing the core improvement lifecycle.

## Different Signals, One Lifecycle

| Project | Observation | Possible lesson | Interpretation limit |
|---|---|---|---|
| Nitpick, a code-review flow | A finding was accepted, dismissed, or addressed | Improve correctness, relevance, clarity, or duplicate detection | A resolved discussion is not necessarily acceptance; silence is unknown |
| Autocut, a video-production flow | Views, watch time, clicks, or attributed sales | Improve creative choices under comparable conditions | Audience, distribution, spend, and offer affect performance |
| A(i)-Team, a software-production flow | A confirmed defect is linked to a shipped change | Improve implementation instructions, tests, or review checks | A bug can have several contributing changes; no reported bugs is not proof of correctness |

Preserve observations and their context. A common ingestion envelope should not
collapse these signals into a universal quality score. Interpretation produces
evidence for a hypothesis; an evaluation determines whether a proposed change
deserves promotion.

## 1. Identify the Work That Leaves the Flow

Introduce three records with identities scoped to a project:

| Record | Minimum purpose |
|---|---|
| Artifact revision | Identify an exact output and its producing run, card, station, and attempt; retain a content hash and retrievable content reference |
| Production bundle | Retain the flow, prompts, schemas, model settings, and input references used for production, including critic configuration |
| Delivery receipt | Map an artifact revision to an external destination and subject, such as a PR comment, video, commit, or release |

The existing journal provenance and checkpoint bindings are starting points.
A binding hash alone cannot reconstruct a historical configuration. Keep actual
configuration content or durable content-addressed references, including custom
worker code versions where applicable. Credentials remain runtime references,
not bundle contents. Reproducing the setup does not guarantee identical model
output or continued availability of a provider model.

An artifact can have multiple deliveries: the same video may appear on several
platforms. A batch can also contain multiple independently assessed subjects:
each review finding needs an identity, even when a station emits one JSON file.
Track revision lineage so feedback on an earlier published version does not
silently attach to a later revision.

Delivery receipts need the same retry discipline as delivery itself. A retry
must not manufacture a second logical delivery, and an external send whose
result is uncertain must remain explicitly unresolved until reconciled.

**Acceptance check:** given a published PR comment, retrieve its finding,
artifact revision, producing run, production bundle, and inspection history.

## 2. Store Observations Independently of Runs

Start with a dedicated SQLite evidence database. Feedback, experiments, and
promotion history span runs and need an explicit retention policy independent
of the execution journal. Retained bundles and evidence must remain usable when
older operational runs are removed; missing retained content should be reported
rather than treated as replayable.

The common observation envelope should carry:

- project, source, source event ID, observation type, and schema version;
- external subject identity and the resolved delivery or artifact identity;
- event time and ingestion time;
- domain-specific payload and source evidence reference;
- an optional reference to an observation it corrects or supersedes.

Use a unique source-event key within each project to deduplicate ingestion.
Keep observations append-only; corrections are new observations. Keep derived
interpretations separate and version the interpretation policy so a later
policy change can be evaluated against the original evidence.

Feedback may arrive before its delivery receipt. Preserve unmatched observations
and expose them for inspection and later resolution. Never guess a join from a
similar title or filename. Ambiguous defect-to-change attribution can require
human confirmation and may involve multiple artifacts.

Different observation types require different aggregation rules. Cumulative
video snapshots of 8,000 and then 10,000 views represent 10,000 total views, not
18,000. Preserve their measurement windows and dimensions. Missing review
feedback remains unknown; it is not a negative label.

The initial ingestion surface should be a validated JSON import and a small
programmatic interface. Add source-specific collectors as needed. Raw feedback
ingestion should not automatically rerun the original production flow.

**Acceptance checks:** duplicate imports, out-of-order delivery receipts,
corrections, project isolation, and cumulative metrics all preserve the intended
meaning without double-counting.

## 3. Ship a Useful Nitpick Evidence Report

Start with one complete use case before generalizing discovery. Report which
kinds of review findings are useful or repeatedly dismissed, grouped by the
configuration that produced them, with inspectable examples.

Capture explicit reasons where available: incorrect, duplicate, unclear, outside
scope, or addressed. Store the source action separately from its interpretation.
Include reviewer identity when available and define who is allowed to provide
authoritative labels for a project.

Show feedback coverage and denominators: PRs reviewed, findings generated,
findings published, findings assessed, and results by category. Acceptance can
rise merely because a reviewer publishes fewer findings. Evaluation therefore
also needs known valid issues that the reviewer should detect.

The first report can be a CLI export with links to supporting evidence. It
should already help a developer improve a flow manually, before any analyst
generates a patch.

**Acceptance check:** inspect a recurring problem and trace every example back
to its source feedback and production configuration.

## 4. Produce Bounded Change Proposals

Run the analyst as an ordinary Conduit flow over a fixed evidence snapshot. Its
structured output should include:

- the problem, supporting observation IDs, and a causal hypothesis;
- the incumbent configuration and a concrete patch;
- the expected benefit and possible regressions;
- the evaluation plan and the evidence needed for promotion.

Begin with one allowed change surface, such as a Nitpick maker prompt or critic
rubric. Model changes and topology changes can follow after the evaluation
process is useful. Changing several variables together makes results harder
to interpret.

An LLM can suggest explanations and changes. Deterministic validation checks
that the evidence exists, the patch applies to its declared base, and only
allowed files are modified. The analyst may return insufficient evidence and
propose no change. Source comments are evidence to analyze, not instructions
that can expand the analyst's permissions.

Example proposal: repeated findings describe issues already addressed elsewhere
in a PR. Add a cross-check before publishing, then measure duplicate findings
and retention of known valid findings.

**Acceptance check:** produce a reviewable patch with linked evidence, without
modifying the deployed flow.

## 5. Give Evaluators a Shared Contract

The evaluation record should identify the incumbent and candidate bundles, the
versioned dataset and evaluator, per-case results, aggregate metrics, resource
usage, and a decision: `pass`, `fail`, or `insufficient_evidence`. Each project's
policy declares the metrics, minimum evidence, improvement margin, and regression
limits before the experiment runs.

| Project | Initial evaluation |
|---|---|
| Nitpick | Compare incumbent and candidate on historical PR cases with known valid findings and false positives; assess correctness, coverage, duplicates, and cost |
| A(i)-Team | Reproduce confirmed defects and assess whether revised production or inspection steps prevent or detect them; include unrelated regression cases |
| Autocut | Check production constraints offline, then assess creative performance through a bounded prospective experiment with comparable distribution conditions |

Separate proposal-development examples from held-out evaluation cases. For
Nitpick, split by PR or related change rather than by individual comments from
the same PR. Keep evaluation labels outside the candidate's production inputs.
Repeatedly tuning against the same held-out set eventually compromises it;
dataset renewal and an untouched final comparison set need explicit ownership.

Run evaluations in isolated workspaces with external effects replaced by
recording adapters. A historical test must not publish comments, send a campaign,
or deploy software. Run incumbent and candidate under comparable conditions,
record model settings, and repeat measurements when variability prevents a
confident decision. Missing inputs or unavailable models produce incomplete
evidence, not a fabricated comparison.

Promptdiff is a candidate implementation for prompt comparisons behind this
contract. Its existing interfaces need inspection before committing to an
integration or duplicating its behavior in Conduit.

**Acceptance check:** a candidate that fixes its motivating example but loses
known valid findings fails evaluation; a result without enough evidence cannot
be promoted as a demonstrated improvement.

## 6. Approve Versions and Observe Their Rollout

For the first release, produce a patch and evaluation report for human review.
Apply approved changes through the existing Git and deployment workflow. Approval
must identify the exact candidate bundle and evaluation; editing the candidate
after evaluation invalidates that approval.

Controlled rollout is a later milestone. Assign new runs to an incumbent or
candidate configuration, persist the assignment, and define the observation
window and regression thresholds before rollout. Existing runs keep their
original bundle. Delayed outcomes may keep a rollout inconclusive for days or
weeks; elapsed time alone is not evidence of improvement.

Rollback directs future runs back to the previous approved version. It does not
undo already delivered artifacts. Automatic rollout or rollback requires an
explicit deployment integration and policy; the initial Git-based review stage
does not provide those capabilities.

**Acceptance check:** any proposed or deployed change has a traceable evidence,
evaluation, approval, and version history, with a known prior version to restore.

## Proposed Build Order

1. Artifact identities, production bundles, and delivery receipts.
2. Observation import, deduplication, attribution, and evidence inspection.
3. Nitpick feedback capture and the first evidence report.
4. One bounded prompt-change proposal plus incumbent/candidate evaluation.
5. Human-approved Git changes with an evaluation record.
6. A(i)-Team confirmed-defect feedback, then Autocut performance observations.
7. Controlled rollout and monitoring once the individual evaluation policies
   have proved useful.

The first end-to-end milestone is: **Nitpick can trace a published comment to its
production configuration, ingest explicit feedback, show recurring problems,
and produce one evaluated prompt-change proposal for human review.**

General skill discovery and automatic topology changes are outside that first
milestone. No new service or separate analyst scheduler is required initially:
ordinary flow invocation can run a batch over imported observations.

## Differences from the Earlier Draft and Questions for Review

The [earlier Kaizen PRD](../prd/drafts/kaizen-pipe.md) starts with frequency-driven
skill crystallization and assumes substantial attribution is already available.
This proposal starts with Nitpick and explicitly builds the artifact/delivery
joins and retained production bundles needed to support external feedback.

It also stages Git-based human review before automatic canary rollout. That first
milestone is narrower than the earlier draft's full promotion contract. Approval
of this direction should be followed by an explicit reconciliation of the PRD
and specification before implementation.

Evidence thresholds should depend on the change. A single confirmed severe bug
can justify adding a regression test; a broad prompt-policy change needs evidence
that it generalizes. This proposes revising the earlier universal recurrence
requirement while retaining evaluation, human approval, and protection against
loosening risk checks.

Questions for public review:

- Is Nitpick the right first complete feedback loop, and which explicit feedback
  actions should its first collector support?
- Which delivery destinations must expose receipts first, and how should custom
  publishing scripts register external identities?
- What retention and export contract keeps evidence useful after operational
  runs are removed?
- What can Promptdiff provide through the evaluator contract?
- What constitutes comparable Autocut experiments, including observation windows
  and the effects of paid distribution?
- Which parts of the earlier Acceptance Bar must remain mandatory in the first
  manual promotion milestone?
