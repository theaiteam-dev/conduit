/**
 * Tests for the flow.yaml loader + validator (WI-292).
 *
 * Implements FR-1 / Principle 10 — "config is validated, not trusted." A valid
 * flow.yaml loads into a typed, FROZEN FlowConfig; any invalid flow is rejected
 * at load with a structured, actionable error and NO FlowConfig is produced.
 *
 * Contract this file pins for src/flow/load.ts:
 *
 *   export function loadFlow(absolutePath: string): LoadFlowResult   // synchronous
 *   export type LoadFlowResult =
 *     | { ok: true;  flow: FlowConfig }
 *     | { ok: false; errors: FlowValidationError[] }
 *   export interface FlowValidationError { code: string; message: string }
 *
 * Because the real flow.yaml schema is richer than the Wave-0 placeholder
 * FlowConfig (WI-289), the loader must populate these fields on FlowConfig.
 * Add them to src/types/kernel.ts as OPTIONAL so the existing WI-289 literal
 * (version + stations only) still type-checks:
 *
 *   terminal_lanes?: string[]
 *   budgets?:  { run?: {...}; per_wave?: {...}; per_card?: {...}; liveness?: {...} }
 *   channels?: { ingress?: { type?: string }; egress?: Array<{ type?: string; ... }> }
 *   back_edges?: ReadonlyArray<{ from: string; to: string }>   // the lane-graph back-edges
 *
 * YAML `flow_version` maps to FlowConfig.version (kept consistent with WI-289).
 * Per the work item, put reusable cycle detection (DFS, SPEC §9) in
 * src/flow/dag-utils.ts so WI-302 can share it.
 */
import { describe, it, expect } from 'bun:test';
import { join, dirname } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { FlowConfig } from '../types/kernel';
import { loadFlow, type LoadFlowResult } from './load';
import { flowToTransitionContext } from '../law/contract';

const FLOWS_DIR = join(import.meta.dir, '..', '..', 'fixtures', 'flows');

function fixture(rel: string): string {
  return join(FLOWS_DIR, rel);
}

/**
 * Write `yaml` to a throwaway temp file and load it. Keeps these new
 * validation tests self-contained (no shared fixture files to maintain).
 *
 * `extraFiles` writes sibling files (e.g. prompt templates) into the same temp
 * directory before loading, so on-disk existence checks (prompt_file resolution,
 * resolved relative to the flow.yaml's directory) can be exercised. Keys are
 * paths relative to the flow.yaml; values are file contents.
 */
function loadInline(
  yaml: string,
  extraFiles: Record<string, string> = {},
): LoadFlowResult {
  const dir = mkdtempSync(join(tmpdir(), 'conduit-flow-'));
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

/** All error codes joined — used to assert a specific code is present. */
function errorCodes(result: LoadFlowResult): string[] {
  return expectErrors(result).map((e) => e.code);
}

/** Narrow to the success branch, failing the test (with detail) otherwise. */
function expectOk(result: LoadFlowResult): FlowConfig {
  if (!result.ok) {
    throw new Error(`expected ok, got errors: ${JSON.stringify(result.errors)}`);
  }
  return result.flow;
}

/** Narrow to the failure branch, failing the test otherwise. */
function expectErrors(result: LoadFlowResult): { code: string; message: string }[] {
  if (result.ok) {
    throw new Error('expected validation errors, but load succeeded');
  }
  return result.errors;
}

/** All error messages joined — used to assert an error "names" a given entity. */
function errorText(result: LoadFlowResult): string {
  return expectErrors(result)
    .map((e) => e.message)
    .join(' | ');
}

// ---------------------------------------------------------------------------
// AC1 — the reference flow loads into a fully-populated, frozen FlowConfig.
// ---------------------------------------------------------------------------

describe('loadFlow — reference flow (AC1)', () => {
  it('returns ok with all five stations populated', () => {
    const flow = expectOk(loadFlow(fixture('reference.flow.yaml')));
    const stationIds = Object.keys(flow.stations).sort();
    expect(stationIds).toEqual(['assemble', 'draft', 'plan', 'publish', 'select']);
  });

  it('maps worker.kind to station kind and parses effectful', () => {
    const flow = expectOk(loadFlow(fixture('reference.flow.yaml')));
    expect(flow.stations.plan!.kind).toBe('transform');
    expect(flow.stations.assemble!.kind).toBe('deterministic');
    // publish is the ONLY effectful station in the reference flow.
    expect(flow.stations.publish!.effectful).toBe(true);
    expect(flow.stations.draft!.effectful).toBe(false);
  });

  it('populates terminal_lanes', () => {
    const flow = expectOk(loadFlow(fixture('reference.flow.yaml')));
    expect(flow.terminal_lanes).toBeDefined();
    for (const lane of ['done', 'scrap', 'hold']) {
      expect(flow.terminal_lanes).toContain(lane);
    }
  });

  it('populates budgets from the yaml', () => {
    const flow = expectOk(loadFlow(fixture('reference.flow.yaml')));
    expect(flow.budgets).toBeDefined();
    expect(flow.budgets?.run?.max_tokens).toBe(1000000);
    expect(flow.budgets?.per_card?.max_execution_attempts).toBe(4);
  });

  it('populates channels (cli ingress + slack egress)', () => {
    const flow = expectOk(loadFlow(fixture('reference.flow.yaml')));
    expect(flow.channels).toBeDefined();
    expect(flow.channels?.ingress?.type).toBe('cli');
    expect(Array.isArray(flow.channels?.egress)).toBe(true);
    expect(flow.channels!.egress!.length).toBeGreaterThan(0);
    expect(flow.channels!.egress![0]!.type).toBe('slack');
  });

  it('pins flow_version', () => {
    const flow = expectOk(loadFlow(fixture('reference.flow.yaml')));
    expect(flow.version).toBe(1);
  });

  it('returns a frozen FlowConfig that cannot be mutated', () => {
    const flow = expectOk(loadFlow(fixture('reference.flow.yaml')));
    expect(Object.isFrozen(flow)).toBe(true);
    // ESM runs in strict mode — writing to a frozen object throws.
    expect(() => {
      (flow as unknown as Record<string, unknown>).injected = true;
    }).toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC6 — a valid on_reject to a reachable non-terminal station records the
//        back-edge in the lane graph. The reference flow has select→draft
//        (rework) and plan→plan (self gate).
// ---------------------------------------------------------------------------

describe('loadFlow — back-edge recording (AC6)', () => {
  it('records the on_reject back-edge from select to draft', () => {
    const flow = expectOk(loadFlow(fixture('reference.flow.yaml')));
    expect(flow.back_edges).toBeDefined();
    const edges = flow.back_edges ?? [];
    expect(edges).toContainEqual({ from: 'select', to: 'draft' });
  });

  it('records the gate self-loop back-edge from plan to plan', () => {
    const flow = expectOk(loadFlow(fixture('reference.flow.yaml')));
    const edges = flow.back_edges ?? [];
    expect(edges).toContainEqual({ from: 'plan', to: 'plan' });
  });
});

describe('loadFlow — A-Team renderer stress fixture', () => {
  it('loads the A-Team flow with fan-out, fan-in, and visible backflow routes', () => {
    const flow = expectOk(loadFlow(fixture('aiteam.flow.yaml')));

    expect(flow.name).toBe('aiteam-mission-orchestration');
    expect(flow.stations.dispatch!.fan_out).toBe(4);
    expect(flow.stations.dispatch!.child_entry).toBe('testing');
    expect(flow.stations.dispatch!.child_terminal).toBe('item_done');
    expect(flow.stations.dispatch!.resume_at).toBe('join');
    expect(flow.stations.join!.fan_in).toEqual({ policy: 'all' });
    expect(flow.happyPathNext).toMatchObject({
      plan: 'deps',
      deps: 'dispatch',
      dispatch: 'join',
      testing: 'coding',
      coding: 'reviewing',
      reviewing: 'manual_testing',
      manual_testing: 'item_done',
      join: 'final',
      final: 'checks',
      checks: 'docs',
      docs: 'done',
    });

    expect(flow.stations.testing!.role).toBe('Murdock');
    expect(flow.stations.coding!.role).toBe('B.A.');
    expect(flow.stations.reviewing!.role).toBe('Lynch');
    expect(flow.stations.manual_testing!.role).toBe('Amy');

    expect(flow.back_edges ?? []).toContainEqual({ from: 'coding', to: 'testing' });
    expect(flow.back_edges ?? []).toContainEqual({ from: 'reviewing', to: 'coding' });
    expect(flow.back_edges ?? []).toContainEqual({ from: 'manual_testing', to: 'coding' });
    expect(flow.back_edges ?? []).toContainEqual({ from: 'final', to: 'dispatch' });
  });
});

// ---------------------------------------------------------------------------
// AC2–AC5 — every invalid flow is rejected at load with a structured error
//            and NO FlowConfig is produced.
// ---------------------------------------------------------------------------

describe('loadFlow — fail-closed validation (AC2–AC5)', () => {
  it('rejects cyclic depends_on, naming the stations in the cycle (AC2)', () => {
    const result = loadFlow(fixture('invalid/cyclic-deps.flow.yaml'));
    const errors = expectErrors(result);

    expect(errors.length).toBeGreaterThan(0);
    // No FlowConfig leaks out on the failure branch.
    expect(result).not.toHaveProperty('flow');

    const text = errorText(result);
    expect(text).toContain('alpha');
    expect(text).toContain('beta');
  });

  it('rejects an on_reject target that does not exist, naming the unknown lane (AC3)', () => {
    const result = loadFlow(fixture('invalid/missing-on-reject-target.flow.yaml'));
    expectErrors(result);
    expect(errorText(result)).toContain('ghost_station');
  });

  it('rejects overlapping owned_paths, naming both stations and the shared path (AC4)', () => {
    const result = loadFlow(fixture('invalid/overlapping-owned-paths.flow.yaml'));
    expectErrors(result);

    const text = errorText(result);
    expect(text).toContain('write');
    expect(text).toContain('edit');
    expect(text).toContain('draft.md');
  });

  it('rejects hold_timeout set without on_timeout, citing on_timeout (AC5)', () => {
    const result = loadFlow(fixture('invalid/hold-timeout-without-on-timeout.flow.yaml'));
    expectErrors(result);
    expect(errorText(result)).toContain('on_timeout');
  });

  it('rejects an unrecognised on_timeout value, naming the illegal policy (WI-398)', () => {
    const result = loadFlow(fixture('invalid/invalid-on-timeout.flow.yaml'));
    const errors = expectErrors(result);
    expect(errors.map((e) => e.code)).toContain('INVALID_ON_TIMEOUT');
    expect(errorText(result)).toContain('yolo');
  });

  it('returns structured errors carrying a non-empty code', () => {
    // Every rejection is actionable: a stable code plus a human message.
    const result = loadFlow(fixture('invalid/cyclic-deps.flow.yaml'));
    const errors = expectErrors(result);
    for (const err of errors) {
      expect(typeof err.code).toBe('string');
      expect(err.code.length).toBeGreaterThan(0);
      expect(typeof err.message).toBe('string');
      expect(err.message.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// #4 — quorum fan_in: k is a COUNT (integer 1 <= k <= fan_out), structured.
// ---------------------------------------------------------------------------

describe('loadFlow — quorum fan_in is a validated COUNT (#4)', () => {
  const stationWithQuorum = (k: unknown, fanOut: unknown): string => `
flow: q
flow_version: 1
terminal_lanes: [done, scrap, hold]
stations:
  - id: assemble
    worker: { kind: deterministic }
    fan_out: ${fanOut}
    fan_in:
      policy: quorum
      k: ${k}
`;

  it('loads a valid quorum and stores a structured {policy, k} count', () => {
    const flow = expectOk(loadInline(stationWithQuorum(2, 3)));
    expect(flow.stations.assemble!.fan_in).toEqual({ policy: 'quorum', k: 2 });
  });

  it('rejects k greater than fan_out', () => {
    expect(errorCodes(loadInline(stationWithQuorum(4, 3)))).toContain('INVALID_QUORUM_K');
  });

  it('rejects k < 1', () => {
    expect(errorCodes(loadInline(stationWithQuorum(0, 3)))).toContain('INVALID_QUORUM_K');
  });

  it('rejects a non-integer k', () => {
    expect(errorCodes(loadInline(stationWithQuorum('0.66', 3)))).toContain('INVALID_QUORUM_K');
  });
});

// ---------------------------------------------------------------------------
// #13 — station-level depends_on must reference a known station.
// ---------------------------------------------------------------------------

describe('loadFlow — unknown station depends_on is rejected (#13)', () => {
  it('rejects a station depending on a non-existent station id', () => {
    const yaml = `
flow: d
flow_version: 1
terminal_lanes: [done, scrap, hold]
stations:
  - id: a
    worker: { kind: transform }
  - id: b
    worker: { kind: transform }
    depends_on: [nope]
`;
    const result = loadInline(yaml);
    expect(errorCodes(result)).toContain('UNKNOWN_DEPENDS_ON');
    expect(errorText(result)).toContain('nope');
  });

  it('accepts station depends_on that references a known station', () => {
    const yaml = `
flow: d
flow_version: 1
terminal_lanes: [done, scrap, hold]
stations:
  - id: a
    worker: { kind: transform }
  - id: b
    worker: { kind: transform }
    depends_on: [a]
`;
    expect(loadInline(yaml).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #15 — numeric config fields (wip, fan_out, rework_cap) are validated.
// ---------------------------------------------------------------------------

describe('loadFlow — numeric config fields are validated (#15)', () => {
  const withWip = (wip: unknown): string => `
flow: n
flow_version: 1
terminal_lanes: [done, scrap, hold]
stations:
  - id: a
    worker: { kind: transform }
    wip: ${wip}
`;

  it('rejects wip: 0 (would deadlock every routed card)', () => {
    expect(errorCodes(loadInline(withWip(0)))).toContain('INVALID_WIP');
  });

  it('rejects negative wip', () => {
    expect(errorCodes(loadInline(withWip(-1)))).toContain('INVALID_WIP');
  });

  it('rejects fan_out: 0', () => {
    const yaml = `
flow: n
flow_version: 1
terminal_lanes: [done, scrap, hold]
stations:
  - id: a
    worker: { kind: transform }
    fan_out: 0
`;
    expect(errorCodes(loadInline(yaml))).toContain('INVALID_FAN_OUT');
  });

  it('accepts wip >= 1', () => {
    expect(loadInline(withWip(2)).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// defaults.cap_policy / defaults.on_dep_scrap — parsed onto FlowConfig.defaults,
// fail-closed to 'scrap'/'scrap' when absent, and rejected on illegal values.
// ---------------------------------------------------------------------------

describe('loadFlow — defaults.cap_policy / on_dep_scrap parsing', () => {
  const withDefaults = (defaultsLine: string): string => `
flow: dflt
flow_version: 1
terminal_lanes: [done, scrap, hold]
${defaultsLine}
stations:
  - id: a
    worker: { kind: transform }
`;

  it('parses cap_policy: scrap and an explicit on_dep_scrap: hold', () => {
    const flow = expectOk(loadInline(withDefaults('defaults: { cap_policy: scrap, on_dep_scrap: hold }')));
    expect(flow.defaults!.capPolicy).toBe('scrap');
    expect(flow.defaults!.onDepScrap).toBe('hold');
  });

  it('parses cap_policy: proceed_with_findings', () => {
    const flow = expectOk(loadInline(withDefaults('defaults: { cap_policy: proceed_with_findings }')));
    expect(flow.defaults!.capPolicy).toBe('proceed_with_findings');
  });

  it('defaults capPolicy and onDepScrap to scrap when the defaults block is absent', () => {
    const flow = expectOk(loadInline(`
flow: dflt
flow_version: 1
terminal_lanes: [done, scrap, hold]
stations:
  - id: a
    worker: { kind: transform }
`));
    expect(flow.defaults!.capPolicy).toBe('scrap');
    expect(flow.defaults!.onDepScrap).toBe('scrap');
  });

  it('rejects an illegal cap_policy value (INVALID_CAP_POLICY) and produces no FlowConfig', () => {
    const result = loadInline(withDefaults('defaults: { cap_policy: scrapp }'));
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('flow');
    expect(errorCodes(result)).toContain('INVALID_CAP_POLICY');
    expect(errorText(result)).toContain('scrapp');
  });

  it('rejects an illegal on_dep_scrap value (INVALID_ON_DEP_SCRAP)', () => {
    const result = loadInline(withDefaults('defaults: { on_dep_scrap: pause }'));
    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain('INVALID_ON_DEP_SCRAP');
    expect(errorText(result)).toContain('pause');
  });
});

// ---------------------------------------------------------------------------
// worker-kind validation work — invalid worker.kind is rejected; a worker-less station stays valid.
// ---------------------------------------------------------------------------

describe('loadFlow — worker.kind validation (worker-kind validation work)', () => {
  it('rejects a worker with a bogus kind (typo must not silently become transform)', () => {
    const yaml = `
flow: w
flow_version: 1
terminal_lanes: [done, scrap, hold]
stations:
  - id: a
    worker: { kind: tranform }
`;
    expect(errorCodes(loadInline(yaml))).toContain('INVALID_WORKER_KIND');
  });

  it('keeps a station with NO worker key valid (check-only station)', () => {
    const yaml = `
flow: w
flow_version: 1
terminal_lanes: [done, scrap, hold]
stations:
  - id: gate
    check:
      kind: gate
      on_reject: gate
`;
    const flow = expectOk(loadInline(yaml));
    expect(flow.stations.gate).toBeDefined();
    expect(flow.stations.gate!.kind).toBe('transform');
  });
});

// ===========================================================================
// WI-351 — real-run flow config surface (FR-2,3,4,4a,7; NFR-4).
//
// Extends the loader to parse + fail-closed-validate the fields the real-run
// path needs: declared topology (`next`), deterministic command/args, model
// prompt sourcing (prompt_file/prompt_version), output_schema, inference
// params, and the "only references declared inputs" rule. Every new field is
// validated at LOAD — an invalid flow must never reach dispatch.
// ===========================================================================

const EXAMPLE_FLOW = join(
  import.meta.dir,
  '..',
  '..',
  'examples',
  'tiktok-shoppable-ideas',
  'flow.yaml',
);

/**
 * Build a fully-valid single transform (model) station, parameterised so each
 * test can omit exactly one required field and assert its fail-closed code.
 * Returns the yaml plus the prompt-file fixtures to write alongside it.
 *
 *  - promptFile: undefined → declared as 'prompts/p.md'; null → field omitted
 *  - promptVersion: undefined → '"1"'; null → field omitted
 *  - outputSchema: false → output_schema omitted
 *  - writePromptFile: false → prompt_file is declared but NOT created on disk
 *  - promptBody: contents of the prompt template (default refs {{context.json}})
 *  - inputs: the station's declared inputs (default [context.json])
 */
function modelFlow(
  opts: {
    promptFile?: string | null;
    promptVersion?: string | null;
    outputSchema?: boolean;
    writePromptFile?: boolean;
    promptBody?: string;
    inputs?: string;
  } = {},
): { yaml: string; files: Record<string, string> } {
  const promptFile = opts.promptFile === undefined ? 'prompts/p.md' : opts.promptFile;
  const promptVersion = opts.promptVersion === undefined ? '"1"' : opts.promptVersion;
  const wantSchema = opts.outputSchema ?? true;
  const writePromptFile = opts.writePromptFile ?? true;
  const inputs = opts.inputs ?? '[context.json]';

  const lines: string[] = [
    'flow: m',
    'flow_version: 1',
    'project_root: .',
    'terminal_lanes: [done, scrap, hold]',
    'stations:',
    '  - id: ideate',
    '    worker:',
    '      kind: transform',
    '      model: gpt-4o-mini',
  ];
  if (promptFile !== null) lines.push(`      prompt_file: ${promptFile}`);
  if (promptVersion !== null) lines.push(`      prompt_version: ${promptVersion}`);
  if (wantSchema) {
    lines.push('      output_schema:');
    lines.push('        fields:');
    lines.push('          - { name: idea, type: string, required: true }');
  }
  lines.push(`    inputs: ${inputs}`);
  lines.push('    outputs: [idea.json]');
  lines.push('    next: done');

  const files: Record<string, string> = {};
  if (promptFile !== null && writePromptFile) {
    files[promptFile] = opts.promptBody ?? 'Make an idea from {{context.json}}';
  }
  return { yaml: lines.join('\n') + '\n', files };
}

// ---------------------------------------------------------------------------
// AC1 — `next` is parsed into a happyPathNext map; an unknown/non-terminal
//        target fails load with UNKNOWN_NEXT_TARGET.
// ---------------------------------------------------------------------------

describe('loadFlow — declared topology via `next` (AC1)', () => {
  it('parses each station `next` into the happyPathNext successor map', () => {
    const yaml = `
flow: t
flow_version: 1
project_root: .
terminal_lanes: [done, scrap, hold]
security:
  bash:
    allow: [echo]
stations:
  - id: a
    worker: { kind: deterministic, command: echo }
    next: b
  - id: b
    worker: { kind: deterministic, command: echo }
    next: done
`;
    const flow = expectOk(loadInline(yaml));
    expect(flow.happyPathNext).toEqual({ a: 'b', b: 'done' });
  });

  it('rejects a `next` naming a target that is neither a station nor a terminal lane (UNKNOWN_NEXT_TARGET)', () => {
    const yaml = `
flow: t
flow_version: 1
project_root: .
terminal_lanes: [done, scrap, hold]
security:
  bash:
    allow: [echo]
stations:
  - id: a
    worker: { kind: deterministic, command: echo }
    next: ghost
`;
    const result = loadInline(yaml);
    expect(errorCodes(result)).toContain('UNKNOWN_NEXT_TARGET');
    expect(errorText(result)).toContain('ghost');
  });
});

// ---------------------------------------------------------------------------
// AC2 — deterministic worker.command + worker.args; a deterministic station
//        with no command, or a command absent from security.bash.allow, fails
//        load BEFORE any spawn.
// ---------------------------------------------------------------------------

describe('loadFlow — deterministic command + allowlist (AC2)', () => {
  it('parses worker.command and worker.args onto the station config', () => {
    const flow = expectOk(loadFlow(EXAMPLE_FLOW));
    expect(flow.stations.fetch_context!.command).toBe('duckdb');
    expect(flow.stations.fetch_context!.args).toEqual([
      '-readonly',
      'fixtures/fixture.duckdb',
      '-f',
      'fetch.sql',
    ]);
  });

  it('rejects a deterministic station with no command (MISSING_DETERMINISTIC_COMMAND)', () => {
    const yaml = `
flow: d
flow_version: 1
project_root: .
terminal_lanes: [done, scrap, hold]
security:
  bash:
    allow: [echo]
stations:
  - id: fetch
    worker: { kind: deterministic }
    next: done
`;
    expect(errorCodes(loadInline(yaml))).toContain('MISSING_DETERMINISTIC_COMMAND');
  });

  it('rejects a command absent from security.bash.allow (COMMAND_NOT_ALLOWLISTED)', () => {
    const yaml = `
flow: d
flow_version: 1
project_root: .
terminal_lanes: [done, scrap, hold]
security:
  bash:
    allow: [echo]
stations:
  - id: fetch
    worker: { kind: deterministic, command: rm }
    next: done
`;
    const result = loadInline(yaml);
    expect(errorCodes(result)).toContain('COMMAND_NOT_ALLOWLISTED');
    expect(errorText(result)).toContain('rm');
  });
});

// ---------------------------------------------------------------------------
// AC3 — model (transform/gate-critic) prompt sourcing: prompt_file +
//        prompt_version are parsed; missing either fails load; a prompt_file
//        that does not exist on disk fails at LOAD (not mid-run).
// ---------------------------------------------------------------------------

describe('loadFlow — model prompt sourcing (AC3)', () => {
  it('parses prompt_file and prompt_version onto the station config', () => {
    const flow = expectOk(loadFlow(EXAMPLE_FLOW));
    expect(flow.stations.ideate!.prompt_file).toContain('prompts/ideate.md');
    expect(flow.stations.ideate!.prompt_version).toBe('1');
  });

  it('rejects a model station missing prompt_file (MISSING_PROMPT_TEMPLATE)', () => {
    const { yaml, files } = modelFlow({ promptFile: null });
    expect(errorCodes(loadInline(yaml, files))).toContain('MISSING_PROMPT_TEMPLATE');
  });

  it('rejects a model station missing prompt_version (MISSING_PROMPT_VERSION)', () => {
    const { yaml, files } = modelFlow({ promptVersion: null });
    expect(errorCodes(loadInline(yaml, files))).toContain('MISSING_PROMPT_VERSION');
  });

  it('rejects a model prompt_file that does not exist on disk, at load (names the missing path)', () => {
    const { yaml, files } = modelFlow({
      promptFile: 'prompts/ghost.md',
      writePromptFile: false,
    });
    const result = loadInline(yaml, files);
    expect(result.ok).toBe(false);
    expect(errorText(result)).toContain('ghost.md');
  });

  it('rejects a gate-critic prompt_file that does not exist on disk, at load (names the missing path)', () => {
    // Worker prompt exists; only the critic's prompt is missing — isolates the
    // failure to the gate-critic prompt validation path.
    const yaml = `
flow: g
flow_version: 1
project_root: .
terminal_lanes: [done, scrap, hold]
stations:
  - id: ideate
    worker:
      kind: transform
      model: gpt-4o-mini
      prompt_file: prompts/ideate.md
      prompt_version: "1"
      output_schema:
        fields:
          - { name: idea, type: string, required: true }
    inputs: [context.json]
    outputs: [idea.json]
    next: done
    check:
      kind: gate
      critic:
        role: ad-critic
        model: gpt-4o
        prompt_file: prompts/critic-ghost.md
        prompt_version: "1"
      on_reject: ideate
`;
    const result = loadInline(yaml, {
      'prompts/ideate.md': 'Make an idea from {{context.json}}',
    });
    expect(result.ok).toBe(false);
    expect(errorText(result)).toContain('critic-ghost.md');
  });
});

// ---------------------------------------------------------------------------
// AC4 — output_schema.fields (name/type/required) are parsed; a model station
//        with no output_schema fails load (MISSING_OUTPUT_SCHEMA).
// ---------------------------------------------------------------------------

describe('loadFlow — output_schema declaration (AC4)', () => {
  it('parses output_schema.fields (name/type/required) onto the station config', () => {
    const flow = expectOk(loadFlow(EXAMPLE_FLOW));
    expect(flow.stations.ideate!.output_schema?.fields).toContainEqual({
      name: 'featured_variant',
      type: 'string',
      required: true,
    });
  });

  it('rejects a model station with no output_schema (MISSING_OUTPUT_SCHEMA)', () => {
    const { yaml, files } = modelFlow({ outputSchema: false });
    expect(errorCodes(loadInline(yaml, files))).toContain('MISSING_OUTPUT_SCHEMA');
  });
});

// ---------------------------------------------------------------------------
// AC5 — a model prompt may reference ONLY artifacts the station declares in
//        its inputs (FR-4a). The loader scans the template for {{artifact}}
//        refs and checks each against the station's declared inputs.
//        "Only" qualifier → both a positive and a negative test.
// ---------------------------------------------------------------------------

describe('loadFlow — prompt references only declared inputs (AC5 / FR-4a)', () => {
  it('accepts a prompt that references a declared input artifact', () => {
    const { yaml, files } = modelFlow({
      inputs: '[context.json]',
      promptBody: 'Use {{context.json}} to write an idea.',
    });
    const result = loadInline(yaml, files);
    expect(result.ok).toBe(true);
  });

  it('rejects a prompt that references an undeclared artifact (UNDECLARED_PROMPT_INPUT)', () => {
    const { yaml, files } = modelFlow({
      inputs: '[context.json]',
      promptBody: 'Use {{secret.json}} to write an idea.',
    });
    const result = loadInline(yaml, files);
    expect(errorCodes(result)).toContain('UNDECLARED_PROMPT_INPUT');
    expect(errorText(result)).toContain('secret.json');
  });
});

// ---------------------------------------------------------------------------
// AC6 + AC7 — happyPathNext is built strictly from declared `next`, NEVER from
//   station insertion order. The ONLY builder of happyPathNext is
//   flowToTransitionContext() in src/law/contract.ts; it must read the declared
//   topology, not Object.keys(flow.stations) order (FR-2). This is the
//   load.ts ↔ hooks.ts routing seam, so it is exercised end-to-end here.
// ---------------------------------------------------------------------------

describe('loadFlow ↔ flowToTransitionContext — topology from `next`, not YAML order (AC6/AC7)', () => {
  // Stations declared in order [a, b, c], but `next` declares a -> c -> b -> done.
  // Insertion order would route a -> b; declared topology routes a -> c.
  const orderedYaml = `
flow: topo
flow_version: 1
project_root: .
terminal_lanes: [done, scrap, hold]
security:
  bash:
    allow: [echo]
stations:
  - id: a
    worker: { kind: deterministic, command: echo }
    next: c
  - id: b
    worker: { kind: deterministic, command: echo }
    next: done
  - id: c
    worker: { kind: deterministic, command: echo }
    next: b
`;

  it('loader builds happyPathNext from `next` (a→c→b→done), not insertion order', () => {
    const flow = expectOk(loadInline(orderedYaml));
    expect(flow.happyPathNext).toEqual({ a: 'c', c: 'b', b: 'done' });
    // The decisive assertion: insertion order [a,b,c] would map a→b; `next` maps a→c.
    expect(flow.happyPathNext!.a).toBe('c');
  });

  it('flowToTransitionContext derives happyPathNext from declared `next`, never from insertion order', () => {
    const flow = expectOk(loadInline(orderedYaml));
    const ctx = flowToTransitionContext(flow);
    expect(ctx.happyPathNext).toEqual({ a: 'c', c: 'b', b: 'done' });
    // Proves the routing seam reads declared topology: a→c, not the
    // insertion-order successor (b).
    expect(ctx.happyPathNext.a).toBe('c');
    expect(ctx.happyPathNext.a).not.toBe('b');
  });
});

// ---------------------------------------------------------------------------
// AC8 — the committed dogfood example loads ok:true with every new field
//        populated; pre-existing validations continue to pass unchanged.
// ---------------------------------------------------------------------------

describe('loadFlow — committed example flow loads fully (AC8)', () => {
  it('loads examples/tiktok-shoppable-ideas/flow.yaml with ok:true', () => {
    const result = loadFlow(EXAMPLE_FLOW);
    expect(result.ok).toBe(true);
  });

  it('yields happyPathNext={fetch_context:ideate, ideate:done}', () => {
    const flow = expectOk(loadFlow(EXAMPLE_FLOW));
    expect(flow.happyPathNext).toEqual({ fetch_context: 'ideate', ideate: 'done' });
  });

  it('populates the deterministic command + args, the model prompt, schema, and params', () => {
    const flow = expectOk(loadFlow(EXAMPLE_FLOW));
    // deterministic fetch_context
    expect(flow.stations.fetch_context!.command).toBe('duckdb');
    expect(flow.stations.fetch_context!.args).toContain('fetch.sql');
    // transform ideate
    expect(flow.stations.ideate!.prompt_file).toContain('prompts/ideate.md');
    expect(flow.stations.ideate!.prompt_version).toBe('1');
    expect(flow.stations.ideate!.params).toEqual({ temperature: 0.7 });
    expect(flow.stations.ideate!.output_schema?.fields).toContainEqual({
      name: 'hook',
      type: 'string',
      required: true,
    });
  });

  it('still records the gate self-loop back-edge (ideate→ideate) — existing validation unchanged', () => {
    const flow = expectOk(loadFlow(EXAMPLE_FLOW));
    expect(flow.back_edges ?? []).toContainEqual({ from: 'ideate', to: 'ideate' });
  });
});

// ===========================================================================
// WI-380 — fail-closed: a station whose prompt declares the synthetic
// {{feedback}} input must actually be reachable via a back-edge (some station's
// check.on_reject targets it). A prompt that declares a feedback input that can
// never be supplied is a config error and must fail at LOAD, not silently render
// an empty feedback block forever (NFR-6; Principle: config is validated, not
// trusted).
//
// `feedback` is the reserved synthetic input name (src/flow/render.ts,
// FEEDBACK_INPUT). A station "declares feedback" when its prompt template
// references {{feedback}} (detected with the existing extractTemplateRefs). A
// station is a back-edge target iff some station's check.on_reject equals its id
// — INCLUDING a gate self-loop (on_reject: <self>), which is exactly the dogfood
// `ideate` shape and must therefore be accepted.
//
// New error code pinned by this contract: FEEDBACK_WITHOUT_BACK_EDGE.
// ===========================================================================

/**
 * Build a single maker station `ideate` whose prompt references {{feedback}}
 * (and declares `feedback` in its inputs, so the existing UNDECLARED_PROMPT_INPUT
 * guard is satisfied and the ONLY variable under test is reachability).
 *
 *  - backEdge: 'self'     → ideate has a gate self-loop (check.on_reject: ideate)
 *  - backEdge: 'separate' → a sibling check-only station `verify` routes
 *                           on_reject → ideate
 *  - backEdge: 'none'     → no station's on_reject targets ideate (the error case)
 */
function feedbackMakerFlow(backEdge: 'self' | 'separate' | 'none'): {
  yaml: string;
  files: Record<string, string>;
} {
  const lines: string[] = [
    'flow: fb',
    'flow_version: 1',
    'project_root: .',
    'terminal_lanes: [done, scrap, hold]',
    'stations:',
    '  - id: ideate',
    '    worker:',
    '      kind: transform',
    '      model: gpt-4o-mini',
    '      prompt_file: prompts/ideate.md',
    '      prompt_version: "1"',
    '      output_schema:',
    '        fields:',
    '          - { name: idea, type: string, required: true }',
    '    inputs: [context.json, feedback]',
    '    outputs: [idea.json]',
    '    next: done',
  ];
  if (backEdge === 'self') {
    lines.push('    check:', '      kind: gate', '      on_reject: ideate');
  } else if (backEdge === 'separate') {
    lines.push('  - id: verify', '    check:', '      kind: gate', '      on_reject: ideate');
  }
  return {
    yaml: lines.join('\n') + '\n',
    files: { 'prompts/ideate.md': 'Make an idea from {{context.json}}\n\nPrior feedback:\n{{feedback}}\n' },
  };
}

// ---------------------------------------------------------------------------
// AC1 — a station that declares {{feedback}} AND is a back-edge target loads ok.
//        Both the gate self-loop (dogfood shape) and a separate gate satisfy it.
// ---------------------------------------------------------------------------

describe('loadFlow — feedback input with a back-edge is accepted (WI-380 AC1)', () => {
  it('accepts a maker whose own gate self-loops back to it (on_reject: ideate)', () => {
    const { yaml, files } = feedbackMakerFlow('self');
    const flow = expectOk(loadInline(yaml, files));
    // The back-edge that supplies feedback is recorded.
    expect(flow.back_edges ?? []).toContainEqual({ from: 'ideate', to: 'ideate' });
  });

  it('accepts a maker reached by a separate gate station’s on_reject (verify → ideate)', () => {
    const { yaml, files } = feedbackMakerFlow('separate');
    const flow = expectOk(loadInline(yaml, files));
    expect(flow.back_edges ?? []).toContainEqual({ from: 'verify', to: 'ideate' });
  });
});

// ---------------------------------------------------------------------------
// AC2 — a station that declares {{feedback}} but is NOT a back-edge target fails
//        load, naming the station and explaining the input can never be supplied.
// ---------------------------------------------------------------------------

describe('loadFlow — feedback input without a back-edge fails closed (WI-380 AC2, NFR-6)', () => {
  it('rejects a maker that references {{feedback}} with no on_reject targeting it', () => {
    const { yaml, files } = feedbackMakerFlow('none');
    const result = loadInline(yaml, files);

    expect(result.ok).toBe(false);
    // No FlowConfig leaks out on the failure branch.
    expect(result).not.toHaveProperty('flow');
    expect(errorCodes(result)).toContain('FEEDBACK_WITHOUT_BACK_EDGE');
  });

  it('names the offending station and explains the feedback input can never be supplied', () => {
    const { yaml, files } = feedbackMakerFlow('none');
    const text = errorText(loadInline(yaml, files));

    // Actionable error: names station S, mentions the feedback input, and the
    // back-edge / reachability reason (NFR-6).
    expect(text).toContain('ideate');
    expect(text).toMatch(/feedback/i);
    expect(text).toMatch(/back-edge|on_reject|rework|never be supplied|reachable/i);
  });
});

// ---------------------------------------------------------------------------
// AC3 — regression: a flow with no {{feedback}} placeholder anywhere loads
//        exactly as before. No false positive when feedback is simply absent,
//        even for a station that is NOT a back-edge target.
// ---------------------------------------------------------------------------

describe('loadFlow — no feedback placeholder loads unchanged (WI-380 AC3)', () => {
  it('loads a maker with no {{feedback}} reference and no back-edge (no false positive)', () => {
    // modelFlow’s default prompt references only {{context.json}} and has no
    // back-edge — it must NOT be flagged by the feedback rule.
    const { yaml, files } = modelFlow();
    expect(loadInline(yaml, files).ok).toBe(true);
  });

  it('does not emit FEEDBACK_WITHOUT_BACK_EDGE for a feedback-free flow', () => {
    const { yaml, files } = modelFlow({
      inputs: '[context.json]',
      promptBody: 'Use {{context.json}} to write an idea.',
    });
    const result = loadInline(yaml, files);
    expect(result.ok).toBe(true);
    // Belt-and-suspenders: even were another error to appear, this code must not.
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).not.toContain('FEEDBACK_WITHOUT_BACK_EDGE');
    }
  });
});

// ---------------------------------------------------------------------------
// AC4 — the feedback error is collected ALONGSIDE other fail-closed errors (all
//        returned together), not thrown mid-parse.
// ---------------------------------------------------------------------------

describe('loadFlow — feedback error is collected with the others, not thrown (WI-380 AC4)', () => {
  // A feedback-without-back-edge `ideate` PLUS an independent UNKNOWN_DEPENDS_ON
  // on a second station. Both errors must surface from a single load call.
  const multiError = `
flow: fb
flow_version: 1
project_root: .
terminal_lanes: [done, scrap, hold]
stations:
  - id: ideate
    worker:
      kind: transform
      model: gpt-4o-mini
      prompt_file: prompts/ideate.md
      prompt_version: "1"
      output_schema:
        fields:
          - { name: idea, type: string, required: true }
    inputs: [context.json, feedback]
    outputs: [idea.json]
    next: done
  - id: orphan
    worker: { kind: transform }
    depends_on: [ghost]
`;
  const files = {
    'prompts/ideate.md': 'Make an idea from {{context.json}}\n{{feedback}}\n',
  };

  it('does not throw — validation errors are returned, never raised', () => {
    expect(() => loadInline(multiError, files)).not.toThrow();
  });

  it('returns BOTH the feedback error and the unrelated UNKNOWN_DEPENDS_ON together', () => {
    const codes = errorCodes(loadInline(multiError, files));
    expect(codes).toContain('FEEDBACK_WITHOUT_BACK_EDGE');
    expect(codes).toContain('UNKNOWN_DEPENDS_ON');
  });
});

// ===========================================================================
// CYCLIC_NEXT — a flow whose forward `next` edges form a cycle (no entry
// station) must be rejected at load time. A pure `next` cycle means every
// station is some other station's successor, so entryStationId detection
// yields undefined and the run seeds lane 'intake' which nothing serves —
// the run silently exits without dispatching. The fix: reject at load.
//
// back_edges (check.on_reject) are NOT next edges — legitimate rework loops
// declared via on_reject must NOT be flagged by this check.
//
// New error code pinned by this contract: CYCLIC_NEXT.
// ===========================================================================

describe('loadFlow — CYCLIC_NEXT: forward next cycle is rejected at load', () => {
  // A→B→C→A (all three stations point to each other forming a pure cycle).
  const cyclicNextYaml = `
flow: cycle
flow_version: 1
project_root: .
terminal_lanes: [done, scrap, hold]
security:
  bash:
    allow: [echo]
stations:
  - id: a
    worker: { kind: deterministic, command: echo }
    next: b
  - id: b
    worker: { kind: deterministic, command: echo }
    next: c
  - id: c
    worker: { kind: deterministic, command: echo }
    next: a
`;

  it('rejects a flow whose next edges form a cycle (A→B→C→A)', () => {
    const result = loadInline(cyclicNextYaml);
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('flow');
    expect(errorCodes(result)).toContain('CYCLIC_NEXT');
  });

  it('names the stations involved in the cycle', () => {
    const text = errorText(loadInline(cyclicNextYaml));
    // All three participants should be named in the error message.
    expect(text).toContain('a');
    expect(text).toContain('b');
    expect(text).toContain('c');
  });

  it('does not throw — validation errors are returned, not raised', () => {
    expect(() => loadInline(cyclicNextYaml)).not.toThrow();
  });
});

describe('loadFlow — CYCLIC_NEXT: normal linear flow and back-edge flow are accepted', () => {
  it('accepts a normal linear flow with a valid entry station (no cycle)', () => {
    // a → b → done: a is the entry (not a successor of anything in next).
    const result = loadInline(`
flow: linear
flow_version: 1
project_root: .
terminal_lanes: [done, scrap, hold]
security:
  bash:
    allow: [echo]
stations:
  - id: a
    worker: { kind: deterministic, command: echo }
    next: b
  - id: b
    worker: { kind: deterministic, command: echo }
    next: done
`);
    expect(result.ok).toBe(true);
  });

  it('accepts a flow with a rework back-edge (check.on_reject) — NOT a next cycle', () => {
    // b → done, b has a gate self-loop (on_reject: b).
    // The back-edge is check.on_reject, NOT a `next` edge — must not be flagged.
    const result = loadInline(`
flow: rework
flow_version: 1
project_root: .
terminal_lanes: [done, scrap, hold]
security:
  bash:
    allow: [echo]
stations:
  - id: a
    worker: { kind: deterministic, command: echo }
    next: b
  - id: b
    worker: { kind: deterministic, command: echo }
    next: done
    check:
      kind: gate
      on_reject: a
`);
    expect(result.ok).toBe(true);
  });
});

// ===========================================================================
// WI-393 — branching topology schema + fail-closed loader validation.
//
// A fan-out station may declare three new routing-target fields:
//
//   child_entry    — the station each spawned child card enters first.
//                    MUST name a known station id.            (AC1, AC2)
//   child_terminal — the terminal lane each child sub-path ends at.
//                    MUST name a TERMINAL lane; a non-terminal
//                    lane (station id) is rejected.           (AC1, AC4)
//   resume_at      — the lane the parent resumes at after fan-in.
//                    MUST name a known station id OR a terminal lane. (AC1, AC3)
//
// All three are OPTIONAL: a linear flow (no fan-out) declares none of them and
// loads exactly as before (AC5). Each invalid target is collected fail-closed
// by the existing collectErrors pass — never thrown — and NO FlowConfig is
// produced when any topology field is invalid (the run does not start).
//
// New error codes this contract pins for src/flow/load.ts:
//   UNKNOWN_CHILD_ENTRY      — child_entry is not a known station
//   INVALID_CHILD_TERMINAL   — child_terminal is not a terminal lane
//   UNKNOWN_RESUME_AT        — resume_at is neither a known station nor terminal
//
// Reference: SPEC.md flow.yaml schema / station taxonomy; PRD FR1 / NFR4.
// Fan-out is one level only (nested fan-out is out of scope).
// ===========================================================================

/**
 * Build a 3-station fan-out flow (split → {work}, merge) and parameterise the
 * three branching-topology fields on the `split` fan-out station so each test
 * can override exactly one and assert its fail-closed code. A field set to
 * `null` is OMITTED from the YAML entirely.
 *
 *   split:  fan_out: 2, child_entry, child_terminal, resume_at
 *   work:   the child-entry work station
 *   merge:  the post-fan-in resume station
 *
 * No `next` is declared, so the WI-351 real-run validations (command/allowlist/
 * prompt sourcing) are intentionally skipped — this isolates the topology
 * validations under test.
 */
function branchFlow(
  opts: {
    childEntry?: string | null;
    childTerminal?: string | null;
    resumeAt?: string | null;
  } = {},
): string {
  const childEntry = opts.childEntry === undefined ? 'work' : opts.childEntry;
  const childTerminal = opts.childTerminal === undefined ? 'done' : opts.childTerminal;
  const resumeAt = opts.resumeAt === undefined ? 'merge' : opts.resumeAt;

  const lines: string[] = [
    'flow: branch',
    'flow_version: 1',
    'terminal_lanes: [done, scrap, hold]',
    'stations:',
    '  - id: split',
    '    worker: { kind: deterministic }',
    '    fan_out: 2',
  ];
  if (childEntry !== null) lines.push(`    child_entry: ${childEntry}`);
  if (childTerminal !== null) lines.push(`    child_terminal: ${childTerminal}`);
  if (resumeAt !== null) lines.push(`    resume_at: ${resumeAt}`);
  lines.push(
    '  - id: work',
    '    worker: { kind: deterministic }',
    '  - id: merge',
    '    worker: { kind: deterministic }',
  );
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// v10 — child_stagger_seconds (fan-out cache-warming stagger knob): a
//        non-negative integer, only on a fan-out station.
// ---------------------------------------------------------------------------

describe('loadFlow — child_stagger_seconds validation (v10 fan-out stagger)', () => {
  function staggered(value: string, opts: { fanOut?: boolean } = {}): string {
    const lines = [
      'flow: stagger',
      'flow_version: 1',
      'terminal_lanes: [done, scrap, hold]',
      'stations:',
      '  - id: split',
      '    worker: { kind: deterministic }',
    ];
    if (opts.fanOut !== false) {
      lines.push('    fan_out: 2', '    child_entry: work', '    child_terminal: done', '    resume_at: merge');
    }
    lines.push(`    child_stagger_seconds: ${value}`);
    lines.push('  - id: work', '    worker: { kind: deterministic }', '  - id: merge', '    worker: { kind: deterministic }');
    return lines.join('\n') + '\n';
  }

  it('accepts a non-negative integer on a fan-out station and parses it onto the config', () => {
    expect(expectOk(loadInline(staggered('2'))).stations.split!.child_stagger_seconds).toBe(2);
  });

  it('accepts 0 as an explicit no-stagger', () => {
    expect(expectOk(loadInline(staggered('0'))).stations.split!.child_stagger_seconds).toBe(0);
  });

  it('rejects a negative value', () => {
    expect(errorCodes(loadInline(staggered('-1')))).toContain('INVALID_CHILD_STAGGER_SECONDS');
  });

  it('rejects a non-integer value', () => {
    expect(errorCodes(loadInline(staggered('1.5')))).toContain('INVALID_CHILD_STAGGER_SECONDS');
  });

  it('rejects the knob on a non-fan-out station (no child_entry to stagger)', () => {
    expect(errorCodes(loadInline(staggered('1', { fanOut: false })))).toContain('INVALID_CHILD_STAGGER_SECONDS');
  });
});

// ---------------------------------------------------------------------------
// v10 — output_scope: where a transform station's declared outputs are written.
//        Enum-valued, transform-only, requires declared outputs.
// ---------------------------------------------------------------------------

describe('loadFlow — output_scope validation (v10 owned-dir outputs)', () => {
  function scoped(value: string, opts: { kind?: string; outputs?: string } = {}): string {
    const kind = opts.kind ?? 'transform';
    const workerExtra =
      kind === 'transform'
        ? [
            '      model: gpt-4o-mini',
            '      prompt_file: prompts/w.md',
            '      prompt_version: "1"',
            '      output_schema: { fields: [{ name: ok, type: string, required: true }] }',
          ].join('\n')
        : '';
    return (
      [
        'flow: scope',
        'flow_version: 1',
        'terminal_lanes: [done, scrap, hold]',
        'stations:',
        '  - id: w',
        '    worker:',
        `      kind: ${kind}`,
        ...(workerExtra ? [workerExtra] : []),
        `    outputs: ${opts.outputs ?? '[out.json]'}`,
        `    output_scope: ${value}`,
      ].join('\n') + '\n'
    );
  }
  const FILES = { 'prompts/w.md': 'w' };

  it('accepts owned_dir on a transform station with outputs, parsed onto the config', () => {
    expect(expectOk(loadInline(scoped('owned_dir'), FILES)).stations.w!.output_scope).toBe('owned_dir');
  });

  it('accepts the explicit default project_root', () => {
    expect(expectOk(loadInline(scoped('project_root'), FILES)).stations.w!.output_scope).toBe('project_root');
  });

  it('rejects an unknown scope value', () => {
    expect(errorCodes(loadInline(scoped('card_dir'), FILES))).toContain('INVALID_OUTPUT_SCOPE');
  });

  it('rejects output_scope on a non-transform station', () => {
    expect(errorCodes(loadInline(scoped('owned_dir', { kind: 'deterministic' })))).toContain('INVALID_OUTPUT_SCOPE');
  });

  it('rejects output_scope with no declared outputs', () => {
    expect(errorCodes(loadInline(scoped('owned_dir', { outputs: '[]' }), FILES))).toContain('INVALID_OUTPUT_SCOPE');
  });
});

// ---------------------------------------------------------------------------
// issue #51 — input_scope: which declared inputs are READ from the card's
//        owned dir. A list ⊆ inputs, never 'feedback', transform OR harness
//        (unlike output_scope, harness stations read inputs too).
// ---------------------------------------------------------------------------

describe('loadFlow — input_scope validation (issue #51 owned-dir inputs)', () => {
  function scopedInputs(
    ownedDir: string,
    opts: { kind?: string; inputs?: string } = {},
  ): string {
    const kind = opts.kind ?? 'transform';
    const workerExtra =
      kind === 'transform'
        ? [
            '      model: gpt-4o-mini',
            '      prompt_file: prompts/w.md',
            '      prompt_version: "1"',
            '      output_schema: { fields: [{ name: ok, type: string, required: true }] }',
          ].join('\n')
        : kind === 'harness'
          ? [
              '      harness: claude-code',
              '      prompt_file: prompts/w.md',
              '      prompt_version: "1"',
            ].join('\n')
          : '';
    return (
      [
        'flow: scope',
        'flow_version: 1',
        'terminal_lanes: [done, scrap, hold]',
        'stations:',
        '  - id: w',
        '    worker:',
        `      kind: ${kind}`,
        ...(workerExtra ? [workerExtra] : []),
        `    inputs: ${opts.inputs ?? '[patch.txt, style-guide.md]'}`,
        '    outputs: [out.json]',
        '    input_scope:',
        `      owned_dir: ${ownedDir}`,
      ].join('\n') + '\n'
    );
  }
  const FILES = { 'prompts/w.md': 'w' };

  it('accepts a valid list, parsed onto the config', () => {
    const station = expectOk(loadInline(scopedInputs('[patch.txt]'), FILES)).stations.w!;
    expect(station.input_scope).toEqual({ owned_dir: ['patch.txt'] });
  });

  it('accepts several declared inputs at once', () => {
    const station = expectOk(
      loadInline(scopedInputs('[patch.txt, style-guide.md]'), FILES),
    ).stations.w!;
    expect(station.input_scope).toEqual({ owned_dir: ['patch.txt', 'style-guide.md'] });
  });

  it('leaves input_scope ABSENT when not declared', () => {
    const noScope =
      [
        'flow: scope',
        'flow_version: 1',
        'terminal_lanes: [done, scrap, hold]',
        'stations:',
        '  - id: w',
        '    worker:',
        '      kind: transform',
        '      model: gpt-4o-mini',
        '      prompt_file: prompts/w.md',
        '      prompt_version: "1"',
        '      output_schema: { fields: [{ name: ok, type: string, required: true }] }',
        '    inputs: [patch.txt]',
        '    outputs: [out.json]',
      ].join('\n') + '\n';
    expect(expectOk(loadInline(noScope, FILES)).stations.w!.input_scope).toBeUndefined();
  });

  it('rejects a non-list owned_dir', () => {
    expect(errorCodes(loadInline(scopedInputs('patch.txt'), FILES))).toContain('INVALID_INPUT_SCOPE');
  });

  it('rejects a list holding a non-string entry', () => {
    expect(errorCodes(loadInline(scopedInputs('[7]'), FILES))).toContain('INVALID_INPUT_SCOPE');
  });

  it('rejects a name that is not among the declared inputs', () => {
    expect(errorCodes(loadInline(scopedInputs('[nope.txt]'), FILES))).toContain('INVALID_INPUT_SCOPE');
  });

  it('rejects the synthetic feedback input (never on disk)', () => {
    expect(
      errorCodes(loadInline(scopedInputs('[feedback]', { inputs: '[patch.txt, feedback]' }), FILES)),
    ).toContain('INVALID_INPUT_SCOPE');
  });

  it('accepts input_scope on a HARNESS station (unlike output_scope)', () => {
    const station = expectOk(
      loadInline(scopedInputs('[patch.txt]', { kind: 'harness' }), FILES),
    ).stations.w!;
    expect(station.input_scope).toEqual({ owned_dir: ['patch.txt'] });
  });

  it('rejects input_scope on a station kind that reads no prompt inputs', () => {
    expect(
      errorCodes(loadInline(scopedInputs('[patch.txt]', { kind: 'deterministic' }), FILES)),
    ).toContain('INVALID_INPUT_SCOPE');
  });
});

// ---------------------------------------------------------------------------
// AC1 — a valid fan-out station loads and exposes the parsed topology on the
//        station config. resume_at may name a station OR a terminal lane.
// ---------------------------------------------------------------------------

describe('loadFlow — branching topology parsed onto the station config (WI-393 AC1)', () => {
  it('exposes child_entry, child_terminal, and resume_at on the fan-out station', () => {
    const flow = expectOk(loadInline(branchFlow()));
    expect(flow.stations.split!.child_entry).toBe('work');
    expect(flow.stations.split!.child_terminal).toBe('done');
    expect(flow.stations.split!.resume_at).toBe('merge');
  });

  it('accepts resume_at naming a terminal lane (the station-OR-terminal branch)', () => {
    const flow = expectOk(loadInline(branchFlow({ resumeAt: 'done' })));
    expect(flow.stations.split!.resume_at).toBe('done');
  });

  it('accepts child_terminal naming the scrap terminal lane', () => {
    const flow = expectOk(loadInline(branchFlow({ childTerminal: 'scrap' })));
    expect(flow.stations.split!.child_terminal).toBe('scrap');
  });
});

// ---------------------------------------------------------------------------
// AC2 — child_entry naming a station not present in the flow fails load with a
//        descriptive error, and NO FlowConfig is produced (the run does not
//        start).
// ---------------------------------------------------------------------------

describe('loadFlow — child_entry must name a known station (WI-393 AC2)', () => {
  it('rejects a fan-out child_entry naming an unknown station (UNKNOWN_CHILD_ENTRY)', () => {
    const result = loadInline(branchFlow({ childEntry: 'ghost' }));
    expect(result.ok).toBe(false);
    // The run does not start: no FlowConfig leaks out on the failure branch.
    expect(result).not.toHaveProperty('flow');
    expect(errorCodes(result)).toContain('UNKNOWN_CHILD_ENTRY');
    // Descriptive: the error names the offending target.
    expect(errorText(result)).toContain('ghost');
  });
});

// ---------------------------------------------------------------------------
// AC3 — post-fan-in resume_at naming an unknown station OR terminal fails load
//        with a descriptive error.
// ---------------------------------------------------------------------------

describe('loadFlow — resume_at must name a known station or terminal (WI-393 AC3)', () => {
  it('rejects a resume_at naming an unknown lane (UNKNOWN_RESUME_AT)', () => {
    const result = loadInline(branchFlow({ resumeAt: 'ghost' }));
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('flow');
    expect(errorCodes(result)).toContain('UNKNOWN_RESUME_AT');
    expect(errorText(result)).toContain('ghost');
  });
});

// ---------------------------------------------------------------------------
// AC4 — child_terminal naming a non-terminal lane (a station id) fails load.
//        "MUST be a terminal" is an exclusionary qualifier → positive coverage
//        lives in AC1 (child_terminal: done / scrap accepted); this is the
//        negative half.
// ---------------------------------------------------------------------------

describe('loadFlow — child_terminal must name a terminal lane (WI-393 AC4)', () => {
  it('rejects a child_terminal naming a non-terminal lane / station (INVALID_CHILD_TERMINAL)', () => {
    // 'work' is a defined station — a non-terminal lane — so it is not a legal
    // child sub-path terminal.
    const result = loadInline(branchFlow({ childTerminal: 'work' }));
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('flow');
    expect(errorCodes(result)).toContain('INVALID_CHILD_TERMINAL');
    expect(errorText(result)).toContain('work');
  });
});

// ---------------------------------------------------------------------------
// fail-closed: topology errors are COLLECTED (not thrown) and returned
// alongside other errors — the existing collectErrors discipline (NFR-4).
// ---------------------------------------------------------------------------

describe('loadFlow — branching topology errors are collected fail-closed (WI-393)', () => {
  it('does not throw — topology validation errors are returned, never raised', () => {
    expect(() => loadInline(branchFlow({ childEntry: 'ghost', resumeAt: 'nope' }))).not.toThrow();
  });

  it('returns multiple topology errors together (child_entry + resume_at)', () => {
    const codes = errorCodes(loadInline(branchFlow({ childEntry: 'ghostA', resumeAt: 'ghostB' })));
    expect(codes).toContain('UNKNOWN_CHILD_ENTRY');
    expect(codes).toContain('UNKNOWN_RESUME_AT');
  });

  it('collects a topology error alongside an unrelated validation error', () => {
    // A bad child_entry on `split` PLUS an unrelated unknown depends_on on a
    // second station — both must surface from a single load call.
    const yaml = `
flow: branch
flow_version: 1
terminal_lanes: [done, scrap, hold]
stations:
  - id: split
    worker: { kind: deterministic }
    fan_out: 2
    child_entry: ghost
    child_terminal: done
    resume_at: merge
  - id: work
    worker: { kind: deterministic }
  - id: merge
    worker: { kind: deterministic }
    depends_on: [nowhere]
`;
    const codes = errorCodes(loadInline(yaml));
    expect(codes).toContain('UNKNOWN_CHILD_ENTRY');
    expect(codes).toContain('UNKNOWN_DEPENDS_ON');
  });
});

// ---------------------------------------------------------------------------
// AC5 — the new fields are OPTIONAL. A linear flow with no fan-out station
//        loads unchanged, and a fan-out station that declares fan_out but NONE
//        of the topology fields (the committed reference/example flows) is not
//        tripped by the new validations.
// ---------------------------------------------------------------------------

describe('loadFlow — branching-topology fields are optional (WI-393 AC5)', () => {
  it('loads a linear flow with no fan-out and no topology fields', () => {
    const flow = expectOk(loadInline(`
flow: linear
flow_version: 1
terminal_lanes: [done, scrap, hold]
stations:
  - id: a
    worker: { kind: transform }
  - id: b
    worker: { kind: transform }
`));
    // The new fields are absent on a linear flow's stations.
    expect(flow.stations.a!.child_entry).toBeUndefined();
    expect(flow.stations.a!.child_terminal).toBeUndefined();
    expect(flow.stations.a!.resume_at).toBeUndefined();
  });

  it('still loads the reference flow (fan_out present, no topology fields) unchanged', () => {
    // reference.flow.yaml has plan.fan_out: 3 but declares NONE of the new
    // topology fields — the new validations must not fire on an absent field.
    const flow = expectOk(loadFlow(fixture('reference.flow.yaml')));
    expect(flow.stations.plan!.fan_out).toBe(3);
    expect(flow.stations.plan!.child_entry).toBeUndefined();
    expect(flow.stations.plan!.child_terminal).toBeUndefined();
    expect(flow.stations.plan!.resume_at).toBeUndefined();
  });

  it('still loads the committed example flow unchanged', () => {
    expect(loadFlow(EXAMPLE_FLOW).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC6 — a HITL rank station that OMITS on_timeout defaults to hold-indefinitely
//        (no auto-pick) and MUST NOT be rejected by the loader. The runtime
//        hold-indefinitely default is out of scope for the loader; the loader's
//        sole obligation here is to NOT reject the station.
// ---------------------------------------------------------------------------

describe('loadFlow — HITL rank station without on_timeout is accepted (WI-393 AC6)', () => {
  // A rank check-only station (no worker, no `next`), mirroring the reference
  // flow's `select`. `withOnTimeout` toggles the optional on_timeout line.
  const rankFlow = (withOnTimeout: boolean): string => {
    const lines: string[] = [
      'flow: hitl',
      'flow_version: 1',
      'terminal_lanes: [done, scrap, hold]',
      'stations:',
      '  - id: draft',
      '    worker: { kind: transform }',
      '  - id: select',
      '    check:',
      '      kind: rank',
      '      class: taste',
      '      critic:',
      '        role: selector',
      '        model: gpt-4o',
      '      on_reject: draft',
      '      rework_cap: 2',
    ];
    if (withOnTimeout) lines.push('      on_timeout: scrap');
    return lines.join('\n') + '\n';
  };

  it('accepts a rank station that OMITS on_timeout (no auto-pick default; not rejected)', () => {
    const result = loadInline(rankFlow(false));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      // Belt-and-suspenders: the rank station must never be rejected for a
      // missing on_timeout.
      expect(result.errors.map((e) => e.code)).not.toContain('HOLD_TIMEOUT_WITHOUT_ON_TIMEOUT');
    }
  });

  it('also accepts a rank station that declares on_timeout (field is optional either way)', () => {
    expect(loadInline(rankFlow(true)).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// WI-442 — preserve the flow name and station/critic roles in FlowConfig.
//
// The loader already PARSES these fields (RawYaml.flow, RawWorker.role,
// RawCritic.role) but DISCARDS them — they never reach the FlowConfig. These
// tests pin that they are carried through onto:
//   - FlowConfig.name              ← top-level `flow:`
//   - StationConfig.role           ← station `worker.role`
//   - StationGateConfig.criticRole ← gate check `critic.role`
//
// Each field is OPTIONAL: declared → preserved verbatim; absent → undefined
// (never an empty string), matching the optional-field convention of the
// surrounding config surface (next, prompt_file, image_inputs).
// ---------------------------------------------------------------------------

describe('loadFlow — flow name preservation (WI-442)', () => {
  it('preserves the top-level `flow:` name from the reference flow', () => {
    const flow = expectOk(loadFlow(fixture('reference.flow.yaml')));
    expect(flow.name).toBe('content-pipeline');
  });

  it('preserves an arbitrary flow name verbatim', () => {
    const flow = expectOk(
      loadInline(
        [
          'flow: my-bespoke-pipeline',
          'flow_version: 1',
          'terminal_lanes: [done, scrap, hold]',
          'stations:',
          '  - id: draft',
          '    worker: { kind: transform }',
          '    inputs: [req.json]',
          '    outputs: [draft.md]',
        ].join('\n') + '\n',
      ),
    );
    expect(flow.name).toBe('my-bespoke-pipeline');
  });

  it('leaves name undefined when `flow:` is absent (no empty-string fallback)', () => {
    const flow = expectOk(
      loadInline(
        [
          'flow_version: 1',
          'terminal_lanes: [done, scrap, hold]',
          'stations:',
          '  - id: draft',
          '    worker: { kind: transform }',
          '    inputs: [req.json]',
          '    outputs: [draft.md]',
        ].join('\n') + '\n',
      ),
    );
    expect(flow.name).toBeUndefined();
  });
});

describe('loadFlow — station worker role preservation (WI-442)', () => {
  // Roles must be carried through regardless of worker kind — the role lives on
  // RawWorker and is independent of transform vs deterministic. Asserting both
  // kinds guards against an impl that only wires the field on one branch.
  it.each([
    ['plan', 'planner'],     // transform worker
    ['draft', 'drafter'],    // transform worker
    ['publish', 'publisher'], // transform worker (effectful)
    ['assemble', 'assembler'], // deterministic worker
  ])('preserves worker.role for station %s as %s', (stationId, role) => {
    const flow = expectOk(loadFlow(fixture('reference.flow.yaml')));
    expect(flow.stations[stationId]!.role).toBe(role);
  });

  it('leaves role undefined when a worker declares no role', () => {
    const flow = expectOk(
      loadInline(
        [
          'flow: no-role',
          'flow_version: 1',
          'terminal_lanes: [done, scrap, hold]',
          'stations:',
          '  - id: build',
          '    worker: { kind: transform, model: gpt-4o-mini }',
          '    inputs: [a.json]',
          '    outputs: [b.json]',
        ].join('\n') + '\n',
      ),
    );
    expect(flow.stations.build!.role).toBeUndefined();
  });

  it('leaves role undefined for a check-only station with no worker', () => {
    // `select` in the reference flow is a rank check-only station — no worker
    // block at all, so there is no role to carry.
    const flow = expectOk(loadFlow(fixture('reference.flow.yaml')));
    expect(flow.stations.select!.role).toBeUndefined();
  });
});

describe('loadFlow — gate critic role preservation (WI-442)', () => {
  it('preserves the gate critic role into StationGateConfig.criticRole', () => {
    const flow = expectOk(loadFlow(fixture('reference.flow.yaml')));
    const gate = flow.stations.plan!.gateCheck;
    expect(gate).toBeDefined();
    expect(gate!.criticRole).toBe('plan-critic');
  });

  it('leaves criticRole undefined when the gate critic declares no role', () => {
    const flow = expectOk(
      loadInline(
        [
          'flow: gate-no-critic-role',
          'flow_version: 1',
          'terminal_lanes: [done, scrap, hold]',
          'stations:',
          '  - id: write',
          '    worker: { kind: transform, role: writer, model: gpt-4o-mini }',
          '    inputs: [req.json]',
          '    outputs: [out.md]',
          '    check:',
          '      kind: gate',
          '      critic: { model: gpt-4o-mini }',
          '      on_reject: write',
          '      rework_cap: 1',
        ].join('\n') + '\n',
      ),
    );
    const gate = flow.stations.write!.gateCheck;
    expect(gate).toBeDefined();
    expect(gate!.criticRole).toBeUndefined();
    // The worker role on the same station IS preserved — the two are wired
    // independently, so a missing critic role must not suppress the worker role.
    expect(flow.stations.write!.role).toBe('writer');
  });
});
