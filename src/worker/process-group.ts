/**
 * Process-group termination shared by the deterministic station runner
 * (./deterministic.ts) and the harness runner (./harness-runner.ts).
 *
 * Both spawn their child with `detached: true`, which calls setsid(): the
 * child becomes its own session and process-group leader, so its pid is also
 * the group id. Every descendant that does not call setsid() itself stays in
 * that group, and a signal sent to the negative pid reaches all of them. This
 * works on Linux and macOS without prctl or a subreaper.
 */

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
