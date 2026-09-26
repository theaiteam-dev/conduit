/**
 * Load-time validation of a station's `skip_when` predicate (issue #32).
 *
 * `skip_when` lets the kernel pass a card straight to the station's declared
 * `next` when a field read from card state equals a scalar. The loader checks
 * the declaration before anything runs:
 *
 *   - INVALID_SKIP_WHEN          malformed block: not a mapping, unknown source,
 *                                missing or empty field, missing or non-scalar
 *                                equals, or (source: output) a station that is
 *                                unknown, not a transform, has no such
 *                                output_schema field, or is not upstream.
 *   - SKIP_WHEN_WITHOUT_NEXT     the station declares no `next` to skip to.
 *   - SKIP_WHEN_OUTPUTS_CONSUMED a skipped station writes none of its outputs,
 *                                so no other station may declare one as input.
 *   - SKIP_WHEN_ON_REWORK_TARGET a gate's on_reject may not target the station:
 *                                the card would re-enter, skip again, and reach
 *                                the gate unchanged.
 *
 * Every test drives the real loadFlow() against an inline flow.yaml.
 */
import { describe, it, expect } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { FlowConfig } from '../types/kernel';
import { loadFlow, type LoadFlowResult } from './load';

/** Write `yaml` (plus a shared prompt file) to a temp dir and load it. */
function loadInline(yaml: string): LoadFlowResult {
  const dir = mkdtempSync(join(tmpdir(), 'conduit-skip-when-flow-'));
  try {
    writeFileSync(join(dir, 'classify.md'), 'Classify {{seed.json}}', 'utf-8');
    writeFileSync(join(dir, 'flow.yaml'), yaml, 'utf-8');
    return loadFlow(join(dir, 'flow.yaml'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function expectOk(result: LoadFlowResult): FlowConfig {
  if (!result.ok) throw new Error(`expected ok, got errors: ${JSON.stringify(result.errors)}`);
  return result.flow;
}

function codes(result: LoadFlowResult): string[] {
  if (result.ok) throw new Error('expected validation errors, but load succeeded');
  return result.errors.map((e) => e.code);
}

function messages(result: LoadFlowResult): string {
  if (result.ok) throw new Error('expected validation errors, but load succeeded');
  return result.errors.map((e) => e.message).join(' | ');
}

/**
 * A three-station deterministic chain: prep -> write_tests -> implement -> done.
 * `skip` is inserted verbatim under write_tests; `extra` is appended to the
 * stations list.
 */
function chainYaml(opts: {
  skip?: string;
  writeTestsNext?: string | null;
  writeTestsOutputs?: string;
  implementInputs?: string;
  implementCheck?: string;
}): string {
  const writeTestsNext = opts.writeTestsNext === undefined ? 'implement' : opts.writeTestsNext;
  return [
    'flow: skiptest',
    'flow_version: 1',
    'terminal_lanes: [done, scrap, hold]',
    'security:',
    '  bash: { allow: ["true"] }',
    'stations:',
    '  - id: prep',
    '    worker: { kind: deterministic, command: "true" }',
    '    next: write_tests',
    '  - id: write_tests',
    '    worker: { kind: deterministic, command: "true" }',
    opts.writeTestsOutputs !== undefined ? `    outputs: ${opts.writeTestsOutputs}` : '',
    opts.skip ?? '',
    writeTestsNext !== null ? `    next: ${writeTestsNext}` : '',
    '  - id: implement',
    '    worker: { kind: deterministic, command: "true" }',
    opts.implementInputs !== undefined ? `    inputs: ${opts.implementInputs}` : '',
    opts.implementCheck ?? '',
    '    next: done',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * A chain with a transform `classify` upstream of the skippable station, for
 * the `source: output` form. `classifyNext` lets a test put classify after the
 * skippable station instead.
 */
function outputSourceYaml(opts: { skip: string; downstreamClassify?: boolean }): string {
  const classify = [
    '  - id: classify',
    '    worker:',
    '      kind: transform',
    '      model: m',
    '      prompt_file: classify.md',
    '      prompt_version: 1',
    '      output_schema:',
    '        fields:',
    '          - { name: needs_tests, type: boolean, required: true }',
    '          - { name: notes, type: string, required: false }',
    '    inputs: [seed.json]',
  ];
  const writeTests = [
    '  - id: write_tests',
    '    worker: { kind: deterministic, command: "true" }',
    opts.skip,
  ];
  const lines = opts.downstreamClassify === true
    ? [...writeTests, '    next: classify', ...classify, '    next: done']
    : [...classify, '    next: write_tests', ...writeTests, '    next: done'];
  return [
    'flow: skiptest',
    'flow_version: 1',
    'terminal_lanes: [done, scrap, hold]',
    'security:',
    '  bash: { allow: ["true"] }',
    'stations:',
    ...lines,
  ].join('\n');
}

describe('skip_when parses onto StationConfig', () => {
  it('a seed predicate is carried verbatim', () => {
    const flow = expectOk(
      loadInline(chainYaml({ skip: '    skip_when: { source: seed, field: no_test_needed, equals: true }' })),
    );
    expect(flow.stations['write_tests']!.skip_when).toEqual({
      source: 'seed',
      field: 'no_test_needed',
      equals: true,
    });
  });

  it('string and number scalars are accepted for equals', () => {
    const str = expectOk(loadInline(chainYaml({ skip: '    skip_when: { source: seed, field: kind, equals: docs }' })));
    expect(str.stations['write_tests']!.skip_when?.equals).toBe('docs');
    const num = expectOk(loadInline(chainYaml({ skip: '    skip_when: { source: seed, field: tier, equals: 0 }' })));
    expect(num.stations['write_tests']!.skip_when?.equals).toBe(0);
  });

  it('an output predicate on an upstream transform field is carried verbatim', () => {
    const flow = expectOk(
      loadInline(
        outputSourceYaml({
          skip: '    skip_when: { source: output, station: classify, field: needs_tests, equals: false }',
        }),
      ),
    );
    expect(flow.stations['write_tests']!.skip_when).toEqual({
      source: 'output',
      station: 'classify',
      field: 'needs_tests',
      equals: false,
    });
  });

  it('a station without skip_when has no skip_when key', () => {
    const flow = expectOk(loadInline(chainYaml({})));
    expect('skip_when' in flow.stations['write_tests']!).toBe(false);
  });
});

describe('INVALID_SKIP_WHEN — malformed predicate', () => {
  const cases: Array<[string, string]> = [
    ['not a mapping', '    skip_when: true'],
    ['unknown source', '    skip_when: { source: card, field: x, equals: true }'],
    ['missing source', '    skip_when: { field: x, equals: true }'],
    ['missing field', '    skip_when: { source: seed, equals: true }'],
    ['empty field', '    skip_when: { source: seed, field: "", equals: true }'],
    ['missing equals', '    skip_when: { source: seed, field: x }'],
    ['null equals', '    skip_when: { source: seed, field: x, equals: null }'],
    ['list equals', '    skip_when: { source: seed, field: x, equals: [1, 2] }'],
    ['mapping equals', '    skip_when: { source: seed, field: x, equals: { a: 1 } }'],
    ['unknown key', '    skip_when: { source: seed, field: x, equals: true, when: now }'],
  ];
  for (const [name, skip] of cases) {
    it(`rejects ${name}`, () => {
      const result = loadInline(chainYaml({ skip }));
      expect(codes(result)).toContain('INVALID_SKIP_WHEN');
      expect(messages(result)).toContain('write_tests');
    });
  }

  it('rejects source: seed with a station key', () => {
    const result = loadInline(chainYaml({ skip: '    skip_when: { source: seed, station: prep, field: x, equals: true }' }));
    expect(codes(result)).toContain('INVALID_SKIP_WHEN');
  });

  it('rejects source: output without a station', () => {
    const result = loadInline(
      outputSourceYaml({ skip: '    skip_when: { source: output, field: needs_tests, equals: false }' }),
    );
    expect(codes(result)).toContain('INVALID_SKIP_WHEN');
  });

  it('rejects source: output naming an unknown station', () => {
    const result = loadInline(
      outputSourceYaml({ skip: '    skip_when: { source: output, station: nope, field: needs_tests, equals: false }' }),
    );
    expect(codes(result)).toContain('INVALID_SKIP_WHEN');
    expect(messages(result)).toContain('nope');
  });

  it('rejects source: output naming a non-transform station', () => {
    const result = loadInline(
      chainYaml({ skip: '    skip_when: { source: output, station: prep, field: x, equals: true }' }),
    );
    expect(codes(result)).toContain('INVALID_SKIP_WHEN');
    expect(messages(result)).toContain('prep');
  });

  it('rejects source: output naming a field the transform output_schema does not declare', () => {
    const result = loadInline(
      outputSourceYaml({ skip: '    skip_when: { source: output, station: classify, field: missing, equals: false }' }),
    );
    expect(codes(result)).toContain('INVALID_SKIP_WHEN');
    expect(messages(result)).toContain('missing');
  });

  it('rejects source: output naming a transform that is not upstream of the station', () => {
    const result = loadInline(
      outputSourceYaml({
        skip: '    skip_when: { source: output, station: classify, field: needs_tests, equals: false }',
        downstreamClassify: true,
      }),
    );
    expect(codes(result)).toContain('INVALID_SKIP_WHEN');
    expect(messages(result)).toContain('upstream');
  });
});

describe('SKIP_WHEN_WITHOUT_NEXT', () => {
  it('rejects skip_when on a station with no declared next', () => {
    const result = loadInline(
      chainYaml({
        skip: '    skip_when: { source: seed, field: no_test_needed, equals: true }',
        writeTestsNext: null,
      }),
    );
    expect(codes(result)).toContain('SKIP_WHEN_WITHOUT_NEXT');
    expect(messages(result)).toContain('write_tests');
  });
});

describe('SKIP_WHEN_OUTPUTS_CONSUMED', () => {
  it('rejects skip_when on a station whose output another station reads', () => {
    const result = loadInline(
      chainYaml({
        skip: '    skip_when: { source: seed, field: no_test_needed, equals: true }',
        writeTestsOutputs: '[tests.txt]',
        implementInputs: '[tests.txt]',
      }),
    );
    expect(codes(result)).toContain('SKIP_WHEN_OUTPUTS_CONSUMED');
    expect(messages(result)).toContain('tests.txt');
    expect(messages(result)).toContain('implement');
  });

  it('accepts skip_when on a station whose outputs nobody reads', () => {
    expectOk(
      loadInline(
        chainYaml({
          skip: '    skip_when: { source: seed, field: no_test_needed, equals: true }',
          writeTestsOutputs: '[tests.txt]',
        }),
      ),
    );
  });
});

describe('SKIP_WHEN_ON_REWORK_TARGET', () => {
  it('rejects skip_when on a station that a gate on_reject targets', () => {
    const result = loadInline(
      chainYaml({
        skip: '    skip_when: { source: seed, field: no_test_needed, equals: true }',
        implementCheck: [
          '    check:',
          '      kind: gate',
          '      critic: { role: critic, model: m }',
          '      on_reject: write_tests',
          '      rework_cap: 1',
        ].join('\n'),
      }),
    );
    expect(codes(result)).toContain('SKIP_WHEN_ON_REWORK_TARGET');
    expect(messages(result)).toContain('implement');
  });
});
