/**
 * Unit tests for the declared-output resolver (issue #98).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import {
  cardScopedArtifactNames,
  describeOutputDestinations,
  harnessOutputInputOverlap,
  resolveDeclaredOutputs,
  resolveDeliverFile,
  resolveOutputBase,
} from './resolve-output';

let root: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'conduit-resolve-output-'));
  outside = mkdtempSync(join(tmpdir(), 'conduit-resolve-output-outside-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('resolveOutputBase', () => {
  it('returns projectRoot for the default and explicit project_root scope', () => {
    expect(resolveOutputBase(root, ['child-a'], undefined)).toBe(root);
    expect(resolveOutputBase(root, ['child-a'], 'project_root')).toBe(root);
  });

  it('resolves a relative owned_paths[0] against projectRoot', () => {
    mkdirSync(join(root, 'evidence', 'c1'), { recursive: true });
    expect(resolveOutputBase(root, ['evidence/c1'], 'owned_dir')).toBe(join(root, 'evidence', 'c1'));
  });

  it('throws for a card with no owned path instead of falling back to projectRoot', () => {
    expect(() => resolveOutputBase(root, [], 'owned_dir')).toThrow(/has no owned_paths/);
    expect(() => resolveOutputBase(root, undefined, 'owned_dir')).toThrow(/has no owned_paths/);
    expect(() => resolveOutputBase(root, ['  '], 'owned_dir')).toThrow(/has no owned_paths/);
  });

  it('throws when owned_paths[0] does not exist or is a file', () => {
    expect(() => resolveOutputBase(root, ['missing'], 'owned_dir')).toThrow(/not an existing directory|is not/);
    writeFileSync(join(root, 'a-file'), 'x');
    expect(() => resolveOutputBase(root, ['a-file'], 'owned_dir')).toThrow(/existing directory/);
  });

  it('allows an owned dir outside the root unless requireWithinProjectRoot is set', () => {
    expect(resolveOutputBase(root, [outside], 'owned_dir')).toBe(outside);
    expect(() =>
      resolveOutputBase(root, [outside], 'owned_dir', { requireWithinProjectRoot: true }),
    ).toThrow(/inside the project root/);
  });

  it('rejects an owned dir inside the root that is a symlink to outside it', () => {
    symlinkSync(outside, join(root, 'link'));
    expect(() =>
      resolveOutputBase(root, ['link'], 'owned_dir', { requireWithinProjectRoot: true }),
    ).toThrow(/inside the project root/);
  });
});

describe('resolveDeclaredOutputs', () => {
  it('resolves every output under the card dir for owned_dir', () => {
    mkdirSync(join(root, 'c1'));
    const out = resolveDeclaredOutputs(
      { outputs: ['result.json', 'evidence/notes.md'], output_scope: 'owned_dir' },
      root,
      ['c1'],
    );
    expect(out).toEqual([
      { name: 'result.json', path: join(root, 'c1', 'result.json') },
      { name: 'evidence/notes.md', path: join(root, 'c1', 'evidence', 'notes.md') },
    ]);
  });

  it('resolves under projectRoot by default, ignoring owned_paths', () => {
    mkdirSync(join(root, 'c1'));
    expect(resolveDeclaredOutputs({ outputs: ['result.json'] }, root, ['c1'])).toEqual([
      { name: 'result.json', path: join(root, 'result.json') },
    ]);
  });

  it('rejects a name that escapes the card dir lexically', () => {
    mkdirSync(join(root, 'c1'));
    expect(() =>
      resolveDeclaredOutputs({ outputs: ['../c2/result.json'], output_scope: 'owned_dir' }, root, ['c1']),
    ).toThrow(/resolves outside the owned directory/);
  });

  it('rejects a name that escapes the card dir through a symlinked subdirectory', () => {
    mkdirSync(join(root, 'c1'));
    symlinkSync(outside, join(root, 'c1', 'evidence'));
    expect(() =>
      resolveDeclaredOutputs({ outputs: ['evidence/result.json'], output_scope: 'owned_dir' }, root, ['c1']),
    ).toThrow(/resolves outside the owned directory/);
  });

  it('rejects a default-scope name that escapes the root through a symlinked ancestor', () => {
    symlinkSync(outside, join(root, 'linked'));
    expect(() => resolveDeclaredOutputs({ outputs: ['linked/result.json'] }, root, [])).toThrow(
      /resolves outside the project root/,
    );
  });

  it('allows a default-scope name under a not-yet-created subdirectory of the root', () => {
    expect(resolveDeclaredOutputs({ outputs: ['newdir/result.json'] }, root, [])).toEqual([
      { name: 'newdir/result.json', path: join(root, 'newdir/result.json') },
    ]);
  });

  it('keeps the project-root escape message for the default scope', () => {
    expect(() => resolveDeclaredOutputs({ outputs: ['../x.json'] }, root, [])).toThrow(
      /resolves outside the project root/,
    );
  });
});

describe('cardScopedArtifactNames', () => {
  it('is the input_scope list alone for an unscoped-output station', () => {
    expect(
      cardScopedArtifactNames({ outputs: ['r.json'], input_scope: { owned_dir: ['patch.txt'] } }),
    ).toEqual(['patch.txt']);
  });

  it('adds every declared output for an owned_dir station', () => {
    expect(
      cardScopedArtifactNames({
        outputs: ['r.json', 'notes.md'],
        output_scope: 'owned_dir',
        input_scope: { owned_dir: ['patch.txt'] },
      }),
    ).toEqual(['patch.txt', 'r.json', 'notes.md']);
  });
});

describe('resolveDeliverFile', () => {
  it('maps a card-scoped declared output to its path under the card dir', () => {
    mkdirSync(join(root, 'evidence', 'c1'), { recursive: true });
    expect(
      resolveDeliverFile('report.md', { outputs: ['report.md'], output_scope: 'owned_dir' }, root, ['evidence/c1']),
    ).toBe(join('evidence', 'c1', 'report.md'));
  });

  it('returns the absolute path when the owned dir is outside the project root', () => {
    const dir = join(outside, 'card');
    mkdirSync(dir);
    expect(
      resolveDeliverFile('r.json', { outputs: ['r.json'], output_scope: 'owned_dir' }, root, [dir]),
    ).toBe(join(dir, 'r.json'));
  });

  it('leaves entries that are not card-scoped outputs unchanged', () => {
    mkdirSync(join(root, 'c1'));
    expect(resolveDeliverFile('other.md', { outputs: ['report.md'], output_scope: 'owned_dir' }, root, ['c1'])).toBe(
      'other.md',
    );
    expect(resolveDeliverFile('report.md', { outputs: ['report.md'] }, root, ['c1'])).toBe('report.md');
  });
});

describe('harnessOutputInputOverlap', () => {
  it('names card-scoped outputs that are also card-scoped inputs or the seed', () => {
    expect(
      harnessOutputInputOverlap({
        outputs: ['draft.md', 'seed.json', 'r.json'],
        output_scope: 'owned_dir',
        input_scope: { owned_dir: ['draft.md'] },
      }),
    ).toEqual(['draft.md', 'seed.json']);
  });

  it('is empty for a project-root station', () => {
    expect(harnessOutputInputOverlap({ outputs: ['seed.json'], input_scope: { owned_dir: [] } })).toEqual([]);
  });
});

describe('describeOutputDestinations', () => {
  it('lists each output with its absolute path', () => {
    const text = describeOutputDestinations([{ name: 'r.json', path: '/p/c1/r.json' }]);
    expect(text).toContain('- r.json: /p/c1/r.json');
  });
});
