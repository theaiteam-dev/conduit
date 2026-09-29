/**
 * Load-time validation of `kind: harness` stations (WI-563).
 *
 * Fail-closed: a malformed or unsatisfiable harness declaration is rejected
 * BEFORE anything runs (FR-1, FR-10, NFR-Security-3). This file pins the loader
 * contract for the five acceptance criteria:
 *
 *   AC1  unknown adapter name              → UNKNOWN_HARNESS_ADAPTER (names station + adapter)
 *   AC2  missing prompt / version / schema → the reused MISSING_PROMPT_* / MISSING_OUTPUT_SCHEMA family
 *   AC3  tools allowlist the adapter cannot express → HARNESS_TOOLS_UNEXPRESSIBLE
 *        UNLESS the station carries `unrestricted_tools: true` → load succeeds, waiver recorded
 *   AC4  missing / non-executable binary   → HARNESS_BINARY_NOT_FOUND at load/startup, NOT first dispatch
 *   AC5  a valid harness station loads and is exposed on the FROZEN FlowConfig
 *
 * ── Contract decisions this test file pins (and why) ─────────────────────────
 *
 * 1. loadFlow gains an OPTIONAL second argument carrying the harness registry:
 *
 *      loadFlow(absolutePath: string, options?: { harnessRegistry?: HarnessRegistry }): LoadFlowResult
 *
 *    Adapter-name validity and tools-expressibility can only be judged against
 *    the engine-config registry (WI-560). The param is optional so every
 *    existing sync `loadFlow(path)` caller keeps compiling; harness stations are
 *    only validated against the registry the caller injects. loadFlow STAYS
 *    SYNCHRONOUS — its large sync caller base (worker-entry, executor tests,
 *    reference-flow-runner) is unchanged.
 *
 * 2. Binary presence is probed by a SEPARATE async export in load.ts:
 *
 *      probeHarnessBinaries(flow: FlowConfig, registry: HarnessRegistry): Promise<FlowValidationError[]>
 *
 *    The adapter's `probeBinary()` is async (WI-560), so it cannot run inside
 *    synchronous collectErrors/loadFlow. FR-10 says the binary check happens "at
 *    load/startup" (after the pure parse) and NEVER at first dispatch — a
 *    separate async probe over the already-loaded FlowConfig is exactly that
 *    seam. Returns [] when every harness station's binary is present; one
 *    HARNESS_BINARY_NOT_FOUND per missing/non-executable binary, naming the
 *    adapter and the probed path (from the probe's `detail`).
 *
 * 3. YAML shape mirrors a transform station: the harness adapter name, the
 *    `tools:` allowlist, and the `unrestricted_tools:` waiver live UNDER
 *    `worker:` alongside `model` / `prompt_file` / `output_schema` (the PRD:
 *    "declare the station like a transform, add `harness:` and a `tools:`
 *    allowlist"). buildStationConfig lifts them onto the flat StationConfig
 *    fields (`harness` / `tools` / `unrestricted_tools`, WI-559).
 *
 * 4. Every harness fixture declares `next:` because the reused MISSING_PROMPT_* /
 *    MISSING_OUTPUT_SCHEMA family only runs for stations with a `next` field
 *    (the pre-existing model-station validation gate in collectErrors). A real
 *    harness station always has a successor, so this is not a contrivance.
 */
import { describe, it, expect } from 'bun:test';
import { join, dirname } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { FlowConfig, StationConfig } from '../types/kernel';
import {
  loadFlow,
  probeHarnessBinaries,
  type LoadFlowResult,
  type FlowValidationError,
} from './load';
import {
  createHarnessRegistry,
  makeFakeHarnessAdapter,
  type HarnessAdapter,
  type HarnessRegistry,
  type BinaryProbe,
} from '../worker/harness-adapter';

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/** A registry over the given fake adapters (name + capability flags only). */
function registryOf(
  specs: Array<{
    name: string;
    canRestrictTools?: boolean;
    canGatePerCall?: boolean;
    canExpressTools?: (tools: readonly string[]) => boolean;
    binaryPresent?: boolean;
  }>,
): HarnessRegistry {
  return createHarnessRegistry(specs.map((s) => makeFakeHarnessAdapter(s).adapter));
}

/**
 * Write `yaml` (plus any sibling prompt files) to a throwaway temp dir and load
 * it with an injected harness registry. Self-contained per the load.test.ts
 * convention — no shared fixture files to maintain.
 */
function loadHarness(
  yaml: string,
  opts: { registry?: HarnessRegistry; extraFiles?: Record<string, string> } = {},
): LoadFlowResult {
  const dir = mkdtempSync(join(tmpdir(), 'conduit-harness-'));
  const path = join(dir, 'flow.yaml');
  try {
    writeFileSync(path, yaml, 'utf-8');
    for (const [rel, content] of Object.entries(opts.extraFiles ?? {})) {
      const filePath = join(dir, rel);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, content, 'utf-8');
    }
    return loadFlow(path, { harnessRegistry: opts.registry });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function expectErrors(result: LoadFlowResult): FlowValidationError[] {
  if (result.ok) throw new Error('expected validation errors, but load succeeded');
  return result.errors;
}

function errorCodes(result: LoadFlowResult): string[] {
  return expectErrors(result).map((e) => e.code);
}

function errorText(result: LoadFlowResult): string {
  return expectErrors(result).map((e) => e.message).join(' | ');
}

function expectOk(result: LoadFlowResult): FlowConfig {
  if (!result.ok) throw new Error(`expected ok, got errors: ${JSON.stringify(result.errors)}`);
  return result.flow;
}

/** The prompt file every fixture references; no template refs → no UNDECLARED_PROMPT_INPUT. */
const CODER_PROMPT = { 'prompts/coder.md': 'Implement the task described in the inputs.' };

/**
 * A complete, valid harness station under `worker:`. Overridable lines let each
 * test perturb exactly one field (drop the adapter, drop the schema, ...).
 */
function harnessFlow(
  parts: {
    harnessLine?: string; // default: `harness: claude-headless`
    promptFileLine?: string; // default: `prompt_file: prompts/coder.md`
    promptVersionLine?: string; // default: `prompt_version: "1"`
    schemaBlock?: string; // default: a one-field schema
    toolsLine?: string; // default: `tools: [Read, Write, Bash]`
    waiverLine?: string; // default: omitted
    outputsLine?: string; // default: `outputs: [result.md]`
    nextLine?: string; // default: `next: done`
  } = {},
): string {
  const {
    harnessLine = 'harness: claude-headless',
    promptFileLine = 'prompt_file: prompts/coder.md',
    promptVersionLine = 'prompt_version: "1"',
    schemaBlock = `output_schema:
        fields:
          - { name: result, type: string, required: true }`,
    toolsLine = 'tools: [Read, Write, Bash]',
    waiverLine = '',
    outputsLine = 'outputs: [result.md]',
    nextLine = 'next: done',
  } = parts;
  return `
flow: harness-fixture
flow_version: 1
terminal_lanes: [done, scrap, hold]
stations:
  - id: coder
    worker:
      kind: harness
      model: sonnet
      ${harnessLine}
      ${promptFileLine}
      ${promptVersionLine}
      ${toolsLine}
      ${waiverLine}
      ${schemaBlock}
    inputs: [task.md]
    ${outputsLine}
    ${nextLine}
`;
}

// ---------------------------------------------------------------------------
// AC1 — unknown adapter name is rejected, naming the station and the adapter.
// ---------------------------------------------------------------------------

describe('WI-563 AC1 — unknown harness adapter (FR-1, NFR-Security-3)', () => {
  it('rejects a harness station naming an adapter absent from the registry', () => {
    const result = loadHarness(harnessFlow({ harnessLine: 'harness: ghost-headless' }), {
      registry: registryOf([{ name: 'claude-headless' }]),
      extraFiles: CODER_PROMPT,
    });

    expect(errorCodes(result)).toContain('UNKNOWN_HARNESS_ADAPTER');
    // The error must name BOTH the offending station and the unknown adapter so
    // an operator can find and fix the flow.yaml entry.
    const text = errorText(result);
    expect(text).toContain('coder');
    expect(text).toContain('ghost-headless');
  });

  it('accepts a harness station naming a registered adapter', () => {
    const flow = expectOk(
      loadHarness(harnessFlow(), {
        registry: registryOf([{ name: 'claude-headless' }]),
        extraFiles: CODER_PROMPT,
      }),
    );
    expect(flow.stations.coder!.kind).toBe('harness');
  });
});

// ---------------------------------------------------------------------------
// Review #3 — harness validation is unconditional, not gated on `next`.
// ---------------------------------------------------------------------------

describe('review #3 — harness validation runs for stations without `next`', () => {
  it('rejects an unknown adapter even when the station declares no next', () => {
    // Before the fix, the WI-563 checks lived inside the `next !== undefined`
    // loop, so a harness station without `next` loaded cleanly and only failed
    // at first dispatch (escalate-to-hold mid-run) — not fail-closed at load.
    const result = loadHarness(harnessFlow({ harnessLine: 'harness: ghost-headless', nextLine: '' }), {
      registry: registryOf([{ name: 'claude-headless' }]),
      extraFiles: CODER_PROMPT,
    });

    expect(errorCodes(result)).toContain('UNKNOWN_HARNESS_ADAPTER');
  });

  it('rejects an unexpressible tools allowlist even when the station declares no next', () => {
    const result = loadHarness(harnessFlow({ nextLine: '' }), {
      registry: registryOf([{ name: 'claude-headless', canRestrictTools: false }]),
      extraFiles: CODER_PROMPT,
    });

    expect(errorCodes(result)).toContain('HARNESS_TOOLS_UNEXPRESSIBLE');
  });
});

// ---------------------------------------------------------------------------
// Review #5 — a harness maker must declare at least one outputs entry.
// ---------------------------------------------------------------------------

describe('review #5 — harness station with no outputs is rejected at load', () => {
  it('rejects an omitted outputs list → HARNESS_MISSING_OUTPUTS', () => {
    // The executor reads the maker's typed payload from outputs[0]; with none
    // declared, every attempt scrapped at runtime under a misleading
    // 'harness-output-unparseable … (none declared)' reason.
    const result = loadHarness(harnessFlow({ outputsLine: '' }), {
      registry: registryOf([{ name: 'claude-headless' }]),
      extraFiles: CODER_PROMPT,
    });

    expect(errorCodes(result)).toContain('HARNESS_MISSING_OUTPUTS');
    expect(errorText(result)).toContain('coder');
  });

  it('rejects an explicitly empty outputs list → HARNESS_MISSING_OUTPUTS', () => {
    const result = loadHarness(harnessFlow({ outputsLine: 'outputs: []' }), {
      registry: registryOf([{ name: 'claude-headless' }]),
      extraFiles: CODER_PROMPT,
    });

    expect(errorCodes(result)).toContain('HARNESS_MISSING_OUTPUTS');
  });

  it('fires WITHOUT an injected registry — the outputs check is not registry-gated', () => {
    const result = loadHarness(harnessFlow({ outputsLine: '' }), {
      extraFiles: CODER_PROMPT,
    });

    expect(errorCodes(result)).toContain('HARNESS_MISSING_OUTPUTS');
  });
});

// ---------------------------------------------------------------------------
// AC2 — prompt / version / schema reuse the existing model-station family.
// ---------------------------------------------------------------------------

describe('WI-563 AC2 — prompt/version/schema reuse the MISSING_* family (FR-1)', () => {
  const registry = registryOf([{ name: 'claude-headless' }]);

  it('rejects a harness station with no prompt_file → MISSING_PROMPT_TEMPLATE', () => {
    const result = loadHarness(harnessFlow({ promptFileLine: '' }), {
      registry,
      extraFiles: CODER_PROMPT,
    });
    expect(errorCodes(result)).toContain('MISSING_PROMPT_TEMPLATE');
    expect(errorText(result)).toContain('coder');
  });

  it('rejects a harness station whose prompt_file is absent on disk → PROMPT_FILE_NOT_FOUND', () => {
    // prompt_file declared but the sibling file was never written.
    const result = loadHarness(harnessFlow({ promptFileLine: 'prompt_file: prompts/missing.md' }), {
      registry,
      // note: no extraFiles — the referenced template does not exist.
    });
    expect(errorCodes(result)).toContain('PROMPT_FILE_NOT_FOUND');
    expect(errorText(result)).toContain('prompts/missing.md');
  });

  it('rejects a harness station with no prompt_version → MISSING_PROMPT_VERSION', () => {
    const result = loadHarness(harnessFlow({ promptVersionLine: '' }), {
      registry,
      extraFiles: CODER_PROMPT,
    });
    expect(errorCodes(result)).toContain('MISSING_PROMPT_VERSION');
    expect(errorText(result)).toContain('coder');
  });

  it('rejects a harness station with no output_schema → MISSING_OUTPUT_SCHEMA', () => {
    const result = loadHarness(harnessFlow({ schemaBlock: '' }), {
      registry,
      extraFiles: CODER_PROMPT,
    });
    expect(errorCodes(result)).toContain('MISSING_OUTPUT_SCHEMA');
    expect(errorText(result)).toContain('coder');
  });
});

// ---------------------------------------------------------------------------
// AC3 — tools expressibility: fail-closed by default, honor the waiver.
// ---------------------------------------------------------------------------

describe('WI-563 AC3 — tools allowlist expressibility + unrestricted waiver (NFR-Security-3)', () => {
  it('rejects a declared tools allowlist the adapter cannot express → HARNESS_TOOLS_UNEXPRESSIBLE', () => {
    const result = loadHarness(harnessFlow({ toolsLine: 'tools: [Read, Write, Bash]' }), {
      registry: registryOf([{ name: 'claude-headless', canRestrictTools: false }]),
      extraFiles: CODER_PROMPT,
    });
    expect(errorCodes(result)).toContain('HARNESS_TOOLS_UNEXPRESSIBLE');
    // Names the station and the adapter that cannot narrow the allowlist.
    const text = errorText(result);
    expect(text).toContain('coder');
    expect(text).toContain('claude-headless');
  });

  it('accepts an allowlist an adapter CAN express (no waiver needed)', () => {
    const flow = expectOk(
      loadHarness(harnessFlow({ toolsLine: 'tools: [Read, Write, Bash]' }), {
        registry: registryOf([{ name: 'claude-headless', canRestrictTools: true }]),
        extraFiles: CODER_PROMPT,
      }),
    );
    expect(flow.stations.coder!.tools).toEqual(['Read', 'Write', 'Bash']);
  });

  it('does NOT fail a tools-blind adapter when the station declares no allowlist', () => {
    // Nothing to express → fail-closed does not trip; the waiver is only needed
    // when there IS an allowlist the adapter cannot narrow.
    const flow = expectOk(
      loadHarness(harnessFlow({ toolsLine: '' }), {
        registry: registryOf([{ name: 'claude-headless', canRestrictTools: false }]),
        extraFiles: CODER_PROMPT,
      }),
    );
    expect(flow.stations.coder!.kind).toBe('harness');
  });

  it('honors unrestricted_tools: true — load succeeds and the waiver is recorded on the frozen config', () => {
    const flow = expectOk(
      loadHarness(
        harnessFlow({
          toolsLine: 'tools: [Read, Write, Bash]',
          waiverLine: 'unrestricted_tools: true',
        }),
        {
          registry: registryOf([{ name: 'claude-headless', canRestrictTools: false }]),
          extraFiles: CODER_PROMPT,
        },
      ),
    );
    // The waiver is RECORDED on the frozen config so `conduit explain` (WI-573)
    // can surface it as a warning; the declared allowlist is preserved too.
    expect(flow.stations.coder!.unrestricted_tools).toBe(true);
    expect(flow.stations.coder!.tools).toEqual(['Read', 'Write', 'Bash']);
  });
});

// ---------------------------------------------------------------------------
// Issue #21 — an adapter that gates per call denies every unlisted tool, so a
// station with no tools list, or one that waives the list, fails at load.
// ---------------------------------------------------------------------------

describe('issue #21 — a per-call gating adapter needs a tools list (HARNESS_GATED_ADAPTER_NEEDS_TOOLS)', () => {
  const gating = (): HarnessRegistry => registryOf([{ name: 'claude-headless', canGatePerCall: true }]);

  it('rejects unrestricted_tools: true', () => {
    const result = loadHarness(
      harnessFlow({ toolsLine: 'tools: [Read, Write]', waiverLine: 'unrestricted_tools: true' }),
      { registry: gating(), extraFiles: CODER_PROMPT },
    );
    expect(errorCodes(result)).toContain('HARNESS_GATED_ADAPTER_NEEDS_TOOLS');
    expect(JSON.stringify(result)).toContain('unrestricted_tools: true has no effect');
    // The list is present and governs, so the message must not claim the station can do nothing.
    expect(JSON.stringify(result)).not.toContain('can do nothing');
  });

  it('says a waiver with no tools list leaves the station unable to do anything', () => {
    const result = loadHarness(
      harnessFlow({ toolsLine: '', waiverLine: 'unrestricted_tools: true' }),
      { registry: gating(), extraFiles: CODER_PROMPT },
    );
    expect(errorCodes(result)).toContain('HARNESS_GATED_ADAPTER_NEEDS_TOOLS');
    expect(JSON.stringify(result)).toContain('can do nothing');
  });

  it('rejects a station that declares no tools list', () => {
    const result = loadHarness(harnessFlow({ toolsLine: '' }), { registry: gating(), extraFiles: CODER_PROMPT });
    expect(errorCodes(result)).toContain('HARNESS_GATED_ADAPTER_NEEDS_TOOLS');
  });

  it('accepts a station that lists its tools', () => {
    const flow = expectOk(
      loadHarness(harnessFlow({ toolsLine: 'tools: [Read, Write, "Bash(git:*)"]' }), {
        registry: gating(),
        extraFiles: CODER_PROMPT,
      }),
    );
    expect(flow.stations.coder!.tools).toEqual(['Read', 'Write', 'Bash(git:*)']);
  });

  it('leaves an adapter that does not gate per call alone, waiver and empty list included', () => {
    const registry = registryOf([{ name: 'claude-headless', canRestrictTools: false }]);
    expectOk(loadHarness(harnessFlow({ toolsLine: '' }), { registry, extraFiles: CODER_PROMPT }));
    expectOk(
      loadHarness(harnessFlow({ toolsLine: 'tools: [Read, Write]', waiverLine: 'unrestricted_tools: true' }), {
        registry,
        extraFiles: CODER_PROMPT,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// WI-595 — the GATE CRITIC's tools allowlist is threaded into its harness
// invocation (gate.ts), so a critic adapter that cannot restrict tools must
// fail at LOAD too (mirrors the maker guard above, on the check.critic surface).
// ---------------------------------------------------------------------------

/** A transform maker gated by a HARNESS critic that declares a tools allowlist. */
function criticToolsFlow(parts: { criticToolsLine?: string } = {}): string {
  const { criticToolsLine = 'tools: [Read, Write]' } = parts;
  return `
flow: critic-tools-fixture
flow_version: 1
terminal_lanes: [done, scrap, hold]
stations:
  - id: coder
    worker:
      kind: transform
      model: sonnet
      prompt_file: prompts/coder.md
      prompt_version: "1"
      output_schema:
        fields:
          - { name: result, type: string, required: true }
    inputs: [task.md]
    outputs: [result.md]
    next: done
    check:
      kind: gate
      critic:
        role: critic
        harness: weak-critic
        ${criticToolsLine}
        prompt_file: prompts/verify.md
        prompt_version: "1"
      on_reject: coder
`;
}

describe('WI-595 — gate-critic tools allowlist expressibility (HARNESS_TOOLS_UNEXPRESSIBLE)', () => {
  const PROMPTS = { 'prompts/coder.md': 'Do the task.', 'prompts/verify.md': 'Check the work.' };

  it('rejects a gate-critic tools allowlist an adapter CANNOT express → HARNESS_TOOLS_UNEXPRESSIBLE', () => {
    const result = loadHarness(criticToolsFlow(), {
      registry: registryOf([{ name: 'weak-critic', canRestrictTools: false }]),
      extraFiles: PROMPTS,
    });
    expect(errorCodes(result)).toContain('HARNESS_TOOLS_UNEXPRESSIBLE');
    // ...naming the offending critic adapter so the failure is diagnosable.
    expect(errorText(result)).toContain('weak-critic');
  });

  it('accepts a gate-critic tools allowlist an adapter CAN express, recording criticTools', () => {
    const flow = expectOk(
      loadHarness(criticToolsFlow(), {
        registry: registryOf([{ name: 'weak-critic', canRestrictTools: true }]),
        extraFiles: PROMPTS,
      }),
    );
    expect(flow.stations.coder!.gateCheck?.criticTools).toEqual(['Read', 'Write']);
  });

  // RRULING (RetroLearning row 16, operator-ruled): a harness gate critic MUST
  // declare a non-empty criticTools allowlist. The omission path is no longer
  // silently-unrestricted — it fails CLOSED at load. This test previously
  // asserted the OPPOSITE ("does NOT fire when the critic declares no tools");
  // its asserted behavior is exactly what the ruling reverses, so it is
  // rewritten (not deleted) to pin the new fail-closed contract.
  it('rejects a gate critic that OMITS its tools allowlist → HARNESS_CRITIC_TOOLS_REQUIRED', () => {
    const result = loadHarness(criticToolsFlow({ criticToolsLine: '' }), {
      registry: registryOf([{ name: 'weak-critic', canRestrictTools: true }]),
      extraFiles: PROMPTS,
    });
    expect(errorCodes(result)).toContain('HARNESS_CRITIC_TOOLS_REQUIRED');
    // ...naming the offending station and adapter so the failure is diagnosable.
    expect(errorText(result)).toContain('coder');
    expect(errorText(result)).toContain('weak-critic');
  });

  it('rejects a gate critic with an EXPLICITLY EMPTY tools allowlist → HARNESS_CRITIC_TOOLS_REQUIRED', () => {
    const result = loadHarness(criticToolsFlow({ criticToolsLine: 'tools: []' }), {
      registry: registryOf([{ name: 'weak-critic', canRestrictTools: true }]),
      extraFiles: PROMPTS,
    });
    expect(errorCodes(result)).toContain('HARNESS_CRITIC_TOOLS_REQUIRED');
    expect(errorText(result)).toContain('weak-critic');
  });
});

// ---------------------------------------------------------------------------
// AC4 — binary presence probed at load/startup, never at first dispatch (FR-10).
// ---------------------------------------------------------------------------

/** A minimal frozen FlowConfig carrying just the given harness stations. */
function flowWith(stations: Record<string, StationConfig>): FlowConfig {
  return Object.freeze({ version: 1, stations }) as FlowConfig;
}

function harnessStation(harness: string): StationConfig {
  return { kind: 'harness', effectful: false, wip: 1, inputs: [], outputs: [], harness };
}

/** An adapter whose binary probe reports a MISSING binary at a specific path. */
function missingBinaryAdapter(name: string, probedPath: string): HarnessAdapter {
  return {
    name,
    reportsUsage: true,
    canRestrictTools: true,
    async probeBinary(): Promise<BinaryProbe> {
      return { present: false, detail: probedPath };
    },
    async invoke() {
      throw new Error('probeHarnessBinaries must not invoke the adapter');
    },
  };
}

describe('WI-563 AC4 — harness binary presence probe (FR-10)', () => {
  it('returns no errors when every declared harness binary is present', async () => {
    const registry = registryOf([{ name: 'claude-headless', binaryPresent: true }]);
    const flow = flowWith({ coder: harnessStation('claude-headless') });

    const errors = await probeHarnessBinaries(flow, registry);

    expect(errors).toEqual([]);
  });

  it('fails a missing/non-executable binary → HARNESS_BINARY_NOT_FOUND naming the adapter and probed path', async () => {
    const registry = createHarnessRegistry([
      missingBinaryAdapter('claude-headless', '/usr/local/bin/claude'),
    ]);
    const flow = flowWith({ coder: harnessStation('claude-headless') });

    const errors = await probeHarnessBinaries(flow, registry);

    expect(errors.map((e) => e.code)).toContain('HARNESS_BINARY_NOT_FOUND');
    const message = errors.map((e) => e.message).join(' | ');
    expect(message).toContain('claude-headless');
    expect(message).toContain('/usr/local/bin/claude');
  });

  it('probes without a full invocation — the missing binary is caught at load, never at first dispatch', async () => {
    // makeFakeHarnessAdapter records every invoke() in `calls`; probing must not
    // add to it. This is the load-vs-dispatch guarantee of FR-10.
    const present = makeFakeHarnessAdapter({ name: 'good', binaryPresent: true });
    const missing = makeFakeHarnessAdapter({ name: 'bad', binaryPresent: false });
    const registry = createHarnessRegistry([present.adapter, missing.adapter]);
    const flow = flowWith({
      a: harnessStation('good'),
      b: harnessStation('bad'),
    });

    const errors = await probeHarnessBinaries(flow, registry);

    // Exactly the missing one is reported, named.
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe('HARNESS_BINARY_NOT_FOUND');
    expect(errors[0]!.message).toContain('bad');
    // No adapter was invoked — probeBinary only.
    expect(present.calls).toHaveLength(0);
    expect(missing.calls).toHaveLength(0);
  });

  it('ignores non-harness stations when probing', async () => {
    const registry = registryOf([{ name: 'claude-headless', binaryPresent: false }]);
    const flow = flowWith({
      build: { kind: 'deterministic', effectful: false, wip: 1, inputs: [], outputs: [] },
    });

    const errors = await probeHarnessBinaries(flow, registry);

    // No harness station → nothing to probe → no errors.
    expect(errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC5 — a valid harness station loads onto a frozen FlowConfig.
// ---------------------------------------------------------------------------

describe('WI-563 AC5 — a valid harness declaration loads onto the frozen FlowConfig', () => {
  it('exposes the harness kind, adapter name, and tools allowlist on the frozen config', () => {
    const flow = expectOk(
      loadHarness(harnessFlow(), {
        registry: registryOf([{ name: 'claude-headless' }]),
        extraFiles: CODER_PROMPT,
      }),
    );

    const station = flow.stations.coder!;
    expect(station.kind).toBe('harness');
    expect(station.harness).toBe('claude-headless');
    expect(station.tools).toEqual(['Read', 'Write', 'Bash']);
    // The transform-parity fields are still carried through.
    expect(station.inputs).toEqual(['task.md']);
    expect(station.outputs).toEqual(['result.md']);
    expect(station.output_schema).toBeDefined();
    // FlowConfig is frozen (Principle 10 — config is validated, not trusted).
    expect(Object.isFrozen(flow)).toBe(true);
  });

  it('does not set unrestricted_tools when the waiver is absent', () => {
    const flow = expectOk(
      loadHarness(harnessFlow(), {
        registry: registryOf([{ name: 'claude-headless' }]),
        extraFiles: CODER_PROMPT,
      }),
    );
    // Absent waiver → falsy (undefined or false), never a silent true.
    expect(flow.stations.coder!.unrestricted_tools ?? false).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The original per-list tool-expression work — per-list expressibility: a capability-lattice adapter
// (canRestrictTools=false + canExpressTools) hosts critics and tool-declaring
// makers for the lists its envelopes match, and only those.
// ---------------------------------------------------------------------------

describe('the original per-list tool-expression work — per-list tools expressibility (canExpressTools)', () => {
  const PROMPTS = { 'prompts/coder.md': 'Do the task.', 'prompts/verify.md': 'Check the work.' };
  // A codex-shaped lattice: expresses exactly the Read/Write set, nothing else.
  const LATTICE = (tools: readonly string[]): boolean =>
    [...tools].sort().join(',') === 'Read,Write';

  it('accepts a gate critic on a canRestrictTools=false adapter when the list is expressible', () => {
    const flow = expectOk(
      loadHarness(criticToolsFlow(), {
        registry: registryOf([
          { name: 'weak-critic', canRestrictTools: false, canExpressTools: LATTICE },
        ]),
        extraFiles: PROMPTS,
      }),
    );
    expect(flow.stations.coder!.gateCheck?.criticTools).toEqual(['Read', 'Write']);
  });

  it('still rejects the critic when the specific list is NOT expressible → HARNESS_TOOLS_UNEXPRESSIBLE', () => {
    const result = loadHarness(criticToolsFlow({ criticToolsLine: 'tools: [Read, WebFetch]' }), {
      registry: registryOf([
        { name: 'weak-critic', canRestrictTools: false, canExpressTools: LATTICE },
      ]),
      extraFiles: PROMPTS,
    });
    expect(errorCodes(result)).toContain('HARNESS_TOOLS_UNEXPRESSIBLE');
  });

  it('boolean-only adapters keep todays behavior: canRestrictTools=false still rejects', () => {
    const result = loadHarness(criticToolsFlow(), {
      registry: registryOf([{ name: 'weak-critic', canRestrictTools: false }]),
      extraFiles: PROMPTS,
    });
    expect(errorCodes(result)).toContain('HARNESS_TOOLS_UNEXPRESSIBLE');
  });
});
