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
 *   - SKIP_WHEN_READS_SKIPPABLE  a `source: output` predicate may not name a
 *                                station that itself declares skip_when: a
 *                                skipped station writes no checkpoint, so a
 *                                pass where the upstream station skips would
 *                                leave the reader looking at a stale checkpoint
 *                                from an earlier pass.
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
 * the `source: output` form. `downstreamClassify` puts classify after the
 * skippable station instead (the not-upstream negative). `hops` controls how
 * many `next` edges separate classify from write_tests: the default, 1, is
 * the direct single-hop chain; hops > 1 splices `hops - 1` intermediate
 * deterministic stations (mid1, mid2, ...) in between, so the loader's
 * transitive `next`-chain walk in validateOutputSource must actually iterate
 * rather than compare a single next pointer.
 */
function outputSourceYaml(opts: {
  skip: string;
  downstreamClassify?: boolean;
  classifySkipWhen?: string;
  hops?: number;
}): string {
  const hops = opts.hops ?? 1;
  const midIds = Array.from({ length: Math.max(hops - 1, 0) }, (_, i) => `mid${i + 1}`);

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
    ...(opts.classifySkipWhen !== undefined ? [opts.classifySkipWhen] : []),
  ];
  const writeTests = [
    '  - id: write_tests',
    '    worker: { kind: deterministic, command: "true" }',
    opts.skip,
  ];
  const mid = (id: string): string[] => [`  - id: ${id}`, '    worker: { kind: deterministic, command: "true" }'];

  // Wire `next` between consecutive entries in the chain, ending at `done`.
  const chain: Array<{ id: string; body: string[] }> = opts.downstreamClassify === true
    ? [{ id: 'write_tests', body: writeTests }, ...midIds.map((id) => ({ id, body: mid(id) })), { id: 'classify', body: classify }]
    : [{ id: 'classify', body: classify }, ...midIds.map((id) => ({ id, body: mid(id) })), { id: 'write_tests', body: writeTests }];
  const lines: string[] = [];
  for (let i = 0; i < chain.length; i++) {
    lines.push(...chain[i]!.body, `    next: ${i < chain.length - 1 ? chain[i + 1]!.id : 'done'}`);
  }

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

describe('source: output — transitive next-chain walk', () => {
  it('accepts a source: output predicate with an intermediate deterministic station between the upstream transform and the skip station', () => {
    const flow = expectOk(
      loadInline(
        outputSourceYaml({
          skip: '    skip_when: { source: output, station: classify, field: needs_tests, equals: false }',
          hops: 2,
        }),
      ),
    );
    expect(flow.stations['mid1']!.kind).toBe('deterministic');
    expect(flow.stations['write_tests']!.skip_when).toEqual({
      source: 'output',
      station: 'classify',
      field: 'needs_tests',
      equals: false,
    });
  });

  it('rejects source: output naming a transform that is two hops downstream of the skip station', () => {
    const result = loadInline(
      outputSourceYaml({
        skip: '    skip_when: { source: output, station: classify, field: needs_tests, equals: false }',
        downstreamClassify: true,
        hops: 2,
      }),
    );
    expect(codes(result)).toContain('INVALID_SKIP_WHEN');
    expect(messages(result)).toContain('upstream');
  });

  // A cycle in the upstream station's own `next` chain (independent of
  // write_tests, which sits outside it) is already rejected by CYCLIC_NEXT,
  // but validateSkipWhen runs unconditionally alongside every other check
  // (load.ts collects all errors rather than short-circuiting), so this still
  // drives validateOutputSource's walk through a cycle. Without the visited
  // set the while loop would spin forever between classify and mid; with it,
  // the walk terminates and correctly falls through to INVALID_SKIP_WHEN
  // because the cycle never reaches write_tests.
  it('terminates (does not hang) when the named station is on a cyclic next chain that never reaches the skip station', () => {
    const yaml = [
      'flow: skiptest',
      'flow_version: 1',
      'terminal_lanes: [done, scrap, hold]',
      'security:',
      '  bash: { allow: ["true"] }',
      'stations:',
      '  - id: classify',
      '    worker:',
      '      kind: transform',
      '      model: m',
      '      prompt_file: classify.md',
      '      prompt_version: 1',
      '      output_schema:',
      '        fields:',
      '          - { name: needs_tests, type: boolean, required: true }',
      '    inputs: [seed.json]',
      '    next: mid',
      '  - id: mid',
      '    worker: { kind: deterministic, command: "true" }',
      '    next: classify',
      '  - id: write_tests',
      '    worker: { kind: deterministic, command: "true" }',
      '    skip_when: { source: output, station: classify, field: needs_tests, equals: false }',
      '    next: done',
    ].join('\n');
    const result = loadInline(yaml);
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

describe('SKIP_WHEN_READS_SKIPPABLE', () => {
  it('rejects a source: output predicate naming a station that itself declares skip_when', () => {
    const result = loadInline(
      outputSourceYaml({
        skip: '    skip_when: { source: output, station: classify, field: needs_tests, equals: false }',
        classifySkipWhen: '    skip_when: { source: seed, field: precomputed, equals: true }',
      }),
    );
    expect(codes(result)).toContain('SKIP_WHEN_READS_SKIPPABLE');
    expect(messages(result)).toContain('classify');
    expect(messages(result)).toContain('write_tests');
  });

  it('accepts a source: output predicate naming a station with no skip_when of its own', () => {
    expectOk(
      loadInline(
        outputSourceYaml({
          skip: '    skip_when: { source: output, station: classify, field: needs_tests, equals: false }',
        }),
      ),
    );
  });
});
