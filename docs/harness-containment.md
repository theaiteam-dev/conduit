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
  it, except through a supervised adapter (see [below](#a-middle-claim-supervised-adapters)).
  This kind makes a **weaker containment claim than the Law**, on purpose, and this
  document exists so that claim is never implied to be stronger than it is.

If you need per-tool-call pre-execution gating, that's the Tool-Bridge (`kind: agentic`),
not this. A `kind: harness` station is the pragmatic precursor: it gets the tool loop onto
the kernel's books (journaled attempts, gate verdicts, rework guards, budgets, binding
stamps) without building an in-kernel loop first.

## A middle claim: supervised adapters

An adapter that sets `canGatePerCall` runs the harness loop with a callback into the
kernel, and the kernel decides every tool call before it runs. `agent-sdk` is the shipped
one: it drives the Claude Code CLI through `@anthropic-ai/claude-agent-sdk` `query()` and
calls the kernel's gate from `hooks.PreToolUse`
([#21](https://github.com/theaiteam-dev/conduit/issues/21)). The hook fires for the main
agent and for subagents, and an `allowedTools` rule does not bypass it.

The claim is a pre-execution decision on each call. It is not the Tool-Bridge: the CLI
still owns the loop, and the kernel sees one call at a time. The gate
(`src/worker/harness-gate.ts`) enforces:

- **Tool allowlist.** A tool not in the station's `tools` is denied.
- **Bash positive allowlist.** Executables come only from `Bash(<exe>)` and
  `Bash(<exe>:*)` entries. A bare `Bash` entry allows the tool and no executable. A
  narrower rule such as `Bash(git status:*)` is not widened to `git`. A command
  containing a shell metacharacter is denied before the allowlist is consulted.
- **Write ownership.** Write, Edit, MultiEdit and NotebookEdit targets must resolve inside
  the card's owned paths, with symlinks resolved on both sides, including a write through
  a dangling symlink. This applies only where the flow sets `defaults.enforce_owned_paths`
  and the card declares owned paths, the same condition as the other integrity checks.
- **No network tools.** `WebFetch` and `WebSearch` are always denied.
- **Human questions hold.** `AskUserQuestion` moves the card to `hold`: the adapter ends
  the harness process and the executor holds the card without spending an execution
  attempt. It does not park a live process.

A gate critic on a supervised adapter may write only its verdict file. A station on a
supervised adapter must list its tools: an empty list, or `unrestricted_tools: true`, would
deny every tool, so the loader rejects both (`HARNESS_GATED_ADAPTER_NEEDS_TOOLS`).

What it does not cover:

- The arguments of an allowlisted executable. `git -C / ...` and `git config` pass, and a
  script the agent wrote can then be run.
- A Bash write that bypasses the path check. The MARK_DONE owned-paths integrity check
  stays mandatory as the backstop.
- Reads outside the project root, and a symlink swapped between the check and the write.
- The input of `Agent` and of any other listed tool that is not a file tool.

The SDK reports a hook denial nowhere (`result.permission_denials` stays empty), so the
adapter emits a `gate-decision` event for every call the gate sees. It is journaled in
`harness_events` with the decision, code, tool name, subagent id when there is one, and a
reason cut to 200 characters. No tool input body is stored. `conduit journal inspect` and
`tail` print it. A hold answers the call with a deny and `continue: false`, so the CLI stops and emits its
result message (about 15 ms in a live run), and the thrown error carries that call's usage
and cost. Every later call is denied without asking the gate. If no result arrives within 5
seconds the process is killed, and the error then carries no usage.

Every invocation is a fresh session: `agent-sdk` does not resume one, and it does not run
named agents (`agent`, `pluginDirs`).

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
  (trusted), never in `flow.yaml` (validated, untrusted). An allowlisted `HOME` is more
  than a variable: it hands a CLI the operator's home directory, including its config. See
  [The child's configuration surface](#the-childs-configuration-surface).
- **Process-tree termination.** A timeout, idle timeout or run halt kills everything the
  harness started, not a lone pid, so a harness that has spawned its own subprocesses (a
  shell, a browser, a language server) doesn't leave them running. See
  [Process-tree termination](#process-tree-termination) below for the mechanism, what it
  requires of the host, and what happens on a host that lacks it.
  The evidence is the containment conformance suite,
  [`src/worker/harness-containment.conformance.ts`](../src/worker/harness-containment.conformance.ts).
  Each shipped adapter runs it through its own spawn path with a stand-in binary that
  starts two grandchildren, one backgrounded in the binary's own process group and one
  started with `setsid` in a new session, and must show that each grandchild's pid is gone
  and its sentinel file stops changing after the timeout.
  `src/worker/harness-containment-registry.test.ts` fails if an adapter ships without a
  conformance call. The deterministic station runner and the harness runner, two separate
  spawn paths, both pass the same suite, and both also run its exit scenarios: when the
  command exits 0 or nonzero before its timeout, the runner kills what the command started
  before it returns, so a grandchild does not outlive a station or a harness invocation
  that finished on its own
  ([#10](https://github.com/theaiteam-dev/conduit/issues/10),
  [#17](https://github.com/theaiteam-dev/conduit/issues/17)). For the harness runner this
  also keeps a grandchild that inherited the stdout/stderr pipes from stalling the output
  drains past its actual finish. Both runners also kill every live station process tree
  when the kernel receives SIGINT, SIGTERM or SIGHUP, or exits; a SIGKILLed kernel cannot do
  this, which is why the container boundary below still matters.
  Deployment guidance additionally recommends running the container as a dedicated non-root
  user for agentic/harness flows. [`deployment-hardening.md`](deployment-hardening.md) is
  that guidance in full.
- **Optional idle timeout.** `timeout_seconds` bounds the whole invocation, so a harness
  stuck on a hung tool call runs until that bound. `idle_timeout_seconds` adds a second
  bound, reset by every stdout line: if no line arrives for that long, the runner kills the
  process group as it does on the wall-clock timeout
  ([#31](https://github.com/theaiteam-dev/conduit/issues/31)). It applies only to
  `kind: harness` stations and must be a positive integer below the wall-clock timeout
  that applies (`timeout_seconds`, or the 300-second default). An idle kill fails as
  `harness-idle-timeout` rather than `harness-timeout`, and is retried the same way: it
  spends an execution attempt, bounded by `max_execution_attempts`, and is never parked.
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

## Process-tree termination

Claude Code's Bash tool runs every command in a new session (`setsid`), and so does any
tool that daemonizes. A process-group kill cannot reach such a command: it has left the
group ([#77](https://github.com/theaiteam-dev/conduit/issues/77)). The runners therefore
use two mechanisms together.

**cgroup v2, where the host allows it.** Each invocation, harness or deterministic station,
runs in its own cgroup, `conduit-<kernel pid>-<kernel start time>-<n>`, created under the cgroup the kernel
itself runs in. The child joins it before it runs: the runner spawns
`/bin/sh -c 'echo $$ > <cgroup>/cgroup.procs && exec <command>'`, so the command is in the
cgroup before it can fork. Creating a new session or process group (`setsid`, `nohup`, a
daemonizing fork) does not move a process out of its cgroup, so every descendant started
that way stays in it. On every path that kills the
process group (wall-clock timeout, idle timeout, the post-exit reap, and the kernel's
signal and exit handlers), the runner also writes `1` to the cgroup's `cgroup.kill`, which
SIGKILLs every process in it, and then removes the cgroup. A kernel that is SIGKILLed
leaves its cgroups behind; the next kernel started in the same cgroup kills whatever is
still in them and removes them. It treats a cgroup as left behind when no running process
has both the pid and the start time in its name, so a dead kernel's cgroup is reaped even
after another process has been given its pid
([#81](https://github.com/theaiteam-dev/conduit/issues/81)).

The cgroup does not contain a command that moves itself out on purpose. Descendants run as
the kernel's user, and that user can write the parent cgroup's `cgroup.procs` (the
requirement below), so a command that writes its own pid there leaves the invocation's
cgroup and survives `cgroup.kill`. The mechanism covers commands that detach the ordinary
ways, which is what Claude Code's Bash tool and backgrounded shell jobs do. It is not a
boundary against a harness that sets out to evade it; the container is that boundary.

This requires:

- Linux with the cgroup v2 (unified) hierarchy mounted at `/sys/fs/cgroup`;
- kernel 5.14 or later, for `cgroup.kill`;
- write access, for the user the kernel runs as, to the cgroup the kernel runs in. A
  systemd user session provides this: processes started from a login shell run in a
  cgroup the user owns. No controllers are enabled on the created cgroups.

The kernel checks this once per process, by creating a probe cgroup, moving a real process
into it, and killing it through `cgroup.kill`. `conduit doctor` reports the result as the
`process-containment` probe.

**The process-group kill, always.** Each child is also its own process group (it is
spawned detached), and every kill path still SIGKILLs the group. Where cgroups are
available this is a second mechanism alongside `cgroup.kill`; where they are not, it is the
only one.

**Where cgroup containment is unavailable** (no cgroup v2, an older kernel, or a read-only
or root-owned `/sys/fs/cgroup`, which is the default in a Docker or Podman container), the
kernel falls back to the process-group kill alone. It does not refuse to run. It prints a
warning naming the reason once per process, and `conduit doctor` reports
`process-containment: ok — warning: process group only (<reason>)`. On such a host the
process-tree guarantee is weaker: **a command that calls `setsid`, which includes every
command Claude Code's Bash tool runs, can outlive its invocation.** The container boundary
is then what bounds it, and a stopped container takes it down.

To get cgroup containment inside a container, the container needs a writable cgroup
namespace, and the kernel's user needs a cgroup it owns. With rootless Podman (which
[`deployment-hardening.md`](deployment-hardening.md) already recommends),
`--systemd=always` mounts the container's own cgroup read-write. The engine image runs as
the non-root `conduit` user, which cannot write the root-owned container cgroup, so start
the container as root, delegate a subtree to `conduit`, and drop privileges before the
kernel starts. This keeps to the non-root guidance in
[`deployment-hardening.md`](deployment-hardening.md): under rootless Podman the
container's root is the unprivileged host service user, it runs only the setup commands,
and `setpriv` switches to `conduit` before the kernel, so the kernel and every station
still run as `conduit`:

```sh
podman run --systemd=always --user root --entrypoint sh <image> -c '
  mkdir /sys/fs/cgroup/conduit &&
  chown -R conduit:conduit /sys/fs/cgroup/conduit &&
  echo $$ > /sys/fs/cgroup/conduit/cgroup.procs &&
  exec setpriv --reuid=conduit --regid=conduit --init-groups bun src/cli/main.ts "$@"' sh doctor
```

Docker mounts `/sys/fs/cgroup` read-only in every container that is not `--privileged`,
and `--privileged` removes more isolation than this recovers, so under Docker expect the
fallback. The kernel's own tests require the cgroup mechanism in CI
(`CONDUIT_REQUIRE_CGROUP_CONTAINMENT=1`); on a development host without it, the tests that
need it are reported as skipped with the reason.

## The child's configuration surface

A harness CLI assembles its behaviour from configuration it finds, not only from the
argv and env the kernel builds. For `claude -p`, allowlisting `HOME` (which subscription
auth needs) hands the child the operator's `~/.claude`: installed and skills-dir plugins,
user agents, `settings.json` and its hooks, the user `CLAUDE.md`, and the account's
claude.ai MCP connectors. That surface differs between operators, is not in `flow.yaml`,
and is not in the binding stamp, so two operators resuming the same flow at the same stamp
can get different child behaviour.

**Default: inherited.** With no extra configuration, a `claude-headless` station with
`HOME` allowlisted runs with the operator's user-level Claude configuration. This is the
behaviour before issue #29, kept so existing deployments do not change underneath their
operators.

**With `CONDUIT_HARNESS_CLAUDE_HEADLESS_ISOLATE_CONFIG=1`: constructed.** Each invocation
gets a `CLAUDE_CONFIG_DIR` the adapter creates, holding only a symlink to the operator's
`.credentials.json` (or nothing, when an auth variable such as `CLAUDE_CODE_OAUTH_TOKEN` is
allowlisted), and `--strict-mcp-config`. The directory is deleted when the invocation ends.
Verified against `claude` 2.1.282: subscription auth works, and the child loads no user
plugin, user agent, user settings or hooks, user `CLAUDE.md`, or MCP server. Plugins and
agents then come only from what engine config declares with
`CONDUIT_HARNESS_CLAUDE_HEADLESS_PLUGIN_DIRS`. The opt-in E2E test
`src/integration/harness-e2e-claude-agent.test.ts` shows an ambient agent answering when
the child can see ambient config, and a same-named `--plugin-dir` agent answering, with the
ambient one unreachable, under isolation.

A named `agent:` is part of the binding stamp in both modes: the kernel locates its
definition file in the configured plugin dirs and folds the name and the file's SHA-256
into `prompt_template_version`, and a station whose agent it cannot locate holds rather
than runs. A `--plugin-dir` plugin takes precedence over an installed plugin of the same
name, so without isolation the declared agent is still the one that runs; the rest of the
operator's configuration still loads alongside it.

What isolation does **not** fence, stated so the claim stays narrow:

- **The project root's own configuration.** `CLAUDE.md`, `.claude/settings.json` and
  `.claude/agents/` inside the project root still load. They belong to the project the flow
  operates on rather than to the operator, but they are not hashed into the stamp either.
- **Account-level state.** The CLI fetches account state into the run-scoped dir as it
  runs, including account-synced skills (observed: `anthropic-skills:*` appearing on a
  second invocation against a reused dir). That content follows the logged-in account, not
  the machine. A fresh dir per invocation keeps most of it from arriving, since it is
  synced in the background; the kernel does not guarantee that.
- **Built-in skills and agents** that ship with the CLI binary, and admin-managed (policy)
  settings, which apply regardless of the config dir.
- **Other plugin files.** Only the agent's definition file is hashed. A changed skill, hook
  or command inside a plugin dir does not move the stamp.
- **Token refresh.** The CLI replaces `.credentials.json` with an atomic rename that does
  not follow the symlink, so a token refreshed inside the child is discarded with the
  run-scoped dir and the operator's file keeps the old token. A long-lived
  `CLAUDE_CODE_OAUTH_TOKEN` on the allowlist avoids this.
- **`codex-exec`.** No equivalent fence exists for codex yet; its allowlisted `HOME`
  still exposes the operator's codex configuration.

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
**model id**, and the **prompt version**, with a named **agent's name and definition-file
hash** folded into the prompt version when the station runs one. A change to any of them
invalidates the checkpoint and cascades downstream on resume, exactly like any other
station.

The harness **binary version is deliberately excluded** from the stamp, as are the
adapter's engine config (`_COMMAND`, `_ENV`, `_PLUGIN_DIRS` beyond the agent file,
`_ISOLATE_CONFIG`) and, without isolation, the operator's own CLI configuration. Upgrading the
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
model, duration, artifact hashes, usage, and the binding stamp, effective
`prompt_template_version`, agent and agent definition hash that produced the attempt), wall-clock timeout (plus an optional idle timeout) and execution-attempt caps,
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
