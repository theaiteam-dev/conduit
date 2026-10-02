/**
 * Journal schema gaps found by the War Room (issue #89, PRD FR-13).
 *
 * Every datum the War Room is designed to show but the journal and state DB do
 * not record is listed here. Where one of these is missing, the view renders
 * "not recorded" and the projection names the gap in `WatchView.gaps`, so the
 * TUI can report the gaps a run hit when it exits. The War Room never writes,
 * so this module plus that exit report is the gap log; triage of each entry
 * into the journal schema happens before the kaizen PRD moves to ready.
 *
 * `location` is where the datum would live if it were recorded.
 */

export type SchemaGapId =
  | 'card-log-timestamp'
  | 'cross-table-order'
  | 'kernel-heartbeat'
  | 'run-end-time'
  | 'plan-quota'
  | 'card-title'
  | 'status-history'
  | 'deterministic-span'
  | 'worker-activity-history'
  | 'flow-at-run'
  | 'hold-timeout-policy'
  | 'finding-severity';

export interface SchemaGap {
  id: SchemaGapId;
  /** What the War Room wants to show. */
  datum: string;
  /** Where the datum would be recorded. */
  location: string;
  /** What the TUI renders today in its place. */
  renders: string;
}

export const JOURNAL_SCHEMA_GAPS: readonly SchemaGap[] = [
  {
    id: 'card-log-timestamp',
    datum: 'when a card entered a lane',
    location: 'card_log (no time column)',
    renders:
      'no time axis; a done card shows ✓ without a duration; when no worker is active the ' +
      'watchdog meter measures the age of the newest journal span instead of time since the last lane change',
  },
  {
    id: 'cross-table-order',
    datum: 'one order across card_log, journal and harness_events',
    location: 'a shared sequence or a timestamp on every journal table',
    renders:
      'replay positions are counted in the order the reader received rows; the projection ' +
      'is built so the final view does not depend on how the three tables interleave',
  },
  {
    id: 'kernel-heartbeat',
    datum: 'whether the kernel driving the run is alive (FR-14)',
    location: 'a run-level heartbeat row in the journal',
    renders: '"kernel not observed" in the header',
  },
  {
    id: 'run-end-time',
    datum: 'when a finished or halted run stopped',
    location: 'runs (no ended_at column)',
    renders: 'the wall clock of a run that is not running reads "≥" the age of its newest journal span',
  },
  {
    id: 'plan-quota',
    datum: 'plan quota used in the 5-hour window',
    location: 'harness_events rate-limit rows (only harness adapters that report windows write them)',
    renders: '"QUOTA 5h not recorded"',
  },
  {
    id: 'card-title',
    datum: 'a short human name for each card',
    location: 'cards (no title column)',
    renders: 'the card id only',
  },
  {
    id: 'status-history',
    datum: "a card's status (ready, claimed, working) over time",
    location: 'card_log records lane changes only; status lives in the state DB',
    renders: 'in replay, the state column shows the lane-derived state; working and ready read "lane"',
  },
  {
    id: 'deterministic-span',
    datum: 'a span for each deterministic station execution',
    location: 'journal (deterministic stations write none)',
    renders: 'no last-call detail for a card at a deterministic station',
  },
  {
    id: 'worker-activity-history',
    datum: 'whether a worker held a card, or a card was release-gated, at a past point in the run',
    location: 'active_workers and cards.release_at hold the present only; the journal records neither over time',
    renders: 'in replay the WATCHDOG meter reads "not recorded"',
  },
  {
    id: 'flow-at-run',
    datum: 'the flow definition the run started with (budgets, rework caps, station order)',
    location: 'runs stores the flow path and an input fingerprint, not the flow version or a copy',
    renders: 'budgets and caps are read from the flow file as it is now; when it cannot be read they render "not recorded"',
  },
  {
    id: 'hold-timeout-policy',
    datum: "a held card's timeout and on_timeout policy",
    location: 'hitl.held_at span (records held_at only)',
    renders: '"on_timeout not recorded"',
  },
  {
    id: 'finding-severity',
    datum: 'severity of a gate finding',
    location: 'card_log.findings_json (plain strings)',
    renders: 'findings without severity',
  },
];

/** Look up one catalogued gap. */
export function schemaGap(id: SchemaGapId): SchemaGap {
  const gap = JOURNAL_SCHEMA_GAPS.find((g) => g.id === id);
  if (gap === undefined) throw new Error(`unknown schema gap '${id}'`);
  return gap;
}

/** The exit report: one line per gap the run hit, in catalogue order. */
export function formatGapReport(runId: string, hit: Iterable<SchemaGapId>): string[] {
  const ids = new Set(hit);
  if (ids.size === 0) return [];
  const lines = [`conduit watch: journal schema gaps seen in run ${runId} (PRD FR-13):`];
  for (const gap of JOURNAL_SCHEMA_GAPS) {
    if (!ids.has(gap.id)) continue;
    lines.push(`  ${gap.id}: ${gap.datum}. Would be recorded in: ${gap.location}.`);
  }
  return lines;
}
