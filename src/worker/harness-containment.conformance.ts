/**
 * Containment conformance suite (issue #27, NFR-Security-6).
 *
 * Every spawn path that runs a worker process must kill that worker's whole
 * process tree on timeout, so a grandchild the worker backgrounded (a shell, a
 * browser, a language server) does not outlive the invocation. The guarantee
 * is implemented in `runHarnessProcess` (./harness-runner.ts) and proved there
 * by the runner's own AC3 test. That test calls the runner directly, so an
 * adapter that spawns some other way would drop the guarantee without anything
 * going red. This suite is the contract each spawn path must pass instead: it
 * drives the path's real spawn and kill, not the runner.
 *
 * Each spawn path's own test file calls one of the two exported functions:
 *
 *   describeHarnessContainmentConformance('claude-headless', (opts) =>
 *     createClaudeHarnessAdapter({ ...opts, envAllowlist: [] }));
 *
 *   describeContainmentConformance('deterministic', runViaDeterministic, {...});
 *
 * `harness-containment-registry.test.ts` fails when an adapter in the shipped
 * factory map has no `describeHarnessContainmentConformance` call.
 *
 * The fixture (./containment-fixture.sh) stands in for the binary. It
 * backgrounds a grandchild that records its pid and touches a sentinel file
 * every 100ms, then blocks. The suite proves the grandchild died two ways: the
 * pid is gone, and the sentinel mtime stops advancing. The second check does
 * not depend on the pid, so a recycled pid cannot make a surviving grandchild
 * look dead.
 *
 * This file is not a test file itself. Bun only runs it through the calls in
 * the `*.test.ts` files.
 */
import { describe, it, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessAdapter } from './harness-adapter';

/** Absolute path of the stand-in binary every conformance call spawns. */
export const CONTAINMENT_FIXTURE = join(import.meta.dir, 'containment-fixture.sh');

/** Files the fixture writes into its working directory. */
const PID_FILE = 'containment.pid';
const SENTINEL_FILE = 'containment.sentinel';

/**
 * Timing. The invocation timeout leaves room for a loaded CI box to start the
 * fixture and let the grandchild touch the sentinel at least twice before the
 * kill. The reap budget and the stall window are generous for the same reason.
 */
const TIMEOUT_MS = 1_000;
const REAP_BUDGET_MS = 3_000;
/** Five sentinel intervals: a live grandchild always advances the mtime in this window. */
const STALL_WINDOW_MS = 500;
const TEST_TIMEOUT_MS = 20_000;

/** What a spawn path receives for one conformance run. */
export interface ContainmentRun {
  /** Fresh directory per test. The spawn path must run the fixture with this as its cwd. */
  projectRoot: string;
  /** The binary to spawn: always CONTAINMENT_FIXTURE. */
  fixture: string;
  /** Wall-clock bound to pass to the spawn path's own timeout mechanism. */
  timeoutMs: number;
}

/**
 * Launch the fixture through a spawn path's production spawn and kill, wait
 * for the path to report back, and return the classification it gave the
 * timeout: an adapter's error `code`, or whatever label the path uses. Return
 * undefined when the path reported no timeout at all.
 */
export type ContainmentSpawnPath = (run: ContainmentRun) => Promise<string | undefined>;

export interface ContainmentConformanceOptions {
  /** The classification the spawn path must report for a timed-out invocation. */
  timeoutClass: string;
  /**
   * Set when the path is known not to reap descendants yet, naming the open
   * issue(s). The reaping test is then registered with `test.failing`: it
   * reports as passing while the bug stands, and turns red the moment the
   * path is fixed, so the marker has to be removed rather than left behind.
   * A separate normal test still pins the timeout class and the fixture, so a
   * broken fixture cannot hide behind the inverted test.
   */
  knownLeak?: string;
}

/** True while `pid` exists (signal 0 checks for existence without delivering a signal). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** Poll until `pid` is gone or the budget elapses; returns whether it died. */
async function waitForPidGone(pid: number, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(25);
  }
  return !isAlive(pid);
}

function sentinelMtime(projectRoot: string): number | undefined {
  try {
    return statSync(join(projectRoot, SENTINEL_FILE)).mtimeMs;
  } catch {
    return undefined;
  }
}

function recordedPid(projectRoot: string): number | undefined {
  const path = join(projectRoot, PID_FILE);
  if (!existsSync(path)) return undefined;
  const pid = Number(readFileSync(path, 'utf-8').trim());
  return Number.isInteger(pid) && pid > 1 ? pid : undefined;
}

/**
 * Watch the sentinel while the invocation runs and resolve true once its mtime
 * has advanced, proving the grandchild was alive and touching it. Resolves
 * false if the invocation settles first without an advance being seen.
 */
async function watchSentinelAdvance(projectRoot: string, settled: () => boolean): Promise<boolean> {
  let first: number | undefined;
  while (!settled()) {
    const now = sentinelMtime(projectRoot);
    if (now !== undefined) {
      if (first === undefined) first = now;
      else if (now !== first) return true;
    }
    await sleep(20);
  }
  return false;
}

interface ObservedRun {
  timeoutClass: string | undefined;
  /** The sentinel advanced while the invocation was running. */
  sawGrandchildLive: boolean;
  grandchildPid: number | undefined;
}

async function runAndObserve(spawnPath: ContainmentSpawnPath, projectRoot: string): Promise<ObservedRun> {
  let done = false;
  const invocation = spawnPath({ projectRoot, fixture: CONTAINMENT_FIXTURE, timeoutMs: TIMEOUT_MS }).finally(
    () => {
      done = true;
    },
  );
  const [timeoutClass, sawGrandchildLive] = await Promise.all([
    invocation,
    watchSentinelAdvance(projectRoot, () => done),
  ]);
  return { timeoutClass, sawGrandchildLive, grandchildPid: recordedPid(projectRoot) };
}

/**
 * Register the containment conformance tests for one spawn path. Use
 * `describeHarnessContainmentConformance` for a harness adapter.
 */
export function describeContainmentConformance(
  name: string,
  spawnPath: ContainmentSpawnPath,
  options: ContainmentConformanceOptions,
): void {
  describe(`containment conformance: ${name}`, () => {
    let projectRoot: string;

    beforeEach(() => {
      projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'conduit-containment-')));
    });

    afterEach(() => {
      // Kill a grandchild the spawn path failed to reap, so a failing test
      // does not leave the fixture's loop running in the developer's session.
      // Only the recorded pid: when the path did not detach the worker, the
      // grandchild shares the test runner's process group, so a group kill
      // here would take the runner down with it.
      const pid = recordedPid(projectRoot);
      if (pid !== undefined) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* already gone: the expected case */
        }
      }
      rmSync(projectRoot, { recursive: true, force: true });
    });

    const reaps = options.knownLeak !== undefined ? test.failing : it;

    if (options.knownLeak !== undefined) {
      it(
        `reports '${options.timeoutClass}' and the fixture grandchild runs (pinned while ${options.knownLeak} is open)`,
        async () => {
          const run = await runAndObserve(spawnPath, projectRoot);
          expect(run.timeoutClass).toBe(options.timeoutClass);
          expect(run.sawGrandchildLive).toBe(true);
          expect(run.grandchildPid).toBeDefined();
        },
        TEST_TIMEOUT_MS,
      );
    }

    reaps(
      `reports '${options.timeoutClass}' and kills a backgrounded grandchild on timeout`,
      async () => {
        const run = await runAndObserve(spawnPath, projectRoot);

        expect(run.timeoutClass).toBe(options.timeoutClass);
        // The grandchild was running before the kill. Without this, a stalled
        // sentinel below could mean the fixture never started.
        expect(run.sawGrandchildLive).toBe(true);
        expect(run.grandchildPid).toBeDefined();

        // Proof one: the recorded pid disappears.
        expect(await waitForPidGone(run.grandchildPid!, REAP_BUDGET_MS)).toBe(true);

        // Proof two: the sentinel stops advancing. A live grandchild touches
        // it every 100ms, so an unchanged mtime across the window means
        // nothing is left running the loop, whatever the pid now refers to.
        const before = sentinelMtime(projectRoot);
        await sleep(STALL_WINDOW_MS);
        expect(sentinelMtime(projectRoot)).toBe(before);
      },
      TEST_TIMEOUT_MS,
    );
  });
}

/** What the adapter factory receives: the only two values the suite controls. */
export interface HarnessContainmentFactoryOptions {
  projectRoot: string;
  /** The binary seam (e.g. `ClaudeHarnessAdapterConfig.command`): always CONTAINMENT_FIXTURE. */
  command: string;
}

/**
 * The classification a harness adapter spawn path must report for a
 * timed-out invocation. Shared by `harnessAdapterSpawnPath` and the
 * `timeoutClass` passed to `describeContainmentConformance` so the two
 * cannot drift apart.
 */
export const HARNESS_TIMEOUT_CLASS = 'harness-timeout';

/**
 * Build the `ContainmentSpawnPath` for one shipped harness adapter: construct
 * it through the factory, invoke it, and report the timeout classification.
 *
 * Only a throw whose `code` is exactly `HARNESS_TIMEOUT_CLASS` is the timeout
 * report this suite is checking for. Anything else, including a throw with no
 * `code` at all, is a different failure (a binary-probe error, a bad config,
 * a bug in the factory or the invocation) and is rethrown unchanged: folding
 * it into `undefined` would report it as "no timeout happened" and swallow
 * the original error and its stack.
 */
export function harnessAdapterSpawnPath(
  name: string,
  factory: (opts: HarnessContainmentFactoryOptions) => HarnessAdapter,
): ContainmentSpawnPath {
  return async ({ projectRoot, fixture, timeoutMs }) => {
    const adapter = factory({ projectRoot, command: fixture });
    expect(adapter.name).toBe(name);
    try {
      await adapter.invoke({ prompt: 'containment conformance', inputs: [], tools: [], timeoutMs });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === HARNESS_TIMEOUT_CLASS) return code;
      throw err;
    }
    return undefined;
  };
}

/**
 * Register the containment conformance tests for one shipped harness adapter.
 *
 * The factory must build the adapter through its production spawn path with
 * `command` as the binary. The suite invokes it with a short timeout and
 * requires the adapter to reject with code `harness-timeout`. It also checks
 * that the adapter's `name` matches `name`, which is the key the registry test
 * looks for, so a call cannot cover one adapter under another's name.
 */
export function describeHarnessContainmentConformance(
  name: string,
  factory: (opts: HarnessContainmentFactoryOptions) => HarnessAdapter,
): void {
  describeContainmentConformance(name, harnessAdapterSpawnPath(name, factory), {
    timeoutClass: HARNESS_TIMEOUT_CLASS,
  });
}
