# ADR-0012: Ungated harness calls may overlap under `--concurrency`, with owned-dir attribution in the integrity check

Status: Accepted (maintainer decision 2026-10-08 to build ahead of the measurement; #30 acceptance item 3 still needs a measured number)
Date: 2026-10-07

## Context

Under `conduit run --concurrency K>1` there are two concurrent dispatch paths, and
`kind: harness` matches neither ([#30](https://github.com/theaiteam-dev/conduit/issues/30)).
The worker pool admits only `kind: deterministic` stations, and the v10 overlap batch only
`kind: transform` ones (`src/controller/executor.ts`, the `poolEligible` test and the
concurrent transform branch after it). A harness station falls through to the synchronous
`await executeStation(...)`, and the tick loop dispatches nothing else until it returns. Steps
1 and 2 of #30 shipped: the limitation is documented, and `conduit run status` reports
per-station harness busy time and the card-seconds other ready cards waited
(`src/run/harness-occupancy.ts`). Step 3 is this decision.

The case that motivates it is [Shakedown](https://github.com/queso/shakedown-flow)
(queso/shakedown-flow#2): 3 to 6 Claude Code walkers, each an ungated harness child of a
fan-out, prove a PR's change in CI. The proof check is a deterministic fan-in station, so no
walker carries a `check:` gate. The GitHub job has a 10-minute timeout, boot takes 3 to 4
minutes, and that leaves about 5 minutes to walk. Each walker is capped at 150 s, so six
walkers in series take up to 15 minutes and three at a time take about 5.

Adding harness stations to the overlap batch is mechanically small. The batch already
isolates per-call token attribution with `AsyncLocalStorage`, so `foldHarnessUsage` reaches
the right card. Each harness invocation already has its own cgroup, its own invocation id,
and its own temporary config directories (created under the OS temp dir, outside the
project root). Two things block it:

1. **The mandatory harness integrity check.** Before each harness `invoke()`, the executor
   snapshots the whole project root (`snapshotTree`), and after the call it diffs the tree
   (`diffTouched`). Every touched path must lie inside the card's `owned_paths`; otherwise
   the card holds. Under overlap, sibling A's diff contains every write sibling B made during
   A's window, so both cards hold on every run.
2. **Declared outputs resolve under the project root.** Siblings of one station declare the
   same output name and overwrite each other's file.
   [#98](https://github.com/theaiteam-dev/conduit/issues/98) (card-scoped harness outputs)
   fixes this and is a prerequisite. It merged in #118: a harness station with
   `output_scope: owned_dir` writes and collects its outputs under the card's `owned_paths[0]`.

Gated harness stations are a separate problem. Their gate path (`runGateCheckOrAdvance`:
critic call, per-gate rework counter, back-edge transition) is serial in-process logic that
enforces SPEC §6, and making it re-entrant is not needed for the Shakedown shape.

## Decision

**A harness station may opt in to overlapping calls. Its overlapped calls use an integrity
rule that attributes a touched path inside an overlapping sibling's owned paths to that
sibling. The rule cannot detect a Bash write from one sibling into another's owned paths,
and SPEC §7 states that gap.** This ADR is Proposed: shipping it is conditional on the
measurement described under *Ship condition* below.

### Opt-in: `overlap: true` on the station

The station declares `overlap: true` at station level, beside `wip`. It is valid only on
`kind: harness`; the loader rejects it on any other kind (a transform overlaps without
declaring anything, so the field would mean nothing there).

The flag is explicit, per station, because overlap changes what the integrity check can
detect for that station's calls. Raising `--concurrency` is an operator decision at run
time and must not weaken a containment property that the flow file declares. A flow-level
default would apply the weaker rule to every harness station in the flow, including ones
whose authors did not accept the gap. The flag sits at station level, not inside `worker:`,
because it governs dispatch, as `wip` does, not how the worker is invoked.

### Admission conditions

A card is admitted to a harness overlap batch only when all of the following hold. The
static conditions are validated at load for any station declaring `overlap: true`, so a
station that can never overlap fails at load instead of running serially without notice.
The adapter condition is checked again at dispatch, since the adapter registry is populated
from engine configuration at boot.

Static, per station:

1. `kind: harness` and `overlap: true`.
2. No `check:` block (this also excludes `rank`).
3. Not `effectful`.
4. Not a fan-out station (the station that seeds children; the children's station may
   overlap).
5. No `deliver` block.
6. The resolved adapter has `canGatePerCall` (today `agent-sdk`, `codex-app-server`,
   `opencode`). `claude-headless` and `codex-exec` cannot overlap.
7. The flow sets `defaults.enforce_owned_paths: true`, so the per-call gate receives the
   card's `ownedPaths` and confines file-tool writes to them.

Dynamic, per card at dispatch:

8. The card declares non-empty `owned_paths`.
9. The card's canonical owned paths are disjoint from those of every member already
   admitted to the batch. Fan-out validation (`validateExpansion`) already guarantees this
   among siblings of one parent; the dispatch check covers cards from different parents.
10. The usual caps: at most `min(K, wip)` members.

A card that fails 8 or 9 runs on the serial path with today's integrity rule. Harness
members and transform members never share a batch: the dispatch pass runs them as separate
batches, one after the other, because a transform member's kernel-written output under the
project root would appear in a harness member's diff and could be attributed to no member.

### The overlap integrity rule

For a harness member M, M's window runs from its baseline snapshot to its post-invoke
snapshot. The executor records, for each member, the set of other members whose windows
intersected M's window. With the `Promise.all` batch that is every other member of the
batch, but the rule is stated over recorded windows so it stays correct if a long-lived
in-flight pool later replaces the batch.

Each path in M's diff is classified:

- Inside M's own `owned_paths`: allowed, as today.
- Inside the `owned_paths` of a member whose window intersected M's: attributed to that
  member, not a breach for M. Disjoint ownership (SPEC §9 and condition 9) means at most one
  member owns the path. The attribution is journaled on M's span (the sibling card id and a
  count of attributed paths).
- Anywhere else under the project root: a breach. M holds, as today.

The checks in the serial path are unchanged otherwise: symlink canonicalization, fail-closed
on an unresolvable path, and a hold (not a retry) on breach.

### The gap, stated

Sibling A can write into sibling B's owned paths without either card holding: both diffs
attribute the write to B. The per-call gate closes this for the file-write tools, because
under condition 7 it denies a Write, Edit, MultiEdit or NotebookEdit outside A's own owned
paths before the call runs. It does not close it for Bash. The gate denies shell
metacharacters, so a redirect (`>`) is refused, but an allowlisted executable that writes to
a path given as an argument (`cp`, `tee`, `sed -i`, a script the agent wrote) is not checked
against ownership. On the serial path the diff catches such a write; on the overlap path it
does not, when the target is inside an overlapping sibling's owned paths. A write outside
every member's owned paths is still caught.

A flow author who opts in accepts that a Bash write by one overlapped sibling can change
another sibling's artifacts undetected. A flow whose overlapped stations allow no
file-writing executable in their Bash allowlist does not have the gap in practice.

### Ship condition

Issue #30 acceptance item 3 requires the decision to cite a measured number. None exists
yet, because no Conduit run of a multi-card harness flow has been recorded. This ADR moves
to Accepted only after a Conduit run of the Shakedown flow at today's serial dispatch
supplies one from `conduit run status`: per-station harness busy time for the walker
station, the share of run wall clock it took, and the card-seconds ready walkers waited.
Shakedown v1's own walker timings (it ships first as a Node orchestrator spawning
`claude -p`) are a preliminary figure, not the cited one.

The figure that justifies shipping: the walker station's serial busy time exceeds the
roughly 300 s walk budget left by the 10-minute job on a typical PR, while the same measured
per-call durations, packed three-wide, fit under 300 s. With walkers near the 150 s cap,
serial is 450 to 900 s for 3 to 6 walkers against 300 s at three-wide. If the measured
serial busy time for the walker station usually fits in 300 s, #30 closes as documented and
accepted, and this ADR is marked rejected. After shipping, an overlapped run's measured wall
clock replaces the packed estimate in the #30 record.

## Alternatives

### A. Per-invocation workspace: copy or overlay the project root, copy the owned dir back: *the documented alternative*
Each overlapped call runs in its own copy (or overlayfs upper layer) of the project root;
on return, the kernel diffs that copy against its baseline, applies the full serial
integrity rule, and copies only the card's owned dir back. This keeps full detection: a Bash
write into a sibling's dir lands in the writer's private copy and is a breach. It was not
chosen because it costs disk and copy time proportional to the project root per call, it
complicates input mounts and symlinks that point into the project root (a link resolved
inside the copy can point back at the shared tree), and overlayfs needs mount privileges
that a default Docker container does not grant. It is the escape hatch if the Bash gap
proves unacceptable for a flow that needs overlap.

### B. Keep harness stations serial and close #30 as documented: *the default if the ship condition fails*
No new rule, no gap. It is the outcome if the measured figure does not justify overlap.

### C. Make the integrity diff advisory, or skip it, under overlap: *rejected*
Removes the backstop for every Bash write, including writes outside every owned path, which
the chosen rule still catches.

### D. Check each member's diff only within its own owned dir: *rejected*
Loses detection of writes outside every owned dir (the project root's shared files, other
cards' dirs not in flight). The chosen rule keeps that detection.

### E. Attribute writes by process (fanotify, eBPF, audit on the invocation's cgroup): *deferred*
Would close the Bash gap by knowing which process wrote a path. fanotify and eBPF need
capabilities a default container lacks. A related option is Landlock, an unprivileged
Linux LSM that could confine each harness process tree's writes to its owned dir plus its
temp and config dirs. That would turn the gap into a pre-execution denial; it needs
per-adapter allowances for the paths each CLI writes and a kernel that supports it.
Recorded as a revisit trigger.

### F. Mixed harness and transform batches, with attribution to transform outputs: *deferred*
Attribution would also need the resolved declared-output paths of transform members. The
separate-batch rule is simpler and loses only overlap between the two kinds.

### G. Overlap gated harness stations: *out of scope*
Needs `runGateCheckOrAdvance` to be re-entrant. Not required by the Shakedown shape.

## Consequences

**We gain**
- Ungated harness fan-out children run up to `min(K, wip)` at a time, which turns Shakedown's
  walk phase from up to 15 minutes into about 5 (to be confirmed by measurement).
- The integrity check still holds a card for any touched path outside every overlapping
  member's owned paths.

**We pay**
- **The Bash cross-sibling gap** above, accepted per station by `overlap: true`.
- **A breach by one member can hold every member whose window overlapped it.** A path no
  member owns cannot be attributed, so each overlapping diff that contains it holds its
  card. This fails closed; the hold reason already names "another process wrote to the
  project root while it ran" as a possible cause.
- **Budget overshoot of up to K calls.** Each member checks the consumption andon after its
  own call, and `HarnessInvocation` has no abort signal, so a run can exceed its token budget
  by up to K harness calls. This is the transform batch's behaviour today and is within SPEC
  §8's soft-ceiling drain semantics.
- **The batch waits for its slowest member**, including that member's retry backoff, before
  the next dispatch pass. A staggered sibling (`child_stagger_seconds`) cannot join a batch
  already in flight: it starts at the later of its `release_at` and the end of the current
  batch. This composes with the stagger (the first child still runs alone and warms the
  cache) but can delay later siblings past their release time when the first call is long.
- **More provider rate limits under K.** Each card parks on its own, through the existing
  `RATE_LIMITED` path, and `MAX_CONSECUTIVE_RATE_LIMIT_PARKS` stays per card.
- **K snapshots of the project root per pass.** `snapshotTree` reads and hashes every file
  synchronously, so one member's snapshot blocks the event loop for all members, including
  stdout handling that resets the idle timeout. Snapshot time must stay well under the
  shortest `worker.idle_timeout_seconds` in the batch, or the snapshot must become
  asynchronous before this ships.
- **Occupancy reporting changes.** `src/run/harness-occupancy.ts` sums span durations,
  which overcounts busy time once calls overlap. It must report busy time as the union of
  call intervals (per station and in total), and each overlapped harness span records a
  `concurrent` attribute. `ready_waiting` counts ready cards not admitted to the batch.
- **Containment conformance with several live invocations.** The #27 conformance suite must
  pass with two or more harness invocations live at once: killing one invocation's cgroup
  leaves the other's process tree running until its own end.
- **Shakedown's walkers move to a `canGatePerCall` adapter** (`agent-sdk` for Claude Code),
  since `claude-headless` cannot overlap under condition 6.
- **No worker-pool interaction.** A flow that can overlap harness calls sets
  `enforce_owned_paths`, and the worker pool excludes such flows, so no pooled deterministic
  worker writes to the project root during an overlapped call.

**Prerequisites**
- #98 (card-scoped harness outputs) merged. Done in #118.
- The overlap set and the attribution journaled on each span.
- The occupancy and conformance changes above.

**Revisit triggers**
- A flow needs overlap with Bash executables that write by argument: adopt Alternative A, or
  E if Landlock confinement becomes practical for the shipped adapters.
- Gated harness stations need overlap: a new ADR for a re-entrant gate path.
- The `Promise.all` batch's wait-for-slowest cost shows up in occupancy data: replace it with
  a long-lived in-flight pool. The integrity rule is already stated over recorded windows.

## References

- Issues: [#30](https://github.com/theaiteam-dev/conduit/issues/30) (this decision),
  [#98](https://github.com/theaiteam-dev/conduit/issues/98) (card-scoped harness outputs),
  [#27](https://github.com/theaiteam-dev/conduit/issues/27) (containment conformance),
  [#21](https://github.com/theaiteam-dev/conduit/issues/21) (per-call tool gate),
  queso/shakedown-flow#2.
- SPEC §7 (*Overlapping harness calls*), §9 (disjoint ownership invariant), §8 (andon drain).
- `docs/harness-containment.md` (the containment profile and the per-call gate).
- Code: `src/controller/executor.ts` (`poolEligible`, the concurrent transform branch,
  `snapshotTree`, `diffTouched`, the harness integrity check in the harness station path),
  `src/run/harness-occupancy.ts`, `src/worker/harness-gate.ts`.
