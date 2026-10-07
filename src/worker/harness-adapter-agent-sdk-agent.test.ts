/**
 * agent-sdk: named agents and plugin dirs (issue #109).
 *
 * The station's agent (or the adapter default) reaches the SDK as `agent`, and
 * engine-config plugin dirs as `plugins: [{ type: 'local', path }]`. The SDK
 * turns these into `--agent` and `--plugin-dir`, the flags claude-headless
 * passes.
 *
 * On the SDK path an agent the CLI cannot find does not fail: the CLI runs the
 * default agent and reports success (spike on #21, 2026-10-06). The adapter
 * fails the call closed on either of two signals: the `system`/`init` message's
 * `agents` list lacks the requested name, or a main-thread tool call (no
 * `agent_id`) carries an `agent_type` other than the requested agent. Both end
 * the call with HARNESS_GATE_HOLD_CODE, so the executor holds the card as it
 * does when the agent cannot be resolved at dispatch.
 *
 * `query()` is replaced by a scripted generator, so nothing here calls the API.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createAgentSdkHarnessAdapter, type AgentSdkHarnessAdapterConfig, type AgentSdkQueryFn } from './harness-adapter-agent-sdk';
import { createClaudeHarnessAdapter } from './harness-adapter-claude';
import {
  bindHarnessDefinitions, bindHarnessDefinitionsForIntrospection, buildHarnessDefinitionRegistry, resolveHarnessAgent,
  usageFromThrow, type HarnessInvocation,
} from './harness-adapter';
import type { HarnessEvent } from './harness-events';
import { HARNESS_GATE_HOLD_CODE, type HarnessToolGate } from './harness-gate';

const containment = { mechanism: 'process-group', reason: 'unit test' } as const;
type Msg = Record<string, unknown>;

const RESULT_OK: Msg = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  total_cost_usd: 0.0123,
  usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 },
  modelUsage: {},
  num_turns: 1,
  permission_denials: [],
};

const initWith = (agents: string[] | undefined): Msg => ({
  type: 'system',
  subtype: 'init',
  ...(agents !== undefined ? { agents } : {}),
});

interface Ctx {
  options: Options;
  hook(input: Record<string, unknown>): Promise<unknown>;
}

function scripted(script: (ctx: Ctx) => AsyncGenerator<Msg, void>): { query: AgentSdkQueryFn; seen: Options[]; closedEarly: () => boolean } {
  const seen: Options[] = [];
  let finished = false;
  let returned = false;
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
    };
    const gen = script(ctx);
    return {
      async *[Symbol.asyncIterator]() {
        try {
          for await (const m of gen) yield m as unknown as SDKMessage;
          finished = true;
        } finally {
          if (!finished) returned = true;
        }
      },
    };
  };
  return { query, seen, closedEarly: () => returned };
}

const allowAll: HarnessToolGate = () => ({ decision: 'allow' });

function invocation(extra: Partial<HarnessInvocation> = {}): HarnessInvocation {
  return { prompt: 'do it', inputs: [], tools: [], timeoutMs: 10_000, gate: allowAll, ...extra };
}

async function rejection(p: Promise<unknown>): Promise<Error & { code?: string }> {
  try {
    await p;
  } catch (err) {
    return err as Error & { code?: string };
  }
  throw new Error('expected the invocation to reject');
}

let root: string;
let pluginDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'conduit-agent-sdk-agent-'));
  pluginDir = join(root, 'team');
  mkdirSync(join(pluginDir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'team' }));
  mkdirSync(join(pluginDir, 'agents'), { recursive: true });
  writeFileSync(join(pluginDir, 'agents', 'coder.md'), '---\nname: coder\ndescription: d\n---\nWrite code.\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeAdapter(query: AgentSdkQueryFn, extra: Partial<AgentSdkHarnessAdapterConfig> = {}) {
  return createAgentSdkHarnessAdapter({
    projectRoot: root,
    envAllowlist: [],
    command: '/bin/sh',
    sourceEnv: {},
    containment,
    query,
    ...extra,
  });
}

describe('agent-sdk: agent and plugins options', () => {
  it('passes the station agent over the adapter default, and the plugin dirs as local plugins', async () => {
    const { query, seen } = scripted(async function* () {
      yield initWith(['team:station']);
      yield RESULT_OK;
    });
    await makeAdapter(query, { agent: 'team:default', pluginDirs: [pluginDir] }).invoke(invocation({ agent: 'team:station' }));
    expect(seen[0]!.agent).toBe('team:station');
    expect(seen[0]!.plugins).toEqual([{ type: 'local', path: pluginDir }]);
  });

  it('uses the adapter default agent when the station declares none', async () => {
    const { query, seen } = scripted(async function* () {
      yield initWith(['team:default']);
      yield RESULT_OK;
    });
    await makeAdapter(query, { agent: 'team:default' }).invoke(invocation());
    expect(seen[0]!.agent).toBe('team:default');
  });

  it('passes no agent and no plugins when neither is configured', async () => {
    const { query, seen } = scripted(async function* () {
      yield initWith([]);
      yield RESULT_OK;
    });
    await makeAdapter(query).invoke(invocation());
    expect('agent' in seen[0]!).toBe(false);
    expect('plugins' in seen[0]!).toBe(false);
  });

  it('exposes the configured default as adapter.agent', () => {
    expect(makeAdapter(scripted(async function* () {}).query, { agent: 'team:default' }).agent).toBe('team:default');
    expect(makeAdapter(scripted(async function* () {}).query).agent).toBeUndefined();
  });
});

describe('agent-sdk: plugin dirs are checked at construction', () => {
  const q = () => scripted(async function* () {}).query;

  it('rejects a plugin dir that does not exist', () => {
    const missing = join(root, 'nope');
    expect(() => makeAdapter(q(), { pluginDirs: [missing] })).toThrow(missing);
  });

  it('rejects a plugin dir that is a file', () => {
    const zip = join(root, 'plugin.zip');
    writeFileSync(zip, 'PK');
    expect(() => makeAdapter(q(), { pluginDirs: [zip] })).toThrow('directory');
  });

  it('rejects a relative plugin dir', () => {
    expect(() => makeAdapter(q(), { pluginDirs: ['plugins'] })).toThrow('absolute');
  });

  it('names agent-sdk in the error, not claude-headless', () => {
    expect(() => makeAdapter(q(), { pluginDirs: ['plugins'] })).toThrow('agent-sdk');
  });
});

describe('agent-sdk: resolveAgentDefinition', () => {
  it('hashes the same definition file as claude-headless', () => {
    const sdk = makeAdapter(scripted(async function* () {}).query, { pluginDirs: [pluginDir] }).resolveAgentDefinition!('team:coder');
    const headless = createClaudeHarnessAdapter({ projectRoot: root, envAllowlist: [], pluginDirs: [pluginDir] })
      .resolveAgentDefinition!('team:coder');
    expect(sdk.ok).toBe(true);
    expect(sdk).toEqual(headless);
    if (sdk.ok) expect(sdk.path).toBe(join(pluginDir, 'agents', 'coder.md'));
  });

  it('fails closed on an agent no plugin dir defines, and when no plugin dirs are configured', () => {
    expect(makeAdapter(scripted(async function* () {}).query, { pluginDirs: [pluginDir] }).resolveAgentDefinition!('team:nobody').ok).toBe(false);
    expect(makeAdapter(scripted(async function* () {}).query).resolveAgentDefinition!('team:coder').ok).toBe(false);
  });
});

describe('agent-sdk: fails closed when the CLI did not load the agent', () => {
  it('ends the call and holds when init does not list the requested agent', async () => {
    let afterInit = false;
    const { query, closedEarly } = scripted(async function* () {
      yield initWith(['team:helper']);
      afterInit = true;
      yield RESULT_OK;
    });
    const err = await rejection(makeAdapter(query, { pluginDirs: [pluginDir] }).invoke(invocation({ agent: 'team:coder' })));
    expect(err.code).toBe(HARNESS_GATE_HOLD_CODE);
    expect(err.message).toContain("'team:coder'");
    expect(err.message).toContain('did not load');
    // The stream was ended at init rather than run to the end.
    expect(afterInit).toBe(false);
    expect(closedEarly()).toBe(true);
    expect(usageFromThrow(err)).toBeUndefined();
  });

  it('holds when init carries no agents list at all', async () => {
    const { query } = scripted(async function* () {
      yield initWith(undefined);
      yield RESULT_OK;
    });
    const err = await rejection(makeAdapter(query).invoke(invocation({ agent: 'team:coder' })));
    expect(err.code).toBe(HARNESS_GATE_HOLD_CODE);
    expect(err.message).toContain("'team:coder'");
  });

  it('checks the init list on every init message, not only the first', async () => {
    const { query } = scripted(async function* () {
      yield initWith(['team:coder']);
      yield initWith(['team:helper']);
      yield RESULT_OK;
    });
    const err = await rejection(makeAdapter(query).invoke(invocation({ agent: 'team:coder' })));
    expect(err.code).toBe(HARNESS_GATE_HOLD_CODE);
  });

  it('does not check init when no agent was requested', async () => {
    const { query } = scripted(async function* () {
      yield initWith(undefined);
      yield RESULT_OK;
    });
    await makeAdapter(query).invoke(invocation());
  });

  it('denies a main-thread call whose agent_type is not the requested agent, stops the CLI, and bills the call', async () => {
    let asked = 0;
    const gate: HarnessToolGate = () => {
      asked++;
      return { decision: 'allow' };
    };
    let answer: unknown;
    const { query } = scripted(async function* (ctx) {
      yield initWith(['team:coder']);
      answer = await ctx.hook({ tool_name: 'Bash', tool_input: { command: 'ls' } });
      yield RESULT_OK;
    });
    const events: HarnessEvent[] = [];
    const err = await rejection(
      makeAdapter(query).invoke(invocation({ agent: 'team:coder', gate, onEvent: (e) => events.push(e) })),
    );
    expect(err.code).toBe(HARNESS_GATE_HOLD_CODE);
    expect(err.message).toContain("'team:coder'");
    expect(asked).toBe(0);
    expect(answer).toMatchObject({ continue: false, hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(usageFromThrow(err)).toMatchObject({ tokens: 100, cost: 0.0123 });
    expect(events.find((e) => e.type === 'gate-decision')).toMatchObject({
      toolName: 'Bash', decision: 'hold', code: 'agent_not_loaded',
    });
  });

  it('denies a main-thread call that carries a different agent_type', async () => {
    let answer: unknown;
    const { query } = scripted(async function* (ctx) {
      yield initWith(['team:coder']);
      answer = await ctx.hook({ tool_name: 'Bash', tool_input: { command: 'ls' }, agent_type: 'general-purpose' });
      yield RESULT_OK;
    });
    const err = await rejection(makeAdapter(query).invoke(invocation({ agent: 'team:coder' })));
    expect(err.code).toBe(HARNESS_GATE_HOLD_CODE);
    expect(answer).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  });

  it('asks the gate for a main-thread call whose agent_type matches', async () => {
    let asked = 0;
    const gate: HarnessToolGate = () => {
      asked++;
      return { decision: 'allow' };
    };
    let answer: unknown;
    const { query } = scripted(async function* (ctx) {
      yield initWith(['team:coder']);
      answer = await ctx.hook({ tool_name: 'Read', tool_input: { file_path: 'a' }, agent_type: 'team:coder' });
      yield RESULT_OK;
    });
    const out = await makeAdapter(query).invoke(invocation({ agent: 'team:coder', gate }));
    expect(out.usage).toMatchObject({ tokens: 100 });
    expect(asked).toBe(1);
    expect(answer).toEqual({ continue: true });
  });

  it('does not apply the agent_type check to a subagent call (one with agent_id)', async () => {
    let asked = 0;
    const gate: HarnessToolGate = () => {
      asked++;
      return { decision: 'allow' };
    };
    let answer: unknown;
    const { query } = scripted(async function* (ctx) {
      yield initWith(['team:coder', 'team:helper']);
      answer = await ctx.hook({
        tool_name: 'Read', tool_input: { file_path: 'a' }, agent_id: 'sub-1', agent_type: 'team:helper',
      });
      yield RESULT_OK;
    });
    await makeAdapter(query).invoke(invocation({ agent: 'team:coder', gate }));
    expect(asked).toBe(1);
    expect(answer).toEqual({ continue: true });
  });

  it('does not apply the agent_type check when no agent was requested', async () => {
    let answer: unknown;
    const { query } = scripted(async function* (ctx) {
      yield initWith([]);
      answer = await ctx.hook({ tool_name: 'Read', tool_input: { file_path: 'a' } });
      yield RESULT_OK;
    });
    await makeAdapter(query).invoke(invocation());
    expect(answer).toEqual({ continue: true });
  });

  it('denies every later call after the mismatch without asking the gate', async () => {
    let asked = 0;
    const gate: HarnessToolGate = () => {
      asked++;
      return { decision: 'allow' };
    };
    let later: unknown;
    const { query } = scripted(async function* (ctx) {
      yield initWith(['team:coder']);
      await ctx.hook({ tool_name: 'Bash', tool_input: { command: 'ls' } });
      later = await ctx.hook({ tool_name: 'Read', tool_input: { file_path: 'a' }, agent_type: 'team:coder' });
      yield RESULT_OK;
    });
    const err = await rejection(makeAdapter(query).invoke(invocation({ agent: 'team:coder', gate })));
    expect(err.code).toBe(HARNESS_GATE_HOLD_CODE);
    expect(asked).toBe(0);
    expect(later).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  });
});

describe('agent-sdk: agent miss journaling and identity verification', () => {
  const holds = (events: HarnessEvent[]) => events.filter((e) => e.type === 'gate-decision');

  it('journals a gate-decision hold when init does not list the agent, naming the observed agents', async () => {
    const { query } = scripted(async function* () {
      yield initWith(['team:helper', 'team:other']);
      yield RESULT_OK;
    });
    const events: HarnessEvent[] = [];
    const err = await rejection(makeAdapter(query).invoke(invocation({ agent: 'team:coder', onEvent: (e) => events.push(e) })));
    expect(err.code).toBe(HARNESS_GATE_HOLD_CODE);
    const [hold] = holds(events);
    expect(holds(events)).toHaveLength(1);
    expect(hold).toMatchObject({ decision: 'hold', code: 'agent_not_loaded' });
    expect((hold as { reason: string }).reason).toContain("'team:coder'");
    expect((hold as { reason: string }).reason).toContain('[team:helper, team:other]');
    expect(err.message).toContain('[team:helper, team:other]');
  });

  it('says so when init carries no agents list', async () => {
    const { query } = scripted(async function* () {
      yield initWith(undefined);
      yield RESULT_OK;
    });
    const events: HarnessEvent[] = [];
    await rejection(makeAdapter(query).invoke(invocation({ agent: 'team:coder', onEvent: (e) => events.push(e) })));
    expect((holds(events)[0] as { reason: string }).reason).toContain('carries no agents list');
  });

  it('holds when the result arrives with no init message, and journals the hold', async () => {
    const { query } = scripted(async function* () {
      yield { type: 'system', subtype: 'hook_started' };
      yield RESULT_OK;
    });
    const events: HarnessEvent[] = [];
    const err = await rejection(makeAdapter(query).invoke(invocation({ agent: 'team:coder', onEvent: (e) => events.push(e) })));
    expect(err.code).toBe(HARNESS_GATE_HOLD_CODE);
    expect(err.message).toContain('no init message');
    expect(holds(events)[0]).toMatchObject({ decision: 'hold', code: 'agent_not_loaded' });
    // The turn ran and was billed, so the hold carries its usage.
    expect(usageFromThrow(err)).toMatchObject({ tokens: 100, cost: 0.0123 });
  });

  it('holds when an assistant message arrives with no init message, ending the stream', async () => {
    let after = false;
    const { query, closedEarly } = scripted(async function* () {
      yield { type: 'assistant', message: { content: [] } };
      after = true;
      yield RESULT_OK;
    });
    const err = await rejection(makeAdapter(query).invoke(invocation({ agent: 'team:coder' })));
    expect(err.code).toBe(HARNESS_GATE_HOLD_CODE);
    expect(after).toBe(false);
    expect(closedEarly()).toBe(true);
  });

  it('does not require init when no agent was requested', async () => {
    const { query } = scripted(async function* () {
      yield RESULT_OK;
    });
    await makeAdapter(query).invoke(invocation());
  });

  it('journals a later call after a miss as agent_not_loaded, not needs_human', async () => {
    const { query } = scripted(async function* (ctx) {
      yield initWith(['team:coder']);
      await ctx.hook({ tool_name: 'Bash', tool_input: { command: 'ls' } });
      await ctx.hook({ tool_name: 'Read', tool_input: { file_path: 'a' }, agent_type: 'team:coder', tool_use_id: 'tu-2' });
      yield RESULT_OK;
    });
    const events: HarnessEvent[] = [];
    await rejection(makeAdapter(query).invoke(invocation({ agent: 'team:coder', onEvent: (e) => events.push(e) })));
    const decisions = holds(events);
    expect(decisions).toHaveLength(2);
    expect(decisions[1]).toMatchObject({ toolName: 'Read', decision: 'deny', code: 'agent_not_loaded' });
  });
});

describe('agent-sdk: registration with agent and plugin dirs', () => {
  it('accepts _AGENT and _PLUGIN_DIRS and threads them into the bound adapter', async () => {
    const registry = buildHarnessDefinitionRegistry([
      { name: 'agent-sdk', envAllowlist: ['HOME'], agent: 'team:coder', pluginDirs: [pluginDir] },
    ]);
    const bound = bindHarnessDefinitions(registry, root).resolve('agent-sdk');
    if (!bound.ok) throw new Error(bound.error);
    expect(bound.adapter.agent).toBe('team:coder');
    expect(resolveHarnessAgent(bound.adapter, 'team:coder').ok).toBe(true);
  });

  it('carries resolveAgentDefinition through the load-time introspection registry', () => {
    const registry = buildHarnessDefinitionRegistry([{ name: 'agent-sdk', envAllowlist: ['HOME'], pluginDirs: [pluginDir] }]);
    const resolved = bindHarnessDefinitionsForIntrospection(registry).resolve('agent-sdk');
    if (!resolved.ok) throw new Error(resolved.error);
    expect(resolveHarnessAgent(resolved.adapter, 'team:coder').ok).toBe(true);
    expect(resolveHarnessAgent(resolved.adapter, 'team:nobody').ok).toBe(false);
  });

  it('fails registry construction on a plugin dir that does not exist', () => {
    expect(() =>
      buildHarnessDefinitionRegistry([{ name: 'agent-sdk', envAllowlist: ['HOME'], pluginDirs: [join(root, 'missing')] }]),
    ).toThrow('does not exist');
  });
});
