# Concurrency demo — proving `--concurrency` runs fan-out lanes in parallel

This is a short, reproducible proof that `conduit run --concurrency K` dispatches
fan-out lanes **K-at-a-time as real out-of-process workers**, bounded by
`min(K, station.wip)`, while preserving correctness. It exercises the production
binary end-to-end — not a unit test seam.

It is the runnable companion to the
[`tiktok-parallel-ideas`](../examples/tiktok-parallel-ideas/) example, whose
README previously said "the executor is single-in-flight: the 10 lanes run one at
a time." That is no longer true; this doc shows what replaced it.

## TL;DR

```
examples/tiktok-parallel-ideas/concurrency-demo.sh 1 3 5
```

```
concurrency    | peak in-flight | wall-clock  | lanes done
---------------+----------------+-------------+-----------
1              | 1              | 4.06s       | 10/10
3              | 3              | 1.75s       | 10/10
5              | 5              | 0.87s       | 10/10
```

- **Peak simultaneous lanes equals the flag, exactly** — and never exceeds it.
- **Wall-clock scales inversely** (~2.3× faster at K=3, ~4.7× at K=5) for the
  same 10 lanes.
- **All 10 lanes complete correctly** at every concurrency level — only
  wall-clock changes, never the result.

## What's under test

The flow is `examples/tiktok-parallel-ideas/flow-kernel-demo.yaml`, a zero-model
variant of the tiktok ideation flow (so no gateway is needed):

```
select (DuckDB)          rank products, pick top-5 + bottom-5  → selected.json
  └─ plan (FAN-OUT ×10)  one child lane per product            → 10 children
       └─ ideate         per-product work (the parallel lanes)
  └─ collect (FAN-IN all) gather the 10 lanes
```

The `plan` station fans out to 10 children at `ideate`; those 10 `ideate` lanes
are the parallel work. `select` (DuckDB), the `plan` fan-out, and the `collect`
fan-in run on the in-process path; only the **plain pure deterministic** `ideate`
lanes are pooled as subprocesses (see the pool-eligibility rules in
[`CLAUDE.md`](../CLAUDE.md)).

## How the peak is measured

`true` (the demo's `ideate` command) finishes in microseconds, so overlap is
unobservable. The harness (`concurrency-demo.sh`) makes a throwaway copy of the
example and instruments `ideate` so each lane is visible in time:

```bash
# obs-ideate.sh — what each ideate lane runs
printf '%s %s START\n' "$(date +%s.%N)" "$$" >> obs.log
sleep 0.4
printf '%s %s END\n' "$(date +%s.%N)" "$$" >> obs.log
```

It also raises `ideate.wip` to 10 so the **run-level `--concurrency` flag is the
binding cap** (see the gotcha below). After each run, a sweep over the
START/END events computes the peak number of lanes in flight simultaneously.

Each `obs.log` PID is a `bash obs-ideate.sh` process spawned by a `conduit
__worker` subprocess. A peak above 1 is therefore only possible via genuine
out-of-process parallelism: the old single-in-flight path `await`s one station
call at a time and physically cannot exceed peak=1 — which is exactly what
`--concurrency 1` reproduces in the table above.

## Gotcha: the cap is `min(K, station.wip)`

The run-level `--concurrency K` is ANDed with each station's `wip` cap (the
atomic claim enforces both). The demo's `ideate` has no explicit `wip`, so it
defaults to **1** — meaning `--concurrency 3` alone still runs the lanes one at a
time. The flag cannot exceed a station's WIP. The harness raises `ideate.wip` to
10 so the flag is what binds; in a real flow, set the station `wip` to the
parallelism you actually want to allow.

## Gotcha: harness stations run one card at a time

`--concurrency K` parallelises two kinds of station: plain pure `deterministic`
stations (the out-of-process worker pool) and plain `transform` stations
(overlapping in-process model calls). A `kind: harness` station is neither. It
runs on the synchronous path: the kernel awaits the agent CLI call and
dispatches no other card until it returns, whatever K and the station `wip` are
set to. A harness station with a `check:` gate is excluded a second time,
because the critic call, the per-gate rework counter and the back-edge
transition are serial in-process logic (SPEC §6). A pipeline of gated harness
stations therefore runs one agent call at a time. This costs wall clock only;
token spend and per-call context size do not change.

To see what it cost a finished run, run `conduit run status --run <id>`. For a
run with harness calls it prints, per harness station, the call count, the
summed call duration and its share of the run's wall clock, and the
card-seconds other ready cards spent waiting behind those calls:

```text
run job-1: terminal (outcome=complete)
harness occupancy (serial under any --concurrency; run wall clock 100.0s):
  research: 2 maker + 1 critic call(s), busy 60.0s (60.0% of wall clock), other ready cards waited 70.0 card-s
  total: busy 60.0s (60.0% of wall clock)
```

Run wall clock is `runs.created_at` to the run's newest journal row, in whole
seconds, and includes any time a resumed run spent stopped. The waiting figure
is an estimate. It is sampled once when each call starts, so a card that
becomes dispatchable during the call, for example when its `release_at` passes,
is not counted. It also counts ready cards that a station `wip` cap would have
held back anyway. Calls journaled before this report existed carry no waiting
sample and are listed as not sampled.

## What this validates

- The event-driven worker pool is wired into the production binary (`cmdRun` /
  `cmdResume` → `buildWorkerPool` → `runExecutor`), not just a test seam.
- The K-bound is real and enforced (peak never exceeds the flag).
- Determinism holds under concurrency: the same 10 lanes reach the same terminal
  state regardless of K — the kernel decides what is legal next; only wall-clock
  differs (Conduit's "deterministic flow, non-deterministic labor" principle).

## Reproduce / extend

```
# default levels (1 3 5)
examples/tiktok-parallel-ideas/concurrency-demo.sh

# custom levels
examples/tiktok-parallel-ideas/concurrency-demo.sh 1 2 4 8
```

Requires `bun`, `duckdb`, and `python3`. Nothing in the committed example is
mutated — the harness works in a temp dir it cleans up on exit.
