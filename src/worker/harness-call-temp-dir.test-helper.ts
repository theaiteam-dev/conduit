/**
 * Shared by the opencode, agent-sdk and codex-app-server adapter tests.
 */
import { spyOn } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as landlock from './landlock-confinement';

/**
 * Run `body` with createCallTempDir forced to throw, and return the run-scoped dirs (under `prefix`) that
 * existed at the moment it threw. The adapter has made its config/home dir by then and nothing else.
 *
 * TMPDIR points at a private directory for the duration, so the adapter's mkdtemp lands there and the
 * listing taken inside the mock can hold only what this call created. A same-prefix directory made
 * elsewhere in the shared OS temp dir by a concurrent test is never counted. A decoy with the same prefix is
 * planted in the real temp dir mid-call to keep that true; it is removed before this returns.
 */
export async function withFailingCallTempDir(prefix: string, body: () => Promise<void>): Promise<string[]> {
  const sharedTmp = tmpdir();
  const priv = mkdtempSync(join(sharedTmp, 'conduit-private-tmp-'));
  const hadTmpdir = Object.prototype.hasOwnProperty.call(process.env, 'TMPDIR');
  const savedTmpdir = process.env.TMPDIR;
  let decoyDir: string | undefined;
  let live: string[] = [];
  process.env.TMPDIR = priv;
  const spy = spyOn(landlock, 'createCallTempDir').mockImplementation(() => {
    decoyDir = mkdtempSync(join(sharedTmp, `${prefix}decoy-`));
    live = readdirSync(priv).filter((n) => n.startsWith(prefix)).map((n) => join(priv, n));
    throw new Error('simulated call temp dir failure');
  });
  try {
    await body();
  } finally {
    spy.mockRestore();
    if (hadTmpdir) process.env.TMPDIR = savedTmpdir;
    else delete process.env.TMPDIR;
    if (decoyDir) rmSync(decoyDir, { recursive: true, force: true });
    rmSync(priv, { recursive: true, force: true });
  }
  return live;
}
