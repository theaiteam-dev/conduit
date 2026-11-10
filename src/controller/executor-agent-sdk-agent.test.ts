/**
 * Named agents on agent-sdk stations, through runExecutor (issue #109).
 *
 * The real agent-sdk adapter with a scripted `query()`, so the whole path is
 * the one the shipping binary runs: the dispatch-time `resolveHarnessAgent`,
 * the agent-aware prompt_template_version, the SDK `agent` and `plugins`
 * options, and the hold when the CLI did not load the agent. Covered for the
 * maker (`worker.agent`) and the gate critic (`check.critic.agent`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import { loadFlow } from '../flow/load';
import type { FlowConfig } from '../types/kernel';
import { runExecutor } from './executor';
import type { RunEngineArgs } from '../cli/main';
import type { ModelAdapter } from '../worker/adapter';
import { createHarnessRegistry, type HarnessRegistry } from '../worker/harness-adapter';
import { createAgentSdkHarnessAdapter, type AgentSdkQueryFn } from '../worker/harness-adapter-agent-sdk';
import { resolveClaudePluginAgent } from '../worker/claude-plugin-agents';

const throwingModel: ModelAdapter = {
  async call() {
    throw new Error('ModelAdapter.call must not be used by a harness station');
  },
};

const RESULT_OK = {
  type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.001,
  usage: { input_tokens: 5, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  modelUsage: {},
};

let originalCwd: string;
let dir: string;
let pluginDir: string;
let db: ConduitDB | null;

beforeEach(() => {
  originalCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), 'conduit-sdk-agent-'));
  pluginDir = mkdtempSync(join(tmpdir(), 'conduit-sdk-agent-plugin-'));
  mkdirSync(join(pluginDir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'team' }));
  mkdirSync(join(pluginDir, 'agents'), { recursive: true });
  for (const name of ['coder', 'reviewer']) {
    writeFileSync(join(pluginDir, 'agents', `${name}.md`), `---\nname: ${name}\ndescription: d\n---\n${name} body\n`);
  }
  process.chdir(dir);
  db = null;
});

afterEach(() => {
  if (db) db.close();
  db = null;
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
  rmSync(pluginDir, { recursive: true, force: true });
});

interface Seen {
  role: 'maker' | 'critic';
  options: Options;
}

/**
 * A scripted SDK. The maker writes result.json, the critic a passing verdict.
 * `loaded` lists the agents the fake CLI reports in its init message.
 */
function fakeSdk(loaded: string[]): { query: AgentSdkQueryFn; seen: Seen[] } {
  const seen: Seen[] = [];
  const query: AgentSdkQueryFn = ({ prompt, options }) => {
    const role = prompt.includes('VERIFY') ? 'critic' : 'maker';
    seen.push({ role, options });
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', agents: loaded } as never;
        if (role === 'maker') {
          writeFileSync(join(dir, 'result.json'), JSON.stringify({ summary: 'ok' }), 'utf-8');
        } else {
          writeFileSync(join(dir, 'verdict.json'), JSON.stringify({ verdict: 'pass', findings: [] }), 'utf-8');
        }
        yield RESULT_OK as never;
      },
    };
  };
  return { query, seen };
}

function registryFor(query: AgentSdkQueryFn): HarnessRegistry {
  return createHarnessRegistry([
    createAgentSdkHarnessAdapter({
      projectRoot: dir, envAllowlist: [], command: '/bin/sh', sourceEnv: {}, query, pluginDirs: [pluginDir],
      containment: { mechanism: 'process-group', reason: 'unit test' },
    }),
  ]);
}

function writeFlow(registry: HarnessRegistry, opts: { makerAgent?: string; criticAgent?: string } = {}): FlowConfig {
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'coder.md'), 'BUILD {{task.json}}');
  writeFileSync(join(dir, 'prompts', 'verify.md'), 'VERIFY {{result.json}}');
  writeFileSync(join(dir, 'task.json'), '{"task":"build"}');
  const makerAgent = opts.makerAgent !== undefined ? `\n      agent: ${opts.makerAgent}` : '';
  const check =
    opts.criticAgent !== undefined
      ? `
    check:
      kind: gate
      critic: { role: critic, harness: agent-sdk, agent: ${opts.criticAgent}, tools: [Read, Write], prompt_file: prompts/verify.md, prompt_version: "1" }
      on_reject: coder
      rework_cap: 2`
      : '';
  writeFileSync(
    join(dir, 'flow.yaml'),
    `
flow: sdk-agent
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 100000 }
  per_card: { max_execution_attempts: 3 }
  liveness: { no_progress_minutes: 3 }
terminal_lanes: [done, scrap, hold]
stations:
  - id: coder
    worker:
      kind: harness
      harness: agent-sdk${makerAgent}
      prompt_file: prompts/coder.md
      prompt_version: "1"
      tools: [Read, Write]
      output_schema:
        fields:
          - { name: summary, type: string, required: true }
    inputs: [task.json]
    outputs: [result.json]
    next: done${check}
`,
  );
  const loaded = loadFlow(join(dir, 'flow.yaml'), { harnessRegistry: registry });
  if (!loaded.ok) throw new Error(`fixture flow invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

function seedCard(target: ConduitDB): void {
  target.insertCard({
    run_id: DEFAULT_RUN_ID, id: 'entry', parent_id: null, lane: 'coder', status: 'ready',
    attempt: 0, wave: 0, owned_paths: ['task.json', 'result.json'], rework_count: 0,
  });
}

async function run(flow: FlowConfig, registry: HarnessRegistry): Promise<void> {
  await runExecutor({
    db: db!, flow, now: () => 1000, adapter: throwingModel, io: { out: () => {}, err: () => {} }, harnessRegistry: registry,
  } as RunEngineArgs);
}

function openDb(): ConduitDB {
  const opened = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(opened.getStateDb());
  seedCard(opened);
  return opened;
}

const sha = (agent: string): string => {
  const r = resolveClaudePluginAgent([pluginDir], agent);
  if (!r.ok) throw new Error(r.error);
  return r.sha256;
};

describe('issue #109: a named agent on an agent-sdk maker', () => {
  it('runs the agent through the SDK options and stamps its definition file', async () => {
    db = openDb();
    const { query, seen } = fakeSdk(['team:coder']);
    const registry = registryFor(query);
    await run(writeFlow(registry, { makerAgent: 'team:coder' }), registry);

    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('done');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.options.agent).toBe('team:coder');
    expect(seen[0]!.options.plugins).toEqual([{ type: 'local', path: pluginDir }]);
    const span = db.getJournalSpansForRun(DEFAULT_RUN_ID, 'entry').find((s) => s.name === 'coder.harness');
    expect(span?.agent).toBe('team:coder');
    expect(span?.agentSha256).toBe(sha('team:coder'));
  });

  it('holds the card, spending no attempt, when the CLI did not load the agent', async () => {
    db = openDb();
    const { query, seen } = fakeSdk(['team:other']);
    const registry = registryFor(query);
    await run(writeFlow(registry, { makerAgent: 'team:coder' }), registry);

    const card = db.getCard(DEFAULT_RUN_ID, 'entry');
    expect(card?.lane).toBe('hold');
    expect(card?.status).toBe('held');
    // One call, not max_execution_attempts: a hold is not a failed attempt to retry.
    expect(seen).toHaveLength(1);
  });

  it('holds without calling the SDK when the agent file is gone at dispatch', async () => {
    db = openDb();
    const { query, seen } = fakeSdk(['team:coder']);
    const registry = registryFor(query);
    const flow = writeFlow(registry, { makerAgent: 'team:coder' });
    rmSync(join(pluginDir, 'agents', 'coder.md'));
    await run(flow, registry);

    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('hold');
    expect(seen).toHaveLength(0);
  });
});

describe('issue #109: a named agent on an agent-sdk gate critic', () => {
  it('passes check.critic.agent to the critic call and journals its definition hash', async () => {
    db = openDb();
    const { query, seen } = fakeSdk(['team:reviewer']);
    const registry = registryFor(query);
    await run(writeFlow(registry, { criticAgent: 'team:reviewer' }), registry);

    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('done');
    const critic = seen.find((s) => s.role === 'critic');
    expect(critic?.options.agent).toBe('team:reviewer');
    expect(seen.find((s) => s.role === 'maker')?.options.agent).toBeUndefined();
    const span = db.getJournalSpansForRun(DEFAULT_RUN_ID, 'entry').find((s) => s.name === 'coder.harness-critic');
    expect(span?.agent).toBe('team:reviewer');
    expect(span?.agentSha256).toBe(sha('team:reviewer'));
  });

  it('holds the card when the CLI did not load the critic agent', async () => {
    db = openDb();
    const { query, seen } = fakeSdk([]);
    const registry = registryFor(query);
    await run(writeFlow(registry, { criticAgent: 'team:reviewer' }), registry);

    expect(db.getCard(DEFAULT_RUN_ID, 'entry')?.lane).toBe('hold');
    expect(seen.filter((s) => s.role === 'critic')).toHaveLength(1);
  });
});
