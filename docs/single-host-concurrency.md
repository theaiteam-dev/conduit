# Single-Host Concurrency

What's safe, what's prevented, and what you (the integrator dispatching `conduit run`/`resume`
processes) still own — so you don't have to reverse-engineer it from the schema or the claim
code. This is about **multiple OS processes** sharing one `conduit.sqlite`; it is unrelated to
`--concurrency K`, which governs in-process worker parallelism *within* a single run (see
[installation.md](./installation.md)).

## What's safe today

**N concurrent `conduit run` / `conduit resume` processes against one shared state DB, each
with a distinct `--run-id`.** This is the schema-v6+ multi-run model (run namespacing): every
per-run table is partitioned by `run_id`, so two runs don't see each other's cards, journal
entries, or HITL state.

Two things make concurrent writers safe at the SQLite layer:

- **WAL mode + the atomic claim.** Every dispatch decision (`slot_occupied`, card status, WIP
  cap) is evaluated and committed inside a single `BEGIN IMMEDIATE` transaction. Two processes
  racing to claim the same card can't both win — one's transaction serializes behind the
  other's, and it re-reads a `claimed` card and moves on.
- **Bounded `SQLITE_BUSY` retry.** On top of the existing `PRAGMA busy_timeout=5000`, claim
  writes are wrapped in a bounded retry (~5 attempts, exponential backoff with jitter from
  ~50ms up to a 1s cap). Sustained write contention from other runs' processes now waits it
  out instead of surfacing a raw `SQLITE_BUSY` failure.

In short: distinct run ids on a shared DB is a supported deployment shape, not something you
need to serialize yourself.

## What's prevented

**Two processes driving the *same* run id.** This is not a supported shape — a run's cards,
lease renewals, and journal writes assume a single driving process — so it's now guarded by a
per-run advisory lease:

- The first `conduit run`/`resume` for a given run id acquires the lease (`holder_pid`,
  `lease_acquired_at` and `holder_start_time` on the `runs` table). `conduit run` takes it in
  the same insert that registers the run, so a launch killed before its engine starts still
  leaves a holder behind, and `conduit run status` reports that run as halted. A launch that
  fails after registering records the run halted and releases the lease; the row is kept, not
  deleted. When it failed (or was killed) before seeding its entry card, the run has no cards,
  `conduit run status` reports the launch as failed, and running the same `conduit run
  --run-id` command again retries it in place, in one transaction that refuses the retry as a
  lease conflict while another live process holds the lease.
- A second process invoked against the **same run id** fails fast — exit code 1, with a clear
  message naming the run id and the holding pid — instead of racing the first process or
  silently corrupting shared run state.
- A stale lease left by a **dead** holder is reclaimed automatically — a crashed holder doesn't
  permanently wedge the run. The holder is identified by pid and process start time, so a pid
  the kernel has since given to another process does not count as the holder.

This is advisory, single-host locking: it depends on reading pid liveness and
`/proc/<pid>/stat` on the same host as the lease holder. Where the start time cannot be read
(no `/proc`, or a lease recorded before schema v12), the check falls back to pid liveness
alone. It is not a distributed lock.

## What you still own

Conduit doesn't queue or bound run dispatch for you. As the integrator:

- **Process fan-out and bounding.** If you're dispatching runs from a webhook, queue consumer,
  or scheduler, you decide how many `conduit run` processes exist at once and how they're
  throttled. Conduit does not impose a ceiling.
- **Backpressure.** If your trigger volume exceeds what your host can drive, that's a dispatch
  decision on your side (queue depth, rate limiting), not something the kernel arbitrates.
- **Distinct entry-input paths per concurrently-seeded run.** Don't point two concurrently
  running, distinctly-`run-id`'d runs at the *same* `project_root` if you're re-seeding the
  entry station's input with different content for each — seeding is fail-closed (see the
  pre-public changelog's entry-seeding note: a pre-staged entry artifact that already exists with different
  content refuses the run rather than silently overwriting it). Use a per-run project root
  (`--project-root`) whenever concurrent runs seed distinct content.

## Explicit non-goals

- **Multi-host.** SQLite's single-writer model and the pid-liveness reclaim are both
  single-host mechanisms. There is no distributed claim, no network-aware lease, no support
  for `conduit.sqlite` on a network filesystem shared across hosts. An always-on, multi-host,
  multi-flow service (`conduitd`) is a deferred future-watch item — see SPEC §10A and SPEC §17
  F1 / build-order F1.
- **Containers with separate pid namespaces sharing one volume-mounted DB.** Pid-liveness
  reclaim reads pids from the local pid namespace. Two containers each with their own pid
  namespace, both mounting the same `conduit_data` volume, can each see pid 1 as "alive" for
  what is actually a dead process in the *other* container — defeating stale-lease reclaim.
  Run overlapping `conduit run`/`resume` processes for the same run id in the **same**
  container (or same host pid namespace), not split across containers.

## Under contention

What actually happens when two processes hit the DB at once:

1. Each write attempt gets SQLite's own `busy_timeout` window (5s) to acquire its lock.
2. If that's exceeded, the bounded retry kicks in: a handful of attempts with exponential
   backoff and jitter (~50ms → 1s cap).
3. If contention persists past the retry budget, the process surfaces a loud, specific error
   naming the contention — never a silent hang, and never partial/corrupted state. WAL +
   the atomic claim mean a transaction either commits whole or doesn't commit at all.

## See also

- [installation.md](./installation.md) — `--concurrency K` (in-process worker pool), Docker
  volume mounts for `conduit.sqlite`.
- [ingress-listener.md](./ingress-listener.md) — the listener spawns one `conduit run` per
  distinct event; each spawned run gets its own run id.
- [Pre-public changelog](./history/pre-public-changelog.md) — the historical
  entries for fail-closed entry-input seeding, the run lock, and busy-retry work.
