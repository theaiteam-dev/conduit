# blackbox/

Black-box test suite for Conduit. Tests here exercise the shipped binary /
CLI surface only — **no imports from `src/`** — so they verify what a real
user or CI consumer actually sees, not internal implementation details.

## Layout

- `harness/journey-harness.ts` — the shared fakes + reusable assertions
  (`startJourneyHarness()`). The **only** module in this suite that owns the
  fake Slack server, the fake model gateway, workspace scaffolding, and spawn
  observation. Kept separate from `src/test-harness/`, which drives
  white-box crash/reference-flow tests against the executor directly.
- `golden-journey.test.ts` — the FR-1 golden Studio journey (WI-679): signed
  Slack event → real `conduit run` → HITL rank ask → Socket Mode reply →
  real `conduit resume` → terminal `done`, asserted entirely through public
  surfaces. This is the **worked example** every fault variant below builds on.
- `fault-*.test.ts` — fault variants of the golden journey (see "The standing
  rule" below). `fault-stalled-slack.test.ts` (WI-680) is the first shipped
  example.
- `harness/fake-claude.ts`: a scenario-driven stand-in for the headless
  Claude Code CLI. The harness-flow journeys point the shipped
  `claude-headless` adapter at it through engine config
  (`CONDUIT_HARNESS_CLAUDE_HEADLESS_COMMAND`). It reads a scenario JSON file
  named by `FAKE_CLAUDE_SCENARIO` (on the adapter's env allowlist), picks a
  role by a substring of the prompt, and uses a per-role counter file so call 1
  and call 2 can behave differently. Per call it can write files, emit
  stream-json lines (system/init, assistant tool_use, user tool_result,
  `rate_limit_event`, `result` with usage and `total_cost_usd`), delay, exit
  with a given code, go silent for the idle timeout, and spawn a `setsid`
  sleeper that writes its pid. Every invocation appends its argv, cwd and pid
  to a log. The stream shapes are copied from the recorded CLI fixture
  (`fixtures/harness/claude-stream-json.ndjson`), not imported.
- `harness/harness-flow.ts`: `startHarnessFlow()`, the scaffolding for
  `kind: harness` journeys. It writes a temp project (flow.yaml, prompts,
  inputs), temp state and journal DBs, the fake-claude scenario and a
  `#!/bin/sh` wrapper that execs it with the running bun binary (the adapter
  scrubs the child env, so `bun` may not be on its PATH). It runs the real
  `conduit run`, `conduit run status`, `conduit journal inspect` and
  `conduit doctor` as subprocesses. No Slack or listener. `journalSpans()` is
  a read-only journal DB read for span usage columns, which no CLI prints.
- `harness-happy-path.test.ts`: one harness maker writes its declared output
  and the card reaches `done`; checks exit code, `run status` occupancy, the
  `<station>.harness` span and its usage, and the argv the kernel passed.
- `harness-gate-critic.test.ts`: a harness maker gated by an agentic
  (`check.critic.harness`) critic. The critic rejects then passes, and the
  card goes back through the maker to `done`; a second case always rejects
  and the per-gate `rework_cap` scraps the card.
- `harness-critic-budget.test.ts`: the run token budget counts the critic's
  spend (issue #26). Maker alone is under budget, maker plus critic is over,
  and the run halts on the tokens andon; a control run with more budget
  completes. The halt prints one andon line, and `run status` reports the run
  halted with its resume command (#83).
- `harness-idle-timeout.test.ts`: `worker.idle_timeout_seconds` kills a
  silent call, which is retried up to `max_execution_attempts` and then
  scrapped as `harness-idle-timeout`. A `setsid` sleeper spawned by the stub
  must be dead after the run when `conduit doctor` reports cgroup
  containment; under the process-group fallback that one assertion is skipped
  with a logged reason, or fails when `CONDUIT_REQUIRE_CGROUP_CONTAINMENT=1`.
  `blackbox.yml` sets that variable and creates a runner-owned cgroup before
  the suite, the same way `test.yml` does, so CI must take the cgroup branch.
- `harness-rate-limit-park.test.ts`: a blocking provider rate limit parks the
  card with no attempt consumed, and `run status` reports the run parked with
  its resume command, including when the park outlasts the wall-clock budget
  (#84).
- `harness/fake-codex-app-server.ts`: a scenario-driven stand-in for
  `codex app-server`, run behind the shipped `codex-app-server` adapter
  through `stub:` on `startHarnessFlow()`. `--version` prints the codex
  version the adapter checks against; `app-server` speaks the line-delimited
  JSON-RPC on stdio (initialize, thread/start, turn/start, turn/interrupt) and
  then, inside the turn, sends one approval request per scenario step: a
  shell command (`item/commandExecution/requestApproval`) or a file add
  (`item/started` fileChange, then `item/fileChange/requestApproval`). It runs
  the command or writes the file only when the kernel answers `accept`, then
  sends `thread/tokenUsage/updated` and `turn/completed`. Each turn logs its
  role, call number, argv, cwd, pid, the thread/start params and every
  decision received, in fields `stubLog()` reads. The message shapes are
  copied from the adapter's unit-test peer, not imported.
  `harness/fake-codex-app-server.smoke.test.ts` drives it directly as a
  JSON-RPC client.
- `codex-app-server-gate.test.ts`: the per-call tool gate (issue #21) on a
  real `conduit run` with `enforce_owned_paths`. In one turn the fake asks
  for an allowlisted `cat`, a `curl`, a redirect, a write of the declared
  output and a write outside the project root; the kernel accepts exactly the
  first and fourth, only those effects happen, the card reaches `done`, and
  `journal inspect` prints one `gate-decision` row per request under the
  `research.harness` span, whose usage is the fake's token total. A second
  case drops `enforce_owned_paths`: the gate then confines writes to the
  project root, so the output write is accepted and the out-of-root write is
  still declined. A third case declines every call, so the output is never
  written and the card is scrapped as `harness-output-missing` after
  `max_execution_attempts`.
- `harness/fake-opencode.ts`: a scenario-driven stand-in for
  `opencode serve`, run behind the shipped `opencode` adapter through `stub:`
  on `startHarnessFlow()`. It binds 127.0.0.1 on a free port, prints the
  listening line the adapter reads, and checks HTTP Basic auth against
  `OPENCODE_SERVER_PASSWORD` on every request, the event stream included (a
  wrong password gets 401 and an `auth-rejected` log line). When the prompt
  arrives it plays the role's steps over the SSE stream: a running tool part
  plus a `permission.asked` per bash, write or `external_directory` step, or a
  `question.asked`. It runs the command or writes the file only when the
  adapter answers `once`, then reports the assistant message's tokens and
  goes idle. Every log line carries the fields `stubLog()` reads plus a
  `kind` (`serve`, `prompt`, `answer`, `question-reject`, `abort`,
  `auth-rejected`). The shapes are copied from the adapter and its unit-test
  fake, not imported. `harness/fake-opencode.smoke.test.ts` drives it
  directly to prove the auth check rejects a wrong or missing password.
- `opencode-gate.test.ts`: the per-call tool gate (issue #21) on the
  `opencode` adapter in a real `conduit run`. In one invocation the fake asks
  for an allowlisted `cat`, an `ls`, a pipeline, an `external_directory` read
  and a write of the declared output; the fake records `once` for the first
  and last and `reject` for the rest, only those effects happen, the card
  reaches `done`, and `journal inspect` prints one `gate-decision` row per ask
  under the `research.harness` span, whose usage is the fake's tokens. A
  second case sends a question: the adapter holds, aborts the session, and
  the card lands in `hold` at attempt 0 with the call's usage billed.
- `no-internal-imports.test.ts` + `harness/import-scan.ts` — the zero-imports
  gate (AC-1): a TypeScript-compiler-API scan that fails if any file under
  `blackbox/` imports anything resolving into `src/`.
- `scaffold.test.ts` — pins the plumbing in this file (test-script scoping,
  the required `blackbox` CI job's name and unfiltered trigger).

## Platform requirements

**This suite requires Linux.** The harness observes the `conduit run`/`resume`
grandchildren the listener spawns by reading `/proc` (`SpawnObserver` in
`harness/journey-harness.ts`), which exists only on Linux; `startJourneyHarness()`
throws at boot on any other platform rather than dying later at an opaque
`waitFor` timeout. CI runs on `ubuntu`. macOS/Windows contributors should run
the suite inside a Linux container or VM.

## Running

```sh
bun run test:blackbox        # the suite itself
bun run typecheck:blackbox   # tsc --noEmit against blackbox/tsconfig.json
```

Both are **intentionally separate** from `bun run test`/`bun run typecheck`
(scoped to `src/` only). CI runs them in their own required job, `blackbox`,
alongside the `tests` job in `.github/workflows/test.yml`; a PR cannot merge
until both pass. See `.github/workflows/blackbox.yml` for the CI wiring and the
burn-in record that preceded promotion. `.github/workflows/release.yml` runs
the suite again, with the unit suite and the mutation check, before it
publishes, because a squash merge produces a tree no PR check ran on.
`scaffold.test.ts` pins both.

`blackbox/tsconfig.json` extends the root `tsconfig.json` and scopes
`include` to this directory — it is what makes `typecheck:blackbox` a real
signal. Before it existed, nothing type-checked files under `blackbox/`, so a
call to a method that didn't exist on `Harness` only surfaced at runtime.

## The standing rule: every production bug becomes a fault variant

**When you fix a bug that was found in production (or found live against the
shipped binary during review, the same category), the fix is not done until
this suite has a fault variant that reproduces the failure mode and asserts
the fix holds.** This is how the golden journey earns its name — it's not a
static demo, it's a growing net.

A fault variant does **not** need to be a 1:1 reproduction of the original
bug's exact trigger. It needs to exercise the same *failure class* against
the real shipped binary, through the same public surfaces the golden journey
already uses, so a future regression in that class is caught the same way.

## How to add a fault variant

Use `golden-journey.test.ts` as the structural template and
`fault-stalled-slack.test.ts` as the template for injecting a fault
mid-journey. The steps:

1. **Boot the harness.** `const h = await startJourneyHarness()` in
   `beforeAll`, `await h.cleanup()` in `afterAll`. Boot spawns a real
   `conduit listen` child (temp state+journal SQLite DBs, temp workspace, a
   scaffolded flow), a fake Slack Web API + Socket Mode server, and a fake
   OpenAI-compatible model gateway — all wired to the child purely via env
   (`SLACK_API_BASE_URL`, `CONDUIT_BASE_URL`, `CONDUIT_SLACK_SIGNING_SECRET`,
   DB paths). Never import anything from `src/` to do this — `startJourneyHarness`
   is the only sanctioned way in.

2. **Inject your fault before triggering the journey**, if it's a
   pre-existing condition:
   - `h.faults.setStall(surface, true)` — the named fake-Slack endpoint
     (`"chat.postMessage"`, `"files.getUploadURLExternal"`, `"upload_bytes"`,
     `"files.completeUploadExternal"`, `"apps.connections.open"`) accepts the
     request and never responds, up to a 10-minute internal cap (so a broken
     bound in the child will time the *test* out, not hang forever).
   - `h.faults.setDuplicateDelivery(true)` — every `sendSignedEvent` /
     `sendInteractiveResponse` call fires its payload twice, for testing
     exactly-once / idempotency guarantees.
   - Environment-variable faults (e.g. a short `SLACK_FETCH_TIMEOUT_MS`) must
     be set on `process.env` **before** calling `startJourneyHarness()` — the
     harness spreads `process.env` into the spawned child's env at boot, so
     setting it after boot has no effect on that child.

3. **Trigger the journey.** `await h.sendSignedEvent(event)` POSTs a
   correctly-signed webhook event to the child's real `/slack/events` route
   (the v0 HMAC scheme mirrors production exactly). Then
   `await h.waitFor(() => h.spawns.runInvocations().length >= 1, {...})` to
   observe the real `conduit run` child the listener spawns — never assume
   it happened, wait for it.

4. **If your variant needs a HITL reply**, discover the ask's correlation id
   (not printed by any CLI surface — see step 6) via
   `h.assert.explainField(cardId, "reason", { runId })` until it matches
   `/^hitl::/`, then call `await h.sendInteractiveResponse(correlationId, value)`.
   **Trap:** pass `correlationId` **verbatim** as the interactive action id —
   it already carries the full `hitl::<runId>::<cardId>::<station>::<attempt>`
   format from `executor.ts`. Prefixing it again (`` `hitl::${correlationId}` ``)
   double-prefixes to `hitl::hitl::...`, which the production correlation
   lookup never finds, so the resume silently never spawns. This bit the
   harness itself once (WI-679) — don't reintroduce it in a variant.

5. **Assert the outcome through a real public surface, not a DB read.**
   - `h.assert.exitCode(spawnRecord, 0 | 1)` — derives the run's actual
     kernel outcome (0 = reached `done`, 1 = reached `scrap`) fresh from the
     journal DB each call; throws a distinct "not yet resolved" error if the
     run is still parked (e.g. at `hold`), so you can `waitFor` on it safely.
   - `h.runConduit(args: string[])` — spawns `conduit <args>` for real
     against the harness's live DBs/env and returns `{stdout, stderr,
     exitCode}`. **This is the run-narration surface**:
     `h.runConduit(["journal", "inspect", cardId, "--run", runId])` prints the
     ask (`hitl.ask`), the human selection (`hitl.selection`), and the
     terminal transition (`entered_lane: ... → done`). **`conduit explain`
     is NOT this** — it renders only the *static* flow diagram from a flow
     path, has no run/journal awareness, and fails `loadFlow` if you pass it
     a run id. Use `journal inspect`, not `explain`, whenever an AC calls for
     "the journey visible on `conduit explain`" — that's a composite-surface
     reading the reviewers have already accepted (see WI-679/680's review
     trail), not a literal `explain` invocation.
   - `h.listenerStderr()` — the listener child's accumulated stderr,
     continuously buffered since spawn. Useful for listener-level failures,
     but **not** for run-level ones: the listener discards its spawned
     `run`/`resume` children's stderr (`main.ts`'s `spawnConduitRun`), so a
     named failure inside a run/resume always lives in `runConduit`'s output,
     never here.
   - `h.assert.artifactContent(relPath)` — reads a file from the scaffolded
     project workspace (e.g. `"delivery.txt"`).
   - `h.slack.posts()` / `.uploads()` / `.completeUploadCount()` — the fake's
     recorded traffic, for exactly-once assertions across a resume boundary.
     `completeUploadCount()` increments **only** on `files.completeUploadExternal`
     — never on `getUploadURLExternal` or the raw byte upload — so it's the
     correct "one real delivery" counter.
   - `h.assert.explainField(cardId, field, opts?)` is a raw journal-DB
     `SELECT` — legitimate for discovering internal-only data no CLI prints
     (like the correlation id above), but **not** a substitute for a public-surface
     assertion on anything an AC claims is user-visible. If reviewers can't
     tell the difference from the test alone, add a comment explaining why
     the DB read is the correct choice for that specific lookup (see
     `golden-journey.test.ts`'s step 4 for the pattern).

6. **No fixed sleeps, anywhere.** Every wait in the harness and in every
   shipped test is `h.waitFor(condition, { timeoutMs, intervalMs? })` —
   condition-polled with a bounded timeout. A fixed `sleep()` in a fault
   variant either flakes (too short) or silently hides a real hang (too
   long, masked by an unrelated pass). If you're tempted to add one, there's
   almost always a real condition to poll instead (a spawn count, a
   `runConduit` narration marker, an assertion that stops throwing).

7. **Verify determinism before submitting**: run your new test file 3
   consecutive times locally. The suite is a required CI check, so a flaky
   fault variant blocks every PR, not just yours.

### Available fault knobs today

| Knob | Effect |
|---|---|
| `h.faults.setStall(surface, on)` | Named fake-Slack endpoint accepts and never responds (bounded internally at 10 min) |
| `h.faults.setDuplicateDelivery(on)` | Every signed event / interactive reply is delivered twice |
| `process.env.SLACK_FETCH_TIMEOUT_MS` (set before boot) | Short-circuits the child's Slack fetch bound, so a stall settles fast in tests |

If your bug needs a fault knob that doesn't exist yet, add it to
`journey-harness.ts` (the harness's own smoke test —
`journey-harness.smoke.test.ts` — must stay green) rather than working around
its absence inside a test file.

## Seeded backlog: known production bugs awaiting a fault variant

These are real production-discovered failure classes that do **not** yet
have a fault variant in this suite. Picking one up means writing a
`fault-*.test.ts` following the guide above; check it off here once it lands.

- [ ] **In-flight liveness false positive** — the liveness watchdog kills a legitimately still-in-flight
      call (false-positive stall detection under real latency, not a hang).
- [ ] **Misreported fetch timeout** — an implicit fetch timeout is misreported as a different
      failure class on the observability surface (the *shape* of the error
      is wrong, not just its presence).
- [ ] **Silent terminal outcome** — a card silently exits to `scrap`/`hold` with no failure
      surfaced anywhere a human would see it. **Partially materialized**
      this mission as WI-686 (a sync-path FSM bypass found via this very
      suite); WI-681 is planned as its shipped fault variant — check WI-681's
      status before starting this one from scratch.
- [ ] **Swallowed gateway error** — a model/gateway error response body is swallowed instead of
      surfaced, so the operator sees a generic failure instead of the
      upstream's actual error detail.

## Suite ground rules

- **Zero imports from `src/`.** Enforced by `no-internal-imports.test.ts`
  (`harness/import-scan.ts`), which walks the real TypeScript AST of every
  `.ts` file under `blackbox/` and fails on any import/export/require/`import
  x = require(...)` whose specifier resolves into `<repoRoot>/src`. This
  isn't a style preference — it's what makes the suite prove the *shipped
  binary* works, not just the in-process kernel. If you need something from
  `src/`, you almost certainly want a public surface instead (spawn the
  binary, hit the fake server, read `runConduit`'s output) — see "How to add
  a fault variant" above.
- **Scoped typecheck.** `blackbox/tsconfig.json` extends the root config and
  scopes `include` to this directory; `bun run typecheck:blackbox` runs
  against it. The root `bun run typecheck` stays `src/`-only. Both block
  merges: a type error here fails the required `blackbox` job.
- **Required CI, after burn-in.** `.github/workflows/blackbox.yml` runs
  `test:blackbox` and `typecheck:blackbox` on every PR in a job named
  `blackbox`, which the `main` ruleset requires by name. Keep that name, and
  keep `pull_request` unfiltered: a renamed or path-filtered required check
  never reports, and every PR waits on it. Never name it `tests`, which the
  ruleset reads as the `test.yml` gate. The suite ran advisory-only from
  2026-08-27 until its promotion on 2026-09-26 (48/48 executed runs green).
