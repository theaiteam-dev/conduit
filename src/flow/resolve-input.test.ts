/**
 * Shared card-scoped input resolution (issue #112).
 *
 * The rule this file pins: an input name is CARD-SCOPED when it appears in the
 * station's `input_scope.owned_dir` list, UNION the reserved `seed.json` (which
 * has been card-scoped since WI-468 and stays so with no declaration). A
 * card-scoped name resolves under the card's owned dir; everything else stays
 * at projectRoot.
 *
 * Both the prompt renderer and the binding-stamp hasher route through these two
 * functions, so a card-scoped input can never be RENDERED from one location and
 * HASHED from another — the divergence that produced the WI-468 BUG-1 stamp
 * collision.
 */
import { describe, it, expect } from 'bun:test';
import { join } from 'node:path';
import { isCardScoped, resolveInputPath } from './resolve-input';

const ROOT = '/proj';
const OWNED = '/proj/child-a';

describe('isCardScoped — declared list ∪ {seed.json} (issue #112)', () => {
  it('treats a name in the owned-dir list as card-scoped', () => {
    expect(isCardScoped('patch.txt', ['patch.txt'])).toBe(true);
  });

  it('treats a name absent from the list as project-root scoped', () => {
    expect(isCardScoped('style-guide.md', ['patch.txt'])).toBe(false);
  });

  it('treats the reserved seed.json as card-scoped with NO declaration (backward compat)', () => {
    expect(isCardScoped('seed.json', undefined)).toBe(true);
    expect(isCardScoped('seed.json', [])).toBe(true);
  });

  it('treats every other name as project-root scoped when nothing is declared', () => {
    expect(isCardScoped('patch.txt', undefined)).toBe(false);
    expect(isCardScoped('patch.txt', [])).toBe(false);
  });
});

describe('resolveInputPath — card scope wins over projectRoot (issue #112)', () => {
  it('resolves a card-scoped input under the first owned path', () => {
    expect(resolveInputPath('patch.txt', ROOT, [OWNED], ['patch.txt'])).toBe(join(OWNED, 'patch.txt'));
  });

  it('resolves a non-listed input from projectRoot even when an owned dir exists', () => {
    expect(resolveInputPath('style-guide.md', ROOT, [OWNED], ['patch.txt'])).toBe(
      join(ROOT, 'style-guide.md'),
    );
  });

  it('resolves the reserved seed.json card-scoped with no declared list', () => {
    expect(resolveInputPath('seed.json', ROOT, [OWNED], undefined)).toBe(join(OWNED, 'seed.json'));
  });

  it('uses ownedPaths[0] — "the" child dir — when several are declared', () => {
    expect(resolveInputPath('patch.txt', ROOT, [OWNED, '/proj/other'], ['patch.txt'])).toBe(
      join(OWNED, 'patch.txt'),
    );
  });

  it('falls back to projectRoot when the card has no owned dir', () => {
    // The stamp path relies on this fallback: an unscoped card hashes from
    // projectRoot (typically ENOENT → '') rather than throwing. Render layers
    // its own fail-closed guard on top; see render.ts.
    expect(resolveInputPath('patch.txt', ROOT, [], ['patch.txt'])).toBe(join(ROOT, 'patch.txt'));
    expect(resolveInputPath('seed.json', ROOT, undefined, undefined)).toBe(join(ROOT, 'seed.json'));
  });
});
