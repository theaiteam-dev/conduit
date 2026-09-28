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
 * This file is the seam. It holds the types both sides build against, the
 * fail-closed wrapper an adapter must call the gate through, and a factory
 * that denies everything until the real one lands.
 */

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
  | 'needs_human';

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
   * (`defaults.enforce_owned_paths` is off), and write paths are not checked.
   * Present and empty: every write is denied.
   */
  ownedPaths?: readonly string[];
}

/**
 * Build the gate for one invocation.
 *
 * Fail-closed placeholder: denies every call until the real implementation
 * replaces this body. Callers depend on the signature only.
 */
export function createHarnessToolGate(_config: HarnessGateConfig): HarnessToolGate {
  return () => ({ decision: 'deny', code: 'gate_error', reason: 'harness tool gate is not implemented' });
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
    return { decision: 'deny', code: 'gate_error', reason: `gate threw: ${err instanceof Error ? err.message : String(err)}` };
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
