import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createRunScopedCodexHome,
  operatorCodexHome,
  removeRunScopedCodexHome,
} from './codex-home-isolation';

const PREFIX = 'conduit-codex-home-';
const listHomes = (): string[] => readdirSync(tmpdir()).filter((n) => n.startsWith(PREFIX));
// Other tests and processes may leave their own dirs; compare against this snapshot.
const baseline = new Set(listHomes());
const newHomes = (): string[] => listHomes().filter((n) => !baseline.has(n));

const cleanup: string[] = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** An operator home, with auth.json when `auth` is given. Returns the env pointing at it. */
function operator(auth?: string): { env: Record<string, string>; authPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'codex-op-test-'));
  cleanup.push(dir);
  const authPath = join(dir, 'auth.json');
  if (auth !== undefined) writeFileSync(authPath, auth);
  return { env: { CODEX_HOME: dir }, authPath, dir };
}

describe('createRunScopedCodexHome', () => {
  it('throws when there is no auth.json and no allowlisted auth variable', () => {
    const { env } = operator();
    expect(() => createRunScopedCodexHome(env, [])).toThrow(/no credentials/);
    expect(newHomes()).toEqual([]);
  });

  for (const name of ['OPENAI_API_KEY', 'CODEX_API_KEY']) {
    it(`does not throw for an allowlisted ${name} and links no auth.json`, () => {
      const { env } = operator();
      const dir = createRunScopedCodexHome({ ...env, [name]: 'sk-test' }, [name]);
      cleanup.push(dir);
      expect(existsSync(join(dir, 'config.toml'))).toBe(true);
      expect(() => lstatSync(join(dir, 'auth.json'))).toThrow();
    });
  }

  it('still throws when the allowlisted variable is empty or whitespace', () => {
    const { env } = operator();
    expect(() => createRunScopedCodexHome({ ...env, OPENAI_API_KEY: '' }, ['OPENAI_API_KEY'])).toThrow();
    expect(() => createRunScopedCodexHome({ ...env, OPENAI_API_KEY: '  ' }, ['OPENAI_API_KEY'])).toThrow();
  });

  it('still throws when the variable is set but not allowlisted', () => {
    const { env } = operator();
    expect(() => createRunScopedCodexHome({ ...env, OPENAI_API_KEY: 'sk-test' }, [])).toThrow();
    expect(() => createRunScopedCodexHome({ ...env, OPENAI_API_KEY: 'sk-test' }, ['PATH'])).toThrow();
  });

  it('links the operator auth.json rather than copying it, and writes an empty config.toml', () => {
    const { env, authPath } = operator('{"token":"A"}');
    const dir = createRunScopedCodexHome(env, []);
    cleanup.push(dir);
    const link = join(dir, 'auth.json');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(authPath);
    expect(readFileSync(join(dir, 'config.toml'), 'utf8')).toBe('');
  });

  it('removal deletes the dir and leaves the operator auth.json intact', () => {
    const { env, authPath } = operator('{"token":"A"}');
    const dir = createRunScopedCodexHome(env, []);
    removeRunScopedCodexHome(dir);
    expect(existsSync(dir)).toBe(false);
    expect(readFileSync(authPath, 'utf8')).toBe('{"token":"A"}');
  });

  it('refuses to delete a dir that is not a run-scoped home, and leaves it in place', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'codex-notahome-'));
    cleanup.push(elsewhere);
    writeFileSync(join(elsewhere, 'keep.txt'), 'x');
    expect(() => removeRunScopedCodexHome(elsewhere)).toThrow(/run-scoped/);
    expect(existsSync(join(elsewhere, 'keep.txt'))).toBe(true);

    // Right name, wrong parent.
    const inner = mkdtempSync(join(elsewhere, PREFIX));
    expect(() => removeRunScopedCodexHome(inner)).toThrow(/run-scoped/);
    expect(existsSync(inner)).toBe(true);
  });

  // chmod does not stop root, so the failure cannot be simulated there.
  it.skipIf(process.getuid?.() === 0)('keeps the dir removable by a second call after a failed removal', () => {
    const { env } = operator('{}');
    const dir = createRunScopedCodexHome(env, []);
    cleanup.push(dir);
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'f'), 'x');
    chmodSync(join(dir, 'sub'), 0o500);
    try {
      expect(() => removeRunScopedCodexHome(dir)).toThrow();
      expect(existsSync(dir)).toBe(true);
    } finally {
      chmodSync(join(dir, 'sub'), 0o700);
    }
    removeRunScopedCodexHome(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it('refuses a prefix-matching dir under the temp dir that this module did not create', () => {
    const foreign = mkdtempSync(join(tmpdir(), PREFIX));
    cleanup.push(foreign);
    writeFileSync(join(foreign, 'keep.txt'), 'x');
    expect(() => removeRunScopedCodexHome(foreign)).toThrow(/run-scoped/);
    expect(existsSync(join(foreign, 'keep.txt'))).toBe(true);
  });

  it('removes a created dir even when TMPDIR changed after creation', () => {
    const { env } = operator('{}');
    const dir = createRunScopedCodexHome(env, []);
    const other = mkdtempSync(join(tmpdir(), 'codex-tmpdir-'));
    cleanup.push(dir, other);
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = other;
    try {
      removeRunScopedCodexHome(dir);
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
    expect(existsSync(dir)).toBe(false);
  });

  it('throws when the same dir is removed a second time', () => {
    const { env } = operator('{}');
    const dir = createRunScopedCodexHome(env, []);
    removeRunScopedCodexHome(dir);
    expect(() => removeRunScopedCodexHome(dir)).toThrow(/run-scoped/);
  });

  it('leaves no dir behind when the link cannot be created', async () => {
    // node:fs is mocked in a child process so the mock cannot leak into other test files.
    const { env } = operator('{}');
    const tmp = mkdtempSync(join(tmpdir(), 'codex-chi-tmp-'));
    cleanup.push(tmp);
    const script = `
      import { mock } from 'bun:test';
      import { readdirSync } from 'node:fs';
      const real = await import('node:fs');
      mock.module('node:fs', () => ({ ...real, symlinkSync: () => { throw new Error('EPERM: simulated'); } }));
      const { createRunScopedCodexHome } = await import(${JSON.stringify(join(import.meta.dir, 'codex-home-isolation.ts'))});
      let msg = '';
      try { createRunScopedCodexHome(JSON.parse(process.env.CHI_ENV), []); } catch (e) { msg = String(e); }
      console.log(JSON.stringify({ msg, left: readdirSync(process.env.TMPDIR) }));
    `;
    const proc = Bun.spawnSync([process.execPath, '-e', script], {
      env: { ...process.env, TMPDIR: tmp, CHI_ENV: JSON.stringify(env) },
    });
    if (proc.exitCode !== 0) throw new Error(`child exited ${proc.exitCode}: ${proc.stderr.toString()}`);
    const lines = proc.stdout.toString().trim();
    if (lines === '') throw new Error(`child printed nothing: ${proc.stderr.toString()}`);
    const out = JSON.parse(lines.split('\n').pop()!) as { msg: string; left: string[] };
    expect(out.msg).toContain('simulated');
    expect(out.left).toEqual([]);
  });
});

describe('operatorCodexHome', () => {
  it('prefers CODEX_HOME', () => {
    expect(operatorCodexHome({ CODEX_HOME: '/x/codex', HOME: '/home/u' })).toBe('/x/codex');
  });
  it('falls back to HOME/.codex', () => {
    expect(operatorCodexHome({ HOME: '/home/u' })).toBe('/home/u/.codex');
    expect(operatorCodexHome({ CODEX_HOME: '', HOME: '/home/u' })).toBe('/home/u/.codex');
  });
  it('is undefined when neither is set', () => {
    expect(operatorCodexHome({})).toBeUndefined();
    expect(operatorCodexHome({ HOME: '' })).toBeUndefined();
  });
});
