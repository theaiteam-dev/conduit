/**
 * claude-headless: named agents, per-run plugin dirs, and a run-scoped config
 * dir (issues #28, #29).
 *
 * #28 threads a per-station `agent` (station over adapter default, the WI-589
 * model precedent) to `--agent`, and per-run plugin dirs from engine config to
 * one `--plugin-dir` each. #29 is the reason the second half of this file
 * exists: with HOME allowlisted, the child also loads the operator's
 * ~/.claude (plugins, agents, settings, hooks, CLAUDE.md, claude.ai MCP
 * connectors). `isolateConfig` makes the adapter construct a fresh
 * CLAUDE_CONFIG_DIR per invocation holding only a link to the credentials
 * file, and pass --strict-mcp-config.
 *
 * Observed against claude 2.1.282 before this was written:
 *   - `--agent <unknown>` exits 1 with an empty stdout and names the agent on
 *     stderr, so the adapter's existing nonzero-exit path already fails it;
 *   - with CLAUDE_CONFIG_DIR set to a dir holding only `.credentials.json`,
 *     subscription auth works and no user plugin, user agent, MCP server or
 *     user CLAUDE.md is loaded;
 *   - a `--plugin-dir` plugin takes precedence over an ambient plugin of the
 *     same name, so a same-named ambient agent does not run.
 *
 * Every test drives the real factory through the injected `run` seam: no
 * process is spawned, and assertions are on the argv/env the adapter built.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, lstatSync, readlinkSync, readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClaudeHarnessAdapter, type ClaudeHarnessAdapterConfig } from './harness-adapter-claude';
import {
  buildHarnessDefinitionRegistry,
  bindHarnessDefinitions,
  bindHarnessDefinitionsForIntrospection,
  resolveHarnessAgent,
  makeFakeHarnessAdapter,
  type HarnessInvocation,
} from './harness-adapter';
import type { HarnessCommand, HarnessRunnerConfig, HarnessSpawnResult } from './harness-runner';

const RECORDED_SUCCESS = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  total_cost_usd: 0.01,
  usage: { input_tokens: 1, output_tokens: 1 },
});

interface RecordedCall {
  cmd: HarnessCommand;
  config: HarnessRunnerConfig;
  /** Listing of the injected CLAUDE_CONFIG_DIR at spawn time, when one was set. */
  configDirEntries?: string[];
}

function makeRun(result: Partial<HarnessSpawnResult> = {}): {
  run: (cmd: HarnessCommand, config: HarnessRunnerConfig) => Promise<HarnessSpawnResult>;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const run = async (cmd: HarnessCommand, config: HarnessRunnerConfig): Promise<HarnessSpawnResult> => {
    const dir = config.injectedEnv?.CLAUDE_CONFIG_DIR;
    calls.push({ cmd, config, ...(dir !== undefined ? { configDirEntries: readdirSync(dir).sort() } : {}) });
    return { exitCode: 0, stdout: RECORDED_SUCCESS, stderr: '', durationMs: 1, timedOut: false, ...result };
  };
  return { run, calls };
}

function invocation(over: Partial<HarnessInvocation> = {}): HarnessInvocation {
  return { prompt: 'do the task', inputs: [], tools: ['Read'], timeoutMs: 1_000, ...over };
}

function flagValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === flag) values.push(args[i + 1]!);
  return values;
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'conduit-claude-agent-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A plugin dir `<root>/<dirName>` whose plugin.json names it `pluginName`, with one agent. */
function writePluginWithAgent(dirName: string, pluginName: string, agentName: string, body: string): string {
  const dir = join(root, dirName);
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: pluginName }));
  mkdirSync(join(dir, 'agents'), { recursive: true });
  writeFileSync(join(dir, 'agents', `${agentName}.md`), `---\nname: ${agentName}\ndescription: d\n---\n${body}\n`);
  return dir;
}

function adapter(over: Partial<ClaudeHarnessAdapterConfig>) {
  return createClaudeHarnessAdapter({ projectRoot: '/p', envAllowlist: ['HOME', 'PATH'], ...over });
}

// ===========================================================================
// #28: --agent and --plugin-dir
// ===========================================================================

describe('claude-headless --agent: call.agent ?? config.agent (issue #28 AC1)', () => {
  async function agentFlag(configAgent: string | undefined, callAgent: string | undefined): Promise<string[]> {
    const { run, calls } = makeRun();
    await adapter({ agent: configAgent, run }).invoke(invocation({ agent: callAgent }));
    return flagValues(calls[0]!.cmd.args, '--agent');
  }

  it('the station agent (call.agent) wins over the adapter default', async () => {
    expect(await agentFlag('team:default', 'team:station')).toEqual(['team:station']);
  });

  it('uses the adapter default when the station declares none', async () => {
    expect(await agentFlag('team:default', undefined)).toEqual(['team:default']);
  });

  it('passes no --agent when neither is set', async () => {
    expect(await agentFlag(undefined, undefined)).toEqual([]);
  });

  it('exposes the configured default as adapter.agent, for the executor to compute the effective agent', () => {
    expect(adapter({ agent: 'team:default' }).agent).toBe('team:default');
    expect(adapter({}).agent).toBeUndefined();
  });
});

describe('claude-headless --plugin-dir: one flag per configured dir (issue #28 AC3)', () => {
  it('emits one --plugin-dir per entry, in configured order, before the prompt terminator', async () => {
    const a = writePluginWithAgent('a', 'a', 'x', 'A');
    const b = writePluginWithAgent('b', 'b', 'y', 'B');
    const { run, calls } = makeRun();
    await adapter({ pluginDirs: [a, b], run }).invoke(invocation());

    const args = calls[0]!.cmd.args;
    expect(flagValues(args, '--plugin-dir')).toEqual([a, b]);
    expect(args.lastIndexOf('--plugin-dir')).toBeLessThan(args.indexOf('--'));
  });

  it('emits no --plugin-dir when none are configured', async () => {
    const { run, calls } = makeRun();
    await adapter({ run }).invoke(invocation());
    expect(calls[0]!.cmd.args).not.toContain('--plugin-dir');
  });

  it('fails at construction on a plugin dir that does not exist, since the CLI ignores a missing one without error', () => {
    const missing = join(root, 'nope');
    expect(() => adapter({ pluginDirs: [missing] })).toThrow(missing);
  });

  it('fails at construction on a plugin dir that is a file (a .zip cannot be scanned for agent definitions)', () => {
    const zip = join(root, 'plugin.zip');
    writeFileSync(zip, 'PK');
    expect(() => adapter({ pluginDirs: [zip] })).toThrow('directory');
  });

  it('fails at construction on a relative plugin dir', () => {
    expect(() => adapter({ pluginDirs: ['plugins'] })).toThrow('absolute');
  });
});

describe('claude-headless resolveAgentDefinition (issue #28 AC4)', () => {
  it('locates the agent in the configured plugin dirs and hashes the file', () => {
    const dir = writePluginWithAgent('team', 'team', 'coder', 'Write code.');
    const file = join(dir, 'agents', 'coder.md');
    const result = adapter({ pluginDirs: [dir] }).resolveAgentDefinition!('team:coder');
    expect(result).toEqual({
      ok: true,
      path: file,
      sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
    });
  });

  it('fails closed when the agent is not in any configured plugin dir', () => {
    const dir = writePluginWithAgent('team', 'team', 'coder', 'Write code.');
    expect(adapter({ pluginDirs: [dir] }).resolveAgentDefinition!('team:nobody').ok).toBe(false);
  });
});

describe('resolveHarnessAgent (issue #28)', () => {
  it('fails closed on an adapter that cannot run a named agent, naming the adapter', () => {
    const { adapter: fake } = makeFakeHarnessAdapter({ name: 'no-agents' });
    const result = resolveHarnessAgent(fake, 'team:coder');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('no-agents');
  });
});

// ===========================================================================
// #29: run-scoped CLAUDE_CONFIG_DIR
// ===========================================================================

describe('claude-headless isolateConfig: a constructed config dir per invocation (issue #29)', () => {
  /** An operator config dir standing in for ~/.claude, with a credentials file. */
  function writeAmbient(): string {
    const ambient = join(root, 'ambient');
    mkdirSync(ambient, { recursive: true });
    writeFileSync(join(ambient, '.credentials.json'), '{"placeholder":true}');
    writeFileSync(join(ambient, 'settings.json'), '{"hooks":{}}');
    writeFileSync(join(ambient, 'CLAUDE.md'), 'operator instructions');
    mkdirSync(join(ambient, 'agents'), { recursive: true });
    return ambient;
  }

  it('leaves the child env and argv unchanged when isolateConfig is off (the default)', async () => {
    const { run, calls } = makeRun();
    await adapter({ run }).invoke(invocation());
    expect(calls[0]!.config.injectedEnv).toBeUndefined();
    expect(calls[0]!.cmd.args).not.toContain('--strict-mcp-config');
  });

  it('points CLAUDE_CONFIG_DIR at a fresh dir holding only a link to the operator credentials, and passes --strict-mcp-config', async () => {
    const ambient = writeAmbient();
    const { run, calls } = makeRun();
    await adapter({ isolateConfig: true, sourceEnv: { CLAUDE_CONFIG_DIR: ambient }, run }).invoke(invocation());

    const call = calls[0]!;
    const dir = call.config.injectedEnv!.CLAUDE_CONFIG_DIR!;
    expect(dir).not.toBe(ambient);
    expect(call.configDirEntries).toEqual(['.credentials.json']);
    expect(call.cmd.args).toContain('--strict-mcp-config');
    expect(call.cmd.args.indexOf('--strict-mcp-config')).toBeLessThan(call.cmd.args.indexOf('--'));
  });

  it('links the credentials file rather than copying it', async () => {
    const ambient = writeAmbient();
    let linkTarget: string | undefined;
    let isLink = false;
    const run = async (_cmd: HarnessCommand, config: HarnessRunnerConfig): Promise<HarnessSpawnResult> => {
      const link = join(config.injectedEnv!.CLAUDE_CONFIG_DIR!, '.credentials.json');
      isLink = lstatSync(link).isSymbolicLink();
      linkTarget = readlinkSync(link);
      return { exitCode: 0, stdout: RECORDED_SUCCESS, stderr: '', durationMs: 1, timedOut: false };
    };
    await adapter({ isolateConfig: true, sourceEnv: { CLAUDE_CONFIG_DIR: ambient }, run }).invoke(invocation());

    expect(isLink).toBe(true);
    expect(linkTarget).toBe(join(ambient, '.credentials.json'));
  });

  it('reads the operator credentials from $HOME/.claude when CLAUDE_CONFIG_DIR is unset in the kernel env', async () => {
    const home = join(root, 'home');
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', '.credentials.json'), '{}');
    let linkTarget: string | undefined;
    const run = async (_cmd: HarnessCommand, config: HarnessRunnerConfig): Promise<HarnessSpawnResult> => {
      linkTarget = readlinkSync(join(config.injectedEnv!.CLAUDE_CONFIG_DIR!, '.credentials.json'));
      return { exitCode: 0, stdout: RECORDED_SUCCESS, stderr: '', durationMs: 1, timedOut: false };
    };
    await adapter({ isolateConfig: true, sourceEnv: { HOME: home }, run }).invoke(invocation());

    expect(linkTarget).toBe(join(home, '.claude', '.credentials.json'));
  });

  it('removes the run-scoped dir after the invocation returns', async () => {
    const ambient = writeAmbient();
    const { run, calls } = makeRun();
    await adapter({ isolateConfig: true, sourceEnv: { CLAUDE_CONFIG_DIR: ambient }, run }).invoke(invocation());

    expect(existsSync(calls[0]!.config.injectedEnv!.CLAUDE_CONFIG_DIR!)).toBe(false);
    // The operator's own file is untouched.
    expect(existsSync(join(ambient, '.credentials.json'))).toBe(true);
  });

  it('removes the run-scoped dir when the invocation fails', async () => {
    const ambient = writeAmbient();
    const { run, calls } = makeRun({ exitCode: 1, stdout: '', stderr: "--agent 'x' not found" });
    await expect(
      adapter({ isolateConfig: true, sourceEnv: { CLAUDE_CONFIG_DIR: ambient }, run }).invoke(invocation()),
    ).rejects.toThrow('exited with code 1');

    expect(existsSync(calls[0]!.config.injectedEnv!.CLAUDE_CONFIG_DIR!)).toBe(false);
  });

  it('fails before spawning when there is no credentials file and no token variable is allowlisted', async () => {
    const empty = join(root, 'empty-config');
    mkdirSync(empty);
    const { run, calls } = makeRun();
    await expect(
      adapter({ isolateConfig: true, sourceEnv: { CLAUDE_CONFIG_DIR: empty }, run }).invoke(invocation()),
    ).rejects.toThrow('.credentials.json');
    expect(calls).toHaveLength(0);
  });

  it('runs with an empty config dir when a token variable is allowlisted and set instead of a credentials file', async () => {
    const empty = join(root, 'empty-config');
    mkdirSync(empty);
    const { run, calls } = makeRun();
    await adapter({
      isolateConfig: true,
      envAllowlist: ['PATH', 'CLAUDE_CODE_OAUTH_TOKEN'],
      sourceEnv: { CLAUDE_CONFIG_DIR: empty, CLAUDE_CODE_OAUTH_TOKEN: 'tok' },
      run,
    }).invoke(invocation());

    expect(calls[0]!.configDirEntries).toEqual([]);
  });

  it('treats a falsy CLAUDE_CODE_USE_BEDROCK="0" as not authenticating: still fails closed with no credentials file', async () => {
    const empty = join(root, 'empty-config');
    mkdirSync(empty);
    const { run, calls } = makeRun();
    await expect(
      adapter({
        isolateConfig: true,
        envAllowlist: ['PATH', 'CLAUDE_CODE_USE_BEDROCK'],
        sourceEnv: { CLAUDE_CONFIG_DIR: empty, CLAUDE_CODE_USE_BEDROCK: '0' },
        run,
      }).invoke(invocation()),
    ).rejects.toThrow('.credentials.json');
    expect(calls).toHaveLength(0);
  });

  it('treats a falsy CLAUDE_CODE_USE_BEDROCK="false" as not authenticating: still links the credentials file', async () => {
    const ambient = writeAmbient();
    const { run, calls } = makeRun();
    await adapter({
      isolateConfig: true,
      envAllowlist: ['PATH', 'CLAUDE_CODE_USE_BEDROCK'],
      sourceEnv: { CLAUDE_CONFIG_DIR: ambient, CLAUDE_CODE_USE_BEDROCK: 'false' },
      run,
    }).invoke(invocation());

    expect(calls[0]!.configDirEntries).toEqual(['.credentials.json']);
  });

  it('treats a truthy CLAUDE_CODE_USE_BEDROCK="1" as authenticating: runs with an empty config dir and no credentials file', async () => {
    const empty = join(root, 'empty-config');
    mkdirSync(empty);
    const { run, calls } = makeRun();
    await adapter({
      isolateConfig: true,
      envAllowlist: ['PATH', 'CLAUDE_CODE_USE_BEDROCK'],
      sourceEnv: { CLAUDE_CONFIG_DIR: empty, CLAUDE_CODE_USE_BEDROCK: '1' },
      run,
    }).invoke(invocation());

    expect(calls[0]!.configDirEntries).toEqual([]);
  });

  it('issue #29 AC1: with an identically named agent in ambient config, the child gets the --plugin-dir agent and cannot see the ambient one', async () => {
    // Ambient: the operator's config carries a plugin named `team` with an
    // agent `coder` (the CLI loads ~/.claude/skills/<plugin> as a plugin).
    const ambient = writeAmbient();
    const ambientPlugin = join(ambient, 'skills', 'team');
    mkdirSync(join(ambientPlugin, '.claude-plugin'), { recursive: true });
    writeFileSync(join(ambientPlugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'team' }));
    mkdirSync(join(ambientPlugin, 'agents'), { recursive: true });
    writeFileSync(join(ambientPlugin, 'agents', 'coder.md'), '---\nname: coder\ndescription: d\n---\nAMBIENT\n');
    // Supplied: a --plugin-dir plugin of the same name defining the same agent.
    const supplied = writePluginWithAgent('supplied', 'team', 'coder', 'SUPPLIED');

    const { run, calls } = makeRun();
    const claude = adapter({ pluginDirs: [supplied], isolateConfig: true, sourceEnv: { CLAUDE_CONFIG_DIR: ambient }, run });
    await claude.invoke(invocation({ agent: 'team:coder' }));

    const call = calls[0]!;
    expect(flagValues(call.cmd.args, '--agent')).toEqual(['team:coder']);
    expect(flagValues(call.cmd.args, '--plugin-dir')).toEqual([supplied]);
    // The child's config dir is not the ambient one and holds none of its
    // plugins, agents, settings or CLAUDE.md.
    expect(call.config.injectedEnv!.CLAUDE_CONFIG_DIR).not.toBe(ambient);
    expect(call.configDirEntries).toEqual(['.credentials.json']);
    // And the definition the kernel hashes is the supplied file, not the ambient one.
    const resolved = claude.resolveAgentDefinition!('team:coder');
    expect(resolved.ok && resolved.path).toBe(join(supplied, 'agents', 'coder.md'));
  });
});

// ===========================================================================
// Registry wiring
// ===========================================================================

describe('definition registry threads agent / plugin dirs / isolation (issues #28, #29)', () => {
  it('binds a claude-headless def carrying agent and pluginDirs into the invocable adapter', async () => {
    const dir = writePluginWithAgent('team', 'team', 'coder', 'Write code.');
    const { run, calls } = makeRun();
    const registry = buildHarnessDefinitionRegistry(
      [{ name: 'claude-headless', envAllowlist: ['HOME'], agent: 'team:coder', pluginDirs: [dir] }],
      { run },
    );
    const bound = bindHarnessDefinitions(registry, '/p').resolve('claude-headless');
    if (!bound.ok) throw new Error(bound.error);
    expect(bound.adapter.agent).toBe('team:coder');
    await bound.adapter.invoke(invocation());
    expect(flagValues(calls[0]!.cmd.args, '--plugin-dir')).toEqual([dir]);
    expect(flagValues(calls[0]!.cmd.args, '--agent')).toEqual(['team:coder']);
  });

  it('carries resolveAgentDefinition through the load-time introspection registry', () => {
    const dir = writePluginWithAgent('team', 'team', 'coder', 'Write code.');
    const registry = buildHarnessDefinitionRegistry([
      { name: 'claude-headless', envAllowlist: ['HOME'], pluginDirs: [dir] },
    ]);
    const resolved = bindHarnessDefinitionsForIntrospection(registry).resolve('claude-headless');
    if (!resolved.ok) throw new Error(resolved.error);
    expect(resolveHarnessAgent(resolved.adapter, 'team:coder').ok).toBe(true);
    expect(resolveHarnessAgent(resolved.adapter, 'team:nobody').ok).toBe(false);
  });

  it.each([
    ['agent', { agent: 'team:coder' }],
    ['pluginDirs', { pluginDirs: ['/opt/plugins'] }],
    ['isolateConfig', { isolateConfig: true }],
  ])('rejects %s on an adapter that does not support it, rather than ignoring it', (option, extra) => {
    expect(() =>
      buildHarnessDefinitionRegistry([{ name: 'codex-exec', envAllowlist: ['HOME'], ...extra }]),
    ).toThrow(option === 'pluginDirs' ? 'PLUGIN_DIRS' : option === 'agent' ? 'AGENT' : 'ISOLATE_CONFIG');
  });
});
