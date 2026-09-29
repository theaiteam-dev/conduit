/**
 * conduit doctor — registered-adapter visibility + misconfiguration warnings
 * (WI-592).
 *
 * `conduit doctor` with NO flow arg gains a flow-INDEPENDENT harness listing so
 * a broken deployment is diagnosed before the first dispatch: every registered
 * adapter's name, caps (canRestrictTools/reportsUsage), and binary-probe result,
 * plus two operator-facing WARNINGS — an env allowlist missing HOME/PATH, and a
 * relative-path _COMMAND override (a doctor-green / first-dispatch-fails hole).
 *
 * ── CONTRACT PINNED FOR B.A. (how doctor reads envAllowlist/command) ──
 *   The introspection registry (deps.harnessRegistry, via
 *   bindHarnessDefinitionsForIntrospection) exposes only name/caps/probeBinary —
 *   it deliberately STRIPS envAllowlist + command. The two warnings need those,
 *   which live on the config-time HarnessAdapterDefinition. So these tests expect
 *   a NEW optional CliDeps field `harnessDefinitions?: HarnessDefinitionRegistry`
 *   (the buildHarnessDefinitionRegistry result buildProductionDeps already builds
 *   at main.ts ~1893 but does not currently thread onto deps). cmdDoctor's no-flow
 *   listing iterates deps.harnessDefinitions.list() + resolve(name) → definition
 *   {name, canRestrictTools, reportsUsage, envAllowlist, command, probeBinary}.
 *   If B.A. prefers a different surface, the injection here is a mechanical
 *   change — ping murdock.
 *
 * ── OUTPUT-FORMAT NOTE ──
 *   Assertions are on the combined stdout+stderr and check semantic tokens
 *   (adapter names, the flag names `canRestrictTools`/`reportsUsage`, the probe
 *   detail, and warning keywords like `HOME`/`PATH`/`absolute`) — not an exact
 *   layout. B.A. owns the rendering; if a token label differs, it's a mechanical
 *   test tweak.
 *
 * Covered ACs (FR-7, FR-11):
 *   AC1 — lists each adapter's name, caps, and binary-probe result.
 *   AC2 — warns on an allowlist missing HOME/PATH (naming the minimum); a
 *         missing credential var (ANTHROPIC_API_KEY) is NEVER flagged (FR-11).
 *   AC3 — warns on a relative-path _COMMAND override (recommend absolute); an
 *         absolute path, a bare PATH-resolved name, and no override do NOT warn.
 *   AC4 — `conduit explain` still renders harness stations (no regression).
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { main, type CliDeps, type CliIO, type PrereqProbe, type RunEngineArgs } from './main';
import {
  buildHarnessDefinitionRegistry,
  bindHarnessDefinitionsForIntrospection,
  type HarnessDefinitionRegistry,
} from '../worker/harness-adapter';
import type { HarnessAdapterConfigDef } from '../worker/harness-config';
import { openConduitDB, type ConduitDB } from '../persistence/db';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import type { ModelAdapter } from '../worker/adapter';
import type { BinaryProbe } from '../worker/harness-adapter';

// The doctor listing reads envAllowlist/command from the definition registry —
// a NEW optional deps field this item introduces (see header).
type DoctorDeps = CliDeps & { harnessDefinitions?: HarnessDefinitionRegistry };

const stubAdapter: ModelAdapter = {
  async call() {
    return { text: '{}', inputTokens: 1, outputTokens: 1, costUsd: 0 };
  },
};

function makeIO(): CliIO & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, out: (l: string) => lines.push(l), err: (l: string) => errors.push(l) };
}

let db: ConduitDB;
let io: ReturnType<typeof makeIO>;

beforeEach(() => {
  db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
  io = makeIO();
});

afterEach(() => {
  db.close();
});

/** Combined stdout+stderr, so assertions don't depend on the warning stream. */
function allOutput(): string {
  return [...io.lines, ...io.errors].join('\n');
}

/** Build a definition registry from config defs with an injected binary probe. */
function defRegistry(
  defs: HarnessAdapterConfigDef[],
  probe: () => Promise<BinaryProbe> = async () => ({ present: true, detail: '/opt/bin/agent' }),
): HarnessDefinitionRegistry {
  return buildHarnessDefinitionRegistry(defs, { probe });
}

/** Deps whose harness listing is driven by the injected definition registry. */
function makeDeps(harnessDefinitions?: HarnessDefinitionRegistry, over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    io,
    now: () => 1_000,
    db,
    adapter: stubAdapter,
    runEngine: async (_args: RunEngineArgs) => {},
    prereqs: [] as PrereqProbe[], // no base probes → the only output is the harness listing
    harnessDefinitions,
    // Introspection registry (name/caps/probe) — what explain + per-flow probing use.
    harnessRegistry: harnessDefinitions ? bindHarnessDefinitionsForIntrospection(harnessDefinitions) : undefined,
    ...over,
  };
}

describe('conduit doctor — registered harness adapter listing (AC1)', () => {
  it('lists each registered adapter name, its caps, and its binary-probe result', async () => {
    const registry = defRegistry(
      [
        { name: 'claude-headless', envAllowlist: ['HOME', 'PATH'] },
        { name: 'codex-exec', envAllowlist: ['HOME', 'PATH'] },
      ],
      async () => ({ present: true, detail: '/opt/bin/agent' }),
    );
    const code = await main(['doctor'], makeDeps(registry));
    const out = allOutput();

    expect(code).toBe(0);
    // Names of both registered adapters.
    expect(out).toContain('claude-headless');
    expect(out).toContain('codex-exec');
    // Capability flags surfaced (claude can restrict tools; codex cannot).
    expect(out).toContain('canRestrictTools');
    expect(out).toContain('reportsUsage');
    // Binary-probe result surfaced (the injected probe detail).
    expect(out).toContain('/opt/bin/agent');
  });

  it('surfaces a MISSING binary in the probe result', async () => {
    const registry = defRegistry(
      [{ name: 'claude-headless', envAllowlist: ['HOME', 'PATH'] }],
      async () => ({ present: false, detail: "'claude' not found on PATH" }),
    );
    await main(['doctor'], makeDeps(registry));
    const out = allOutput();

    expect(out).toContain('claude-headless');
    expect(out.toLowerCase()).toContain('not found');
  });

  it('signals per-list expressibility (perListTools=yes) on lattice adapters only (the original per-list tool-expression work)', async () => {
    // codex-exec's canRestrictTools stays false (deliberately — boolean-only
    // paths must fail closed), so without this signal a doctor reader would
    // conclude it can never host a critic. Boolean-only adapters like
    // claude-headless must NOT grow the token.
    const registry = defRegistry([
      { name: 'claude-headless', envAllowlist: ['HOME', 'PATH'] },
      { name: 'codex-exec', envAllowlist: ['HOME', 'PATH'] },
    ]);
    const code = await main(['doctor'], makeDeps(registry));

    expect(code).toBe(0);
    const codexLine = io.lines.find((l) => l.includes("harness 'codex-exec'"));
    const claudeLine = io.lines.find((l) => l.includes("harness 'claude-headless'"));
    expect(codexLine).toBeDefined();
    expect(claudeLine).toBeDefined();
    expect(codexLine!).toContain('perListTools=yes');
    expect(codexLine!).toContain('canRestrictTools=false');
    expect(claudeLine!).not.toContain('perListTools');
  });
});

describe('conduit doctor — per-call gating adapters (issue #21)', () => {
  it('lists codex-app-server with its probe result and gatesPerCall=yes, and no other adapter grows the token', async () => {
    const registry = defRegistry([
      { name: 'codex-app-server', envAllowlist: ['HOME', 'PATH'] },
      { name: 'claude-headless', envAllowlist: ['HOME', 'PATH'] },
    ]);
    const code = await main(['doctor'], makeDeps(registry));

    expect(code).toBe(0);
    const gatedLine = io.lines.find((l) => l.includes("harness 'codex-app-server'"));
    const plainLine = io.lines.find((l) => l.includes("harness 'claude-headless'"));
    expect(gatedLine).toContain('gatesPerCall=yes');
    expect(gatedLine).toContain('reportsUsage=true');
    expect(gatedLine).toContain('/opt/bin/agent');
    expect(plainLine).not.toContain('gatesPerCall');
  });

  it('reports a missing codex binary as a failure', async () => {
    const registry = defRegistry(
      [{ name: 'codex-app-server', envAllowlist: ['HOME', 'PATH'] }],
      async () => ({ present: false, detail: "'codex' was not found on PATH" }),
    );
    const code = await main(['doctor'], makeDeps(registry));
    expect(code).toBe(1);
    expect(allOutput()).toContain("'codex' was not found on PATH");
  });
});

describe('conduit doctor — env allowlist warnings (AC2, FR-7/FR-11)', () => {
  it('warns, naming HOME, when the allowlist omits HOME', async () => {
    const registry = defRegistry([{ name: 'claude-headless', envAllowlist: ['PATH', 'ANTHROPIC_API_KEY'] }]);
    await main(['doctor'], makeDeps(registry));
    const out = allOutput();

    expect(out.toLowerCase()).toContain('warn');
    expect(out).toContain('HOME');
  });

  it('warns, naming PATH, when the allowlist omits PATH', async () => {
    const registry = defRegistry([{ name: 'claude-headless', envAllowlist: ['HOME'] }]);
    await main(['doctor'], makeDeps(registry));
    const out = allOutput();

    expect(out.toLowerCase()).toContain('warn');
    expect(out).toContain('PATH');
  });

  it('does NOT warn when the allowlist includes both HOME and PATH', async () => {
    const registry = defRegistry([{ name: 'claude-headless', envAllowlist: ['HOME', 'PATH'] }]);
    await main(['doctor'], makeDeps(registry));
    // A fully-floored adapter with no command override yields no warnings at all.
    expect(allOutput().toLowerCase()).not.toContain('warn');
  });

  it('FR-11: a missing credential variable (ANTHROPIC_API_KEY) is neither an error nor a warning', async () => {
    // HOME+PATH present, no credential var — credential mode is the operator's
    // choice, so doctor must stay silent about it.
    const registry = defRegistry([{ name: 'claude-headless', envAllowlist: ['HOME', 'PATH'] }]);
    const code = await main(['doctor'], makeDeps(registry));
    const out = allOutput();

    expect(code).toBe(0);
    expect(out.toUpperCase()).not.toContain('ANTHROPIC');
    expect(out.toLowerCase()).not.toContain('credential');
  });
});

describe('conduit doctor — relative _COMMAND override warning (AC3, FR-7)', () => {
  it('warns, recommending an absolute path, when _COMMAND is a relative path', async () => {
    const registry = defRegistry([
      { name: 'claude-headless', envAllowlist: ['HOME', 'PATH'], command: './bin/claude' },
    ]);
    await main(['doctor'], makeDeps(registry));
    const out = allOutput();

    expect(out.toLowerCase()).toContain('warn');
    expect(out.toLowerCase()).toContain('absolute');
    expect(out).toContain('./bin/claude');
  });

  it('does NOT warn when _COMMAND is an absolute path', async () => {
    const registry = defRegistry([
      { name: 'claude-headless', envAllowlist: ['HOME', 'PATH'], command: '/opt/bin/claude' },
    ]);
    await main(['doctor'], makeDeps(registry));
    expect(allOutput().toLowerCase()).not.toContain('warn');
  });

  it('does NOT warn for a bare command name (PATH-resolved, identical cwd at probe and dispatch)', async () => {
    // A bare name is not a relative PATH — it resolves via PATH the same way at
    // probe and dispatch, so there is no cwd hole to warn about. Guards against a
    // naive `!isAbsolute(command)` check that would wrongly warn on the default.
    const registry = defRegistry([
      { name: 'claude-headless', envAllowlist: ['HOME', 'PATH'], command: 'claude' },
    ]);
    await main(['doctor'], makeDeps(registry));
    expect(allOutput().toLowerCase()).not.toContain('warn');
  });

  it('does NOT warn when no _COMMAND override is set', async () => {
    const registry = defRegistry([{ name: 'claude-headless', envAllowlist: ['HOME', 'PATH'] }]);
    await main(['doctor'], makeDeps(registry));
    expect(allOutput().toLowerCase()).not.toContain('warn');
  });
});

describe('conduit doctor <flow.yaml> — adapter misconfiguration warnings (finding #4)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'conduit-doctor-flowwarn-'));
    mkdirSync(join(dir, 'prompts'), { recursive: true });
    writeFileSync(join(dir, 'prompts', 'coder.md'), 'Do the task.');
    writeFileSync(
      join(dir, 'flow.yaml'),
      `
flow: research-lite
flow_version: 1
terminal_lanes: [done, scrap, hold]
stations:
  - id: coder
    worker:
      kind: harness
      harness: claude-headless
      prompt_file: prompts/coder.md
      prompt_version: "1"
      tools: [Read, Write, Bash]
      output_schema:
        fields:
          - { name: result, type: string, required: true }
    inputs: [task.md]
    outputs: [result.md]
    next: done
`,
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('warns, naming HOME, when a flow-scoped adapter allowlist omits HOME', async () => {
    const registry = defRegistry([{ name: 'claude-headless', envAllowlist: ['PATH', 'ANTHROPIC_API_KEY'] }]);
    await main(['doctor', join(dir, 'flow.yaml')], makeDeps(registry));
    const out = allOutput();

    expect(out.toLowerCase()).toContain('warn');
    expect(out).toContain('HOME');
  });

  it('warns, recommending an absolute path, when a flow-scoped adapter _COMMAND is relative', async () => {
    const registry = defRegistry([
      { name: 'claude-headless', envAllowlist: ['HOME', 'PATH'], command: './bin/claude' },
    ]);
    await main(['doctor', join(dir, 'flow.yaml')], makeDeps(registry));
    const out = allOutput();

    expect(out.toLowerCase()).toContain('warn');
    expect(out.toLowerCase()).toContain('absolute');
    expect(out).toContain('./bin/claude');
  });

  it('does NOT warn when a flow-scoped adapter is well-configured (HOME+PATH, no override)', async () => {
    const registry = defRegistry([{ name: 'claude-headless', envAllowlist: ['HOME', 'PATH'] }]);
    const code = await main(['doctor', join(dir, 'flow.yaml')], makeDeps(registry));

    expect(code).toBe(0);
    expect(allOutput().toLowerCase()).not.toContain('warn');
  });
});

describe('conduit explain — harness station rendering (AC4, no regression)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'conduit-doctor-explain-'));
    mkdirSync(join(dir, 'prompts'), { recursive: true });
    writeFileSync(join(dir, 'prompts', 'coder.md'), 'Do the task.');
    writeFileSync(
      join(dir, 'flow.yaml'),
      `
flow: research-lite
flow_version: 1
terminal_lanes: [done, scrap, hold]
stations:
  - id: coder
    worker:
      kind: harness
      harness: claude-headless
      prompt_file: prompts/coder.md
      prompt_version: "1"
      tools: [Read, Write, Bash]
      output_schema:
        fields:
          - { name: result, type: string, required: true }
    inputs: [task.md]
    outputs: [result.md]
    next: done
`,
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('renders the harness station against the configured registry', async () => {
    const registry = defRegistry([{ name: 'claude-headless', envAllowlist: ['HOME', 'PATH'] }]);
    const code = await main(['explain', join(dir, 'flow.yaml')], makeDeps(registry));
    const out = allOutput();

    expect(code).toBe(0);
    // The harness station is rendered (no validation error suppressed it).
    expect(out).toContain('coder');
    expect(io.errors.filter((l) => l.includes('validation error'))).toEqual([]);
  });
});
