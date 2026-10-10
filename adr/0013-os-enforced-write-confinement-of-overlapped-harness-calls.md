# ADR-0013: Overlapped harness calls run under OS-enforced write confinement (Landlock)

Status: Accepted (maintainer decisions for issue #122, 2026-10-10)
Date: 2026-10-10

## Context

[ADR-0012](./0012-overlapping-ungated-harness-calls.md) lets a `kind: harness` station that
declares `overlap: true` run several cards' calls at once under `--concurrency K>1`. Its
integrity rule attributes a touched path inside an overlapping sibling's owned paths to that
sibling, which leaves a stated gap: a Bash write by one member into another member's owned
paths holds neither card. The per-call gate denies such a write through the file-write tools,
but not one made by an allowlisted executable that writes to a path in its arguments (`cp`,
`tee`, `sed -i`, `curl -o`, a script the agent wrote), and not one through a symlink the member
creates in its own dir.

Issue [#122](https://github.com/theaiteam-dev/conduit/issues/122) proposed confining each
harness call's writes with Landlock, an unprivileged Linux security module. A prototype on
2026-10-08 (kernel 6.8, Landlock ABI 4) showed a 40-line static helper refusing `cp` and `mv`
into a sibling dir, a write through a symlink, a `setsid` child's write and a write to a shared
file, on the host and in a default Docker container, while a real `claude -p` call ran normally
under it.

## Decision

**Every member of a harness overlap batch (two or more calls admitted together) runs its whole
process tree under a Landlock ruleset that allows writes only beneath the call's writable set.
A host or adapter that cannot provide this runs the station's cards on the serial path. Serial
harness calls, gate critics and deterministic stations are unchanged.** This is the minimum
version of #122: it closes ADR-0012's gap and changes nothing else.

### The helper

`llexec <writable path>... -- <command> [args...]` (`native/llexec/llexec.c`) is a small C
program, built statically and installed in the engine image at `/usr/local/bin/llexec` by a
build stage in the Dockerfile. It reads the highest Landlock ABI the kernel reports and creates
a ruleset that handles the write-type file rights that ABI supports: the base rights (write,
remove, make each file type) from ABI 1 (Linux 5.13), `REFER` from ABI 2 (5.19) and `TRUNCATE`
from ABI 3 (6.2). It grants all of them beneath each writable directory, and only write and
truncate on a writable path that is a file. It then sets `no_new_privs`, restricts itself, and
execs the command. Reads and executes are not handled, so they stay allowed. Any failure before
the exec prints a line starting with `llexec:` and exits 121; the command never runs unconfined.
The helper works from ABI 1, where the kernel refuses every cross-directory rename or link even
inside the writable paths. Overlap does not run below ABI 3 (see *Detection and fallback*).

A static binary was chosen over a `conduit __confine` subcommand using `bun:ffi`. The FFI route
hit `EINVAL` on `landlock_add_rule` in the #122 prototype, it would need proof that Bun never
spawns the confined child from an unconfined thread, and it puts a Bun process between the
cgroup wrapper and the CLI on every confined call.

### Where it is applied

The helper is chained at the existing single wrap point, `prepareContainedCommand`
(`src/worker/cgroup-containment.ts`), which every harness spawn path already goes through: the
cgroup wrapper shell joins the invocation's cgroup and execs `llexec`, which execs the CLI. The
two mechanisms compose: every process the CLI starts is both in the cgroup and confined. The
`agent-sdk` adapter's `spawnClaudeCodeProcess` hook and the `containedSpawn` used by
`codex-app-server` and `opencode` pass a `SpawnWriteConfinement` through. The executor puts
`HarnessInvocation.confinement` (the helper and the card's canonical owned paths) on each
overlapped call; the adapter adds its own dirs.

### The writable set

- The card's canonical `owned_paths`. Each must exist when the batch is admitted, since a
  Landlock rule names an existing file or directory; a card with a missing owned path runs on
  the serial path.
- A per-call temp dir. The adapter points `TMPDIR` at it, and `TMPPREFIX` (zsh ignores
  `TMPDIR`). On `agent-sdk` and `codex-app-server` it also points `XDG_CACHE_HOME` and
  `XDG_STATE_HOME` into it; `opencode` already run-scopes all four XDG dirs.
- The adapter's run-scoped config dirs: `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, or the opencode
  root holding `HOME` and the XDG dirs. Config isolation is mandatory for a confined call: the
  `agent-sdk` adapter creates a run-scoped `CLAUDE_CONFIG_DIR` for it whatever `_ISOLATE_CONFIG`
  says, because the operator's own config dir is not writable under the ruleset.
- `/dev`.

How each adapter's set was established:

| Adapter | Verified with | Result |
|---|---|---|
| `agent-sdk` | strace of `claude -p` 2.1.296 (unconfined, then confined), then a live confined call through the adapter under strace | Call succeeded; its own file was written; `cp` into a sibling's dir was refused; no other write was refused once `TMPPREFIX` was set |
| `codex-app-server` | a live confined call through the adapter (codex 0.161.0) under strace | Call succeeded; `cp` into a sibling's dir was refused; no other write was refused |
| `opencode` | a live confined call through the adapter (opencode 1.15.10, `openai/gpt-4.1-mini`) under strace | Call succeeded; `cp` into a sibling's dir was refused; no other write was refused |

All three were verified with real runs; none was derived only from the isolation code. Not
observed: an OAuth token refresh by the Claude CLI. Its `.credentials.json` in the run-scoped
dir links to the operator's file, so a refresh written through the link would be refused.

### Detection and fallback

A once-per-process probe, `resolveWriteConfinement` (`src/worker/landlock-confinement.ts`),
modelled on `resolveContainment`, finds the helper (`CONDUIT_LLEXEC`; else the source-checkout
build at `native/llexec/build/llexec`; else `llexec` on `PATH`), asks it for the ABI, and runs
a real write test through it: a write inside the writable path must succeed and a write outside
it must be refused.

The probe requires Landlock ABI 3 or higher, that is Linux 6.2 or later. ABI 1 and 2 do not
check `truncate(2)`, so a confined member could empty a file in a sibling's owned paths. That
changes the file's contents, and the overlap integrity rule would attribute it to the sibling,
which is ADR-0012's gap again. On ABI 1 or 2 the probe reports confinement unavailable with a
reason naming the minimum, and overlap candidates run serially. The helper itself stays
ABI-generic, so the check lives in the probe, not in `llexec`. `conduit doctor` reports it as the `write-confinement` probe, which never
fails.

Admission adds two conditions to ADR-0012's list, both checked at dispatch:

- the resolved adapter has `canConfineWrites` (today `agent-sdk`, `codex-app-server`,
  `opencode`, the same three that have `canGatePerCall`);
- the probe reported confinement available.

A card that fails either, or whose owned path does not exist, runs on the serial path with the
reason journaled as `overlap_fallback`; an unavailable probe is also warned once per run. This
fails closed: no path runs an overlapped call unconfined. Each overlapped span records
`write_confinement: "landlock"`.

### What stays the same

- The overlap integrity rule, as the backstop. With confinement, a path it attributes to a
  sibling was written by that sibling, so the attribution is sound for file contents.
- The Bash metacharacter rule in the per-call gate, on every station.
- ADR-0012 condition 6 (`canGatePerCall`), so `claude-headless` and `codex-exec` still cannot
  overlap.
- Serial harness calls, gate critics and deterministic stations run unconfined.

### Remaining limits

- **Metadata changes.** `chmod`, `chown`, `utimes` and extended attributes are not Landlock
  write rights. A member can make a sibling's file unreadable or change its times; it cannot
  change its contents.
- **Writes by an unconfined process on the call's behalf**, for example a daemon reached over a
  unix socket.
- **Network egress.** Landlock filters TCP by port only, and every CLI needs 443.
- **Kernel minimum.** Overlap needs Linux 6.2 (Landlock ABI 3); an older kernel gets no
  overlap (see *Detection and fallback*).
- **Platform coverage.** Verified on Linux 6.8 (ABI 4) on the host and in a default Docker
  container. Docker Desktop's VM kernel is not verified. CI builds the helper and sets
  `CONDUIT_REQUIRE_LANDLOCK=1`, so a GitHub runner without Landlock fails the suite instead of
  skipping it.

## Alternatives

### A. A `bun:ffi` subcommand instead of a static helper: *rejected*
See *The helper* above.

### B. A separate copy of the project root per call (ADR-0012 Alternative A): *rejected*
A copy confines nothing by itself: the agent can still write the real tree by absolute path,
and #98 puts absolute output paths in the prompt. It would also need mount namespaces, which a
default Docker container and Ubuntu's AppArmor profile block. #122 measured about 2.7 s per call
to copy this repository.

### C. Confine every harness call, serial ones included: *deferred*
Would deny an out-of-owned-path write up front instead of holding the card after a wasted call.
It changes the failure mode of every existing harness flow (a refused write the agent reacts to
instead of a hold), so it is a separate decision. Listed as a follow-up.

### D. Leave confinement optional per station: *rejected*
An unconfined overlapped call reopens ADR-0012's gap. Falling back to the serial path keeps
every flow running and costs only wall clock.

## Consequences

**We gain**
- ADR-0012's cross-sibling gap is closed where confinement is active: a write into a sibling's
  owned paths, through a symlink into them, or to a shared project file fails at the syscall.
- The integrity attribution under overlap now reflects who wrote a file's contents.

**We pay**
- A C source file and a Dockerfile build stage. A source checkout needs a C compiler and
  static libc to build the helper (`bun run build:llexec`); without it, overlap runs serially.
- A run on a host without Landlock ABI 3 (macOS, a kernel before 6.2, a kernel booted without
  `landlock` in `lsm=`) gets no overlap.
- The CLIs see `TMPDIR`, `TMPPREFIX` and the XDG cache and state dirs pointed at a per-call dir,
  and on `agent-sdk` an isolated config dir, on every overlapped call.

**Follow-ups this enables**
- Relax the Bash metacharacter rule on confined stations: the gate refuses `&&`, `;` and
  redirects because it cannot see where they write, and Landlock now bounds that.
- Drop ADR-0012 condition 6 for overlap: the CLI process itself is confined, so an adapter that
  cannot gate per call, such as `claude-headless`, could overlap.
- Confine serial calls too (Alternative C).

**Revisit triggers**
- A supported CLI needs a write outside the set (a new cache or lock dir): add it to that
  adapter's run-scoped dirs, verified with strace, in the same change.
- Landlock gains rights for metadata or network scoping that the CLIs tolerate.

## References

- Issues: [#122](https://github.com/theaiteam-dev/conduit/issues/122) (this decision),
  [#30](https://github.com/theaiteam-dev/conduit/issues/30),
  [#29](https://github.com/theaiteam-dev/conduit/issues/29) (config isolation),
  [#77](https://github.com/theaiteam-dev/conduit/issues/77) (cgroup containment).
- [ADR-0012](./0012-overlapping-ungated-harness-calls.md), whose gap this closes.
- SPEC §7 (*Overlapping harness calls*), `docs/harness-containment.md` (*Write confinement of
  overlapped calls*).
- Code: `native/llexec/llexec.c`, `src/worker/landlock-confinement.ts`,
  `src/worker/cgroup-containment.ts` (`prepareContainedCommand`), the overlap admission in
  `src/controller/executor.ts`, `src/worker/harness-containment.conformance.ts`.
