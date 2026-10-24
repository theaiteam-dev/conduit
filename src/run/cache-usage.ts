/**
 * Issue #156: cache-read figures per station, read from a run's own journal,
 * for `conduit run status`, and the per-span split `conduit journal inspect`
 * prints.
 *
 * Every span with usage counts toward its station's call count: transform
 * makers and critics, harness makers and critics, subflow roll-ups. Only a
 * span that records a cache split (`cache_read_input_tokens` not NULL)
 * contributes to the figure. Under the issue #5 convention such a span's
 * `input_tokens` is UNCACHED input, so
 *
 *   input = uncached input + cache reads + cache creation
 *   share = cache reads / input
 *
 * A span with NULL cache columns (a journal older than the split, or an
 * adapter that reports none, such as a subflow roll-up) adds no figure: its
 * `input_tokens` may already include cached tokens, so folding it into the
 * denominator would understate the share. A station whose spans all lack a
 * split prints "no cache figure", never 0%.
 *
 * Cache creation is printed only when some split span reported it: the
 * transform adapter reports cache reads alone, and a NULL there means "not
 * reported", not zero.
 */
import type { ConduitDB } from '../persistence/db';

export interface StationCacheUsage {
  station: string;
  /** Spans with usage at this station. */
  calls: number;
  /** Of those, spans that record a cache split. */
  splitCalls: number;
  /** Summed over split spans only. */
  uncachedInputTokens: number;
  cacheReadInputTokens: number;
  /** Summed over split spans that reported it; null when none did. */
  cacheCreationInputTokens: number | null;
}

export interface CacheUsage {
  stations: StationCacheUsage[];
}

/** Aggregate a run's usage spans per station. Null when the run has none. */
export function getCacheUsage(db: ConduitDB, runId: string): CacheUsage | null {
  const spans = db.getSpanTokenUsageForRun(runId);
  if (spans.length === 0) return null;
  const byStation = new Map<string, StationCacheUsage>();
  for (const span of spans) {
    let entry = byStation.get(span.station);
    if (entry === undefined) {
      entry = {
        station: span.station, calls: 0, splitCalls: 0,
        uncachedInputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: null,
      };
      byStation.set(span.station, entry);
    }
    entry.calls++;
    if (span.cacheReadInputTokens === null) continue;
    entry.splitCalls++;
    entry.uncachedInputTokens += span.inputTokens;
    entry.cacheReadInputTokens += span.cacheReadInputTokens;
    if (span.cacheCreationInputTokens !== null) {
      entry.cacheCreationInputTokens = (entry.cacheCreationInputTokens ?? 0) + span.cacheCreationInputTokens;
    }
  }
  return { stations: [...byStation.values()].sort((a, b) => a.station.localeCompare(b.station)) };
}

/** "cache read R of N input tokens (S%)[, cache creation C]". */
function splitText(uncached: number, cacheRead: number, cacheCreation: number | null): string {
  const input = uncached + cacheRead + (cacheCreation ?? 0);
  const share = input === 0 ? 'n/a' : `${((cacheRead / input) * 100).toFixed(1)}%`;
  const creation = cacheCreation === null ? '' : `, cache creation ${cacheCreation}`;
  return `cache read ${cacheRead} of ${input} input tokens (${share})${creation}`;
}

/** Render the cache report as lines for `conduit run status`. */
export function formatCacheUsage(report: CacheUsage): string[] {
  const lines = ['cache reads (share of input = cache reads / (uncached input + cache reads + cache creation)):'];
  for (const s of report.stations) {
    if (s.splitCalls === 0) {
      lines.push(`  ${s.station}: no cache figure, ${s.calls} call(s)`);
      continue;
    }
    const unsplit = s.calls - s.splitCalls;
    const missing = unsplit > 0 ? `, ${unsplit} with no cache figure` : '';
    lines.push(
      `  ${s.station}: ${splitText(s.uncachedInputTokens, s.cacheReadInputTokens, s.cacheCreationInputTokens)}, ` +
        `${s.calls} call(s)${missing}`,
    );
  }
  return lines;
}

/** One span's split for `journal inspect`, or null when the span records none. */
export function formatSpanCacheSplit(span: {
  inputTokens?: number | null;
  cacheReadInputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
}): string | null {
  if (span.cacheReadInputTokens == null || span.inputTokens == null) return null;
  return splitText(span.inputTokens, span.cacheReadInputTokens, span.cacheCreationInputTokens ?? null);
}
