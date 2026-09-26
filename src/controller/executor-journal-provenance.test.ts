/**
 * Journal provenance for station executions that compute a binding stamp.
 *
 * The binding stamp (SPEC §5) decides checkpoint reuse, but the checkpoints
 * table is per-run, deleted on invalidation, and holds only a one-way hash. The
 * kaizen pipe (SPEC §13) has to attribute each journaled result to the config
 * version that produced it, across runs. So every span a stamped execution
 * writes carries:
 *   - binding_stamp: the stamp the checkpoint was (or would be) written under;
 *   - prompt_template_version: the effective value folded into that stamp
 *     (prompt_version with the agent or skills folded in);
 *   - agent / agent_sha256: the effective named agent and the SHA-256 of its
 *     definition file, or NULL when the station runs none.
 *
 * Every assertion reads the rows back from the journal DB through
 * getJournalSpansForRun, never an in-memory value, and compares the stamp to
 * the one persisted in the checkpoints table.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import type { ModelAdapter, ModelCall, ModelResponse } from '../worker/adapter';
import type { RunEngineArgs } from '../cli/main';
import type { Card, FlowConfig } from '../types/kernel';
import { openConduitDB, type ConduitDB, type StoredJournalSpan, DEFAULT_RUN_ID } from '../persistence/db';
import { ensureCheckpointSchema, computeAgentAwarePromptTemplateVersion } from '../checkpoint/checkpoint';
import { loadFlow } from '../flow/load';
import { runExecutor, type SubflowSeam } from './executor';
import {
  createHarnessRegistry,
  type HarnessAdapter,
  type HarnessInvocation,
  type HarnessRegistry,
} from '../worker/harness-adapter';
import { resolveClaudePluginAgent } from '../worker/claude-plugin-agents';

const io = { out: (_l: string) => {}, err: (_l: string) => {} };

let projectDir: string;
let pluginDir: string;
let originalCwd: string;
let db: ConduitDB | null;

beforeEach(() => {
  originalCwd = process.cwd();
  projectDir = mkdtempSync(join(tmpdir(), 'conduit-journal-prov-'));
  pluginDir = mkdtempSync(join(tmpdir(), 'conduit-journal-prov-plugin-'));
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

function agentPath(name: string): string {
  return join(pluginDir, 'agents', `${name}.md`);
}

function writeAgent(name: string, body: string): void {
  mkdirSync(join(pluginDir, 'agents'), { recursive: true });
  writeFileSync(agentPath(name), `---\nname: ${name}\ndescription: d\n---\n${body}\n`);
}

/** SHA-256 of the definition file's bytes, computed independently of the resolver. */
function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

type HarnessStep = 'ok' | 'throw' | 'rate-limit';

/**
 * A harness fake that resolves named agents out of `pluginDir`. `script`
 * decides each invocation's behaviour in order; after it runs out, every call
 * succeeds and writes the declared output.
 */
function makeHarness(opts: { script?: HarnessStep[] } = {}): { adapter: HarnessAdapter; calls: HarnessInvocation[] } {
  const calls: HarnessInvocation[] = [];
  const script = [...(opts.script ?? [])];
  const adapter: HarnessAdapter = {
    name: 'fake-claude',
    reportsUsage: true,
    canRestrictTools: true,
    resolveAgentDefinition: (agent: string) => resolveClaudePluginAgent([pluginDir], agent),
    async probeBinary() {
      return { present: true };
    },
    async invoke(call: HarnessInvocation) {
      calls.push(call);
      const step = script.shift() ?? 'ok';
      if (step === 'throw') {
        throw Object.assign(new Error('exited with code 1'), { code: 'harness-nonzero-exit' });
      }
      if (step === 'rate-limit') {
        throw Object.assign(new Error('rate limited'), { code: 'harness-rate-limited', resetAtMs: 5_000_000 });
      }
      writeFileSync(join(process.cwd(), 'mid.json'), JSON.stringify({ summary: 'done' }), 'utf-8');
      return { outputs: [], usage: { tokens: 10, cost: 0.001 } };
    },
  };
  return { adapter, calls };
}

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

/** a (harness, optional agent) -> b (transform consuming a's output) -> done. */
function writeFlow(registry: HarnessRegistry, opts: { agent?: string; maxAttempts?: number } = {}): FlowConfig {
  mkdirSync(join(projectDir, 'prompts'), { recursive: true });
  writeFileSync(join(projectDir, 'prompts', 'a.md'), 'Constant prompt for stage A.');
  writeFileSync(join(projectDir, 'prompts', 'b.md'), 'Stage B from {{mid.json}}');
  const agentLine = opts.agent !== undefined ? `\n      agent: ${opts.agent}` : '';
  writeFileSync(
    join(projectDir, 'flow.yaml'),
    `
flow: journal-provenance
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 100000 }
  per_card: { max_execution_attempts: ${opts.maxAttempts ?? 2} }
  liveness: { no_progress_minutes: 3 }
defaults: { cap_policy: scrap, on_dep_scrap: hold }
terminal_lanes: [done, scrap, hold]
stations:
  - id: a
    worker:
      kind: harness
      harness: fake-claude${agentLine}
      prompt_file: prompts/a.md
      prompt_version: "7"
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
      prompt_version: "3"
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

async function run(flow: FlowConfig, registry: HarnessRegistry, model: ModelAdapter, now = 1000): Promise<void> {
  let clock = now;
  await runExecutor({
    db: db!,
    flow,
    now: () => clock,
    sleep: async (ms: number) => {
      clock += Math.max(1, Math.ceil(ms / 1000));
    },
    adapter: model,
    io,
    harnessRegistry: registry,
  } as unknown as RunEngineArgs);
}

function stampOf(target: ConduitDB, station: string): string {
  const row = target
    .getStateDb()
    .prepare('SELECT binding_stamp FROM checkpoints WHERE station = $s')
    .get({ $s: station }) as { binding_stamp: string } | undefined;
  if (!row) throw new Error(`no checkpoint recorded for station '${station}'`);
  return row.binding_stamp;
}

function spansNamed(target: ConduitDB, name: string, cardId = 'c'): StoredJournalSpan[] {
  return target.getJournalSpansForRun(DEFAULT_RUN_ID, cardId).filter((s) => s.name === name);
}

describe('harness maker spans record the provenance of the config that produced them', () => {
  it('records binding_stamp, the folded prompt_template_version, agent and agent_sha256', async () => {
    writeAgent('coder', 'Original agent body.');
    db = openDb();
    const harness = makeHarness();
    const registry = createHarnessRegistry([harness.adapter]);
    await run(writeFlow(registry, { agent: 'team:coder' }), registry, makeStubModel().adapter);

    const spans = spansNamed(db, 'a.harness');
    expect(spans).toHaveLength(1);
    const sha = fileSha256(agentPath('coder'));
    expect(spans[0]!.bindingStamp).toBe(stampOf(db, 'a'));
    expect(spans[0]!.promptTemplateVersion).toBe(computeAgentAwarePromptTemplateVersion('7', 'team:coder', sha));
    expect(spans[0]!.agent).toBe('team:coder');
    expect(spans[0]!.agentSha256).toBe(sha);
  });

  it('an edited agent file changes agent_sha256 and prompt_template_version on the next run\'s row', async () => {
    writeAgent('coder', 'Original agent body.');
    db = openDb();
    const harness = makeHarness();
    const model = makeStubModel();
    const registry = createHarnessRegistry([harness.adapter]);
    const flow = writeFlow(registry, { agent: 'team:coder' });

    await run(flow, registry, model.adapter, 1000);
    const firstSha = fileSha256(agentPath('coder'));

    writeAgent('coder', 'REVISED agent body with a different system prompt.');
    const secondSha = fileSha256(agentPath('coder'));
    expect(secondSha).not.toBe(firstSha);
    resetToA(db);
    await run(flow, registry, model.adapter, 2000);

    const spans = spansNamed(db, 'a.harness');
    expect(spans).toHaveLength(2);
    const [first, second] = spans as [StoredJournalSpan, StoredJournalSpan];
    expect(first.agentSha256).toBe(firstSha);
    expect(second.agentSha256).toBe(secondSha);
    expect(second.promptTemplateVersion).toBe(computeAgentAwarePromptTemplateVersion('7', 'team:coder', secondSha));
    expect(second.promptTemplateVersion).not.toBe(first.promptTemplateVersion);
    expect(second.bindingStamp).not.toBe(first.bindingStamp);
    // The later row matches the checkpoint the re-run wrote.
    expect(second.bindingStamp).toBe(stampOf(db, 'a'));
  });

  it('a station without an agent records NULL agent columns and the bare prompt_version', async () => {
    db = openDb();
    const harness = makeHarness();
    const registry = createHarnessRegistry([harness.adapter]);
    await run(writeFlow(registry), registry, makeStubModel().adapter);

    const spans = spansNamed(db, 'a.harness');
    expect(spans).toHaveLength(1);
    expect(spans[0]!.agent).toBeNull();
    expect(spans[0]!.agentSha256).toBeNull();
    expect(spans[0]!.promptTemplateVersion).toBe('7');
    expect(spans[0]!.bindingStamp).toBe(stampOf(db, 'a'));
  });

  it('a failed attempt\'s span carries the same provenance as the attempt that succeeds after it', async () => {
    writeAgent('coder', 'Body.');
    db = openDb();
    const harness = makeHarness({ script: ['throw'] });
    const registry = createHarnessRegistry([harness.adapter]);
    await run(writeFlow(registry, { agent: 'team:coder', maxAttempts: 3 }), registry, makeStubModel().adapter);

    const spans = spansNamed(db, 'a.harness');
    expect(spans).toHaveLength(2);
    expect(spans[0]!.attributes.outcome).toBe('harness-nonzero-exit');
    expect(spans[1]!.attributes.outcome).toBe('success');
    const stamp = stampOf(db, 'a');
    for (const span of spans) {
      expect(span.bindingStamp).toBe(stamp);
      expect(span.agent).toBe('team:coder');
      expect(span.agentSha256).toBe(fileSha256(agentPath('coder')));
    }
  });

  it('a rate-limit park span carries the stamp it was dispatched under', async () => {
    writeAgent('coder', 'Body.');
    db = openDb();
    const harness = makeHarness({ script: ['rate-limit'] });
    const registry = createHarnessRegistry([harness.adapter]);
    await run(writeFlow(registry, { agent: 'team:coder' }), registry, makeStubModel().adapter);

    const spans = spansNamed(db, 'a.harness');
    const parked = spans.find((s) => s.attributes.outcome === 'harness-rate-limited');
    expect(parked).toBeDefined();
    const success = spans.find((s) => s.attributes.outcome === 'success');
    expect(success).toBeDefined();
    expect(parked!.bindingStamp).toBe(stampOf(db, 'a'));
    expect(parked!.bindingStamp).toBe(success!.bindingStamp);
    expect(parked!.promptTemplateVersion).toBe(success!.promptTemplateVersion);
    expect(parked!.agent).toBe('team:coder');
    expect(parked!.agentSha256).toBe(fileSha256(agentPath('coder')));
  });
});

describe('transform station spans record provenance', () => {
  it('records the prompt_template_version and binding_stamp, with NULL agent columns', async () => {
    db = openDb();
    const harness = makeHarness();
    const registry = createHarnessRegistry([harness.adapter]);
    await run(writeFlow(registry), registry, makeStubModel().adapter);

    const spans = spansNamed(db, 'b.transform');
    expect(spans).toHaveLength(1);
    expect(spans[0]!.promptTemplateVersion).toBe('3');
    expect(spans[0]!.bindingStamp).toBe(stampOf(db, 'b'));
    expect(spans[0]!.agent).toBeNull();
    expect(spans[0]!.agentSha256).toBeNull();
  });
});

describe('subflow station spans record the binding stamp', () => {
  it('records binding_stamp and leaves the prompt and agent columns NULL', async () => {
    mkdirSync(join(projectDir, 'child'), { recursive: true });
    mkdirSync(join(projectDir, 'work'), { recursive: true });
    writeFileSync(join(projectDir, 'work', 'in.json'), JSON.stringify({ photo: 'a.jpg' }));
    writeFileSync(
      join(projectDir, 'child', 'flow.yaml'),
      `
flow: child
project_root: ..
flow_version: 1
terminal_lanes: [done, scrap, hold]
security:
  bash: { allow: ["true"] }
stations:
  - id: edit
    worker: { kind: deterministic, command: "true" }
    inputs: [work/in.json]
    outputs: [work/out.json]
    next: done
`,
    );
    writeFileSync(
      join(projectDir, 'flow.yaml'),
      `
flow: parent
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 100000 }
  per_card: { max_execution_attempts: 3 }
defaults: { cap_policy: scrap, on_dep_scrap: hold }
terminal_lanes: [done, scrap, hold]
stations:
  - id: call-child
    worker:
      kind: subflow
      flow: ./child/flow.yaml
    inputs: [work/in.json]
    outputs: [work/out.json]
    next: done
`,
    );
    const loaded = loadFlow(join(projectDir, 'flow.yaml'));
    if (!loaded.ok) throw new Error(`fixture flow invalid: ${JSON.stringify(loaded.errors)}`);

    db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
    ensureCheckpointSchema(db.getStateDb());
    db.insertCard({
      run_id: DEFAULT_RUN_ID, id: 'card-1', parent_id: null, lane: 'call-child', status: 'ready',
      attempt: 0, wave: 0, owned_paths: [], rework_count: 0,
    } as Card);
    const seam: SubflowSeam = async () => {
      writeFileSync(join(projectDir, 'work', 'out.json'), JSON.stringify({ edited: true }));
      return { outcome: 'done', tokens: 42, costUsd: 0.01 };
    };

    await runExecutor({ db, flow: loaded.flow, now: () => 1000, adapter: makeStubModel().adapter, io, runSubflow: seam });

    const spans = spansNamed(db, 'call-child.subflow', 'card-1');
    expect(spans).toHaveLength(1);
    expect(spans[0]!.bindingStamp).toBe(stampOf(db, 'call-child'));
    expect(spans[0]!.promptTemplateVersion).toBeNull();
    expect(spans[0]!.agent).toBeNull();
    expect(spans[0]!.agentSha256).toBeNull();
  });
});
