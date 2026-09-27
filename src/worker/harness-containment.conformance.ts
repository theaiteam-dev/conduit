/**
 * Containment conformance suite (issue #27, NFR-Security-6).
 *
 * Every spawn path that runs a worker process must kill that worker's whole
 * process tree on timeout, so a grandchild the worker backgrounded (a shell, a
 * browser, a language server) does not outlive the invocation. A spawn path
 * that opts in with `reapsOnExit` must also kill it when the worker exits on
 * its own, with status 0 or nonzero (issue #17). The guarantee
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
 * The fixture (./containment-fixture.sh) stands in for the binary. It starts
 * two grandchildren that each record a pid and touch a sentinel file every
 * 100ms, then blocks, or exits with a given code when run with
 * `--exit <code>`. One is backgrounded with a plain `( ... ) &` and stays in
 * the fixture's process group. The other is started with `setsid`, as Claude
 * Code's Bash tool starts every command (issue #77), so a process-group kill
 * cannot reach it. The suite proves each grandchild died two ways: the pid is
 * gone, and the sentinel mtime stops advancing. The second check does not
 * depend on the pid, so a recycled pid cannot make a surviving grandchild look
 * dead.
 *
 * The setsid grandchild can only be killed through a cgroup
 * (./cgroup-containment.ts). The suite requires it dead wherever the runners
 * use cgroup containment, and everywhere when
 * CONDUIT_REQUIRE_CGROUP_CONTAINMENT=1, which CI sets so a host that lost the
 * mechanism fails rather than skips. On any other host the setsid assertions
 * are registered as skipped tests that name the reason.
 *
 * This file is not a test file itself. Bun only runs it through the calls in
 * the `*.test.ts` files.
 */
import { describe, it, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessAdapter } from './harness-adapter';
import { resolveContainment, type Containment } from './cgroup-containment';

/** Absolute path of the stand-in binary every conformance call spawns. */
export const CONTAINMENT_FIXTURE = join(import.meta.dir, 'containment-fixture.sh');

/** Files the fixture writes into its working directory. */
const PID_FILE = 'containment.pid';
const SENTINEL_FILE = 'containment.sentinel';
const SETSID_PID_FILE = 'containment.setsid.pid';
const SETSID_SENTINEL_FILE = 'containment.setsid.sentinel';

/** The fixture's two grandchildren: the pid file and sentinel each one writes. */
const GRANDCHILDREN = [
  { label: 'backgrounded grandchild', pidFile: PID_FILE, sentinel: SENTINEL_FILE },
  { label: 'setsid grandchild', pidFile: SETSID_PID_FILE, sentinel: SETSID_SENTINEL_FILE },
] as const;

/** The containment the runners resolve on this host, through the same resolver. */
export const hostContainment: Containment = await resolveContainment();

/**
 * Whether the suite requires the setsid grandchild to die. False only on a
 * host without cgroup containment that CI has not told to insist on it.
 */
export const requiresSetsidContainment =
  hostContainment.mechanism === 'cgroup' || process.env.CONDUIT_REQUIRE_CGROUP_CONTAINMENT === '1';

/** The grandchildren every reaping assertion covers on this host. */
const REQUIRED_GRANDCHILDREN = requiresSetsidContainment ? GRANDCHILDREN : GRANDCHILDREN.slice(0, 1);

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
  /**
   * Arguments for the fixture. Empty for the timeout scenario. The exit
   * scenarios, registered only with `reapsOnExit`, pass `--exit <code>`, so a
   * spawn path that opts in must hand these to the fixture unchanged.
   */
  fixtureArgs: string[];
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
   * issue(s). The reaping tests are then registered with `test.failing`: they
   * report as passing while the bug stands, and turn red the moment the path
   * is fixed, so the marker has to be removed rather than left behind. A
   * separate normal test still pins the timeout class and the fixture, so a
   * broken fixture cannot hide behind the inverted test. No shipped path sets
   * it today; it is kept so a new spawn path can be registered before its fix.
   */
  knownLeak?: string;
  /**
   * Also register the exit scenarios: the fixture backgrounds its grandchild
   * and exits 0, or exits nonzero, well before the timeout. The spawn path
   * must return without reporting a timeout and the grandchild must be gone.
   * Opt-in because it requires the path to pass `fixtureArgs` through, and a
   * harness adapter builds its own argv and treats a nonzero exit as an error.
   */
  reapsOnExit?: boolean;
}

/**
 * The wall-clock bound for the exit scenarios. The fixture exits on its own
 * long before this, so a path that takes this long waited on its timeout
 * instead of returning when the worker exited. The elapsed-time check uses
 * this bound, not a tighter one, so a loaded CI host cannot fail it.
 */
const EXIT_SCENARIO_TIMEOUT_MS = 10_000;

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

function sentinelMtime(projectRoot: string, sentinel: string = SENTINEL_FILE): number | undefined {
  try {
    return statSync(join(projectRoot, sentinel)).mtimeMs;
  } catch {
    return undefined;
  }
}

function readPidFile(projectRoot: string, pidFile: string): number | undefined {
  const path = join(projectRoot, pidFile);
  if (!existsSync(path)) return undefined;
  const pid = Number(readFileSync(path, 'utf-8').trim());
  return Number.isInteger(pid) && pid > 1 ? pid : undefined;
}

/**
 * The backgrounded grandchild's pid the fixture recorded in `projectRoot`, if
 * it got that far. It is written first, so its presence means the fixture is
 * running.
 */
export function recordedPid(projectRoot: string): number | undefined {
  return readPidFile(projectRoot, PID_FILE);
}

/** The setsid grandchild's pid the fixture recorded in `projectRoot`, if it got that far. */
export function recordedSetsidPid(projectRoot: string): number | undefined {
  return readPidFile(projectRoot, SETSID_PID_FILE);
}

/**
 * The session id of `pid`, read from /proc (Linux). Undefined when the process
 * is gone or /proc is unavailable.
 */
function sessionId(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
    // Fields after the parenthesised comm: state ppid pgrp session ...
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const sid = Number(fields[3]);
    return Number.isInteger(sid) ? sid : undefined;
  } catch {
    return undefined;
  }
}

/** What `watchSentinelAdvance` observed while the invocation was still running. */
interface SentinelWatch {
  /**
   * Every required grandchild's sentinel mtime advanced at least once,
   * proving each grandchild was alive and touching it. False if the
   * invocation settled first without every advance being seen.
   */
  advanced: boolean;
  /**
   * The setsid grandchild's session id, read from /proc the first time it
   * came back defined during the loop, i.e. while the grandchild was
   * confirmed still running (before any kill the spawn path issues on its
   * way to settling `invocation`). Undefined if it was never readable during
   * the loop, or read but never resolved to a defined sid.
   */
  setsidSidWhileRunning: number | undefined;
  /**
   * Whether the setsid grandchild's pid file was readable at least once
   * during the loop. False only means the invocation settled before the
   * loop's first poll, so nothing about the grandchild was observed while it
   * ran; that is the one case genuinely ambiguous about its session, as
   * opposed to a pid that was readable but never yielded a sid.
   */
  setsidPidReadableWhileRunning: boolean;
}

/**
 * Watch every grandchild's sentinel while the invocation runs, and along the
 * way sample the setsid grandchild's session id so the anti-drift check below
 * reads it while the process is known to still be alive rather than after the
 * spawn path may already have killed it.
 */
async function watchSentinelAdvance(projectRoot: string, settled: () => boolean): Promise<SentinelWatch> {
  const first = new Map<string, number>();
  const advanced = new Set<string>();
  let setsidSidWhileRunning: number | undefined;
  let setsidPidReadableWhileRunning = false;
  while (!settled()) {
    for (const { sentinel } of REQUIRED_GRANDCHILDREN) {
      const now = sentinelMtime(projectRoot, sentinel);
      if (now === undefined) continue;
      const seen = first.get(sentinel);
      if (seen === undefined) first.set(sentinel, now);
      else if (now !== seen) advanced.add(sentinel);
    }
    if (setsidSidWhileRunning === undefined) {
      const pid = recordedSetsidPid(projectRoot);
      if (pid !== undefined) {
        setsidPidReadableWhileRunning = true;
        setsidSidWhileRunning = sessionId(pid);
      }
    }
    if (advanced.size === REQUIRED_GRANDCHILDREN.length) {
      return { advanced: true, setsidSidWhileRunning, setsidPidReadableWhileRunning };
    }
    await sleep(20);
  }
  return { advanced: false, setsidSidWhileRunning, setsidPidReadableWhileRunning };
}

/** The fixture arguments that make it exit with `code` once its grandchild is running. */
export function containmentFixtureExitArgs(code: number): string[] {
  return ['--exit', String(code)];
}

/**
 * SIGKILL the grandchildren recorded in `projectRoot`, for an afterEach, so a
 * failing test does not leave the fixture's loops running in the developer's
 * session. Only the recorded pids: when the path did not detach the worker,
 * the backgrounded grandchild shares the test runner's process group, so a
 * group kill here would take the runner down with it.
 */
export function killRecordedGrandchild(projectRoot: string): void {
  for (const { pidFile } of GRANDCHILDREN) {
    const pid = readPidFile(projectRoot, pidFile);
    if (pid === undefined) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone: the expected case */
    }
  }
}

/**
 * Assert that the fixture's grandchildren in `projectRoot` are dead, each two
 * ways: the recorded pid disappears, and the sentinel stops advancing. A live
 * grandchild touches its sentinel every 100ms, so an unchanged mtime across
 * the window means nothing is left running the loop, whatever the pid now
 * refers to. Covers the setsid grandchild wherever `requiresSetsidContainment`
 * holds, and the backgrounded one everywhere.
 */
export async function expectGrandchildReaped(projectRoot: string): Promise<void> {
  await expectReaped(projectRoot, REQUIRED_GRANDCHILDREN);
}

/**
 * Assert that only the backgrounded grandchild is dead. For tests of the
 * process-group fallback, which cannot kill the setsid grandchild.
 */
export async function expectBackgroundedGrandchildReaped(projectRoot: string): Promise<void> {
  await expectReaped(projectRoot, GRANDCHILDREN.slice(0, 1));
}

async function expectReaped(
  projectRoot: string,
  grandchildren: ReadonlyArray<(typeof GRANDCHILDREN)[number]>,
): Promise<void> {
  for (const { label, pidFile } of grandchildren) {
    const pid = readPidFile(projectRoot, pidFile);
    expect(pid, `${label}: no pid recorded`).toBeDefined();
    expect(await waitForPidGone(pid!, REAP_BUDGET_MS), `${label} (pid ${pid}) is still running`).toBe(true);
  }

  const before = grandchildren.map(({ sentinel }) => sentinelMtime(projectRoot, sentinel));
  await sleep(STALL_WINDOW_MS);
  grandchildren.forEach(({ label, sentinel }, i) => {
    expect(sentinelMtime(projectRoot, sentinel), `${label}: sentinel still advancing`).toBe(before[i]);
  });
}

interface ObservedRun {
  timeoutClass: string | undefined;
  /** Every grandchild's sentinel advanced while the invocation was running. */
  sawGrandchildLive: boolean;
  grandchildPid: number | undefined;
  /**
   * The setsid grandchild's pid the fixture recorded, read any time (the pid
   * file outlives the process, so this also answers the fixture started it).
   */
  setsidPid: number | undefined;
  /**
   * The setsid grandchild's session id, sampled inside the watch loop while
   * the invocation was still running. Equal to its pid when it leads its own
   * session, which is what makes it escape a process-group kill. Undefined
   * either because the pid was never readable while running (see
   * `setsidPidReadableWhileRunning`) or because it was readable but /proc
   * never resolved a session id for it.
   */
  setsidSidWhileRunning: number | undefined;
  /**
   * Whether the setsid grandchild's pid file was readable at least once
   * while the invocation was still running. False means the invocation
   * settled before the watch loop ever polled, so nothing about the
   * grandchild's session was observed in time: the one genuinely ambiguous
   * case, as opposed to a pid that was readable but never yielded a sid.
   */
  setsidPidReadableWhileRunning: boolean;
}

async function runAndObserve(spawnPath: ContainmentSpawnPath, projectRoot: string): Promise<ObservedRun> {
  let done = false;
  const invocation = spawnPath({
    projectRoot,
    fixture: CONTAINMENT_FIXTURE,
    timeoutMs: TIMEOUT_MS,
    fixtureArgs: [],
  }).finally(
    () => {
      done = true;
    },
  );
  const [timeoutClass, watch] = await Promise.all([invocation, watchSentinelAdvance(projectRoot, () => done)]);
  return {
    timeoutClass,
    sawGrandchildLive: watch.advanced,
    grandchildPid: recordedPid(projectRoot),
    setsidPid: recordedSetsidPid(projectRoot),
    setsidSidWhileRunning: watch.setsidSidWhileRunning,
    setsidPidReadableWhileRunning: watch.setsidPidReadableWhileRunning,
  };
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
      killRecordedGrandchild(projectRoot);
      rmSync(projectRoot, { recursive: true, force: true });
    });

    const reaps = options.knownLeak !== undefined ? test.failing : it;

    if (!requiresSetsidContainment && hostContainment.mechanism !== 'cgroup') {
      // Visible in the run's skip count, naming why this host cannot prove it.
      it.skip(`kills a grandchild that called setsid (host has no cgroup containment: ${hostContainment.reason})`, () => {});
    }

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
        // Both grandchildren were running before the kill. Without this, a
        // stalled sentinel below could mean the fixture never started.
        expect(run.sawGrandchildLive).toBe(true);
        expect(run.grandchildPid).toBeDefined();
        // The setsid grandchild really left the fixture's session. Without
        // this, the fixture could stop modelling the escape and the suite
        // would still pass.
        if (requiresSetsidContainment) {
          // The fixture did start it, whether or not the watch loop caught
          // it while it ran (the pid file outlives the process).
          expect(run.setsidPid, 'setsid grandchild: no pid recorded').toBeDefined();
          const setsidPid = run.setsidPid!;
          if (run.setsidSidWhileRunning !== undefined) {
            expect(run.setsidSidWhileRunning).toBe(setsidPid);
          } else if (run.setsidPidReadableWhileRunning) {
            // Its pid was readable at least once while it was still
            // running, so we had a real chance to read its session and
            // never got one. That is not the same as the invocation
            // settling before our first poll (handled below), so it does
            // not get the benefit of the doubt.
            expect(
              run.setsidSidWhileRunning,
              'setsid grandchild: pid was readable while the invocation ran, but its session id was never read (expected it to equal its pid)',
            ).toBeDefined();
          }
          // Else: the invocation settled before the watch loop's first poll,
          // so nothing about the grandchild's session was observed in time.
          // Genuinely ambiguous; the pid-recorded assertion above still holds
          // it accountable for having started at all.
        }

        await expectGrandchildReaped(projectRoot);
      },
      TEST_TIMEOUT_MS,
    );

    if (options.reapsOnExit === true) {
      for (const [label, code] of [
        ['exits 0', 0],
        ['exits nonzero', 3],
      ] as const) {
        reaps(
          `kills a backgrounded grandchild when the worker ${label} before its timeout`,
          async () => {
            const startedAt = Date.now();
            const timeoutClass = await spawnPath({
              projectRoot,
              fixture: CONTAINMENT_FIXTURE,
              timeoutMs: EXIT_SCENARIO_TIMEOUT_MS,
              fixtureArgs: containmentFixtureExitArgs(code),
            });

            expect(Date.now() - startedAt).toBeLessThan(EXIT_SCENARIO_TIMEOUT_MS);
            // A worker that exited on its own was not timed out, even though
            // the path killed its process group afterwards.
            expect(timeoutClass).toBeUndefined();
            // The fixture exits only after both grandchildren have touched
            // their sentinels, so both were running when the worker exited.
            for (const { sentinel } of REQUIRED_GRANDCHILDREN) {
              expect(sentinelMtime(projectRoot, sentinel)).toBeDefined();
            }
            await expectGrandchildReaped(projectRoot);
          },
          TEST_TIMEOUT_MS,
        );
      }
    }
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
