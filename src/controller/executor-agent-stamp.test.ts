/**
 * Executor wiring for a harness station's named agent (issue #28).
 *
 * An agent is a prompt: it carries a system prompt, a tool allowlist and a
 * model preference. So it rides the binding stamp's promptTemplateVersion
 * input, the same way worker.uses skills do (executor-skill-stamp.test.ts),
 * rather than a new stamp field. The executor:
 *   - computes `effectiveAgent = station.agent ?? adapter.agent` once, threads
 *     it into HarnessInvocation.agent, and folds the agent NAME plus the SHA-256
 *     of its definition file into promptTemplateVersion, so an edited agent
 *     body invalidates the checkpoint and cascades downstream;
 *   - resolves the definition at dispatch through the adapter and hard-pauses
 *     the card to hold when it cannot be found, without invoking the harness.
 *     Hashing the name alone would let an edited agent replay from a stale
 *     checkpoint.
 *
 * The fake adapter below resolves definitions with the real plugin-dir lookup
 * (claude-plugin-agents.ts) over a temp plugin, so an edit to the file on disk
 * is what moves the stamp. Stamps are observed through the persisted
 * checkpoints table, as in the skill-stamp tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import type { ModelAdapter, ModelCall, ModelResponse } from '../worker/adapter';
import type { RunEngineArgs } from '../cli/main';
import type { FlowConfig } from '../types/kernel';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import { loadFlow } from '../flow/load';
import { runExecutor } from './executor';
import {
  createHarnessRegistry,
  type HarnessAdapter,
  type HarnessInvocation,
  type HarnessRegistry,
} from '../worker/harness-adapter';
import { resolveClaudePluginAgent } from '../worker/claude-plugin-agents';

const SECONDS = (n: number) => () => n;
const io = { out: (_l: string) => {}, err: (_l: string) => {} };

let projectDir: string;
let pluginDir: string;
let originalCwd: string;
let db: ConduitDB | null;

beforeEach(() => {
  originalCwd = process.cwd();
  projectDir = mkdtempSync(join(tmpdir(), 'conduit-agent-stamp-'));
  pluginDir = mkdtempSync(join(tmpdir(), 'conduit-agent-plugin-'));
  mkdirSync(join(pluginDir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'team' }));
  process.chdir(projectDir);
  db = null;
});

afterEach(() => {
  if (db) {
    db.close();
    db = null;
  }
  process.chdir(originalCwd);
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(pluginDir, { recursive: true, force: true });
});

function writeAgent(name: string, body: string): void {
  mkdirSync(join(pluginDir, 'agents'), { recursive: true });
  writeFileSync(join(pluginDir, 'agents', `${name}.md`), `---\nname: ${name}\ndescription: d\n---\n${body}\n`);
}

function removeAgent(name: string): void {
  rmSync(join(pluginDir, 'agents', `${name}.md`), { force: true });
}

/**
 * A harness fake that runs named agents out of `pluginDir`. It writes its
 * declared output so the station completes and checkpoints.
 */
function makeAgentHarness(opts: { agent?: string; tokens?: number } = {}): {
  adapter: HarnessAdapter;
  calls: HarnessInvocation[];
} {
  const calls: HarnessInvocation[] = [];
  const adapter: HarnessAdapter = {
    name: 'fake-claude',
    reportsUsage: true,
    canRestrictTools: true,
    ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
    resolveAgentDefinition: (agent: string) => resolveClaudePluginAgent([pluginDir], agent),
    async probeBinary() {
      return { present: true };
    },
    async invoke(call: HarnessInvocation) {
      calls.push(call);
      writeFileSync(join(process.cwd(), 'mid.json'), JSON.stringify({ summary: 'done' }), 'utf-8');
      return { outputs: [], usage: { tokens: opts.tokens ?? 10, cost: 0.001 } };
    },
  };
  return { adapter, calls };
}

/** Stage b's transform worker. */
function makeStubModel(): { adapter: ModelAdapter; calls: ModelCall[] } {
  const calls: ModelCall[] = [];
  const adapter: ModelAdapter = {
    async call(req: ModelCall): Promise<ModelResponse> {
      calls.push(req);
      return { text: JSON.stringify({ idea: 'an idea' }), inputTokens: 1, outputTokens: 1, costUsd: 0.001 };
    },
  };
  return { adapter, calls };
}

/**
 * a (harness, optional agent) -> b (transform consuming a's output) -> done.
 * Everything but the agent is held constant so a stamp change is attributable
 * to the agent.
 */
function writeFlow(registry: HarnessRegistry, opts: { agent?: string; maxTokens?: number } = {}): FlowConfig {
  mkdirSync(join(projectDir, 'prompts'), { recursive: true });
  writeFileSync(join(projectDir, 'prompts', 'a.md'), 'Constant prompt for stage A.');
  writeFileSync(join(projectDir, 'prompts', 'b.md'), 'Stage B from {{mid.json}}');
  const agentLine = opts.agent !== undefined ? `\n      agent: ${opts.agent}` : '';
  writeFileSync(
    join(projectDir, 'flow.yaml'),
    `
flow: agent-stamp
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: ${opts.maxTokens ?? 100000} }
  per_card: { max_execution_attempts: 2 }
  liveness: { no_progress_minutes: 3 }
defaults: { cap_policy: scrap, on_dep_scrap: hold }
terminal_lanes: [done, scrap, hold]
stations:
  - id: a
    worker:
      kind: harness
      harness: fake-claude${agentLine}
      prompt_file: prompts/a.md
      prompt_version: "1"
      tools: [Read, Write]
      output_schema:
        fields:
          - { name: summary, type: string, required: true }
    inputs: []
    outputs: [mid.json]
    next: b
  - id: b
    worker:
      kind: transform
      model: gpt-4o-mini
      prompt_file: prompts/b.md
      prompt_version: "1"
      output_schema: { fields: [{ name: idea, type: string, required: true }] }
    inputs: [mid.json]
    outputs: [final.json]
    next: done
`,
  );
  const loaded = loadFlow(join(projectDir, 'flow.yaml'), { harnessRegistry: registry });
  if (!loaded.ok) throw new Error(`fixture flow invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

function openDb(): ConduitDB {
  const opened = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(opened.getStateDb());
  opened.insertCard({
    run_id: DEFAULT_RUN_ID, id: 'c', parent_id: null, lane: 'a', status: 'ready',
    attempt: 0, wave: 0, owned_paths: ['mid.json', 'final.json'], rework_count: 0,
  });
  return opened;
}

function resetToA(target: ConduitDB): void {
  target.getStateDb().prepare("UPDATE cards SET lane = 'a', status = 'ready' WHERE id = 'c'").run();
}

async function run(flow: FlowConfig, registry: HarnessRegistry, model: ModelAdapter, now: number): Promise<void> {
  await runExecutor({ db: db!, flow, now: SECONDS(now), adapter: model, io, harnessRegistry: registry } as RunEngineArgs);
}

function checkpointCount(target: ConduitDB, station: string): number {
  return (
    target.getStateDb().prepare('SELECT COUNT(*) AS n FROM checkpoints WHERE station = $s').get({ $s: station }) as {
      n: number;
    }
  ).n;
}

function stampOf(target: ConduitDB, station: string): string {
  const row = target
    .getStateDb()
    .prepare('SELECT binding_stamp FROM checkpoints WHERE station = $s')
    .get({ $s: station }) as { binding_stamp: string } | undefined;
  if (!row) throw new Error(`no checkpoint recorded for station '${station}'`);
  return row.binding_stamp;
}

/** Run the flow once in a throwaway DB and return stage a's persisted stamp. */
async function stampForA(harness: HarnessAdapter, agent: string | undefined): Promise<string> {
  const registry = createHarnessRegistry([harness]);
  const flow = writeFlow(registry, agent !== undefined ? { agent } : {});
  const local = openDb();
  try {
    await runExecutor({
      db: local, flow, now: SECONDS(1000), adapter: makeStubModel().adapter, io, harnessRegistry: registry,
    } as RunEngineArgs);
    if (local.getCard(DEFAULT_RUN_ID, 'c')?.lane !== 'done') throw new Error('fixture run did not reach done');
    return stampOf(local, 'a');
  } finally {
    local.close();
  }
}

describe('effective agent reaches HarnessInvocation.agent (issue #28 AC1)', () => {
  it('passes the station agent, winning over the adapter default', async () => {
    writeAgent('station', 'Station agent.');
    writeAgent('default', 'Default agent.');
    db = openDb();
    const harness = makeAgentHarness({ agent: 'team:default' });
    const registry = createHarnessRegistry([harness.adapter]);
    await run(writeFlow(registry, { agent: 'team:station' }), registry, makeStubModel().adapter, 1000);
    expect(harness.calls[0]!.agent).toBe('team:station');
  });

  it('passes the adapter default when the station declares none', async () => {
    writeAgent('default', 'Default agent.');
    db = openDb();
    const harness = makeAgentHarness({ agent: 'team:default' });
    const registry = createHarnessRegistry([harness.adapter]);
    await run(writeFlow(registry), registry, makeStubModel().adapter, 1000);
    expect(harness.calls[0]!.agent).toBe('team:default');
  });

  it('passes no agent when neither is set', async () => {
    db = openDb();
    const harness = makeAgentHarness();
    const registry = createHarnessRegistry([harness.adapter]);
    await run(writeFlow(registry), registry, makeStubModel().adapter, 1000);
    expect(harness.calls[0]!.agent).toBeUndefined();
  });
});

describe('agent folds into promptTemplateVersion (issue #28 AC4)', () => {
  it('editing the agent body re-executes the station AND its downstream consumer on resume', async () => {
    writeAgent('coder', 'Original agent body.');
    db = openDb();
    const harness = makeAgentHarness();
    const model = makeStubModel();
    const registry = createHarnessRegistry([harness.adapter]);
    const flow = writeFlow(registry, { agent: 'team:coder' });

    await run(flow, registry, model.adapter, 1000);
    expect(db.getCard(DEFAULT_RUN_ID, 'c')?.lane).toBe('done');
    expect(checkpointCount(db, 'a')).toBe(1);
    expect(checkpointCount(db, 'b')).toBe(1);
    expect(harness.calls).toHaveLength(1);
    expect(model.calls).toHaveLength(1);

    writeAgent('coder', 'REVISED agent body with a different system prompt.');
    resetToA(db);
    await run(flow, registry, model.adapter, 2000);

    expect(db.getCard(DEFAULT_RUN_ID, 'c')?.lane).toBe('done');
    expect(harness.calls).toHaveLength(2);
    expect(model.calls).toHaveLength(2);
  });

  it('the cascade drops the downstream checkpoint before it re-runs', async () => {
    writeAgent('coder', 'Original agent body.');
    db = openDb();
    const model = makeStubModel();
    const big = makeAgentHarness();
    const bigRegistry = createHarnessRegistry([big.adapter]);
    await run(writeFlow(bigRegistry, { agent: 'team:coder' }), bigRegistry, model.adapter, 1000);
    expect(checkpointCount(db, 'b')).toBe(1);

    // Edit the agent, then resume under a token budget the re-run of a alone
    // exceeds, so the andon halts before b runs and the cascade is observable.
    writeAgent('coder', 'EDITED agent body.');
    const tiny = makeAgentHarness({ tokens: 50 });
    const tinyRegistry = createHarnessRegistry([tiny.adapter]);
    const tinyFlow = writeFlow(tinyRegistry, { agent: 'team:coder', maxTokens: 1 });
    resetToA(db);
    await run(tinyFlow, tinyRegistry, model.adapter, 2000);

    expect(tiny.calls).toHaveLength(1);
    expect(checkpointCount(db, 'b')).toBe(0);
    expect(db.getCard(DEFAULT_RUN_ID, 'c')?.lane).not.toBe('done');
  });

  it('an unchanged agent keeps skip-on-resume: no re-invocation', async () => {
    writeAgent('coder', 'Stable agent body.');
    db = openDb();
    const harness = makeAgentHarness();
    const model = makeStubModel();
    const registry = createHarnessRegistry([harness.adapter]);
    const flow = writeFlow(registry, { agent: 'team:coder' });

    await run(flow, registry, model.adapter, 1000);
    resetToA(db);
    await run(flow, registry, model.adapter, 2000);

    expect(harness.calls).toHaveLength(1);
    expect(model.calls).toHaveLength(1);
  });

  it('folds the agent name too: two agents with identical bodies stamp differently', async () => {
    writeAgent('one', 'Identical body.');
    writeAgent('two', 'Identical body.');
    const s1 = await stampForA(makeAgentHarness().adapter, 'team:one');
    const s2 = await stampForA(makeAgentHarness().adapter, 'team:two');
    expect(s1).not.toBe(s2);
  });

  it('an adapter-default agent moves the stamp exactly like a station agent does', async () => {
    writeAgent('coder', 'Body.');
    const viaStation = await stampForA(makeAgentHarness().adapter, 'team:coder');
    const viaDefault = await stampForA(makeAgentHarness({ agent: 'team:coder' }).adapter, undefined);
    expect(viaDefault).toBe(viaStation);
  });

  it('leaves a station with no agent stamped exactly as before: the bare prompt_version', async () => {
    const plain: HarnessAdapter = { ...makeAgentHarness().adapter };
    delete plain.resolveAgentDefinition;
    const withCapability = await stampForA(makeAgentHarness().adapter, undefined);
    const withoutCapability = await stampForA(plain, undefined);
    expect(withCapability).toBe(withoutCapability);
    // And an agent-bearing station differs from it.
    writeAgent('coder', 'Body.');
    expect(await stampForA(makeAgentHarness().adapter, 'team:coder')).not.toBe(withCapability);
  });
});

describe('an agent that cannot be resolved at dispatch fails closed (issue #28 AC5)', () => {
  it('hard-pauses the card to hold without invoking the harness when the definition file is gone', async () => {
    writeAgent('coder', 'Body.');
    db = openDb();
    const harness = makeAgentHarness();
    const registry = createHarnessRegistry([harness.adapter]);
    // Loads cleanly (the file exists at load), then the file disappears.
    const flow = writeFlow(registry, { agent: 'team:coder' });
    removeAgent('coder');

    await run(flow, registry, makeStubModel().adapter, 1000);

    expect(harness.calls).toHaveLength(0);
    expect(db.getCard(DEFAULT_RUN_ID, 'c')?.lane).toBe('hold');
  });

  it('hard-pauses when the adapter default agent cannot be resolved', async () => {
    db = openDb();
    const harness = makeAgentHarness({ agent: 'team:missing' });
    const registry = createHarnessRegistry([harness.adapter]);

    await run(writeFlow(registry), registry, makeStubModel().adapter, 1000);

    expect(harness.calls).toHaveLength(0);
    expect(db.getCard(DEFAULT_RUN_ID, 'c')?.lane).toBe('hold');
  });
});
