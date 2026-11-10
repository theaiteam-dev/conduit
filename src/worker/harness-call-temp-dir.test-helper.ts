/**
 * Shared by the opencode, agent-sdk and codex-app-server adapter tests.
 */
import { spyOn } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as landlock from './landlock-confinement';

/**
 * Run `body` with createCallTempDir forced to throw. Returns `live`, the run-scoped dirs (under `prefix`) that
 * existed at the moment it threw (the adapter has made its config/home dir by then and nothing else), and
 * `leftBehind`, those of them still on disk once `body` returns. `leftBehind` is read before the private
 * directory is removed, so a dir the adapter failed to clean up is reported rather than swept away.
 *
 * TMPDIR points at a private directory for the duration, so the adapter's mkdtemp lands there and the
 * listing taken inside the mock can hold only what this call created. A same-prefix directory made
 * elsewhere in the shared OS temp dir by a concurrent test is never counted.
 *
 * The helper throws, instead of returning, in two cases that would otherwise pass vacuously: createCallTempDir
 * was never called (the adapter bypassed the spy), or no dir with `prefix` existed in the private TMPDIR when
 * it was called (the adapter's dir did not land there, for example because it read a cached tmpdir).
 */
export async function withFailingCallTempDir(
  prefix: string,
  body: () => Promise<void>,
): Promise<{ live: string[]; leftBehind: string[] }> {
  const sharedTmp = tmpdir();
  const priv = mkdtempSync(join(sharedTmp, 'conduit-private-tmp-'));
  const hadTmpdir = Object.prototype.hasOwnProperty.call(process.env, 'TMPDIR');
  const savedTmpdir = process.env.TMPDIR;
  let called = false;
  let live: string[] = [];
  let leftBehind: string[] = [];
  process.env.TMPDIR = priv;
  const spy = spyOn(landlock, 'createCallTempDir').mockImplementation(() => {
    called = true;
    live = readdirSync(priv).filter((n) => n.startsWith(prefix)).map((n) => join(priv, n));
    throw new Error('simulated call temp dir failure');
  });
  try {
    await body();
    if (!called) throw new Error('createCallTempDir was never called: the adapter bypassed the spy');
    if (live.length === 0) {
      throw new Error(`no ${prefix}* dir existed in the private TMPDIR when createCallTempDir was called`);
    }
    leftBehind = live.filter((dir) => existsSync(dir));
  } finally {
    spy.mockRestore();
    if (hadTmpdir) process.env.TMPDIR = savedTmpdir;
    else delete process.env.TMPDIR;
    rmSync(priv, { recursive: true, force: true });
  }
  return { live, leftBehind };
}
