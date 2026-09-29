/**
 * agent-sdk adapter tests (issue #21). `query()` is replaced by a scripted
 * generator, so nothing here calls the API. A script that needs a real child
 * process (the kill paths) starts one through `options.spawnClaudeCodeProcess`,
 * the same hook the SDK would call.
 */
import { describe, it, expect } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describeHarnessContainmentConformance } from './harness-containment.conformance';
import { createAgentSdkHarnessAdapter, type AgentSdkHarnessAdapterConfig, type AgentSdkQueryFn } from './harness-adapter-agent-sdk';
import {
  bindHarnessDefinitionsForIntrospection, buildHarnessDefinitionRegistry, shippedHarnessAdapterNames,
  usageFromThrow, type HarnessInvocation, type KnownUsage,
} from './harness-adapter';
import type { HarnessEvent } from './harness-events';
import { HARNESS_GATE_HOLD_CODE, type GateToolCall, type HarnessToolGate } from './harness-gate';

describeHarnessContainmentConformance('agent-sdk', (opts) =>
  createAgentSdkHarnessAdapter({ ...opts, envAllowlist: [] }),
);

const ROOT = tmpdir();
const containment = { mechanism: 'process-group', reason: 'unit test' } as const;

type Msg = Record<string, unknown>;
const asMsg = (m: Msg): SDKMessage => m as unknown as SDKMessage;

const USAGE = { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 };
const RESULT_OK: Msg = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  total_cost_usd: 0.0123,
  usage: USAGE,
  modelUsage: {
    'claude-haiku-4-5': { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 40, cacheCreationInputTokens: 30 },
  },
  num_turns: 1,
  permission_denials: [],
};

interface Ctx {
  options: Options;
  /** Run the PreToolUse hook the adapter registered, as the CLI would. */
  hook(input: Record<string, unknown>): Promise<unknown>;
  /** Start a real child through the adapter's spawn hook. */
  spawn(command: string, args: string[]): ChildProcess;
}

/** A `query()` whose stream is `script`'s generator. Records the options it was given. */
function scripted(script: (ctx: Ctx) => AsyncGenerator<Msg, void>): { query: AgentSdkQueryFn; seen: Options[] } {
  const seen: Options[] = [];
  const query: AgentSdkQueryFn = ({ options }) => {
    seen.push(options);
    const ctx: Ctx = {
      options,
      hook: (input) => {
        const fn = options.hooks!.PreToolUse![0]!.hooks[0]!;
        return fn(
          { hook_event_name: 'PreToolUse', session_id: 's', transcript_path: '', cwd: '', tool_use_id: 'tu-1', ...input } as never,
          'tu-1',
          { signal: new AbortController().signal },
        );
      },
      spawn: (command, args) =>
        options.spawnClaudeCodeProcess!({
          command,
          args,
          cwd: options.cwd,
          env: { PATH: '/usr/bin:/bin' },
          signal: new AbortController().signal,
        }) as unknown as ChildProcess,
    };
    const gen = script(ctx);
    return {
      async *[Symbol.asyncIterator]() {
        for await (const m of gen) yield asMsg(m);
      },
    };
  };
  return { query, seen };
}

function makeAdapter(query: AgentSdkQueryFn, extra: Partial<AgentSdkHarnessAdapterConfig> = {}) {
  return createAgentSdkHarnessAdapter({
    projectRoot: ROOT,
    envAllowlist: [],
    command: '/bin/sh',
    sourceEnv: {},
    containment,
    query,
    ...extra,
  });
}

function invocation(extra: Partial<HarnessInvocation> = {}): HarnessInvocation {
  return { prompt: 'do it', inputs: [], tools: [], timeoutMs: 10_000, ...extra };
}

const allowAll: HarnessToolGate = () => ({ decision: 'allow' });

function collect(): { events: HarnessEvent[]; onEvent: (e: HarnessEvent) => void } {
  const events: HarnessEvent[] = [];
  return { events, onEvent: (e) => events.push(e) };
}

const isDead = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    // EPERM means the process exists under another user, so it is not dead.
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
};

async function rejection(p: Promise<unknown>): Promise<Error & { code?: string; usage?: unknown }> {
  try {
    await p;
  } catch (err) {
    return err as Error & { code?: string };
  }
  throw new Error('expected the invocation to reject');
}

describe('agent-sdk adapter: capabilities', () => {
  it('names itself, reports usage, restricts tools and gates per call', () => {
    const adapter = makeAdapter(scripted(async function* () {}).query);
    expect(adapter.name).toBe('agent-sdk');
    expect(adapter.reportsUsage).toBe(true);
    expect(adapter.canRestrictTools).toBe(true);
    expect(adapter.canGatePerCall).toBe(true);
    expect(adapter.resolveAgentDefinition).toBeUndefined();
  });

  it('probes the resolved binary, and reports a missing one', async () => {
    const present = await makeAdapter(scripted(async function* () {}).query).probeBinary();
    expect(present).toEqual({ present: true, detail: '/bin/sh' });
    const absent = await makeAdapter(scripted(async function* () {}).query, { command: 'no-such-claude-binary' }).probeBinary();
    expect(absent.present).toBe(false);
  });

  it('rejects an invocation when the binary is not found', async () => {
    const adapter = makeAdapter(scripted(async function* () {}).query, { command: 'no-such-claude-binary' });
    expect((await rejection(adapter.invoke(invocation()))).message).toContain('not found');
  });
});

describe('agent-sdk adapter: executable resolution', () => {
  it('says a relative command path is not absolute, rather than not on PATH', async () => {
    const adapter = makeAdapter(scripted(async function* () {}).query, { command: './bin/claude' });
    const probed = await adapter.probeBinary();
    expect(probed.present).toBe(false);
    expect(probed.detail).toContain('absolute');
    expect(probed.detail).not.toContain('not found on PATH');
    const err = await rejection(adapter.invoke(invocation()));
    expect(err.message).toContain('absolute');
    expect(err.message).not.toContain('not found on PATH');
  });

  it('says a missing absolute path does not exist, rather than not on PATH', async () => {
    const adapter = makeAdapter(scripted(async function* () {}).query, { command: '/no/such/dir/claude' });
    const probed = await adapter.probeBinary();
    expect(probed.present).toBe(false);
    expect(probed.detail).toContain('/no/such/dir/claude');
    expect(probed.detail).not.toContain('not found on PATH');
    expect((await rejection(adapter.invoke(invocation()))).message).not.toContain('not found on PATH');
  });
});

describe('agent-sdk adapter: success path', () => {
  it('parses usage, cost, breakdown and the billed model from the result message', async () => {
    const { query } = scripted(async function* () {
      yield { type: 'system', subtype: 'init' };
      yield RESULT_OK;
    });
    const out = await makeAdapter(query).invoke(invocation({ gate: allowAll }));
    expect(out.outputs).toEqual([]);
    const usage = out.usage as KnownUsage;
    expect(usage.tokens).toBe(100);
    expect(usage.cost).toBe(0.0123);
    expect(usage.breakdown).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadInputTokens: 40,
      cacheCreationInputTokens: 30,
    });
    expect(usage.model).toBe('claude-haiku-4-5');
  });

  it('calls onProgress once per SDK message', async () => {
    let progress = 0;
    const { query } = scripted(async function* () {
      yield { type: 'system', subtype: 'init' };
      yield { type: 'assistant', message: { id: 'm', content: [] } };
      yield RESULT_OK;
    });
    await makeAdapter(query).invoke(invocation({ gate: allowAll, onProgress: () => (progress += 1) }));
    expect(progress).toBe(3);
  });

  it('ignores message types it does not know', async () => {
    const { query } = scripted(async function* () {
      yield { type: 'stream_event', event: {} };
      yield { type: 'something_new', payload: 1 };
      yield { nothing: 'typed' };
      yield RESULT_OK;
    });
    const { events, onEvent } = collect();
    const out = await makeAdapter(query).invoke(invocation({ gate: allowAll, onEvent }));
    expect((out.usage as KnownUsage).tokens).toBe(100);
    expect(events.map((e) => e.type)).toEqual(['lifecycle', 'usage', 'lifecycle']);
  });

  it('maps stream messages through the shared mapper and numbers events from 0', async () => {
    const { query } = scripted(async function* () {
      yield {
        type: 'assistant',
        uuid: 'u1',
        message: { id: 'm1', content: [{ type: 'tool_use', id: 'tu-9', name: 'Read', input: { file_path: '/x' } }] },
      };
      yield {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu-9', content: 'ok' }] },
      };
      yield RESULT_OK;
    });
    const { events, onEvent } = collect();
    await makeAdapter(query).invoke(invocation({ gate: allowAll, onEvent }));
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    expect(events.map((e) => e.type)).toEqual([
      'lifecycle',
      'tool-input-start',
      'tool-input-available',
      'tool-output-available',
      'usage',
      'lifecycle',
    ]);
    expect(events[events.length - 1]).toMatchObject({ type: 'lifecycle', phase: 'end' });
  });
});

describe('agent-sdk adapter: options handed to the SDK', () => {
  const ok = () => scripted(async function* () { yield RESULT_OK; });

  it('isolates settings, keeps the default permission mode and uses the resolved executable', async () => {
    const { query, seen } = ok();
    await makeAdapter(query).invoke(invocation({ gate: allowAll }));
    const o = seen[0]!;
    expect(o.settingSources).toEqual([]);
    expect(o.permissionMode).toBe('default');
    expect(o.pathToClaudeCodeExecutable).toBe('/bin/sh');
    expect(o.cwd).toBe(ROOT);
    expect(typeof o.spawnClaudeCodeProcess).toBe('function');
  });

  it('passes the tools allowlist as allowedTools, and none for a waived station', async () => {
    const a = ok();
    await makeAdapter(a.query).invoke(invocation({ gate: allowAll, tools: ['Read', 'Bash(git:*)'] }));
    expect(a.seen[0]!.allowedTools).toEqual(['Read', 'Bash(git:*)']);
    const b = ok();
    await makeAdapter(b.query).invoke(invocation({ gate: allowAll, tools: [] }));
    expect(b.seen[0]!.allowedTools).toBeUndefined();
  });

  it('lets the call model win over the adapter default, and omits it when neither is set', async () => {
    const a = ok();
    await makeAdapter(a.query, { model: 'adapter-model' }).invoke(invocation({ gate: allowAll, model: 'call-model' }));
    expect(a.seen[0]!.model).toBe('call-model');
    const b = ok();
    await makeAdapter(b.query, { model: 'adapter-model' }).invoke(invocation({ gate: allowAll }));
    expect(b.seen[0]!.model).toBe('adapter-model');
    const c = ok();
    await makeAdapter(c.query).invoke(invocation({ gate: allowAll }));
    expect('model' in c.seen[0]!).toBe(false);
  });

  it('builds the whole env from the allowlist and nothing else', async () => {
    const { query, seen } = ok();
    const sourceEnv = { KEEP: '1', SECRET: 'no', PATH: '/usr/bin' };
    await makeAdapter(query, { sourceEnv, envAllowlist: ['KEEP', 'ABSENT'] }).invoke(invocation({ gate: allowAll }));
    expect(seen[0]!.env).toEqual({ KEEP: '1' });
  });
});

describe('agent-sdk adapter: isolateConfig', () => {
  function home(): string {
    const dir = mkdtempSync(join(tmpdir(), 'conduit-sdk-home-'));
    mkdirSync(join(dir, '.claude'));
    writeFileSync(join(dir, '.claude', '.credentials.json'), '{}');
    return dir;
  }

  it('gives the child a run-scoped config dir that exists during the call and is removed after', async () => {
    const h = home();
    let during: string | undefined;
    const { query } = scripted(async function* (ctx) {
      during = ctx.options.env!.CLAUDE_CONFIG_DIR;
      expect(existsSync(join(during!, '.credentials.json'))).toBe(true);
      yield RESULT_OK;
    });
    try {
      await makeAdapter(query, { isolateConfig: true, sourceEnv: { HOME: h }, envAllowlist: ['HOME'] }).invoke(
        invocation({ gate: allowAll }),
      );
      expect(during).toBeDefined();
      expect(during).not.toBe(join(h, '.claude'));
      expect(existsSync(during!)).toBe(false);
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });

  it('removes the config dir when the call fails', async () => {
    const h = home();
    let during: string | undefined;
    const { query } = scripted(async function* (ctx) {
      during = ctx.options.env!.CLAUDE_CONFIG_DIR;
      throw new Error('boom');
    });
    try {
      await rejection(
        makeAdapter(query, { isolateConfig: true, sourceEnv: { HOME: h }, envAllowlist: ['HOME'] }).invoke(invocation({ gate: allowAll })),
      );
      expect(existsSync(during!)).toBe(false);
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });

  it('removes the config dir when the invocation throws before the stream starts', async () => {
    const h = home();
    const scratch = mkdtempSync(join(tmpdir(), 'conduit-sdk-tmp-'));
    const savedTmp = process.env.TMPDIR;
    process.env.TMPDIR = scratch;
    try {
      const { query } = scripted(async function* () { yield RESULT_OK; });
      // `tools` is absent, so building the SDK options throws after the config dir exists.
      const bad = { prompt: 'do it', inputs: [], timeoutMs: 10_000, gate: allowAll } as unknown as HarnessInvocation;
      await rejection(makeAdapter(query, { isolateConfig: true, sourceEnv: { HOME: h }, envAllowlist: ['HOME'] }).invoke(bad));
      expect(readdirSync(scratch).filter((n) => n.startsWith('conduit-claude-config-'))).toEqual([]);
    } finally {
      if (savedTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = savedTmp;
      rmSync(scratch, { recursive: true, force: true });
      rmSync(h, { recursive: true, force: true });
    }
  });

  it('fails before spawning when there is nothing to authenticate with', async () => {
    const { query, seen } = scripted(async function* () { yield RESULT_OK; });
    const err = await rejection(
      makeAdapter(query, { isolateConfig: true, sourceEnv: { HOME: '/nonexistent-home' }, envAllowlist: ['HOME'] }).invoke(
        invocation({ gate: allowAll }),
      ),
    );
    expect(err.message).toContain('credentials');
    expect(seen).toEqual([]);
  });
});

describe('agent-sdk adapter: the tool gate', () => {
  it('returns no permission decision for an allow, so the SDK permission flow continues', async () => {
    let answer: unknown;
    const { query } = scripted(async function* (ctx) {
      answer = await ctx.hook({ tool_name: 'Read', tool_input: { file_path: 'a' } });
      yield RESULT_OK;
    });
    await makeAdapter(query).invoke(invocation({ gate: allowAll }));
    expect(answer).toEqual({ continue: true });
  });

  it('emits a gate-decision event for an allowed call', async () => {
    const { query } = scripted(async function* (ctx) {
      await ctx.hook({ tool_name: 'Read', tool_input: {} });
      yield RESULT_OK;
    });
    const { events, onEvent } = collect();
    await makeAdapter(query).invoke(invocation({ gate: allowAll, onEvent }));
    expect(events.find((e) => e.type === 'gate-decision')).toMatchObject({
      type: 'gate-decision',
      toolName: 'Read',
      toolCallId: 'tu-1',
      decision: 'allow',
    });
  });

  it('answers a deny with permissionDecision deny, emits the decision, and lets the call finish', async () => {
    let answer: unknown;
    const gate: HarnessToolGate = () => ({ decision: 'deny', code: 'not_allowlisted', reason: 'rm is not on the allowlist' });
    const { query } = scripted(async function* (ctx) {
      answer = await ctx.hook({ tool_name: 'Bash', tool_input: { command: 'rm -rf x' } });
      yield RESULT_OK;
    });
    const { events, onEvent } = collect();
    const out = await makeAdapter(query).invoke(invocation({ gate, onEvent }));
    expect(answer).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'rm is not on the allowlist',
      },
    });
    expect(events.find((e) => e.type === 'gate-decision')).toMatchObject({
      decision: 'deny',
      code: 'not_allowlisted',
      reason: 'rm is not on the allowlist',
      toolName: 'Bash',
    });
    expect((out.usage as KnownUsage).tokens).toBe(100);
  });

  it('never puts the tool input in the gate-decision event', async () => {
    const gate: HarnessToolGate = () => ({ decision: 'deny', code: 'not_allowlisted', reason: 'no' });
    const { query } = scripted(async function* (ctx) {
      await ctx.hook({ tool_name: 'Bash', tool_input: { command: 'echo SECRET-VALUE' } });
      yield RESULT_OK;
    });
    const { events, onEvent } = collect();
    await makeAdapter(query).invoke(invocation({ gate, onEvent }));
    expect(JSON.stringify(events)).not.toContain('SECRET-VALUE');
  });

  it('hands a subagent call to the gate with its agent id and type, and journals the id', async () => {
    const calls: GateToolCall[] = [];
    const gate: HarnessToolGate = (c) => {
      calls.push(c);
      return { decision: 'allow' };
    };
    const { query } = scripted(async function* (ctx) {
      await ctx.hook({ tool_name: 'Bash', tool_input: { command: 'ls' } });
      await ctx.hook({ tool_name: 'Bash', tool_input: { command: 'ls' }, agent_id: 'sub-7', agent_type: 'general-purpose' });
      yield RESULT_OK;
    });
    const { events, onEvent } = collect();
    await makeAdapter(query).invoke(invocation({ gate, onEvent }));
    expect(calls[0]).toEqual({ toolName: 'Bash', input: { command: 'ls' }, toolCallId: 'tu-1' });
    expect(calls[1]).toEqual({
      toolName: 'Bash',
      input: { command: 'ls' },
      toolCallId: 'tu-1',
      agentId: 'sub-7',
      agentType: 'general-purpose',
    });
    const decisions = events.filter((e) => e.type === 'gate-decision');
    expect(decisions[0]).not.toHaveProperty('agentId');
    expect(decisions[1]).toMatchObject({ agentId: 'sub-7' });
  });

  it('treats a throwing gate as a deny', async () => {
    let answer: unknown;
    const gate: HarnessToolGate = () => {
      throw new Error('gate exploded');
    };
    const { query } = scripted(async function* (ctx) {
      answer = await ctx.hook({ tool_name: 'Write', tool_input: {} });
      yield RESULT_OK;
    });
    const { events, onEvent } = collect();
    await makeAdapter(query).invoke(invocation({ gate, onEvent }));
    expect(answer).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(events.find((e) => e.type === 'gate-decision')).toMatchObject({ decision: 'deny', code: 'gate_error' });
  });

  it('denies every call when no gate was supplied', async () => {
    let answer: unknown;
    const { query } = scripted(async function* (ctx) {
      answer = await ctx.hook({ tool_name: 'Read', tool_input: {} });
      yield RESULT_OK;
    });
    const { events, onEvent } = collect();
    await makeAdapter(query).invoke(invocation({ onEvent }));
    expect(answer).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(events.find((e) => e.type === 'gate-decision')).toMatchObject({ decision: 'deny', code: 'gate_error' });
  });

  it('ignores a hook event that is not PreToolUse', async () => {
    let answer: unknown;
    const { query } = scripted(async function* (ctx) {
      answer = await ctx.hook({ hook_event_name: 'PostToolUse', tool_name: 'Read' });
      yield RESULT_OK;
    });
    const { events, onEvent } = collect();
    await makeAdapter(query).invoke(invocation({ gate: () => ({ decision: 'deny', code: 'gate_error', reason: 'x' }), onEvent }));
    expect(answer).toEqual({ continue: true });
    expect(events.some((e) => e.type === 'gate-decision')).toBe(false);
  });
});

describe('agent-sdk adapter: hold', () => {
  const holdGate: HarnessToolGate = () => ({ decision: 'hold', code: 'needs_human', reason: 'asks a human' });
  /** A stream that started a child and waits for it to be killed, as a CLI that never answers does. */
  const stuckAfterHold = () => {
    const state: { child?: ChildProcess; answer?: unknown } = {};
    const { query } = scripted(async function* (ctx) {
      state.child = ctx.spawn('/bin/sleep', ['30']);
      state.answer = await ctx.hook({ tool_name: 'AskUserQuestion', tool_input: {} });
      await new Promise((r) => state.child!.once('exit', r));
      throw new Error('Claude Code process terminated by signal SIGKILL');
    });
    return { query, state };
  };

  it('answers the held call with a deny that also stops the CLI', async () => {
    const { query, state } = stuckAfterHold();
    const { events, onEvent } = collect();
    const err = await rejection(makeAdapter(query, { holdStopWaitMs: 100 }).invoke(invocation({ gate: holdGate, onEvent })));
    expect(err.code).toBe(HARNESS_GATE_HOLD_CODE);
    expect(err.message).toContain('needs_human');
    expect(state.answer).toMatchObject({
      continue: false,
      stopReason: 'asks a human',
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    expect(events.find((e) => e.type === 'gate-decision')).toMatchObject({ decision: 'hold', code: 'needs_human' });
  });

  it('bills the call when the CLI emits its result after the hold', async () => {
    const started = Date.now();
    const { query } = scripted(async function* (ctx) {
      await ctx.hook({ tool_name: 'AskUserQuestion', tool_input: {} });
      yield RESULT_OK;
    });
    const err = await rejection(makeAdapter(query, { holdStopWaitMs: 30_000 }).invoke(invocation({ gate: holdGate })));
    expect(err.code).toBe(HARNESS_GATE_HOLD_CODE);
    expect(usageFromThrow(err)).toMatchObject({ tokens: 100, cost: 0.0123 });
    // The bound is 30 s: a result that arrives ends the wait at once, far below it even on a slow host.
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('kills the process after the bounded wait when no result arrives, and invents no usage', async () => {
    const { query, state } = stuckAfterHold();
    const started = Date.now();
    const err = await rejection(makeAdapter(query, { holdStopWaitMs: 200 }).invoke(invocation({ gate: holdGate })));
    const elapsed = Date.now() - started;
    expect(err.code).toBe(HARNESS_GATE_HOLD_CODE);
    expect(isDead(state.child!.pid!)).toBe(true);
    expect(usageFromThrow(err)).toBeUndefined();
    expect(elapsed).toBeGreaterThanOrEqual(150);
  });

  it('denies every later call without asking the gate, even one it would allow', async () => {
    let asked = 0;
    const gate: HarnessToolGate = () => (asked++ === 0 ? { decision: 'hold', code: 'needs_human', reason: 'asks a human' } : { decision: 'allow' });
    let later: unknown;
    const { query } = scripted(async function* (ctx) {
      await ctx.hook({ tool_name: 'AskUserQuestion', tool_input: {} });
      later = await ctx.hook({ tool_name: 'Read', tool_input: { file_path: 'a' } });
      yield RESULT_OK;
    });
    const { events, onEvent } = collect();
    const err = await rejection(makeAdapter(query).invoke(invocation({ gate, onEvent })));
    expect(err.code).toBe(HARNESS_GATE_HOLD_CODE);
    expect(asked).toBe(1);
    expect(later).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(later).not.toHaveProperty('continue', true);
    const decisions = events.filter((e) => e.type === 'gate-decision');
    expect(decisions[1]).toMatchObject({ toolName: 'Read', decision: 'deny', code: 'needs_human' });
  });

  it('still throws the hold code when the stream errors after the hold', async () => {
    const { query } = scripted(async function* (ctx) {
      await ctx.hook({ tool_name: 'AskUserQuestion', tool_input: {} });
      yield RESULT_OK;
      throw new Error('Claude Code returned an error result: something else');
    });
    const err = await rejection(makeAdapter(query).invoke(invocation({ gate: holdGate })));
    expect(err.code).toBe(HARNESS_GATE_HOLD_CODE);
  });

  it('keeps the wall-clock timer running during the wait, and the hold still wins', async () => {
    const { query, state } = stuckAfterHold();
    const started = Date.now();
    const err = await rejection(
      makeAdapter(query, { holdStopWaitMs: 60_000 }).invoke(invocation({ gate: holdGate, timeoutMs: 250 })),
    );
    expect(err.code).toBe(HARNESS_GATE_HOLD_CODE);
    expect(isDead(state.child!.pid!)).toBe(true);
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  it('keeps the idle timer running during the wait, and the hold still wins', async () => {
    const { query, state } = stuckAfterHold();
    const started = Date.now();
    const err = await rejection(
      makeAdapter(query, { holdStopWaitMs: 60_000 }).invoke(invocation({ gate: holdGate, idleTimeoutMs: 250 })),
    );
    expect(err.code).toBe(HARNESS_GATE_HOLD_CODE);
    expect(isDead(state.child!.pid!)).toBe(true);
    expect(Date.now() - started).toBeLessThan(20_000);
  });
});

describe('agent-sdk adapter: several children', () => {
  it('kills every child the SDK spawned for one invocation, not only the newest', async () => {
    const children: ChildProcess[] = [];
    const { query } = scripted(async function* (ctx) {
      children.push(ctx.spawn('/bin/sleep', ['30']));
      children.push(ctx.spawn('/bin/sleep', ['30']));
      yield RESULT_OK;
    });
    try {
      await makeAdapter(query).invoke(invocation({ gate: allowAll }));
      expect(children).toHaveLength(2);
      expect(children[0]!.pid).not.toBe(children[1]!.pid);
      for (const child of children) expect(isDead(child.pid!)).toBe(true);
    } finally {
      for (const child of children) if (!isDead(child.pid!)) process.kill(-child.pid!, 'SIGKILL');
    }
  });

  it('kills the older child too when the wall-clock timer fires', async () => {
    const children: ChildProcess[] = [];
    const { query } = scripted(async function* (ctx) {
      children.push(ctx.spawn('/bin/sleep', ['30']));
      children.push(ctx.spawn('/bin/sleep', ['30']));
      await new Promise((r) => children[1]!.once('exit', r));
      throw new Error('Claude Code process terminated by signal SIGKILL');
    });
    try {
      const err = await rejection(makeAdapter(query).invoke(invocation({ timeoutMs: 200 })));
      expect(err.code).toBe('harness-timeout');
      for (const child of children) expect(isDead(child.pid!)).toBe(true);
    } finally {
      for (const child of children) if (!isDead(child.pid!)) process.kill(-child.pid!, 'SIGKILL');
    }
  });
});

describe('agent-sdk adapter: timeouts', () => {
  it('kills the process and throws harness-timeout at the wall-clock bound', async () => {
    let child: ChildProcess | undefined;
    const { query } = scripted(async function* (ctx) {
      child = ctx.spawn('/bin/sleep', ['30']);
      await new Promise((r) => child!.once('exit', r));
      throw new Error('Claude Code process terminated by signal SIGKILL');
    });
    const { events, onEvent } = collect();
    const err = await rejection(makeAdapter(query).invoke(invocation({ timeoutMs: 200, onEvent })));
    expect(err.code).toBe('harness-timeout');
    expect(isDead(child!.pid!)).toBe(true);
    expect(usageFromThrow(err)).toBeUndefined();
    expect(events[events.length - 1]).toMatchObject({ type: 'lifecycle', phase: 'timeout' });
  });

  it('throws harness-idle-timeout when no message arrives for the idle bound', async () => {
    let child: ChildProcess | undefined;
    const { query } = scripted(async function* (ctx) {
      child = ctx.spawn('/bin/sleep', ['30']);
      yield { type: 'system', subtype: 'init' };
      await new Promise((r) => child!.once('exit', r));
      throw new Error('Claude Code process terminated by signal SIGKILL');
    });
    const { events, onEvent } = collect();
    const err = await rejection(makeAdapter(query).invoke(invocation({ timeoutMs: 10_000, idleTimeoutMs: 200, onEvent })));
    expect(err.code).toBe('harness-idle-timeout');
    expect(isDead(child!.pid!)).toBe(true);
    expect(events[events.length - 1]).toMatchObject({ type: 'lifecycle', phase: 'idle-timeout' });
  });

  it('resets the idle timer on every message', async () => {
    const { query } = scripted(async function* () {
      for (let i = 0; i < 5; i += 1) {
        await new Promise((r) => setTimeout(r, 80));
        yield { type: 'system', subtype: 'status' };
      }
      yield RESULT_OK;
    });
    const out = await makeAdapter(query).invoke(invocation({ gate: allowAll, idleTimeoutMs: 200 }));
    expect((out.usage as KnownUsage).tokens).toBe(100);
  });

  it('recovers usage on an idle kill when the result message had already arrived', async () => {
    let child: ChildProcess | undefined;
    const { query } = scripted(async function* (ctx) {
      child = ctx.spawn('/bin/sleep', ['30']);
      yield RESULT_OK;
      await new Promise((r) => child!.once('exit', r));
      throw new Error('Claude Code process terminated by signal SIGKILL');
    });
    const err = await rejection(makeAdapter(query).invoke(invocation({ idleTimeoutMs: 200 })));
    expect(err.code).toBe('harness-idle-timeout');
    expect(usageFromThrow(err)).toMatchObject({ tokens: 100 });
  });
});

describe('agent-sdk adapter: failures', () => {
  it('classifies a missing login on the assistant error, not on subtype', async () => {
    const { query } = scripted(async function* () {
      yield { type: 'assistant', error: 'authentication_failed', message: { id: 'm', content: [] } };
      yield {
        type: 'result',
        subtype: 'success',
        is_error: true,
        terminal_reason: 'api_error',
        result: 'Not logged in',
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      };
      throw new Error('Claude Code returned an error result: Not logged in');
    });
    const err = await rejection(makeAdapter(query).invoke(invocation({ gate: allowAll })));
    expect(err.code).toBe('harness-nonzero-exit');
    expect(err.message).toContain('authentication failed');
    expect(err.message).toContain('Not logged in');
  });

  it('classifies is_error with terminal_reason api_error as an auth failure without an assistant error', async () => {
    const { query } = scripted(async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        is_error: true,
        terminal_reason: 'api_error',
        result: 'Not logged in',
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      };
    });
    const err = await rejection(makeAdapter(query).invoke(invocation({ gate: allowAll })));
    expect(err.code).toBe('harness-nonzero-exit');
    expect(err.message).toContain('authentication failed');
  });

  it('throws harness-nonzero-exit for an iterator error with no result, without invented usage', async () => {
    const { query } = scripted(async function* () {
      throw new Error('Claude Code process terminated by signal SIGKILL');
    });
    const err = await rejection(makeAdapter(query).invoke(invocation({ gate: allowAll })));
    expect(err.code).toBe('harness-nonzero-exit');
    expect(err.message).toContain('SIGKILL');
    expect(usageFromThrow(err)).toBeUndefined();
  });

  it('throws an untagged error when the stream ends without a result', async () => {
    const { query } = scripted(async function* () {
      yield { type: 'system', subtype: 'init' };
    });
    const err = await rejection(makeAdapter(query).invoke(invocation({ gate: allowAll })));
    expect(err.message).toContain('without a result');
  });

  it('bills a failed call that still produced a result with usage', async () => {
    const { query } = scripted(async function* () {
      yield { ...RESULT_OK, subtype: 'error_max_turns', is_error: true, terminal_reason: 'max_turns' };
    });
    const err = await rejection(makeAdapter(query).invoke(invocation({ gate: allowAll })));
    expect(err.code).toBe('harness-nonzero-exit');
    expect(usageFromThrow(err)).toMatchObject({ tokens: 100 });
  });

  it('rejects a success result with a malformed usage object', async () => {
    const { query } = scripted(async function* () {
      yield { ...RESULT_OK, usage: 'lots' };
    });
    const err = await rejection(makeAdapter(query).invoke(invocation({ gate: allowAll })));
    expect(err.message).toContain('usage');
  });
});

describe('agent-sdk adapter: rate limits', () => {
  const window = {
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'allowed',
      rateLimitType: 'five_hour',
      utilization: 0.04,
      resetsAt: 1790544600,
      unifiedWindows: {
        five_hour: { utilization: 0.04, resetsAt: 1790544600 },
        seven_day: { utilization: 0.48, resetsAt: 1790748000 },
      },
    },
  };

  it('emits a rate-limit event carrying both windows', async () => {
    const { query } = scripted(async function* () {
      yield window;
      yield RESULT_OK;
    });
    const { events, onEvent } = collect();
    await makeAdapter(query).invoke(invocation({ gate: allowAll, onEvent }));
    expect(events.find((e) => e.type === 'rate-limit')).toMatchObject({
      type: 'rate-limit',
      status: 'allowed',
      windows: [
        { name: 'five_hour', utilization: 0.04, resetsAtMs: 1790544600_000 },
        { name: 'seven_day', utilization: 0.48, resetsAtMs: 1790748000_000 },
      ],
    });
  });

  it('puts the capacity snapshot on the usage of a successful call', async () => {
    const { query } = scripted(async function* () {
      yield window;
      yield RESULT_OK;
    });
    const out = await makeAdapter(query).invoke(invocation({ gate: allowAll }));
    expect((out.usage as KnownUsage).rateLimit?.windows.map((w) => w.name)).toEqual(['five_hour', 'seven_day']);
  });

  it('throws harness-rate-limited with the binding reset and the recovered usage on a rejected state', async () => {
    const { query } = scripted(async function* () {
      yield {
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', utilization: 1, resetsAt: 1790544600 },
      };
      yield { ...RESULT_OK, is_error: true, api_error_status: 429, result: 'session limit reached' };
      throw new Error('Claude Code returned an error result: session limit reached');
    });
    const err = (await rejection(makeAdapter(query).invoke(invocation({ gate: allowAll })))) as Error & {
      code?: string;
      resetAtMs?: number;
    };
    expect(err.code).toBe('harness-rate-limited');
    expect(err.resetAtMs).toBe(1790544600_000);
    expect(usageFromThrow(err)).toMatchObject({ tokens: 100 });
  });

  it('parks on a rate_limit assistant error even with no result message', async () => {
    const { query } = scripted(async function* () {
      yield { type: 'assistant', error: 'rate_limit', message: { id: 'm', content: [] } };
      throw new Error('Claude Code process exited with code 1');
    });
    const err = await rejection(makeAdapter(query).invoke(invocation({ gate: allowAll })));
    expect(err.code).toBe('harness-rate-limited');
  });

  it('does not park on an allowed_warning state alone', async () => {
    const { query } = scripted(async function* () {
      yield { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.9, resetsAt: 1790748000 } };
      throw new Error('Claude Code process exited with code 1');
    });
    const err = await rejection(makeAdapter(query).invoke(invocation({ gate: allowAll })));
    expect(err.code).toBe('harness-nonzero-exit');
  });
});

describe('agent-sdk adapter: registration', () => {
  it('is in the shipped factory map', () => {
    expect(shippedHarnessAdapterNames()).toContain('agent-sdk');
  });

  it('carries canGatePerCall through the definition and the introspection registry', () => {
    const registry = buildHarnessDefinitionRegistry([{ name: 'agent-sdk', envAllowlist: ['HOME'] }]);
    const def = registry.resolve('agent-sdk');
    if (!def.ok) throw new Error(def.error);
    expect(def.adapter.canGatePerCall).toBe(true);
    const bound = bindHarnessDefinitionsForIntrospection(registry).resolve('agent-sdk');
    if (!bound.ok) throw new Error(bound.error);
    expect(bound.adapter.canGatePerCall).toBe(true);
  });

  it('accepts isolateConfig', () => {
    expect(() =>
      buildHarnessDefinitionRegistry([{ name: 'agent-sdk', envAllowlist: ['HOME'], isolateConfig: true }]),
    ).not.toThrow();
  });

  it.each([
    ['agent', { agent: 'team:coder' }, 'AGENT'],
    ['pluginDirs', { pluginDirs: ['/opt/plugins'] }, 'PLUGIN_DIRS'],
  ])('rejects %s, since named agents are not implemented for this adapter', (_option, extra, suffix) => {
    expect(() => buildHarnessDefinitionRegistry([{ name: 'agent-sdk', envAllowlist: ['HOME'], ...extra }])).toThrow(suffix);
  });
});
