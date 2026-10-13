import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as landlock from './landlock-confinement';
import { withFailingCallTempDir } from './harness-call-temp-dir.test-helper';

describe('withFailingCallTempDir', () => {
  it('fails loudly when the body never reaches createCallTempDir', async () => {
    await expect(withFailingCallTempDir('conduit-x-', async () => {})).rejects.toThrow(/never called/);
  });

  it('fails loudly when no dir with the prefix existed in the private TMPDIR at the failure', async () => {
    await expect(
      withFailingCallTempDir('conduit-x-', async () => {
        expect(() => landlock.createCallTempDir()).toThrow('simulated call temp dir failure');
      }),
    ).rejects.toThrow(/private TMPDIR/);
  });

  it('reports no leftover for a dir the body removes', async () => {
    const r = await withFailingCallTempDir('conduit-x-', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'conduit-x-'));
      try {
        landlock.createCallTempDir();
      } catch {
        rmSync(dir, { recursive: true, force: true });
      }
    });
    expect(r.live.length).toBe(1);
    expect(r.leftBehind).toEqual([]);
  });

  it('reports a dir the body leaves behind', async () => {
    const r = await withFailingCallTempDir('conduit-x-', async () => {
      mkdtempSync(join(tmpdir(), 'conduit-x-'));
      try {
        landlock.createCallTempDir();
      } catch {
        // The body deliberately does not remove its dir.
      }
    });
    expect(r.live.length).toBe(1);
    expect(r.leftBehind).toEqual(r.live);
  });
});
