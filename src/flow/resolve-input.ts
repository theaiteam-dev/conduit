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

import { join } from 'node:path';

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
 * A card-scoped name on a card with NO owned dir falls back to projectRoot
 * rather than throwing, because the two callers want different failure shapes
 * from the same unresolvable input (both preserved from the seed behavior this
 * generalizes):
 *   - the binding stamp hashes a missing file as '' — a card that cannot supply
 *     the input still gets a stamp, and the difference still invalidates;
 *   - `renderPrompt` FAILS CLOSED, throwing before it would substitute a
 *     project-root file for the per-child one the template asked for.
 * The fail-closed guard therefore lives in render.ts, ahead of this call.
 *
 * @param name           - Declared input artifact name.
 * @param projectRoot    - Absolute project root (the default scope).
 * @param ownedPaths     - The card's owned paths; `[0]` is the child dir.
 * @param ownedDirInputs - The station's `input_scope.owned_dir` list.
 */
export function resolveInputPath(
  name: string,
  projectRoot: string,
  ownedPaths?: readonly string[],
  ownedDirInputs?: readonly string[],
): string {
  const ownedDir = ownedPaths?.[0];
  if (ownedDir !== undefined && isCardScoped(name, ownedDirInputs)) {
    return join(ownedDir, name);
  }
  return join(projectRoot, name);
}
