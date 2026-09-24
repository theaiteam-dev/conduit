/**
 * Shared card-scoped input resolution (issue #51).
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
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isCardScoped, resolveInputPath } from './resolve-input';

const ROOT = '/proj';
const OWNED = '/proj/child-a';

describe('isCardScoped — declared list ∪ {seed.json} (issue #51)', () => {
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

describe('resolveInputPath — card scope wins over projectRoot (issue #51)', () => {
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

  it('THROWS rather than falling back to projectRoot when the card has no owned dir', () => {
    // Review finding: the fallback returned <projectRoot>/<name> — the SHARED
    // artifact the per-child copy was meant to replace. Silently handing that
    // back is the exact bug this module exists to prevent, and render's own
    // guard did not cover the callers that MOUNT an input without referencing
    // it in a template. Fail closed here, once, for every caller.
    expect(() => resolveInputPath('patch.txt', ROOT, [], ['patch.txt'])).toThrow(
      /Card-scoped input "patch\.txt" cannot be resolved/,
    );
    expect(() => resolveInputPath('patch.txt', ROOT, undefined, ['patch.txt'])).toThrow(
      /no owned_paths scope/,
    );
    expect(() => resolveInputPath('seed.json', ROOT, undefined, undefined)).toThrow(
      /Card-scoped input "seed\.json" cannot be resolved/,
    );
  });

  it('still resolves an UNSCOPED name from projectRoot on a card with no owned dir', () => {
    // The throw is scoped to card-scoped names only — a station that declares
    // no input_scope keeps resolving every input from the project root, which is
    // the overwhelmingly common (and unchanged) case.
    expect(resolveInputPath('style-guide.md', ROOT, [], ['patch.txt'])).toBe(
      join(ROOT, 'style-guide.md'),
    );
    expect(resolveInputPath('style-guide.md', ROOT, undefined, undefined)).toBe(
      join(ROOT, 'style-guide.md'),
    );
  });
});

/**
 * Traversal confinement (review finding).
 *
 * The READ side never had the escape guard the WRITE side has had since the
 * output_scope work — every declared input was read via a bare
 * `join(projectRoot, name)`. These use REAL directories because the guard's
 * symlink branch only engages when the target's parent actually exists.
 */
describe('resolveInputPath — traversal confinement (issue #51)', () => {
  let root: string;
  let owned: string;
  let outside: string;

  beforeEach(() => {
    // realpathSync so the fixture root is already canonical — otherwise on
    // platforms where the temp dir is itself a symlink (macOS /tmp) the
    // assertions below would be testing the harness, not the guard.
    root = realpathSync(mkdtempSync(join(tmpdir(), 'conduit-resolve-confine-')));
    owned = join(root, 'child-a');
    mkdirSync(owned, { recursive: true });
    outside = realpathSync(mkdtempSync(join(tmpdir(), 'conduit-resolve-outside-')));
    writeFileSync(join(outside, 'secret.txt'), 'SECRET', 'utf-8');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('rejects a card-scoped name that traverses above the owned dir', () => {
    expect(() => resolveInputPath('../../etc/passwd', root, [owned], ['../../etc/passwd'])).toThrow(
      /resolves outside the owned directory/,
    );
  });

  it('rejects an unscoped name that traverses above the project root', () => {
    // The pre-existing hole: this path predates card scope entirely.
    expect(() => resolveInputPath('../secret.txt', root, [owned], [])).toThrow(
      /resolves outside the project root/,
    );
  });

  it('rejects a symlink inside the owned dir that points outside it', () => {
    // The reason the guard realpaths rather than only normalizing lexically:
    // '<owned>/leak.txt' is lexically confined and still reads SECRET.
    symlinkSync(join(outside, 'secret.txt'), join(owned, 'leak.txt'));
    expect(() => resolveInputPath('leak.txt', root, [owned], ['leak.txt'])).toThrow(
      /resolves outside the owned directory/,
    );
  });

  it('allows a symlink that stays INSIDE the scope, returning the declared name', () => {
    // Canonicalizing the leaf must not outlaw symlinks outright — only ones that
    // leave the scope. The returned path is still the declared name, so the
    // caller reads through the link exactly as the flow wrote it.
    writeFileSync(join(owned, 'real.txt'), 'MY_SHARD', 'utf-8');
    symlinkSync(join(owned, 'real.txt'), join(owned, 'alias.txt'));
    expect(resolveInputPath('alias.txt', root, [owned], ['alias.txt'])).toBe(
      join(owned, 'alias.txt'),
    );
  });

  it('allows a name in a subdirectory of the scope', () => {
    mkdirSync(join(owned, 'shards'), { recursive: true });
    writeFileSync(join(owned, 'shards', 'a.diff'), 'SHARD', 'utf-8');
    expect(resolveInputPath('shards/a.diff', root, [owned], ['shards/a.diff'])).toBe(
      join(owned, 'shards/a.diff'),
    );
  });

  it('neutralizes an absolute-looking name into a confined path rather than escaping', () => {
    // join() already treats a leading '/' as a segment, so this lands INSIDE the
    // scope. Pinned so the guard is never "fixed" into rejecting it, and so the
    // neutralization itself is not silently lost.
    expect(resolveInputPath('/etc/passwd', root, [owned], ['/etc/passwd'])).toBe(
      join(owned, 'etc/passwd'),
    );
  });

  it('still resolves a MISSING file inside the scope (the stamp path depends on it)', () => {
    // The lexical branch — no parent to realpath. A missing input is legal: the
    // binding stamp hashes it as ''. The guard must not turn absence into an error.
    expect(resolveInputPath('not-yet-written.json', root, [owned], ['not-yet-written.json'])).toBe(
      join(owned, 'not-yet-written.json'),
    );
    expect(resolveInputPath('deep/nested/missing.json', root, [owned], ['deep/nested/missing.json'])).toBe(
      join(owned, 'deep/nested/missing.json'),
    );
  });

  it('allows a scope reached THROUGH a symlink (no false reject)', () => {
    // A symlinked project root is a normal deployment shape; confinement must
    // compare canonical-to-canonical, not canonical-to-lexical.
    const linkedRoot = join(outside, 'link-to-root');
    symlinkSync(root, linkedRoot);
    writeFileSync(join(owned, 'patch.txt'), 'MY_SHARD', 'utf-8');
    const viaLink = join(linkedRoot, 'child-a');
    expect(resolveInputPath('patch.txt', linkedRoot, [viaLink], ['patch.txt'])).toBe(
      join(viaLink, 'patch.txt'),
    );
  });
});
