/**
 * Per-invocation dirs under the OS temp dir that a confined call can write and
 * that may hold credential links (a Claude credentials file, a Codex auth.json,
 * an OpenCode provider entry). Each is removed by its adapter's `finally`, but a
 * kernel that is SIGKILLed or crashes runs no `finally`. So each dir is named
 * `<prefix><pid>-<start time>-<random>` after its owner, the same tag the
 * cgroups carry (`owner-tag.ts`), and the next kernel sweeps the ones whose
 * owner is gone, as `sweepStaleCgroups` does for cgroups.
 */
import { readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isOwnerPairGone, isPidAlive, processStartTime, tryOwnerTag } from './owner-tag';

export const CALL_TMP_PREFIX = 'conduit-call-tmp-';
export const CLAUDE_CONFIG_PREFIX = 'conduit-claude-config-';
export const CODEX_HOME_PREFIX = 'conduit-codex-home-';
export const OPENCODE_PREFIX = 'conduit-opencode-';

/** Every prefix the sweep covers. */
export const RUN_SCOPED_TEMP_PREFIXES: readonly string[] = [
  CALL_TMP_PREFIX,
  CLAUDE_CONFIG_PREFIX,
  CODEX_HOME_PREFIX,
  OPENCODE_PREFIX,
];

let warnedUntagged = false;

/** Test seam: let `taggedTempPrefix` warn again. */
export function resetUntaggedTempWarning(): void {
  warnedUntagged = false;
}

/**
 * `prefix` followed by this kernel's owner tag, for `mkdtemp` to add its random
 * suffix to. Plain `prefix` when the tag cannot be read, so creation never
 * fails because of tagging; such a dir is never swept, so the first time that
 * happens in a process it warns once on stderr.
 */
export function taggedTempPrefix(
  prefix: string,
  tryTag: () => string | undefined = tryOwnerTag,
  warn: (message: string) => void = (message) => process.stderr.write(message + '\n'),
): string {
  const tag = tryTag();
  if (tag !== undefined) return `${prefix}${tag}-`;
  if (!warnedUntagged) {
    warnedUntagged = true;
    warn(
      'conduit: cannot read this process start time from /proc, so run-scoped temp dirs (which may hold credential links) are created untagged and will not be swept after a crash',
    );
  }
  return prefix;
}

/** Injectable dependencies of `sweepStaleRunScopedDirs`, defaulted to the real ones in production. */
export interface SweepStaleDirsDeps {
  /** Directory to sweep. Defaults to `os.tmpdir()`. */
  tmpRoot?: string;
  /** Prefixes to sweep. Defaults to `RUN_SCOPED_TEMP_PREFIXES`. */
  prefixes?: readonly string[];
  selfPid?: number;
  selfStartTime?: number | undefined;
  isPidAlive?: (pid: number) => boolean;
  processStartTime?: (pid: number) => number | undefined;
  /** Removes one dir. Defaults to `rmSync(dir, { recursive: true, force: true })`. */
  rm?: (dir: string) => void;
}

/**
 * Remove the dirs under the temp root named `<prefix><pid>-<start time>-<suffix>`
 * whose owner is gone (`isOwnerPairGone`). Files, symlinks, untagged names,
 * this kernel's own, a live owner's and anything ambiguous are kept.
 * Best-effort: every fs error
 * (another user's dir in a shared /tmp, a race with another kernel's sweep) is
 * ignored. `rmSync` removes a symlink, not its target, so a credentials link is
 * dropped without touching the operator's file. Returns the removed paths.
 */
export function sweepStaleRunScopedDirs(deps: SweepStaleDirsDeps = {}): string[] {
  const removed: string[] = [];
  try {
    const root = deps.tmpRoot ?? tmpdir();
    const prefixes = deps.prefixes ?? RUN_SCOPED_TEMP_PREFIXES;
    const selfPid = deps.selfPid ?? process.pid;
    const resolved = {
      selfPid,
      selfStartTime: 'selfStartTime' in deps ? deps.selfStartTime : processStartTime(selfPid),
      isPidAlive: deps.isPidAlive ?? isPidAlive,
      processStartTime: deps.processStartTime ?? processStartTime,
    };
    const rm = deps.rm ?? ((dir: string) => rmSync(dir, { recursive: true, force: true }));
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      // Only mkdtemp makes these names, so anything but a real dir is not ours.
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      const prefix = prefixes.find((p) => name.startsWith(p));
      if (prefix === undefined) continue;
      const match = /^(\d+)-(\d+)-[^-]+$/.exec(name.slice(prefix.length));
      if (match === null) continue;
      try {
        if (!isOwnerPairGone(Number(match[1]), Number(match[2]), resolved)) continue;
        const dir = join(root, name);
        rm(dir);
        removed.push(dir);
      } catch {
        // Not ours to remove, or already gone.
      }
    }
  } catch {
    // Missing or unreadable temp root.
  }
  return removed;
}

let swept = false;

/** Run `sweepStaleRunScopedDirs` once per process. Later calls do nothing. */
export function sweepStaleRunScopedDirsOnce(): void {
  if (swept) return;
  swept = true;
  sweepStaleRunScopedDirs();
}

/** Test seam: let `sweepStaleRunScopedDirsOnce` run again. */
export function resetSweepStaleRunScopedDirsOnce(): void {
  swept = false;
}
