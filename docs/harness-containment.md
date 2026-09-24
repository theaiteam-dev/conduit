# Harness Containment Profile

What `kind: harness` stations enforce, what they deliberately don't, and why that's an
honest tradeoff rather than a gap — so you don't read `agentic`-station guarantees onto a
harness station by mistake. See [SPEC §7](../SPEC.md#7-the-worker-runtime-tool-bridge--atomic-claim-highest-risk-surface)
for the Law-grade tier this profile is weaker than, and
[`prd/done/agentic-harness-worker.md`](../prd/done/agentic-harness-worker.md) for the full
design.

## Two tiers, not one

Conduit has two station kinds for tool-using workers, and they make different containment
claims:

- **`kind: agentic`** — the in-kernel Tool-Bridge (SPEC §7, build-order step 9, Law-grade
  tier). The kernel owns the tool loop and gates every tool call before it executes: the
  Bash positive allowlist, path-ownership resolution, and network-namespace egress denial
  all run **pre-execution, per call**. This is the Law.
- **`kind: harness`** — a station whose worker is an external headless agent harness
  (`claude -p`, `codex exec`, or similar) wrapped in Conduit's transform contract. The
  harness owns its own tool loop; Conduit cannot see or gate individual tool calls inside
  it. This kind makes a **weaker containment claim than the Law**, on purpose, and this
  document exists so that claim is never implied to be stronger than it is.

If you need per-tool-call pre-execution gating, that's the Tool-Bridge (`kind: agentic`),
not this. A `kind: harness` station is the pragmatic precursor: it gets the tool loop onto
the kernel's books (journaled attempts, gate verdicts, rework guards, budgets, binding
stamps) without building an in-kernel loop first.

## The containment profile

Because the kernel can't gate what happens inside the harness's own loop, containment is a
**documented profile at the process boundary** instead of per-call enforcement. Five things
hold it together:

- **Mandatory owned-paths integrity gate.** Every write the harness makes is checked against
  the card's `owned_paths` in the MARK_DONE transaction. Unlike `agentic`'s pre-execution
  path gating, this is a **post-hoc, boundary check**: the harness can attempt any write
  during its run, but a write outside `owned_paths` hard-pauses the card to `hold` rather
  than advancing it. For harness stations this check is **mandatory, not opt-in** — it
  cannot be disabled via `defaults.enforce_owned_paths: false` the way it can for other
  station kinds.
- **Secrets by explicit allowlist only.** The harness child process's environment contains
  only variables named in engine configuration (e.g. the harness's own auth token) — never
  the kernel's environment inherited wholesale. Allowlisted names live in engine config
  (trusted), never in `flow.yaml` (validated, untrusted).
- **Process-group termination.** The harness runs as its own process group; a timeout or
  run halt kills the group, not a lone pid, so a harness that has spawned its own
  subprocesses (a shell, a browser, a language server) doesn't leave zombies behind.
  The evidence is the containment conformance suite,
  [`src/worker/harness-containment.conformance.ts`](../src/worker/harness-containment.conformance.ts).
  Each shipped adapter runs it through its own spawn path with a stand-in binary that
  backgrounds a grandchild, and must show that the grandchild's pid is gone and its
  sentinel file stops changing after the timeout.
  `src/worker/harness-containment-registry.test.ts` fails if an adapter ships without a
  conformance call. The deterministic station runner is registered against the same suite
  but does not pass it yet ([#10](https://github.com/theaiteam-dev/conduit/issues/10),
  [#17](https://github.com/theaiteam-dev/conduit/issues/17)); that is a separate path from
  harness stations, and its test is marked as a known failure until those are fixed.
  Deployment guidance additionally recommends running the container as a dedicated non-root
  user for agentic/harness flows.
- **The ADR-0003 container wall.** [ADR-0003](../adr/0003-packaging-and-distribution.md)'s
  Docker packaging is the outer containment boundary for what a harness does inside its
  loop — the container, not the kernel, bounds the blast radius. Network-policy
  restriction, if you want it, is an operator-owned container/deployment control, not
  something the kernel imposes for this kind.
- **The adversarial gate as the quality control.** Because the kernel can't inspect a
  harness's tool calls, the check that catches a corrupted or injected result is the
  existing `check:` gate machinery — a critic station (itself possibly a harness or
  transform) re-deriving and attacking the maker's output, journaled and rework-bounded
  like any other gate.

What this profile does **not** claim: that the kernel prevents a compromised or
prompt-injected harness from doing something unwanted *during* its run. It claims the
blast radius is bounded — by owned-paths (writes that escape are caught before they
advance the card), by the env allowlist (there's little worth exfiltrating), by the
container (the operator's network/process boundary), and by the adversarial gate
(corrupted output gets caught before it ships) — and that every attempt is legible in the
journal (hashes and usage, never raw transcripts).

## Network posture: full egress in v1

**Harness stations have full network egress in v1.** This is stated plainly, not implied
away: v1 does **not** attempt kernel-level egress restriction for `kind: harness`. The
harness needs to reach its own model provider, and research-style tools (web fetch, web
search) need to reach the open web — the same `unshare --net`-style denial that guards
`agentic`'s content-processing workers (SPEC §7) would break the harness's own purpose.

This is a deliberate departure from the Law's default-deny posture, made acceptable because
the rest of the profile holds together: the env allowlist keeps the exfiltratable surface
to the harness's own auth token, the container is the operator's network-policy boundary if
one is wanted, and the journal stores artifact hashes and usage rather than raw
transcripts. An allowlisted egress proxy is a possible later tier — not a v1 promise.

## Operator-owned upgrades

The checkpoint binding stamp for a harness station incorporates the **adapter name**, the
**model id**, and the **prompt version** — a change to any of them invalidates the
checkpoint and cascades downstream on resume, exactly like any other station.

The harness **binary version is deliberately excluded** from the stamp. Upgrading the
installed `claude`/`codex`/harness binary on the host or in the container does not
invalidate existing checkpoints. This means **the operator owns harness upgrades and their
behavioral consequences** — if a harness upgrade changes output format or behavior
mid-flight, that's a deployment decision the operator made, not something the kernel
detects or protects against. Adapters guard against the sharpest edge of this (structured
output modes plus contract tests against recorded outputs), but a behavior change that
still parses is the operator's to notice.

## What stays the same as a transform station

Everything upstream and downstream of the tool loop is the same kernel machinery a
`transform` station gets: the atomic claim, declared inputs and typed `output_schema`
validation with coercive parsing, `check:` gates in both directions with journaled
`gate_verdict` rows and all four rework guards, per-attempt journaling (harness identity,
model, duration, artifact hashes, usage), wall-clock timeout and execution-attempt caps,
liveness-watchdog integration so an in-flight attempt counts as progress, and the outbox +
idempotency discipline for effectful stations. The tool loop is the only new freedom; the
contract around it is unchanged.

## Recommended deployment

- Run agentic/harness flows in the [ADR-0003](../adr/0003-packaging-and-distribution.md)
  container, never bare-metal against a shared host.
- Use a **dedicated non-root container user** for agentic/harness flows, so a compromised
  or misbehaving harness process is bound by that user's OS-level permissions in addition
  to the containment profile above.
- Treat the container's network policy as the place to restrict egress if your deployment
  requires it — the kernel does not do this for you in v1.
