/**
 * Keeps a Conduit process's environment from processes of the same user (GHSA-r69q-grh3-2r38).
 *
 * The harness env allowlist decides which variables a harness child starts with, but the
 * child runs as the same user as the kernel, in the same PID namespace. Without this, any
 * harness that can read a file reads `/proc/<kernel pid>/environ` and gets every variable
 * the kernel holds, including the ones the allowlist leaves out.
 *
 * `prctl(PR_SET_DUMPABLE, 0)` makes the process non-dumpable: its `/proc/<pid>/environ`,
 * `mem`, `maps` and `fd/` are then readable only with CAP_SYS_PTRACE, which a container does
 * not grant by default. `stat` and `cgroup` stay readable, so the run lock and cgroup
 * containment, which read them for other Conduit processes, are unaffected. The flag is
 * reset by execve, so it covers only the process that sets it: harness children keep their
 * allowlisted env readable to each other, and a deterministic station, which inherits the
 * kernel's full environment, is readable while it runs.
 *
 * Linux only. Other platforms have no `/proc/<pid>/environ`.
 */
import { dlopen, FFIType } from 'bun:ffi';

const PR_GET_DUMPABLE = 3;
const PR_SET_DUMPABLE = 4;

// glibc first (the oven/bun image), then musl.
const LIBC_NAMES = ['libc.so.6', `libc.musl-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}.so.1`];

export type NonDumpableResult = { ok: true } | { ok: false; reason: string };

export function makeProcessNonDumpable(platform: string = process.platform): NonDumpableResult {
  if (platform !== 'linux') return { ok: false, reason: `not Linux (${platform})` };
  const errors: string[] = [];
  for (const name of LIBC_NAMES) {
    let lib;
    try {
      // prctl is variadic; on Linux x86_64 and aarch64 its integer arguments are passed in
      // registers either way, so a fixed five-argument signature calls it correctly.
      lib = dlopen(name, {
        prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
      });
    } catch (err) {
      errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    try {
      if (lib.symbols.prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) !== 0) return { ok: false, reason: 'prctl(PR_SET_DUMPABLE, 0) failed' };
      if (lib.symbols.prctl(PR_GET_DUMPABLE, 0, 0, 0, 0) !== 0) return { ok: false, reason: 'the process is still dumpable after prctl(PR_SET_DUMPABLE, 0)' };
      return { ok: true };
    } finally {
      lib.close();
    }
  }
  return { ok: false, reason: `no libc to call prctl through (${errors.join('; ')})` };
}

/**
 * Called first thing by the kernel and by each `__worker` process. A failure on Linux is
 * reported, not fatal: the run still works, but its environment is readable by harnesses.
 */
export function protectProcessEnvironment(write: (line: string) => void = (l) => process.stderr.write(l)): void {
  const result = makeProcessNonDumpable();
  if (!result.ok && process.platform === 'linux') {
    write(`warning: could not mark this process non-dumpable (${result.reason}); harness processes can read its environment from /proc\n`);
  }
}
