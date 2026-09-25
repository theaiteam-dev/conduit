# Harness Adapter Registration — Operator Setup Guide

How to register `kind: harness` adapters (`claude-headless`, `codex-exec`) via
`CONDUIT_HARNESS_*` engine config, for Docker and bare-metal deployments, with
the recommended minimal env allowlist per adapter and per claude credential
mode, and how to verify the result with `conduit doctor`.

This is config-time wiring — what a harness adapter is allowed to *do* once
registered (containment, network posture, the adversarial-gate quality
control) is a separate concern, covered in
[`harness-containment.md`](./harness-containment.md). See
[ADR-0003](../adr/0003-packaging-and-distribution.md) for the Docker
packaging model this guide assumes.

**Until you configure this, the adapter registry ships empty and every
`kind: harness` station fails closed at load** with `UNKNOWN_HARNESS_ADAPTER`
— an unconfigured engine behaves exactly like today's, on purpose.

## Quick start

```sh
export CONDUIT_HARNESS_ADAPTERS=claude-headless
export CONDUIT_HARNESS_CLAUDE_HEADLESS_ENV=HOME,PATH
conduit doctor
```

```
  harness 'claude-headless' canRestrictTools=true reportsUsage=true at '/usr/local/bin/claude': ok
```

That's the whole surface: one variable naming which adapters are registered,
one per-adapter variable declaring exactly which environment variables the
harness child process may see. Everything below explains the details and the
warnings `doctor` gives you when something's off.

## The `CONDUIT_HARNESS_*` variables

| Variable | Required | Purpose |
|---|---|---|
| `CONDUIT_HARNESS_ADAPTERS` | Yes (to register anything) | Comma-separated list of adapter names to register, e.g. `claude-headless,codex-exec`. Absent or empty → the registry stays empty (today's behavior, no opt-in needed to preserve it). |
| `CONDUIT_HARNESS_<NAME>_ENV` | Yes, per registered adapter | Comma-separated env var **names** the harness child process may see. Explicit-only — the engine never injects a baseline; `HOME`/`PATH` are not assumed. An empty string is legal (an intentionally empty allowlist); an *absent* var for a registered adapter is a hard config error at engine boot. |
| `CONDUIT_HARNESS_<NAME>_COMMAND` | No | Overrides the binary invoked (default: the adapter's own name, e.g. `claude`, `codex`). See [Use absolute paths](#_command-use-absolute-paths) below. |
| `CONDUIT_HARNESS_<NAME>_MODEL` | No | The adapter's deployment-default model. A station's own `model:` in `flow.yaml` **wins** when both are set — see [Model precedence](#model-precedence-station-wins-over-_model). |
| `CONDUIT_HARNESS_<NAME>_AGENT` | No, `claude-headless` only | The adapter's default named agent (`<plugin>:<agent>`), passed as `--agent`. A station's own `agent:` wins. The value is trimmed; setting it to an empty or whitespace-only string is a boot error naming the variable, not a silently empty default. See [Named agents and plugin dirs](#named-agents-and-plugin-dirs). |
| `CONDUIT_HARNESS_<NAME>_PLUGIN_DIRS` | No, `claude-headless` only | Comma-separated **absolute** plugin directories, one `--plugin-dir` each. Absent or empty: no flag. A relative entry is a boot error; a missing or non-directory entry fails when the adapter is built. |
| `CONDUIT_HARNESS_<NAME>_ISOLATE_CONFIG` | No, `claude-headless` only | `1`/`true` gives the child a run-scoped config dir instead of the operator's `~/.claude`; `0`/`false` or absent keeps today's behaviour. Any other value is a boot error. See [Isolating the child's Claude config](#isolating-the-childs-claude-config-_isolate_config). |

Setting `_AGENT`, `_PLUGIN_DIRS` or `_ISOLATE_CONFIG` for an adapter that does
not act on it (e.g. `codex-exec`) fails registry construction at boot, naming
the adapter and the variable, rather than being ignored.

### Deriving `<NAME>` from an adapter name

`<NAME>` is the adapter name **uppercased, with every hyphen mapped to an
underscore**:

| Adapter name | `_ENV` variable |
|---|---|
| `claude-headless` | `CONDUIT_HARNESS_CLAUDE_HEADLESS_ENV` |
| `codex-exec` | `CONDUIT_HARNESS_CODEX_EXEC_ENV` |
| `my-cool-agent` | `CONDUIT_HARNESS_MY_COOL_AGENT_ENV` |

Because the mapping collapses hyphens and underscores together, two
*different* adapter names can derive the **same** prefix (`claude-headless`
and `claude_headless` both map to `CONDUIT_HARNESS_CLAUDE_HEADLESS_`) — this
is rejected at engine boot, naming both colliding names, rather than silently
picking one.

### What fails at boot, never at first dispatch

Every misconfiguration below is a **fail-closed error at engine startup**
(`buildProductionDeps`, or `buildReadOnlyProductionDeps` for `conduit
explain` specifically) — never deferred to the first flow that tries to
dispatch a harness station. The CLI prints it as a single clean
`fatal: <message>` line and exits 1 (verified against the real binary for
all three cases):

```
$ CONDUIT_HARNESS_ADAPTERS=mystery-adapter CONDUIT_HARNESS_MYSTERY_ADAPTER_ENV=HOME conduit doctor
fatal: harness registry: "mystery-adapter" is not an adapter this engine ships — adapter registration is configuration-driven (CONDUIT_HARNESS_ADAPTERS); check your CONDUIT_HARNESS_* config

$ CONDUIT_HARNESS_ADAPTERS=claude-headless conduit doctor
fatal: harness config: adapter "claude-headless" is missing required env allowlist var CONDUIT_HARNESS_CLAUDE_HEADLESS_ENV

$ CONDUIT_HARNESS_ADAPTERS=claude-headless,claude_headless CONDUIT_HARNESS_CLAUDE_HEADLESS_ENV=HOME conduit doctor
fatal: harness config: adapter names collide on the same derived env prefix: claude-headless, claude_headless
```

(An `_ENV` set to the **empty string** is fine — that's a deliberate empty
allowlist, not a missing one, and doesn't trigger the second error above.)

If `conduit explain`/`doctor`/`build`/`run`/`resume` (or the listener) starts
at all, your `CONDUIT_HARNESS_*` config parsed cleanly.

## Docker deployment

Follow [ADR-0003](../adr/0003-packaging-and-distribution.md)'s secrets
discipline: `CONDUIT_HARNESS_*` values reach the container via `-e`, a
mounted `.env`, or Docker secrets — **never baked into an image layer**. The
same rule that applies to `CONDUIT_API_KEY` applies here.

The engine image runs as a non-root system user (`conduit`) created with no
home directory (least-privilege — see the `Dockerfile`), so `$HOME` is unset
by default inside the container. Subscription-auth `claude` needs its
credential directory (`~/.claude`) reachable, which means you must both
mount it **and** set `HOME` explicitly so `claude` (and the `HOME,PATH`
allowlist) find it at a consistent path:

```sh
docker run --rm \
  -v conduit_data:/data \
  -v "$HOME/.claude:/home/conduit/.claude:ro" \
  -e HOME=/home/conduit \
  -e CONDUIT_HARNESS_ADAPTERS=claude-headless \
  -e CONDUIT_HARNESS_CLAUDE_HEADLESS_ENV=HOME,PATH \
  -e CONDUIT_API_KEY="$CONDUIT_API_KEY" \
  -e CONDUIT_BASE_URL="$CONDUIT_BASE_URL" \
  conduit-engine doctor
```

(`CONDUIT_API_KEY`/`CONDUIT_BASE_URL` are the existing model-gateway
variables required regardless of harness config — see
[`installation.md`](./installation.md).)

For API-key claude auth instead of subscription auth, no credential mount is
needed — but `HOME` is still on the recommended allowlist floor (see
[Recommended minimal env allowlists](#recommended-minimal-env-allowlists)
below), so set it to *some* consistent, container-writable path (no `~/.claude`
mount needed since the API key carries the credential, not a file under `$HOME`):

```sh
docker run --rm \
  -v conduit_data:/data \
  -e HOME=/home/conduit \
  -e CONDUIT_HARNESS_ADAPTERS=claude-headless \
  -e CONDUIT_HARNESS_CLAUDE_HEADLESS_ENV=HOME,PATH,ANTHROPIC_API_KEY \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  -e CONDUIT_API_KEY="$CONDUIT_API_KEY" \
  -e CONDUIT_BASE_URL="$CONDUIT_BASE_URL" \
  conduit-engine doctor
```

## Bare-metal deployment

Same variables, exported directly in the shell (or your process manager's
env block) before invoking `conduit`:

```sh
export CONDUIT_HARNESS_ADAPTERS=claude-headless,codex-exec
export CONDUIT_HARNESS_CLAUDE_HEADLESS_ENV=HOME,PATH
export CONDUIT_HARNESS_CODEX_EXEC_ENV=HOME,PATH
conduit doctor
```

Bare metal has no Docker volume or per-flow image to imply the rest of the
environment for you, so a few things that are invisible in the Docker
walkthrough become explicit gaps here.

### State DB paths — no `/data` volume to imply them

`CONDUIT_STATE_DB` and `CONDUIT_JOURNAL_DB` default to `/data/conduit.sqlite`
and `/data/conduit.journal.sqlite` (`DEFAULT_STATE_DB`/`DEFAULT_JOURNAL_DB` in
`src/cli/main.ts`) — paths that only exist because the Docker image mounts a
volume at `/data`. On bare metal there is no such mount, so **set both
explicitly** to a writable directory before running anything:

```sh
export CONDUIT_STATE_DB=./data/conduit.sqlite
export CONDUIT_JOURNAL_DB=./data/conduit.journal.sqlite
```

### The model-gateway probes still gate a harness-only flow

`conduit doctor`'s base probes — `model_api_key` (`CONDUIT_API_KEY` /
`OPENAI_API_KEY`) and `gateway_base_url` (`CONDUIT_BASE_URL`) — always run,
whether or not any station in your flow actually calls the model gateway (see
[`installation.md`](./installation.md#6-verify-with-conduit-doctor)). `conduit
run` / `resume` / `listen` invoke `doctor` as a pre-flight gate, so a flow
built entirely from `kind: harness` stations still needs `CONDUIT_API_KEY`
(or `OPENAI_API_KEY`) and `CONDUIT_BASE_URL` set to *something* before it can
start — the model adapter is constructed lazily and a pure-harness run never
actually calls it, but the doctor probe fails the gate regardless.

### `CONDUIT_PROJECT_ROOT` (env) vs. `--project-root` (flag)

These are not the same knob, and only one of them anchors containment:

- **`CONDUIT_PROJECT_ROOT`** only feeds the `project-root-present` doctor
  probe — it checks that the path exists on disk and nothing else. Per-flow
  Docker images set it to the baked-in flow directory (`/flow`) purely so
  that probe reports `ok`. Setting it on bare metal does not change where
  `conduit run` actually anchors cwd confinement, `owned_paths`, or artifact
  I/O.
- **`--project-root <dir>`** — or, absent that flag, `flow.project_root`
  resolved relative to the flow's own directory, falling back to the flow
  directory itself — is what `conduit run` / `resume` actually use as the
  project root: the path cwd confinement, `owned_paths`, and station
  input/output resolution are anchored to.

If you set `CONDUIT_PROJECT_ROOT` expecting it to change where a run reads or
writes artifacts, it won't — pass `--project-root` instead.

### Path resolution: flow directory vs. project root

Two different roots resolve two different kinds of path in `flow.yaml`. This
is invisible while the flow directory and the project root are the same path
(the common case), and becomes a bare-metal footgun the moment `--project-root`
points somewhere else:

- **`worker.prompt_file` / `check.critic.prompt_file`** always resolve
  relative to the **flow directory** (the directory containing `flow.yaml`),
  regardless of `--project-root`.
- **Station `inputs:` / `outputs:`** — including a harness station's declared
  output file — resolve relative to the **project root**: `--project-root`'s
  value, or its fallback as described above.

## Recommended minimal env allowlists

The allowlist is the **entire** environment the harness child process sees —
nothing is injected for you (this is deliberate; see
[`harness-containment.md`](./harness-containment.md#the-containment-profile)).
Get it wrong and the harness fails at dispatch with a normal named attempt
failure, not a containment change — but it's easy to get right:

| Adapter / credential mode | Minimum allowlist | Notes |
|---|---|---|
| `claude-headless`, **subscription auth** | `HOME,PATH` | Credentials live under `$HOME/.claude` — no separate credential variable needed. This is the mode the Phase-1 exit-criterion evidence run (below) exercises. |
| `claude-headless`, **API-key auth** | `HOME,PATH,ANTHROPIC_API_KEY` | |
| `codex-exec` | **Assumed — verify in your deployment.** `HOME,PATH` is a reasonable starting point, but codex's exact minimum has not been verified against a live run in this mission (no consumer currently depends on it). |

**`conduit doctor`'s binary probe does NOT validate your allowlist.** The
probe resolves the configured command against the *engine's own* `PATH`
(`Bun.which`) — the same unrestricted environment the engine itself runs in
— never the scrubbed child allowlist a real invocation actually gets. A
probe showing `ok` only means the binary exists somewhere on the engine's
`PATH`; it says nothing about whether your `_ENV` allowlist is sufficient
for the harness to actually *run* once dispatched (verified: setting
`CONDUIT_HARNESS_CLAUDE_HEADLESS_ENV=HOME` — `PATH` entirely omitted — still
shows the binary probe as `ok`). There is currently no deployment-time check
for allowlist sufficiency short of a real dispatch — for `codex-exec`
specifically, that means running an actual flow against it, not just
`doctor`.

`HOME` and `PATH` are the **universal floor** for every adapter — without
them, most CLI tooling (credential lookup, subprocess resolution) breaks in
ways that are hard to diagnose from the outside. `conduit doctor` warns when
a registered adapter's allowlist omits either:

```
  warning: harness 'claude-headless' env allowlist omits HOME — recommend including HOME and PATH (the universal floor; credential vars are a separate operator choice)
```

This warning is about the floor, **not** about credentials — an allowlist
with `HOME,PATH` but no `ANTHROPIC_API_KEY` never triggers a warning or an
error. Credential mode is entirely your choice; `doctor` only flags the two
variables nearly every harness CLI needs regardless of how it authenticates.

### `HOME` also carries the operator's user-level Claude hooks

Allowlisting `HOME` gives the harness child more than credentials: **it
inherits the operator's user-level Claude Code configuration, including
hooks** (`~/.claude/settings.json`). A hook that writes files will do so in
the child's cwd — inside the confined project root — and the mandatory
owned-paths integrity gate will (correctly) flag that write as a containment
violation, hard-pausing the card to `hold` with a `path_escape` naming a
file your flow never asked for.

This is the gate working as designed — the write really did come from
outside the flow's contract — but the failure is confusing until you know
where the file came from. First observed in the wild by an early consumer
smoke test: a DevTrack telemetry hook silently bootstrapped a
`devtrack.yaml` into the confined root on the harness's first invocation
(reported upstream).

**For `claude-headless`, set `CONDUIT_HARNESS_CLAUDE_HEADLESS_ISOLATE_CONFIG=1`.**
The child then reads a config dir the adapter constructs per invocation, so
the operator's `~/.claude/settings.json` hooks, plugins, agents and
`CLAUDE.md` are not loaded. See
[Isolating the child's Claude config](#isolating-the-childs-claude-config-_isolate_config).
Without it, guard or disable file-writing user-level hooks on hosts that run
harness flows: run the engine under a dedicated user whose `~/.claude`
carries no hooks, add a guard condition to the hook so it skips harness
working directories, or disable the hook on that host.

## `_COMMAND`: use absolute paths

If you override `CONDUIT_HARNESS_<NAME>_COMMAND`, use an **absolute path**.
The harness binary always resolves against the *engine's* environment (never
the scrubbed child env) at both probe time and dispatch time — but a
*relative* `_COMMAND` resolves against whatever the engine's current working
directory happens to be at each of those two moments, and those two
moments don't share a cwd. That's a "doctor green, first dispatch fails"
hole: the probe can succeed from one cwd and the real invocation fail from
another. `doctor` catches this:

```
  warning: harness 'claude-headless' _COMMAND override './bin/claude' is a relative path — it resolves against different working directories at probe time and at dispatch time; use an absolute path instead
```

A **bare command name** (no `/` at all, e.g. `claude`) is fine and does
**not** warn — PATH resolution is consistent regardless of cwd, so there's no
hole to close. Only a path containing `/` that isn't absolute is flagged.

## Verifying with `conduit doctor`

Run `conduit doctor` with **no flow argument** to see every registered
adapter — name, capability flags, and binary-probe result — independent of
any specific flow:

```
$ conduit doctor
  state_db_volume: ok
  project-root-present: ok
  model_api_key: ok
  gateway_base_url: ok — CONDUIT_BASE_URL is configured
  harness 'claude-headless' canRestrictTools=true reportsUsage=true at '/usr/local/bin/claude': ok
```

A missing binary surfaces in the same probe result rather than a separate
error:

```
  harness 'claude-headless' canRestrictTools=true reportsUsage=true at ''claude' not found on PATH': FAIL
```

Expect: every adapter you registered listed, `canRestrictTools`/`reportsUsage`
shown, the binary probed `ok`, and no `warning:` lines (or exactly the
warnings you intended, if you're deliberately running with a non-default
allowlist).

**`conduit doctor <flow.yaml>` shows a DIFFERENT listing.** Scoping to a flow
replaces the adapter listing above — it does not layer on top of it. `doctor
<flow.yaml>` probes only the harness adapters that specific flow's stations
declare, and shows a more minimal per-station line with no capability flags:

```
$ conduit doctor examples/research-flow.yaml
  harness 'claude-headless' (station 'research') at '/usr/local/bin/claude': ok
```

The allowlist/`_COMMAND` warnings, however, fire in **both** modes — a broken
allowlist is broken regardless of which flow is probed, so `doctor
<flow.yaml>` surfaces the same `HOME`/`PATH`-floor and relative-`_COMMAND`
warnings as the bare command. Either invocation is enough to catch an
allowlist or command misconfiguration.

## `conduit resume` and containment re-anchoring

`conduit resume` reuses a run's **recorded** project root by default — no
`--project-root` needed, and this includes a worktree-rooted run, which
re-anchors cwd confinement and `owned_paths` at the recorded worktree path
automatically. If you pass an explicit `--project-root` that **differs**
from the recorded root, resume proceeds with your override (re-anchoring
containment is a legitimate operator decision) but never silently:

```
warning: resume --project-root '/new/root' re-anchors run 'job-A' away from its recorded project root '/original/root' — proceeding with the override; cwd confinement and owned_paths now anchor at the override root
```

No warning fires when there's no override, or when the override resolves to
the same path as the recorded root.

## Model precedence: station wins over `_MODEL`

`CONDUIT_HARNESS_<NAME>_MODEL` sets the adapter's **deployment default**. A
station's own `model:` field in `flow.yaml` — when set — **wins**: the
flow states intent, engine config is only the fallback. Whichever value is
actually used (station's, or the adapter default when the station declares
none, or neither — no `--model` flag is passed at all when both are unset)
is exactly the value passed to the harness CLI *and* recorded in the resume
binding stamp, so the two never disagree — a resume after only the adapter
default changed correctly re-invokes rather than silently skipping.

## Named agents and plugin dirs

A `claude-headless` station can run a named Claude Code agent out of a plugin
directory the deployment supplies, without that plugin being installed in
anyone's user config:

```sh
export CONDUIT_HARNESS_CLAUDE_HEADLESS_PLUGIN_DIRS=/opt/conduit/plugins
```

```yaml
  - id: coder
    worker:
      kind: harness
      harness: claude-headless
      agent: ai-team:murdock        # <plugin>:<agent>
      prompt_file: prompts/coder.md
      prompt_version: "1"
      tools: [Read, Write, Bash]
```

A gate critic takes the same field as `check.critic.agent`, next to
`check.critic.harness`.

- **Precedence.** The station's `agent:` wins over `_AGENT`, exactly as
  `model:` wins over `_MODEL`. Neither set: no `--agent` flag.
- **Plugin dirs are per run, agents are per station.** `_PLUGIN_DIRS` is
  engine config and applies to every invocation through the adapter; each
  entry becomes one `--plugin-dir`. An entry holding
  `.claude-plugin/plugin.json` is one plugin; any other entry is a folder of
  plugins, and each child holding that manifest is loaded. Only directories are
  accepted. The CLI also takes a `.zip`, but the kernel has to read the
  agent's definition file.
- **Agent names are `<plugin>:<agent>`.** The plugin part is the manifest's
  `name`; the agent part is the definition file's frontmatter `name:`, not its
  filename. A `--plugin-dir` plugin takes precedence over an installed plugin
  of the same name.
- **The agent is part of the binding stamp.** The kernel finds the agent's
  definition file in the configured plugin dirs (`agents/*.md`, plus any
  paths the manifest's `agents` field lists) and folds the agent name and the
  file's SHA-256 into the station's `prompt_template_version`. Editing the
  agent body invalidates the checkpoint and cascades downstream, the same as
  editing a `worker.uses` skill. Other plugin files (skills, hooks, commands)
  are not hashed. Every `<station>.harness` journal row records the agent
  name and that SHA-256 in its `agent` and `agent_sha256` columns, next to
  the `binding_stamp` and folded `prompt_template_version`, so a result stays
  attributable to the agent version that produced it after the checkpoint is
  gone. A harness critic's `<station>.harness-critic` row records its agent
  the same way, with no stamp, since a critic writes no checkpoint.
- **It fails closed.** An agent with no definition file in the plugin dirs, a
  name without a `<plugin>:` part, or more than one matching file is rejected
  at flow load (`UNRESOLVED_HARNESS_AGENT`) when a registry is configured, and
  again at dispatch, where the card hard-pauses to `hold` without invoking the
  harness. `agent:` on a station that is not `kind: harness`, or on a critic
  with no `harness`, is `INVALID_HARNESS_AGENT`. A name the CLI itself does
  not know makes `claude` exit 1 naming it, which the adapter reports as a
  `harness-nonzero-exit` attempt failure.

## Isolating the child's Claude config: `_ISOLATE_CONFIG`

With `HOME` allowlisted, `claude -p` reads the operator's `~/.claude`:
installed and skills-dir plugins, user agents, `settings.json` and its hooks,
the user `CLAUDE.md`, and the account's claude.ai MCP connectors. Two
operators running the same flow get different child behaviour, and none of
it is in the binding stamp.

```sh
export CONDUIT_HARNESS_CLAUDE_HEADLESS_ISOLATE_CONFIG=1
```

With this set, each invocation:

1. creates a fresh directory under the engine's temp dir and sets
   `CLAUDE_CONFIG_DIR` to it for the child, overriding any allowlisted value;
2. symlinks the operator's `.credentials.json` into it (from the engine's own
   `CLAUDE_CONFIG_DIR`, else `$HOME/.claude`). The file is linked, never
   copied or read. When `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
   `CLAUDE_CODE_OAUTH_TOKEN` or a `CLAUDE_CODE_USE_*` provider variable is
   allowlisted and set, nothing is linked;
3. passes `--strict-mcp-config`, which drops user-level and claude.ai MCP
   servers;
4. deletes the directory when the invocation returns or throws.

If there is neither a credentials file nor an allowlisted auth variable, the
invocation fails before spawning, naming what it looked for.

Verified against `claude` 2.1.282: subscription auth works with only the
credentials link present, and the child loads no user plugin, user agent,
user `CLAUDE.md` or MCP server. What the fence does not cover is listed in
[`harness-containment.md`](./harness-containment.md#the-childs-configuration-surface).
Two of those gaps are operational:

- **Token refresh.** The CLI writes `.credentials.json` with an atomic rename
  that does not follow symlinks. If the child refreshes the OAuth token, the
  new token lands in the run-scoped dir and is deleted with it, and the
  operator's file keeps the old one. If the provider rotated the refresh
  token, the operator has to log in again. A long-lived
  `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) on the allowlist
  avoids the file entirely and is the recommended credential under isolation.
- **macOS.** Subscription credentials live in the Keychain there, not in a
  file, so isolation needs one of the auth variables above.

Isolation is off by default so existing deployments keep the child surface
they have today. In the Docker walkthrough above, the read-only
`~/.claude` mount works unchanged: the CLI writes its session state into the
run-scoped dir, not the mount.

## A harness station's `outputs[0]` is its typed result

A `kind: harness` worker's first declared `outputs` entry is not just another
artifact — it's the one the engine reads back off disk and coercively parses
as JSON against the station's `output_schema` (`stationConfig.outputs[0]` in
`src/controller/executor.ts`; enforced at load time by `HARNESS_MISSING_OUTPUTS`
in `src/flow/load.ts`, which rejects a `kind: harness` station that declares
no `outputs` at all). Everything after `outputs[0]` is an ordinary artifact —
written to disk, checked for existence, never parsed.

```yaml
outputs: [findings.md]              # findings.md IS the typed result — must be JSON
outputs: [findings.md, notes.md]    # findings.md parsed as JSON; notes.md is just a file
```

A harness maker whose sole deliverable is prose — a markdown report with no
JSON envelope — fails the moment the engine tries to parse `outputs[0]`: the
card scraps with `harness-output-unparseable: station '<id>' output '<file>'
is not valid JSON`. Give the model a small JSON wrapper (even just
`{ "summary": "..." }`) as `outputs[0]`, and put the prose deliverable in a
second `outputs` entry instead.

## The critic verdict contract

Unlike a harness maker, a `check.critic.harness` critic has no `outputs` list
of its own — a critic block in `flow.yaml` doesn't accept an `outputs` field.
Its verdict instead goes to a fixed, reserved filename, `verdict.json`, at the
project root (`HARNESS_CRITIC_VERDICT_FILE` in `src/quality/gate.ts`). The
engine deletes any stale `verdict.json` before each critic attempt, so a
critic that resolves without (re)writing the file can't accidentally have an
earlier rework cycle's verdict mistaken for this attempt's judgment.

The verdict must match this shape:

```json
{ "verdict": "pass", "findings": [] }
```

```json
{ "verdict": "reject", "findings": ["Check 3 failed: summary omits \"durability\""], "return_to": "research" }
```

- `verdict` — `"pass"` or `"reject"`, required.
- `findings` — array of strings, required. **On a reject, `findings` must be
  non-empty** (a `pass` with empty `findings` stays legal). A reject with
  missing/empty `findings` — including the common mistake of writing the
  reasons under the wrong key entirely (e.g. `{"verdict":"reject","reasons":[...]}`)
  — fails verdict validation under its own named reason,
  `harness-critic-reject-without-findings`, rather than being folded into the
  generic `harness-critic-verdict-invalid` catch-all, so it's greppable as its
  own failure class in the journal.
- `return_to` — optional back-edge lane; falls back to the station's
  `on_reject` when omitted, and must be one of the flow's validated
  back-edges (an unrecognized lane here is the separate, already-existing
  `invalid_verdict` outcome).

A malformed critic invocation is still a **scrap** either way — Conduit has no
"retry the critic" path independent of the card's own rework loop — but each
failure mode scraps under its own named reason
(`harness-critic-invoke-failed`, `harness-critic-verdict-missing`,
`harness-critic-verdict-unparseable`, `harness-critic-reject-without-findings`,
`harness-critic-verdict-invalid`) instead of one shared, undiagnosable
`model-incompatible` label — each names the specific thing that went wrong
in `gate_verdict` / journal output.

[`examples/prompts/research-critic.md`](../examples/prompts/research-critic.md)
is the reference critic prompt that instructs the model to write exactly this
shape — see [`examples/research-flow.yaml`](../examples/research-flow.yaml)
for the station config it pairs with.

## Reproducing the Phase-1 exit-criterion evidence

The self-serve evidence that a configured deployment can run a real
harness-maker + adversarial-harness-critic flow end to end, headlessly:

```sh
CONDUIT_E2E_CLAUDE=1 bun test src/integration/harness-e2e-claude.test.ts
```

This is **flag-gated and default-skipped** — a plain `bun test` never runs
it, so CI and uncredentialed environments stay green. Running it enabled
requires:

- a `claude` binary on `PATH`, logged in (subscription auth is what this
  test exercises — see [Quick start](#quick-start) above for the exact env
  it sets internally: `CONDUIT_HARNESS_ADAPTERS=claude-headless`,
  `CONDUIT_HARNESS_CLAUDE_HEADLESS_ENV=HOME,PATH`);
- willingness to spend **real tokens** — it runs [`examples/research-flow.yaml`](../examples/research-flow.yaml)
  (a harness maker + adversarial harness critic, using the cheap Haiku
  model, bounded by the fixture's own `budgets.run.max_tokens`) against the
  real local `claude` binary, not a fake adapter.

> **A harness critic MUST declare a non-empty `criticTools` allowlist.** A
> `check.critic.harness` station with an omitted or empty tools list is a
> load-time error (`HARNESS_CRITIC_TOOLS_REQUIRED`) — the critic is the
> quality gate itself, so its verdict must be produced under known
> containment, and there is no unrestricted-tools waiver for critics.
>
> **Expressibility is judged per-list, not per-adapter.** An
> adapter either expresses tool restriction by name (`claude-headless`,
> `--allowed-tools`; the static `canRestrictTools=true`) or — when it
> implements `canExpressTools(tools)` — by mapping the list onto an
> OS-enforced capability envelope. `codex-exec` does the latter: a list maps
> onto a sandbox envelope iff the envelope grants exactly the list's
> capability classes —
>
> | Allowlist shape | Codex envelope |
> |---|---|
> | `Read`/`Glob`/`Grep` (± `Bash`) | `-s read-only` (sandboxed exec is confined to reads) |
> | + `Write`/`Edit` — `Bash` **must** be granted | `-s workspace-write` |
> | + `WebFetch`/`WebSearch` | `-c sandbox_workspace_write.network_access=true` |
> | network without write · write without `Bash` · unknown tool names | **unexpressible** |
>
> A list no envelope matches still fails `HARNESS_TOOLS_UNEXPRESSIBLE` at
> load (and fail-closed at invoke, as defense-in-depth). The doctor line's
> `canRestrictTools=false` for codex-exec remains accurate as the
> conservative static flag — `perListTools=yes` on the same line signals the
> per-list negotiation that admits the expressible subsets.
>
> **Semantics asymmetry flow authors should know:** codex has no no-exec
> posture (`read-only` / `workspace-write` / `danger-full-access` only), so a
> Bash-less list like `tools: [Read]` means *no shell at all* on
> claude-headless but *read-confined shell* on codex-exec — the sandbox
> denies writes and network to spawned commands, but `grep -r /` over
> OS-readable files is possible. Same capability class, different mechanism.
> Workspace-write mode always pins `network_access` explicitly (both
> directions), so a user-level `~/.codex/config.toml` granting network can
> never widen a flow's declared envelope.
>
> Envelope semantics verified live on codex-cli 0.142.4 (Linux, bubblewrap):
> `read-only` denied both a shell file-write and `curl` at the OS level;
> workspace-write's default denied `curl`; a user-config network grant
> demonstrably reached the spawned run; the CLI `-c` override restored denial.

On success, it asserts the exit-criterion evidence: the card reaches `done`,
per-attempt journal rows for the maker station with usage, and `gate_verdict`
rows for the adversarial critic.

**A single scrap on this test is not automatically a bug.** The flow's
adversarial critic is a real LLM judgment call, bounded by the flow's own
`rework_cap` (its internal quality loop — distinct from the test itself,
which never loops or retries the flow). If the critic genuinely rejects
every attempt within that bound, the test fails with a diagnostic prefixed
`JUDGMENT SCRAP: mechanism verified, critic rejected Nx — re-run the
evidence test` — meaning the wiring is confirmed correct (well-formed critic
verdicts, maker spans recorded) and this was live-model variance, not a
defect. **Re-run it.** A failure prefixed `WIRING FAILURE:` instead means
the evidence doesn't look like a clean critic rejection — that one is worth
investigating.

### The plugin-dir agent evidence

A second flag-gated test checks that a `--plugin-dir` agent runs while an
identically named agent exists in ambient config, and that the ambient one is
unreachable under `_ISOLATE_CONFIG`:

```sh
CONDUIT_E2E_CLAUDE=1 bun test src/integration/harness-e2e-claude-agent.test.ts
```

It needs a `.credentials.json` in your Claude config dir (it is symlinked into
a scratch dir, never copied) and costs two Haiku calls.

## See also

- [`harness-containment.md`](./harness-containment.md) — what a `kind: harness`
  station is (and isn't) contained by once registered.
- [ADR-0003](../adr/0003-packaging-and-distribution.md) — the Docker
  packaging and secrets-discipline model this guide assumes.
- [`single-host-concurrency.md`](./single-host-concurrency.md) — running
  multiple `conduit run`/`resume` processes against one shared state DB,
  each with its own `--project-root`.
- [`installation.md`](./installation.md) — the base `CONDUIT_API_KEY` /
  `CONDUIT_BASE_URL` / state-volume setup this guide layers on top of.
