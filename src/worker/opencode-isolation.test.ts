/**
 * Run-scoped opencode state (issue #21): model parsing, credential selection
 * and the per-invocation XDG directories.
 */
import { describe, it, expect, afterAll, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildProviderAuthContent,
  createRunScopedOpenCodeDirs,
  operatorOpenCodeAuthPath,
  removeRunScopedOpenCodeDirs,
  splitOpenCodeModel,
} from './opencode-isolation';

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'conduit-oc-iso-')));
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fresh data home per call, with auth.json when a body is given. */
function dataHomeWith(body?: string): string {
  const dir = realpathSync(mkdtempSync(join(HOME, 'dh-')));
  made.push(dir);
  if (body !== undefined) {
    mkdirSync(join(dir, 'opencode'), { recursive: true });
    writeFileSync(join(dir, 'opencode', 'auth.json'), body);
  }
  return dir;
}

describe('splitOpenCodeModel', () => {
  it('splits at the first slash', () => {
    expect(splitOpenCodeModel('openai/gpt-4.1-mini')).toEqual({ providerID: 'openai', modelID: 'gpt-4.1-mini' });
    expect(splitOpenCodeModel('openrouter/anthropic/claude')).toEqual({ providerID: 'openrouter', modelID: 'anthropic/claude' });
  });

  it('errors for an absent, blank, provider-less or model-less value', () => {
    for (const v of [undefined, '', '  ', 'gpt', '/gpt', 'openai/']) expect('error' in splitOpenCodeModel(v)).toBe(true);
  });
});

describe('operatorOpenCodeAuthPath', () => {
  it('honours XDG_DATA_HOME, then HOME, then reports none', () => {
    expect(operatorOpenCodeAuthPath({ XDG_DATA_HOME: '/x', HOME: '/h' })).toBe('/x/opencode/auth.json');
    expect(operatorOpenCodeAuthPath({ HOME: '/h' })).toBe('/h/.local/share/opencode/auth.json');
    expect(operatorOpenCodeAuthPath({})).toBeUndefined();
  });
});

describe('buildProviderAuthContent', () => {
  it('returns only the entry for the requested provider', () => {
    const h = dataHomeWith(JSON.stringify({ openai: { type: 'api', key: 'K1' }, anthropic: { type: 'oauth', refresh: 'R2' } }));
    const got = buildProviderAuthContent({ XDG_DATA_HOME: h }, [], 'anthropic');
    expect('content' in got && JSON.parse(got.content!)).toEqual({ anthropic: { type: 'oauth', refresh: 'R2' } });
  });

  it('falls back to an allowlisted, set provider variable, with no auth content', () => {
    const h = dataHomeWith('{}');
    expect(buildProviderAuthContent({ XDG_DATA_HOME: h, OPENAI_API_KEY: 'k' }, ['OPENAI_API_KEY'], 'openai')).toEqual({ content: undefined });
    expect('error' in buildProviderAuthContent({ XDG_DATA_HOME: h, OPENAI_API_KEY: 'k' }, [], 'openai')).toBe(true);
    expect('error' in buildProviderAuthContent({ XDG_DATA_HOME: h, OPENAI_API_KEY: ' ' }, ['OPENAI_API_KEY'], 'openai')).toBe(true);
  });

  it('errors, quoting no credential, for an unreadable file or a missing file', () => {
    const h = dataHomeWith('{"openai": {"key": "LEAKME"');
    const bad = buildProviderAuthContent({ XDG_DATA_HOME: h }, [], 'openai');
    expect('error' in bad && bad.error).not.toContain('LEAKME');
    const missing = buildProviderAuthContent({ XDG_DATA_HOME: dataHomeWith() }, [], 'openai');
    expect('error' in missing && missing.error).toContain('openai');
  });

  it('does not take an entry that is not an object', () => {
    const h = dataHomeWith(JSON.stringify({ openai: 'sk-string', groq: [1] }));
    expect('error' in buildProviderAuthContent({ XDG_DATA_HOME: h }, [], 'openai')).toBe(true);
    expect('error' in buildProviderAuthContent({ XDG_DATA_HOME: h }, [], 'groq')).toBe(true);
  });

  it('prefers a valid file entry over an allowlisted provider variable', () => {
    const h = dataHomeWith(JSON.stringify({ openai: { type: 'api', key: 'FILEKEY' } }));
    const got = buildProviderAuthContent({ XDG_DATA_HOME: h, OPENAI_API_KEY: 'envkey' }, ['OPENAI_API_KEY'], 'openai');
    expect(got).toEqual({ content: JSON.stringify({ openai: { type: 'api', key: 'FILEKEY' } }) });
  });

  it('falls back to the variable, not an error, when the file entry is not an object', () => {
    const h = dataHomeWith(JSON.stringify({ openai: 'sk-string' }));
    expect(buildProviderAuthContent({ XDG_DATA_HOME: h, OPENAI_API_KEY: 'envkey' }, ['OPENAI_API_KEY'], 'openai')).toEqual({ content: undefined });
  });
});

describe('run-scoped directories', () => {
  it('creates four empty XDG directories and removes them all', () => {
    const dirs = createRunScopedOpenCodeDirs();
    for (const path of Object.values(dirs.env)) {
      expect(existsSync(path)).toBe(true);
      expect(path.startsWith(dirs.root)).toBe(true);
    }
    expect(Object.keys(dirs.env).sort()).toEqual(['XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']);
    removeRunScopedOpenCodeDirs(dirs);
    expect(existsSync(dirs.root)).toBe(false);
  });
});
