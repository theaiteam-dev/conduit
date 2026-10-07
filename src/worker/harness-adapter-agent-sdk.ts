/**
 * agent-sdk harness adapter (issue #21).
 *
 * Runs the Claude Code CLI through `@anthropic-ai/claude-agent-sdk` `query()`
 * so the kernel can decide every tool call before it runs. The decision is the
 * per-invocation `HarnessInvocation.gate`, called from a `hooks.PreToolUse`
 * callback through `callGateFailClosed`. The hook fires for the main agent and
 * for subagents, and an `allowedTools` rule does not bypass it. A hook denial
 * does not appear in `result.permission_denials`, so this adapter emits its own
 * `gate-decision` event for every call the gate sees.
 *
 * The loop stays the CLI's own. This is a pre-execution decision on each call,
 * not the Law-grade Tool-Bridge (SPEC §7, step 9b).
 *
 * Other PreToolUse hooks (plugin hooks, agent frontmatter hooks) run beside the
 * gate's, and one that returns `updatedInput` replaces the input after the gate
 * approved it. The gate cannot prevent that: the hook that answers last wins.
 * The adapter detects it instead. It records the input the gate approved per
 * `tool_use_id`, and its `PostToolUse` and `PostToolUseFailure` hooks compare
 * the input that ran with it. A mismatch is journaled as a `gate-decision`
 * hold with code `input_rewritten` and ends the call as a gate hold does. The
 * rewritten call has already run, so this is a backstop like the MARK_DONE
 * integrity check (issue #109).
 *
 * Process ownership. The SDK would spawn the CLI itself and kill only the
 * immediate child. `spawnClaudeCodeProcess` hands the spawn back to this
 * adapter, which starts the CLI detached (its own session and process group),
 * inside its own cgroup where the host allows it, registers it with
 * `trackProcessGroup`, and ends it with the same `killContained` the harness
 * runner uses. That reaches a descendant that called `setsid()`, as every
 * Claude Code Bash-tool command does (issue #77).
 *
 * `Options.env` is not merged with `process.env`: the SDK passes the spawn hook
 * exactly the env given plus three of its own variables, so the whole
 * allowlisted env is built here, as the claude-headless adapter builds it.
 *
 * Named agents and plugin dirs (issue #109). The station's agent (or the
 * adapter default) goes to the SDK as `agent` and the engine-config plugin dirs
 * as `plugins`, which the SDK passes to the CLI as `--agent` and `--plugin-dir`,
 * the flags claude-headless passes. `resolveAgentDefinition` hashes the same
 * definition file claude-headless hashes. On this path an agent the CLI cannot
 * find does not fail: the CLI runs its default agent and reports success. So
 * the adapter checks that the CLI loaded the requested agent, on two signals:
 * every `system`/`init` message must list it in `agents`, and every main-thread
 * tool call (no `agent_id`) must carry it as `agent_type`. A miss ends the call
 * with `HARNESS_GATE_HOLD_CODE`, and the executor holds the card, as it does
 * when it cannot resolve the agent at dispatch.
 *
 * Not implemented here: session resume. Every invocation is a fresh session.
 */

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import type { HookCallback, Options, SDKMessage, SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import type {
  HarnessAdapter, HarnessInvocation, HarnessResult, BinaryProbe, RateLimitSnapshot, RateLimitWindow,
} from './harness-adapter';
import {
  assertUsablePluginDirs, buildKnownUsage, bindingResetAtMs, isRateLimited, type ClaudeResultPayload,
} from './harness-adapter-claude';
import { createHarnessEventEmitter } from './harness-events';
import { mapClaudeStreamMessage, rateLimitWindowsFromInfo, type ClaudeRateLimitInfo } from './harness-events-claude';
import { HARNESS_GATE_HOLD_CODE, callGateFailClosed, type GateDecision } from './harness-gate';
import { buildHarnessChildEnv } from './harness-runner';
import { resolveClaudePluginAgent } from './claude-plugin-agents';
import { createRunScopedClaudeConfigDir, removeRunScopedClaudeConfigDir } from './claude-config-isolation';
import { killContained, trackProcessGroup, untrackProcessGroup } from './process-group';
import { prepareContainedCommand, removeCgroup, resolveContainment, type Containment } from './cgroup-containment';
import { existsSync, statSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { resolveExecutable } from './harness-contained-spawn';

/** The part of the SDK's `Query` this adapter uses. */
export type AgentSdkQuery = AsyncIterable<SDKMessage> & { close?(): void };

/** The SDK's `query()` as this adapter calls it. Injected by tests. */
export type AgentSdkQueryFn = (params: { prompt: string; options: Options }) => AgentSdkQuery;

export interface AgentSdkHarnessAdapterConfig {
  /** Absolute project root: the CLI's cwd. */
  projectRoot: string;
  /** Env var names visible to the child (NFR-Security-2), sourced from engine config. */
  envAllowlist: string[];
  /** Claude Code binary. Defaults to `claude`, resolved on PATH. A path is used as given. */
  command?: string;
  /** Default model. A station's own model wins. */
  model?: string;
  /** Default named agent, `<plugin>:<agent>` (issue #109). A station's own agent wins. */
  agent?: string;
  /**
   * Absolute plugin directories, passed to the SDK as local plugins (issue
   * #109). Each must be an existing directory, as for claude-headless.
   */
  pluginDirs?: string[];
  /**
   * Point the child at a run-scoped CLAUDE_CONFIG_DIR holding only a link to
   * the operator's credentials (issue #29). Off by default.
   */
  isolateConfig?: boolean;
  /** Kernel env used to resolve the allowlist, PATH lookup and credentials. Defaults to process.env. */
  sourceEnv?: Record<string, string | undefined>;
  /** Injected `query()`, for tests. Defaults to the SDK's, imported on first use. */
  query?: AgentSdkQueryFn;
  /** Injected binary-presence probe, for tests. */
  probe?: () => Promise<BinaryProbe>;
  /** Wait after a gate hold for the CLI to emit its result before it is killed, in ms. For tests; defaults to HOLD_STOP_WAIT_MS. */
  holdStopWaitMs?: number;
  /** Injected containment mechanism, for tests. Defaults to the process-wide detection. */
  containment?: Containment;
}

/** Longest wait for the killed CLI's `exit` event before the adapter gives up on it. */
const EXIT_WAIT_MS = 5_000;
/**
 * Longest wait, after a gate hold, for the CLI to stop by itself and emit its result message. Measured
 * live at about 15 ms with `continue: false`; after this the process is killed as on a timeout.
 */
const HOLD_STOP_WAIT_MS = 5_000;
/** `gate-decision` code journaled when a main-thread call shows the CLI did not load the requested agent. */
const AGENT_NOT_LOADED = 'agent_not_loaded';
/** Bytes of the child's stderr kept for rate-limit detection and error detail. */
const STDERR_TAIL_BYTES = 2_000;

function fail(reason: string, code?: string, detail?: Record<string, unknown>): never {
  throw Object.assign(new Error(`agent-sdk: ${reason}`), code !== undefined ? { code } : {}, detail ?? {});
}

interface ActiveChild {
  pid: number;
  cgroup: string | undefined;
  exited: Promise<number | undefined>;
}

/**
 * Build the `agent-sdk` adapter. Every collaborator (`query`, `probe`,
 * `containment`, `sourceEnv`) is injectable so tests never call the API.
 */
export function createAgentSdkHarnessAdapter(config: AgentSdkHarnessAdapterConfig): HarnessAdapter {
  const command = config.command ?? 'claude';
  const sourceEnv = config.sourceEnv ?? process.env;
  const pluginDirs = config.pluginDirs ?? [];
  assertUsablePluginDirs(pluginDirs, 'agent-sdk');
  const probe =
    config.probe ??
    (async (): Promise<BinaryProbe> => {
      const resolved = resolveExecutable(command, sourceEnv);
      return 'path' in resolved
        ? { present: true, detail: resolved.path }
        : { present: false, detail: resolved.error };
    });

  return {
    name: 'agent-sdk',
    reportsUsage: true,
    canRestrictTools: true,
    canGatePerCall: true,
    model: config.model,
    agent: config.agent,

    resolveAgentDefinition(agent: string) {
      return resolveClaudePluginAgent(pluginDirs, agent);
    },

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
      const queryFn: AgentSdkQueryFn = config.query ?? (await import('@anthropic-ai/claude-agent-sdk')).query;
      const containment = config.containment ?? (await resolveContainment());
      const model = call.model ?? config.model;
      // Station wins over the adapter's configured default, as for the model.
      const agent = call.agent ?? config.agent;

      // Built before the dir exists: nothing between the dir's creation and the try below can throw.
      const baseEnv = buildHarnessChildEnv(config.envAllowlist, sourceEnv);
      // Throws before anything is spawned when the child could not authenticate.
      const configDir =
        config.isolateConfig === true ? createRunScopedClaudeConfigDir(sourceEnv, config.envAllowlist) : undefined;
      const env: Record<string, string> = {
        ...baseEnv,
        ...(configDir !== undefined ? { CLAUDE_CONFIG_DIR: configDir } : {}),
      };

      // Every throw from here on, including one while building the options, must remove the dir.
      try {
        const emit = call.onEvent !== undefined ? createHarnessEventEmitter(call.onEvent) : undefined;
        const abortController = new AbortController();
        // Mutated from callbacks, so held in an object: a bare `let` would be narrowed to its initial value.
        const st: {
          children: ActiveChild[];
          held: { code: string; reason: string; toolName: string } | undefined;
          /** Why the CLI is known not to run the requested agent. Set once; ends the call. */
          agentNotLoaded: string | undefined;
          holdTimer: ReturnType<typeof setTimeout> | undefined;
          stderrTail: string;
          timedOut: boolean;
          idledOut: boolean;
          finished: boolean;
        } = { children: [], held: undefined, agentNotLoaded: undefined, holdTimer: undefined, stderrTail: '', timedOut: false, idledOut: false, finished: false };
        const killAll = (): void => {
          for (const child of st.children) killContained(child.pid, child.cgroup);
        };

        const spawnClaudeCodeProcess = (opts: SpawnOptions): SpawnedProcess => {
          const childEnv: Record<string, string> = {};
          for (const [name, value] of Object.entries(opts.env)) if (value !== undefined) childEnv[name] = value;
          const contained = prepareContainedCommand(containment, [opts.command, ...opts.args], {
            ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
            env: childEnv,
          });
          let child: ChildProcess;
          try {
            child = nodeSpawn(contained.argv[0]!, contained.argv.slice(1), {
              ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
              env: childEnv,
              // setsid(): the CLI leads its own session and group, so its pid addresses the whole group.
              detached: true,
              stdio: ['pipe', 'pipe', 'pipe'],
            });
          } catch (err) {
            if (contained.cgroup !== undefined) void removeCgroup(contained.cgroup);
            throw err;
          }
          if (child.pid === undefined) {
            if (contained.cgroup !== undefined) void removeCgroup(contained.cgroup);
            throw new Error(`agent-sdk: failed to spawn '${opts.command}'`);
          }
          const pid = child.pid;
          trackProcessGroup(pid, contained.cgroup);
          const exited = new Promise<number | undefined>((resolve) => {
            child.once('exit', (code) => resolve(code ?? undefined));
            child.once('error', () => resolve(undefined));
          });
          st.children.push({ pid, cgroup: contained.cgroup, exited });
          child.stderr?.on('data', (chunk: Buffer) => {
            st.stderrTail = (st.stderrTail + chunk.toString('utf-8')).slice(-STDERR_TAIL_BYTES);
          });
          // The SDK's own signal fires after its stdin-EOF grace; the kill is what ends the tree. The SDK
          // may spawn more than once per invocation, so it ends every child, not only this one.
          opts.signal.addEventListener('abort', killAll, { once: true });
          // A signal that aborted before this spawn never fires the listener, so end the child now.
          if (opts.signal.aborted) killAll();
          return child as unknown as SpawnedProcess;
        };

        // The gate. Absent, every call is denied: an adapter that can gate must never run ungated.
        // After the first hold every later call is denied without asking the gate, so nothing the model
        // does while the CLI stops can run.
        const deny = (reason: string) => ({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'deny' as const,
            permissionDecisionReason: reason,
          },
        });
        // Stop the CLI gracefully so it still emits its result message, which carries the call's
        // usage and cost. If it has not ended by itself after HOLD_STOP_WAIT_MS, kill it.
        const stopAfterHold = (): void => {
          if (st.holdTimer !== undefined) return;
          st.holdTimer = setTimeout(() => {
            abortController.abort();
            killAll();
          }, config.holdStopWaitMs ?? HOLD_STOP_WAIT_MS);
        };
        // The input the gate allowed, per tool_use_id, until the call's post event compares it.
        const approvedInputs = new Map<string, unknown>();
        // The first hold wins.
        const startHold = (held: { code: string; reason: string; toolName: string }): void => {
          if (st.held !== undefined) return;
          st.held = held;
          stopAfterHold();
        };
        const preToolUse: HookCallback = async (input, toolUseId) => {
          if (input.hook_event_name !== 'PreToolUse') return { continue: true };
          const toolCallId = toolUseId ?? input.tool_use_id;
          const emitDecision = (decision: GateDecision | { decision: 'deny'; code: string; reason: string }): void =>
            emit?.({
              type: 'gate-decision',
              toolCallId,
              toolName: input.tool_name,
              decision: decision.decision === 'hold' ? 'deny' : decision.decision,
              ...(decision.decision !== 'allow' ? { code: decision.code, reason: decision.reason } : {}),
              ...(input.agent_id !== undefined ? { agentId: input.agent_id } : {}),
            });
          if (st.held !== undefined || st.agentNotLoaded !== undefined) {
            // AGENT_NOT_LOADED is the adapter's own code, outside the gate's GateDenyCode set.
            const later: { decision: 'deny'; code: string; reason: string } =
              st.held !== undefined
                ? { decision: 'deny', code: 'needs_human', reason: 'an earlier call was held for a human' }
                : { decision: 'deny', code: AGENT_NOT_LOADED, reason: 'an earlier call showed the CLI did not load the requested agent' };
            emitDecision(later);
            return deny(later.reason);
          }
          // A main-thread call of a session started with an agent carries that agent as `agent_type`. One
          // without it, or with another, means the CLI ran a different agent than the one the kernel hashed.
          if (agent !== undefined && input.agent_id === undefined && input.agent_type !== agent) {
            const reason =
              input.agent_type === undefined
                ? `main-thread ${input.tool_name} call carries no agent_type`
                : `main-thread ${input.tool_name} call runs as agent '${input.agent_type}'`;
            st.agentNotLoaded = reason;
            emit?.({
              type: 'gate-decision',
              toolCallId,
              toolName: input.tool_name,
              decision: 'hold',
              code: AGENT_NOT_LOADED,
              reason: `the CLI did not load agent '${agent}': ${reason}`,
            });
            stopAfterHold();
            return { continue: false, stopReason: reason, ...deny(`the CLI did not load agent '${agent}'`) };
          }
          const decision: GateDecision =
            call.gate !== undefined
              ? callGateFailClosed(call.gate, {
                  toolName: input.tool_name,
                  input: input.tool_input,
                  toolCallId,
                  ...(input.agent_id !== undefined ? { agentId: input.agent_id } : {}),
                  ...(input.agent_type !== undefined ? { agentType: input.agent_type } : {}),
                })
              : { decision: 'deny', code: 'gate_error', reason: 'no tool gate was supplied for this invocation' };
          if (decision.decision === 'hold') {
            // The hold itself is journaled as a hold, not the deny the model sees.
            emit?.({
              type: 'gate-decision',
              toolCallId,
              toolName: input.tool_name,
              decision: 'hold',
              code: decision.code,
              reason: decision.reason,
              ...(input.agent_id !== undefined ? { agentId: input.agent_id } : {}),
            });
          } else {
            emitDecision(decision);
          }
          // Allow returns no permissionDecision, so the SDK's normal permission flow continues and
          // `allowedTools` decides. Returning 'allow' here would grant what no rule granted.
          if (decision.decision === 'allow') {
            if (toolCallId !== undefined) approvedInputs.set(toolCallId, input.tool_input);
            return { continue: true };
          }
          if (decision.decision === 'hold') {
            startHold({ code: decision.code, reason: decision.reason, toolName: input.tool_name });
            return { continue: false, stopReason: decision.reason, ...deny(decision.reason) };
          }
          return deny(decision.reason);
        };

        // The rewrite check. A call the gate did not allow, or one that never reports a post event,
        // is not compared.
        const postToolUse: HookCallback = async (input, toolUseId) => {
          if (input.hook_event_name !== 'PostToolUse' && input.hook_event_name !== 'PostToolUseFailure') {
            return { continue: true };
          }
          const toolCallId = toolUseId ?? input.tool_use_id;
          if (toolCallId === undefined || !approvedInputs.has(toolCallId)) return { continue: true };
          const approved = approvedInputs.get(toolCallId);
          approvedInputs.delete(toolCallId);
          if (isDeepStrictEqual(approved, input.tool_input)) return { continue: true };
          const reason = 'another PreToolUse hook changed the input the gate approved, and the changed call ran';
          emit?.({
            type: 'gate-decision',
            toolCallId,
            toolName: input.tool_name,
            decision: 'hold',
            code: 'input_rewritten',
            reason,
            ...(input.agent_id !== undefined ? { agentId: input.agent_id } : {}),
          });
          startHold({ code: 'input_rewritten', reason, toolName: input.tool_name });
          return { continue: false, stopReason: reason };
        };

        const options: Options = {
          cwd: config.projectRoot,
          env,
          pathToClaudeCodeExecutable: executable,
          settingSources: [],
          permissionMode: 'default',
          abortController,
          spawnClaudeCodeProcess,
          hooks: {
            PreToolUse: [{ hooks: [preToolUse] }],
            PostToolUse: [{ hooks: [postToolUse] }],
            PostToolUseFailure: [{ hooks: [postToolUse] }],
          },
          // Defence in depth: the gate is the enforcement. Empty tools is the executor's encoding of a
          // waived `unrestricted_tools` station and passes no narrowing.
          ...(call.tools.length > 0 ? { allowedTools: call.tools } : {}),
          ...(model !== undefined ? { model } : {}),
          ...(agent !== undefined ? { agent } : {}),
          ...(pluginDirs.length > 0 ? { plugins: pluginDirs.map((path) => ({ type: 'local' as const, path })) } : {}),
        };

        // Stream state.
        let result: ClaudeResultPayload | null = null;
        let assistantError: string | undefined;
        const windowsByName = new Map<string, RateLimitWindow>();
        let rateLimitStatus: string | undefined;
        let rateLimitOverage: boolean | undefined;
        let sawRateLimit = false;
        const rateLimitSnapshot = (): RateLimitSnapshot | undefined =>
          sawRateLimit
            ? {
                ...(rateLimitStatus !== undefined ? { status: rateLimitStatus } : {}),
                ...(rateLimitOverage !== undefined ? { usingOverage: rateLimitOverage } : {}),
                windows: [...windowsByName.values()],
              }
            : undefined;

        // Timers, as in runHarnessProcess: wall-clock, plus an idle bound reset by every message.
        const timer = setTimeout(() => {
          st.timedOut = true;
          killAll();
          abortController.abort();
        }, call.timeoutMs);
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        const resetIdleTimer = (): void => {
          if (call.idleTimeoutMs === undefined || st.finished) return;
          if (idleTimer !== undefined) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            if (st.timedOut) return;
            st.idledOut = true;
            killAll();
            abortController.abort();
          }, call.idleTimeoutMs);
        };
        resetIdleTimer();

        emit?.({ type: 'lifecycle', phase: 'start' });
        let iteratorError: unknown;
        let stream: AgentSdkQuery | undefined;
        let exitCode: number | undefined;
        try {
          stream = queryFn({ prompt: call.prompt, options });
          let index = 0;
          let sawInit = false;
          for await (const message of stream) {
            call.onProgress?.();
            resetIdleTimer();
            const m = message as unknown as Record<string, unknown>;
            // The CLI emits init at the start of each turn. Before any API call, so ending the call here
            // bills nothing. A session that reaches an assistant or result message with no init at all is
            // a miss too: the list was never seen, so the agent cannot be confirmed.
            if (agent !== undefined) {
              let initMiss: string | undefined;
              if (m.type === 'system' && m.subtype === 'init') {
                sawInit = true;
                if (!Array.isArray(m.agents)) initMiss = 'the init message carries no agents list';
                else if (!m.agents.includes(agent)) initMiss = `the init message lists agents [${m.agents.join(', ')}]`;
              } else if (!sawInit && (m.type === 'assistant' || m.type === 'result')) {
                initMiss = `no init message arrived before the first ${m.type} message`;
              }
              if (initMiss !== undefined) {
                st.agentNotLoaded ??= initMiss;
                // A result before init means the turn ran and was billed: keep it so the hold carries its usage.
                if (m.type === 'result') result = m as unknown as ClaudeResultPayload;
                // No tool call here, so the event names the stream message that tripped it.
                emit?.({
                  type: 'gate-decision',
                  toolName: 'init',
                  decision: 'hold',
                  code: AGENT_NOT_LOADED,
                  reason: `the CLI did not load agent '${agent}': ${initMiss}`,
                });
                abortController.abort();
                killAll();
                break;
              }
            }
            if (m.type === 'result') result = m as unknown as ClaudeResultPayload;
            else if (m.type === 'assistant' && typeof m.error === 'string') assistantError = m.error;
            else if (m.type === 'rate_limit_event' && typeof m.rate_limit_info === 'object' && m.rate_limit_info !== null) {
              const info = m.rate_limit_info as ClaudeRateLimitInfo;
              sawRateLimit = true;
              if (typeof info.status === 'string') rateLimitStatus = info.status;
              if (typeof info.isUsingOverage === 'boolean') rateLimitOverage = info.isUsingOverage;
              for (const w of rateLimitWindowsFromInfo(info)) windowsByName.set(w.name, w);
            }
            for (const event of mapClaudeStreamMessage(m, index)) emit?.(event);
            index += 1;
          }
        } catch (err) {
          iteratorError = err;
        } finally {
          st.finished = true;
          clearTimeout(timer);
          if (st.holdTimer !== undefined) clearTimeout(st.holdTimer);
          if (idleTimer !== undefined) clearTimeout(idleTimer);
          try {
            stream?.close?.();
          } catch {
            /* already closed */
          }
          // The CLI has ended or is being ended. A descendant it backgrounded may still run: kill the
          // group and the cgroup before waiting, as the runner does on every exit path (#17).
          killAll();
          for (const child of st.children) {
            let exitWait: ReturnType<typeof setTimeout> | undefined;
            const childExit = await Promise.race([
              child.exited,
              new Promise<undefined>((r) => {
                exitWait = setTimeout(() => r(undefined), EXIT_WAIT_MS);
              }),
            ]);
            // An uncleared timer would hold the process open for EXIT_WAIT_MS after every call.
            clearTimeout(exitWait);
            // A nonzero code from any child wins over an earlier clean or unknown one.
            if (childExit !== undefined && childExit !== 0) exitCode = childExit;
            else exitCode ??= childExit;
            untrackProcessGroup(child.pid);
            if (child.cgroup !== undefined) await removeCgroup(child.cgroup);
          }
        }

        const rateLimit = rateLimitSnapshot();
        emit?.(
          st.idledOut && (iteratorError !== undefined || result === null)
            ? { type: 'lifecycle', phase: 'idle-timeout' }
            : st.timedOut && (iteratorError !== undefined || result === null)
              ? { type: 'lifecycle', phase: 'timeout' }
              : { type: 'lifecycle', phase: 'end', ...(exitCode !== undefined ? { exitCode } : {}) },
        );

        // An agent the CLI did not load wins over everything: whatever ran, ran as the wrong agent. It holds
        // the card, as an agent the kernel cannot resolve at dispatch does, and the spend is billed.
        if (st.agentNotLoaded !== undefined) {
          const usage = buildKnownUsage(result, rateLimit);
          fail(
            `the CLI did not load agent '${agent}' (${st.agentNotLoaded}); check the agent name and the plugin dirs`,
            HARNESS_GATE_HOLD_CODE,
            usage !== undefined ? { usage } : undefined,
          );
        }
        // A hold wins over everything else: a human is asked, and the call's spend is still billed.
        if (st.held !== undefined) {
          const usage = buildKnownUsage(result, rateLimit);
          fail(
            `the tool gate held the card on ${st.held.toolName} (${st.held.code}): ${st.held.reason}`,
            HARNESS_GATE_HOLD_CODE,
            usage !== undefined ? { usage } : undefined,
          );
        }
        const failedOnItsOwn = iteratorError !== undefined || result === null;
        if (st.idledOut && failedOnItsOwn) {
          const usage = buildKnownUsage(result, rateLimit);
          fail(
            'invocation produced no output for longer than the idle timeout and was killed',
            'harness-idle-timeout',
            usage !== undefined ? { usage } : undefined,
          );
        }
        if (st.timedOut && failedOnItsOwn) {
          const usage = buildKnownUsage(result, rateLimit);
          fail('invocation exceeded its timeout and was killed', 'harness-timeout', usage !== undefined ? { usage } : undefined);
        }

        const errorText = iteratorError instanceof Error ? iteratorError.message : iteratorError !== undefined ? String(iteratorError) : '';
        const resultFailed = result !== null && (result.is_error === true || (result.subtype !== undefined && result.subtype !== 'success'));
        if (iteratorError !== undefined || resultFailed || result === null) {
          // Provider cap first: retrying it now cannot work, and the executor parks rather than scraps.
          if (
            assistantError === 'rate_limit' ||
            isRateLimited(result, rateLimit, `${st.stderrTail}\n${errorText}`.trim())
          ) {
            const resetAtMs = bindingResetAtMs(rateLimit);
            const usage = buildKnownUsage(result, rateLimit);
            fail(`provider rate limit: ${result?.result ?? rateLimit?.status ?? 'no detail reported'}`, 'harness-rate-limited', {
              ...(resetAtMs !== undefined ? { resetAtMs } : {}),
              ...(rateLimit !== undefined ? { rateLimit } : {}),
              ...(usage !== undefined ? { usage } : {}),
            });
          }
          // Authentication is classified on the assistant error or the terminal reason, never on
          // `subtype`, which reads 'success' for it. It uses the nonzero-exit class the executor
          // already handles: retrying will not help, and nothing was billed.
          const authFailed =
            assistantError === 'authentication_failed' || (result?.is_error === true && result.terminal_reason === 'api_error');
          const detail = authFailed
            ? `authentication failed: ${result?.result ?? errorText}`.trim()
            : result !== null
              ? `${result.terminal_reason ?? result.subtype ?? 'unknown reason'}: ${result.result ?? errorText}`.trim()
              : errorText !== ''
                ? errorText
                : 'the stream ended without a result message';
          const usage = buildKnownUsage(result, rateLimit);
          fail(
            `exited${exitCode !== undefined ? ` with code ${exitCode}` : ''}: ${detail}`,
            'harness-nonzero-exit',
            usage !== undefined ? { usage } : undefined,
          );
        }

        if (typeof result.usage !== 'object' || result.usage === null || Array.isArray(result.usage)) {
          fail('response payload had a missing or malformed usage object');
        }
        if (typeof result.total_cost_usd !== 'number') {
          fail('response payload had a missing or non-numeric total_cost_usd');
        }
        const usage = buildKnownUsage(result, rateLimit);
        if (usage === undefined) fail('response payload had a missing or malformed usage object');
        return { outputs: [], usage };
      } finally {
        if (configDir !== undefined) removeRunScopedClaudeConfigDir(configDir);
      }
    },
  };
}
