# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

**MVP kernel + harness precursor tier shipped with Phase 1 exit criterion met (v0.3.1).** Build-order steps 1–7 (deterministic substrate:
transform + deterministic stations, atomic claim, tick planner, checkpoint binding stamps, exactly-once
recovery), 7.6 (multimodal image inputs), 7.7 (Docker packaging), 8.1 (deterministic fan-out/fan-in +
rank/HITL), 8.2 (ingress listener, including one run per subject for a webhook `run_key`: events
become passes of that run via `conduit run --append-pass`, routed by `src/ingress/keyed-runs.ts`), **9c (harness precursor tier: `kind: harness` station wrapping
external headless agent CLIs)**, and **engine-config adapter registration (per-run projectRoot binding)**
are complete and driven by `runExecutor`. The owned-paths integrity gate, checkpoint cascade invalidation,
the per-wave subtree budget, and the harness adapter registry (environment-config populated at boot) are
wired. Phase 1 exit criterion met: research flow runs end-to-end with real adapters (claude-headless,
codex-exec) and self-serve E2E evidence via `CONDUIT_E2E_CLAUDE=1`. Remaining: the **Law-grade agentic
Tool-Bridge** (step 9b, `prd/drafts/`), and the **kaizen** loop (step 10) — see the build order in
`SPEC.md §16` and `docs/build-order.md`.

## What this is

Conduit is a **deterministic, model-independent flow-shop for LLM labor** — a lean-manufacturing assembly line applied to knowledge work. The kernel is a Bun/SQLite state machine; LLMs are workers at stations, never in the control loop.

The central insight: three independently-built systems (A(i)-Team for code, Studio for ad assets, Autocut for video) converged on the same kernel architecture. Conduit extracts that kernel so **the flow becomes config (`flow.yaml`), not code**.

## Orientation — read in this order

1. `docs/philosophy.md` — the worldview (why shaped this way)
2. `README.md` — the pitch, glossary, and build order
3. `SPEC.md` — the full design (state machine, `flow.yaml` schema, quality system, cost model)
4. `adr/` — why each major decision was made

## Core concepts

### The vocabulary (lean → Conduit)

| Lean term | Conduit component |
|---|---|
| Production line | a `flow` defined in `flow.yaml` |
| Station | a lane with a worker and optional QC |
| Kanban card | a `card` (epic = parent card, task = child) |
| Quality gate | a `check` station (LLM critic) with a back-edge |
| Rework loop | reject-to-an-earlier-station, bounded by four guards |
| Scrap bin | the `scrap` terminal lane |
| Andon cord | the global run budget + liveness watchdog → halt |
| Standard work | a crystallized **skill** (named, reusable) |

### Station taxonomy — the key distinction (SPEC §4)

Every station is classified on two orthogonal axes:

**Axis 1 — execution `kind`:**
- `deterministic` — no LLM; a command or function (`ffmpeg`, `git`)
- `transform` — one LLM call, typed data in/out, **no tools, no loop** (most critics/briefers)
- `agentic` — LLM with Read/Write/Bash in a multi-turn loop (the full Tool-Bridge)

**Axis 2 — `effectful: true|false`:**
- `pure` — replays cleanly from checkpoint
- `effectful` — billed call or irreversible side effect (image-gen, git commit, publish) → needs the outbox + idempotency key

This matters because **the Law (§7) applies only to `agentic` stations**. A `transform`-only flow (Studio) ships without any of the agentic safety surface. The MVP can be built without it.

### The state machine — `(lane, status)` (SPEC §3)

Each card has two orthogonal fields:
- **`lane`** — *where* the card is (routing). Either a station from `flow.yaml` or a kernel terminal (`intake`, `done`, `scrap`, `hold`).
- **`status`** — execution sub-state (scheduling). Universal: `waiting → ready → claimed → working → done_pending_ack`, plus `interrupted`, `held`, `awaiting_children`, `scrapped`.

A card is dispatchable iff: `status=ready` AND lane is a work station AND under WIP cap AND a worker slot is free — ANDed in a **single atomic SQLite transaction**.

### The quality system (SPEC §6)

Quality comes from `work → check → bounded rework`, not from one smart call. Keep two checks strictly separate:
- **Integrity check** — deterministic Summary Hook in the DONE transaction (files ⊆ owned paths, schema valid)
- **Quality check** — a separate QC station (LLM critic, usually a pure `transform`, back-edge to an earlier lane)

Rework is bounded by **four independent guards**: per-card, **per-gate** rework cap → scrap (`rework_cap` is declared on each station's `check:` block, so the counter it bounds is scoped to the `(card, gate)` pair — `cards.rework_count` stays the card's lifetime total, which is history, not a budget), per-execution-attempt cap, progress-monotonicity on findings hash (not artifact), and budgets at card/wave/run scope + liveness watchdog.

### The Law (SPEC §7)

Because Conduit runs its own runtime with no provider safety net, the Law is the **only guardrail**:
- Path ownership — writes ⊆ card's `owned_paths`, symlink-resolved
- Bash positive allowlist — only listed executables, no shell metacharacters
- Network egress denied by default for content workers

The Law applies to `agentic` stations only. It is load-bearing; hooks must have unit tests. A disabled hook is how a flow learns to `rm -rf` the wrong directory.

### Checkpoint soundness (SPEC §5)

Each checkpoint carries a **binding stamp**: `hash(model_id, prompt_template_version, input_artifact_hashes, flow_version)`. A completed station is skipped on resume **only if the binding stamp matches**. Mismatch invalidates and cascades downstream. Effectful stations additionally use an outbox + idempotency key (never blind-retry a publish/commit).

## Runtime and packaging decisions

- **Bun** (ADR-0002): the kernel runtime. One binary provides `Bun.spawn` (vfork, cheap), native `process.send` IPC (no broker), in-process `bun:sqlite` (no driver), and zero-compile TypeScript. The kernel and userland are one language, hot-loadable.
- **Docker-first** (ADR-0003): distribute as Docker images with Bun baked in. `conduit.sqlite` + project root must live on a mounted volume — never the ephemeral container FS. Secrets via env/-e, never baked into an image layer. Agentic flows get container-level blast-radius containment.

## Build order

See [`docs/build-order.md`](./docs/build-order.md) for the canonical sequence. Steps 1–7 ship the MVP (Studio, no agentic surface); 7.6–7.7 add multimodal input and Docker packaging; 8.1–8.2 add deterministic branching/HITL and the ingress listener (all shipped). The remaining steps 9–10 add the agentic Tool-Bridge and kaizen.

### Built-as-library vs. driven-in-production

Some kernel modules are **fully implemented and unit-tested but not yet called by the production executor** (`src/controller/executor.ts` / `runExecutor`). This is deliberate — they are later-build-order capabilities waiting for their step — **not dead code or bugs**. Do not assume `runExecutor` exercises them just because the tests are green; the unit tests drive the modules directly, and some integration/crash tests drive the `src/test-harness/` scaffolding (`crash-oracle.ts`, `reference-flow-runner.ts`) rather than `runExecutor`.

**Wired into `runExecutor` today:** the `(lane, status)` FSM (`statemachine/transitions.ts` — the executor routes every post-work transition through `transition()`), the effectful outbox + idempotency discipline (`checkpoint.ts` `writePendingIntent`/`commitIntent`/`reconcileOnResume`, gated on `station.effectful`), `cap_policy` (`flow.defaults.capPolicy`, applied via the FSM) with guard #1's counter derived **per `(card, gate)`** from the card_log (`quality/rework.ts` `countGateReworks`) rather than the card's lifetime `rework_count`, the atomic claim, checkpoint skip-on-resume (binding-stamp match), **binding-stamp cascade invalidation** (`cascadeInvalidation` — a stale upstream stamp on resume invalidates downstream checkpoints), the **MARK_DONE owned-paths integrity gate** (`worker/integrity.ts` `checkIntegrity` — opt-in per flow via `defaults.enforce_owned_paths`; a write outside `owned_paths` hard-pauses to `hold`), the **per-wave/subtree budget** (`aggregateByWave`/`checkWaveBudget` — guard #4's wave scope; an over-budget `parent_id` subtree is scrapped without halting the run), **fan-out / fan-in** (`dag/expand.ts` `commitFanOut`/`validateExpansion`/`evaluateFanIn` — acyclic-deps + disjoint-ownership validation, child seeding, quorum/all/best-effort merge), **card-scoped input resolution** (issue #51: `flow/resolve-input.ts` `resolveInputPath` is the one resolver for the transform and harness binding-stamp hashers, `renderPrompt`, the harness input mounts and the gate critic's mounts; names in a station's `input_scope.owned_dir`, plus the reserved `seed.json`, resolve from the card's `owned_paths[0]` against `projectRoot`, everything else from `projectRoot`, and every read is confined to the directory it resolves from. A card-scoped input on a card with no owned dir fails closed: the stamp hashes `''`, render throws, and a harness station holds the card), **rank QC + HITL selection** (`quality/rank.ts` `runRankCheck` — short-list, hold for a human pick, `conduit reply`), **harness-critic spend folded into the run/wave budgets** (issue #26: `quality/gate.ts` `runHarnessGateCheck` binds the `HarnessResult` it used to discard and returns a `CriticUsage` on every `GateDecision` branch, including the failure ones, since a critic that timed out or returned a garbled verdict was still billed; `runGateCheckOrAdvance` folds it via `foldHarnessUsage` BEFORE its andon check, so a budget-busting critic trips on its own spend, and journals it as `<station>.harness-critic`, a name kept deliberately distinct from the maker's `<station>.harness` because `countConsecutiveRateLimitParks` keys its streak on that exact string. Only the AGENTIC critic populates `criticUsage`: a transform critic's spend already folds through `trackingAdapter`, so populating it there would double-count, and a regression test pins that asymmetry. `check.critic.model` now reaches `HarnessInvocation.model` with station-over-adapter precedence, reading the loader's `''` as absent rather than as a model name. A harness throw that carried usage is billed rather than written off: `worker/harness-adapter.ts` `usageFromThrow` is the single reader, the claude and codex adapters attach a recovered figure to their classified throws, and both the maker catch and the rate-limit park fold it), **named harness agents** (issue #28, and #109 for `agent-sdk`: a `claude-headless` or `agent-sdk` station's `agent:` or `check.critic.agent` resolves through `worker/harness-adapter.ts` `resolveHarnessAgent` against `CONDUIT_HARNESS_<NAME>_PLUGIN_DIRS` at load and again at dispatch, and a miss holds the card; the maker folds the agent name and definition-file SHA-256 into `prompt_template_version` via `computeAgentAwarePromptTemplateVersion`, and the critic, which writes no checkpoint, records them only on its journal span. On the SDK path the CLI runs its default agent, without an error, when it cannot find the requested one, so `agent-sdk` also checks the init message's `agents` list and each main-thread tool call's `agent_type`, and a miss ends the call with `HARNESS_GATE_HOLD_CODE`, which holds the card), **run-scoped `CLAUDE_CONFIG_DIR` isolation** (issue #29, opt-in via `_ISOLATE_CONFIG`: `worker/claude-config-isolation.ts` builds a per-invocation dir holding only a credentials link), journal provenance on stamped station spans (`binding_stamp`, effective prompt version, `agent`, `agent_sha256`), the consumption andon, the liveness watchdog (`checkLiveness`/`checkConsumptionAndon` — a card gated behind a future `cards.release_at` counts as scheduled, not stalled), the **rate-limit park** (a `harness-rate-limited` adapter throw re-readies the card behind `release_at` via the FSM's `RATE_LIMITED` event, consuming no execution attempt — on a rework invocation too, though an **effectful** station escalates to `hold` instead of parking, because its pending outbox intent would re-dispatch at the same idempotency key and reconcile can only answer `escalate_hold`; because no rework guard bounds a park, consecutive parks are counted from the `<station>.harness` journal spans and the `MAX_CONSECUTIVE_RATE_LIMIT_PARKS`th hard-pauses the card to the `hold` lane instead of parking again; a run the consumption andon halts while every unfinished card is so parked — or `waiting`/`awaiting_children` on one that is — is recorded `outcome='parked'` by the CLI (`run/run-state.ts` `getRunParkedRelease`, which asks `soonestRateLimitGate` whether the card_log attributes the gate to a provider cap, since the fan-out stagger stamps the same `release_at` column; re-confirmed against the cards by `getRunState`) and stays resumable — the ingress listener resumes it itself once the gate passes (`ingress/parked.ts`, skipping any event whose launch is already in flight); bounded backoff via `worker/harness-retry.ts` paces every other retryable class), the **harness idle timeout** (issue #31, opt-in per station via `worker.idle_timeout_seconds`: `worker/harness-runner.ts` `runHarnessProcess` kills the process group when no stdout line arrives for `idleTimeoutMs`. The two adapters that drive a long-lived server instead of a one-shot process carry their own copy of the guard, because `runHarnessProcess` cannot drive a session: `codex-app-server` resets it on every stdout JSON-RPC line, and `opencode` on every SSE event except `server.heartbeat`, which proves the server is up, not that the model is working. A change to idle-timeout semantics must be made in all three. `checkLiveness` runs only between ticks and a harness station awaits one `invoke()` for the whole tick, so these adapter-side timers are the only check on a hung harness call; the mid-call `onProgress` stamp from #33 does not provide one. An idle kill throws `harness-idle-timeout` and is retried like `harness-timeout`: it spends an execution attempt and is never parked), **per-invocation cgroup containment** (issue #77: `worker/cgroup-containment.ts`; both `runDeterministic` and `runHarnessProcess` spawn each command in its own cgroup v2 `conduit-<pid>-<start time>-<n>` (the start time keeps the stale-cgroup sweep correct when a dead kernel's pid is reused, issue #81) and write `cgroup.kill` alongside every process-group kill, so a descendant that called `setsid()`, as every Claude Code Bash-tool command does, dies with its invocation. That holds while the descendant stays in the invocation's cgroup: commands run as the kernel's user, who can write the parent cgroup, so one that writes its own pid into the parent's `cgroup.procs` escapes, and the container is the boundary for that case (issue #79). `resolveContainment` detects the mechanism once per process with a real probe; a host where that fails, such as a default Docker container with a read-only `/sys/fs/cgroup`, falls back to the process-group kill alone, warns once on stderr, and `conduit doctor` reports which mechanism is in use), and the **event-driven worker pool** (`conduit run --concurrency K>1`): real out-of-process workers (`worker/worker-entry.ts`, spawned via the `makeWorkerPool`/`buildWorkerPool` seam as `conduit __worker`), START_WORK/MARK_DONE over Bun IPC (codec-validated by `worker/ipc-protocol.ts`), the K-bounded concurrency cap (run-level `concurrency` ANDed with station `wip` via the atomic claim), `beginWork`-stamped leases + live `reconcile` for hung-worker reclaim, MARK_DONE token attribution into the run/wave budgets, and `watchdog.planDrain` (drain/hard-kill on andon trip — now driven against genuinely concurrent in-flight workers). Only PLAIN PURE deterministic stations are POOLED as out-of-process workers; transform/agentic/fan-out/effectful/`enforce_owned_paths` stations stay in-process. **(v10)** Under `concurrency>1`, plain TRANSFORM siblings ready in one tick run as *overlapping in-process adapter calls* (the fan-out reviewer case) — per-call token attribution isolated via `AsyncLocalStorage`, K-bounded, with fan-out/effectful/gated/deliver/rank transforms excluded and still serial. **`kind: harness` stations, gated or not, run one card at a time under any K** (issue #30): `poolEligible` admits only `kind: deterministic` and the overlap batch only `kind: transform`, so a harness station falls through to the synchronous `await executeStation(...)` and the tick loop dispatches nothing else until it returns. A gated harness station is excluded a second time, because its gate path (`runGateCheckOrAdvance`: critic call, per-gate rework counter, back-edge transition) is serial in-process logic enforcing SPEC §6. Every harness maker and critic span records `ready_waiting` (other dispatchable cards when the call started), and `conduit run status` reports per-station harness busy time against run wall clock (`run/harness-occupancy.ts`). An optional `child_stagger_seconds` on the fan-out station gates siblings behind `cards.release_at` so the first child warms a shared prompt-prefix cache before the rest fire. **`skip_when`** (issue #32): a station may declare `skip_when: { source: seed | output, field, equals }`, validated at load (`flow/load.ts` `validateSkipWhen`: the station declares `next`, no other station reads its outputs, no gate's `on_reject` targets it, and a `source: output` predicate does not name a station that itself declares `skip_when`, since that station's checkpoint would go stale rather than absent once it skips). Before `planTick`, `applySkipWhen` evaluates it via `controller/skip-when.ts` `evaluateSkipWhen` (seed.json in `owned_paths[0]`, or the latest checkpoint of an upstream transform through `readLatestCheckpoint`) once per dispatchable card, not once per loop iteration: a `run` decision is memoized for the lifetime of the `runExecutor` call, keyed by `(card, lane, attempt)`, so a card a wip cap or a busy station keeps waiting does not re-read its seed.json or re-query the checkpoint on every later tick; a new execution attempt or a new lane is a fresh key. A match fires the FSM's `SKIP` event: the card moves to the station's `next` with no claim, no worker, no checkpoint and no counter change, and the card_log records an `entered_lane` row with reasonClass `skip` plus a `skip` row naming the predicate and value (shown by `conduit journal inspect`) — both rows are written only after `applySkipWhen` re-confirms the card is still `ready` inside a `BEGIN IMMEDIATE` transaction on the state DB, so a concurrent writer that moved the card first (the same window `advanceCard`'s journal-first ordering tolerates via `INSERT OR IGNORE` dedup on replay, here closed by taking the write lock before journaling) leaves no phantom skip in the journal. An unreadable predicate holds the card in place — through the same `withVerifiedReadyCard` re-check, so a concurrent writer racing a hold gets the same treatment as one racing a skip, rather than being overwritten by `escalateToHold`'s own unguarded UPDATE. The **harness event journal** (issues #70 and #71): every adapter except `codex-exec` (`claude-headless`, `agent-sdk`, `codex-app-server`, `opencode`) emits `HarnessEvent`s (`worker/harness-events.ts`, `worker/harness-events-claude.ts`) to `HarnessInvocation.onEvent`, and the executor passes a sink on every harness `invoke()`, maker and gate critic alike. `stampHarnessEvents` mints one `invocationId` per call and stamps it with the attempt: the maker mints inside its retry loop, so a rate-limit re-invoke under the same attempt gets a new id, and the critic's id is minted in the executor and threaded through `runGateRework` to `runHarnessGateCheck`. `worker/harness-events-journal.ts` `createHarnessEventJournalSink` writes only `tool-input-available`, `tool-output-available`, `usage`, `rate-limit`, `lifecycle` and, for a per-call-gated adapter, `gate-decision` to the journal DB's `harness_events` table, keyed `(run, card, station, attempt, invocation_id, seq)`, and drops the deltas. It stores no prompt text and no tool input or output body: a tool call is recorded by name and the path it touched, a result by its error flag and, for a failed Bash call, the exit code parsed from its `Exit code N` error string (NULL otherwise). A write failure is swallowed, so a journal error cannot fail a billed call. Every `<station>.harness` and `<station>.harness-critic` span carries the same `invocation_id`, which is how rows join to their span, and `conduit journal inspect` / `tail` print each harness span's rows beneath it, plus the rows of any invocation with no span, labelled `(no span)` (a live call, or one that never finished), read-only. The `codex-exec` adapter emits no events, so its calls have spans with an id and no rows. The **per-call tool gate** (issue #21): an adapter with `canGatePerCall` receives `HarnessInvocation.gate`, built per invoke by `createHarnessToolGate` (`worker/harness-gate.ts`) from the station's `tools`, and consults it through `callGateFailClosed`, so a throw or a malformed answer is a deny. Three adapters do: `agent-sdk` (`worker/harness-adapter-agent-sdk.ts`, the Claude Code CLI driven through the Agent SDK, consulted from `hooks.PreToolUse`; other hooks run beside the gate and a deny from either wins, but another `PreToolUse` hook's `updatedInput` replaces an approved input and the gate cannot prevent it, so the adapter records each approved input per `tool_use_id` and its `PostToolUse`/`PostToolUseFailure` hooks hold the card, code `input_rewritten`, when the input that ran differs: detected after the call runs, not prevented, issue #109) and `codex-app-server` (`worker/harness-adapter-codex-app-server.ts`, `codex app-server` under the `untrusted` approval policy, which asks before every shell command and patch, subagents' included: the adapter unwraps the shell wrapper to a `Bash` call, gates every path of a `fileChange` item as `Write`/`Edit`, gates MCP approvals as `mcp__<server>__<tool>`, answers any other server request with a JSON-RPC error, and sends only `accept`, `decline` or `cancel`, never `acceptForSession`) and `opencode` (`worker/harness-adapter-opencode.ts`, a per-invocation `opencode serve` started with `permission: {"*":"ask"}` and read over raw HTTP and SSE: each `permission.asked` is joined by `callID` to its tool part for the real tool and path, mapped to the gate's Claude vocabulary, and answered `once` or `reject` only, never `always`; `external_directory` is always rejected, a `question` is a hold, and the server needs a random Basic-auth password on every request). The gate enforces the tool allowlist, the Bash positive allowlist (`Bash(<exe>)` and `Bash(<exe>:*)` entries only), write ownership on the file-write tools, and denies `WebFetch` and `WebSearch`. It receives `ownedPaths` only when the flow sets `enforce_owned_paths` AND the card declares some, the condition `runOwnedPathsIntegrity` uses; without them it confines file-tool writes to the canonical project root rather than allowing any path, because the harness integrity check scans only the project root and would never see a write outside it. A gate critic may write only `verdict.json`. A `hold` decision (`AskUserQuestion`) ends the process and throws `HARNESS_GATE_HOLD_CODE`: the executor holds the card through `escalateToHold` without spending an execution attempt, on the maker path and, through `GateDecision` `hold`, the critic path, and the recovered usage goes through the existing folds. Every call the gate sees emits a `gate-decision` event, journaled as its own `harness_events` kind because the SDK reports a hook denial nowhere. The MARK_DONE integrity check stays the backstop for Bash writes, and a hold stops the CLI with `continue: false` so it emits its result message, which the thrown error carries as usage; every later call is denied without asking the gate, and a CLI that emits no result within 5 seconds is killed and bills nothing. `codex-app-server` answers a hold with `cancel`, which interrupts the turn, and Codex reports no usage for an interrupted call, so the thrown usage is only what `thread/tokenUsage/updated` had reported (summed per thread, last total each, no cost) and the call in flight is not counted. Its `tools` list is the same gate allowlist, except that Codex has no Read, Glob or Grep tool (reads are shell commands needing `Bash(<exe>)` entries) and the shipped gate never holds a Codex call: `createHarnessToolGate` holds only `AskUserQuestion`, which Codex has no counterpart for, so the adapter's hold path (above) runs only for a gate that returns `hold` on another call. It runs in its own cgroup with a run-scoped `CODEX_HOME` (always, no opt-out), with web search and the other built-ins that do not ask turned off by `-c`, and the `workspace-write` sandbox confines nothing on a host without `bwrap`. On a hold `opencode` rejects the ask, denies later asks unasked, waits (5 s bound) for the step in flight to report tokens, then aborts the session, so the thrown usage includes that step. It sums the last value per assistant message over the session tree (child sessions carry the subagent's `agentId`), runs in its own cgroup with run-scoped XDG directories and only the model provider's credential entry, and needs a `provider/model` (no default). Its rate-limit shape is inferred, not observed.

**Built but NOT yet driven by `runExecutor`:** none of the kernel substrate remains library-only — the remaining unshipped work is the agentic Tool-Bridge (step 9) and kaizen (step 10), which are new surfaces rather than wired-vs-unwired modules.

When you pick up a later build-order step, prefer **wiring the existing library module into `runExecutor`** over re-implementing its logic inline — then point the integration/contract tests at the real executor path so the SPEC guarantee becomes one the shipping binary actually provides.

## Docs are an input, not a cleanup step

Parts of this repo are **normative**: SPEC.md does not describe what the kernel
happens to do, it states what the kernel must do. The Law (§7), the four rework
guards (§6), the binding stamp (§5), and the `(lane, status)` FSM (§3) are
specified behaviour, and `CLAUDE.md`'s wired-vs-library inventory is what steers
every agent session. Code that contradicts them is wrong even when its tests are
green — and prose left behind by a change quietly misleads the next agent.

[`drift`](https://github.com/fiberplane/drift) binds those documents to the
symbols they govern. `drift.lock` records, per binding, an AST fingerprint of
the target at the moment someone last vouched for the prose. It is a routing
table, not a correctness checker: it tells you *which paragraph to re-read*,
never that a paragraph is right.

Two obligations, at two different moments. They are separate on purpose — one is
an input to the work, the other is only answerable once the work has settled.

**Once, when you scope a task** — not per edit — name the files the task will
touch:

```bash
bun run docs:governing src/quality/rework.ts src/controller/gate-rework.ts
# -> SPEC.md
```

Anything it prints makes claims about the code you are about to change. **Read
those sections and implement against them.** Silence means nothing is bound and
there is nothing to read — the common case, and it costs nothing. Do not skip
this because a change looks small: issue #1 was a one-line cap comparison whose
correct behaviour was specified in SPEC §6.

Run it once per task, not once per edit. Editing a file five times does not make
SPEC §6 say anything new.

**At commit time** — enforced by `.githooks/pre-commit`. Two different commands,
and the difference matters:

```bash
bun run docs:check       # SCOPED to your staged files — what the hook runs.
bun run docs:check:all   # the WHOLE corpus. Informational; see below.
```

The scoped form covers deletions and both sides of a rename, since a binding
whose target no longer exists is precisely what needs flagging, and it fails
closed — if it cannot determine what is bound, it errors rather than reporting a
clean bill of health. (The `docs` CI job runs the same
`scripts/docs-check.sh` over a commit range instead of the index.)

Reach for `docs:check:all` only when you want the repo-wide picture. It is
deliberately **not** what gates anything: unscoped, a single stale anchor
anywhere fails you for drift you did not introduce, which is how a check earns a
permanent `--no-verify`.

The commit is the unit here because "is this prose still true?" cannot be
answered while the code is still moving; asking per-edit asks before the answer
exists, and invites rewriting a SPEC paragraph three times as one change
settles.

A stale anchor is an obligation, not an error. Re-read the section it names,
then either fix the prose or confirm it still holds — re-stamping **the document
the check named**, which is not always `SPEC.md` (`CLAUDE.md` and
`docs/installation.md` carry anchors too):

```bash
drift link <doc> --doc-is-still-accurate     # e.g. drift link SPEC.md ...
```

`drift link` **refuses** to re-stamp a stale anchor without that flag. Passing it
is an assertion that you re-read the doc. Do not pass it to make the hook or CI
pass — a `drift.lock` diff that re-signs anchors while changing no prose is
exactly what reviewers look for.

**When adding or renaming a governed symbol**, update the binding
(`drift link <doc> <file#Symbol>` / `drift unlink`) in the same change.

Bindings are deliberately **symbol-level** (`file#Symbol`), not file-level: a
binding to all of `src/controller/executor.ts` would flag on nearly every PR and
train everyone to re-stamp reflexively, which is worse than no binding. And the
binding set is deliberately small — `adr/`, `docs/archive/`, `docs/history/`,
`prd/`, `CHANGELOG.md` and the `examples/`+`fixtures/` prompt templates are
**never** bound. An ADR is a dated record of a decision and is *supposed* to
describe the world as it was; prompt templates are runtime inputs, not docs.

## A green suite does not mean a budget is wired

`foldHarnessUsage` is how a billed harness call reaches the run and wave
budgets. There are five call sites, all in `src/controller/executor.ts`: the
gate critic, the rate-limit park, the maker throw, the maker success, and the
subflow roll-up. Deleting any one of them breaks no type, no schema and no
journal row — the row is written by a different line — so the only thing that
goes wrong is that `tokensSpent` is too low, on exactly the runs that cost the
most. Issue #26 shipped that way, and an early version of #26's own tests
passed with one of the folds removed, because the assertion read the journal
instead of the accumulator.

`bun run test:mutation` (`scripts/mutation-check.ts`) deletes each fold site in
turn and requires a named test to fail. It runs in the required CI gate and
takes about three seconds. Two obligations follow:

- **Assert on the accumulator, not the journal.** A test that proves usage was
  *recorded* does not prove it was *counted*. Reach for `tokensSpent`, or for a
  budget that trips.
- **If you move, rename or add a fold site, update the manifest in the same
  change.** A `find` string that no longer matches fails the check rather than
  skipping it, deliberately: a silently skipped mutant is the same failure mode
  the script exists to catch. `--list` prints each site and what goes wrong
  without it.

The manifest is small on purpose: the five fold sites, plus the line in
`src/worker/harness-events-claude.ts` (`claudeResultBreakdown`) that makes a
Claude harness call's token figure the session total from `modelUsage` rather
than the last result message's `usage` (issue #108). Its guard lists were
found by mutating and seeing what broke, not by guessing. Keep them that way.

## Design principles to apply consistently

- **Deterministic flow, non-deterministic labor.** The kernel decides what's legal next; LLMs only produce and judge. No LLM in the steady-state dispatch loop.
- **Escalate ambiguity; never guess.** On contradictory/unrecoverable state → hard-pause to `hold`, surface to a human. Don't auto-reverse.
- **Config is validated, not trusted.** `flow.yaml` is checked at load (disjoint path ownership, legal transitions, acyclic deps) before anything runs.
- **The check is the quality engine.** The back-edge is the point; separate maker from inspector (different prompt, often different model).
- **Two andons, not one.** The consumption andon (wall-clock + tokens, busy runaway) and the liveness watchdog ("no progress + no active worker", deadlock/stall) are distinct and both necessary. Scheduled waiting is neither: a card behind a future `release_at` is not a stall, and only the consumption andon bounds how long a run may wait for it.

## Key mechanisms modeled on A(i)-Team

The kernel design is substantially proven — the same patterns run in production across three flows. See SPEC Appendix B for the full conceptual mapping. Key ones:
- Lane graph + transition matrix
- Deterministic tick / action plan (replaced a runaway LLM orchestration loop)
- Generation-keyed idempotent action IDs (fixes prefix-dedup blocking legitimate rework)
- Dependency waves + DFS cycle detection
- `needsJudgment` fail-closed escalation

## Maintainer-only: A(i)-Team Integration

> This is a private maintainer workflow. External contributors do not need the
> A(i)-Team plugin or any `/ai-team:*` commands; follow
> [`CONTRIBUTING.md`](./CONTRIBUTING.md) instead.

Maintainers use the A(i)-Team plugin for PRD-driven development.

### When to Use A(i)-Team

Use the A(i)-Team workflow when:
- Implementing features from a PRD document
- Working on multi-file changes that benefit from TDD
- Building features that need structured test → implement → review flow

### Commands

- `/ai-team:plan <prd-file>` - Decompose a PRD into tracked work items
- `/ai-team:run` - Execute the mission with parallel agents
- `/ai-team:status` - Check current progress
- `/ai-team:resume` - Resume an interrupted mission

### Workflow

1. Place your PRD in the `prd/` directory
2. Run `/ai-team:plan prd/your-feature.md`
3. Run `/ai-team:run` to execute

The A(i)-Team will:
- Break down the PRD into testable units
- Write tests first (TDD)
- Implement to pass tests
- Review each feature
- Probe for bugs
- Update documentation and commit

**Maintainers:** do not work on PRD features directly without using
`/ai-team:plan` first.
