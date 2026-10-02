/**
 * Process plumbing shared by the app-server style harness adapters
 * (`codex-app-server`, `opencode`) and executable lookup shared by those and
 * `agent-sdk`: a contained, detached, line-oriented spawn and its seam types.
 */

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { killContained, trackProcessGroup, untrackProcessGroup } from './process-group';
import { prepareContainedCommand, removeCgroup, type Containment } from './cgroup-containment';

/** Longest wait for the killed process to exit before `close()` gives up on it. */
const EXIT_WAIT_MS = 5_000;
/** Grace after `exit` for the stdout stream to close, when a surviving descendant holds the pipe. */
const CLOSE_GRACE_MS = 1_000;

/**
 * The `claude` a bare name resolves to on `sourceEnv`'s PATH, or a given absolute path. Files only,
 * never a shell function. A path containing '/' must be absolute: a relative one would resolve
 * against whatever cwd the kernel happens to have, so it is refused, with its own message.
 */
export function resolveExecutable(
  command: string,
  sourceEnv: Record<string, string | undefined>,
): { path: string } | { error: string } {
  if (command.includes('/')) {
    if (!isAbsolute(command)) return { error: `'${command}' is a relative path, and the command must be an absolute path or a bare name on PATH` };
    return existsSync(command) && statSync(command).isFile()
      ? { path: command }
      : { error: `'${command}' does not exist or is not a file` };
  }
  const found = Bun.which(command, { PATH: sourceEnv.PATH ?? '/usr/bin:/bin' });
  return found !== null ? { path: found } : { error: `'${command}' was not found on PATH` };
}

/** What the adapter hands a spawn seam. */
export interface ContainedSpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  /** The whole child env. Nothing is inherited. */
  env: Record<string, string>;
}

/** The three things a running process tells the adapter. */
export interface ContainedProcessHandlers {
  /** One complete stdout line, without its newline. */
  onLine(line: string): void;
  onStderr(text: string): void;
  /** Once, after the process is gone and its stdout has been read to the end. */
  onExit(code: number | undefined, signal: string | undefined): void;
}

/** A running process, as the adapter drives it. */
export interface ContainedProcess {
  /** Write one line (the newline is added). Never throws. */
  write(line: string): void;
  /** End everything the process started. Idempotent. */
  kill(): void;
  /** Resolve once the process has exited and its containment is released, bounded. */
  close(): Promise<void>;
}

/** Start a process. May throw. Injected by tests. */
export type ContainedSpawn = (spec: ContainedSpawnSpec, handlers: ContainedProcessHandlers) => ContainedProcess;

/**
 * Start `spec` detached, in its own cgroup where the host has one, and tracked
 * for the kernel's signal handlers. Lines are delivered as they complete.
 * `label` prefixes the spawn error.
 */
export function containedSpawn(
  containment: Containment,
  label = 'harness',
  seams: { exitWaitMs?: number; kill?: (pid: number, cgroup: string | undefined) => void; spawn?: typeof nodeSpawn } = {},
): ContainedSpawn {
  return (spec, handlers) => {
    const contained = prepareContainedCommand(containment, [spec.command, ...spec.args], { cwd: spec.cwd, env: spec.env });
    let child: ChildProcess;
    try {
      child = (seams.spawn ?? nodeSpawn)(contained.argv[0]!, contained.argv.slice(1), {
        cwd: spec.cwd,
        env: spec.env,
        // setsid(): the child leads its own session and group, so its pid addresses the whole group.
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      if (contained.cgroup !== undefined) void removeCgroup(contained.cgroup);
      throw err;
    }
    if (child.pid === undefined) {
      if (contained.cgroup !== undefined) void removeCgroup(contained.cgroup);
      throw new Error(`${label}: failed to spawn '${spec.command}'`);
    }
    const pid = child.pid;
    const cgroup = contained.cgroup;
    trackProcessGroup(pid, cgroup);
    let released = false;
    // Idempotent: the error handler and close() both release, and only the first does anything.
    const release = async (): Promise<void> => {
      if (released) return;
      released = true;
      untrackProcessGroup(pid);
      if (cgroup !== undefined) await removeCgroup(cgroup);
    };
    const killTree = seams.kill ?? killContained;
    const kill = (): void => killTree(pid, cgroup);

    let exitCode: number | undefined;
    let exitSignal: string | undefined;
    let exitReported = false;
    let closeGrace: ReturnType<typeof setTimeout> | undefined;
    const decoder = new StringDecoder('utf8');
    let carry = '';
    // Set once exit is reported: nothing is delivered after onExit.
    let ended = false;
    const flushTail = (): void => {
      if (ended) return;
      carry += decoder.end();
      const tail = carry;
      carry = '';
      if (tail.length > 0) handlers.onLine(tail);
    };
    const reportExit = (): void => {
      if (exitReported) return;
      exitReported = true;
      if (closeGrace !== undefined) clearTimeout(closeGrace);
      // The grace timer can fire with the stream still open: deliver the buffered tail first.
      flushTail();
      ended = true;
      handlers.onExit(exitCode, exitSignal);
    };
    const exited = new Promise<void>((done) => {
      child.once('exit', (code, signal) => {
        exitCode = code ?? undefined;
        exitSignal = signal ?? undefined;
        // A descendant it backgrounded may hold the pipes open: end the tree so stdout reaches its end.
        kill();
        closeGrace = setTimeout(reportExit, CLOSE_GRACE_MS);
        done();
      });
      child.once('error', () => {
        // Best effort: end whatever started, and do not leave the group tracked with no close() coming.
        try {
          kill();
        } catch {
          /* already gone */
        }
        void release().catch(() => {});
        done();
        reportExit();
      });
    });
    child.once('close', reportExit);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (ended) return;
      carry += decoder.write(chunk);
      let newline = carry.indexOf('\n');
      while (newline >= 0) {
        const line = carry.slice(0, newline);
        carry = carry.slice(newline + 1);
        if (line.length > 0) handlers.onLine(line);
        if (ended) return;
        newline = carry.indexOf('\n');
      }
    });
    child.stdout?.on('end', flushTail);
    child.stderr?.on('data', (chunk: Buffer) => {
      if (!ended) handlers.onStderr(chunk.toString('utf-8'));
    });
    child.stdin?.on('error', () => {
      /* the process is gone: the exit handler reports it */
    });

    return {
      write(line) {
        try {
          child.stdin?.write(`${line}\n`);
        } catch {
          /* the process is gone */
        }
      },
      kill,
      async close() {
        kill();
        let wait: ReturnType<typeof setTimeout> | undefined;
        const won = await Promise.race([
          exited.then(() => 'exited' as const),
          new Promise<'timeout'>((r) => {
            wait = setTimeout(() => r('timeout'), seams.exitWaitMs ?? EXIT_WAIT_MS);
          }),
        ]);
        // An uncleared timer would hold the process open for EXIT_WAIT_MS after every call.
        clearTimeout(wait);
        // A process still alive stays tracked so the kernel's signal handlers can reap it. The stale-cgroup sweep handles its cgroup.
        if (won !== 'exited') return;
        await release();
      },
    };
  };
}
