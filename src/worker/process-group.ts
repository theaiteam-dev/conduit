/**
 * Process-group termination shared by the deterministic station runner
 * (./deterministic.ts) and the harness runner (./harness-runner.ts).
 *
 * Both spawn their child with `detached: true`, which calls setsid(): the
 * child becomes its own session and process-group leader, so its pid is also
 * the group id. Every descendant that does not call setsid() itself stays in
 * that group, and a signal sent to the negative pid reaches all of them. This
 * works on Linux and macOS without prctl or a subreaper.
 *
 * A detached child is outside the terminal's foreground process group, so a
 * Ctrl-C reaches only the kernel, and the runner's timeout timer dies with it.
 * The registry below closes that gap: while any station group is live, SIGINT,
 * SIGTERM and SIGHUP handlers and an `exit` handler kill every live group
 * before the kernel goes. A SIGKILLed kernel runs no handler, which is why the
 * ADR-0003 container boundary still matters.
 *
 * A descendant that calls setsid() leaves the group, and Claude Code's Bash
 * tool does that for every command (issue #77). Where the host allows it, each
 * child therefore also runs in its own cgroup (./cgroup-containment.ts), and
 * `killContained` writes that cgroup's `cgroup.kill` as well as killing the
 * group. The registry records the cgroup so the signal and exit handlers do
 * the same.
 */
import { killCgroup, removeCgroupsSync } from './cgroup-containment';

/**
 * SIGKILL every process in the group led by `pid`. ESRCH (the group is
 * already empty) is the normal case after a clean exit and is ignored, as is
 * any other kill error: there is nothing further the caller could do.
 */
export function killProcessGroup(pid: number): void {
  try {
    // Negative pid == the process GROUP, not just the immediate child.
    process.kill(-pid, 'SIGKILL');
  } catch {
    /* group already exited: nothing to kill */
  }
}

/**
 * Kill everything a contained child started: every process in `cgroup` when
 * it has one, and every process in the group led by `pid`. The group kill is
 * kept under cgroup containment too, so the two mechanisms back each other up.
 */
export function killContained(pid: number, cgroup: string | undefined): void {
  if (cgroup !== undefined) killCgroup(cgroup);
  killProcessGroup(pid);
}

/** Signals whose default action terminates the kernel, and so must take live groups with it. */
export const TERMINATING_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
type TerminatingSignal = (typeof TERMINATING_SIGNALS)[number];

/** Group ids of station commands that are running now, with each one's cgroup, if any. */
const liveGroups = new Map<number, string | undefined>();

function killLiveGroups(): void {
  const cgroups: string[] = [];
  for (const [pid, cgroup] of liveGroups) {
    killContained(pid, cgroup);
    if (cgroup !== undefined) cgroups.push(cgroup);
  }
  liveGroups.clear();
  // The runners cannot remove their cgroups once the kernel is going, so do it
  // here, bounded: what is still populated is left for the next kernel's sweep.
  removeCgroupsSync(cgroups);
}

/**
 * Kill the live groups, then preserve the kernel's normal outcome for `signal`.
 * When no other listener remains, re-raise the signal so the default action
 * (termination, exit status 128 + signo) still happens. When another listener
 * exists, such as `conduit listen`'s graceful stop, termination is its job.
 */
function onSignal(signal: TerminatingSignal): void {
  killLiveGroups();
  uninstallHandlers();
  if (process.listenerCount(signal) === 0) {
    process.kill(process.pid, signal);
  }
}

const signalHandlers: Record<TerminatingSignal, () => void> = {
  SIGINT: () => onSignal('SIGINT'),
  SIGTERM: () => onSignal('SIGTERM'),
  SIGHUP: () => onSignal('SIGHUP'),
};

/** `process.exit()` mid-station: only synchronous work runs here, and kill is synchronous. */
function onExit(): void {
  killLiveGroups();
}

let installed = false;

function installHandlers(): void {
  if (installed) return;
  installed = true;
  for (const signal of TERMINATING_SIGNALS) {
    // Prepended so it runs before any other listener. A listener that removes
    // itself when it runs (conduit listen's does) would otherwise be gone by
    // the time onSignal counts the remaining listeners.
    process.prependListener(signal, signalHandlers[signal]);
  }
  process.on('exit', onExit);
}

function uninstallHandlers(): void {
  if (!installed) return;
  installed = false;
  for (const signal of TERMINATING_SIGNALS) {
    process.off(signal, signalHandlers[signal]);
  }
  process.off('exit', onExit);
}

/**
 * Record a just-spawned detached child as a live station group, with the
 * cgroup it runs in when it has one. The first live group installs the signal
 * and exit handlers.
 */
export function trackProcessGroup(pid: number, cgroup?: string): void {
  liveGroups.set(pid, cgroup);
  installHandlers();
}

/**
 * Forget a group once its runner has finished with it (after its final kill).
 * The last one removes the handlers, so an idle kernel, and every test that
 * spawns nothing, keeps its default signal behaviour.
 */
export function untrackProcessGroup(pid: number): void {
  liveGroups.delete(pid);
  if (liveGroups.size === 0) uninstallHandlers();
}
