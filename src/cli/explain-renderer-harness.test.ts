/**
 * `conduit explain` + `conduit doctor` render harness stations (WI-573).
 *
 * Keeps the flow author's mental model matching the runtime (NFR-Op-4, the explain-renderer work
 * lesson: explain / validate / runtime must agree). For a `kind: harness`
 * station, explain renders its adapter identity, tools allowlist, attached gate,
 * an unrestricted_tools waiver WARNING (NFR-Security-3), and a usage-blind flag
 * (NFR-Op-2); doctor probes the configured harness binary and reports
 * present/invocable vs missing/non-executable, naming the adapter and path.
 *
 * Contract decisions this file pins:
 *   - renderFlow gains an optional `harnessRegistry` on RenderOptions so the
 *     renderer can resolve station.harness → adapter.reportsUsage for the
 *     usage-blind flag (the frozen FlowConfig alone cannot carry adapter
 *     capability). Identity/tools/waiver come from the StationConfig fields
 *     (WI-559) and need no registry.
 *   - doctor gains a harness-binary probe section keyed off deps.harnessRegistry:
 *     it resolves each harness station's adapter, awaits probeBinary(), and emits
 *     a present/missing line naming the adapter + probed path; a missing binary
 *     makes doctor exit non-zero.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { renderFlow, type RenderOptions } from './explain-renderer';
import { main, type CliDeps, type CliIO, type PrereqProbe, type RunEngineArgs } from './main';
import type { FlowConfig, StationConfig, StationGateConfig } from '../types/kernel';
import type { ModelAdapter } from '../worker/adapter';
import { openConduitDB, type ConduitDB } from '../persistence/db';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import {
  createHarnessRegistry,
  makeFakeHarnessAdapter,
  type HarnessAdapter,
  type BinaryProbe,
  type HarnessRegistry,
} from '../worker/harness-adapter';

// ---------------------------------------------------------------------------
// Literal FlowConfig builders (the explain-renderer.test.ts convention).
// ---------------------------------------------------------------------------

function harnessStation(overrides: Partial<StationConfig> = {}): StationConfig {
  return {
    kind: 'harness',
    effectful: false,
    wip: 1,
    inputs: [],
    outputs: [],
    harness: 'claude-headless',
    tools: ['Read', 'Write', 'Bash'],
    ...overrides,
  };
}

function makeFlow(stations: Record<string, StationConfig>): FlowConfig {
  return Object.freeze({
    version: 1,
    name: 'wi573-fixture',
    stations,
    terminal_lanes: ['done', 'scrap', 'hold'],
  }) as FlowConfig;
}

const GATE: StationGateConfig = {
  criticModel: 'critic-model',
  criticPromptFile: '/tmp/verify.md',
  criticPromptVersion: '1',
  onReject: 'coder',
  reworkCap: 2,
  criticInputScope: [],
};

/** Render in both the plain and rich modes so the harness surface shows in each. */
const MODES: Array<[string, RenderOptions]> = [
  ['plain', {}],
  ['rich', { rich: true }],
];

// ---------------------------------------------------------------------------
// AC1 — explain renders adapter identity + tools allowlist + attached gate.
// ---------------------------------------------------------------------------

describe('WI-573 AC1 — explain renders a harness station identity, tools, and gate', () => {
  it.each(MODES)('shows the adapter identity and every allowlisted tool (%s)', (_mode, opts) => {
    const flow = makeFlow({ coder: harnessStation({ tools: ['Read', 'Write', 'Bash'] }) });

    const out = renderFlow(flow, opts);

    // Adapter identity (station.harness) — the runtime worker, not just model=.
    expect(out).toContain('claude-headless');
    // The declared tools allowlist is surfaced verbatim.
    expect(out).toContain('Read');
    expect(out).toContain('Write');
    expect(out).toContain('Bash');
  });

  it.each(MODES)('shows the attached check gate on a gated harness station (%s)', (_mode, opts) => {
    const flow = makeFlow({ coder: harnessStation({ gateCheck: GATE }) });

    const out = renderFlow(flow, opts);

    // The gate is visible (the existing (check)/gate marker on the station).
    expect(out).toMatch(/\(check\)|gate/i);
    expect(out).toContain('claude-headless');
  });
});

// ---------------------------------------------------------------------------
// AC2 — an unrestricted_tools: true waiver renders a visible WARNING (only when
// the waiver is present).
// ---------------------------------------------------------------------------

describe('WI-573 AC2 — unrestricted_tools waiver renders a warning', () => {
  it.each(MODES)('renders a permission-narrowing waiver warning when unrestricted_tools is true (%s)', (_mode, opts) => {
    const flow = makeFlow({ coder: harnessStation({ unrestricted_tools: true }) });

    const out = renderFlow(flow, opts);

    // Visible, named waiver warning — the operator must SEE the security opt-out.
    expect(out).toMatch(/unrestricted/i);
    expect(out).toMatch(/warn/i);
  });

  it.each(MODES)('renders NO waiver warning when the station does not carry the waiver (%s)', (_mode, opts) => {
    const flow = makeFlow({ coder: harnessStation({ unrestricted_tools: false }) });

    const out = renderFlow(flow, opts);

    // The "only" qualifier: absent waiver → no unrestricted-tools warning at all.
    expect(out).not.toMatch(/unrestricted/i);
  });
});

// ---------------------------------------------------------------------------
// AC3 — a usage-blind adapter (reportsUsage=false) renders a usage-blind flag
// in explain (only for usage-blind adapters). Needs the registry for capability.
// ---------------------------------------------------------------------------

describe('WI-573 AC3 — usage-blind indicator in explain', () => {
  it.each(MODES)('renders a usage-blind indicator when the adapter cannot report usage (%s)', (_mode, opts) => {
    const flow = makeFlow({ coder: harnessStation() });
    const registry = createHarnessRegistry([
      makeFakeHarnessAdapter({ name: 'claude-headless', reportsUsage: false }).adapter,
    ]);

    const out = renderFlow(flow, { ...opts, harnessRegistry: registry });

    expect(out).toMatch(/usage.?blind/i);
  });

  it.each(MODES)('renders NO usage-blind indicator when the adapter reports usage (%s)', (_mode, opts) => {
    const flow = makeFlow({ coder: harnessStation() });
    const registry = createHarnessRegistry([
      makeFakeHarnessAdapter({ name: 'claude-headless', reportsUsage: true }).adapter,
    ]);

    const out = renderFlow(flow, { ...opts, harnessRegistry: registry });

    // The "only" qualifier: a usage-reporting adapter is never flagged usage-blind.
    expect(out).not.toMatch(/usage.?blind/i);
  });
});

// ---------------------------------------------------------------------------
// AC4 — `conduit doctor` probes the harness binary (present vs missing), naming
// the adapter and probed path. Driven through the real main() doctor command.
// ---------------------------------------------------------------------------

function makeIO(): CliIO & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, out: (l: string) => lines.push(l), err: (l: string) => errors.push(l) };
}

const stubModel: ModelAdapter = {
  async call() {
    return { text: '{}', inputTokens: 1, outputTokens: 1, costUsd: 0 };
  },
};

/** A harness adapter with a scripted binary probe (present + probed path). */
function probingAdapter(
  name: string,
  probe: BinaryProbe,
  opts: { reportsUsage?: boolean } = {},
): HarnessAdapter {
  return {
    name,
    reportsUsage: opts.reportsUsage ?? true,
    canRestrictTools: true,
    async probeBinary(): Promise<BinaryProbe> {
      return probe;
    },
    async invoke() {
      throw new Error('doctor must not invoke the harness');
    },
  };
}

let dir: string;
let db: ConduitDB;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conduit-wi573-doctor-'));
  db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Write a valid single-harness-station flow that loads against `registry`. */
function writeHarnessFlow(adapterName: string): string {
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'coder.md'), 'Implement the task.');
  const yaml = `
flow: wi573-doctor
flow_version: 1
terminal_lanes: [done, scrap, hold]
stations:
  - id: coder
    worker:
      kind: harness
      harness: ${adapterName}
      model: sonnet
      prompt_file: prompts/coder.md
      prompt_version: "1"
      tools: [Read, Write, Bash]
      output_schema:
        fields:
          - { name: result, type: string, required: true }
    inputs: [task.md]
    outputs: [result.md]
    next: done
`;
  const path = join(dir, 'flow.yaml');
  writeFileSync(path, yaml, 'utf-8');
  return path;
}

function makeDoctorDeps(io: CliIO, registry: HarnessRegistry): CliDeps {
  return {
    io,
    now: () => 1_000,
    db,
    adapter: stubModel,
    runEngine: async (_a: RunEngineArgs) => {},
    prereqs: [{ name: 'noop', check: () => ({ ok: true }) } as PrereqProbe],
    harnessRegistry: registry,
  };
}

describe('WI-573 AC4 — doctor probes the harness binary', () => {
  it('reports the harness binary as present/invocable, naming the adapter and path (exit 0)', async () => {
    const registry = createHarnessRegistry([
      probingAdapter('claude-headless', { present: true, detail: '/usr/local/bin/claude' }),
    ]);
    const flowPath = writeHarnessFlow('claude-headless');
    const io = makeIO();

    const code = await main(['doctor', flowPath], makeDoctorDeps(io, registry));

    const printed = [...io.lines, ...io.errors].join('\n');
    expect(printed).toContain('claude-headless');
    expect(printed).toContain('/usr/local/bin/claude');
    // A present, invocable binary does not fail the doctor run.
    expect(code).toBe(0);
  });

  it('reports a missing/non-executable harness binary, naming the adapter and path, and exits non-zero', async () => {
    const registry = createHarnessRegistry([
      probingAdapter('claude-headless', { present: false, detail: '/usr/local/bin/claude' }),
    ]);
    const flowPath = writeHarnessFlow('claude-headless');
    const io = makeIO();

    const code = await main(['doctor', flowPath], makeDoctorDeps(io, registry));

    const printed = [...io.lines, ...io.errors].join('\n');
    expect(printed).toContain('claude-headless');
    expect(printed).toContain('/usr/local/bin/claude');
    // A missing/non-executable harness binary is a doctor failure (FR-10 spirit).
    expect(code).not.toBe(0);
  });

  it('surfaces a usage-blind adapter in doctor output (NFR-Op-2)', async () => {
    const registry = createHarnessRegistry([
      probingAdapter('claude-headless', { present: true, detail: '/usr/local/bin/claude' }, { reportsUsage: false }),
    ]);
    const flowPath = writeHarnessFlow('claude-headless');
    const io = makeIO();

    await main(['doctor', flowPath], makeDoctorDeps(io, registry));

    const printed = [...io.lines, ...io.errors].join('\n');
    expect(printed).toMatch(/usage.?blind/i);
  });

  // Refactor-safety (finding 4 part 2): doctor now delegates the pass/fail
  // verdict to the shared probeHarnessBinaries helper. These pin the exact
  // line shape/content so that dedup did not silently change the output.
  it('emits the exact present-line shape after delegating to probeHarnessBinaries', async () => {
    const registry = createHarnessRegistry([
      probingAdapter('claude-headless', { present: true, detail: '/usr/local/bin/claude' }),
    ]);
    const flowPath = writeHarnessFlow('claude-headless');
    const io = makeIO();

    const code = await main(['doctor', flowPath], makeDoctorDeps(io, registry));

    expect(code).toBe(0);
    expect(io.lines).toContain("  harness 'claude-headless' (station 'coder') at '/usr/local/bin/claude': ok");
  });

  it('emits the exact FAIL-line shape and exits non-zero for a missing binary', async () => {
    const registry = createHarnessRegistry([
      probingAdapter('claude-headless', { present: false, detail: '/usr/local/bin/claude' }),
    ]);
    const flowPath = writeHarnessFlow('claude-headless');
    const io = makeIO();

    const code = await main(['doctor', flowPath], makeDoctorDeps(io, registry));

    expect(code).not.toBe(0);
    expect(io.lines).toContain("  harness 'claude-headless' (station 'coder') at '/usr/local/bin/claude': FAIL");
  });
});

// ---------------------------------------------------------------------------
// Finding 3 (wiring) — the usage-blind indicator (NFR-Op-2) must render through
// the REAL `conduit explain` command, not just renderFlow() in isolation. This
// drives main(['explain', ...]) so it fails if cmdExplain forgets to thread
// deps.harnessRegistry into renderFlow.
// ---------------------------------------------------------------------------

describe('finding 3 — conduit explain surfaces usage-blind end-to-end via main()', () => {
  it('renders the usage-blind indicator through cmdExplain for a usage-blind adapter', async () => {
    const registry = createHarnessRegistry([
      probingAdapter('claude-headless', { present: true }, { reportsUsage: false }),
    ]);
    const flowPath = writeHarnessFlow('claude-headless');
    const io = makeIO();

    const code = await main(['explain', flowPath], makeDoctorDeps(io, registry));

    expect(code).toBe(0);
    // The registry-dependent branch renders only when cmdExplain threads the
    // registry into renderFlow — proving the wiring, not just the renderer.
    expect(io.lines.join('\n')).toMatch(/usage.?blind/i);
  });

  it('renders NO usage-blind indicator through cmdExplain when the adapter reports usage', async () => {
    const registry = createHarnessRegistry([
      probingAdapter('claude-headless', { present: true }, { reportsUsage: true }),
    ]);
    const flowPath = writeHarnessFlow('claude-headless');
    const io = makeIO();

    const code = await main(['explain', flowPath], makeDoctorDeps(io, registry));

    expect(code).toBe(0);
    expect(io.lines.join('\n')).not.toMatch(/usage.?blind/i);
  });
});

// ---------------------------------------------------------------------------
// Finding 4 part 1 (wiring) — cmdRun / cmdResume must probe declared harness
// binaries at startup (FR-10), failing BEFORE any dispatch. A runEngine that
// throws if reached proves the gate fires before the engine, not at first
// dispatch.
// ---------------------------------------------------------------------------

function makeStartupGateDeps(io: CliIO, registry: HarnessRegistry): CliDeps {
  return {
    ...makeDoctorDeps(io, registry),
    runEngine: async (_a: RunEngineArgs) => {
      throw new Error('engine started — the harness binary probe must gate before dispatch');
    },
  };
}

describe('finding 4 — run/resume fail at startup on a missing harness binary (FR-10)', () => {
  it('cmdRun fails at startup, before the engine, when a configured harness binary is missing', async () => {
    const registry = createHarnessRegistry([
      probingAdapter('claude-headless', { present: false, detail: '/usr/local/bin/claude' }),
    ]);
    const flowPath = writeHarnessFlow('claude-headless');
    const io = makeIO();

    const code = await main(['run', flowPath], makeStartupGateDeps(io, registry));

    expect(code).not.toBe(0);
    const errs = io.errors.join('\n');
    expect(errs).toContain('HARNESS_BINARY_NOT_FOUND');
    expect(errs).toContain('claude-headless');
  });

  it('cmdResume fails at startup, before the engine, when a configured harness binary is missing', async () => {
    const registry = createHarnessRegistry([
      probingAdapter('claude-headless', { present: false, detail: '/usr/local/bin/claude' }),
    ]);
    const flowPath = writeHarnessFlow('claude-headless');
    const io = makeIO();

    const code = await main(['resume', flowPath], makeStartupGateDeps(io, registry));

    expect(code).not.toBe(0);
    expect(io.errors.join('\n')).toContain('HARNESS_BINARY_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// Issue #35 — a gate critic on a harness adapter is a harness too, whatever the
// station's own kind. explain, doctor and the startup probe must all list it,
// labelled as the critic's so it is not read as the maker's.
// ---------------------------------------------------------------------------

const CRITIC_GATE: StationGateConfig = {
  ...GATE,
  criticModel: 'gpt-5',
  criticHarness: 'codex-exec',
  criticTools: ['Read', 'Bash(ls)'],
  criticAgent: 'reviewer',
};

function transformStation(overrides: Partial<StationConfig> = {}): StationConfig {
  return { kind: 'transform', effectful: false, wip: 1, inputs: [], outputs: [], model: 'sonnet', ...overrides };
}

/** Drop table borders and collapse whitespace, so a note the rich table wrapped reads as one line. */
function flatten(out: string): string {
  return out.replace(/[║│]/g, ' ').replace(/\s+/g, ' ');
}

describe('issue #35 — explain renders a harness critic', () => {
  it.each(MODES)('renders the critic adapter, model, agent and tools on a kind: transform station (%s)', (_mode, opts) => {
    const flow = makeFlow({ draft: transformStation({ gateCheck: CRITIC_GATE }) });

    const out = flatten(renderFlow(flow, opts));

    expect(out).toContain('critic harness=codex-exec');
    expect(out).toContain('critic model=gpt-5');
    expect(out).toContain('critic agent=reviewer');
    expect(out).toContain('critic tools=Read,Bash(ls)');
    // No maker harness on a transform station.
    expect(out).not.toMatch(/(?<!critic )harness=/);
  });

  it.each(MODES)('omits critic model and agent when the critic declares neither (%s)', (_mode, opts) => {
    // The loader stores an undeclared critic model as ''.
    const gate: StationGateConfig = { ...GATE, criticModel: '', criticHarness: 'codex-exec', criticTools: ['Read'] };
    const flow = makeFlow({ draft: transformStation({ gateCheck: gate }) });

    const out = flatten(renderFlow(flow, opts));

    expect(out).toContain('critic harness=codex-exec');
    expect(out).not.toContain('critic model=');
    expect(out).not.toContain('critic agent=');
  });

  it.each(MODES)("renders a usage-blind critic adapter as the critic's (%s)", (_mode, opts) => {
    const flow = makeFlow({ draft: transformStation({ gateCheck: CRITIC_GATE }) });
    const registry = createHarnessRegistry([
      makeFakeHarnessAdapter({ name: 'codex-exec', reportsUsage: false }).adapter,
    ]);

    const out = flatten(renderFlow(flow, { ...opts, harnessRegistry: registry }));

    expect(out).toContain('critic usage-blind');
  });

  it.each(MODES)('reports both the maker and the critic when they use different adapters (%s)', (_mode, opts) => {
    const flow = makeFlow({ coder: harnessStation({ agent: 'team:coder', gateCheck: CRITIC_GATE }) });
    const registry = createHarnessRegistry([
      makeFakeHarnessAdapter({ name: 'claude-headless', reportsUsage: false }).adapter,
      makeFakeHarnessAdapter({ name: 'codex-exec', reportsUsage: true }).adapter,
    ]);

    const out = flatten(renderFlow(flow, { ...opts, harnessRegistry: registry }));

    expect(out).toContain('harness=claude-headless');
    expect(out).toContain('agent=team:coder');
    expect(out).toContain('critic harness=codex-exec');
    // Only the maker's adapter is usage-blind here.
    expect(out).toContain('usage-blind (adapter cannot report token/cost usage)');
    expect(out).not.toContain('critic usage-blind');
  });
});

/** A maker of `makerKind` gated by a harness critic on `criticAdapter`. */
function writeCriticFlow(criticAdapter: string, makerKind: 'transform' | 'harness' = 'transform'): string {
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'coder.md'), 'Implement the task.');
  writeFileSync(join(dir, 'prompts', 'verify.md'), 'Check the work.');
  const makerHarness = makerKind === 'harness' ? '\n      harness: claude-headless\n      tools: [Read, Write]' : '';
  const yaml = `
flow: issue35-doctor
flow_version: 1
terminal_lanes: [done, scrap, hold]
stations:
  - id: draft
    worker:
      kind: ${makerKind}${makerHarness}
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
        harness: ${criticAdapter}
        tools: [Read]
        prompt_file: prompts/verify.md
        prompt_version: "1"
      on_reject: draft
`;
  const path = join(dir, 'flow.yaml');
  writeFileSync(path, yaml, 'utf-8');
  return path;
}

describe('issue #35 — doctor probes a harness critic', () => {
  it('prints a critic probe line and fails when the critic binary of a kind: transform station is missing', async () => {
    const registry = createHarnessRegistry([
      probingAdapter('codex-exec', { present: false, detail: '/usr/local/bin/codex' }),
    ]);
    const flowPath = writeCriticFlow('codex-exec');
    const io = makeIO();

    const code = await main(['doctor', flowPath], makeDoctorDeps(io, registry));

    expect(code).not.toBe(0);
    expect(io.lines).toContain("  harness 'codex-exec' (station 'draft' critic) at '/usr/local/bin/codex': FAIL");
  });

  it("prints the critic's usage-blind notice when its adapter cannot report usage", async () => {
    const registry = createHarnessRegistry([
      probingAdapter('codex-exec', { present: true, detail: '/usr/local/bin/codex' }, { reportsUsage: false }),
    ]);
    const flowPath = writeCriticFlow('codex-exec');
    const io = makeIO();

    const code = await main(['doctor', flowPath], makeDoctorDeps(io, registry));

    expect(code).toBe(0);
    expect(io.lines).toContain("  harness 'codex-exec' (station 'draft' critic) at '/usr/local/bin/codex': ok");
    expect(io.lines).toContain(
      "  harness 'codex-exec' (station 'draft' critic) is usage-blind (cannot report token/cost usage)",
    );
  });

  it('prints a line for the maker and one for the critic when a station has both', async () => {
    const registry = createHarnessRegistry([
      probingAdapter('claude-headless', { present: true, detail: '/usr/local/bin/claude' }),
      probingAdapter('codex-exec', { present: false, detail: '/usr/local/bin/codex' }),
    ]);
    const flowPath = writeCriticFlow('codex-exec', 'harness');
    const io = makeIO();

    const code = await main(['doctor', flowPath], makeDoctorDeps(io, registry));

    expect(code).not.toBe(0);
    expect(io.lines).toContain("  harness 'claude-headless' (station 'draft') at '/usr/local/bin/claude': ok");
    expect(io.lines).toContain("  harness 'codex-exec' (station 'draft' critic) at '/usr/local/bin/codex': FAIL");
  });

  it('cmdRun fails at startup when only the critic binary is missing', async () => {
    const registry = createHarnessRegistry([
      probingAdapter('codex-exec', { present: false, detail: '/usr/local/bin/codex' }),
    ]);
    const flowPath = writeCriticFlow('codex-exec');
    const io = makeIO();

    const code = await main(['run', flowPath], makeStartupGateDeps(io, registry));

    expect(code).not.toBe(0);
    expect(io.errors.join('\n')).toContain("Station 'draft' critic harness adapter 'codex-exec' binary not found");
  });
});
