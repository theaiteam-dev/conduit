# Glossary

Every term Conduit uses, in one place. Definitions here match the code and
[`SPEC.md`](../SPEC.md) — when a doc and this glossary disagree, file a bug.

Terms are grouped by subsystem; **bold** marks the canonical term, *italics* mark
accepted synonyms. Cross-references point at the SPEC section that owns the concept.

---

## Core objects

**flow** — a production line: the complete routing definition in `flow.yaml` (stations,
checks, budgets, terminal lanes). The flow is config, not code; the kernel validates it
at load and refuses to run an illegal one. (SPEC §2, §4)

**flow_version** — an integer bumped on any `flow.yaml` edit, pinned at run start. Part
of every checkpoint's binding stamp, so editing a flow mid-run invalidates checkpoints
rather than silently mixing two routings. (SPEC §5)

**card** — the unit of work moving through a flow; the kanban card. Carries `goal`,
`outputs` (owned paths), `depends_on[]`, `attempt`, plus the kernel fields `lane`,
`status`, `owned_paths`. An epic is a parent card; its fan-out children are task cards.
(SPEC §3)

**lane** — *where* a card is: either a station id from `flow.yaml` or a kernel lane.
One of the two orthogonal fields of the state machine. (SPEC §3)

**kernel lanes** — the lanes the kernel owns regardless of flow config: `intake` (entry,
before the first station), and the terminals `done`, `scrap`, `hold`.

**status** — *how far along* a card is within its lane; the scheduling sub-state,
orthogonal to `lane`. Universal across all flows:
`waiting → ready → claimed → working → done_pending_ack`, plus `interrupted`, `held`,
`awaiting_children`, `scrapped`. (SPEC §3)

**station** — a work-cell: a lane with a worker (and optionally a check) attached. Defined
as one entry in `flow.yaml`'s `stations:` list. (SPEC §4)

**worker** — the labor at a station: an LLM call, an agentic LLM loop, or a deterministic
command. Workers produce and judge; they never decide routing — that's the kernel's job.

**wave** — operationally, all cards sharing a `parent_id`. The unit of subtree budgeting:
per-wave token/dispatch caps scrap one subtree without halting the run. (SPEC §6)

**terminal lane** — a lane a card never leaves: `done` (shipped), `scrap` (rejected),
`hold` (parked for a human). Declared per flow via `terminal_lanes:`.

---

## Station taxonomy

Every station is classified on two orthogonal axes. (SPEC §4, ADR-0005)

**kind** (axis 1 — how it executes):

- **deterministic** — no LLM; a command or function (`ffmpeg`, `git`). Allowlist-checked
  before spawn.
- **transform** — exactly one LLM call, typed data in / typed data out, **no tools, no
  loop**. Most critics and briefers. A transform-only flow ships without any agentic
  safety surface.
- **agentic** — an LLM with Read/Write/Bash in a multi-turn loop (the Tool-Bridge,
  build step 9). The only kind the Law applies to.

**effectful** (axis 2 — `true | false`):

- **pure** — replays cleanly from a checkpoint; safe to re-execute.
- **effectful** — a billed call or irreversible side effect (image-gen, git commit,
  publish). Requires the outbox + idempotency key; never blind-retried.

**check kinds** (the QC station attached to a worker):

- **gate** — pass/fail with findings; reject routes the card down a back-edge.
- **rank** — don't converge to one: curate/score a short-list. Terminal is a selection,
  by a human via `hold` or by a downstream station.
- **market** — external signal (e.g., ad performance) replacing an internal critic.

**check class** — `taste` (market-replaceable judgment) vs. `risk` (mandatory — e.g.,
brand safety — stays hard regardless of signal). (SPEC §6)

**adapter** — the pluggable boundary a deterministic station calls through (e.g.,
`meta-ads-csv`) or the model-gateway client a transform calls through.

---

## The state machine & dispatch

**(lane, status)** — the two orthogonal fields that fully describe a card's position.
Routing changes `lane`; scheduling changes `status`. All legal moves live in one
transition table (`src/statemachine/transitions.ts`); the executor routes every
post-work move through it. (SPEC §3)

**dispatchable** — a card is dispatchable iff `status = ready` AND its lane is a work
station AND the station is under its WIP cap AND a worker slot is free — ANDed in a
**single atomic SQLite transaction** (the claim). (SPEC §3)

**claim** — the atomic transaction that takes a `ready` card to `claimed` and binds it to
a worker slot. The atomicity is what makes two workers never grab the same card.

**tick** — one pass of the deterministic planner: read state, compute the legal action
plan, execute it. No LLM is ever in this loop. (SPEC §8)

**WIP cap** — per-station concurrency limit (`wip:` in `flow.yaml`). Never a global sum;
each station pulls work only when it has capacity (the pull system).

**done_pending_ack** — the status between "the worker finished" and "the kernel
acknowledged and routed the result". Crash-recovery treats it as work-complete,
routing-incomplete.

**generation-keyed action ID** — idempotency key for dispatch actions that encodes the
card's rework generation (`flow:card:dispatch:g<attempt>:worker:seq`). Dedup keyed on
the generation allows legitimate re-dispatch after a rework bounce while suppressing
duplicates of the same attempt. (SPEC §10)

---

## Checkpoints & recovery

**checkpoint** — the persisted output of a completed station, keyed by its binding stamp.
On resume, a completed station is skipped **only if the stamp matches**. (SPEC §5)

**binding stamp** — `hash(model_id, prompt_template_version, input_artifact_hashes,
flow_version)`; rework feedback is hashed into the input set too. Any change to anything
that could change the output invalidates the checkpoint. (SPEC §5)

**outbox** *(intent log)* — the table where an effectful station writes a pending intent
**before** firing the side effect, and commits it after. A crash between the two
fail-closes to `hold` for human reconciliation — never a blind retry of a publish or a
billed call. (SPEC §5)

**idempotency key** — the stable key an effectful call carries so the receiving system
(or the outbox) can dedup a retry of the same logical effect.

**exactly-once** — the recovery guarantee for effectful stations: an effect either
verifiably happened once or the run escalates; it is never silently repeated.

**resume** — restarting a run from persisted state: checkpoints with matching stamps are
skipped, pending outbox intents are reconciled, `interrupted` cards are recovered.

---

## The quality system

Quality comes from **work → check → bounded rework**, not from one smart call. (SPEC §6)

**check** *(quality gate, QC station)* — the LLM critic attached to a station, usually a
pure transform, with a back-edge to an earlier lane. Keep the maker and the inspector
separate: different prompt, often a different model.

**integrity check** — the *deterministic* validation in the DONE transaction (touched
files ⊆ owned paths, output schema valid). Distinct from the quality check — one is
mechanical, the other is judgment. (SPEC §5, §6)

**back-edge** — the reject route from a check to an earlier station (`on_reject:`).
Validated against the lane graph at load.

**skip_when** — a station-level predicate (`{ source: seed | output, field, equals }`)
the kernel evaluates when a card becomes ready at the station. On a match the card moves
to the station's `next` through the `SKIP` event without the station running: no worker,
no checkpoint, no counter spent. An unreadable predicate holds the card. (SPEC §3, §4)

**rework** — a card bouncing down a back-edge to be redone with the critic's findings as
feedback. Bounded by four independent guards (below).

**the four rework guards** — (1) per-card `rework_cap` → scrap; (2) per-card
`max_execution_attempts` (parse/integrity retries); (3) **progress monotonicity** — the
findings hash must change between attempts, else no progress is being made and the loop
stops; (4) budgets at card/wave/run scope plus the liveness watchdog. (SPEC §6)

**findings hash** *(progress signal)* — a hash over the critic's findings array (order-
insensitive), **not** over the artifact. An artifact can churn forever; identical
findings on consecutive attempts mean the rework loop is spinning.

**cap_policy** — what happens when `rework_cap` is exhausted: `scrap` (default) or
`proceed_with_findings` (ship it, attach the unresolved findings).

**scrap** — the terminal lane for rejected work; the scrap bin. Scrapping a parent's
subtree (`scrap_subtree`) kills its children too.

**fan-out** — one card expanding into N child cards (`fan_out: N`), e.g., variants or
decomposed tasks. Children get disjoint `owned_paths`, validated at expansion. (SPEC §9)

**fan-in** — the join: a downstream station that collects a parent's children. Its
failure policy defines what a scrapped child does to the parent:
`all` (one scrap holds/scraps the parent), `quorum(k)`, or `best_effort`. (SPEC §6)

**k (quorum)** — an **integer count**, `1 ≤ k ≤ fan_out`: the minimum number of children
that must reach a non-scrap terminal for the fan-in to proceed. A count, not a ratio.

**no_selection_policy** — what a rank station does when no selection is recorded by
timeout: e.g., `scrap`. (See the branching example.)

**materialize: on_approval** — plan-first QC / just-in-time: produce the expensive
artifact (image, render) only after its cheap proxy (the prompt) passes the check. A
post-materialize reject routes back to the *proxy* station, not to re-materialization.
(SPEC §6)

---

## Control & safety

**andon** *(consumption andon)* — the runaway halt: per-run wall-clock + token budgets.
On trip, new claims stop; in-flight workers complete-and-checkpoint (soft ceiling — the
alert reports overshoot). Named for the lean andon cord: anyone stops the line. (SPEC §8)

**liveness watchdog** — the *other* andon: trips on "no card changed lane for N minutes
AND no worker is active" — a deadlock or stall the consumption budgets can't see. Two
andons, not one: busy-runaway and silent-stall are different failure modes. (SPEC §8)

**budgets** — caps at three scopes: per-card (execution attempts), per-wave (tokens /
dispatches per `parent_id` subtree → scrap the subtree), and per-run (the andon).

**hold** — the parked-for-a-human terminal lane. Used for HITL selection (rank stations)
and for escalation on contradictory or unrecoverable state. The kernel hard-pauses and
surfaces; it never guesses.

**HITL** — human-in-the-loop: a rank station posting candidates to a channel (e.g.,
Slack) and waiting on `hold` for a human selection, bounded by `hold_timeout` +
`on_timeout` (`scrap | proceed_with_findings | escalate`). (SPEC §4A, ADR-0007)

**escalation** *(needsJudgment)* — the fail-closed move: on ambiguity, route to `hold`
and alert a human rather than auto-reversing or guessing.

**the Law** — the runtime guardrail for **agentic stations only** (there is no provider
safety net underneath Conduit): writes ⊆ the card's `owned_paths` (symlink-resolved);
Bash limited to a positive executable allowlist with no shell metacharacters; network
egress denied by default for content workers. Load-bearing; its hooks have unit tests.
(SPEC §7)

**owned paths** — the disjoint set of filesystem paths a card may write. Disjointness
across concurrent cards is validated at load (static) and at fan-out expansion (dynamic).
(SPEC §9)

**allowlist** — positive enumeration (commands, ingress flows, model params). Conduit
prefers allowlists over blocklists wherever input is untrusted.

---

## Ingress

The trigger-listener that turns external events into runs. (docs/ingress-listener.md)

**listener** — the long-lived HTTP process accepting webhook/Slack events, authenticating
them, recording them durably, and spawning runs.

**binding** — a flow's declaration of which external events trigger it (`ingress:` block
in `flow.yaml`): route, auth, event-id derivation, substrate mapping.

**envelope** *(substrate envelope)* — the normalized, deterministic record of an accepted
event (no randomness, no wall-clock reads in construction; sensitive keys filtered) that
becomes the spawned run's input.

**event id** — the dedup key for an incoming event, derived from a configured source
(header or body field) or, degraded, from a raw-body content hash. Same id = same event;
the second delivery is a no-op.

**accept-before-spawn** — the durability order: the event is committed to
`ingress_events` first, then the run is spawned. A crash after accept is recovered by
re-drive, never by asking the sender to retry.

**re-drive** — on boot, re-attempting spawns for accepted-but-not-spawned events, bounded
by a `spawn_attempts` cap so a poisoned event can't loop forever.

**ingress_log** — the append-only observability trail of every delivery attempt
(accepted, deduped, rejected, auth-failed), with sensitive keys filtered.

---

## Persistence & observability

**state DB** — the transactional SQLite database (`conduit.sqlite`): cards, claims,
checkpoints, outbox. The single source of truth the tick reads. (SPEC §11)

**journal** — the hot append-only log (`conduit.journal.sqlite`), split from the state DB
so high-volume writes never contend with transactional state. WAL + `busy_timeout`.
(SPEC §11)

**card log** — the per-card journal trail: every lane change, gate verdict, terminal
reason. The substrate kaizen reads.

**War Room** *(genba)* — the live view over the journal: watch the floor, not a report
about the floor.

**tagging** — stamping every shipped asset with a stable ID (`output.tag_assets`) so
market signals can be joined back to the producing card. (SPEC §13)

---

## Improvement loop

**skill** *(standard work)* — a crystallized, named, reusable unit of work — a prompt +
contract that proved itself and got promoted from ad-hoc to standard.

**kaizen** — the continuous-improvement loop (build step 10): mine the journal for
patterns (chronic rework edges, scrap clusters), propose flow mutations, A/B them.
Improvement is itself a flow.

**calibration cascade** — the three-judge alignment: internal critic ↔ human ↔ market.
Each cheaper judge is periodically calibrated against the more expensive one above it.
(SPEC §12)

---

## Lean → Conduit quick map

The one-table version. (Full mapping: SPEC "Lean glossary".)

| Lean / shop-floor | Conduit |
|---|---|
| Production line | flow (`flow.yaml`) |
| Station / work-cell | lane + worker + optional check |
| Kanban card | card |
| WIP limit | per-station `wip` cap |
| Pull system | station claims work only under cap |
| Quality gate | check station with a back-edge |
| Rework loop | bounded reject-to-earlier-station |
| Scrap bin | `scrap` terminal lane |
| Andon cord | run budgets + liveness watchdog → halt |
| Poka-yoke | schema validation, path ownership, coercive parsing |
| Jidoka | hard-pause on defect; escalate, don't guess |
| Heijunka | token bucket / rate limiting across lanes |
| Just-in-time | `materialize: on_approval` |
| Standard work | skill |
| Kaizen | the improvement loop |
| Genba | the War Room |
