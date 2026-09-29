---
missionId: ~
---

# Conduit — War Room

**Author:** Josh Owens  **Date:** 2026-06-12  **Revised:** 2026-09-28 (TUI first, #89)  **Status:** Draft

> Scope note: the War Room is named in the SPEC's lean glossary — *"Genba (the floor) →
> the War Room — live stream of the journal"* — but has never been specified. This PRD
> defines it as a **read-only projection of the card journal**: no UI-owned state, no
> write path, no second source of truth. It depends on the shipped kernel
> ([`prd/done/mvp-kernel.md`](../done/mvp-kernel.md)), the card transition log
> ([`prd/done/card-transition-log.md`](../done/card-transition-log.md)), and the
> branching/HITL surface ([`prd/done/branching-and-hitl.md`](../done/branching-and-hitl.md)).
> It deliberately precedes the kaizen pipe
> ([`prd/drafts/kaizen-pipe.md`](./kaizen-pipe.md)): both consume the same journal, and
> the War Room is the cheap way to discover what the journal cannot yet answer.

## 1. Context & Background

A Conduit run today is observable only through its exhaust: CLI output, journal rows
queried by hand, and Slack egress messages. There is no way to *watch the line run* —
to see cards move through stations, a QC rejection bounce work back down a back-edge,
or an andon approach its trip point. The lean worldview the whole project is built on
says the floor should be visible (*genba*); right now the floor is a SQLite file.

Two forces make this the right time:

- **Launch.** The project's most compelling asset is currently a 1,000-line SPEC, which
  filters for readers who will go build their own. A live visual assembly line — cards
  flowing, rework bouncing, the andon tripping — is the thirty-second artifact that makes
  the worldview legible to someone who will never read the SPEC. The pre-launch review
  ([`docs/archive/2026-06-12-pre-launch-review.md`](../../docs/archive/2026-06-12-pre-launch-review.md))
  reached the same conclusion from the docs side.
- **Kaizen is next.** The kaizen pipe will mine the journal for chronic rework edges,
  scrap clusters, and cost patterns. Every question the War Room cannot answer from the
  journal is a question kaizen will also be unable to answer. Building the projection
  first is deliberate schema-gap discovery: each gap surfaces as a visible "unknown" in
  the UI, gets logged, and is triaged into the journal schema *before* kaizen is
  specified against it.

There is also a cautionary precedent. A war room was built for A(i)-Team and **it felt
wrong**: it was a window onto *agents* — activity feeds, who is doing what — rather than
onto *work*. Watching workers is not watching the line. That failure shapes this PRD's
central design rule (§7): the unit on screen is the card, never the worker.

## 2. Problem Statement

An operator running a Conduit flow cannot see the state of the line — which cards are
where, what is stuck, what is bouncing through rework, how close the run is to a budget
trip — without hand-querying SQLite. This makes runs hard to supervise, makes the
kernel's behavior invisible to prospective users, and leaves journal schema gaps
undiscovered until kaizen hits them. The fix must not introduce a second source of
truth: the journal and state DB already record everything that happens; the War Room
must only *render* it.

## 3. Target Users & Use Cases

**Primary user — the flow operator/builder (Josh today).** Runs flows (Studio, Autocut,
tiktok-shoppable-ideas, soon Nitpick) and needs to supervise them: spot a card stuck in
rework, see why something scrapped, watch budget consumption, confirm a HITL card is
waiting on a human and not deadlocked.

**Secondary user — the launch audience.** A prospective user evaluating Conduit who
needs to *get it* in under a minute. They watch a run (live or replayed) and walk away
understanding the flow-shop model without reading the SPEC.

**Tertiary consumer — the kaizen pipe (machine, future).** Not a UI user, but the
War Room's data needs are a strict preview of kaizen's. Gaps found here are filed for
the journal schema before kaizen is specified.

**Key use cases:**

- An operator needs to **watch a live run** — every card's lane and status, updating as
  the kernel works — so that supervision doesn't require SQL.
- An operator needs to **see a rework bounce as it happens** (which check rejected, the
  findings, which station the card returned to, how many rework cycles remain) so that
  quality-loop behavior is inspectable rather than inferred.
- An operator needs to **see both andons** — consumption (wall-clock and token budgets,
  with current spend) and liveness (time since last lane change) — so that an
  approaching halt is visible before it happens.
- An operator needs to **see held cards** (HITL waits with their timeout, and
  escalations) so that "waiting on a human" is distinguishable from "stuck."
- An operator needs to **replay a completed or crashed run** from its journal alone so
  that post-mortems and demos don't require a live kernel.
- A demo viewer needs to **understand the flow-shop model from watching** — stations,
  cards, quality gates, scrap — without explanation.
- The project needs to **discover journal schema gaps**: every datum the UI wants but
  the journal cannot supply is surfaced and recorded, not silently worked around.

## 4. Goals & Success Metrics

The War Room is graded on faithfulness and legibility, not feature count. It is a
projection; its whole value is that what you see *is* the journal.

| Goal | Metric | Target |
|------|--------|--------|
| Pure projection | Write statements issued by the War Room against the state DB or journal | Zero — it opens both read-only |
| No second source of truth | Persistent state owned by the War Room (stores, caches surviving restart) | None — restart and replay produce the identical view |
| Live supervision | Lag between a journal append and the rendered update | ≤ 2 seconds |
| Replay fidelity | A completed run reconstructed from its journal alone matches the live rendering of the same run | 100% of journal-recorded transitions rendered, in order |
| Demo legibility | A person unfamiliar with Conduit watches a branching-flow run and can describe what happened (fan-out, a rejection, a human pick) | Yes/no test with ≥ 3 people pre-launch |
| Schema-gap discovery | Every "unknown" the UI renders because the journal lacks the datum | Logged and triaged into a journal-schema issue list before the kaizen PRD moves to ready |

## 5. Scope

### In Scope

- **Single-run view**: one run rendered as a **trace waterfall** — one row per card,
  time on the x-axis, one colored segment per station visit (see §8 for why this
  paradigm, not a kanban board).
- **Live tail**: following an in-progress run by reading the journal and state DB as the
  kernel appends.
- **Historical replay**: reconstructing any past run from its journal, with step/scrub
  controls — including runs that ended in a crash or halt.
- **Card detail**: per-card lane/status history, `reworkCount` and `executionAttempt`
  against their caps, scrap reason, owned paths, per-card cost and token spend.
- **Quality-loop visibility**: gate verdicts with findings, the back-edge a rejection
  routed down, no-progress (findings-hash) trips.
- **Branching visibility**: fan-out parent/child relationships, fan-in quorum state
  (k of N children landed), rank short-lists and the recorded selection.
- **Both andons**: consumption budgets (wall-clock, tokens — spend vs. cap) and the
  liveness watchdog (time since last lane change vs. threshold), plus trip events.
- **HITL state**: held cards, what they wait on, their timeout and its policy.
- **Run summary**: terminal tallies (done / scrapped / held), total cost, duration.

### Out of Scope

- **Any write path** — including HITL selection from the War Room. Selections stay in
  the existing egress channels (Slack). The moment the War Room wants to write, that is
  a kernel/channel gap, not a UI feature (see §7).
- **Multi-run / fleet dashboard** — comparing runs, run history lists across flows.
  Single run first; fleet view is a later PRD informed by this one.
- **Authentication, multi-user hosting, remote access** — this renders local state for
  the operator who owns the volume. The TUI reaches a remote box over SSH or
  `docker exec -it`, so it opens no port and needs no auth decision. Hosting is a
  product decision for another day.
- **The web view in the first delivery**: it follows the TUI as its own PRD and reuses
  the shared core (§8).
- **A run picker**: v1 is one journal, one run.
- **Kaizen analytics** — chronic-edge mining, cost trends, mutation proposals. The
  War Room *feeds* the schema for that work; it does not do it.
- **Flow editing / run control** (pause, scrap, retry buttons) — write paths, all of
  them.
- **Alerting/notifications** — the andon alert surface already exists via egress.

## 6. Requirements

### Functional Requirements

1. The War Room shall render the flow's lane graph — stations, terminal lanes, happy-path
   edges, and validated back-edges — from the flow definition the run was started with.
2. The War Room shall render every card in the run at its current `(lane, status)`, and
   shall update within the live-lag target when either changes.
3. The War Room shall derive everything it displays from the journal and state DB opened
   read-only; it shall issue no writes to either.
4. The War Room shall hold no persistent state of its own: closing and reopening it
   against the same journal shall produce the identical view.
5. A QC rejection shall be rendered as a routing event: the verdict, its findings, the
   back-edge taken, and the card's updated rework count against its cap.
6. A card's detail view shall show its full transition history in journal order, with
   per-transition attribution (integrity fail vs. QC reject vs. dep-scrap vs. crash).
7. Scrapped cards shall display their scrap reason (`rework_cap`, `no_progress`,
   `integrity`, `model-incompatible`) and the evidence trail that led there.
8. Fan-out shall render the parent in `awaiting_children` with its children grouped
   beneath it; fan-in shall render quorum progress (children landed vs. `k`).
9. Held cards shall be visually distinct from working and waiting cards, and shall show
   what they wait on (HITL selection with its timeout and `on_timeout` policy, or an
   escalation reason).
10. The consumption andon shall render current wall-clock and token spend against the
    run budgets; the liveness watchdog shall render time since the last lane change
    against its threshold; trips of either shall be rendered as run-level events.
11. Per-card and run-total cost (tokens and USD where recorded) shall be displayed.
12. Replay mode shall reconstruct a run from its journal alone, support play/pause/step/
    scrub, and clearly label itself as replay (including runs that ended in a crash —
    the view shows last recorded state, not an invented terminal).
14. The kernel shall write a run-level heartbeat entry to the journal at a fixed interval
    while a run is active, so the War Room can tell a crashed kernel (heartbeat stopped)
    from a slow one (heartbeat current, no card activity). The heartbeat is the first
    schema-gap item and is a kernel write; the War Room only reads it. The interval is
    chosen at implementation.
13. Where the journal lacks a datum the UI is designed to show, the War Room shall
    render an explicit "not recorded" marker — never a guess or a blank — and shall log
    the gap (datum, journal location, run) to a schema-gap list.

### Non-Functional Requirements

1. Read access shall not block or degrade the running kernel: the kernel's writes take
   priority, and the War Room tolerates read snapshots that are momentarily behind.
2. The live view shall stay within the ≤ 2 s lag target on a journal of at least 100k
   entries.
3. Replay of a 10k-entry journal shall start rendering in under 5 seconds.
4. The War Room shall run on the same machine/volume as the kernel state (per the
   Docker-first packaging model) with no additional infrastructure.
5. Rendered content shall respect the existing secret-filtering posture: the War Room
   displays what the journal stores and adds no new exposure surface (no raw env, no
   request bodies beyond what ingress already persisted).
6. The full lane graph — parent path, any child band, and the terminal rail — shall be
   visible without horizontal scrolling at 160 terminal columns (TUI) or 1280px width
   (web) for flows of up to 8 stations.

### Edge Cases & Error States

- **Run crashed mid-flight**: journal ends without terminals. Render last known state
  with an explicit staleness indicator ("no journal activity for N min") — do not infer
  completion or failure. With the heartbeat (FR-14) the indicator says whether the
  kernel is still beating. For a journal with no heartbeat entries it says "kernel not
  observed".
- **Kernel resumes a watched run**: checkpoint-skipped stations produce no new work
  events. The view must make skip-on-resume legible (a station satisfied by checkpoint,
  not re-executed) rather than appearing frozen — if the journal cannot distinguish
  this, that is a schema gap to log (FR-13).
- **Older journals** (pre-current schema): render what is present, mark the rest "not
  recorded" per FR-13. Replay must not crash on missing fields.
- **Card held past its timeout** (e.g., the timeout poll skipped it): the held card's
  age is visible, so a hold that outlives its policy is noticeable rather than silent.
- **Empty run** (seeded but nothing dispatched): render the intake state honestly.
- **Flow definition unavailable or version-mismatched** with the journal's
  `flow_version`: render the lane graph from journal evidence where possible and flag
  the mismatch prominently.
- **Journal mid-write / locked**: reads retry quietly; the UI shows its last-read
  position rather than erroring.

## 7. Design Principles

- **Projection, not application.** The War Room is a pure function of the journal. The
  stop rule, verbatim: *the moment the War Room needs its own store or a write path,
  stop — that is a kernel gap, not a UI feature.* File the gap; do not build around it.
- **The unit on screen is the card, never the worker.** This is the lesson from the
  A(i)-Team war room that felt wrong: it showed labor (agents, activity) instead of flow
  (work moving through stations). Workers appear only as attributes of a card's
  transition ("rejected by `verify` critic"), never as first-class objects with their
  own panels.
- **An andon board, not a log viewer.** The default view answers, at a glance: is the
  line flowing, where is work piling up, is anything about to trip. Raw journal entries
  are reachable from any element (drill-down), but the board leads.
- **Attention is a budget; spend it on three layers.** *Quiet* (waiting cards, idle
  stations, chrome) recedes; *alive* (working cards) carries visible motion and the
  brand green; *loud* (held cards, andons past 80%, scrap) is reserved for what needs a
  human and is unmistakable at surface scale — borders and fills, not dots. The squint
  test: squinting at the board, exactly three kinds of things may pop — the pulsing
  working card, the amber held card, and any andon near its limit.
- **Honest about ignorance.** "Not recorded" is a first-class rendering. Every one of
  them is a journal-schema work item — that is half the point of building this now.
- **Replay is the same code path as live.** Live is replay at the journal's head. If the
  two views can disagree, the projection has state it shouldn't have. (Mechanically
  guaranteed by the single shared projection function — see §8.)

## 8. Solution Approach

**Delivery order (revised 2026-09-28, #89).** The first surface is a terminal UI:
`conduit watch` renders in the terminal with `@opentui/react` and reads the journal
directly, with no server. The web view described below comes second and reuses the same
reader, projection function, and replay logic. It adds the rendering components and the
server and SSE layer. The TUI visual spec is `design/war-room/`: frames, 160x45 golden
text and ANSI frames, color tokens, and a cell-grid reference renderer.

`conduit watch` is a command in the existing kernel binary, not a separate service. It
ships in the same Docker image, reads the same mounted volume, and adds no new runtime
or infrastructure. The web view, when it comes, is served by the same binary under a
distinct invocation, `conduit watch --web`, so that plain `conduit watch` never opens a
port.

The data model is a **shared core**, built once around a single projection function,
*the* War Room in code form:

- **Reader**: a read-only journal and state DB reader that loads the current state and
  follows new rows by sequence number.
- **Projection**: one pure function folds journal events into the rendered run state
  (`events → reduce → view state`). It is the only place view state is derived. The June
  prototype's sketch at `design/warroom-prototype/lib/warroom-data.ts` is the starting
  point, with its types reconciled against `src/types/kernel.ts`.
- **Live**: the reader follows the journal and each new row folds into the displayed
  state through the projection.
- **Replay**: events up to a chosen point, re-folded through the same function.
- **Not recorded**: a gap in the journal renders as "not recorded" and is logged to the
  schema-gap list (FR-13).

Because live and replay are the one function, the §7 principles (pure projection,
replay ≡ live, restart-identical rendering) are structural properties rather than
conventions. The TUI has no server, so it has no snapshot or reconnect protocol: a
restart re-reads the journal and re-folds it. The web view adds a snapshot fetch and a
reconnect path on top of the same core.

The primary view is a **trace waterfall**, validated through two prototype rounds (a
kanban-style station board was prototyped first and failed the legibility test — even
the system's author could not narrate it; the paradigm record is §10):

- **One row per card, time on the x-axis, one colored segment per station visit.** The
  journal is a trace; the canonical rendering of a trace is a waterfall. Five shapes
  carry the story and must be legible without explanation: fan-out (a row forking into
  indented child rows), rework (an earlier station's color repeating after a gate, with
  a bounce marker), scrap (a row dying in a red cap with its reason), held (a growing
  amber bar with a countdown, switching to a blinking OVERDUE past its timeout), and
  fan-in (child rows converging with a quorum label).
- **The time axis is the consumption andon.** The axis always fits t0 → now —
  compress, never scroll — with a minimum segment width so nothing vanishes. The
  wall-clock budget renders as a red boundary line that enters the viewport once the
  run passes ~70% of budget: approaching the wall is geometry, not a number. Detail
  recovery is zoom on the time axis (drag in the web view) with a transient minimap
  (full run + viewport) and a "fit all" snap-back; zoom chrome is invisible unless
  zoomed.
- **Live is the default; replay is a mode.** The footer is a slim strip — latest-event
  ticker plus a LIVE badge. Entering replay reveals the scrubber and flips the badge;
  the two are never visible together, and **every** header element (meters, elapsed,
  watchdog, tallies) rolls back to the scrub position — no element may read the live
  head while scrubbed.
- **Terminal aesthetic.** Monospace throughout, TUI-bordered panels, pure-black
  ground, saturated color slabs (engineers are the audience; the product is
  CLI-first). Both andons live in the header as bracketed meters; card drill-down is a
  side panel showing the card's journal events as colored log lines. In the TUI it is a
  60-column scrolling drawer. There is no hover: the selected row's details go in a
  status line. Keys: j/k select, enter opens the drawer, t toggles tool-call ticks for
  the current harness attempt, r enters replay, esc closes. Mouse clicks work on rows
  and ticks.
- The station board from the first prototype round survives as a candidate *secondary*
  view for high-WIP flows (a future PRD), not part of v1.

## 9. Technical Considerations

**Constraints:**

- **TUI** renders with `@opentui/react` (Bun-native), pinned to an exact version while
  it is pre-1.0. Tests use `@opentui/react/test-utils`: `captureCharFrame` for text
  snapshots against `design/war-room/golden/`, `captureSpans` for colors, mock keys and
  mouse for interaction, and `ManualClock` for countdowns and the watchdog.
- **Bun-only toolchain** (per ADR-0002/0003): the TUI is TypeScript run by Bun, with no
  `Bun.serve` endpoints, no SSE, and no listening port. The web UI is a static React SPA bundled by
  Bun's native bundler and served by `Bun.serve()` from the kernel binary. No Node,
  Vite, or Next.js toolchain; no separate deployable. This decision (one binary, no
  second service) should be recorded as an ADR at implementation time.
- **Web view only: transport is one-directional SSE.** Chosen over WebSocket deliberately: the browser
  has no channel to send commands back, which makes the no-write-path rule (§7) an
  architectural property instead of a convention. The only client-initiated calls are
  read-only snapshot/range fetches. The TUI has no transport and listens on nothing, so
  the no-write-path rule holds there for the same reason.
- **Visual language is terminal/TUI** (s-tui / btop energy): pure black `#000` ground,
  monospace everywhere, saturated color slabs. Color encodes **station identity** on
  waterfall segments (a healthy card walks the spectrum left→right; a broken hue order
  is visible trouble); **state** rides on top as markers and caps (green now-line and
  ✓, amber held/OVERDUE, red scrap/wall). Green never appears on a non-alive element;
  station colors must not collide with the now-line (deliver is teal for this reason).

**Dependencies:**

- **[reactiveSWR](https://github.com/queso/reactiveSWR)** (our own library), for the web
  view only. The TUI does not use it. It is the SSE-to-client bridge: its server channel handles wire format, heartbeats, connection
  tracking, and cleanup inside `Bun.serve`; its EventEmitter adapter bridges the journal
  tailer; SWR's revalidate-on-reconnect provides the snapshot self-healing in §8; its
  connection-status hook drives the LIVE/stale indicator. **Shape constraint:** the
  schema uses a *single cache key whose custom update function is the shared projection
  reducer* — not the per-resource CRUD shape — otherwise projection logic scatters
  across cache keys and the replay-≡-live guarantee breaks. Replay bypasses
  SSE/SWR entirely and re-folds events locally.
- **Journal + state DB read-only access** from the watch process; the kernel remains
  the only writer.

**Integration points:**

- The existing CLI (new `watch` command), the Docker image (one exposed port for the web
  view, none for the TUI), and the
  journal schema (every gap found per FR-13 feeds the kaizen-pipe PRD).
- The connection-status / kernel-liveness distinction: in the web view, SSE heartbeats
  tell the browser the *watch process* is alive. In either surface, only a journal-level
  heartbeat (FR-14) can say the *kernel* is alive.

## 10. Risks & Open Questions

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Repeats the agent-centric mistake and "feels wrong" again | Medium | The demo artifact undercuts the worldview instead of selling it | Card-as-unit principle (§7); legibility test in §4 runs before launch, with iteration time budgeted |
| Journal gaps are larger than expected — the UI is mostly "not recorded" | Medium | War Room ships hollow; kaizen schema work balloons | That discovery is a stated goal (§4); timebox the first pass, fix the top gaps in the journal, then finish the UI against the improved schema |
| Read contention with a live kernel on one SQLite volume | Low | Lag or kernel slowdown | Kernel-writes-take-priority NFR; the journal/state split and WAL already exist for this reason — validate, don't redesign |
| Scope creep toward run control (pause/retry/select buttons) | High | Write path sneaks in; second source of truth follows | The stop rule (§7) plus explicit out-of-scope listing; any control surface is its own PRD |
| Replay diverges from live rendering | Low | Trust in the projection collapses | Same-code-path principle (§7); single shared projection function (§8); replay-fidelity metric (§4); core test that replay equals live |
| Journal event bursts fold incorrectly (a tick can append several rows back-to-back; the reader must hand the projection every row in sequence order and the projection must apply N sequential steps, not lose updates) | Medium | The screen shows a state the journal never contained | Core test: a burst of rows written in one tick folds to the same view as the same rows folded one at a time. Re-reading from sequence 0 is the recovery path. The web view adds the same test for its reactiveSWR cache before adoption |

### Open Questions

None open. Three were settled on 2026-09-29 (see Resolved).

### Resolved

- [x] **Run identity** (2026-09-29) → the simple choice: one journal is one run, with no
      run picker in v1. Several flows may run at once; picking among them waits for the
      fleet-view PRD.
- [x] **Replay export** (2026-09-29) → screen capture is enough. A vhs recording of a
      fixture run is the launch demo. No export format.
- [x] **Kernel heartbeat** (2026-09-29) → yes. The kernel writes a run-level heartbeat
      entry to the journal (FR-14). It is the first schema-gap item.
- [x] **Delivery surface** → TUI first, web view second (revised 2026-09-28, #89). This
      was first resolved as web only, because the web view is the demo artifact. It was
      reversed because flows run on a remote box, where a TUI works over SSH with no port
      or auth decision; the TUI needs no server layer; and its tests assert on rendered
      text. A vhs recording of a fixture run serves as the demo. The projection contract
      is identical for both (§8, §9).
- [x] **Primary paradigm** → trace waterfall, not a station board. The board prototype
      failed the narration test (the author could not read it); the waterfall passed
      immediately. The journal is a trace; render it as one. Board demoted to a
      possible future secondary view for high-WIP flows (§8).
- [x] **Where the process lives** → a `conduit watch` command in the existing kernel
      binary. No separate service (§9). Plain `conduit watch` is the TUI and serves nothing.
      The web view is `conduit watch --web`, which also serves the SPA and the event
      stream.
- [x] **Transport** (web view only, 2026-09-29) → one-directional SSE via reactiveSWR,
      single-cache-key reducer shape; replay re-folds locally without SSE (§9). The TUI
      reads the journal in-process and has no transport.
