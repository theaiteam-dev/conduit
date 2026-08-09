/**
 * Card-scoped input resolution — the ONE place that decides where a declared
 * input is read from (issue #112).
 *
 * A station's declared inputs resolve from `projectRoot` by default. A fan-out
 * CHILD, however, may need a per-child copy of an input: the shard of a diff it
 * alone reviews, not the whole diff every sibling sees. `input_scope.owned_dir`
 * lists which of the station's declared inputs resolve from the CARD's owned
 * directory instead — the mirror image of `output_scope: owned_dir`, which
 * already lets a child WRITE there.
 *
 * `seed.json` is RESERVED and stays card-scoped with no declaration at all
 * (WI-468): the effective owned-dir set is `declared list ∪ {'seed.json'}`, so
 * every flow written before this feature keeps rendering its per-child seed.
 *
 * WHY this lives in its own module rather than at each use site: the prompt
 * RENDERER and the binding-stamp HASHER must agree on the location of every
 * input, always. WI-468 BUG-1 was exactly that divergence — render read the
 * seed from the child's owned dir while the stamp hashed `projectRoot/seed.json`
 * (ENOENT → '' → every sibling stamped identically → skip-replay served one
 * child's output to another). Two callers of one function cannot drift; two
 * hand-written `join()` carve-outs did. The harness input MOUNTS (executor and
 * quality/gate) route through here for the same reason.
 *
 * CONVENTION — `ownedPaths[0]` is "the" child dir. A card may own several paths,
 * but the first entry is the one commitFanOut materializes the child's seed into
 * and the one `output_scope: owned_dir` writes to. Card-scoped inputs follow that
 * same convention rather than searching the list, so a card's inputs, outputs,
 * and seed all live in one predictable directory.
 */

import { join, resolve, sep } from 'node:path';
import { realpathSync } from 'node:fs';

/**
 * Reserved synthetic input name for per-child seeds (WI-468 / FR-2a).
 *
 * Card-scoped unconditionally — it predates `input_scope` and must keep working
 * for flows that declare nothing. Hard-coded here because it is part of the
 * Conduit flow contract, not something a flow author may redefine.
 */
export const SEED_INPUT = 'seed.json';

/**
 * True when `name` resolves from the card's owned dir rather than projectRoot.
 *
 * The effective set is `ownedDirInputs ∪ {'seed.json'}` — see SEED_INPUT.
 *
 * @param name           - Declared input artifact name.
 * @param ownedDirInputs - The station's `input_scope.owned_dir` list, validated
 *                         at load to be a subset of its declared `inputs`.
 *                         Absent/empty means only the reserved seed is scoped.
 */
export function isCardScoped(name: string, ownedDirInputs?: readonly string[]): boolean {
  return name === SEED_INPUT || (ownedDirInputs?.includes(name) ?? false);
}

/**
 * Absolute on-disk path a declared input is read from.
 *
 * Card-scoped names resolve to `<ownedPaths[0]>/<name>`; everything else to
 * `<projectRoot>/<name>`.
 *
 * FAIL-CLOSED. A card-scoped name on a card with NO owned dir THROWS; it does
 * not fall back to `<projectRoot>/<name>`. That fallback is precisely the bug
 * this module exists to prevent: the project-root file of the same name is the
 * SHARED artifact the per-child copy was meant to replace, so returning it hands
 * a caller plausible-looking wrong bytes instead of an error. Concretely, it
 * would let a harness station mount the whole diff under the name of a shard —
 * and, worse, let every sibling hash that same shared file into its binding
 * stamp, so N cards stamp identically and skip-replay serves one card's output
 * to another (WI-468 BUG-1, generalized; PR #114 review).
 *
 * Callers still choose their own failure SHAPE around this throw, which is why
 * it is raised here rather than at each use site:
 *   - the binding-stamp hashers catch it and hash '' — the same value an absent
 *     file already produces, so a card that cannot supply the input still gets a
 *     stamp and the difference still invalidates;
 *   - `renderPrompt` and the harness input MOUNTS let it propagate, so the card
 *     escalates rather than executing against the wrong artifact.
 * `renderPrompt` additionally pre-checks the same condition to raise a
 * template-specific message; this throw is the backstop for every other caller.
 *
 * @param name           - Declared input artifact name.
 * @param projectRoot    - Absolute project root (the default scope).
 * @param ownedPaths     - The card's owned paths; `[0]` is the child dir.
 * @param ownedDirInputs - The station's `input_scope.owned_dir` list.
 * @throws If `name` is card-scoped but `ownedPaths` is empty/absent.
 */
export function resolveInputPath(
  name: string,
  projectRoot: string,
  ownedPaths?: readonly string[],
  ownedDirInputs?: readonly string[],
): string {
  if (isCardScoped(name, ownedDirInputs)) {
    const ownedDir = ownedPaths?.[0];
    if (ownedDir === undefined) {
      throw new Error(
        `Card-scoped input "${name}" cannot be resolved: no owned_paths scope was supplied for this card. ` +
          `Refusing to fall back to the project-root artifact of the same name.`,
      );
    }
    return confineToBase(ownedDir, name, 'owned directory');
  }
  return confineToBase(projectRoot, name, 'project root');
}

/**
 * Assert that `<base>/<name>` stays inside `base`, and return the joined path.
 *
 * The READ-side counterpart of the output escape guard in `executor.ts` (Issue
 * C), using the same two-root technique for the same reasons. Inputs never had
 * one: every declared input has been read via a bare `join(projectRoot, name)`
 * since long before card scope existed, so a station declaring
 * `inputs: ['../../../etc/passwd']` was read verbatim (PR #114 review).
 *
 * This is defense in depth, not a privilege boundary. `name` comes from the
 * flow's own `inputs:` list, and a flow author already chooses the commands
 * their stations run — anyone who can add a traversing input name can more
 * directly add a command that cats the same file. What the guard buys is that
 * reads and writes now obey ONE rule, so neither side has to be re-audited on
 * the assumption the other is looser, and a malformed name fails loudly at the
 * chokepoint instead of quietly reading something outside the tree.
 *
 * Three tiers, most canonical first:
 *   - TARGET exists  → realpath the target ITSELF. This is where the read side
 *     must go further than the write side: an output is being created, so only
 *     its parent can be canonicalized, but an input is being READ, so the leaf
 *     is resolvable — and a symlink AT the leaf (`<owned>/patch.txt` →
 *     `/etc/passwd`) is exactly the read-side attack. Parent-only resolution
 *     accepts it, since the parent is honest and the filename is appended
 *     verbatim.
 *   - parent EXISTS  → realpath the parent and reattach the name, so an ancestor
 *     symlink cannot launder an escape into a false allow;
 *   - parent ENOENT  → compare lexically. A path that cannot be resolved cannot
 *     be symlink-checked, and comparing lexical-to-lexical avoids false rejects
 *     when the base itself is reached through a symlink (e.g. macOS `/tmp`).
 *     A missing input is legal here — the binding stamp hashes it as '' — so
 *     this branch is ordinary, not exceptional.
 * The first two tiers compare against the realpath'd base, the third against the
 * lexical one; mixing canonical against lexical is what produces false rejects.
 *
 * Returns the plain `join(base, name)`, NOT the realpath'd form: the resolved
 * path is used for the confinement test only. Callers (and their error
 * messages) keep seeing the path the flow declared, and a legitimate symlink
 * INSIDE the scope is still read through the name the flow chose.
 */
function confineToBase(base: string, name: string, label: string): string {
  const lexicalBase = resolve(base);
  const lexicalTarget = resolve(join(base, name));

  let resolvedTarget = lexicalTarget;
  let canonical = false;
  try {
    resolvedTarget = realpathSync(lexicalTarget);
    canonical = true;
  } catch {
    const parentDir = join(lexicalTarget, '..');
    try {
      const resolvedParent = realpathSync(parentDir);
      const fileName = lexicalTarget.slice(parentDir.length).replace(/^[\\/]+/, '');
      resolvedTarget = join(resolvedParent, fileName);
      canonical = true;
    } catch {
      // Neither the target nor its parent exists — fall through to the lexical check.
    }
  }

  const rootForCheck = canonical
    ? (() => {
        try {
          return realpathSync(base);
        } catch {
          return lexicalBase;
        }
      })()
    : lexicalBase;

  if (resolvedTarget !== rootForCheck && !resolvedTarget.startsWith(rootForCheck + sep)) {
    throw new Error(
      `Input "${name}" resolves outside the ${label} '${rootForCheck}'. ` +
        `Declared input names must not traverse above the directory they are scoped to.`,
    );
  }

  return join(base, name);
}
