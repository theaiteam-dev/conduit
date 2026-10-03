import { describe, it, expect } from 'bun:test';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { containedSpawn } from './harness-contained-spawn';
import { killContained } from './process-group';

const ROOT = process.cwd();
const containment = { mechanism: 'process-group', reason: 'unit test' } as const;

describe('containedSpawn close()', () => {
  const trackedHandlers = (): number => process.listeners('SIGTERM').length;

  it('keeps the group tracked when the process outlives the exit wait, and untracks it once it has exited', async () => {
    const before = trackedHandlers();
    let real = false;
    const proc = containedSpawn(containment, 'test', {
      exitWaitMs: 50,
      kill: (pid, cgroup) => {
        if (real) killContained(pid, cgroup);
      },
    })({ command: 'sleep', args: ['30'], cwd: ROOT, env: { PATH: '/usr/bin:/bin' } }, { onLine() {}, onStderr() {}, onExit() {} });
    try {
      await proc.close();
      // The kill was a no-op, so the process is still alive: the kernel's signal handlers must still know it.
      expect(trackedHandlers()).toBeGreaterThan(before);
    } finally {
      real = true;
      await proc.close();
    }
    expect(trackedHandlers()).toBe(before);
  });
});

const ENV = { PATH: '/usr/bin:/bin' };
const trackedCount = (): number => process.listeners('SIGTERM').length;

describe('containedSpawn error path', () => {
  it('throws on an exec failure and leaves no error event to crash the kernel', async () => {
    // spawn() reports EACCES or ENOENT as an 'error' event on a later tick, after the pid check has thrown.
    const dir = mkdtempSync(join(tmpdir(), 'conduit-spawn-'));
    const noExec = join(dir, 'noexec.sh');
    writeFileSync(noExec, '#!/bin/sh\n', { mode: 0o644 });
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown): void => {
      uncaught.push(err);
    };
    process.on('uncaughtException', onUncaught);
    try {
      for (const command of [noExec, join(dir, 'missing')]) {
        expect(() =>
          containedSpawn(containment, 'test')({ command, args: [], cwd: ROOT, env: ENV }, { onLine() {}, onStderr() {}, onExit() {} }),
        ).toThrow(/failed to spawn/);
      }
      await Bun.sleep(50);
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cleans up on a child error without close(): onExit once, group untracked, later close() is safe', async () => {
    const before = trackedCount();
    let child: ChildProcess | undefined;
    let exits = 0;
    const proc = containedSpawn(containment, 'test', {
      spawn: ((cmd: string, args: readonly string[], opts: object) => (child = nodeSpawn(cmd, args, opts))) as typeof nodeSpawn,
    })({ command: 'sleep', args: ['30'], cwd: ROOT, env: ENV }, { onLine() {}, onStderr() {}, onExit: () => { exits++; } });
    expect(trackedCount()).toBeGreaterThan(before);
    child!.emit('error', new Error('async spawn failure'));
    expect(exits).toBe(1);
    expect(trackedCount()).toBe(before);
    await proc.close();
    await proc.close();
    expect(exits).toBe(1);
    expect(trackedCount()).toBe(before);
  });
});

describe('containedSpawn real children', () => {
  it('a descendant holding stdout open delays onExit past the close grace, and onExit fires once', async () => {
    const t0 = Date.now();
    const exits: number[] = [];
    let descendant: number | undefined;
    // The no-op kill leaves the backgrounded sleep alive holding the pipe. It prints its own pid.
    const proc = containedSpawn(containment, 'test', { kill: () => {} })(
      { command: 'sh', args: ['-c', 'sleep 30 & echo $!'], cwd: ROOT, env: ENV },
      { onLine(line) { descendant = Number(line); }, onStderr() {}, onExit: () => { exits.push(Date.now() - t0); } },
    );
    // Poll rather than sleep a fixed time: a slow spawn only makes onExit later.
    for (let i = 0; i < 100 && exits.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    expect(exits.length).toBe(1);
    expect(exits[0]!).toBeGreaterThanOrEqual(950);
    await proc.close();
    expect(exits.length).toBe(1);
    // Reap the real descendant: the kill seam above was a no-op.
    if (descendant !== undefined && descendant > 0) process.kill(descendant, 'SIGKILL');
  });

  // The no-op kill leaves the backgrounded descendant alive holding the pipe past the close grace.
  const heldPipe = async (script: string) => {
    const events: string[] = [];
    let descendant: number | undefined;
    let exits = 0;
    const proc = containedSpawn(containment, 'test', { kill: () => {} })(
      { command: 'sh', args: ['-c', script], cwd: ROOT, env: ENV },
      {
        onLine(line) {
          if (descendant === undefined) descendant = Number(line);
          else events.push(`line:${line}`);
        },
        onStderr() {},
        onExit: () => { exits++; events.push('exit'); },
      },
    );
    for (let i = 0; i < 100 && exits === 0; i++) await new Promise((r) => setTimeout(r, 50));
    // The descendant writes ~0.5s after the grace-timer exit.
    await new Promise((r) => setTimeout(r, 1000));
    await proc.close();
    if (descendant !== undefined && descendant > 0) {
      try { process.kill(descendant, 'SIGKILL'); } catch { /* already gone */ }
    }
    return { events, exits };
  };

  it('delivers no line after onExit when a descendant writes after the close grace', async () => {
    const { events, exits } = await heldPipe('(sleep 1.5; echo late) & echo $!; echo first');
    expect(exits).toBe(1);
    expect(events).toEqual(['line:first', 'exit']);
  });

  it('flushes a final unterminated line before onExit when a descendant holds the pipe', async () => {
    const { events, exits } = await heldPipe('(sleep 1.5; echo late) & echo $!; printf partial');
    expect(exits).toBe(1);
    expect(events).toEqual(['line:partial', 'exit']);
  });

  it('reassembles a multi-byte character split across chunks and a final unterminated line', async () => {
    const lines: string[] = [];
    let done!: () => void;
    const exited = new Promise<void>((r) => (done = r));
    const script = `
      const w = (b) => new Promise((r) => process.stdout.write(b, () => setTimeout(r, 60)));
      const e = Buffer.from('h\\u00e9\\u20ac\\n', 'utf8');
      await w(e.subarray(0, 2));
      await w(e.subarray(2, 4));
      await w(e.subarray(4));
      await w(Buffer.from('second\\nlast'));
    `;
    containedSpawn(containment, 'test')(
      { command: process.execPath, args: ['-e', script], cwd: ROOT, env: ENV },
      { onLine: (l) => lines.push(l), onStderr() {}, onExit: () => done() },
    );
    await exited;
    expect(lines).toEqual(['h\u00e9\u20ac', 'second', 'last']);
  });
});
