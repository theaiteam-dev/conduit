/**
 * Tests for the worker subprocess entry (src/worker/worker-entry.ts).
 *
 * Drives runWorkerProcess through injected IO seams (no real subprocess): a
 * START_WORK in → the deterministic station runs → exactly one MARK_DONE out,
 * then self-exit. Also pins the fail-closed paths (bad flow, non-runnable
 * station) and the NFR-3 property that the worker module imports no state DB.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { runWorkerProcess, type WorkerProcessIO } from './worker-entry';
import { serializeWorkerMessage, parseWorkerMessage } from './ipc-protocol';
import type { WorkerMessage } from './ipc-protocol';
import {
  CONTAINMENT_FIXTURE,
  containmentFixtureExitArgs,
  expectGrandchildReaped,
  killRecordedGrandchild,
} from './harness-containment.conformance';

// ---------------------------------------------------------------------------
// Harness: a controllable IO seam capturing sends/exits and feeding raw input.
// ---------------------------------------------------------------------------

function makeIO() {
  let handler: ((raw: unknown) => void) | null = null;
  const sent: WorkerMessage[] = [];
  const errs: string[] = [];
  let exitCode: number | null = null;
  const io: WorkerProcessIO = {
    onMessage: (h) => {
      handler = h;
    },
    send: (raw) => {
      const parsed = parseWorkerMessage(raw);
      if (parsed.ok) sent.push(parsed.message);
    },
    err: (line) => errs.push(line),
    timers: {
      // Heartbeats are not asserted here; a no-op interval keeps the body simple.
      setInterval: () => 0,
      clearInterval: () => {},
    },
    exit: (code) => {
      exitCode = code;
    },
  };
  return {
    io,
    sent,
    errs,
    deliver: (raw: string) => handler?.(raw),
    get exitCode() {
      return exitCode;
    },
  };
}

const FLOW = `
flow: worker-entry-test
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 1000 }
  per_card: { max_execution_attempts: 2 }
  liveness: { no_progress_minutes: 3 }
defaults: { cap_policy: scrap, on_dep_scrap: hold }
terminal_lanes: [done, scrap, hold]
security:
  bash:
    allow: ["true", "false"]
stations:
  - id: ok
    worker: { kind: deterministic, command: "true" }
    next: done
  - id: bad
    worker: { kind: deterministic, command: "false" }
    next: done
`;

let dir: string;
let flowPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conduit-worker-'));
  flowPath = join(dir, 'flow.yaml');
  writeFileSync(flowPath, FLOW);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function start(cardId: string, station: string, attempt = 0): string {
  return serializeWorkerMessage({ type: 'START_WORK', cardId, station, attempt, inputRefs: [] });
}

describe('runWorkerProcess — runs a deterministic station and reports MARK_DONE', () => {
  it('reports success for a station whose command exits 0, echoing the attempt', async () => {
    const h = makeIO();
    runWorkerProcess({ flowPath, projectRoot: dir }, h.io);
    h.deliver(start('c1', 'ok', 3));
    // The command runs async (Bun.spawn); let it settle.
    await new Promise((r) => setTimeout(r, 50));

    expect(h.sent).toHaveLength(1);
    const done = h.sent[0]!;
    expect(done.type).toBe('MARK_DONE');
    if (done.type !== 'MARK_DONE') throw new Error('wrong variant');
    expect(done.outcome).toBe('success');
    expect(done.cardId).toBe('c1');
    expect(done.attempt).toBe(3); // echoed from START_WORK
    expect(done.usage).toEqual({ tokens: 0 }); // deterministic → no model spend
    expect(h.exitCode).toBe(0); // one-shot self-exit
  });

  it("reports 'failed' with diagnostic detail when the command exits non-zero (the original deterministic failure-reporting work: the KERNEL applies the attempt cap)", async () => {
    const h = makeIO();
    runWorkerProcess({ flowPath, projectRoot: dir }, h.io);
    h.deliver(start('c1', 'bad'));
    await new Promise((r) => setTimeout(r, 50));

    const done = h.sent[0]!;
    if (done.type !== 'MARK_DONE') throw new Error('wrong variant');
    // NOT a terminal 'scrap' verdict: the worker reports the failure and the
    // kernel decides retry-vs-scrap against per_card.max_execution_attempts,
    // matching the synchronous path's count-and-retry semantics.
    expect(done.outcome).toBe('failed');
    expect(done.failure?.exitCode).toBe(1);
  });

  it('scraps fail-closed when the station is not a runnable deterministic station', async () => {
    const h = makeIO();
    runWorkerProcess({ flowPath, projectRoot: dir }, h.io);
    h.deliver(start('c1', 'does-not-exist'));
    await new Promise((r) => setTimeout(r, 50));

    const done = h.sent[0]!;
    if (done.type !== 'MARK_DONE') throw new Error('wrong variant');
    expect(done.outcome).toBe('scrap');
  });

  it('ignores a malformed IPC payload without throwing', () => {
    const h = makeIO();
    runWorkerProcess({ flowPath, projectRoot: dir }, h.io);
    h.deliver('not json');
    expect(h.sent).toHaveLength(0);
    expect(h.errs.some((e) => e.includes('rejected IPC'))).toBe(true);
  });

  it('replies scrap to every START_WORK when the flow fails to load (fail-closed)', () => {
    const h = makeIO();
    runWorkerProcess({ flowPath: join(dir, 'nonexistent.yaml'), projectRoot: dir }, h.io);
    h.deliver(start('c1', 'ok'));
    expect(h.sent).toHaveLength(1);
    const done = h.sent[0]!;
    if (done.type !== 'MARK_DONE') throw new Error('wrong variant');
    expect(done.outcome).toBe('scrap');
    expect(h.exitCode).toBe(0);
  });
});

describe('worker-entry — PATCH 2: pooled deterministic station gets per-card env', () => {
  // The pool path must inject the SAME CONDUIT_REWORK_COUNT/CONDUIT_ATTEMPT the
  // synchronous executor path does, sourced from START_WORK. Without this a
  // plain-pure deterministic station (which is pool-eligible) would see these
  // vars only at concurrency=1 and get empty strings under `--concurrency K>1`,
  // silently breaking a verdict station's reviewer-flag-at-cap logic.
  function writeEnvFlow(outFile: string): string {
    const script = join(dir, 'echo-env.sh');
    // Emit the injected vars as JSON to a file the test reads back.
    writeFileSync(
      script,
      `#!/bin/sh\nprintf '{"rework":"%s","attempt":"%s"}' "$CONDUIT_REWORK_COUNT" "$CONDUIT_ATTEMPT" > "${outFile}"\n`,
    );
    // Executable bit so the script itself can be the allowlisted command.
    require('node:fs').chmodSync(script, 0o755);
    const yaml = `
flow: worker-entry-env-test
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 1000 }
  per_card: { max_execution_attempts: 4 }
  liveness: { no_progress_minutes: 3 }
defaults: { cap_policy: scrap, on_dep_scrap: hold }
terminal_lanes: [done, scrap, hold]
security:
  bash:
    allow: ["${script}"]
stations:
  - id: gen
    worker: { kind: deterministic, command: "${script}" }
    next: done
`;
    const p = join(dir, 'env-flow.yaml');
    writeFileSync(p, yaml);
    return p;
  }

  it('injects the START_WORK reworkCount/attempt into the spawned command env', async () => {
    const outFile = join(dir, 'seen.json');
    const envFlow = writeEnvFlow(outFile);
    const h = makeIO();
    runWorkerProcess({ flowPath: envFlow, projectRoot: dir }, h.io);
    // Non-zero, non-default values a hard-coded constant could never fake.
    h.deliver(serializeWorkerMessage({ type: 'START_WORK', cardId: 'c1', station: 'gen', attempt: 2, reworkCount: 3, inputRefs: [] }));
    await new Promise((r) => setTimeout(r, 50));

    const done = h.sent[0]!;
    if (done.type !== 'MARK_DONE') throw new Error('wrong variant');
    expect(done.outcome).toBe('success');
    const seen = JSON.parse(require('node:fs').readFileSync(outFile, 'utf-8'));
    expect(seen.rework).toBe('3');
    expect(seen.attempt).toBe('2');
  });

  it('coalesces a missing reworkCount to "0" (optional field on the message)', async () => {
    const outFile = join(dir, 'seen0.json');
    const envFlow = writeEnvFlow(outFile);
    const h = makeIO();
    runWorkerProcess({ flowPath: envFlow, projectRoot: dir }, h.io);
    // No reworkCount on the message → consumer defaults to 0.
    h.deliver(serializeWorkerMessage({ type: 'START_WORK', cardId: 'c1', station: 'gen', attempt: 0, inputRefs: [] }));
    await new Promise((r) => setTimeout(r, 50));

    const seen = JSON.parse(require('node:fs').readFileSync(outFile, 'utf-8'));
    expect(seen.rework).toBe('0');
    expect(seen.attempt).toBe('0');
  });
});

describe('worker-entry #17: a pooled deterministic station reaps its descendants on exit 0', () => {
  afterEach(() => {
    killRecordedGrandchild(dir);
  });

  it('reports success and leaves no backgrounded grandchild running', async () => {
    // The containment fixture backgrounds a grandchild that touches a sentinel,
    // waits for its first touch, then exits 0. It writes into its cwd, which
    // the worker sets to the project root.
    const args = [CONTAINMENT_FIXTURE, ...containmentFixtureExitArgs(0)].map((a) => JSON.stringify(a));
    const reapFlow = join(dir, 'reap-flow.yaml');
    writeFileSync(
      reapFlow,
      `
flow: worker-entry-reap-test
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 1000 }
  per_card: { max_execution_attempts: 1 }
  liveness: { no_progress_minutes: 3 }
defaults: { cap_policy: scrap, on_dep_scrap: hold }
terminal_lanes: [done, scrap, hold]
security:
  bash:
    allow: ["sh"]
stations:
  - id: spawner
    worker: { kind: deterministic, command: "sh", args: [${args.join(', ')}] }
    next: done
`,
    );
    const h = makeIO();
    runWorkerProcess({ flowPath: reapFlow, projectRoot: dir }, h.io);
    h.deliver(start('c1', 'spawner'));

    const deadline = Date.now() + 10_000;
    while (h.sent.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }

    const done = h.sent[0];
    if (done?.type !== 'MARK_DONE') throw new Error('expected a MARK_DONE');
    expect(done.outcome).toBe('success');
    await expectGrandchildReaped(dir);
  }, 20_000);
});

describe('worker-entry — NFR-3: the worker module does no state-DB I/O', () => {
  it('does not import the persistence DB module', async () => {
    // Static guard: the worker entry must never pull in the state DB (the kernel
    // is the sole writer). Read the source and assert it imports nothing from
    // ../persistence — a real check, not just "the function exists".
    const src = await Bun.file(new URL('./worker-entry.ts', import.meta.url)).text();
    expect(src).not.toContain('persistence/db');
    expect(src).not.toMatch(/from '\.\.\/persistence/);
  });
});
