/**
 * Tests for `conduit doctor` container pre-flight probes (WI-437, FR-2/FR-7).
 *
 * Doctor gains an optional positional flow arg (`conduit doctor [flow.yaml]`).
 * It always runs the volume+env probes (state-dir-writable, project-root-present)
 * and, ONLY when a flow arg is given, the flow-aware probes (flow-prereqs-present,
 * model-endpoint-reachable) sourced from the loaded FlowConfig. Every probe is
 * reported on its own line; doctor exits non-zero if ANY probe fails. `run` and
 * `listen` invoke doctor as a pre-flight gate and abort before dispatch/boot on a
 * non-zero result.
 *
 * ---------------------------------------------------------------------------
 * Contract this file pins for src/cli/main.ts (B.A. implements):
 * ---------------------------------------------------------------------------
 *
 *   // 1. PrereqProbe.check() is WIDENED to allow async (the model-endpoint probe
 *   //    makes a real HTTP connect). cmdDoctor must `await` each check. Existing
 *   //    sync probes (cli.test.ts / listen.test.ts) remain valid.
 *   export interface PrereqProbe {
 *     name: string;
 *     check(): { ok: boolean; detail?: string } | Promise<{ ok: boolean; detail?: string }>;
 *   }
 *
 *   // 2. CliDeps gains an OPTIONAL flow-aware probe factory, invoked by cmdDoctor
 *   //    only when a flow arg is provided. Optional so existing CliDeps literals
 *   //    keep compiling; buildProductionDeps populates it with the real factory.
 *   export interface CliDeps {
 *     // ...existing fields...
 *     flowProbes?: (flow: FlowConfig) => PrereqProbe[];
 *   }
 *
 *   // 3. Exported, individually-testable probe builders:
 *   export function buildStateDirProbe(stateDbPath: string, options?: ...): PrereqProbe;
 *   export function buildProjectRootProbe(projectRoot: string | undefined): PrereqProbe;
 *   export function buildFlowPrereqsProbe(prerequisites: readonly string[]): PrereqProbe;
 *   export function buildModelEndpointProbe(
 *     baseUrl: string | undefined,
 *     connect?: (baseUrl: string) => Promise<boolean>,  // injectable; default = real HTTP HEAD/GET
 *   ): PrereqProbe;
 *
 *   // 4. cmdDoctor(argv): parses an optional positional flow.yaml; when present,
 *   //    loadFlow() it and append deps.flowProbes(flow); when absent, base only.
 *   // 5. cmdRun / cmdListen run the doctor pre-flight first and abort (non-zero,
 *   //    no runEngine / no startListener) when it fails (FR-2).
 *
 * RED before WI-437: the builders + flowProbes seam don't exist (typecheck red on
 * the new exports), cmdDoctor ignores any flow arg, and run/listen have no gate.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openConduitDB, type ConduitDB } from '../persistence/db';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import type { ModelAdapter } from '../worker/adapter';
import type { FlowConfig } from '../types/kernel';
import type { ListenerConfig, StartListenerResult, Listener } from '../ingress/listener';
import {
  main,
  buildStateDirProbe,
  buildProjectRootProbe,
  buildFlowPrereqsProbe,
  buildModelEndpointProbe,
  buildProcessContainmentProbe,
  type CliDeps,
  type CliIO,
  type PrereqProbe,
  type RunEngineArgs,
} from './main';

// ---------------------------------------------------------------------------
// Temp-file scaffolding (real FS for the volume/PATH probes)
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Write a flow.yaml into a fresh temp dir and return its absolute path. */
function writeTempFlow(yaml: string): string {
  const dir = makeTempDir('conduit-docflow-');
  const path = join(dir, 'flow.yaml');
  writeFileSync(path, yaml, 'utf-8');
  return path;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

// A minimal, valid flow (no egress channels → no Slack boot gate) used by the
// run pre-flight test and the doctor flow-arg gating test.
const MINIMAL_FLOW_YAML = `
flow: doc
flow_version: 1
terminal_lanes: [done, scrap, hold]
prerequisites: [ffmpeg]
stations:
  - id: a
    worker: { kind: transform }
`;

// A YAML-parseable but INVALID flow (prerequisites is a string, not a list →
// INVALID_PREREQUISITES). Used to prove doctor still reports its base probes
// when the flow arg fails to load, rather than bailing before the probe loop.
const INVALID_FLOW_YAML = `
flow: docbad
flow_version: 1
terminal_lanes: [done, scrap, hold]
prerequisites: ffmpeg
stations:
  - id: a
    worker: { kind: transform }
`;

// ===========================================================================
// GROUP A — individual probe builders (real I/O; injected network connect)
// ===========================================================================

describe('buildStateDirProbe — writable state-dir write test (AC3/AC4/AC5)', () => {
  it('reports ok for a writable state directory and leaves no temp file behind', async () => {
    const dir = makeTempDir('conduit-state-');
    const before = readdirSync(dir);

    const probe = buildStateDirProbe(join(dir, 'conduit.sqlite'));
    const result = await probe.check();

    expect(result.ok).toBe(true);
    // The probe must CREATE AND DELETE its temp file — no residue (it is a
    // liveness write test, not a persisted marker).
    expect(readdirSync(dir)).toEqual(before);
  });

  it('reports FAIL with a writable-mount remedy when the state dir is not writable', async () => {
    // Point the state DB path's parent at a regular FILE, so writing a probe
    // file into it fails with ENOTDIR for ANY uid (robust even when tests run
    // as root, where chmod 0o555 would not block writes). This is the read-only
    // bind-mount failure mode (AC4): a real write test, not a SELECT-1 read.
    const dir = makeTempDir('conduit-ro-');
    const notADir = join(dir, 'state-is-a-file');
    writeFileSync(notADir, 'x', 'utf-8');

    const probe = buildStateDirProbe(join(notADir, 'conduit.sqlite'));
    const result = await probe.check();

    expect(result.ok).toBe(false);
    expect(result.detail ?? '').toMatch(/writable/i); // remedy names a writable volume mount
  });

  it('reports FAIL for a writable /data state directory that is not a mounted volume', async () => {
    const dir = makeTempDir('conduit-data-root-');
    const dataDir = join(dir, 'data');
    const mountInfoPath = join(dir, 'mountinfo');
    writeFileSync(mountInfoPath, '25 1 0:22 / / rw,relatime - overlay overlay rw\n', 'utf-8');
    // Create the synthetic /data equivalent after mountinfo so the probe can
    // prove writability and then fail specifically on "not mounted".
    mkdirSync(dataDir);

    const probe = buildStateDirProbe(join(dataDir, 'conduit.sqlite'), {
      requireMountRoot: dataDir,
      mountInfoPath,
    });
    const result = await probe.check();

    expect(result.ok).toBe(false);
    expect(result.detail ?? '').toMatch(/mounted volume/i);
  });

  it('reports ok for a writable /data state directory backed by a mount entry', async () => {
    const dir = makeTempDir('conduit-mounted-root-');
    const dataDir = join(dir, 'data');
    const mountInfoPath = join(dir, 'mountinfo');
    mkdirSync(dataDir);
    writeFileSync(
      mountInfoPath,
      `25 1 0:22 / / rw,relatime - overlay overlay rw\n` +
        `26 25 0:44 / ${dataDir} rw,relatime - ext4 /dev/sda1 rw\n`,
      'utf-8',
    );

    const probe = buildStateDirProbe(join(dataDir, 'conduit.sqlite'), {
      requireMountRoot: dataDir,
      mountInfoPath,
    });
    const result = await probe.check();

    expect(result.ok).toBe(true);
  });
});

describe('buildProjectRootProbe — project-root presence (AC9)', () => {
  it('reports ok when the project root exists', async () => {
    const dir = makeTempDir('conduit-root-');
    const result = await buildProjectRootProbe(dir).check();
    expect(result.ok).toBe(true);
  });

  it.each([
    ['undefined', undefined],
    ['a non-existent path', join(tmpdir(), 'conduit-absent-root-zzz999')],
  ])('reports FAIL when the project root is %s', async (_label, root) => {
    const result = await buildProjectRootProbe(root as string | undefined).check();
    expect(result.ok).toBe(false);
  });
});

describe('buildFlowPrereqsProbe — declared prerequisites present on PATH (AC6)', () => {
  it.each([
    ['an empty prerequisite list', [] as string[]],
    ['a prerequisite that is on PATH', ['sh']],
  ])('reports ok for %s', async (_label, prereqs) => {
    const result = await buildFlowPrereqsProbe(prereqs).check();
    expect(result.ok).toBe(true);
  });

  it('reports FAIL naming the missing package when a prerequisite is absent from PATH', async () => {
    const missing = 'conduit-not-a-real-binary-zzz999';
    const result = await buildFlowPrereqsProbe([missing]).check();
    expect(result.ok).toBe(false);
    expect(result.detail ?? '').toContain(missing);
  });

  it('reports FAIL when ANY entry is missing, not just the first (names the missing one)', async () => {
    const missing = 'conduit-absent-tool-zzz888';
    const result = await buildFlowPrereqsProbe(['sh', missing]).check();
    expect(result.ok).toBe(false);
    expect(result.detail ?? '').toContain(missing);
  });
});

describe('buildModelEndpointProbe — reachability via injectable connect (AC7/AC8)', () => {
  it('reports ok and connects to the supplied base URL when reachable', async () => {
    const baseUrl = 'http://model-gateway.test:8080';
    const seen: string[] = [];
    const connect = async (url: string): Promise<boolean> => {
      seen.push(url);
      return true;
    };

    const result = await buildModelEndpointProbe(baseUrl, connect).check();

    expect(result.ok).toBe(true);
    expect(seen).toEqual([baseUrl]); // reuses the configured endpoint, no other URL
  });

  it('reports FAIL with the endpoint in the message when the connect fails', async () => {
    const baseUrl = 'http://model-gateway.test:8080';
    const connect = async (): Promise<boolean> => false;

    const result = await buildModelEndpointProbe(baseUrl, connect).check();

    expect(result.ok).toBe(false);
    expect(result.detail ?? '').toContain(baseUrl);
  });

  it('reports FAIL (not a crash) when the connect throws', async () => {
    const baseUrl = 'http://model-gateway.test:8080';
    const connect = async (): Promise<boolean> => {
      throw new Error('ECONNREFUSED');
    };

    const result = await buildModelEndpointProbe(baseUrl, connect).check();

    expect(result.ok).toBe(false);
    expect(result.detail ?? '').toContain(baseUrl);
  });

  // An UNSET env var arrives as undefined; an env var set to "" (CONDUIT_BASE_URL=)
  // arrives as an empty string. Both mean "not configured" and must short-circuit
  // to FAIL before any connect attempt — an empty string must NOT slip past the
  // guard into connect('') (which would crash on a bad URL or, with a stubbed
  // connect, falsely report ok).
  it.each([
    ['undefined', undefined],
    ['an empty string', ''],
  ])('reports FAIL naming CONDUIT_BASE_URL when the base URL is %s', async (_label, baseUrl) => {
    let connectCalled = false;
    const connect = async (): Promise<boolean> => {
      connectCalled = true;
      return true;
    };

    const result = await buildModelEndpointProbe(baseUrl as string | undefined, connect).check();

    expect(result.ok).toBe(false);
    expect(result.detail ?? '').toContain('CONDUIT_BASE_URL');
    // With no endpoint there is nothing to connect to.
    expect(connectCalled).toBe(false);
  });
});

// ===========================================================================
// GROUP B — doctor orchestration + run/listen pre-flight via main()
// ===========================================================================

function makeIO(): CliIO & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    out: (l: string) => lines.push(l),
    err: (l: string) => errors.push(l),
  };
}

const stubAdapter: ModelAdapter = {
  async call() {
    return { text: '{}', inputTokens: 1, outputTokens: 1, costUsd: 0 };
  },
};

const okListener = { alertChannels: {} } as unknown as Listener;

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

interface DepsOverride {
  prereqs?: PrereqProbe[];
  flowProbes?: (flow: FlowConfig) => PrereqProbe[];
  runEngine?: (args: RunEngineArgs) => Promise<void>;
  startListener?: (config: ListenerConfig) => Promise<StartListenerResult>;
}

function makeDeps(over: DepsOverride = {}): CliDeps {
  return {
    io,
    now: () => 1_000,
    db,
    adapter: stubAdapter,
    runEngine: over.runEngine ?? (async () => {}),
    prereqs: over.prereqs ?? [{ name: 'state-dir-writable', check: () => ({ ok: true }) }],
    flowProbes: over.flowProbes,
    startListener: over.startListener,
  };
}

describe('conduit doctor — flow-aware probe gating (AC1/AC2)', () => {
  it('with NO flow arg runs only the base volume+env probes', async () => {
    let flowProbesCalled = 0;
    const flowProbes = (_flow: FlowConfig): PrereqProbe[] => {
      flowProbesCalled++;
      return [
        { name: 'flow-prereqs-present', check: () => ({ ok: true }) },
        { name: 'model-endpoint-reachable', check: () => ({ ok: true }) },
      ];
    };
    const prereqs: PrereqProbe[] = [
      { name: 'state-dir-writable', check: () => ({ ok: true }) },
      { name: 'project-root-present', check: () => ({ ok: true }) },
    ];

    const code = await main(['doctor'], makeDeps({ prereqs, flowProbes }));

    expect(code).toBe(0);
    expect(flowProbesCalled).toBe(0); // flow-aware factory not invoked without a flow
    const printed = io.lines.join('\n');
    expect(printed).toContain('state-dir-writable');
    expect(printed).toContain('project-root-present');
    expect(printed).not.toContain('flow-prereqs-present');
    expect(printed).not.toContain('model-endpoint-reachable');
  });

  it('with a flow arg ALSO runs the flow-aware probes sourced from the loaded FlowConfig', async () => {
    let capturedFlow: FlowConfig | undefined;
    const flowProbes = (flow: FlowConfig): PrereqProbe[] => {
      capturedFlow = flow;
      return [
        { name: 'flow-prereqs-present', check: () => ({ ok: true }) },
        { name: 'model-endpoint-reachable', check: () => ({ ok: true }) },
      ];
    };
    const prereqs: PrereqProbe[] = [
      { name: 'state-dir-writable', check: () => ({ ok: true }) },
      { name: 'project-root-present', check: () => ({ ok: true }) },
    ];

    const flowPath = writeTempFlow(MINIMAL_FLOW_YAML);
    const code = await main(['doctor', flowPath], makeDeps({ prereqs, flowProbes }));

    expect(code).toBe(0);
    // The factory received the REAL loaded flow (its prerequisites come from WI-434).
    expect(capturedFlow?.prerequisites).toContain('ffmpeg');
    const printed = io.lines.join('\n');
    expect(printed).toContain('state-dir-writable');
    expect(printed).toContain('flow-prereqs-present');
    expect(printed).toContain('model-endpoint-reachable');
  });
});

describe('conduit doctor — base probes run even when the flow arg fails to load (AC10)', () => {
  it('still reports the base volume+env probes and exits non-zero on an invalid flow', async () => {
    const prereqs: PrereqProbe[] = [
      { name: 'state-dir-writable', check: () => ({ ok: true }) },
      { name: 'project-root-present', check: () => ({ ok: true }) },
    ];

    const invalidFlowPath = writeTempFlow(INVALID_FLOW_YAML);
    const code = await main(['doctor', invalidFlowPath], makeDeps({ prereqs }));

    // Invalid flow arg → non-zero, but the base probes must NOT be skipped: a
    // failed flow load cannot suppress the volume/env diagnostics the operator
    // needs (no early return before the probe loop).
    expect(code).not.toBe(0);
    const printed = io.lines.join('\n');
    expect(printed).toContain('state-dir-writable');
    expect(printed).toContain('project-root-present');
  });
});

describe('conduit doctor — per-probe reporting + aggregate exit code (AC10)', () => {
  it('reports every probe even after one fails, and exits non-zero', async () => {
    const prereqs: PrereqProbe[] = [
      { name: 'state-dir-writable', check: () => ({ ok: true }) },
      { name: 'project-root-present', check: () => ({ ok: false, detail: 'missing' }) },
      { name: 'third-probe', check: () => ({ ok: true }) },
    ];

    const code = await main(['doctor'], makeDeps({ prereqs }));

    expect(code).not.toBe(0); // any failure → non-zero
    const printed = io.lines.join('\n') + io.errors.join('\n');
    expect(printed).toContain('state-dir-writable');
    expect(printed).toContain('project-root-present');
    expect(printed).toContain('third-probe'); // NOT skipped on the earlier failure
  });

  it('exits zero only when every probe passes', async () => {
    const prereqs: PrereqProbe[] = [
      { name: 'state-dir-writable', check: () => ({ ok: true }) },
      { name: 'project-root-present', check: () => ({ ok: true }) },
    ];

    const code = await main(['doctor'], makeDeps({ prereqs }));

    expect(code).toBe(0);
  });
});

describe('conduit run — doctor pre-flight gate (AC11/FR-2)', () => {
  it('aborts before any engine dispatch and exits non-zero when a pre-flight probe fails', async () => {
    let engineCalled = false;
    const runEngine = async (): Promise<void> => {
      engineCalled = true;
    };
    const prereqs: PrereqProbe[] = [
      { name: 'state-dir-writable', check: () => ({ ok: false, detail: 'read-only volume' }) },
    ];

    const flowPath = writeTempFlow(MINIMAL_FLOW_YAML);
    const code = await main(['run', flowPath], makeDeps({ prereqs, runEngine }));

    expect(code).not.toBe(0);
    expect(engineCalled).toBe(false); // no dispatch when pre-flight fails
  });
});

describe('conduit listen — doctor pre-flight gate (AC12/FR-2)', () => {
  it('does not boot the listener and exits non-zero when a pre-flight probe fails', async () => {
    let listenerStarted = false;
    const startListener = async (): Promise<StartListenerResult> => {
      listenerStarted = true;
      return { ok: true, listener: okListener };
    };
    const prereqs: PrereqProbe[] = [
      { name: 'state-dir-writable', check: () => ({ ok: false, detail: 'read-only volume' }) },
    ];

    const code = await main(
      ['listen', '--flows', 'myflow=/flows/my.yaml'],
      makeDeps({ prereqs, startListener }),
    );

    expect(code).not.toBe(0);
    expect(listenerStarted).toBe(false); // no boot when pre-flight fails
  });
});

describe('buildProcessContainmentProbe — containment mechanism (issue #77)', () => {
  it('reports cgroup containment and passes', async () => {
    const probe = buildProcessContainmentProbe(async () => ({ mechanism: 'cgroup', parent: '/sys/fs/cgroup/app.slice' }));
    expect(probe.name).toBe('process-containment');
    expect(await probe.check()).toEqual({
      ok: true,
      detail: 'cgroup v2, one cgroup per invocation under /sys/fs/cgroup/app.slice',
    });
  });

  it('passes on the process-group fallback but warns with the reason', async () => {
    const probe = buildProcessContainmentProbe(async () => ({
      mechanism: 'process-group',
      reason: 'cannot create a cgroup under /sys/fs/cgroup (EROFS)',
    }));
    const result = await probe.check();
    expect(result.ok).toBe(true);
    expect(result.detail).toStartWith('warning: process group only (cannot create a cgroup under /sys/fs/cgroup (EROFS))');
  });
});
