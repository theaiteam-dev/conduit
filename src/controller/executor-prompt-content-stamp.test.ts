/**
 * The binding stamp's prompt_template_version covers the prompt the station
 * actually renders (SPEC §5), on transform and harness stations alike:
 *   - the content of the station's prompt template, read the way the station
 *     renders it (the composed `prompt_content` of a `worker.uses` station,
 *     otherwise its `prompt_file`), so editing a prompt without bumping
 *     prompt_version re-runs the station and cascades downstream (issue #131);
 *   - on a harness station, the ordered content hash of each `worker.uses`
 *     skill, as a transform station already folds (issue #93).
 *
 * Every test drives the real runExecutor over a loader-built flow, resets the
 * card to the first station as a resume would find it, and observes re-runs
 * through the fakes' call counts and the persisted checkpoints and spans.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import type { ModelAdapter, ModelCall, ModelResponse } from '../worker/adapter';
import type { RunEngineArgs } from '../cli/main';
import type { FlowConfig } from '../types/kernel';
import { openConduitDB, type ConduitDB, type StoredJournalSpan, DEFAULT_RUN_ID } from '../persistence/db';
import {
  ensureCheckpointSchema,
  computeAgentAwarePromptTemplateVersion,
  computePromptContentAwarePromptTemplateVersion,
  computeSkillAwarePromptTemplateVersion,
} from '../checkpoint/checkpoint';
import { loadFlow } from '../flow/load';
import { runExecutor } from './executor';
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
  projectDir = mkdtempSync(join(tmpdir(), 'conduit-prompt-stamp-'));
  pluginDir = mkdtempSync(join(tmpdir(), 'conduit-prompt-stamp-plugin-'));
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

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function writePrompt(name: string, body: string): void {
  mkdirSync(join(projectDir, 'prompts'), { recursive: true });
  writeFileSync(join(projectDir, 'prompts', name), body);
}

function writeSkill(name: string, body: string, references: Record<string, string> = {}): void {
  const bundle = join(projectDir, 'skills', name);
  mkdirSync(bundle, { recursive: true });
  writeFileSync(join(bundle, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n---\n\n${body}\n`);
  if (Object.keys(references).length > 0) {
    mkdirSync(join(bundle, 'references'), { recursive: true });
    for (const [ref, content] of Object.entries(references)) {
      writeFileSync(join(bundle, 'references', ref), content);
    }
  }
}

function writeAgent(name: string, body: string): void {
  mkdirSync(join(pluginDir, 'agents'), { recursive: true });
  writeFileSync(join(pluginDir, 'agents', `${name}.md`), `---\nname: ${name}\ndescription: d\n---\n${body}\n`);
}

function makeHarness(): { adapter: HarnessAdapter; calls: HarnessInvocation[] } {
  const calls: HarnessInvocation[] = [];
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
      writeFileSync(join(process.cwd(), 'mid.json'), JSON.stringify({ summary: 'done' }), 'utf-8');
      return { outputs: [], usage: { tokens: 10, cost: 0.001 } };
    },
  };
  return { adapter, calls };
}

/** Transform fake. A critic prompt (it contains "CRITIC") gets a pass verdict. */
function makeModel(): { adapter: ModelAdapter; calls: ModelCall[] } {
  const calls: ModelCall[] = [];
  const adapter: ModelAdapter = {
    async call(req: ModelCall): Promise<ModelResponse> {
      calls.push(req);
      const text = req.prompt.includes('CRITIC')
        ? JSON.stringify({ verdict: 'pass', findings: [] })
        : JSON.stringify({ idea: 'an idea', summary: 'done' });
      return { text, inputTokens: 1, outputTokens: 1, costUsd: 0.001 };
    },
  };
  return { adapter, calls };
}

interface FlowOpts {
  /** Station a's kind. */
  kind: 'harness' | 'transform';
  promptVersion?: string;
  uses?: string[];
  agent?: string;
  effectful?: boolean;
  /** Gate station a with a transform critic reading prompts/critic.md. */
  critic?: boolean;
}

/** a (harness or transform) -> b (transform consuming a's output) -> done. */
function writeFlow(registry: HarnessRegistry, opts: FlowOpts): FlowConfig {
  const workerA =
    opts.kind === 'harness'
      ? `      kind: harness
      harness: fake-claude
      tools: [Read, Write]
      output_schema:
        fields:
          - { name: summary, type: string, required: true }`
      : `      kind: transform
      model: gpt-4o-mini
      output_schema:
        fields:
          - { name: summary, type: string, required: true }`;
  const extra = [
    opts.uses !== undefined ? `      uses: [${opts.uses.join(', ')}]` : '',
    opts.agent !== undefined ? `      agent: ${opts.agent}` : '',
  ].filter((l) => l !== '').join('\n');
  const check = opts.critic === true
    ? `
    check:
      kind: gate
      critic:
        model: gpt-4o-mini
        prompt_file: prompts/critic.md
        prompt_version: "1"
      on_reject: a
      rework_cap: 2`
    : '';
  writeFileSync(
    join(projectDir, 'flow.yaml'),
    `
flow: prompt-content-stamp
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 100000 }
  per_card: { max_execution_attempts: 2 }
  liveness: { no_progress_minutes: 3 }
defaults: { cap_policy: scrap, on_dep_scrap: hold }
terminal_lanes: [done, scrap, hold]
stations:
  - id: a
    worker:
${workerA}
      prompt_file: prompts/a.md
      prompt_version: "${opts.promptVersion ?? '7'}"${extra !== '' ? `\n${extra}` : ''}
    inputs: []
    outputs: [mid.json]
    next: b${opts.effectful === true ? '\n    effectful: true' : ''}${check}
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
  writeFileSync(join(projectDir, 'prompts', 'b.md'), 'Stage B from {{mid.json}}');
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

/** Put the card back at station a, ready, as a resume finds a card the run left there. */
function resetToA(target: ConduitDB): void {
  target.getStateDb().prepare("UPDATE cards SET lane = 'a', status = 'ready' WHERE id = 'c'").run();
}

interface Rig {
  registry: HarnessRegistry;
  harness: ReturnType<typeof makeHarness>;
  model: ReturnType<typeof makeModel>;
}

function makeRig(): Rig {
  const harness = makeHarness();
  return { registry: createHarnessRegistry([harness.adapter]), harness, model: makeModel() };
}

async function run(rig: Rig, flow: FlowConfig, now = 1000): Promise<void> {
  let clock = now;
  await runExecutor({
    db: db!,
    flow,
    now: () => clock,
    sleep: async (ms: number) => {
      clock += Math.max(1, Math.ceil(ms / 1000));
    },
    adapter: rig.model.adapter,
    io,
    harnessRegistry: rig.registry,
  } as unknown as RunEngineArgs);
  expect(db!.getCard(DEFAULT_RUN_ID, 'c')?.lane).toBe('done');
}

/** Number of station-a calls (harness invokes or maker model calls) so far. */
function aCalls(rig: Rig, kind: FlowOpts['kind']): number {
  return kind === 'harness'
    ? rig.harness.calls.length
    : rig.model.calls.filter((c) => !c.prompt.includes('Stage B') && !c.prompt.includes('CRITIC')).length;
}

function bCalls(rig: Rig): number {
  return rig.model.calls.filter((c) => c.prompt.includes('Stage B')).length;
}

function spansNamed(name: string): StoredJournalSpan[] {
  return db!.getJournalSpansForRun(DEFAULT_RUN_ID, 'c').filter((s) => s.name === name);
}

function stampOf(station: string): string {
  const row = db!
    .getStateDb()
    .prepare('SELECT binding_stamp FROM checkpoints WHERE station = $s')
    .get({ $s: station }) as { binding_stamp: string } | undefined;
  if (!row) throw new Error(`no checkpoint recorded for station '${station}'`);
  return row.binding_stamp;
}

/** Run a fresh flow to done, apply `edit`, reload the flow, reset to a and run again. */
async function runEditResume(opts: FlowOpts, edit: () => void): Promise<Rig & { kind: FlowOpts['kind'] }> {
  const rig = makeRig();
  db = openDb();
  await run(rig, writeFlow(rig.registry, opts), 1000);
  expect(aCalls(rig, opts.kind)).toBe(1);
  expect(bCalls(rig)).toBe(1);
  edit();
  resetToA(db);
  await run(rig, writeFlow(rig.registry, opts), 2000);
  return { ...rig, kind: opts.kind };
}

for (const kind of ['harness', 'transform'] as const) {
  describe(`${kind} station: prompt file content is part of the stamp (issue #131)`, () => {
    it('editing the prompt file without a prompt_version bump re-runs the station and cascades downstream', async () => {
      writePrompt('a.md', 'ROLE:A original prompt.');
      const rig = await runEditResume({ kind }, () => writePrompt('a.md', 'ROLE:A edited prompt.'));
      expect(aCalls(rig, kind)).toBe(2);
      expect(bCalls(rig)).toBe(2);
    });

    it('an unchanged prompt file and prompt_version still skip on resume', async () => {
      writePrompt('a.md', 'ROLE:A stable prompt.');
      const rig = await runEditResume({ kind }, () => {});
      expect(aCalls(rig, kind)).toBe(1);
      expect(bCalls(rig)).toBe(1);
    });

    it('rewriting the prompt file with identical bytes still skips', async () => {
      writePrompt('a.md', 'ROLE:A stable prompt.');
      const rig = await runEditResume({ kind }, () => writePrompt('a.md', 'ROLE:A stable prompt.'));
      expect(aCalls(rig, kind)).toBe(1);
    });

    it('a prompt_version bump still forces a re-run with the prompt file unchanged', async () => {
      writePrompt('a.md', 'ROLE:A stable prompt.');
      const rig = makeRig();
      db = openDb();
      await run(rig, writeFlow(rig.registry, { kind, promptVersion: '7' }), 1000);
      resetToA(db);
      await run(rig, writeFlow(rig.registry, { kind, promptVersion: '8' }), 2000);
      expect(aCalls(rig, kind)).toBe(2);
    });

    it("the span's prompt_template_version folds the prompt content hash into prompt_version", async () => {
      const body = 'ROLE:A provenance prompt.';
      writePrompt('a.md', body);
      const rig = makeRig();
      db = openDb();
      await run(rig, writeFlow(rig.registry, { kind }), 1000);
      const spans = spansNamed(kind === 'harness' ? 'a.harness' : 'a.transform');
      expect(spans).toHaveLength(1);
      expect(spans[0]!.promptTemplateVersion).toBe(computePromptContentAwarePromptTemplateVersion('7', sha256(body)));
      expect(spans[0]!.bindingStamp).toBe(stampOf('a'));
    });

    it('editing a used skill body re-runs the station and cascades downstream (issue #93)', async () => {
      writePrompt('a.md', 'ROLE:A local prompt.');
      writeSkill('house-style', 'Body one.');
      const rig = await runEditResume({ kind, uses: ['house-style'] }, () => writeSkill('house-style', 'Body two.'));
      expect(aCalls(rig, kind)).toBe(2);
      expect(bCalls(rig)).toBe(2);
    });

    it('editing a used skill references/ file re-runs the station', async () => {
      writePrompt('a.md', 'ROLE:A local prompt.');
      writeSkill('house-style', 'Body.', { '01-ref.md': 'reference one' });
      const rig = await runEditResume({ kind, uses: ['house-style'] }, () =>
        writeSkill('house-style', 'Body.', { '01-ref.md': 'reference two' }),
      );
      expect(aCalls(rig, kind)).toBe(2);
    });

    it('editing the local prompt of a worker.uses station re-runs the station', async () => {
      writePrompt('a.md', 'ROLE:A local prompt one.');
      writeSkill('house-style', 'Body.');
      const rig = await runEditResume({ kind, uses: ['house-style'] }, () => writePrompt('a.md', 'ROLE:A local prompt two.'));
      expect(aCalls(rig, kind)).toBe(2);
    });

    it('unchanged skills and prompt still skip on resume', async () => {
      writePrompt('a.md', 'ROLE:A local prompt.');
      writeSkill('house-style', 'Body.');
      const rig = await runEditResume({ kind, uses: ['house-style'] }, () => writeSkill('house-style', 'Body.'));
      expect(aCalls(rig, kind)).toBe(1);
      expect(bCalls(rig)).toBe(1);
    });

    it('swapping the order of two used skills re-runs the station', async () => {
      writePrompt('a.md', 'ROLE:A local prompt.');
      writeSkill('skill-x', 'Content X.');
      writeSkill('skill-y', 'Content Y.');
      const rig = makeRig();
      db = openDb();
      await run(rig, writeFlow(rig.registry, { kind, uses: ['skill-x', 'skill-y'] }), 1000);
      resetToA(db);
      await run(rig, writeFlow(rig.registry, { kind, uses: ['skill-y', 'skill-x'] }), 2000);
      expect(aCalls(rig, kind)).toBe(2);
    });

    it("a worker.uses station's prompt_template_version folds the ordered skill hashes, then the composed prompt", async () => {
      writePrompt('a.md', 'ROLE:A local prompt.');
      writeSkill('skill-x', 'Content X.');
      writeSkill('skill-y', 'Content Y.');
      const rig = makeRig();
      db = openDb();
      const flow = writeFlow(rig.registry, { kind, uses: ['skill-x', 'skill-y'] });
      await run(rig, flow, 1000);
      const station = flow.stations['a']!;
      const expected = computePromptContentAwarePromptTemplateVersion(
        computeSkillAwarePromptTemplateVersion('7', station.skill_content_hashes!),
        sha256(station.prompt_content!),
      );
      const spans = spansNamed(kind === 'harness' ? 'a.harness' : 'a.transform');
      expect(spans[0]!.promptTemplateVersion).toBe(expected);
    });

    it('a prompt file that became unreadable holds the card on resume instead of reusing the checkpoint or throwing', async () => {
      writePrompt('a.md', 'ROLE:A original prompt.');
      const rig = makeRig();
      db = openDb();
      await run(rig, writeFlow(rig.registry, { kind }), 1000);
      expect(aCalls(rig, kind)).toBe(1);
      // The stamp cannot be computed without the template, so a valid
      // checkpoint from the first run cannot be confirmed either.
      const flow = writeFlow(rig.registry, { kind });
      rmSync(join(projectDir, 'prompts', 'a.md'));
      resetToA(db);
      let clock = 2000;
      await runExecutor({
        db,
        flow,
        now: () => clock,
        sleep: async (ms: number) => {
          clock += Math.max(1, Math.ceil(ms / 1000));
        },
        adapter: rig.model.adapter,
        io,
        harnessRegistry: rig.registry,
      } as unknown as RunEngineArgs);
      expect(db.getCard(DEFAULT_RUN_ID, 'c')?.status).toBe('held');
      expect(aCalls(rig, kind)).toBe(1);
      expect(bCalls(rig)).toBe(1);
      const holdReasons = db
        .getCardLogForRun(DEFAULT_RUN_ID, 'c')
        .flatMap((e) => (e.kind === 'terminal' ? [e.reason] : []));
      expect(holdReasons.some((r) => r.includes('could not read its prompt template'))).toBe(true);
    });

    it('an effectful station with an unreadable prompt file holds before writing an outbox intent', async () => {
      writePrompt('a.md', 'ROLE:A original prompt.');
      const rig = makeRig();
      db = openDb();
      const flow = writeFlow(rig.registry, { kind, effectful: true });
      rmSync(join(projectDir, 'prompts', 'a.md'));
      let clock = 1000;
      await runExecutor({
        db,
        flow,
        now: () => clock,
        sleep: async (ms: number) => {
          clock += Math.max(1, Math.ceil(ms / 1000));
        },
        adapter: rig.model.adapter,
        io,
        harnessRegistry: rig.registry,
      } as unknown as RunEngineArgs);
      expect(db.getCard(DEFAULT_RUN_ID, 'c')?.status).toBe('held');
      expect(aCalls(rig, kind)).toBe(0);
      const outbox = db.getStateDb().prepare('SELECT COUNT(*) AS n FROM outbox').get() as { n: number };
      expect(outbox.n).toBe(0);
    });
  });
}

describe('harness station with a named agent', () => {
  it('folds the agent over the skill- and prompt-aware version, so all three move the stamp', async () => {
    writePrompt('a.md', 'ROLE:A local prompt.');
    writeSkill('house-style', 'Body.');
    writeAgent('coder', 'Agent body.');
    const rig = makeRig();
    db = openDb();
    const flow = writeFlow(rig.registry, { kind: 'harness', uses: ['house-style'], agent: 'team:coder' });
    await run(rig, flow, 1000);
    const station = flow.stations['a']!;
    const agentSha = createHash('sha256').update(readFileSync(join(pluginDir, 'agents', 'coder.md'))).digest('hex');
    const expected = computeAgentAwarePromptTemplateVersion(
      computePromptContentAwarePromptTemplateVersion(
        computeSkillAwarePromptTemplateVersion('7', station.skill_content_hashes!),
        sha256(station.prompt_content!),
      ),
      'team:coder',
      agentSha,
    );
    const spans = spansNamed('a.harness');
    expect(spans[0]!.promptTemplateVersion).toBe(expected);
    expect(spans[0]!.agentSha256).toBe(agentSha);

    // Editing the skill with the agent unchanged still re-runs the station.
    writeSkill('house-style', 'Edited body.');
    resetToA(db);
    await run(rig, writeFlow(rig.registry, { kind: 'harness', uses: ['house-style'], agent: 'team:coder' }), 2000);
    expect(rig.harness.calls).toHaveLength(2);
  });

  it('editing the agent definition with the prompt and skills unchanged re-runs the station and cascades downstream', async () => {
    writePrompt('a.md', 'ROLE:A local prompt.');
    writeAgent('coder', 'Agent body one.');
    const rig = await runEditResume({ kind: 'harness', agent: 'team:coder' }, () => writeAgent('coder', 'Agent body two.'));
    expect(rig.harness.calls).toHaveLength(2);
    expect(bCalls(rig)).toBe(2);
  });

  it('an unchanged agent definition still skips on resume', async () => {
    writePrompt('a.md', 'ROLE:A local prompt.');
    writeAgent('coder', 'Agent body.');
    const rig = await runEditResume({ kind: 'harness', agent: 'team:coder' }, () => writeAgent('coder', 'Agent body.'));
    expect(rig.harness.calls).toHaveLength(1);
  });
});

describe('effectful harness station: outbox recovery is unchanged', () => {
  it('a committed intent is not re-invoked on resume even when the prompt changed', async () => {
    writePrompt('a.md', 'ROLE:A original prompt.');
    const rig = await runEditResume({ kind: 'harness', effectful: true }, () => writePrompt('a.md', 'ROLE:A edited prompt.'));
    // The effect already landed under the old prompt: the committed checkpoint
    // is reused and the harness is not invoked a second time.
    expect(rig.harness.calls).toHaveLength(1);
  });
});

describe('gate critic prompt', () => {
  it('editing the critic prompt file re-runs the gate with the new prompt, and the unchanged maker skips', async () => {
    writePrompt('a.md', 'ROLE:A maker prompt.');
    writePrompt('critic.md', 'CRITIC version one. Judge {{mid.json}}.');
    const rig = await runEditResume({ kind: 'harness', critic: true }, () =>
      writePrompt('critic.md', 'CRITIC version two. Judge {{mid.json}}.'),
    );
    const criticPrompts = rig.model.calls.filter((c) => c.prompt.includes('CRITIC')).map((c) => c.prompt);
    expect(criticPrompts).toHaveLength(2);
    expect(criticPrompts[1]).toContain('CRITIC version two');
    expect(rig.harness.calls).toHaveLength(1);
  });
});
