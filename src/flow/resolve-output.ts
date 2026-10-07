/**
 * Declared-output resolution: the ONE place that decides where a station's
 * declared outputs live on disk (issue #98).
 *
 * A station's declared outputs live at `<projectRoot>/<name>` by default.
 * `output_scope: owned_dir` moves every one of them into the card's owned
 * directory (`owned_paths[0]`, where the per-child `seed.json` lives), so N
 * sibling fan-out children that share one station definition each produce
 * their own files instead of overwriting one shared name (SPEC §9: outputs are
 * disjoint across concurrent cards).
 *
 * Every caller that needs a declared output's location goes through here:
 *   - the transform writer (it writes the payload itself);
 *   - the harness maker: the paths it tells the agent to write, the stale-file
 *     removal before each attempt, the presence check, the JSON/schema read of
 *     `outputs[0]`, and the artifact hashes on its journal span;
 *   - the gate critic, which reads the maker's outputs through
 *     `cardScopedArtifactNames` (an owned-dir output is a card-scoped name for
 *     `resolveInputPath`, which joins it to the same directory this module does);
 *   - downstream stations, which read a card-scoped output by listing it in
 *     their own `input_scope.owned_dir`;
 *   - `deliver.files`, where an entry that names a card-scoped declared output
 *     is delivered from the card's directory.
 * Two hand-written `join()`s can disagree about a file's location. Calls to one
 * function cannot, which is the lesson issue #51 recorded for inputs.
 */

import { realpathSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { SEED_INPUT } from './resolve-input';

/** Where a station's declared outputs live. Absent means `project_root`. */
export type OutputScope = 'project_root' | 'owned_dir';

/** One declared output and the absolute path it resolves to. */
export interface ResolvedOutput {
  name: string;
  path: string;
}

/** The station fields output resolution reads. */
export interface OutputScopedStation {
  outputs: readonly string[];
  output_scope?: OutputScope;
  input_scope?: { owned_dir: string[] };
}

export interface ResolveOutputOptions {
  /**
   * Require the card's directory to be inside `projectRoot` (after resolving
   * symlinks). The harness path sets it: its mandatory integrity check
   * snapshots only `projectRoot`, so a write to an owned directory outside it
   * would never be seen, and the per-call gate confines writes to the project
   * root as well. The transform path, where the kernel performs the write
   * itself, does not need it.
   */
  requireWithinProjectRoot?: boolean;
}

/** True when the station's declared outputs resolve from the card's owned dir. */
export function isOutputCardScoped(station: Pick<OutputScopedStation, 'output_scope'>): boolean {
  return station.output_scope === 'owned_dir';
}

/**
 * Every artifact name of `station` that resolves from the card's owned dir:
 * its `input_scope.owned_dir` list, plus all of its declared outputs when it
 * declares `output_scope: owned_dir`.
 *
 * Pass this as the `ownedDirInputs` of `resolveInputPath` or `renderPrompt`
 * wherever a reader sees the station's outputs as well as its inputs: the gate
 * critic, whose scope is the station's inputs plus outputs. The reserved
 * `seed.json` is not listed; `resolveInputPath` adds it on its own.
 */
export function cardScopedArtifactNames(station: OutputScopedStation): string[] {
  const names = [...(station.input_scope?.owned_dir ?? [])];
  if (isOutputCardScoped(station)) {
    for (const name of station.outputs) {
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}

/**
 * Absolute directory a station's declared outputs resolve from.
 *
 * `project_root` (or absent) returns `projectRoot` unchanged. `owned_dir`
 * returns `resolve(projectRoot, ownedPaths[0])`, the same base
 * `resolveInputPath` uses for card-scoped inputs, and FAILS CLOSED: a card with
 * no owned path, or whose first owned path is not an existing directory,
 * throws. It never falls back to `projectRoot`, because the project-root file
 * of the same name is exactly the shared artifact a sibling may also be using.
 *
 * @throws When the scope is `owned_dir` and the owned directory is absent, not
 *         a directory, or (with `requireWithinProjectRoot`) outside the root.
 */
export function resolveOutputBase(
  projectRoot: string,
  ownedPaths: readonly string[] | undefined,
  scope: OutputScope | undefined,
  options: ResolveOutputOptions = {},
): string {
  if (scope !== 'owned_dir') return projectRoot;

  const owned = ownedPaths?.[0];
  if (owned === undefined || owned.trim() === '') {
    throw new Error(
      `output_scope: owned_dir needs the card's owned_paths[0], but this card has no owned_paths. ` +
        `Refusing to fall back to the project-root output of the same name.`,
    );
  }
  const ownedDir = resolve(projectRoot, owned);
  let isDir = false;
  try {
    isDir = statSync(ownedDir).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    throw new Error(
      `output_scope: owned_dir needs the card's owned_paths[0] '${owned}' to be an existing directory, ` +
        `and it is not. Create it before the card runs (the same rule as the per-child seed).`,
    );
  }

  if (options.requireWithinProjectRoot === true) {
    const canonicalRoot = canonical(projectRoot);
    const canonicalDir = canonical(ownedDir);
    if (canonicalDir !== canonicalRoot && !canonicalDir.startsWith(canonicalRoot + sep)) {
      throw new Error(
        `output_scope: owned_dir needs the card's owned_paths[0] '${owned}' to be inside the project root ` +
          `'${canonicalRoot}', and it resolves to '${canonicalDir}'. The harness integrity check sees only ` +
          `the project root, so it could not check writes there.`,
      );
    }
  }
  return ownedDir;
}

/**
 * Resolve every declared output of `station` for one card, in declared order.
 *
 * Each path is confined to its base with the write-side guard (see
 * `confineOutput`): a name that escapes, lexically or through a symlinked
 * ancestor, throws. Callers that run before any work (the harness maker) turn
 * the throw into a hold, so the card never runs against an output path it
 * could not be checked against.
 *
 * @throws See `resolveOutputBase` and `confineOutput`.
 */
export function resolveDeclaredOutputs(
  station: OutputScopedStation,
  projectRoot: string,
  ownedPaths: readonly string[] | undefined,
  options: ResolveOutputOptions = {},
): ResolvedOutput[] {
  const base = resolveOutputBase(projectRoot, ownedPaths, station.output_scope, options);
  const label = isOutputCardScoped(station) ? 'owned directory' : 'project root';
  return station.outputs.map((name) => ({ name, path: confineOutput(base, name, label) }));
}

/**
 * The path a `deliver.files` entry is read from, relative to `projectRoot`.
 *
 * An entry that names one of the station's declared outputs follows that
 * output's scope, so a card-scoped output is delivered from the card's own
 * directory. Any other entry is returned unchanged and stays a
 * project-root-relative path. The caller's existing containment checks
 * (project root, owned_paths) then run on the returned path.
 *
 * @throws When the entry names a card-scoped output and the card's directory
 *         cannot be resolved (see `resolveDeclaredOutputs`).
 */
export function resolveDeliverFile(
  file: string,
  station: OutputScopedStation,
  projectRoot: string,
  ownedPaths: readonly string[] | undefined,
): string {
  if (!isOutputCardScoped(station) || !station.outputs.includes(file)) return file;
  const resolved = resolveDeclaredOutputs(station, projectRoot, ownedPaths).find((o) => o.name === file)!;
  const root = resolve(projectRoot);
  return resolved.path.startsWith(root + sep) ? resolved.path.slice(root.length + 1) : resolved.path;
}

/**
 * Names that a harness station may not declare as `output_scope: owned_dir`
 * outputs: its card-scoped inputs and the reserved seed. The kernel removes a
 * card-scoped harness output before every attempt (the freshness rule), so an
 * output that is also a card-scoped input would delete that input before the
 * agent could read it. Used by the loader.
 */
export function harnessOutputInputOverlap(station: OutputScopedStation): string[] {
  if (!isOutputCardScoped(station)) return [];
  const scopedInputs = new Set([...(station.input_scope?.owned_dir ?? []), SEED_INPUT]);
  return station.outputs.filter((name) => scopedInputs.has(name));
}

/**
 * Text appended to a harness prompt when its outputs are card-scoped, naming
 * the absolute path of each declared output. The flow's template does not have
 * to know or guess the card's directory: the kernel states it.
 */
export function describeOutputDestinations(outputs: readonly ResolvedOutput[]): string {
  const lines = outputs.map((o) => `- ${o.name}: ${o.path}`);
  return (
    `\n\n## Output files\n` +
    `Write each declared output to the path below. The kernel reads them from these paths only, ` +
    `and a file left at any other path is not collected.\n` +
    lines.join('\n') +
    '\n'
  );
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Assert that `<base>/<name>` stays inside `base` and return the joined path.
 *
 * The WRITE-side guard, moved here unchanged from the transform writer (Issue
 * C). An output is about to be created, so only its parent can be resolved:
 *   - parent EXISTS → realpath the parent and reattach the name, so a
 *     symlinked ancestor cannot turn an escape into an allow; compare against
 *     the realpath'd base.
 *   - parent ENOENT → compare lexically against the lexical base, so a new
 *     subdirectory under a base reached through a symlink (macOS `/tmp`) is
 *     not falsely rejected.
 * The read side (`resolve-input.ts` `confineToBase`) additionally resolves the
 * leaf, because an input already exists.
 */
function confineOutput(base: string, name: string, label: string): string {
  const lexicalBase = resolve(base);
  const lexicalTarget = resolve(join(base, name));
  const parentDir = join(lexicalTarget, '..');

  let resolvedTarget = lexicalTarget;
  let parentExists = false;
  try {
    const resolvedParent = realpathSync(parentDir);
    const fileName = lexicalTarget.slice(parentDir.length).replace(/^[\\/]+/, '');
    resolvedTarget = join(resolvedParent, fileName);
    parentExists = true;
  } catch {
    // Parent does not exist yet: the lexical comparison below applies.
  }

  const rootForCheck = parentExists ? canonical(base) : lexicalBase;
  if (resolvedTarget !== rootForCheck && !resolvedTarget.startsWith(rootForCheck + sep)) {
    throw new Error(
      `Output path '${name}' resolves outside the ${label} '${rootForCheck}'. ` +
        `Declared output paths must not traverse above the directory they are scoped to.`,
    );
  }
  return join(base, name);
}
