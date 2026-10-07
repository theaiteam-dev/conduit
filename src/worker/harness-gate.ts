/**
 * Per-call tool gate for supervised harness adapters (issue #21).
 *
 * A `kind: harness` adapter that sets `canGatePerCall` runs the harness loop
 * with a callback into the host (the Agent SDK's `hooks.PreToolUse`). The
 * kernel supplies the decision function, `HarnessToolGate`, on
 * `HarnessInvocation.gate`; the adapter calls it before every tool call and
 * enforces the answer. The loop stays the harness's own. This gate is a
 * pre-execution decision on each call, not a kernel-owned Tool-Bridge (SPEC §7,
 * step 9b), and the MARK_DONE owned-paths integrity check stays mandatory as
 * the backstop, since a Bash command can write files the gate did not parse.
 *
 * This file holds the types both sides build against, the fail-closed wrapper
 * an adapter must call the gate through, and the factory that builds the gate.
 */

import { lstatSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { checkCommandAllowed } from './deterministic';
import { isContainedIn, resolveOwnedPath } from './integrity';

/** Why a call was denied or held. Stable: journaled and matched in tests. */
export type GateDenyCode =
  /** The tool name is not in the station's `tools` allowlist. */
  | 'tool_not_allowed'
  /** Bash: the executable is not on the positive allowlist. */
  | 'not_allowlisted'
  /** Bash: the command string carries a shell metacharacter. */
  | 'shell_metacharacter'
  /** A write resolves outside the card's owned paths (symlinks resolved). */
  | 'path_escape'
  /** A network tool (WebFetch, WebSearch, ...). Denied by default. */
  | 'network_denied'
  /** The call's input does not have the shape the tool requires. */
  | 'malformed_input'
  /** The gate itself threw or returned garbage. Always a deny. */
  | 'gate_error'
  /** The tool asks a human (AskUserQuestion). Held, never auto-answered. */
  | 'needs_human'
  /**
   * The input that ran differs from the input the gate approved: another
   * PreToolUse hook rewrote it. Never returned by the gate. The agent-sdk
   * adapter detects it after the call ran and holds (issue #109).
   */
  | 'input_rewritten';

/** One tool call, as the harness is about to run it. */
export interface GateToolCall {
  /** The tool's name as the harness reports it, e.g. `Bash`, `Write`, `Agent`. */
  toolName: string;
  /** The tool's raw input object. Untrusted: the gate validates its shape. */
  input: unknown;
  toolCallId?: string;
  /** Present only when the call comes from inside a subagent (spike, #21). */
  agentId?: string;
  agentType?: string;
}

/**
 * The gate's answer.
 *
 * `hold` is a deny that also asks the executor to move the card to the `hold`
 * lane for a human. The adapter ends the harness process and throws an error
 * whose `code` is `HARNESS_GATE_HOLD_CODE`. It does not park a live process.
 */
export type GateDecision =
  | { decision: 'allow' }
  | { decision: 'deny'; code: GateDenyCode; reason: string }
  | { decision: 'hold'; code: GateDenyCode; reason: string };

/** Synchronous and pure over its inputs plus the filesystem. Never awaited. */
export type HarnessToolGate = (call: GateToolCall) => GateDecision;

/** `BilledHarnessError.code` for a run ended by a `hold` decision. */
export const HARNESS_GATE_HOLD_CODE = 'harness-gate-hold';

/** What the kernel knows when it builds the gate for one invocation. */
export interface HarnessGateConfig {
  /** Canonical project root. Relative tool paths resolve against it. */
  projectRoot: string;
  /**
   * The station's `tools` allowlist, in Claude's rule syntax. A tool name
   * alone (`Read`, `Write`) allows that tool. `Bash(<exe>)` and `Bash(<exe>:*)`
   * put `<exe>` on the Bash positive allowlist. A bare `Bash` entry puts no
   * executable on it, so every Bash call is denied. A tool not listed is
   * denied.
   */
  tools: readonly string[];
  /**
   * The card's owned paths. Write, Edit and NotebookEdit inputs must resolve
   * inside them. Absent: owned paths are not enforced for this flow
   * (`defaults.enforce_owned_paths` is off), and write paths must resolve
   * inside the project root instead. Present and empty: every write is denied.
   */
  ownedPaths?: readonly string[];
}

const WRITE_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

// Network egress is denied by default for content workers (SPEC §7). The
// config has no per-station switch yet, so these are denied even when listed.
const NETWORK_TOOLS: ReadonlySet<string> = new Set(['WebFetch', 'WebSearch']);

const MAX_REASON = 200;

/** Journaled reasons carry no control characters and stay short. */
function reason(text: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
  return clean.length > MAX_REASON ? clean.slice(0, MAX_REASON) : clean;
}

function deny(code: GateDenyCode, text: string): GateDecision {
  return { decision: 'deny', code, reason: reason(text) };
}

/** A tool name safe to put in a reason: bounded, no control characters. */
function nameForReason(toolName: string): string {
  return JSON.stringify(reason(toolName.slice(0, 64)));
}

interface ParsedTools {
  /** Tool names allowed by a plain entry (or any `Bash(...)` entry, for Bash). */
  names: ReadonlySet<string>;
  /** Executables from `Bash(<exe>)` and `Bash(<exe>:*)` entries only. */
  bashExecutables: readonly string[];
}

const BASH_RULE_RE = /^Bash\(([^\s():*]+)(?::\*)?\)$/;

function parseTools(tools: readonly string[]): ParsedTools {
  const names = new Set<string>();
  const bashExecutables: string[] = [];
  for (const entry of tools) {
    if (typeof entry !== 'string') continue;
    if (entry === 'Task' || entry === 'Agent') {
      // The subagent tool is `Task` in the CLI init list and `Agent` in hooks.
      names.add('Agent');
    } else if (entry.startsWith('Bash(')) {
      // Any Bash(...) form allows the tool. Only the two exact forms add an
      // executable, so a narrower rule such as `Bash(git status:*)` widens
      // nothing to `git`.
      names.add('Bash');
      const m = BASH_RULE_RE.exec(entry);
      if (m) bashExecutables.push(m[1]);
    } else if (/^[A-Za-z0-9_]+$/.test(entry)) {
      names.add(entry);
    }
    // Any other parenthesised form (for example `Read(./x)`) is not recognised.
  }
  return { names, bashExecutables };
}

function checkBash(input: unknown, executables: readonly string[]): GateDecision {
  const command = (input as { command?: unknown } | null | undefined)?.command;
  if (typeof command !== 'string') return deny('malformed_input', 'Bash input has no string command');
  // Split on plain spaces only. Newline, tab and every other separator stay
  // inside a token, where the metacharacter check refuses them.
  const tokens = command.split(' ').filter((t) => t !== '');
  if (tokens.length === 0) return deny('malformed_input', 'Bash command is empty');
  const verdict = checkCommandAllowed(
    { command: tokens[0], args: tokens.slice(1) },
    { allowlist: executables },
  );
  if (verdict.allowed) return { decision: 'allow' };
  if (verdict.reason === 'shell_metacharacter') {
    return deny('shell_metacharacter', 'Bash command contains a shell metacharacter');
  }
  return deny('not_allowlisted', `Bash executable ${JSON.stringify(tokens[0])} is not allowlisted`);
}

/**
 * True when some existing component of `abs` is a symlink that does not
 * resolve. `resolveOwnedPath` treats such a component as not yet created, but a
 * write through a dangling symlink lands wherever it points.
 */
function hasDanglingSymlink(abs: string): boolean {
  let cur = abs;
  for (;;) {
    try {
      realpathSync(cur);
      return false;
    } catch {
      // Not resolvable: a symlink here is dangling, anything else is absent.
    }
    try {
      if (lstatSync(cur).isSymbolicLink()) return true;
    } catch {
      // Absent component.
    }
    const parent = dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}

/** Where a write may land: the card's owned paths, or the whole project root when they are not enforced. */
interface WriteBoundary {
  roots: readonly string[];
  /** Ends the deny reason: "the owned paths" or "the project root". */
  label: string;
}

function checkWritePath(toolName: string, input: unknown, projectRoot: string, boundary: WriteBoundary): GateDecision {
  const fields = input as { file_path?: unknown; notebook_path?: unknown } | null | undefined;
  const path = toolName === 'NotebookEdit' ? fields?.notebook_path : fields?.file_path;
  if (typeof path !== 'string' || path === '' || path.includes('\0')) {
    return deny('malformed_input', `${toolName} input has no usable path`);
  }

  const abs = resolve(projectRoot, path);
  const escape = deny('path_escape', `${toolName} path ${JSON.stringify(path.slice(0, 120))} is outside ${boundary.label}`);
  if (hasDanglingSymlink(abs)) return escape;
  const target = resolveOwnedPath(abs);
  const inside = boundary.roots.some((root) => isContainedIn(target, root));
  return inside ? { decision: 'allow' } : escape;
}

/**
 * Build the gate for one invocation.
 *
 * Synchronous, total and fail-closed: any input, including a hostile one,
 * yields a decision, and anything unexpected is a deny. Subagent calls
 * (`agentId` set) get the same checks as main-thread calls.
 *
 * Owned paths are canonicalized once here, at build time, so a call resolves
 * only its own candidate path. A symlink re-pointed after the gate is built
 * does not move the owned boundary. Absent `ownedPaths` (ownership not
 * enforced) confines writes to the canonical project root, since a flow that
 * does not enforce ownership has still not granted the host, and an empty
 * array stays empty (every write denied).
 *
 * Reads are not confined to the project root here. Write ownership, the Bash
 * allowlist and the tool allowlist are enforced; read confinement is a later
 * slice.
 */
export function createHarnessToolGate(config: HarnessGateConfig): HarnessToolGate {
  const { names, bashExecutables } = parseTools(config.tools);
  const writeBoundary: WriteBoundary =
    config.ownedPaths === undefined
      ? { roots: [resolveOwnedPath(resolve(config.projectRoot))], label: 'the project root' }
      : {
          roots: config.ownedPaths.map((owned) => resolveOwnedPath(resolve(config.projectRoot, owned))),
          label: 'the owned paths',
        };
  return (call) => {
    try {
      const toolName: unknown = call.toolName;
      if (typeof toolName !== 'string' || toolName === '') {
        return deny('malformed_input', 'tool name is not a string');
      }
      if (NETWORK_TOOLS.has(toolName)) return deny('network_denied', `${toolName} is denied: network egress is off`);
      if (toolName === 'AskUserQuestion') {
        return { decision: 'hold', code: 'needs_human', reason: 'the tool asks a human' };
      }
      if (toolName.startsWith('mcp__') || !names.has(toolName)) {
        return deny('tool_not_allowed', `tool ${nameForReason(toolName)} is not in the station allowlist`);
      }
      if (toolName === 'Bash') return checkBash(call.input, bashExecutables);
      if (WRITE_TOOLS.has(toolName)) {
        return checkWritePath(toolName, call.input, config.projectRoot, writeBoundary);
      }
      return { decision: 'allow' };
    } catch {
      return deny('gate_error', 'gate failed while inspecting the call');
    }
  };
}

/**
 * Call a gate so that nothing it does can allow a call by accident. A throw,
 * a missing return, or an unknown `decision` becomes a `gate_error` deny.
 * Every adapter must call the gate through this, never directly.
 */
export function callGateFailClosed(gate: HarnessToolGate, call: GateToolCall): GateDecision {
  let decision: unknown;
  try {
    decision = gate(call);
  } catch (err) {
    return deny('gate_error', `gate threw: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof decision === 'object' && decision !== null) {
    const d = decision as { decision?: unknown; code?: unknown; reason?: unknown };
    if (d.decision === 'allow') return { decision: 'allow' };
    if ((d.decision === 'deny' || d.decision === 'hold') && typeof d.code === 'string' && typeof d.reason === 'string') {
      return decision as GateDecision;
    }
  }
  return { decision: 'deny', code: 'gate_error', reason: 'gate returned a malformed decision' };
}
