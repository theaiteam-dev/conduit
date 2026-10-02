/**
 * codex-app-server harness adapter (issue #21).
 *
 * Drives `codex app-server` (line-delimited JSON-RPC over stdio, no `jsonrpc`
 * field) so the kernel can decide every tool call before it runs. Under the
 * `untrusted` approval policy Codex asks the client before every shell command
 * and every patch, including the commands a subagent runs and the nested
 * commands its code-mode `exec` tool issues. Each request is answered from
 * `HarnessInvocation.gate`, called through `callGateFailClosed`. The loop stays
 * Codex's own: this is a pre-execution decision on each call, not the
 * Law-grade Tool-Bridge (SPEC §7, step 9b).
 *
 * What is asked, and how it reaches the gate:
 *   - `item/commandExecution/requestApproval`: the command is a display string
 *     such as `/usr/bin/zsh -lc 'cat a.txt'`. The shell wrapper is removed and
 *     the script goes to the gate as a `Bash` call. A working directory outside
 *     the project root is denied here, since the gate does not see it.
 *   - `item/fileChange/requestApproval`: the request names no paths. They come
 *     from the `item/started` item of type `fileChange` that precedes it, and
 *     every path is gated (add: Write, update: Edit, delete: Write, a move:
 *     Edit on the source and Write on the destination). One denied path denies
 *     the request. A request with no announced item is denied, and so is an
 *     item whose add or delete carries a move_path.
 *   - `mcpServer/elicitation/request`: gated as `mcp__<server>__<tool>`, which
 *     the gate denies, and answered with `decline`.
 *   - Any other server request is answered with a JSON-RPC error, never left
 *     waiting and never accepted.
 *
 * The host answers with `accept`, `decline` or `cancel` and nothing else.
 * `acceptForSession` and the execpolicy or network-policy amendments would let
 * later calls skip the gate, so no code path here can send them.
 *
 * A `decline` gives the model no reason and it tries other ways, so every retry
 * is gated again. After the first `hold` every later request is declined
 * without asking the gate. A hold is answered with `cancel`, which denies the
 * call and interrupts the turn. Codex reports no usage for an interrupted call,
 * so the held invocation's usage is what `thread/tokenUsage/updated` had
 * reported before it, and the in-flight model call is not counted.
 *
 * Usage is the last `total` of each thread, summed across threads, because a
 * subagent reports on its own thread id. Codex reports no cost, so cost is 0,
 * as for `codex-exec`. `totalTokens` is input plus output and
 * `reasoningOutputTokens` is a subset of the output, so it is not added again.
 *
 * Process ownership. The app-server starts detached (its own session and
 * process group), inside its own cgroup where the host allows it, registered
 * with `trackProcessGroup`, and is ended with `killContained` on every exit
 * path. Codex starts each command in its own session, so the group kill alone
 * would leave one running.
 *
 * The child gets a run-scoped CODEX_HOME and only the allowlisted env. Web
 * search is not gated by approval, so it is disabled with `-c`, as are the
 * other built-in tools that do not ask. Without those flags the built-in MCP
 * resource tools (`list_mcp_resources`, `read_mcp_resource`) ran without a
 * request. With them, a model asked to list its tools named neither. That is
 * the model's own report, checked on one codex version, and a tool that a
 * newer version adds without an approval request would be ungated.
 *
 * Every invocation is a fresh, ephemeral thread. Not implemented: session
 * resume, named agents.
 */

import { existsSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type {
  BinaryProbe, HarnessAdapter, HarnessInvocation, HarnessResult, KnownUsage, RateLimitSnapshot, RateLimitWindow,
} from './harness-adapter';
import {
  containedSpawn, resolveExecutable,
  type ContainedProcess, type ContainedProcessHandlers, type ContainedSpawn,
} from './harness-contained-spawn';
import { bindingResetAtMs } from './harness-adapter-claude';
import { createRunScopedCodexHome, removeRunScopedCodexHome } from './codex-home-isolation';
import { createHarnessEventEmitter } from './harness-events';
import { HARNESS_GATE_HOLD_CODE, callGateFailClosed, type GateDecision, type GateToolCall } from './harness-gate';
import { buildHarnessChildEnv } from './harness-runner';
import { isContainedIn, resolveOwnedPath } from './integrity';
import { resolveContainment, type Containment } from './cgroup-containment';

export interface CodexAppServerHarnessAdapterConfig {
  /** Absolute project root: the app-server's cwd and the confinement root for commands. */
  projectRoot: string;
  /** Env var names visible to the child (NFR-Security-2), sourced from engine config. */
  envAllowlist: string[];
  /** Codex binary. Defaults to `codex`, resolved on PATH. A path is used as given. */
  command?: string;
  /** Default model. A station's own model wins. */
  model?: string;
  /** Kernel env used to resolve the allowlist, PATH lookup and credentials. Defaults to process.env. */
  sourceEnv?: Record<string, string | undefined>;
  /** Injected process seam, for tests. Defaults to a contained detached spawn. */
  spawn?: ContainedSpawn;
  /** Injected binary-presence probe, for tests. */
  probe?: () => Promise<BinaryProbe>;
  /** Injected `--version` runner, for tests. Takes the resolved binary path, returns its stdout or undefined on failure. */
  readVersion?: (binaryPath: string) => Promise<string | undefined>;
  /** Wait after a gate hold for the turn to end before the process is killed, in ms. For tests; defaults to HOLD_STOP_WAIT_MS. */
  holdStopWaitMs?: number;
  /** Injected containment mechanism, for tests. Defaults to the process-wide detection. */
  containment?: Containment;
}

/** Longest wait, after a gate hold, for the interrupted turn to end. Then the process is killed. */
const HOLD_STOP_WAIT_MS = 5_000;
/** Bytes of the child's stderr kept for error detail. */
const STDERR_TAIL_BYTES = 2_000;

/** Longest wait for `codex --version` during the probe, in ms. */
const VERSION_PROBE_TIMEOUT_MS = 5_000;
/** The codex version the ungated built-in list below was checked against. */
export const UNGATED_FEATURES_CHECKED_VERSION = '0.159.1';

/** Run `<binary> --version` with a bounded wait. Undefined when it fails, times out or prints nothing. */
async function runVersionCommand(binaryPath: string, sourceEnv: Record<string, string | undefined>): Promise<string | undefined> {
  try {
    const proc = Bun.spawn([binaryPath, '--version'], {
      stdout: 'pipe', stderr: 'ignore', stdin: 'ignore',
      env: { PATH: sourceEnv.PATH ?? '/usr/bin:/bin', HOME: sourceEnv.HOME ?? '/' },
      timeout: VERSION_PROBE_TIMEOUT_MS, killSignal: 'SIGKILL',
    });
    const out = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return undefined;
    return out.trim() === '' ? undefined : out.trim();
  } catch {
    return undefined;
  }
}

/** The probe detail: the path, the version when known, and a note when it differs from the checked one. */
export function describeCodexProbe(path: string, version: string | undefined): string {
  if (version === undefined) return path;
  const number = /\d+\.\d+\.\d+\S*/.exec(version)?.[0];
  const note = number !== undefined && number === UNGATED_FEATURES_CHECKED_VERSION
    ? ''
    : `, ungated built-ins checked against ${UNGATED_FEATURES_CHECKED_VERSION}`;
  return `${path} (${version}${note})`;
}

/**
 * Built-in tools that do not ask for approval, turned off with `-c`. Web search
 * runs without a request, and so do the tools that reach the network or read
 * outside the workspace through a channel other than a shell command.
 */
const UNGATED_FEATURES: readonly string[] = [
  'apps', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'computer_use',
  'image_generation', 'in_app_browser', 'plugins', 'remote_plugin', 'view_image',
  'skill_mcp_dependency_install', 'tool_suggest',
];

/** Arguments after the binary name. Exported so a test can pin them. */
export const CODEX_APP_SERVER_ARGS: readonly string[] = [
  'app-server',
  '-c', 'web_search="disabled"',
  '-c', 'allow_login_shell=false',
  '-c', 'sandbox_workspace_write.network_access=false',
  ...UNGATED_FEATURES.flatMap((name) => ['-c', `features.${name}=false`]),
];

/** The sandbox and approval policy sent on `thread/start`. The policy is repeated on every `turn/start`. */
const APPROVAL_POLICY = 'untrusted';
const SANDBOX = 'workspace-write';

function fail(reason: string, code?: string, detail?: Record<string, unknown>): never {
  throw Object.assign(new Error(`codex-app-server: ${reason}`), code !== undefined ? { code } : {}, detail ?? {});
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// ---------------------------------------------------------------------------
// Shell command unwrapping
// ---------------------------------------------------------------------------

const SAFE_UNQUOTED = /[A-Za-z0-9_@%+=:,./-]/;

/**
 * Split a shell-quoted string into words: single quotes, double quotes without
 * expansion, and backslash escapes. Returns null for anything it cannot read
 * as a plain word list: an unbalanced quote, an expansion inside double
 * quotes, or an unquoted character outside the set `shlex` leaves unquoted.
 * Codex builds the string it shows with `shlex`, so a string that needs more
 * than this did not come from it.
 */
export function splitShellWords(input: string): string[] | null {
  const words: string[] = [];
  let current = '';
  let inWord = false;
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      if (inWord) words.push(current);
      current = '';
      inWord = false;
      i += 1;
    } else if (ch === "'") {
      const end = input.indexOf("'", i + 1);
      if (end < 0) return null;
      current += input.slice(i + 1, end);
      inWord = true;
      i = end + 1;
    } else if (ch === '"') {
      inWord = true;
      i += 1;
      for (;;) {
        const c = input[i];
        if (c === undefined) return null;
        if (c === '"') {
          i += 1;
          break;
        }
        if (c === '$' || c === '`') return null;
        if (c === '\\') {
          const next = input[i + 1];
          if (next === undefined) return null;
          if (next === '\n') {
            i += 2;
          } else if (next === '"' || next === '\\' || next === '$' || next === '`') {
            current += next;
            i += 2;
          } else {
            current += c;
            i += 1;
          }
        } else {
          current += c;
          i += 1;
        }
      }
    } else if (ch === '\\') {
      const next = input[i + 1];
      if (next === undefined) return null;
      if (next !== '\n') current += next;
      inWord = true;
      i += 2;
    } else if (SAFE_UNQUOTED.test(ch)) {
      current += ch;
      inWord = true;
      i += 1;
    } else {
      return null;
    }
  }
  if (inWord) words.push(current);
  return words;
}

const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ash', 'ksh']);
const SHELL_COMMAND_FLAG = /^-[a-z]*c$/;

/**
 * The command an approval request will run, as the string the gate should see.
 * A `<shell> -c '<script>'` wrapper (`-lc` and `-ic` included) yields the
 * script. Any other command is returned as shown. Returns an error when the
 * string cannot be read as a word list, which the caller treats as a deny.
 */
export function unwrapShellCommand(command: string): { command: string } | { error: string } {
  const words = splitShellWords(command);
  if (words === null) return { error: 'the command string could not be parsed' };
  if (words.length === 0) return { error: 'the command string is empty' };
  if (words.length >= 3 && SHELLS.has(basename(words[0]!)) && SHELL_COMMAND_FLAG.test(words[1]!)) {
    // Extra words after the script are positional parameters ($0, $1, ...) the script can expand. Gating the raw string would hide the script.
    if (words.length > 3) return { error: 'the shell wrapper carries extra arguments after the script' };
    return { command: words[2]! };
  }
  return { command };
}

// ---------------------------------------------------------------------------
// Protocol shapes read here
// ---------------------------------------------------------------------------

type Verdict = 'accept' | 'decline' | 'cancel';

const METHOD_COMMAND = 'item/commandExecution/requestApproval';
const METHOD_FILE_CHANGE = 'item/fileChange/requestApproval';
const METHOD_ELICITATION = 'mcpServer/elicitation/request';

const RATE_LIMIT_INFO: ReadonlySet<string> = new Set(['usageLimitExceeded', 'rateLimitExceeded', 'serverOverloaded']);

interface FileChange {
  path: string;
  kind: 'add' | 'update' | 'delete';
  movePath: string | undefined;
}

interface TokenTotal {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
}

function parseTokenTotal(value: unknown): TokenTotal | undefined {
  if (!isObject(value)) return undefined;
  const input = num(value.inputTokens);
  const output = num(value.outputTokens);
  return {
    totalTokens: typeof value.totalTokens === 'number' ? value.totalTokens : input + output,
    inputTokens: input,
    cachedInputTokens: num(value.cachedInputTokens),
    cacheWriteInputTokens: num(value.cacheWriteInputTokens),
    outputTokens: output,
  };
}

function parseFileChanges(item: Json): FileChange[] | undefined {
  if (!Array.isArray(item.changes)) return undefined;
  const changes: FileChange[] = [];
  for (const raw of item.changes) {
    if (!isObject(raw) || !isObject(raw.kind)) return undefined;
    const path = str(raw.path);
    const kind = raw.kind.type;
    if (path === undefined || (kind !== 'add' && kind !== 'update' && kind !== 'delete')) return undefined;
    const movePath = str(raw.kind.move_path);
    // Only an update can move a file. A move_path on add or delete is unexpected, so the item is rejected.
    if (movePath !== undefined && kind !== 'update') return undefined;
    changes.push({ path, kind, movePath });
  }
  return changes;
}

/** The gate calls a file change stands for. */
function gateCallsForChange(change: FileChange): Array<{ toolName: 'Write' | 'Edit'; path: string }> {
  if (change.kind === 'update') {
    return [
      { toolName: 'Edit', path: change.path },
      ...(change.movePath !== undefined ? [{ toolName: 'Write' as const, path: change.movePath }] : []),
    ];
  }
  return [{ toolName: 'Write', path: change.path }];
}

function windowName(minutes: unknown, fallback: string): string {
  if (minutes === 300) return 'five_hour';
  if (minutes === 10080) return 'seven_day';
  return typeof minutes === 'number' && minutes > 0 ? `${minutes}_minute` : fallback;
}

/** A codex `account/rateLimits/updated` payload as a RateLimitSnapshot. */
function parseRateLimits(params: unknown): RateLimitSnapshot | undefined {
  if (!isObject(params) || !isObject(params.rateLimits)) return undefined;
  const limits = params.rateLimits;
  const windows: RateLimitWindow[] = [];
  for (const [key, fallback] of [['primary', 'primary'], ['secondary', 'secondary']] as const) {
    const w = limits[key];
    if (!isObject(w) || typeof w.usedPercent !== 'number' || typeof w.resetsAt !== 'number') continue;
    windows.push({ name: windowName(w.windowDurationMins, fallback), utilization: w.usedPercent / 100, resetsAtMs: w.resetsAt * 1000 });
  }
  const reached = limits.rateLimitReachedType;
  return {
    status: typeof reached === 'string' && reached.length > 0 ? reached : 'allowed',
    windows,
  };
}

/** True when the snapshot says a provider cap was reached. */
function snapshotReached(snapshot: RateLimitSnapshot | undefined): boolean {
  if (snapshot === undefined) return false;
  return (snapshot.status !== undefined && snapshot.status !== 'allowed') || snapshot.windows.some((w) => w.utilization >= 1);
}

/** The codexErrorInfo name, or the name of its object variant. */
function errorInfoName(info: unknown): string | undefined {
  if (typeof info === 'string') return info;
  if (isObject(info)) return Object.keys(info)[0];
  return undefined;
}

function errorInfoStatus(info: unknown): number | undefined {
  if (!isObject(info)) return undefined;
  const inner = Object.values(info)[0];
  return isObject(inner) && typeof inner.httpStatusCode === 'number' ? inner.httpStatusCode : undefined;
}

interface SeenError {
  message: string;
  info: string | undefined;
  status: number | undefined;
  willRetry: boolean;
}

const AUTH_TEXT = /\b401\b|unauthori[sz]ed|invalid_api_key/i;

function isAuthError(e: SeenError): boolean {
  return e.info === 'unauthorized' || e.status === 401 || AUTH_TEXT.test(e.message);
}

interface ActiveProcess {
  proc: ContainedProcess;
}

type Outcome =
  | { kind: 'turn'; status: string; error: SeenError | undefined }
  | { kind: 'exit' }
  | { kind: 'timeout' }
  | { kind: 'idle' }
  | { kind: 'hold-timeout' }
  | { kind: 'rpc'; message: string };

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/**
 * Build the `codex-app-server` adapter. Every collaborator (`spawn`, `probe`,
 * `containment`, `sourceEnv`) is injectable so tests never start codex.
 */
export function createCodexAppServerHarnessAdapter(config: CodexAppServerHarnessAdapterConfig): HarnessAdapter {
  const command = config.command ?? 'codex';
  const sourceEnv = config.sourceEnv ?? process.env;
  const probe =
    config.probe ??
    (async (): Promise<BinaryProbe> => {
      const resolved = resolveExecutable(command, sourceEnv);
      if (!('path' in resolved)) return { present: false, detail: resolved.error };
      const version = await (config.readVersion ?? ((p) => runVersionCommand(p, sourceEnv)))(resolved.path).catch(() => undefined);
      return { present: true, detail: describeCodexProbe(resolved.path, version) };
    });

  return {
    name: 'codex-app-server',
    reportsUsage: true,
    // The station's `tools` list is the gate's allowlist, as for agent-sdk. Codex has no Read, Glob or
    // Grep tool: it reads through shell commands, which need `Bash(<exe>)` entries.
    canRestrictTools: true,
    canGatePerCall: true,
    model: config.model,

    async probeBinary(): Promise<BinaryProbe> {
      return probe();
    },

    async invoke(call: HarnessInvocation): Promise<HarnessResult> {
      const resolved = resolveExecutable(command, sourceEnv);
      if ('error' in resolved) fail(resolved.error);
      const executable = resolved.path;
      if (!existsSync(config.projectRoot) || !statSync(config.projectRoot).isDirectory()) {
        fail(`project root '${config.projectRoot}' does not exist, cannot confine the harness cwd`);
      }
      const canonicalRoot = resolveOwnedPath(resolve(config.projectRoot));
      const spawnFn: ContainedSpawn = config.spawn ?? containedSpawn(config.containment ?? (await resolveContainment()), 'codex-app-server');
      const model = call.model ?? config.model;

      // Built before the dir exists: nothing between the dir's creation and the try below can throw.
      const baseEnv = buildHarnessChildEnv(config.envAllowlist, sourceEnv);
      // Throws before anything is spawned when the child could not authenticate.
      const codexHome = createRunScopedCodexHome(sourceEnv, config.envAllowlist);
      const env: Record<string, string> = {
        ...baseEnv,
        PATH: baseEnv.PATH ?? sourceEnv.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        CODEX_HOME: codexHome,
      };

      // Every throw from here on must remove the dir, and the process must be dead first.
      let active: ActiveProcess | undefined;
      try {
        const emit = call.onEvent !== undefined ? createHarnessEventEmitter(call.onEvent) : undefined;
        const st: {
          rootThreadId: string | undefined;
          rootTurnId: string | undefined;
          billedModel: string | undefined;
          held: { code: string; reason: string; toolName: string } | undefined;
          holdTimer: ReturnType<typeof setTimeout> | undefined;
          stderrTail: string;
          timedOut: boolean;
          idledOut: boolean;
          finished: boolean;
          exit: { code: number | undefined; signal: string | undefined } | undefined;
        } = {
          rootThreadId: undefined, rootTurnId: undefined, billedModel: undefined, held: undefined, holdTimer: undefined,
          stderrTail: '', timedOut: false, idledOut: false, finished: false, exit: undefined,
        };
        const usageByThread = new Map<string, TokenTotal>();
        // Keyed by thread and item id: a request on one thread must not resolve an item announced on another.
        // Entries are dropped when the item completes, and a fileChange entry also once its request is decided.
        const itemKey = (threadId: string | undefined, itemId: string): string => `${threadId ?? ''}\u0000${itemId}`;
        const fileChanges = new Map<string, FileChange[]>();
        const mcpTools = new Map<string, { server: string; tool: string; threadId: string | undefined }>();
        const errors: SeenError[] = [];
        let rateLimit: RateLimitSnapshot | undefined;

        let resolveFinish!: (outcome: Outcome) => void;
        const finished = new Promise<Outcome>((r) => {
          resolveFinish = r;
        });
        // The first outcome wins, and lines that arrive after it are ignored.
        const finish = (outcome: Outcome): void => {
          st.finished = true;
          resolveFinish(outcome);
        };
        const killAll = (): void => active?.proc.kill();

        // JSON-RPC client side.
        let nextId = 1;
        const pending = new Map<number, { resolve: (m: Json) => void; reject: (e: Error) => void }>();
        const send = (message: Json): void => active?.proc.write(JSON.stringify(message));
        const request = (method: string, params: Json): Promise<Json> =>
          new Promise<Json>((res, rej) => {
            const id = nextId++;
            pending.set(id, { resolve: res, reject: rej });
            send({ method, id, params });
          });
        const rejectPending = (reason: string): void => {
          for (const p of pending.values()) p.reject(new Error(reason));
          pending.clear();
        };

        const agentIdFor = (threadId: string | undefined): string | undefined =>
          threadId !== undefined && st.rootThreadId !== undefined && threadId !== st.rootThreadId ? threadId : undefined;

        // ---- the gate ----------------------------------------------------
        const emitDecision = (
          toolCallId: string | undefined,
          toolName: string,
          agentId: string | undefined,
          decision: GateDecision,
        ): void =>
          emit?.({
            type: 'gate-decision',
            ...(toolCallId !== undefined ? { toolCallId } : {}),
            toolName,
            decision: decision.decision,
            ...(decision.decision !== 'allow' ? { code: decision.code, reason: decision.reason } : {}),
            ...(agentId !== undefined ? { agentId } : {}),
          });

        const beginHold = (decision: GateDecision & { decision: 'hold' }, toolName: string, threadId: string | undefined): void => {
          st.held = { code: decision.code, reason: decision.reason, toolName };
          // The cancel that answers the request interrupts that thread's turn. A subagent's hold leaves
          // the root turn running, so it is interrupted too. If the turn has not ended after the bounded
          // wait, the process is killed.
          if (agentIdFor(threadId) !== undefined && st.rootThreadId !== undefined && st.rootTurnId !== undefined) {
            request('turn/interrupt', { threadId: st.rootThreadId, turnId: st.rootTurnId }).catch(() => {});
          }
          st.holdTimer = setTimeout(() => {
            killAll();
            finish({ kind: 'hold-timeout' });
          }, config.holdStopWaitMs ?? HOLD_STOP_WAIT_MS);
        };

        /** Ask the gate about one call. After the first hold nothing is asked. */
        const askGate = (toolCall: GateToolCall, threadId: string | undefined): GateDecision => {
          const agentId = agentIdFor(threadId);
          const withAgent: GateToolCall = { ...toolCall, ...(agentId !== undefined ? { agentId } : {}) };
          if (st.held !== undefined) {
            const later: GateDecision = { decision: 'deny', code: 'needs_human', reason: 'an earlier call was held for a human' };
            emitDecision(toolCall.toolCallId, toolCall.toolName, agentId, later);
            return later;
          }
          const decision: GateDecision =
            call.gate !== undefined
              ? callGateFailClosed(call.gate, withAgent)
              : { decision: 'deny', code: 'gate_error', reason: 'no tool gate was supplied for this invocation' };
          emitDecision(toolCall.toolCallId, toolCall.toolName, agentId, decision);
          if (decision.decision === 'hold') beginHold(decision, toolCall.toolName, threadId);
          return decision;
        };

        /** A deny the adapter reached without the gate. It is journaled like the gate's. */
        const denyDirect = (
          toolName: string,
          toolCallId: string | undefined,
          threadId: string | undefined,
          code: 'malformed_input' | 'tool_not_allowed' | 'network_denied' | 'path_escape',
          reason: string,
        ): GateDecision => {
          const decision: GateDecision = { decision: 'deny', code, reason };
          emitDecision(toolCallId, toolName, agentIdFor(threadId), decision);
          return decision;
        };

        const verdictOf = (decision: GateDecision): Verdict =>
          decision.decision === 'allow' ? 'accept' : decision.decision === 'hold' ? 'cancel' : 'decline';

        /** Combine the decisions for several calls: a hold beats a deny beats an allow. */
        const combine = (decisions: GateDecision[]): GateDecision => {
          if (decisions.length === 0) return { decision: 'deny', code: 'malformed_input', reason: 'the request named nothing to gate' };
          return (
            decisions.find((d) => d.decision === 'hold') ??
            decisions.find((d) => d.decision === 'deny') ??
            { decision: 'allow' }
          );
        };

        const decideCommand = (params: Json): GateDecision => {
          const threadId = str(params.threadId);
          const itemId = str(params.itemId);
          if (params.kind !== undefined && params.kind !== 'command') {
            return denyDirect('Bash', itemId, threadId, 'tool_not_allowed', `approval kind ${JSON.stringify(String(params.kind).slice(0, 40))} is not supported`);
          }
          if (params.networkApprovalContext !== undefined && params.networkApprovalContext !== null) {
            return denyDirect('Bash', itemId, threadId, 'network_denied', 'the command asks for network access');
          }
          const raw = str(params.command);
          if (raw === undefined) return denyDirect('Bash', itemId, threadId, 'malformed_input', 'the request has no command');
          const cwd = str(params.cwd);
          if (cwd === undefined) return denyDirect('Bash', itemId, threadId, 'malformed_input', 'the request has no working directory');
          if (!isContainedIn(resolveOwnedPath(resolve(canonicalRoot, cwd)), canonicalRoot)) {
            return denyDirect('Bash', itemId, threadId, 'path_escape', 'the working directory is outside the project root');
          }
          const unwrapped = unwrapShellCommand(raw);
          if ('error' in unwrapped) return denyDirect('Bash', itemId, threadId, 'malformed_input', unwrapped.error);
          return askGate({ toolName: 'Bash', input: { command: unwrapped.command }, ...(itemId !== undefined ? { toolCallId: itemId } : {}) }, threadId);
        };

        const decideFileChange = (params: Json): GateDecision => {
          const threadId = str(params.threadId);
          const itemId = str(params.itemId);
          const key = itemId !== undefined ? itemKey(threadId, itemId) : undefined;
          const changes = key !== undefined ? fileChanges.get(key) : undefined;
          if (key !== undefined) fileChanges.delete(key);
          if (changes === undefined) {
            return denyDirect('Write', itemId, threadId, 'malformed_input', 'no file change was announced for this request');
          }
          if (str(params.grantRoot) !== undefined) {
            return denyDirect('Write', itemId, threadId, 'malformed_input', 'the request asks for a session-wide write grant');
          }
          const decisions: GateDecision[] = [];
          for (const change of changes) {
            for (const { toolName, path } of gateCallsForChange(change)) {
              decisions.push(askGate({ toolName, input: { file_path: path }, toolCallId: itemId! }, threadId));
            }
          }
          return combine(decisions);
        };

        const decideElicitation = (params: Json): GateDecision => {
          const threadId = str(params.threadId);
          const server = str(params.serverName) ?? 'unknown';
          const message = str(params.message) ?? '';
          const announced = [...mcpTools.values()].find((m) => m.server === server && m.threadId === threadId);
          const tool = announced?.tool ?? /tool "([^"]{1,64})"/.exec(message)?.[1] ?? 'elicitation';
          return askGate({ toolName: `mcp__${server}__${tool}`, input: {} }, threadId);
        };

        const respond = (id: unknown, result: Json): void => send({ id, result });
        const respondError = (id: unknown, message: string): void => send({ id, error: { code: -32601, message } });

        const handleServerRequest = (id: unknown, method: string, rawParams: unknown): void => {
          if (method !== METHOD_COMMAND && method !== METHOD_FILE_CHANGE && method !== METHOD_ELICITATION) {
            emitDecision(undefined, method.slice(0, 80), undefined, {
              decision: 'deny', code: 'tool_not_allowed', reason: 'unsupported server request',
            });
            respondError(id, `conduit does not handle ${method.slice(0, 80)}`);
            return;
          }
          const asElicitation = method === METHOD_ELICITATION;
          const answer = (verdict: Verdict): Json => (asElicitation ? { action: verdict } : { decision: verdict });
          let decision: GateDecision;
          try {
            if (!isObject(rawParams)) {
              decision = denyDirect('unknown', undefined, undefined, 'malformed_input', 'the request has no params object');
            } else if (method === METHOD_COMMAND) decision = decideCommand(rawParams);
            else if (method === METHOD_FILE_CHANGE) decision = decideFileChange(rawParams);
            else decision = decideElicitation(rawParams);
          } catch {
            decision = { decision: 'deny', code: 'gate_error', reason: 'the adapter failed while inspecting the request' };
          }
          respond(id, answer(verdictOf(decision)));
        };

        // ---- notifications -----------------------------------------------
        const toolNameForChange = (kind: string): string => (kind === 'update' ? 'Edit' : 'Write');

        const handleItem = (started: boolean, params: Json): void => {
          const item = params.item;
          if (!isObject(item)) return;
          const id = str(item.id);
          if (id === undefined) return;
          const threadId = str(params.threadId);
          if (started) {
            switch (item.type) {
              case 'commandExecution': {
                const raw = str(item.command);
                const unwrapped = raw !== undefined ? unwrapShellCommand(raw) : undefined;
                emit?.({
                  type: 'tool-input-available', toolCallId: id, toolName: 'Bash',
                  input: { command: unwrapped !== undefined && 'command' in unwrapped ? unwrapped.command : (raw ?? '') },
                });
                break;
              }
              case 'fileChange': {
                const changes = parseFileChanges(item);
                if (changes !== undefined) {
                  fileChanges.set(itemKey(threadId, id), changes);
                  for (const change of changes) {
                    emit?.({
                      type: 'tool-input-available', toolCallId: id, toolName: toolNameForChange(change.kind),
                      input: { file_path: change.path },
                    });
                  }
                }
                break;
              }
              case 'mcpToolCall': {
                const server = str(item.server) ?? 'unknown';
                const tool = str(item.tool) ?? 'unknown';
                mcpTools.set(itemKey(threadId, id), { server, tool, threadId });
                emit?.({ type: 'tool-input-available', toolCallId: id, toolName: `mcp__${server}__${tool}`, input: {} });
                break;
              }
              default:
                break;
            }
            return;
          }
          fileChanges.delete(itemKey(threadId, id));
          mcpTools.delete(itemKey(threadId, id));
          if (item.type === 'commandExecution' || item.type === 'fileChange' || item.type === 'mcpToolCall') {
            const isError = item.status !== 'completed';
            emit?.({
              type: 'tool-output-available',
              toolCallId: id,
              // The output body is not carried. A failed command's exit code is, in the form the journal reads.
              output: isError && typeof item.exitCode === 'number' ? `Exit code ${item.exitCode}` : '',
              isError,
            });
          }
        };

        const handleNotification = (method: string, rawParams: unknown): void => {
          const params = isObject(rawParams) ? rawParams : {};
          switch (method) {
            case 'turn/started': {
              const turn = params.turn;
              if (params.threadId === st.rootThreadId && isObject(turn) && st.rootTurnId === undefined) st.rootTurnId = str(turn.id);
              break;
            }
            case 'thread/tokenUsage/updated': {
              const threadId = str(params.threadId);
              const usage = isObject(params.tokenUsage) ? parseTokenTotal(params.tokenUsage.total) : undefined;
              if (threadId !== undefined && usage !== undefined) usageByThread.set(threadId, usage);
              break;
            }
            case 'account/rateLimits/updated':
              rateLimit = parseRateLimits(params) ?? rateLimit;
              break;
            case 'error': {
              const e = params.error;
              if (!isObject(e)) break;
              errors.push({
                message: `${str(e.message) ?? ''} ${str(e.additionalDetails) ?? ''}`.trim().slice(0, 500),
                info: errorInfoName(e.codexErrorInfo),
                status: errorInfoStatus(e.codexErrorInfo),
                willRetry: params.willRetry === true,
              });
              break;
            }
            case 'item/started':
              handleItem(true, params);
              break;
            case 'item/completed':
              handleItem(false, params);
              break;
            case 'turn/completed': {
              if (params.threadId !== st.rootThreadId || st.rootThreadId === undefined) break;
              const turn = isObject(params.turn) ? params.turn : {};
              const err = isObject(turn.error) ? turn.error : undefined;
              finish({
                kind: 'turn',
                status: str(turn.status) ?? 'unknown',
                error:
                  err !== undefined
                    ? {
                        message: `${str(err.message) ?? ''} ${str(err.additionalDetails) ?? ''}`.trim().slice(0, 500),
                        info: errorInfoName(err.codexErrorInfo),
                        status: errorInfoStatus(err.codexErrorInfo),
                        willRetry: false,
                      }
                    : undefined,
              });
              break;
            }
            default:
              break;
          }
        };

        // ---- timers ------------------------------------------------------
        const timer = setTimeout(() => {
          st.timedOut = true;
          killAll();
          finish({ kind: 'timeout' });
        }, call.timeoutMs);
        // One-shot counterpart: runHarnessProcess (worker/harness-runner.ts) has the same idle guard. It cannot drive a
        // long-lived session, so both exist: a change to idle-timeout semantics must be made in both.
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        const resetIdleTimer = (): void => {
          if (call.idleTimeoutMs === undefined || st.finished) return;
          if (idleTimer !== undefined) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            if (st.timedOut) return;
            st.idledOut = true;
            killAll();
            finish({ kind: 'idle' });
          }, call.idleTimeoutMs);
        };
        resetIdleTimer();

        const onLine = (line: string): void => {
          if (st.finished) return;
          call.onProgress?.();
          resetIdleTimer();
          let message: unknown;
          try {
            message = JSON.parse(line);
          } catch {
            return;
          }
          if (!isObject(message)) return;
          const hasId = message.id !== undefined && message.id !== null;
          if (typeof message.method === 'string') {
            if (hasId) {
              try {
                handleServerRequest(message.id, message.method, message.params);
              } catch {
                respondError(message.id, 'conduit failed while handling the request');
              }
            } else {
              try {
                handleNotification(message.method, message.params);
              } catch {
                /* a malformed notification cannot fail a billed call */
              }
            }
          } else if (hasId && typeof message.id === 'number') {
            const waiting = pending.get(message.id);
            if (waiting !== undefined) {
              pending.delete(message.id);
              waiting.resolve(message);
            }
          }
        };
        const handlers: ContainedProcessHandlers = {
          onLine,
          onStderr: (text) => {
            st.stderrTail = (st.stderrTail + text).slice(-STDERR_TAIL_BYTES);
          },
          onExit: (code, signal) => {
            st.exit = { code, signal };
            rejectPending('the app-server exited');
            finish({ kind: 'exit' });
          },
        };

        // ---- the run -----------------------------------------------------
        const rpcResult = (response: Json, what: string): Json => {
          if (isObject(response.error)) throw new Error(`${what} failed: ${str(response.error.message) ?? 'no detail'}`);
          if (!isObject(response.result)) throw new Error(`${what} returned no result`);
          return response.result;
        };
        const drive = async (): Promise<void> => {
          rpcResult(
            await request('initialize', {
              clientInfo: { name: 'conduit', title: 'Conduit', version: '0' },
              capabilities: { experimentalApi: true },
            }),
            'initialize',
          );
          send({ method: 'initialized' });
          const thread = rpcResult(
            await request('thread/start', {
              cwd: config.projectRoot,
              approvalPolicy: APPROVAL_POLICY,
              approvalsReviewer: 'user',
              sandbox: SANDBOX,
              ephemeral: true,
              ...(model !== undefined ? { model } : {}),
            }),
            'thread/start',
          );
          const threadObj = isObject(thread.thread) ? thread.thread : {};
          const threadId = str(threadObj.id);
          if (threadId === undefined) throw new Error('thread/start returned no thread id');
          st.rootThreadId = threadId;
          st.billedModel = str(threadObj.model) ?? str(thread.model);
          const turn = rpcResult(
            await request('turn/start', {
              threadId,
              input: [{ type: 'text', text: call.prompt }],
              approvalPolicy: APPROVAL_POLICY,
            }),
            'turn/start',
          );
          if (isObject(turn.turn)) st.rootTurnId ??= str(turn.turn.id);
        };

        emit?.({ type: 'lifecycle', phase: 'start' });
        let outcome: Outcome;
        try {
          const proc = spawnFn(
            { command: executable, args: [...CODEX_APP_SERVER_ARGS], cwd: config.projectRoot, env },
            handlers,
          );
          active = { proc };
          drive().catch((err) => finish({ kind: 'rpc', message: err instanceof Error ? err.message : String(err) }));
          outcome = await finished;
        } finally {
          st.finished = true;
          clearTimeout(timer);
          if (st.holdTimer !== undefined) clearTimeout(st.holdTimer);
          if (idleTimer !== undefined) clearTimeout(idleTimer);
          // The turn has ended or is being ended. A command it started may still run: end the group and
          // the cgroup before waiting, as the runner does on every exit path (#17).
          if (active !== undefined) {
            active.proc.kill();
            await active.proc.close();
          }
        }

        // ---- usage -------------------------------------------------------
        const buildUsage = (): KnownUsage | undefined => {
          if (usageByThread.size === 0) return undefined;
          let tokens = 0, input = 0, cached = 0, cacheWrite = 0, output = 0;
          for (const t of usageByThread.values()) {
            tokens += t.totalTokens;
            input += t.inputTokens;
            cached += t.cachedInputTokens;
            cacheWrite += t.cacheWriteInputTokens;
            output += t.outputTokens;
          }
          return {
            tokens,
            // Codex reports no cost, as codex-exec's stream does not.
            cost: 0,
            breakdown: {
              inputTokens: Math.max(0, input - cached - cacheWrite),
              outputTokens: output,
              cacheReadInputTokens: cached,
              cacheCreationInputTokens: cacheWrite,
            },
            ...(st.billedModel !== undefined ? { model: st.billedModel } : {}),
            ...(rateLimit !== undefined ? { rateLimit } : {}),
          };
        };
        const usage = buildUsage();
        const withUsage = usage !== undefined ? { usage } : undefined;

        if (usage !== undefined) {
          emit?.({ type: 'usage', tokens: usage.tokens, breakdown: usage.breakdown! });
        }
        if (rateLimit !== undefined) {
          emit?.({
            type: 'rate-limit',
            ...(rateLimit.status !== undefined ? { status: rateLimit.status } : {}),
            windows: rateLimit.windows,
          });
        }
        const turnEnded = outcome.kind === 'turn';
        const exitCode = st.exit?.code;
        emit?.(
          st.idledOut && !turnEnded
            ? { type: 'lifecycle', phase: 'idle-timeout' }
            : st.timedOut && !turnEnded
              ? { type: 'lifecycle', phase: 'timeout' }
              : { type: 'lifecycle', phase: 'end', ...(exitCode !== undefined ? { exitCode } : {}) },
        );

        // A hold wins over everything: a human is asked, and what was reported is still billed.
        if (st.held !== undefined) {
          fail(
            `the tool gate held the card on ${st.held.toolName} (${st.held.code}): ${st.held.reason}`,
            HARNESS_GATE_HOLD_CODE,
            withUsage,
          );
        }
        if (outcome.kind === 'idle') {
          fail('invocation produced no output for longer than the idle timeout and was killed', 'harness-idle-timeout', withUsage);
        }
        if (outcome.kind === 'timeout') {
          fail('invocation exceeded its timeout and was killed', 'harness-timeout', withUsage);
        }

        if (outcome.kind === 'turn' && outcome.status === 'completed') {
          return { outputs: [], usage: usage ?? { unknown: true } };
        }

        // Failure. The final error is the turn's own, else the last one that was not going to be retried.
        const finalError =
          (outcome.kind === 'turn' ? outcome.error : undefined) ?? [...errors].reverse().find((e) => !e.willRetry);
        const detailText =
          outcome.kind === 'turn'
            ? `turn ${outcome.status}${finalError !== undefined ? `: ${finalError.message}` : ''}`
            : outcome.kind === 'rpc'
              ? outcome.message
              : st.exit?.signal !== undefined
                ? `the app-server exited with signal ${st.exit.signal} before the turn completed`
                : `the app-server exited${exitCode !== undefined ? ` with code ${exitCode}` : ''} before the turn completed`;

        const authFailed = errors.some(isAuthError) || (finalError !== undefined && isAuthError(finalError));
        // Provider cap first: retrying it now cannot work, and the executor parks rather than scraps.
        const cappedByError = finalError?.info !== undefined && RATE_LIMIT_INFO.has(finalError.info);
        if (cappedByError || (!authFailed && snapshotReached(rateLimit))) {
          const resetAtMs = bindingResetAtMs(rateLimit);
          fail(`provider rate limit: ${finalError?.message ?? rateLimit?.status ?? 'no detail reported'}`, 'harness-rate-limited', {
            ...(resetAtMs !== undefined ? { resetAtMs } : {}),
            ...(rateLimit !== undefined ? { rateLimit } : {}),
            ...(usage !== undefined ? { usage } : {}),
          });
        }
        // Authentication uses the nonzero-exit class the executor already handles: retrying will not help.
        const tail = st.stderrTail.trim();
        fail(
          authFailed
            ? `authentication failed: ${finalError?.message ?? detailText}`
            : `${detailText}${outcome.kind !== 'turn' && tail !== '' ? `: ${tail.slice(-300)}` : ''}`,
          'harness-nonzero-exit',
          withUsage,
        );
      } finally {
        // A throw here would replace the call's own result or error, so report it and move on.
        try {
          removeRunScopedCodexHome(codexHome);
        } catch (err) {
          process.stderr.write(`codex-app-server: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      }
    },
  };
}
