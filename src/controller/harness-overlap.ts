/**
 * Overlapping harness calls (issue #30, ADR-0012, SPEC §7 "Overlapping harness
 * calls").
 *
 * A `kind: harness` station that declares `overlap: true` may run several cards
 * at once under `conduit run --concurrency K>1`. The mandatory harness
 * integrity check diffs the whole project root around each call, so under
 * overlap one member's diff also contains every write a concurrent member made.
 * This module holds the pieces the executor needs to tell those apart:
 *
 *   - `isOverlapHarnessStation`: the static admission conditions, re-checked at
 *     dispatch (the loader already rejected a station that fails them).
 *   - `canonicalOwnedPaths` / `ownedPathSetsIntersect`: the dynamic disjointness
 *     condition between batch members.
 *   - `OverlapWindows`: each member's window, from just before its baseline
 *     snapshot starts to just after its post-invoke snapshot ends, on a logical
 *     clock, and which other members' windows intersected it.
 *   - `classifyOverlapTouched`: drops from a member's touched set every path
 *     inside the owned paths of a member whose window intersected its own, and
 *     reports those paths per member. Everything else is left for the serial
 *     integrity check to judge unchanged.
 */
import { isAbsolute, join } from 'node:path';
import type { StationConfig } from '../types/kernel';
import { isContainedIn, resolveOwnedPath } from '../worker/integrity';

/**
 * The static admission conditions (ADR-0012, conditions 1 to 5 and 7). The
 * adapter condition (6) needs the registry and is checked by the caller. Kept
 * in step with `validateOverlap` in flow/load.ts, which rejects a station that
 * fails any of these at load.
 */
export function isOverlapHarnessStation(stationConfig: StationConfig, enforceOwnedPaths: boolean): boolean {
  return (
    stationConfig.kind === 'harness' &&
    stationConfig.overlap === true &&
    stationConfig.gateCheck === undefined &&
    stationConfig.rankCheck === undefined &&
    !stationConfig.effectful &&
    stationConfig.fan_out === undefined &&
    stationConfig.child_entry === undefined &&
    stationConfig.deliver === undefined &&
    enforceOwnedPaths
  );
}

/**
 * A card's owned paths as canonical absolute paths, through the same resolver
 * `checkIntegrity` uses for its owned set, so the dispatch disjointness check
 * and the integrity attribution compare paths on the same footing.
 */
export function canonicalOwnedPaths(projectRoot: string, ownedPaths: readonly string[]): string[] {
  return ownedPaths.map((p) => resolveOwnedPath(isAbsolute(p) ? p : join(projectRoot, p)));
}

/** True when some path in `a` equals, contains, or lies inside some path in `b`. */
export function ownedPathSetsIntersect(a: readonly string[], b: readonly string[]): boolean {
  return a.some((x) => b.some((y) => isContainedIn(x, y) || isContainedIn(y, x)));
}

interface OverlapWindow {
  cardId: string;
  ownedCanonical: readonly string[];
  start: number;
  /** null while the window is open. */
  end: number | null;
}

/** An intersecting member, as the integrity rule needs it. */
export interface OverlapSibling {
  cardId: string;
  ownedCanonical: readonly string[];
}

/**
 * The recorded windows of one overlap batch. Times come from a logical clock
 * (a counter incremented on every open and close), so two events are always
 * ordered, which a millisecond timestamp does not guarantee.
 *
 * A window is opened before the member's baseline snapshot starts reading the
 * tree and closed after its post-invoke snapshot finishes, or when its invoke
 * throws (the adapter has killed the call's process tree by then). A member
 * writes only while its call runs, which lies inside its window, and a write
 * that shows up in member M's diff happened inside M's window. So any member
 * whose write can appear in M's diff has a window that intersects M's. A
 * window left open counts as intersecting every later window, which can only
 * attribute more, never hide a path no member owns.
 */
export class OverlapWindows {
  private clock = 0;
  private readonly windows: OverlapWindow[] = [];

  /** Open a window for one attempt of `cardId`; returns its handle. */
  open(cardId: string, ownedCanonical: readonly string[]): number {
    this.windows.push({ cardId, ownedCanonical, start: ++this.clock, end: null });
    return this.windows.length - 1;
  }

  /** Close a window. Closing one twice keeps the first end. */
  close(handle: number): void {
    const w = this.windows[handle];
    if (w !== undefined && w.end === null) w.end = ++this.clock;
  }

  /**
   * The other cards whose windows intersected window `handle`, one entry per
   * card (a card that retried has several windows). Call after `close(handle)`.
   */
  intersecting(handle: number): OverlapSibling[] {
    const self = this.windows[handle];
    if (self === undefined) return [];
    const selfEnd = self.end ?? Number.POSITIVE_INFINITY;
    const seen = new Map<string, OverlapSibling>();
    for (const w of this.windows) {
      if (w.cardId === self.cardId) continue;
      const wEnd = w.end ?? Number.POSITIVE_INFINITY;
      if (w.start < selfEnd && self.start < wEnd && !seen.has(w.cardId)) {
        seen.set(w.cardId, { cardId: w.cardId, ownedCanonical: w.ownedCanonical });
      }
    }
    return [...seen.values()];
  }
}

/** Attribution of one member's diff: what is left to check, and what went to whom. */
export interface OverlapClassification {
  /** Touched paths the serial integrity check still judges, in input order. */
  remaining: string[];
  /** Per sibling, how many touched paths lay inside its owned paths. Sorted by card id. */
  attributed: Array<{ card: string; paths: number }>;
}

/**
 * Apply the overlap integrity rule to one member's touched set.
 *
 * A touched path is attributed, and dropped from the set, only when it lies
 * outside the member's own owned paths and inside the owned paths of a member
 * whose window intersected this one. Paths are canonicalized with
 * `resolveOwnedPath`, the resolver `checkIntegrity` uses: a symlink resolves to
 * its target, and a path removed since the snapshot (a sibling deleting a temp
 * file in its own dir) resolves through its parent dir. Every other path is
 * returned unchanged: a path inside the member's own owned paths passes the
 * serial check as before, and a path no intersecting member owns fails it as
 * before.
 */
export function classifyOverlapTouched(
  projectRoot: string,
  ownCanonical: readonly string[],
  touchedPaths: readonly string[],
  siblings: readonly OverlapSibling[],
): OverlapClassification {
  const remaining: string[] = [];
  const counts = new Map<string, number>();
  for (const touched of touchedPaths) {
    const canonical = resolveOwnedPath(isAbsolute(touched) ? touched : join(projectRoot, touched));
    if (ownCanonical.some((owned) => isContainedIn(canonical, owned))) {
      remaining.push(touched);
      continue;
    }
    // Disjoint ownership (SPEC §9, dispatch condition 9) means at most one
    // sibling owns the path.
    const owner = siblings.find((s) => s.ownedCanonical.some((owned) => isContainedIn(canonical, owned)));
    if (owner === undefined) {
      remaining.push(touched);
      continue;
    }
    counts.set(owner.cardId, (counts.get(owner.cardId) ?? 0) + 1);
  }
  const attributed = [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([card, paths]) => ({ card, paths }));
  return { remaining, attributed };
}
