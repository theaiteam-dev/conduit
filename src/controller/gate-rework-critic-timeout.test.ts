/**
 * check.critic.timeout_seconds — harness-critic wall-clock bound threading.
 *
 * Before this change the harness critic's invocation was hard-bounded by
 * DEFAULT_HARNESS_CRITIC_TIMEOUT_MS (5 minutes) with no flow.yaml surface —
 * a critic that must re-read long-form inputs every attempt (e.g. a full
 * podcast transcript + draft + prior findings) was killed mid-verdict and the
 * card fail-closed to scrap (harness-critic-invoke-failed) on a HEALTHY
 * draft. Observed live in the autocut-podcast flow: the round-2 EiC critic
 * exceeded 5 minutes and scrapped the narrate card after a legitimate
 * round-1 reject.
 *
 * This file pins the new surface end to end:
 *   1. runGateRework threads gateConfig.criticTimeoutMs into the harness
 *      invocation's timeoutMs; absent -> the 5-minute engine default.
 *   2. loadFlow parses check.critic.timeout_seconds (seconds) into
 *      StationGateConfig.criticTimeoutMs (ms), validating it like the
 *      maker's worker.timeout_seconds (integer >= 1, INVALID_TIMEOUT_SECONDS).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join, dirname } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import type { ModelAdapter } from '../worker/adapter';
import {
  createHarnessRegistry,
  type HarnessAdapter,
  type HarnessInvocation,
  type HarnessResult,
} from '../worker/harness-adapter';
import { DEFAULT_RUN_ID, openConduitDB, type ConduitDB } from '../persistence/db';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import { runGateRework, type GateReworkInput } from './gate-rework';
import { loadFlow, type LoadFlowResult } from '../flow/load';

// ---------------------------------------------------------------------------
// Part 1 — runGateRework threading (mirrors gate-rework-harness-scrap-reason).
// ---------------------------------------------------------------------------

function openDb(): ConduitDB {
  const db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
  return db;
}

function seedCard(db: ConduitDB, cardId: string): void {
  db.insertCard({
    run_id: DEFAULT_RUN_ID,
    id: cardId,
    parent_id: null,
    lane: 'ideate',
    status: 'working',
    attempt: 0,
    wave: 0,
    owned_paths: [],
    rework_count: 0,
  });
}

/** Records the timeoutMs of every invocation, then reports invoke failure. */
function recordingAdapter(record: number[]): HarnessAdapter {
  return {
    name: 'fake-critic',
    reportsUsage: false,
    canRestrictTools: true,
    async probeBinary() {
      return { present: true };
    },
    async invoke(call: HarnessInvocation): Promise<HarnessResult> {
      record.push(call.timeoutMs);
      // Failing the invoke keeps the test independent of verdict-file plumbing;
      // the timeout was already observed at this point.
      throw new Error('recorded');
    },
  };
}

const UNUSED_MODEL_ADAPTER: ModelAdapter = {
  async call() {
    throw new Error('model adapter must not be called for a harness critic');
  },
};

describe('runGateRework — criticTimeoutMs threads into the harness invocation', () => {
  let dir: string;
  let db: ConduitDB | null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'conduit-critic-timeout-'));
    writeFileSync(join(dir, 'critic.md'), 'Judge the work.');
    db = openDb();
  });

  afterEach(() => {
    db?.close();
    db = null;
    rmSync(dir, { recursive: true, force: true });
  });

  function buildInput(critic: HarnessAdapter, criticTimeoutMs?: number): GateReworkInput {
    return {
      db: db!,
      runId: DEFAULT_RUN_ID,
      cardId: 'card-1',
      workerStationId: 'ideate',
      attempt: 0,
      maxExecutionAttempts: 4,
      gateReworkCount: 0,
      gateConfig: {
        criticModel: 'unused',
        criticPromptFile: join(dir, 'critic.md'),
        criticPromptVersion: '1',
        onReject: 'ideate',
        reworkCap: 3,
        criticInputScope: [],
        criticHarness: 'fake-critic',
        criticTools: ['Read'],
        ...(criticTimeoutMs !== undefined ? { criticTimeoutMs } : {}),
      },
      adapter: UNUSED_MODEL_ADAPTER,
      harnessRegistry: createHarnessRegistry([critic]),
      projectRoot: dir,
      validBackEdges: [{ from: 'ideate', to: 'ideate' }],
    };
  }

  it('passes gateConfig.criticTimeoutMs verbatim when set', async () => {
    seedCard(db!, 'card-1');
    const seen: number[] = [];

    await runGateRework(buildInput(recordingAdapter(seen), 1_800_000));

    expect(seen).toEqual([1_800_000]);
  });

  it('falls back to the 5-minute engine default when absent', async () => {
    seedCard(db!, 'card-1');
    const seen: number[] = [];

    await runGateRework(buildInput(recordingAdapter(seen)));

    // DEFAULT_HARNESS_CRITIC_TIMEOUT_MS (module-private) = 5 * 60 * 1000.
    expect(seen).toEqual([300_000]);
  });
});

// ---------------------------------------------------------------------------
// Part 2 — loader surface (mirrors load-prelaunch's timeout_seconds suite).
// ---------------------------------------------------------------------------

function loadInline(yaml: string, extraFiles: Record<string, string>): LoadFlowResult {
  const dir = mkdtempSync(join(tmpdir(), 'conduit-critic-timeout-load-'));
  const path = join(dir, 'flow.yaml');
  try {
    writeFileSync(path, yaml, 'utf-8');
    for (const [rel, content] of Object.entries(extraFiles)) {
      const filePath = join(dir, rel);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, content, 'utf-8');
    }
    return loadFlow(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A minimal gated transform station; `value` interpolates
 * check.critic.timeout_seconds. The critic is a HARNESS critic by default —
 * timeout_seconds is consumed only by harness invocations, and a bound on a
 * model-based critic is a load error (CRITIC_TIMEOUT_REQUIRES_HARNESS).
 * The harness name resolves lazily at dispatch (WI-590), and the non-empty
 * tools requirement (HARNESS_CRITIC_TOOLS_REQUIRED) fires only when a
 * registry is passed to loadFlow — so this fixture loads registry-free.
 */
function gatedFlow(value: string | null, opts?: { harness?: boolean }): string {
  const criticLines = [
    '      critic:',
    '        model: gpt-4o',
    '        prompt_file: prompts/verify.md',
    '        prompt_version: "1"',
  ];
  if (opts?.harness !== false) {
    criticLines.push('        harness: claude-headless');
    criticLines.push('        tools: [Read]');
  }
  if (value !== null) {
    criticLines.push(`        timeout_seconds: ${value}`);
  }
  return [
    'flow: critic-timeout-fixture',
    'flow_version: 1',
    'terminal_lanes: [done, scrap, hold]',
    'stations:',
    '  - id: ideate',
    '    worker:',
    '      kind: transform',
    '      model: gpt-4o',
    '      prompt_file: prompts/ideate.md',
    '      prompt_version: "1"',
    '      output_schema:',
    '        fields:',
    '          - { name: idea, type: string, required: true }',
    '    inputs: [context.json]',
    '    outputs: [idea.json]',
    '    next: done',
    '    check:',
    '      kind: gate',
    ...criticLines,
    '      on_reject: ideate',
    '      rework_cap: 1',
    '',
  ].join('\n');
}

const PROMPTS = {
  'prompts/ideate.md': 'Ideate over {{context.json}}.',
  'prompts/verify.md': 'Verify {{idea.json}}.',
};

describe('loadFlow — check.critic.timeout_seconds', () => {
  it('parses a positive integer into gateCheck.criticTimeoutMs (seconds -> ms)', () => {
    const result = loadInline(gatedFlow('1800'), PROMPTS);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.flow.stations.ideate?.gateCheck?.criticTimeoutMs).toBe(1_800_000);
  });

  it('leaves criticTimeoutMs undefined when absent (engine default applies)', () => {
    const result = loadInline(gatedFlow(null), PROMPTS);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.flow.stations.ideate?.gateCheck?.criticTimeoutMs).toBeUndefined();
  });

  for (const bad of ['0', '-30', '1.5', '"soon"']) {
    it(`rejects check.critic.timeout_seconds: ${bad} with INVALID_TIMEOUT_SECONDS naming the station`, () => {
      const result = loadInline(gatedFlow(bad), PROMPTS);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.map((e) => e.code)).toContain('INVALID_TIMEOUT_SECONDS');
        expect(result.errors.map((e) => e.message).join(' | ')).toContain('ideate');
      }
    });
  }

  // Config is validated, not trusted: a bound on a critic with no harness
  // has no consumer (model-critic calls carry no wall-clock surface) and
  // would be silently dropped — rejected at load instead.
  it('rejects timeout_seconds on a harness-less (model) critic with CRITIC_TIMEOUT_REQUIRES_HARNESS', () => {
    const result = loadInline(gatedFlow('1800', { harness: false }), PROMPTS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toContain('CRITIC_TIMEOUT_REQUIRES_HARNESS');
      expect(result.errors.map((e) => e.message).join(' | ')).toContain('ideate');
    }
  });

  it('still accepts a harness-less critic when no timeout_seconds is declared', () => {
    const result = loadInline(gatedFlow(null, { harness: false }), PROMPTS);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.flow.stations.ideate?.gateCheck?.criticTimeoutMs).toBeUndefined();
  });
});
