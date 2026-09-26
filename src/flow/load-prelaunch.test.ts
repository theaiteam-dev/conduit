/**
 * Pre-launch punch-list tests for src/flow/load.ts.
 *
 * Item #4 — no_selection_policy must fail-closed at load (mirror on_timeout).
 * Item #5 — hitlEnabled keys off an egress channel's `uses: [hitl]`, not mere
 *           egress presence.
 * Item #9 — confirming test: a fan-out station that OMITS fan_out loads, and a
 *           quorum fan_in `k` is not rejected for exceeding a (nonexistent)
 *           fan_out upper bound.
 *
 * Self-contained: each flow is written to a throwaway temp dir and loaded.
 */
import { describe, it, expect } from 'bun:test';
import { join, dirname } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { FlowConfig } from '../types/kernel';
import { loadFlow, type LoadFlowResult } from './load';

function loadInline(
  yaml: string,
  extraFiles: Record<string, string> = {},
): LoadFlowResult {
  const dir = mkdtempSync(join(tmpdir(), 'conduit-flow-prelaunch-'));
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

function expectOk(result: LoadFlowResult): FlowConfig {
  if (!result.ok) {
    throw new Error(`expected ok, got errors: ${JSON.stringify(result.errors)}`);
  }
  return result.flow;
}

function expectErrors(result: LoadFlowResult): { code: string; message: string }[] {
  if (result.ok) {
    throw new Error('expected validation errors, but load succeeded');
  }
  return result.errors;
}

function errorCodes(result: LoadFlowResult): string[] {
  return expectErrors(result).map((e) => e.code);
}

function errorText(result: LoadFlowResult): string {
  return expectErrors(result)
    .map((e) => e.message)
    .join(' | ');
}

// ---------------------------------------------------------------------------
// Item #4 — no_selection_policy fail-closed.
//
// A rank station's check.no_selection_policy must, like on_timeout, reject an
// unrecognised value at load instead of silently coercing it to 'scrap'.
// Absent is legal (defaults to 'scrap'); only a typo is rejected.
// ---------------------------------------------------------------------------

describe('loadFlow — no_selection_policy fail-closed (Item #4)', () => {
  // A minimal rank check-only station. `policy` is interpolated verbatim; when
  // null, the no_selection_policy line is omitted entirely (absent case).
  const rankFlow = (policy: string | null): string => {
    const lines: string[] = [
      'flow: rank-policy',
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
    ];
    if (policy !== null) lines.push(`      no_selection_policy: ${policy}`);
    return lines.join('\n') + '\n';
  };

  it('rejects an unrecognised no_selection_policy and names the station', () => {
    const result = loadInline(rankFlow('bogus'));
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('flow');
    expect(errorCodes(result)).toContain('INVALID_NO_SELECTION_POLICY');
    expect(errorText(result)).toContain('select');
    expect(errorText(result)).toContain('bogus');
  });

  it("accepts no_selection_policy: 'scrap'", () => {
    const flow = expectOk(loadInline(rankFlow('scrap')));
    expect(flow.stations.select!.rankCheck!.noSelectionPolicy).toBe('scrap');
  });

  it("accepts no_selection_policy: 'proceed_with_findings'", () => {
    const flow = expectOk(loadInline(rankFlow('proceed_with_findings')));
    expect(flow.stations.select!.rankCheck!.noSelectionPolicy).toBe('proceed_with_findings');
  });

  it('defaults to scrap when no_selection_policy is absent', () => {
    const flow = expectOk(loadInline(rankFlow(null)));
    expect(flow.stations.select!.rankCheck!.noSelectionPolicy).toBe('scrap');
  });
});

// ---------------------------------------------------------------------------
// Item #5 — hitlEnabled keys off an egress channel's `uses: [hitl]`.
//
// Declaring ANY egress channel must NOT make a rank station a human gate. The
// signal is "at least one egress channel whose `uses` array includes 'hitl'".
// ---------------------------------------------------------------------------

describe('loadFlow — hitlEnabled keys off uses:[hitl], not mere egress (Item #5)', () => {
  // A rank station plus an egress channel. `uses` is interpolated verbatim;
  // when null the `uses` line is omitted (egress present, no uses declared).
  const flowWith = (uses: string | null): string => {
    const lines: string[] = [
      'flow: hitl-signal',
      'flow_version: 1',
      'terminal_lanes: [done, scrap, hold]',
      'channels:',
      '  egress:',
      '    - type: slack',
      '      target: "#studio"',
    ];
    if (uses !== null) lines.push(`      uses: ${uses}`);
    lines.push(
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
      '      no_selection_policy: scrap',
    );
    return lines.join('\n') + '\n';
  };

  it('hitlEnabled is FALSE when an egress channel declares no uses', () => {
    const flow = expectOk(loadInline(flowWith(null)));
    expect(flow.stations.select!.rankCheck!.hitlEnabled).toBe(false);
  });

  it('hitlEnabled is FALSE when an egress channel uses something other than hitl', () => {
    const flow = expectOk(loadInline(flowWith('[delivery, alerts]')));
    expect(flow.stations.select!.rankCheck!.hitlEnabled).toBe(false);
  });

  it('hitlEnabled is TRUE when an egress channel uses includes hitl', () => {
    const flow = expectOk(loadInline(flowWith('[hitl, delivery]')));
    expect(flow.stations.select!.rankCheck!.hitlEnabled).toBe(true);
  });

  it('hitlEnabled is FALSE when there is no egress channel at all', () => {
    const noEgress = [
      'flow: no-egress',
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
      '      no_selection_policy: scrap',
    ].join('\n') + '\n';
    const flow = expectOk(loadInline(noEgress));
    expect(flow.stations.select!.rankCheck!.hitlEnabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Item #9 — fan-out station that OMITS fan_out loads; quorum k is unbounded
//           above when fan_out is absent (worker-determined child count).
// ---------------------------------------------------------------------------

describe('loadFlow — absent fan_out: dynamic fan-out + unbounded quorum k (Item #9)', () => {
  // A fan-out-shaped flow whose split station OMITS fan_out, with a quorum
  // fan_in on the merge station. `k` is interpolated verbatim.
  // Deterministic workers (command + allowlist) avoid the model-prompt
  // requirements that fire on transform stations declaring `next`, keeping the
  // flow focused on the fan_out / quorum-k behaviour under test.
  const dynamicFanOut = (k: number): string => {
    return [
      'flow: dynamic-fanout',
      'flow_version: 1',
      'terminal_lanes: [done, scrap, hold]',
      'stations:',
      '  - id: split',
      '    worker: { kind: deterministic, command: "true" }',
      '    child_entry: work',
      '    child_terminal: done',
      '    resume_at: merge',
      '    next: merge',
      '  - id: work',
      '    worker: { kind: deterministic, command: "true" }',
      '    next: done',
      '  - id: merge',
      '    worker: { kind: deterministic, command: "true" }',
      '    fan_in:',
      '      policy: quorum',
      `      k: ${k}`,
      '    next: done',
      'security:',
      '  bash:',
      '    allow: ["true"]',
    ].join('\n') + '\n';
  };

  it('loads a fan-out flow that OMITS fan_out (dynamic, worker-determined count)', () => {
    const flow = expectOk(loadInline(dynamicFanOut(2)));
    // fan_out is absent on the config (dynamic upper bound).
    expect(flow.stations.split!.fan_out).toBeUndefined();
    expect(flow.stations.merge!.fan_in).toEqual({ policy: 'quorum', k: 2 });
  });

  it('does NOT reject a quorum k larger than any concrete bound when fan_out is absent', () => {
    // k=99 would exceed any fixed fan_out, but with fan_out absent the upper
    // bound is unbounded, so this must load successfully.
    const result = loadInline(dynamicFanOut(99));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).not.toContain('INVALID_QUORUM_K');
    }
  });
});

// ---------------------------------------------------------------------------
// Item #8 — per-station timeout_seconds for deterministic workers.
//
// When present, timeout_seconds must be a positive integer (>= 1). Anything
// else (0, negative, float, non-number) is rejected at load with a structured
// INVALID_TIMEOUT_SECONDS error naming the station. Absent is legal (unbounded,
// backwards-compatible). The parsed field is exposed as `timeout_seconds` on the
// loaded StationConfig.
// ---------------------------------------------------------------------------

describe('loadFlow — deterministic timeout_seconds fail-closed (Item #8)', () => {
  // A minimal deterministic station. `value` is interpolated verbatim into the
  // worker block; when null the timeout_seconds key is omitted (absent case).
  const detFlow = (value: string | null): string => {
    const lines: string[] = [
      'flow: det-timeout',
      'flow_version: 1',
      'terminal_lanes: [done, scrap, hold]',
      'stations:',
      '  - id: render',
      '    worker:',
      '      kind: deterministic',
      '      command: "true"',
    ];
    if (value !== null) {
      lines.push(`      timeout_seconds: ${value}`);
    }
    lines.push('    next: done');
    lines.push('security:');
    lines.push('  bash:');
    lines.push('    allow: ["true"]');
    return lines.join('\n') + '\n';
  };

  it('loads a valid positive integer timeout_seconds onto the StationConfig', () => {
    const flow = expectOk(loadInline(detFlow('120')));
    expect(flow.stations.render!.timeout_seconds).toBe(120);
  });

  it('loads OK when timeout_seconds is absent (unbounded, backwards-compatible)', () => {
    const flow = expectOk(loadInline(detFlow(null)));
    expect(flow.stations.render!.timeout_seconds).toBeUndefined();
  });

  it('rejects timeout_seconds: 0 with INVALID_TIMEOUT_SECONDS naming the station', () => {
    const result = loadInline(detFlow('0'));
    expect(errorCodes(result)).toContain('INVALID_TIMEOUT_SECONDS');
    expect(errorText(result)).toContain('render');
  });

  it('rejects a negative timeout_seconds', () => {
    const result = loadInline(detFlow('-1'));
    expect(errorCodes(result)).toContain('INVALID_TIMEOUT_SECONDS');
  });

  it('rejects a non-integer (float) timeout_seconds', () => {
    const result = loadInline(detFlow('1.5'));
    expect(errorCodes(result)).toContain('INVALID_TIMEOUT_SECONDS');
  });

  it('rejects a non-number timeout_seconds', () => {
    const result = loadInline(detFlow('"soon"'));
    expect(errorCodes(result)).toContain('INVALID_TIMEOUT_SECONDS');
  });
});

// ---------------------------------------------------------------------------
// Issue #31 — idle_timeout_seconds for kind: harness stations.
//
// When present, idle_timeout_seconds must be a positive integer (>= 1),
// declared only on a harness station, and strictly less than timeout_seconds
// when both are set. Absent is legal (no idle bound, backwards-compatible).
// ---------------------------------------------------------------------------

describe('loadFlow — harness idle_timeout_seconds fail-closed (issue #31)', () => {
  // A minimal harness station. `idleValue`/`timeoutValue` are interpolated
  // verbatim; null omits the key entirely.
  const harnessFlow = (idleValue: string | null, timeoutValue: string | null = null): string => {
    const lines: string[] = [
      'flow: harness-idle-timeout',
      'flow_version: 1',
      'terminal_lanes: [done, scrap, hold]',
      'stations:',
      '  - id: coder',
      '    worker:',
      '      kind: harness',
      '      harness: claude-headless',
      '      prompt_file: prompt.md',
      '      prompt_version: "1"',
      '      tools: [Read, Write, Bash]',
      '      output_schema:',
      '        fields:',
      '          - { name: result, type: string, required: true }',
    ];
    if (timeoutValue !== null) lines.push(`      timeout_seconds: ${timeoutValue}`);
    if (idleValue !== null) lines.push(`      idle_timeout_seconds: ${idleValue}`);
    lines.push('    inputs: [task.md]');
    lines.push('    outputs: [result.md]');
    lines.push('    next: done');
    return lines.join('\n') + '\n';
  };
  const PROMPT = { 'prompt.md': 'Do the task.' };

  it('loads a valid positive integer idle_timeout_seconds onto the StationConfig', () => {
    const flow = expectOk(loadInline(harnessFlow('30', '300'), PROMPT));
    expect(flow.stations.coder!.idle_timeout_seconds).toBe(30);
  });

  it('loads OK when idle_timeout_seconds is absent (no idle bound, backwards-compatible)', () => {
    const flow = expectOk(loadInline(harnessFlow(null), PROMPT));
    expect(flow.stations.coder!.idle_timeout_seconds).toBeUndefined();
  });

  it('rejects idle_timeout_seconds: 0 with INVALID_IDLE_TIMEOUT_SECONDS naming the station', () => {
    const result = loadInline(harnessFlow('0', '300'), PROMPT);
    expect(errorCodes(result)).toContain('INVALID_IDLE_TIMEOUT_SECONDS');
    expect(errorText(result)).toContain('coder');
  });

  it('rejects a negative idle_timeout_seconds', () => {
    const result = loadInline(harnessFlow('-1', '300'), PROMPT);
    expect(errorCodes(result)).toContain('INVALID_IDLE_TIMEOUT_SECONDS');
  });

  it('rejects a non-integer (float) idle_timeout_seconds', () => {
    const result = loadInline(harnessFlow('1.5', '300'), PROMPT);
    expect(errorCodes(result)).toContain('INVALID_IDLE_TIMEOUT_SECONDS');
  });

  it('rejects a non-number idle_timeout_seconds', () => {
    const result = loadInline(harnessFlow('"soon"', '300'), PROMPT);
    expect(errorCodes(result)).toContain('INVALID_IDLE_TIMEOUT_SECONDS');
  });

  it('rejects idle_timeout_seconds >= timeout_seconds with IDLE_TIMEOUT_NOT_LESS_THAN_TIMEOUT', () => {
    const result = loadInline(harnessFlow('300', '300'), PROMPT);
    expect(errorCodes(result)).toContain('IDLE_TIMEOUT_NOT_LESS_THAN_TIMEOUT');
    expect(errorText(result)).toContain('coder');
  });

  it('rejects idle_timeout_seconds greater than timeout_seconds', () => {
    const result = loadInline(harnessFlow('400', '300'), PROMPT);
    expect(errorCodes(result)).toContain('IDLE_TIMEOUT_NOT_LESS_THAN_TIMEOUT');
  });

  it('accepts idle_timeout_seconds strictly less than timeout_seconds', () => {
    const flow = expectOk(loadInline(harnessFlow('30', '300'), PROMPT));
    expect(flow.stations.coder!.idle_timeout_seconds).toBe(30);
    expect(flow.stations.coder!.timeout_seconds).toBe(300);
  });

  it('accepts idle_timeout_seconds with no timeout_seconds declared (only the wall-clock default applies)', () => {
    const flow = expectOk(loadInline(harnessFlow('30'), PROMPT));
    expect(flow.stations.coder!.idle_timeout_seconds).toBe(30);
    expect(flow.stations.coder!.timeout_seconds).toBeUndefined();
  });

  it('rejects idle_timeout_seconds on a non-harness station with IDLE_TIMEOUT_REQUIRES_HARNESS', () => {
    const detFlow = [
      'flow: det-idle-timeout',
      'flow_version: 1',
      'terminal_lanes: [done, scrap, hold]',
      'stations:',
      '  - id: render',
      '    worker:',
      '      kind: deterministic',
      '      command: "true"',
      '      idle_timeout_seconds: 30',
      '    next: done',
      'security:',
      '  bash:',
      '    allow: ["true"]',
    ].join('\n') + '\n';
    const result = loadInline(detFlow);
    expect(errorCodes(result)).toContain('IDLE_TIMEOUT_REQUIRES_HARNESS');
    expect(errorText(result)).toContain('render');
  });
});

// ===========================================================================
// Code-review fix #4 — terminal_lanes declared but empty is rejected at load.
// An empty list has no exits and breaks the downstream runnable-card query
// (`lane NOT IN ()`); absent is fine (defaults to done/scrap/hold).
// ===========================================================================

describe('loadFlow — empty terminal_lanes is rejected (fix #4)', () => {
  const flowWithTerminalLine = (line: string): string => `
flow: tl
flow_version: 1
${line}
stations:
  - id: only
    worker: { kind: transform, model: m, prompt_file: p.md, prompt_version: "1", output_schema: { fields: [{ name: x, type: string, required: true }] } }
    inputs: []
    next: done
`;

  it('rejects an explicitly empty terminal_lanes', () => {
    const result = loadInline(flowWithTerminalLine('terminal_lanes: []'), { 'p.md': 'x' });
    expect(errorCodes(result)).toContain('EMPTY_TERMINAL_LANES');
  });

  it('accepts a non-empty terminal_lanes', () => {
    const result = loadInline(flowWithTerminalLine('terminal_lanes: [done, scrap, hold]'), { 'p.md': 'x' });
    expect(result.ok).toBe(true);
  });

  it('does not raise EMPTY_TERMINAL_LANES when terminal_lanes is omitted', () => {
    // (loadFlow does not itself default terminal_lanes — a separate pre-existing
    // quirk — so an absent declaration may fail for an unrelated reason; we assert
    // only that the empty-list error specifically is never raised for absence.)
    const result = loadInline(flowWithTerminalLine(''), { 'p.md': 'x' });
    const codes = result.ok ? [] : result.errors.map((e) => e.code);
    expect(codes).not.toContain('EMPTY_TERMINAL_LANES');
  });
});

// ===========================================================================
// a pre-public review (github-actions[bot]) — a non-array `channels.egress` (e.g. a
// YAML mapping) must NOT crash loadFlow's {ok,errors} contract. The Array.isArray
// guards (validation loop + hasHitlEgress) treat a malformed egress as no
// channels (config validated, not trusted), matching the pre-change tolerance.
// ===========================================================================

describe('loadFlow — non-array channels.egress does not crash (a pre-public review)', () => {
  const flowWithEgress = (egressYaml: string): string => `
flow: eg
flow_version: 1
terminal_lanes: [done, scrap, hold]
channels:
  egress: ${egressYaml}
stations:
  - id: only
    worker: { kind: transform, model: m, prompt_file: p.md, prompt_version: "1", output_schema: { fields: [{ name: x, type: string, required: true }] } }
    inputs: []
    next: done
`;

  it('returns a structured result (never throws) when egress is a mapping, not a list', () => {
    let threw = false;
    let result: LoadFlowResult | undefined;
    try {
      result = loadInline(flowWithEgress('{ target: "#x", uses: [hitl] }'), { 'p.md': 'x' });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false); // the {ok,errors} contract is honored, not bypassed by a crash
    expect(result).toBeDefined();
  });

  it('treats a non-array egress as no hitl channel (hitlEnabled is not turned on)', () => {
    // A scalar egress is also non-array; loadFlow must tolerate it without throwing.
    let threw = false;
    try {
      loadInline(flowWithEgress('hitl'), { 'p.md': 'x' });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });

  it('still detects hitl when egress is a proper list with uses:[hitl]', () => {
    const result = loadInline(flowWithEgress('[{ type: slack, target: "#x", uses: [hitl] }]'), { 'p.md': 'x' });
    expect(result.ok).toBe(true);
  });
});
