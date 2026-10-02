/**
 * opencode harness adapter (issue #21).
 *
 * Runs one `opencode serve` per invocation and drives it over its HTTP API and
 * SSE event stream (raw `fetch`, not `@opencode-ai/sdk`, whose types were found
 * to differ from the 1.15.10 server: `permission.updated` there,
 * `permission.asked` here). The server is started with `permission: {"*":"ask"}`,
 * so every builtin tool call raises a `permission.asked` event and waits. Each
 * ask is answered from `HarnessInvocation.gate`, called through
 * `callGateFailClosed`. The loop stays opencode's own: this is a pre-execution
 * decision on each call, not the Law-grade Tool-Bridge (SPEC §7, step 9b).
 *
 * How an ask reaches the gate. The ask's `permission` field is a category
 * (`bash`, `edit`, `read`, ...), not a tool name, and it does not carry the
 * absolute path. The real tool name and its input are on the `message.part.updated`
 * tool part with the same `callID`, which may arrive after the ask. The adapter
 * waits for that part (bounded), then re-fetches the message once, and rejects
 * the ask when neither produces it.
 *   - bash: the command is the tool part's `input.command`. The ask's
 *     `patterns` are the parsed sub-commands, so they are only a cross-check.
 *     A `workdir` outside the project root is rejected.
 *   - edit: covers write, edit, multiedit and apply_patch. write is `Write`,
 *     edit and multiedit are `Edit`. A patch is gated per file from the ask's
 *     `metadata.files` (add: Write, update: Edit, delete: Write, move: Edit on
 *     the source and Write on the destination); one denied path rejects it.
 *   - read: Read. glob: Glob. grep: Grep. list: Glob. Their paths must resolve
 *     inside the project root.
 *   - webfetch: WebFetch. websearch and codesearch: WebSearch. task: Agent.
 *   - todowrite: TodoWrite. skill: Skill. Both are allowed only by listing them.
 *   - external_directory: always rejected, without asking the gate.
 *   - question: always a hold. lsp, doom_loop and any unknown category
 *     (an MCP tool included) are rejected as `tool_not_allowed`.
 *
 * The host answers `once` or `reject` and nothing else. `always` would persist
 * for the rest of the server's life and later calls would skip the gate, so no
 * code path here can send it. A reject carries the gate's reason as its
 * message, which lets the model continue with another approach.
 *
 * Subagents. The `task` tool creates a child session (`session.created` with a
 * `parentID`). The adapter tracks the tree from that event. Asks from a child
 * arrive on the same stream and get the same checks, with the child session id
 * as `agentId`. An ask from a session outside the tree is rejected. On idle,
 * only errors from the root session (or naming no session) fail the call, since a
 * subagent's failure returns to the root as a tool result.
 *
 * Hold. Rejecting a call at the ask and aborting at once loses the usage of the
 * step in flight, so the order is: reject the ask, deny every later ask without
 * asking the gate, wait (bounded) until the message that owns the call reports
 * tokens (an ask with no messageID waits for idle or the bound) or the session goes idle, then `POST /session/:id/abort`. The thrown
 * error carries the usage summed so far. The question tool exists only with
 * `OPENCODE_ENABLE_QUESTION_TOOL`, which is never set. A `question.asked` that
 * arrives anyway is rejected and held, and so is a `question` permission ask.
 *
 * Usage. Each assistant message is one model step and carries its own cost and
 * token counts. The last value per message id is kept and summed over every
 * session in the tree. Cost is what opencode reports: it was present for OpenAI
 * and was not looked at for other providers.
 *
 * Process ownership. The server starts detached (its own session and process
 * group), inside its own cgroup where the host allows it, registered with
 * `trackProcessGroup`, and is ended with `killContained` on every exit path.
 * opencode runs each bash command in its own session, which survives a group
 * kill, so the cgroup is the boundary that reaches it.
 *
 * The child. It binds 127.0.0.1 on a random port and requires HTTP Basic auth
 * with a random per-invocation password on every request, the event stream
 * included. The adapter refuses a server that reports any other address. The
 * four XDG directories are run-scoped, project config, Claude-compat files,
 * external skills, plugins and default plugins are switched off, and the
 * child env is the allowlist plus PATH and the run-scoped variables. Allowlisted
 * OPENCODE_* variables are dropped, since OPENCODE_PERMISSION or OPENCODE_CONFIG could override the ask rules
 * and OPENCODE_SERVER_USERNAME would break the Basic auth. Credentials
 * for the model's provider only are passed as `OPENCODE_AUTH_CONTENT`
 * (./opencode-isolation.ts). HOME is not injected.
 *
 * Not verified, or not gated:
 *   - An allowed Bash command runs as the same user as the server and can read its password (the server env
 *     and /proc/<pid>/environ), find the loopback port and answer later asks with `once`. Allowlisting an
 *     executable that can make HTTP requests (curl, python, node, ...) allowlists the gate's bypass. The
 *     container is the boundary for that case.
 *   - The rate-limit shape is inferred from the schema (APIError statusCode
 *     429, `session.status` of type `retry` with rate-limit wording). No live
 *     run hit a provider limit.
 *   - `list` maps to Glob. The `list` tool did not appear in the live tool set,
 *     so its ask shape is assumed to be like glob's.
 *   - MCP tools were not run. No MCP server is configured, so none should exist.
 *   - `tool.execute.before` (a plugin hook) is stricter and fires in subagents,
 *     but it needs OPENCODE_PURE off and runs inside the server, so it is not used.
 *   - Tool asks are the only gate. A builtin that raises no ask would run
 *     ungated. None was seen with `"*":"ask"`.
 *   - Model calls made by opencode itself (title generation and similar) are
 *     not tool calls and are not gated. Their usage arrives as assistant
 *     messages only if opencode records them there.
 *   - Free `opencode/*` models need opencode 1.18 or newer (HTTP 426 before that).
 *
 * Every invocation is a fresh session. Not implemented: session resume, named agents.
 */

import { existsSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import type { BinaryProbe, HarnessAdapter, HarnessInvocation, HarnessResult, KnownUsage } from './harness-adapter';
import {
  containedSpawn,
  resolveExecutable,
  type ContainedProcess,
  type ContainedProcessHandlers,
  type ContainedSpawn,
  type ContainedSpawnSpec,
} from './harness-contained-spawn';
import { createHarnessEventEmitter } from './harness-events';
import { sanitizeGateReason } from './harness-events-journal';
import { HARNESS_GATE_HOLD_CODE, callGateFailClosed, type GateDecision, type GateToolCall } from './harness-gate';
import { buildHarnessChildEnv } from './harness-runner';
import { isContainedIn, resolveOwnedPath } from './integrity';
import { resolveContainment, type Containment } from './cgroup-containment';
import {
  buildProviderAuthContent,
  createRunScopedOpenCodeDirs,
  removeRunScopedOpenCodeDirs,
  splitOpenCodeModel,
} from './opencode-isolation';

export type OpenCodeSpawnSpec = ContainedSpawnSpec;
export type OpenCodeProcessHandlers = ContainedProcessHandlers;
export type OpenCodeProcess = ContainedProcess;
export type OpenCodeSpawn = ContainedSpawn;

export interface OpenCodeHarnessAdapterConfig {
  /** Absolute project root: the server's cwd and the confinement root for tool paths. */
  projectRoot: string;
  /** Env var names visible to the child (NFR-Security-2), sourced from engine config. */
  envAllowlist: string[];
  /** opencode binary. Defaults to `opencode`, resolved on PATH. A path is used as given. */
  command?: string;
  /** Default model as `provider/model`. A station's own model wins. */
  model?: string;
  /** Kernel env used to resolve the allowlist, PATH lookup and credentials. Defaults to process.env. */
  sourceEnv?: Record<string, string | undefined>;
  /** Injected process seam, for tests. Defaults to a contained detached spawn. */
  spawn?: OpenCodeSpawn;
  /** Injected binary-presence probe, for tests. */
  probe?: () => Promise<BinaryProbe>;
  /** Wait after a gate hold for the step to report usage before the abort, in ms. For tests; defaults to HOLD_STOP_WAIT_MS. */
  holdStopWaitMs?: number;
  /** Wait for a tool part that has not arrived when its ask does, in ms. For tests; defaults to TOOL_PART_WAIT_MS. */
  toolPartWaitMs?: number;
  /** Injected containment mechanism, for tests. Defaults to the process-wide detection. */
  containment?: Containment;
}

/** Arguments after the binary name. Port 0 asks the OS for a free one. Exported so a test can pin them. */
export const OPENCODE_SERVE_ARGS: readonly string[] = ['serve', '--port', '0', '--hostname', '127.0.0.1'];

/** Longest wait, after a gate hold, for the step in flight to report usage. Then the session is aborted. */
const HOLD_STOP_WAIT_MS = 5_000;
/** Longest wait for a tool part that has not arrived when its ask does. */
const TOOL_PART_WAIT_MS = 3_000;
/** Bound on every HTTP request other than the event stream, which is bounded by the timers. */
const HTTP_TIMEOUT_MS = 15_000;
/** Bound on the abort request sent while ending a call. */
const ABORT_TIMEOUT_MS = 3_000;
/** Longest wait for `server.connected` after the event stream opens. */
const CONNECT_WAIT_MS = 10_000;
/** Grace, after the event stream ends or the process exits, for the other notice and unread events to arrive first. */
const STREAM_END_GRACE_MS = 250;
/** Bytes of the child's output kept for error detail. */
const OUTPUT_TAIL_BYTES = 2_000;
/** Bytes of an HTTP error body kept for error detail. */
const ERROR_BODY_BYTES = 300;

const LISTENING = /opencode server listening on (https?:\/\/[^\s]+)/;
const AUTH_TEXT = /\b401\b|unauthori[sz]ed|invalid.?api.?key|incorrect api key/i;
const RATE_TEXT = /rate.?limit|too many requests|quota|usage limit|\b429\b/i;

function fail(reason: string, code?: string, detail?: Record<string, unknown>): never {
  throw Object.assign(new Error(`opencode: ${reason}`), code !== undefined ? { code } : {}, detail ?? {});
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

interface ToolPart {
  tool: string;
  status: string;
  input: Json;
  metadata: Json;
  sessionID: string | undefined;
  messageID: string | undefined;
}

interface MessageUsage {
  cost: number;
  total: number;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  model: string | undefined;
}

interface SeenError {
  name: string;
  message: string;
  status: number | undefined;
  retryable: boolean;
  /** Session that raised it; undefined when the event did not say, which is fatal on idle. */
  sessionID?: string;
}

type Outcome =
  | { kind: 'idle' }
  | { kind: 'exit' }
  | { kind: 'timeout' }
  | { kind: 'stalled' }
  | { kind: 'held' }
  | { kind: 'rpc'; message: string }
  | { kind: 'rate-limit'; message: string; resetAtMs: number | undefined };

type Reply = { reply: 'once' } | { reply: 'reject'; message: string };

/** One gate call an ask stands for, and the input the journal is shown for it. */
interface GateCall {
  toolName: string;
  input: Json;
}

interface AskContext {
  sessionID: string;
  messageID: string | undefined;
  toolCallId: string | undefined;
}

function parseUsage(info: Json): MessageUsage | undefined {
  const tokens = info.tokens;
  if (!isObject(tokens)) return undefined;
  const cache = isObject(tokens.cache) ? tokens.cache : {};
  const input = num(tokens.input) ?? 0;
  const output = num(tokens.output) ?? 0;
  const reasoning = num(tokens.reasoning) ?? 0;
  const cacheRead = num(cache.read) ?? 0;
  const cacheWrite = num(cache.write) ?? 0;
  return {
    cost: num(info.cost) ?? 0,
    // opencode stores input, output, reasoning and cache as disjoint parts (input excludes cache,
    // output excludes reasoning), so their sum is the total when it is absent.
    total: num(tokens.total) ?? input + output + reasoning + cacheRead + cacheWrite,
    input, output, reasoning, cacheRead, cacheWrite,
    model: str(info.modelID),
  };
}

function parseError(raw: unknown): SeenError | undefined {
  if (!isObject(raw)) return undefined;
  const data = isObject(raw.data) ? raw.data : {};
  return {
    name: str(raw.name) ?? 'UnknownError',
    message: (str(data.message) ?? str(raw.message) ?? '').slice(0, 500),
    status: num(data.statusCode),
    retryable: data.isRetryable === true,
  };
}

const isAuthError = (e: SeenError): boolean => e.name === 'ProviderAuthError' || e.status === 401 || AUTH_TEXT.test(e.message);
const isRateLimitError = (e: SeenError): boolean => e.status === 429 || (e.status === undefined && RATE_TEXT.test(e.message));

/** Every path check compares against the same set of shapes, so a patch entry is parsed once. */
interface PatchFile {
  filePath: string;
  type: 'add' | 'update' | 'delete' | 'move';
  movePath: string | undefined;
}

function parsePatchFiles(metadata: Json): PatchFile[] | undefined {
  if (!Array.isArray(metadata.files) || metadata.files.length === 0) return undefined;
  const files: PatchFile[] = [];
  for (const raw of metadata.files) {
    if (!isObject(raw)) return undefined;
    const filePath = str(raw.filePath);
    const type = raw.type;
    if (filePath === undefined || (type !== 'add' && type !== 'update' && type !== 'delete' && type !== 'move')) return undefined;
    const movePath = str(raw.movePath);
    if (type === 'move' && movePath === undefined) return undefined;
    files.push({ filePath, type, movePath });
  }
  return files;
}

const collapse = (s: string): string => s.trim().replace(/\s+/g, ' ');

/**
 * Build the `opencode` adapter. Every collaborator (`spawn`, `probe`,
 * `containment`, `sourceEnv`) is injectable so tests never start opencode.
 */
export function createOpenCodeHarnessAdapter(config: OpenCodeHarnessAdapterConfig): HarnessAdapter {
  const command = config.command ?? 'opencode';
  const sourceEnv = config.sourceEnv ?? process.env;
  const probe =
    config.probe ??
    (async (): Promise<BinaryProbe> => {
      const resolved = resolveExecutable(command, sourceEnv);
      return 'path' in resolved
        ? { present: true, detail: resolved.path }
        : { present: false, detail: resolved.error };
    });

  return {
    name: 'opencode',
    reportsUsage: true,
    // The station's `tools` list is the gate's allowlist, as for agent-sdk.
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
      // The instance directory is sent as a header and is not encoded, so a root a header cannot carry is refused.
      if (!/^[\x20-\x7e]+$/.test(config.projectRoot) || config.projectRoot.includes('%')) {
        fail(`project root '${config.projectRoot}' contains characters that cannot be sent verbatim in the x-opencode-directory header (non-printable or '%')`);
      }
      const canonicalRoot = resolveOwnedPath(resolve(config.projectRoot));

      const modelSpec = splitOpenCodeModel(call.model ?? config.model);
      if ('error' in modelSpec) fail(modelSpec.error);
      const auth = buildProviderAuthContent(sourceEnv, config.envAllowlist, modelSpec.providerID);
      if ('error' in auth) fail(auth.error);
      const spawnFn: OpenCodeSpawn = config.spawn ?? containedSpawn(config.containment ?? (await resolveContainment()), 'opencode');

      // Built before the dirs exist: nothing between their creation and the try below can throw.
      // Allowlisted OPENCODE_* names are dropped: OPENCODE_PERMISSION or OPENCODE_CONFIG would override the
      // ask-everything rules, and OPENCODE_SERVER_USERNAME would break the Basic auth below. The ones the
      // adapter needs are set explicitly.
      const baseEnv = Object.fromEntries(
        Object.entries(buildHarnessChildEnv(config.envAllowlist, sourceEnv)).filter(([k]) => !k.startsWith('OPENCODE_')),
      );
      const password = randomBytes(24).toString('hex');
      const dirs = createRunScopedOpenCodeDirs();
      const env: Record<string, string> = {
        ...baseEnv,
        PATH: baseEnv.PATH ?? sourceEnv.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        ...dirs.env,
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          permission: { '*': 'ask' }, mcp: {}, plugin: [], share: 'disabled', autoupdate: false,
        }),
        OPENCODE_DISABLE_PROJECT_CONFIG: '1',
        OPENCODE_DISABLE_CLAUDE_CODE: '1',
        OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
        OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
        OPENCODE_PURE: '1',
        OPENCODE_DISABLE_AUTOUPDATE: '1',
        OPENCODE_DISABLE_SHARE: '1',
        ...(auth.content !== undefined ? { OPENCODE_AUTH_CONTENT: auth.content } : {}),
      };
      const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;

      // Every throw from here on must remove the dirs, and the process must be dead first.
      let proc: OpenCodeProcess | undefined;
      const sseAbort = new AbortController();
      try {
        const emit = call.onEvent !== undefined ? createHarnessEventEmitter(call.onEvent) : undefined;
        const st: {
          base: string | undefined;
          rootId: string | undefined;
          held: { code: string; reason: string; toolName: string; sessionID: string; messageID: string | undefined; replied: boolean } | undefined;
          holdTimer: ReturnType<typeof setTimeout> | undefined;
          outputTail: string;
          timedOut: boolean;
          stalled: boolean;
          finished: boolean;
          aborting: boolean;
          rootIdle: boolean;
          pendingAsks: number;
          rateLimited: { message: string; resetAtMs: number | undefined } | undefined;
          exit: { code: number | undefined; signal: string | undefined } | undefined;
        } = {
          base: undefined, rootId: undefined, held: undefined, holdTimer: undefined, outputTail: '',
          timedOut: false, stalled: false, finished: false, aborting: false, rootIdle: false, pendingAsks: 0,
          rateLimited: undefined, exit: undefined,
        };
        const sessions = new Set<string>();
        const toolParts = new Map<string, ToolPart>();
        const partWaiters = new Map<string, Array<() => void>>();
        const usageByMessage = new Map<string, MessageUsage>();
        const errorMessages = new Set<string>();
        const errors: SeenError[] = [];
        const emittedInputs = new Set<string>();
        const emittedOutputs = new Set<string>();

        let resolveFinish!: (outcome: Outcome) => void;
        const finished = new Promise<Outcome>((r) => {
          resolveFinish = r;
        });
        // The first outcome wins, and events that arrive after it are ignored.
        const finish = (outcome: Outcome): void => {
          st.finished = true;
          resolveFinish(outcome);
        };
        const killAll = (): void => proc?.kill();

        let resolveListening!: (url: string) => void;
        const listening = new Promise<string>((r) => {
          resolveListening = r;
        });
        let resolveConnected!: () => void;
        const connected = new Promise<void>((r) => {
          resolveConnected = r;
        });

        // ---- HTTP ---------------------------------------------------------
        // The spike client sent this header on every request, so it is sent here. Whether the server needs it,
        // given that its cwd is the project root, was not isolated from the model's own variation. invoke()
        // has already refused a root that a header cannot carry verbatim.
        const directory = config.projectRoot;
        const headers = (): Record<string, string> => ({ authorization, 'content-type': 'application/json', 'x-opencode-directory': directory });
        const http = async (method: string, path: string, body?: unknown, timeoutMs = HTTP_TIMEOUT_MS): Promise<{ status: number; text: string }> => {
          const res = await fetch(`${st.base}${path}`, {
            method,
            headers: headers(),
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
            signal: AbortSignal.timeout(timeoutMs),
          });
          return { status: res.status, text: await res.text() };
        };
        const httpOk = async (method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> => {
          const res = await http(method, path, body);
          if (res.status < 200 || res.status >= 300) {
            throw new HttpError(res.status, `opencode answered ${method} ${path.replace(/\/[^/]*$/, '/…')} with HTTP ${res.status}: ${res.text.slice(0, ERROR_BODY_BYTES)}`);
          }
          return res;
        };

        // ---- the gate -----------------------------------------------------
        const agentIdFor = (sessionID: string): string | undefined => (sessionID !== st.rootId ? sessionID : undefined);

        const emitDecision = (toolCallId: string | undefined, toolName: string, sessionID: string | undefined, decision: GateDecision): void => {
          const agentId = sessionID !== undefined ? agentIdFor(sessionID) : undefined;
          emit?.({
            type: 'gate-decision',
            ...(toolCallId !== undefined ? { toolCallId } : {}),
            toolName,
            decision: decision.decision,
            ...(decision.decision !== 'allow' ? { code: decision.code, reason: sanitizeGateReason(decision.reason) } : {}),
            ...(agentId !== undefined ? { agentId } : {}),
          });
        };

        const abortSession = async (sessionID: string): Promise<void> => {
          try {
            await http('POST', `/session/${encodeURIComponent(sessionID)}/abort`, undefined, ABORT_TIMEOUT_MS);
          } catch {
            /* the process is killed next either way */
          }
        };
        /** Abort the sessions involved, then end the call with `outcome`. The abort is ours, not an error. */
        const abortThenFinish = async (outcome: Outcome, also?: string): Promise<void> => {
          if (st.finished || st.aborting) return;
          st.aborting = true;
          if (also !== undefined && also !== st.rootId) await abortSession(also);
          if (st.rootId !== undefined) await abortSession(st.rootId);
          finish(outcome);
        };

        const checkHoldReady = (): void => {
          const h = st.held;
          if (h === undefined || !h.replied || st.finished || st.aborting) return;
          const usage = h.messageID !== undefined ? usageByMessage.get(h.messageID) : undefined;
          if ((usage !== undefined && usage.total > 0) || st.rootIdle) void abortThenFinish({ kind: 'held' }, h.sessionID);
        };

        const beginHold = (decision: GateDecision & { decision: 'hold' }, toolName: string, ctx: AskContext): void => {
          st.held = {
            code: decision.code, reason: decision.reason, toolName, sessionID: ctx.sessionID,
            messageID: ctx.messageID, replied: false,
          };
          st.holdTimer = setTimeout(() => void abortThenFinish({ kind: 'held' }, ctx.sessionID), config.holdStopWaitMs ?? HOLD_STOP_WAIT_MS);
        };

        /** Ask the gate about one call. After the first hold nothing is asked. */
        const askGate = (toolCall: GateToolCall, ctx: AskContext): GateDecision => {
          const agentId = agentIdFor(ctx.sessionID);
          const withAgent: GateToolCall = { ...toolCall, ...(agentId !== undefined ? { agentId } : {}) };
          if (st.held !== undefined) {
            const later: GateDecision = { decision: 'deny', code: 'needs_human', reason: 'an earlier call was held for a human' };
            emitDecision(toolCall.toolCallId, toolCall.toolName, ctx.sessionID, later);
            return later;
          }
          const decision: GateDecision =
            call.gate !== undefined
              ? callGateFailClosed(call.gate, withAgent)
              : { decision: 'deny', code: 'gate_error', reason: 'no tool gate was supplied for this invocation' };
          emitDecision(toolCall.toolCallId, toolCall.toolName, ctx.sessionID, decision);
          if (decision.decision === 'hold') beginHold(decision, toolCall.toolName, ctx);
          return decision;
        };

        /** A deny the adapter reached without the gate. It is journaled like the gate's. */
        const denyDirect = (
          toolName: string,
          ctx: Pick<AskContext, 'sessionID' | 'toolCallId'>,
          code: 'malformed_input' | 'tool_not_allowed' | 'network_denied' | 'path_escape',
          reason: string,
        ): GateDecision => {
          const decision: GateDecision = { decision: 'deny', code, reason };
          emitDecision(ctx.toolCallId, toolName, ctx.sessionID, decision);
          return decision;
        };

        /** An adapter policy hold (a question). The gate is not consulted, so no gate can allow it. */
        const holdDirect = (toolName: string, ctx: AskContext): GateDecision => {
          if (st.held !== undefined) return askGate({ toolName, input: {} }, ctx);
          const decision = { decision: 'hold', code: 'needs_human', reason: 'the tool asks a human' } as const;
          emitDecision(ctx.toolCallId, toolName, ctx.sessionID, decision);
          beginHold(decision, toolName, ctx);
          return decision;
        };

        /** Combine the decisions for several calls: a hold beats a deny beats an allow. */
        const combine = (decisions: GateDecision[]): GateDecision => {
          if (decisions.length === 0) return { decision: 'deny', code: 'malformed_input', reason: 'the request named nothing to gate' };
          return (
            decisions.find((d) => d.decision === 'hold') ??
            decisions.find((d) => d.decision === 'deny') ??
            { decision: 'allow' }
          );
        };

        /** A path as an absolute path inside the project root, or undefined. */
        const confine = (raw: string): string | undefined => {
          if (raw.includes('\0')) return undefined;
          const abs = resolve(canonicalRoot, raw);
          return isContainedIn(resolveOwnedPath(abs), canonicalRoot) ? abs : undefined;
        };

        // ---- tool parts ---------------------------------------------------
        /** The output row for a settled call whose input row is out, once. Runs from both orders: part settles after the input, or before it. */
        const emitOutput = (callID: string): void => {
          const stored = toolParts.get(callID);
          if (stored === undefined || (stored.status !== 'completed' && stored.status !== 'error')) return;
          if (!emittedInputs.has(callID) || emittedOutputs.has(callID)) return;
          emittedOutputs.add(callID);
          const exit = num(stored.metadata.exit);
          const isError = stored.status === 'error' || (exit !== undefined && exit !== 0);
          emit?.({
            type: 'tool-output-available',
            toolCallId: callID,
            // The output body is not carried. A failed command's exit code is, in the form the journal reads.
            output: exit !== undefined && exit !== 0 ? `Exit code ${exit}` : '',
            isError,
          });
        };

        const recordToolPart = (part: Json): void => {
          const callID = str(part.callID);
          const state = isObject(part.state) ? part.state : undefined;
          if (callID === undefined || state === undefined) return;
          const status = str(state.status) ?? 'pending';
          toolParts.set(callID, {
            tool: str(part.tool) ?? '',
            status,
            input: isObject(state.input) ? state.input : {},
            metadata: isObject(state.metadata) ? state.metadata : {},
            sessionID: str(part.sessionID),
            messageID: str(part.messageID),
          });
          if (status !== 'pending') {
            const waiting = partWaiters.get(callID);
            partWaiters.delete(callID);
            waiting?.forEach((wake) => wake());
            emitOutput(callID);
          }
        };

        const partFor = (callID: string | undefined, sessionID: string, messageID: string | undefined): ToolPart | undefined => {
          if (callID === undefined) return undefined;
          const usable = (p: ToolPart | undefined): p is ToolPart =>
            p !== undefined && p.status !== 'pending' && p.sessionID === sessionID && (messageID === undefined || p.messageID === messageID);
          const known = toolParts.get(callID);
          return usable(known) ? known : undefined;
        };

        /** The tool part for an ask: already seen, arriving within the wait, or in the message re-fetched once. */
        const awaitToolPart = async (callID: string | undefined, sessionID: string, messageID: string | undefined): Promise<ToolPart | undefined> => {
          if (callID === undefined) return undefined;
          const now = partFor(callID, sessionID, messageID);
          if (now !== undefined) return now;
          await new Promise<void>((done) => {
            const wake = (): void => {
              clearTimeout(timer);
              done();
            };
            const timer = setTimeout(() => {
              // Drop this waiter so a timed-out wait does not linger for the call id.
              const left = (partWaiters.get(callID) ?? []).filter((w) => w !== wake);
              if (left.length === 0) partWaiters.delete(callID);
              else partWaiters.set(callID, left);
              done();
            }, config.toolPartWaitMs ?? TOOL_PART_WAIT_MS);
            const list = partWaiters.get(callID) ?? [];
            list.push(wake);
            partWaiters.set(callID, list);
          });
          const late = partFor(callID, sessionID, messageID);
          if (late !== undefined || messageID === undefined || st.finished) return late;
          try {
            const res = await http('GET', `/session/${encodeURIComponent(sessionID)}/message/${encodeURIComponent(messageID)}`);
            if (res.status === 200) {
              const body: unknown = JSON.parse(res.text);
              const parts = isObject(body) && Array.isArray(body.parts) ? body.parts : [];
              for (const p of parts) if (isObject(p) && p.type === 'tool' && str(p.callID) === callID) recordToolPart(p);
            }
          } catch {
            /* no part: the ask is rejected */
          }
          return partFor(callID, sessionID, messageID);
        };

        const emitInputs = (callID: string | undefined, calls: GateCall[]): void => {
          if (callID === undefined || emittedInputs.has(callID)) return;
          emittedInputs.add(callID);
          for (const c of calls) emit?.({ type: 'tool-input-available', toolCallId: callID, toolName: c.toolName, input: c.input });
          emitOutput(callID);
        };

        // ---- asks ---------------------------------------------------------
        const EDIT_TOOLS: Readonly<Record<string, 'Write' | 'Edit'>> = { write: 'Write', edit: 'Edit', multiedit: 'Edit' };
        const PATH_CATEGORIES: Readonly<Record<string, { toolName: string; tool: string; field: string; pathField: 'file_path' | 'path' }>> = {
          read: { toolName: 'Read', tool: 'read', field: 'filePath', pathField: 'file_path' },
          glob: { toolName: 'Glob', tool: 'glob', field: 'path', pathField: 'path' },
          grep: { toolName: 'Grep', tool: 'grep', field: 'path', pathField: 'path' },
          list: { toolName: 'Glob', tool: 'list', field: 'path', pathField: 'path' },
        };

        const decideAsk = async (p: Json): Promise<GateDecision> => {
          const sessionID = str(p.sessionID) ?? '';
          const category = str(p.permission) ?? 'unknown';
          const label = category.slice(0, 40);
          const tool = isObject(p.tool) ? p.tool : undefined;
          const toolCallId = str(tool?.callID);
          const messageID = str(tool?.messageID);
          const ctx: AskContext = { sessionID, messageID, toolCallId };
          const bad = (reason: string, code: 'malformed_input' | 'tool_not_allowed' | 'path_escape' = 'malformed_input'): GateDecision =>
            denyDirect(label, ctx, code, reason);

          if (!sessions.has(sessionID)) return bad('the ask comes from a session outside the invocation');
          if (!Array.isArray(p.patterns) || !p.patterns.every((x) => typeof x === 'string') || !isObject(p.metadata)) {
            return bad('the ask is malformed');
          }
          if (st.held !== undefined) return askGate({ toolName: label, input: {} }, ctx);
          const patterns = p.patterns as string[];
          const metadata = p.metadata;

          /** The tool part for this ask, or a deny. */
          const needPart = async (names: readonly string[]): Promise<ToolPart | GateDecision> => {
            const part = await awaitToolPart(toolCallId, sessionID, messageID);
            if (part === undefined) return bad('the tool call behind the ask was not seen');
            if (!names.includes(part.tool)) return bad(`the tool ${JSON.stringify(part.tool.slice(0, 40))} does not match the ask`, 'tool_not_allowed');
            return part;
          };
          const isDecision = (v: ToolPart | GateDecision): v is GateDecision => 'decision' in v;

          switch (category) {
            case 'bash': {
              const part = await needPart(['bash']);
              if (isDecision(part)) return part;
              const commandText = part.input.command;
              if (typeof commandText !== 'string') return denyDirect('Bash', ctx, 'malformed_input', 'the bash call has no command');
              const agreed =
                patterns.length === 1
                  ? collapse(patterns[0]!) === collapse(commandText)
                  : patterns.length > 1 && patterns.every((x) => commandText.includes(x));
              if (!agreed) return denyDirect('Bash', ctx, 'malformed_input', 'the ask does not match the bash command');
              const workdir = part.input.workdir;
              if (workdir !== undefined && workdir !== null && typeof workdir !== 'string') {
                return denyDirect('Bash', ctx, 'malformed_input', 'the bash workdir is not a string');
              }
              if (typeof workdir === 'string' && workdir !== '' && confine(workdir) === undefined) {
                return denyDirect('Bash', ctx, 'path_escape', 'the working directory is outside the project root');
              }
              emitInputs(toolCallId, [{ toolName: 'Bash', input: { command: commandText } }]);
              return askGate({ toolName: 'Bash', input: { command: commandText }, ...(toolCallId !== undefined ? { toolCallId } : {}) }, ctx);
            }
            case 'edit': {
              const part = await needPart(['write', 'edit', 'multiedit', 'apply_patch', 'patch']);
              if (isDecision(part)) return part;
              const calls: Array<GateCall & { path: string }> = [];
              const named = EDIT_TOOLS[part.tool];
              if (named !== undefined) {
                const raw = str(part.input.filePath);
                if (raw === undefined) return denyDirect(named, ctx, 'malformed_input', 'the edit has no path');
                const abs = confine(raw);
                if (abs === undefined) return denyDirect(named, ctx, 'path_escape', 'the path is outside the project root');
                const announced = str(metadata.filepath);
                if (announced !== undefined && resolve(canonicalRoot, announced) !== abs) {
                  return denyDirect(named, ctx, 'malformed_input', 'the ask names a different path than the tool call');
                }
                calls.push({ toolName: named, input: { file_path: abs }, path: abs });
              } else {
                const files = parsePatchFiles(metadata);
                if (files === undefined) return denyDirect('Edit', ctx, 'malformed_input', 'the patch names no usable files');
                for (const f of files) {
                  const abs = confine(f.filePath);
                  const dest = f.movePath !== undefined ? confine(f.movePath) : undefined;
                  if (abs === undefined || (f.movePath !== undefined && dest === undefined)) {
                    return denyDirect(f.type === 'update' || f.type === 'move' ? 'Edit' : 'Write', ctx, 'path_escape', 'a patched path is outside the project root');
                  }
                  if (f.type === 'add' || f.type === 'delete') calls.push({ toolName: 'Write', input: { file_path: abs }, path: abs });
                  else calls.push({ toolName: 'Edit', input: { file_path: abs }, path: abs });
                  if (f.type === 'move') calls.push({ toolName: 'Write', input: { file_path: dest! }, path: dest! });
                }
              }
              emitInputs(toolCallId, calls);
              return combine(
                calls.map((c) => askGate({ toolName: c.toolName, input: c.input, ...(toolCallId !== undefined ? { toolCallId } : {}) }, ctx)),
              );
            }
            case 'read':
            case 'glob':
            case 'grep':
            case 'list': {
              const spec = PATH_CATEGORIES[category]!;
              const part = await needPart([spec.tool]);
              if (isDecision(part)) return part;
              const raw = part.input[spec.field];
              if (raw !== undefined && raw !== null && typeof raw !== 'string') {
                return denyDirect(spec.toolName, ctx, 'malformed_input', 'the tool path is not a string');
              }
              if (category === 'read' && (raw === undefined || raw === '')) return denyDirect('Read', ctx, 'malformed_input', 'the read has no path');
              const abs = confine(typeof raw === 'string' ? raw : '');
              if (abs === undefined) return denyDirect(spec.toolName, ctx, 'path_escape', 'the path is outside the project root');
              const input: Json = { [spec.pathField]: abs };
              if (typeof part.input.pattern === 'string') input.pattern = part.input.pattern;
              emitInputs(toolCallId, [{ toolName: spec.toolName, input: { [spec.pathField]: abs } }]);
              return askGate({ toolName: spec.toolName, input, ...(toolCallId !== undefined ? { toolCallId } : {}) }, ctx);
            }
            case 'webfetch':
            case 'websearch':
            case 'codesearch': {
              // Network tools are denied by the gate whatever they carry, so no tool part is awaited.
              const toolName = category === 'webfetch' ? 'WebFetch' : 'WebSearch';
              emitInputs(toolCallId, [{ toolName, input: {} }]);
              return askGate({ toolName, input: category === 'webfetch' ? { url: patterns[0] ?? '' } : { query: patterns[0] ?? '' }, ...(toolCallId !== undefined ? { toolCallId } : {}) }, ctx);
            }
            case 'task':
              emitInputs(toolCallId, [{ toolName: 'Agent', input: {} }]);
              return askGate({ toolName: 'Agent', input: { subagent_type: patterns[0] ?? '' }, ...(toolCallId !== undefined ? { toolCallId } : {}) }, ctx);
            case 'todowrite':
              emitInputs(toolCallId, [{ toolName: 'TodoWrite', input: {} }]);
              return askGate({ toolName: 'TodoWrite', input: {}, ...(toolCallId !== undefined ? { toolCallId } : {}) }, ctx);
            case 'skill':
              emitInputs(toolCallId, [{ toolName: 'Skill', input: {} }]);
              return askGate({ toolName: 'Skill', input: { name: patterns[0] ?? '' }, ...(toolCallId !== undefined ? { toolCallId } : {}) }, ctx);
            case 'external_directory':
              // Never allowed: it is the route to files outside the project root.
              return bad('access outside the project root is not allowed', 'path_escape');
            case 'question':
              return holdDirect('AskUserQuestion', ctx);
            default:
              // lsp and doom_loop are refused on purpose. Any other name, an MCP tool included, was not verified.
              return bad(category === 'doom_loop' ? 'a repeated identical tool call is refused' : 'this tool category is not supported', 'tool_not_allowed');
          }
        };

        const sendReply = async (id: string, reply: Reply): Promise<void> => {
          if (st.finished) return;
          const res = await http('POST', `/permission/${encodeURIComponent(id)}/reply`, reply);
          // 404: the server already settled it, for instance when a rejection cancelled the session's other asks.
          if (res.status === 404) return;
          if (res.status < 200 || res.status >= 300) throw new HttpError(res.status, `opencode answered a permission reply with HTTP ${res.status}`);
        };

        const maybeComplete = (): void => {
          if (st.finished || !st.rootIdle) return;
          if (st.held !== undefined) {
            checkHoldReady();
            return;
          }
          if (st.pendingAsks === 0) finish({ kind: 'idle' });
        };

        const handleAsk = async (p: Json): Promise<void> => {
          const id = str(p.id);
          if (id === undefined) return;
          st.pendingAsks += 1;
          try {
            let decision: GateDecision;
            try {
              decision = await decideAsk(p);
            } catch {
              decision = { decision: 'deny', code: 'gate_error', reason: 'the adapter failed while inspecting the ask' };
            }
            await sendReply(
              id,
              decision.decision === 'allow'
                ? { reply: 'once' }
                : { reply: 'reject', message: `denied by conduit: ${sanitizeGateReason(decision.reason)}` },
            );
            if (decision.decision === 'hold' && st.held !== undefined) {
              st.held.replied = true;
              checkHoldReady();
            }
          } catch (err) {
            if (!st.finished) finish({ kind: 'rpc', message: err instanceof Error ? err.message : String(err) });
          } finally {
            st.pendingAsks -= 1;
            maybeComplete();
          }
        };

        const handleQuestion = async (p: Json): Promise<void> => {
          const id = str(p.id);
          if (id === undefined) return;
          const sessionID = str(p.sessionID) ?? st.rootId ?? '';
          const tool = isObject(p.tool) ? p.tool : undefined;
          // Only the handler that began the hold may mark it replied. A later question gets a deny.
          const beganHold = st.held === undefined;
          holdDirect('AskUserQuestion', { sessionID, messageID: str(tool?.messageID), toolCallId: str(tool?.callID) });
          try {
            if (!st.finished) await http('POST', `/question/${encodeURIComponent(id)}/reject`);
          } catch {
            /* the hold proceeds either way */
          }
          if (beganHold && st.held !== undefined) {
            st.held.replied = true;
            checkHoldReady();
          }
        };

        // ---- events -------------------------------------------------------
        const recordError = (raw: unknown, sessionID: string | undefined, messageId?: string): void => {
          const parsed = parseError(raw);
          if (parsed === undefined) return;
          const e: SeenError = sessionID !== undefined ? { ...parsed, sessionID } : parsed;
          if (e.name === 'MessageAbortedError' && st.aborting) return;
          if (messageId !== undefined) {
            if (errorMessages.has(messageId)) return;
            errorMessages.add(messageId);
          }
          errors.push(e);
        };

        const handleRetry = (status: Json, sessionID: string): void => {
          const message = str(status.message) ?? '';
          if (!RATE_TEXT.test(message) || st.finished || st.aborting) return;
          const next = num(status.next);
          const resetAtMs = next !== undefined && next > Date.now() ? next : undefined;
          st.rateLimited = { message: message.slice(0, 200), resetAtMs };
          void abortThenFinish({ kind: 'rate-limit', message: st.rateLimited.message, resetAtMs }, sessionID);
        };

        const handleEvent = (type: string, props: Json): void => {
          switch (type) {
            case 'server.connected':
              resolveConnected();
              break;
            case 'session.created': {
              const info = isObject(props.info) ? props.info : {};
              const id = str(info.id) ?? str(props.sessionID);
              const parent = str(info.parentID);
              if (id !== undefined && parent !== undefined && sessions.has(parent)) sessions.add(id);
              break;
            }
            case 'message.updated': {
              const info = isObject(props.info) ? props.info : undefined;
              const sessionID = str(info?.sessionID) ?? str(props.sessionID);
              if (info === undefined || sessionID === undefined || !sessions.has(sessionID) || info.role !== 'assistant') break;
              const id = str(info.id);
              if (id === undefined) break;
              const usage = parseUsage(info);
              if (usage !== undefined) usageByMessage.set(id, usage);
              if (info.error !== undefined) recordError(info.error, sessionID, id);
              checkHoldReady();
              break;
            }
            case 'message.part.updated': {
              const part = isObject(props.part) ? props.part : undefined;
              if (part !== undefined && part.type === 'tool') recordToolPart(part);
              break;
            }
            case 'permission.asked':
              void handleAsk(props);
              break;
            case 'question.asked':
              void handleQuestion(props);
              break;
            case 'session.status': {
              const sessionID = str(props.sessionID);
              const status = isObject(props.status) ? props.status : {};
              if (sessionID === undefined || !sessions.has(sessionID)) break;
              if (status.type === 'idle' && sessionID === st.rootId) {
                st.rootIdle = true;
                maybeComplete();
              } else if (status.type === 'retry') {
                handleRetry(status, sessionID);
              }
              break;
            }
            case 'session.idle':
              if (str(props.sessionID) === st.rootId) {
                st.rootIdle = true;
                maybeComplete();
              }
              break;
            case 'session.error': {
              const sessionID = str(props.sessionID);
              if (sessionID === undefined || sessions.has(sessionID)) recordError(props.error, sessionID);
              break;
            }
            default:
              break;
          }
        };

        // ---- timers -------------------------------------------------------
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
            st.stalled = true;
            killAll();
            finish({ kind: 'stalled' });
          }, call.idleTimeoutMs);
        };
        resetIdleTimer();

        // ---- the event stream ---------------------------------------------
        const pump = async (body: ReadableStream<Uint8Array>): Promise<void> => {
          const decoder = new TextDecoder();
          let buffer = '';
          const reader = body.getReader();
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
              let end = buffer.indexOf('\n\n');
              while (end >= 0) {
                const raw = buffer.slice(0, end);
                buffer = buffer.slice(end + 2);
                end = buffer.indexOf('\n\n');
                const data = raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
                if (data === '' || st.finished) continue;
                let event: unknown;
                try {
                  event = JSON.parse(data);
                } catch {
                  continue;
                }
                if (!isObject(event) || typeof event.type !== 'string') continue;
                // A heartbeat proves the server is up, not that the model is working, so it is not activity.
                if (event.type !== 'server.heartbeat') {
                  call.onProgress?.();
                  resetIdleTimer();
                }
                try {
                  handleEvent(event.type, isObject(event.properties) ? event.properties : {});
                } catch {
                  /* a malformed event cannot fail a billed call */
                }
              }
            }
          } catch {
            /* an abort or a dropped connection ends the stream */
          }
          if (!st.finished) setTimeout(() => finish({ kind: 'exit' }), STREAM_END_GRACE_MS);
        };

        const handlers: OpenCodeProcessHandlers = {
          onLine: (line) => {
            st.outputTail = (st.outputTail + line + '\n').slice(-OUTPUT_TAIL_BYTES);
            const m = LISTENING.exec(line);
            if (m !== null) resolveListening(m[1]!);
          },
          onStderr: (text) => {
            st.outputTail = (st.outputTail + text).slice(-OUTPUT_TAIL_BYTES);
            const m = LISTENING.exec(text);
            if (m !== null) resolveListening(m[1]!);
          },
          onExit: (code, signal) => {
            st.exit = { code, signal };
            // Events the server sent before it died may still be unread: give the stream a moment to drain.
            setTimeout(() => finish({ kind: 'exit' }), STREAM_END_GRACE_MS);
          },
        };

        // ---- the run ------------------------------------------------------
        const STOP = Symbol('stop');
        const untilFinished = finished.then(() => STOP);
        const or = async <T>(p: Promise<T>): Promise<T> => {
          const r = await Promise.race([p, untilFinished]);
          if (r === STOP) throw STOP;
          return r as T;
        };
        const drive = async (): Promise<void> => {
          const url = new URL(await or(listening));
          if (url.hostname !== '127.0.0.1') fail(`the server reported ${url.origin}, which is not a loopback address`);
          st.base = url.origin;

          const stream = await or(
            fetch(`${st.base}/event`, { headers: headers(), signal: sseAbort.signal }),
          );
          if (!stream.ok || stream.body === null) throw new HttpError(stream.status, `the event stream answered HTTP ${stream.status}`);
          void pump(stream.body);
          let waitTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            await or(
              Promise.race([
                connected,
                new Promise<never>((_, rej) => {
                  waitTimer = setTimeout(() => rej(new Error('the event stream sent no server.connected event')), CONNECT_WAIT_MS);
                }),
              ]),
            );
          } finally {
            clearTimeout(waitTimer);
          }

          const created = await or(httpOk('POST', '/session', { title: 'conduit' }));
          const body: unknown = JSON.parse(created.text);
          const rootId = isObject(body) ? str(body.id) : undefined;
          if (rootId === undefined) throw new Error('POST /session returned no session id');
          st.rootId = rootId;
          sessions.add(rootId);
          await or(
            httpOk('POST', `/session/${encodeURIComponent(rootId)}/prompt_async`, {
              model: { providerID: modelSpec.providerID, modelID: modelSpec.modelID },
              parts: [{ type: 'text', text: call.prompt }],
            }),
          );
        };

        emit?.({ type: 'lifecycle', phase: 'start' });
        let outcome: Outcome;
        try {
          proc = spawnFn({ command: executable, args: [...OPENCODE_SERVE_ARGS], cwd: config.projectRoot, env }, handlers);
          drive().catch((err) => {
            if (err === STOP) return;
            finish({ kind: 'rpc', message: err instanceof Error ? err.message : String(err) });
          });
          outcome = await finished;
        } finally {
          st.finished = true;
          clearTimeout(timer);
          if (st.holdTimer !== undefined) clearTimeout(st.holdTimer);
          if (idleTimer !== undefined) clearTimeout(idleTimer);
          sseAbort.abort();
          // The call has ended or is being ended. A command it started may still run: end the group and
          // the cgroup before waiting, as the runner does on every exit path (#17).
          if (proc !== undefined) {
            proc.kill();
            await proc.close();
          }
        }

        // ---- usage --------------------------------------------------------
        const buildUsage = (): KnownUsage | undefined => {
          if (usageByMessage.size === 0) return undefined;
          let tokens = 0, cost = 0, input = 0, output = 0, cacheRead = 0, cacheWrite = 0;
          let model: string | undefined;
          for (const u of usageByMessage.values()) {
            tokens += u.total;
            cost += u.cost;
            input += u.input;
            // opencode reports reasoning apart from output. outputTokens follows the claude and codex
            // adapters, where output includes reasoning.
            output += u.output + u.reasoning;
            cacheRead += u.cacheRead;
            cacheWrite += u.cacheWrite;
            model = u.model ?? model;
          }
          return {
            tokens,
            // What opencode reports. A provider or model it has no price for reports 0.
            cost,
            breakdown: { inputTokens: input, outputTokens: output, cacheReadInputTokens: cacheRead, cacheCreationInputTokens: cacheWrite },
            ...(model !== undefined ? { model } : {}),
          };
        };
        const usage = buildUsage();
        const withUsage = usage !== undefined ? { usage } : undefined;

        if (usage !== undefined) {
          emit?.({ type: 'usage', tokens: usage.tokens, breakdown: usage.breakdown!, costUsd: usage.cost });
        }
        if (outcome.kind === 'rate-limit') emit?.({ type: 'rate-limit', status: 'rate_limited', windows: [] });
        const sessionEnded = outcome.kind === 'idle';
        const exitCode = st.exit?.code;
        emit?.(
          st.stalled && !sessionEnded
            ? { type: 'lifecycle', phase: 'idle-timeout' }
            : st.timedOut && !sessionEnded
              ? { type: 'lifecycle', phase: 'timeout' }
              : { type: 'lifecycle', phase: 'end', ...(exitCode !== undefined ? { exitCode } : {}) },
        );

        // A hold wins over everything: a human is asked, and what was reported is still billed.
        if (st.held !== undefined) {
          fail(
            `the tool gate held the card on ${st.held.toolName} (${st.held.code}): ${sanitizeGateReason(st.held.reason)}`,
            HARNESS_GATE_HOLD_CODE,
            withUsage,
          );
        }
        if (outcome.kind === 'stalled') {
          fail('invocation produced no event for longer than the idle timeout and was killed', 'harness-idle-timeout', withUsage);
        }
        if (outcome.kind === 'timeout') {
          fail('invocation exceeded its timeout and was killed', 'harness-timeout', withUsage);
        }
        if (outcome.kind === 'rate-limit') {
          fail(`provider rate limit: ${outcome.message}`, 'harness-rate-limited', {
            ...(outcome.resetAtMs !== undefined ? { resetAtMs: outcome.resetAtMs } : {}),
            ...(usage !== undefined ? { usage } : {}),
          });
        }

        // A subagent's failure comes back to the root as a tool result, so on idle only the root's errors
        // (and errors naming no session, which fail closed) decide the call.
        const decisive =
          outcome.kind === 'idle' ? errors.filter((e) => e.sessionID === undefined || e.sessionID === st.rootId) : errors;
        const finalError = decisive.length > 0 ? decisive[decisive.length - 1] : undefined;
        if (outcome.kind === 'idle' && finalError === undefined) {
          return { outputs: [], usage: usage ?? { unknown: true } };
        }

        if (finalError !== undefined && isAuthError(finalError) === false && isRateLimitError(finalError)) {
          fail(`provider rate limit: ${finalError.message || finalError.name}`, 'harness-rate-limited', {
            ...(usage !== undefined ? { usage } : {}),
          });
        }
        // Authentication uses the nonzero-exit class the executor already handles: retrying will not help.
        const tail = st.outputTail.trim();
        const detail =
          outcome.kind === 'rpc'
            ? outcome.message
            : finalError !== undefined
              ? `${finalError.name}${finalError.message !== '' ? `: ${finalError.message}` : ''}`
              : st.exit?.signal !== undefined
                ? `the opencode server exited with signal ${st.exit.signal} before the session went idle`
                : `the opencode server exited${exitCode !== undefined ? ` with code ${exitCode}` : ''} before the session went idle`;
        fail(
          finalError !== undefined && isAuthError(finalError)
            ? `authentication failed: ${finalError.message || finalError.name}`
            : `${detail}${outcome.kind === 'exit' && tail !== '' ? `: ${tail.slice(-300)}` : ''}`,
          'harness-nonzero-exit',
          withUsage,
        );
      } finally {
        removeRunScopedOpenCodeDirs(dirs);
      }
    },
  };
}
