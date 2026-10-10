/**
 * MARK_DONE integrity Summary Hook (WI-297, SPEC §5 step 4, FR-7).
 *
 * The integrity half of the quality system — pure, sync, no LLM. Runs in the
 * DONE transaction BEFORE commit+checkpoint to verify:
 *   1. Every touched file resolves (symlinks + ../ traversal → canonical absolute)
 *      INSIDE the card's owned_paths. Escapes (including via symlink) are failures.
 *   2. The output schema validates.
 *   3. Every declared artifact actually exists on disk.
 *
 * A failed integrity check blocks the checkpoint and signals INTEGRITY_FAIL to the
 * FSM (WI-293), which attributes the retry to the EXECUTION-ATTEMPT counter, not the
 * rework counter.
 */

import { realpathSync, existsSync } from 'node:fs';
import { join, isAbsolute, dirname, relative, resolve, sep } from 'node:path';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface IntegrityInput {
  /** Canonical project root — all relative paths are resolved against this. */
  projectRoot: string;
  /** Paths the card is permitted to write, relative to projectRoot or absolute. */
  ownedPaths: readonly string[];
  /** Paths the station wrote or touched during this execution attempt. */
  touchedPaths: readonly string[];
  /**
   * Paths that existed before this execution attempt and are gone after it.
   * A delete is a write (SPEC §7), so each must lie inside owned_paths too.
   */
  deletedPaths?: readonly string[];
  /** Output artifacts that MUST exist after the station completes. */
  declaredArtifacts: readonly string[];
  /** The station's typed output value. */
  output: unknown;
  /**
   * Injected schema validator — returns true when the output is structurally
   * valid.  No LLM, no network — pure code or a compiled schema check.
   */
  validateOutput: (output: unknown) => boolean;
}

export type IntegrityFailure =
  | { code: 'path_escape'; path: string }
  | { code: 'missing_artifact'; path: string }
  | { code: 'schema_invalid' };

export type IntegrityResult =
  | { ok: true }
  | { ok: false; failures: IntegrityFailure[] };

export interface MarkDoneOutcome {
  event: 'INTEGRITY_PASS' | 'INTEGRITY_FAIL';
  /**
   * True only when integrity passes.  A failed check blocks the checkpoint
   * (fail → checkpointed: false).
   */
  checkpointed: boolean;
  integrity: IntegrityResult;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve a path to an absolute path under projectRoot (handles relative + absolute). */
function toAbsolute(projectRoot: string, path: string): string {
  return isAbsolute(path) ? path : join(projectRoot, path);
}

/**
 * Canonicalise an absolute path by resolving symlinks.
 * Returns null if the path does not exist on disk (unreachable).
 */
function tryRealpath(absPath: string): string | null {
  try {
    return realpathSync(absPath);
  } catch {
    return null;
  }
}

/**
 * Canonicalise an owned path that may name a not-yet-created leaf.
 *
 * Touched paths must exist (the station just wrote them), so they canonicalise
 * directly via realpathSync. Owned paths, however, are a DECLARATION — the leaf
 * (or several trailing components) need not exist yet. Falling back to the raw
 * lexical path (the previous behaviour) is asymmetric: a resolved touched path is
 * compared against an UNRESOLVED owned path, so a symlink in any existing ancestor
 * of the owned path is ignored. That can spuriously deny a legitimate write (when
 * the ancestor symlink points back into the owned area) OR, if an attacker controls
 * that ancestor symlink, launder an escape into a spurious allow.
 *
 * Fix: resolve the LONGEST EXISTING PREFIX. Walk up parent components until
 * realpathSync succeeds, then re-append the remaining (non-existent) lexical tail
 * to that resolved prefix. Symlinks in every existing ancestor are thus resolved
 * even when the leaf does not exist yet — putting owned and touched paths on the
 * same canonical footing.
 */
export function resolveOwnedPath(absPath: string): string {
  // Fast path: the whole path already exists on disk.
  const direct = tryRealpath(absPath);
  if (direct !== null) return direct;

  // Walk up to the longest existing prefix, collecting the lexical tail.
  const tail: string[] = [];
  let cur = absPath;
  for (;;) {
    const parent = dirname(cur);
    // dirname is idempotent at the filesystem root ('/' → '/', 'C:\\' → 'C:\\').
    // No existing ancestor resolved — fall back to the lexical absolute path.
    if (parent === cur) return absPath;

    tail.unshift(cur.slice(parent.length + 1)); // the component between parent and cur
    const resolvedParent = tryRealpath(parent);
    if (resolvedParent !== null) {
      return join(resolvedParent, ...tail);
    }
    cur = parent;
  }
}

/**
 * Map a path under projectRoot to the canonical project root plus its lexical
 * remainder, resolving no symlink below the root. Returns null for a path
 * outside projectRoot.
 *
 * A deleted path can no longer be canonicalised by realpath. It is checked at
 * the location it had in the baseline snapshot instead: the snapshot walk never
 * descends a symlink, so every component of a recorded path below the root was
 * a real directory when the baseline was taken. Resolving symlinks now would
 * let a call delete a sibling's file and then swap the sibling's directory for
 * a symlink into its own owned dir, so that the deleted path appears to be
 * inside it.
 */
function lexicalUnderRoot(canonicalRoot: string, projectRoot: string, absPath: string): string | null {
  for (const root of [projectRoot, canonicalRoot]) {
    const rel = relative(root, resolve(absPath));
    if (rel === '') return canonicalRoot;
    if (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)) return join(canonicalRoot, rel);
  }
  return null;
}

/** True when `target` is equal to `ownedDir` or is contained within it. */
export function isContainedIn(target: string, ownedDir: string): boolean {
  return target === ownedDir || target.startsWith(ownedDir + '/');
}

// ---------------------------------------------------------------------------
// checkIntegrity — pure, synchronous, no LLM
// ---------------------------------------------------------------------------

/**
 * Run all integrity checks and collect every failure.
 *
 * Pure and deterministic: reads filesystem state but never mutates the input
 * or any external state.  All failures are collected before returning (the
 * caller can inspect every violation in a single pass).
 */
export function checkIntegrity(input: IntegrityInput): IntegrityResult {
  const failures: IntegrityFailure[] = [];

  // Resolve owned paths to canonical absolutes once (upfront). Owned leaves need
  // not exist yet, so resolve the longest existing prefix and re-append the lexical
  // tail — keeping owned paths on the SAME canonical footing as the (resolved)
  // touched paths below (Should #18: no asymmetric symlink resolution).
  const canonicalOwned = input.ownedPaths.map((p) =>
    resolveOwnedPath(toAbsolute(input.projectRoot, p)),
  );

  // ── 1. Path ownership (SPEC §7 path-ownership equivalent for deterministic) ──
  for (const touched of input.touchedPaths) {
    const abs = toAbsolute(input.projectRoot, touched);
    const canonical = tryRealpath(abs);

    if (canonical === null) {
      // Path does not exist or is unreachable — cannot verify ownership.
      failures.push({ code: 'path_escape', path: touched });
      continue;
    }

    const inside = canonicalOwned.some((owned) => isContainedIn(canonical, owned));
    if (!inside) {
      failures.push({ code: 'path_escape', path: touched });
    }
  }

  // ── 1b. Deleted paths, checked lexically against the baseline layout ──────
  // Owned paths are compared lexically too, for the same reason: a call could
  // otherwise replace its own (empty) owned dir with a symlink to a sibling's
  // dir and make the sibling's deleted files look owned. An owned path reached
  // through a symlink below the root therefore fails closed here.
  const deleted = input.deletedPaths ?? [];
  if (deleted.length > 0) {
    const canonicalRoot = tryRealpath(input.projectRoot) ?? resolve(input.projectRoot);
    const lexicalOwned = input.ownedPaths
      .map((p) => lexicalUnderRoot(canonicalRoot, input.projectRoot, toAbsolute(input.projectRoot, p)))
      .filter((p): p is string => p !== null);
    for (const path of deleted) {
      const location = lexicalUnderRoot(canonicalRoot, input.projectRoot, toAbsolute(input.projectRoot, path));
      if (location === null || !lexicalOwned.some((owned) => isContainedIn(location, owned))) {
        failures.push({ code: 'path_escape', path });
      }
    }
  }

  // ── 2. Declared artifact existence ────────────────────────────────────────
  for (const artifact of input.declaredArtifacts) {
    const abs = toAbsolute(input.projectRoot, artifact);
    if (!existsSync(abs)) {
      failures.push({ code: 'missing_artifact', path: artifact });
    }
  }

  // ── 3. Output schema validation ───────────────────────────────────────────
  if (!input.validateOutput(input.output)) {
    failures.push({ code: 'schema_invalid' });
  }

  if (failures.length > 0) {
    return { ok: false, failures };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// runMarkDoneHook — summary hook that gates the checkpoint
// ---------------------------------------------------------------------------

/**
 * Run the MARK_DONE integrity check and determine whether the checkpoint may
 * be taken.
 *
 * - Pass → INTEGRITY_PASS + checkpointed: true
 * - Fail → INTEGRITY_FAIL + checkpointed: false  (blocks the commit)
 *
 * The execution-attempt counter increment is the FSM's responsibility
 * (WI-293 maps INTEGRITY_FAIL → executionAttempt++) — this function does not
 * touch any counters.
 */
export function runMarkDoneHook(input: IntegrityInput): MarkDoneOutcome {
  const integrity = checkIntegrity(input);

  if (integrity.ok) {
    return { event: 'INTEGRITY_PASS', checkpointed: true, integrity };
  }
  return { event: 'INTEGRITY_FAIL', checkpointed: false, integrity };
}
