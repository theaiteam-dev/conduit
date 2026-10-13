import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { removeRunScopedClaudeConfigDir, createRunScopedClaudeConfigDir, CLAUDE_AUTH_ENV_VARS } from './claude-config-isolation';
import { createRunScopedCodexHome, CODEX_AUTH_ENV_VARS, removeRunScopedCodexHome } from './codex-home-isolation';
import { createCallTempDir, removeCallTempDir } from './landlock-confinement';
import { createRunScopedOpenCodeDirs, removeRunScopedOpenCodeDirs } from './opencode-isolation';
import { tryOwnerTag } from './owner-tag';
import {
  CALL_TMP_PREFIX,
  CLAUDE_CONFIG_PREFIX,
  CODEX_HOME_PREFIX,
  OPENCODE_PREFIX,
  resetSweepStaleRunScopedDirsOnce,
  sweepStaleRunScopedDirs,
  sweepStaleRunScopedDirsOnce,
  taggedTempPrefix,
} from './stale-temp-dirs';

const SELF_PID = 4242;
const SELF_START = 1000;
const DEAD_PID = 999_001;
const LIVE_PID = 999_002;
const LIVE_START = 5000;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stale-temp-dirs-test-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const deps = () => ({
  tmpRoot: root,
  selfPid: SELF_PID,
  selfStartTime: SELF_START,
  isPidAlive: (pid: number) => pid === LIVE_PID || pid === SELF_PID,
  processStartTime: (pid: number) => (pid === LIVE_PID ? LIVE_START : undefined),
});

function mk(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'f'), 'x');
  return dir;
}

describe('creators carry this process owner tag', () => {
  const tag = tryOwnerTag();
  const expectTagged = (dir: string, prefix: string) => {
    expect(tag).toBeDefined();
    expect(basename(dir).startsWith(`${prefix}${tag}-`)).toBe(true);
    expect(basename(dir)).toMatch(new RegExp(`^${prefix}${process.pid}-\\d+-[A-Za-z0-9]{6}$`));
  };

  test('createCallTempDir', () => {
    const d = createCallTempDir();
    try {
      expectTagged(d.root, CALL_TMP_PREFIX);
    } finally {
      removeCallTempDir(d);
    }
  });

  test('createRunScopedClaudeConfigDir', () => {
    const name = CLAUDE_AUTH_ENV_VARS.find((n) => !/USE_/.test(n))!;
    const dir = createRunScopedClaudeConfigDir({ [name]: 'k' }, [name]);
    try {
      expectTagged(dir, CLAUDE_CONFIG_PREFIX);
    } finally {
      removeRunScopedClaudeConfigDir(dir);
    }
  });

  test('createRunScopedCodexHome', () => {
    const name = CODEX_AUTH_ENV_VARS[0]!;
    const dir = createRunScopedCodexHome({ [name]: 'k' }, [name]);
    try {
      expectTagged(dir, CODEX_HOME_PREFIX);
    } finally {
      removeRunScopedCodexHome(dir);
    }
  });

  test('createRunScopedOpenCodeDirs', () => {
    const dirs = createRunScopedOpenCodeDirs();
    try {
      expectTagged(dirs.root, OPENCODE_PREFIX);
    } finally {
      removeRunScopedOpenCodeDirs(dirs);
    }
  });
});

describe('taggedTempPrefix', () => {
  test('appends the owner tag and a separator', () => {
    expect(taggedTempPrefix('conduit-x-')).toBe(`conduit-x-${tryOwnerTag()}-`);
  });
});

describe('sweepStaleRunScopedDirs', () => {
  test('removes a dir tagged with a dead pid', () => {
    const dir = mk(`${CALL_TMP_PREFIX}${DEAD_PID}-77-abc123`);
    expect(sweepStaleRunScopedDirs(deps())).toEqual([dir]);
    expect(existsSync(dir)).toBe(false);
  });

  test('removes a dir of a live pid with a different start time (pid reuse)', () => {
    const dir = mk(`${CLAUDE_CONFIG_PREFIX}${LIVE_PID}-${LIVE_START - 1}-abc123`);
    sweepStaleRunScopedDirs(deps());
    expect(existsSync(dir)).toBe(false);
  });

  test('removes a dir of this pid with a different start time', () => {
    const dir = mk(`${CODEX_HOME_PREFIX}${SELF_PID}-${SELF_START - 1}-abc123`);
    sweepStaleRunScopedDirs(deps());
    expect(existsSync(dir)).toBe(false);
  });

  test('sweeps every covered prefix', () => {
    const dirs = [CALL_TMP_PREFIX, CLAUDE_CONFIG_PREFIX, CODEX_HOME_PREFIX, OPENCODE_PREFIX].map((p) =>
      mk(`${p}${DEAD_PID}-77-abc123`),
    );
    sweepStaleRunScopedDirs(deps());
    for (const d of dirs) expect(existsSync(d)).toBe(false);
  });

  test('keeps this kernel own dirs', () => {
    const dir = mk(`${CALL_TMP_PREFIX}${SELF_PID}-${SELF_START}-abc123`);
    expect(sweepStaleRunScopedDirs(deps())).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  test('keeps a live owner dir', () => {
    const dir = mk(`${OPENCODE_PREFIX}${LIVE_PID}-${LIVE_START}-abc123`);
    sweepStaleRunScopedDirs(deps());
    expect(existsSync(dir)).toBe(true);
  });

  test('keeps a dir whose owner start time is unreadable but whose pid answers', () => {
    const d = { ...deps(), processStartTime: () => undefined };
    const dir = mk(`${CALL_TMP_PREFIX}${LIVE_PID}-${LIVE_START}-abc123`);
    sweepStaleRunScopedDirs(d);
    expect(existsSync(dir)).toBe(true);
  });

  test('keeps untagged and legacy names', () => {
    const a = mk(`${CALL_TMP_PREFIX}abc123`);
    const b = mk(`${CLAUDE_CONFIG_PREFIX}${DEAD_PID}-abc123`);
    sweepStaleRunScopedDirs(deps());
    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(true);
  });

  test('ignores unrelated names', () => {
    const a = mk(`unrelated-${DEAD_PID}-77-abc123`);
    const b = mk(`conduit-other-${DEAD_PID}-77-abc123`);
    sweepStaleRunScopedDirs(deps());
    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(true);
  });

  test('does not throw for a missing root', () => {
    expect(() => sweepStaleRunScopedDirs({ ...deps(), tmpRoot: join(root, 'missing') })).not.toThrow();
  });

  test('skips an entry whose removal throws, and still sweeps the rest', () => {
    const locked = mk(`${CALL_TMP_PREFIX}${DEAD_PID}-77-aaaaaa`);
    writeFileSync(join(locked, 'g'), 'x');
    const other = mk(`${CALL_TMP_PREFIX}${DEAD_PID}-77-bbbbbb`);
    const rm = (dir: string) => {
      if (dir === locked) throw new Error('EACCES');
      rmSync(dir, { recursive: true, force: true });
    };
    let removed: string[] = [];
    expect(() => {
      removed = sweepStaleRunScopedDirs({ ...deps(), rm });
    }).not.toThrow();
    expect(removed).toEqual([other]);
    expect(existsSync(locked)).toBe(true);
    expect(existsSync(other)).toBe(false);
  });

  test('leaves a symlink target outside the swept dir intact', () => {
    const outside = mkdtempSync(join(tmpdir(), 'stale-temp-dirs-outside-'));
    try {
      const creds = join(outside, '.credentials.json');
      writeFileSync(creds, 'secret');
      const dir = mk(`${CLAUDE_CONFIG_PREFIX}${DEAD_PID}-77-abc123`);
      symlinkSync(creds, join(dir, '.credentials.json'));
      sweepStaleRunScopedDirs(deps());
      expect(existsSync(dir)).toBe(false);
      expect(readFileSync(creds, 'utf-8')).toBe('secret');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('sweepStaleRunScopedDirsOnce', () => {
  test('runs the sweep a single time per process', () => {
    resetSweepStaleRunScopedDirsOnce();
    // The memoized wrapper sweeps the real tmpdir: plant a stale dir there, and
    // confirm the first call removes it while a second, after replanting, does not.
    const name = `${CALL_TMP_PREFIX}${DEAD_PID}-77-once01`;
    const dir = join(tmpdir(), name);
    mkdirSync(dir);
    try {
      sweepStaleRunScopedDirsOnce();
      expect(existsSync(dir)).toBe(false);
      mkdirSync(dir);
      sweepStaleRunScopedDirsOnce();
      expect(existsSync(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
