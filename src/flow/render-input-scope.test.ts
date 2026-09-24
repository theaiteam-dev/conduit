/**
 * Card-scoped declared inputs in prompt rendering (issue #51).
 *
 * WI-468 made the reserved `{{seed.json}}` resolve from the child's owned dir.
 * This item completes the symmetry: a station may declare a LIST of its inputs
 * (`input_scope.owned_dir`) that resolve from the card's owned dir, so N fan-out
 * children can each be handed their OWN shard of an input — a per-child patch,
 * one reviewer's slice of a diff — through one shared template.
 *
 * ---------------------------------------------------------------------------
 * Contract this file pins for src/flow/render.ts
 * ---------------------------------------------------------------------------
 *
 *   renderPrompt(
 *     template: string,
 *     inputs: string[],
 *     projectRoot: string,
 *     feedback?: string,
 *     imageInputs?: string[],
 *     ownedPaths?: string[],
 *     ownedDirInputs?: string[],   // NEW (#51) — names read from the owned dir
 *   ): string
 *
 * Invariants pinned here:
 *   - A name in `ownedDirInputs`, declared + referenced, resolves to the bytes of
 *     <ownedPaths[0]>/<name> — NOT join(projectRoot, name).
 *   - A declared input NOT in the list still resolves from projectRoot, in the
 *     same render as a card-scoped one.
 *   - Fail-closed: a card-scoped input that cannot be read THROWS (as seed does)
 *     — it never falls back to the project-root file of the same name, which is
 *     precisely the shared input the shard was meant to replace.
 *   - Backward compat: `seed.json` stays card-scoped with NO input_scope declared,
 *     and the new parameter is purely additive for every existing caller.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { renderPrompt } from './render';

const createdDirs: string[] = [];

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** A throwaway directory seeded with files (used for both project root and owned dirs). */
function makeDir(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'conduit-input-scope-'));
  createdDirs.push(dir);
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, name), contents, 'utf-8');
  }
  return dir;
}

/** Capture the message of the error thrown by `fn`, or '' if it did not throw. */
function thrownMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return '';
}

// ===========================================================================
// AC1 — a declared input listed in input_scope.owned_dir renders from the
//        card's owned dir, not projectRoot.
// ===========================================================================

describe('renderPrompt — declared card-scoped inputs (issue #51 AC1)', () => {
  it('substitutes a listed input with the bytes of <ownedPaths[0]>/<name>', () => {
    const root = makeDir();
    const ownedDir = makeDir({ 'patch.txt': 'SHARD-A-DIFF' });

    const result = renderPrompt(
      'Review:\n{{patch.txt}}',
      ['patch.txt'],
      root,
      undefined,
      undefined,
      [ownedDir],
      ['patch.txt'],
    );

    expect(result).toBe('Review:\nSHARD-A-DIFF');
  });

  it('reads the listed input from the owned dir, NOT from join(projectRoot, name)', () => {
    // A decoy patch.txt sits at projectRoot — the whole-diff file the shard replaces.
    const root = makeDir({ 'patch.txt': 'DECOY_WHOLE_DIFF' });
    const ownedDir = makeDir({ 'patch.txt': 'MY_SHARD' });

    const result = renderPrompt(
      '{{patch.txt}}',
      ['patch.txt'],
      root,
      undefined,
      undefined,
      [ownedDir],
      ['patch.txt'],
    );

    expect(result).toBe('MY_SHARD');
  });

  it('resolves from the FIRST owned_paths entry when several are declared', () => {
    const root = makeDir();
    const firstDir = makeDir({ 'patch.txt': 'FIRST' });
    const secondDir = makeDir({ 'patch.txt': 'SECOND' });

    const result = renderPrompt(
      '{{patch.txt}}',
      ['patch.txt'],
      root,
      undefined,
      undefined,
      [firstDir, secondDir],
      ['patch.txt'],
    );

    expect(result).toBe('FIRST');
  });

  it('renders two sibling shards to different prompts through the SAME template', () => {
    const root = makeDir();
    const childA = makeDir({ 'patch.txt': 'DIFF-A' });
    const childB = makeDir({ 'patch.txt': 'DIFF-B' });
    const template = 'Review this shard: {{patch.txt}}';

    const promptA = renderPrompt(template, ['patch.txt'], root, undefined, undefined, [childA], ['patch.txt']);
    const promptB = renderPrompt(template, ['patch.txt'], root, undefined, undefined, [childB], ['patch.txt']);

    expect(promptA).toBe('Review this shard: DIFF-A');
    expect(promptB).toBe('Review this shard: DIFF-B');
    expect(promptA).not.toBe(promptB);
  });
});

// ===========================================================================
// AC2 — inputs NOT listed stay project-root scoped, in the same render.
// ===========================================================================

describe('renderPrompt — unlisted inputs stay project-root scoped (issue #51 AC2)', () => {
  it('mixes a project-root input and a card-scoped input in one prompt', () => {
    const root = makeDir({ 'style-guide.md': 'HOUSE_STYLE' });
    const ownedDir = makeDir({ 'patch.txt': 'MY_SHARD' });

    const result = renderPrompt(
      'Guide: {{style-guide.md}}\nPatch: {{patch.txt}}',
      ['style-guide.md', 'patch.txt'],
      root,
      undefined,
      undefined,
      [ownedDir],
      ['patch.txt'],
    );

    expect(result).toBe('Guide: HOUSE_STYLE\nPatch: MY_SHARD');
  });

  it('reads an unlisted input from projectRoot even when the owned dir holds the same name', () => {
    // The owned dir has a style-guide.md too; it is NOT scoped, so projectRoot wins.
    const root = makeDir({ 'style-guide.md': 'FROM_PROJECT_ROOT' });
    const ownedDir = makeDir({ 'style-guide.md': 'FROM_OWNED_DIR', 'patch.txt': 'p' });

    const result = renderPrompt(
      '{{style-guide.md}}',
      ['style-guide.md', 'patch.txt'],
      root,
      undefined,
      undefined,
      [ownedDir],
      ['patch.txt'],
    );

    expect(result).toBe('FROM_PROJECT_ROOT');
  });
});

// ===========================================================================
// AC3 — fail-closed: an unreadable card-scoped input throws, exactly as seed
//        does. It must never silently fall back to the project-root file.
// ===========================================================================

describe('renderPrompt — fail-closed card-scoped reads (issue #51 AC3)', () => {
  it('throws when the card-scoped input is missing from the owned dir', () => {
    const root = makeDir();
    const ownedDirEmpty = makeDir();

    const render = () =>
      renderPrompt('{{patch.txt}}', ['patch.txt'], root, undefined, undefined, [ownedDirEmpty], ['patch.txt']);

    expect(render).toThrow(/patch\.txt/);
    expect(thrownMessage(render)).toMatch(/could not be read/i);
  });

  it('throws rather than falling back to the project-root file of the same name', () => {
    // THE fail-closed case: patch.txt exists at projectRoot but not in the owned
    // dir. Rendering the project-root copy would hand this child the whole diff
    // every sibling sees — silently defeating the shard. It must throw instead.
    const root = makeDir({ 'patch.txt': 'DECOY_WHOLE_DIFF' });
    const ownedDirEmpty = makeDir();

    const render = () =>
      renderPrompt('{{patch.txt}}', ['patch.txt'], root, undefined, undefined, [ownedDirEmpty], ['patch.txt']);

    expect(render).toThrow(/patch\.txt/);
    // And the owned dir — not projectRoot — is named in the error.
    expect(thrownMessage(render)).toContain(ownedDirEmpty);
  });

  it('throws when a card-scoped input is declared but no owned scope was supplied', () => {
    const root = makeDir({ 'patch.txt': 'DECOY_WHOLE_DIFF' });

    expect(() =>
      renderPrompt('{{patch.txt}}', ['patch.txt'], root, undefined, undefined, undefined, ['patch.txt']),
    ).toThrow(/patch\.txt/);
    expect(() =>
      renderPrompt('{{patch.txt}}', ['patch.txt'], root, undefined, undefined, [], ['patch.txt']),
    ).toThrow(/patch\.txt/);
  });

  it('still applies the scope guard: an UNDECLARED card-scoped name is rejected', () => {
    const root = makeDir();
    const ownedDir = makeDir({ 'patch.txt': 'MY_SHARD' });

    // Listing a name in input_scope does not declare it — `inputs` does.
    const msg = thrownMessage(() =>
      renderPrompt('{{patch.txt}}', [], root, undefined, undefined, [ownedDir], ['patch.txt']),
    );

    expect(msg).toMatch(/patch\.txt/);
    expect(msg).toMatch(/not declared as an input/i);
  });
});

// ===========================================================================
// AC4 — backward compatibility: seed.json stays card-scoped with NO declared
//        input_scope, and the new parameter is additive for existing callers.
// ===========================================================================

describe('renderPrompt — backward compatibility (issue #51 AC4)', () => {
  it('resolves seed.json from the owned dir with NO input_scope declared', () => {
    const root = makeDir({ 'seed.json': 'DECOY_FROM_PROJECT_ROOT' });
    const ownedDir = makeDir({ 'seed.json': '{"sku":"WIDGET-A"}' });

    // Arity-6 call: exactly what WI-468 callers pass today, no ownedDirInputs.
    const result = renderPrompt('{{seed.json}}', ['seed.json'], root, undefined, undefined, [ownedDir]);

    expect(result).toBe('{"sku":"WIDGET-A"}');
  });

  it('keeps seed.json card-scoped alongside a declared card-scoped input', () => {
    const root = makeDir();
    const ownedDir = makeDir({ 'seed.json': '{"shard":1}', 'patch.txt': 'MY_SHARD' });

    const result = renderPrompt(
      'seed={{seed.json}} patch={{patch.txt}}',
      ['seed.json', 'patch.txt'],
      root,
      undefined,
      undefined,
      [ownedDir],
      ['patch.txt'],
    );

    expect(result).toBe('seed={"shard":1} patch=MY_SHARD');
  });

  it('renders identically for an existing caller that omits the new parameter', () => {
    const root = makeDir({ 'context.json': '{"k":"v"}' });
    const ownedDir = makeDir({ 'context.json': 'IGNORED' });

    const omitted = renderPrompt('{{context.json}}', ['context.json'], root, undefined, undefined, [ownedDir]);
    const emptyList = renderPrompt(
      '{{context.json}}',
      ['context.json'],
      root,
      undefined,
      undefined,
      [ownedDir],
      [],
    );

    expect(omitted).toBe('{"k":"v"}');
    expect(emptyList).toBe(omitted);
  });

  it('keeps the synthetic feedback input working alongside card-scoped inputs', () => {
    const root = makeDir();
    const ownedDir = makeDir({ 'patch.txt': 'MY_SHARD' });

    const result = renderPrompt(
      'patch={{patch.txt}} fb={{feedback}}',
      ['patch.txt', 'feedback'],
      root,
      'REWORK_NOTE',
      undefined,
      [ownedDir],
      ['patch.txt'],
    );

    expect(result).toBe('patch=MY_SHARD fb=REWORK_NOTE');
  });
});
