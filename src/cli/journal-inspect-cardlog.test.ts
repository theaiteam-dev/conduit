/**
 * WI-384 — `conduit journal inspect <cardId>` surfaces the card transition log.
 *
 * FR-9. The journal inspect command currently prints one line per journal span
 * (cmdJournal in src/cli/main.ts, ~lines 379-412). This item extends it so a
 * card's ordered transition log (card_log, from WI-378) is rendered for human
 * triage — answering "why is this card here?" when a card sits at scrap/hold.
 *
 * The card_log read surface (WI-378, already implemented on ConduitDB):
 *
 *   appendCardLog(entry: CardLogEntryInput): void
 *   getCardLog(cardId: string): StoredCardLogEntry[]   // ordered by insertion
 *
 * Three entry kinds (discriminated by `kind`):
 *   - entered_lane : { sourceLane, destLane, reasonClass }   (reasonClass:
 *                    'forward' | 'rework' | 'scrap' | 'hold')
 *   - gate_verdict : { verdict: 'pass'|'reject', findings: string[], returnTo }
 *   - terminal     : { reason }                              (scrap/hold reason)
 *
 * Contract this file pins for cmdJournal:
 *   AC1  inspect prints each card_log entry in order; entered-lane lines show
 *        source + dest lane + reason class; gate-verdict lines show verdict +
 *        findings; the terminal line shows the scrap/hold reason.
 *   AC2  a reworked-then-scrapped card prints a coherent history: the rework
 *        back-edge entry, each gate reject with its findings, then the terminal.
 *   AC3  a card with NO card_log entries exits 0 and still prints the existing
 *        journal spans (no regression); card_log renders ALONGSIDE spans.
 *   AC4  inspect is strictly READ-ONLY — it never writes the state or journal DB.
 *   AC5  an unknown journal subcommand / missing cardId still errors with the
 *        existing usage message (regression guard).
 *
 * These tests use the REAL in-memory ConduitDB (matching cli.test.ts) and the
 * REAL main()/cmdJournal — only the seeded data is arranged. Until B.A. wires
 * getCardLog into cmdJournal, the card_log-content assertions (AC1, AC2, AC3b)
 * fail because the entries are never printed — a correct RED.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { DEFAULT_RUN_ID, openConduitDB,
  type ConduitDB,
  type CardLogEntryInput,
 } from '../persistence/db';
import type { ModelAdapter } from '../worker/adapter';
import {
  main,
  type CliDeps,
  type CliIO,
  type RunEngineArgs,
  type PrereqProbe,
} from './main';

// ---------------------------------------------------------------------------
// Captured IO + stub adapter + deps factory (mirrors cli.test.ts)
// ---------------------------------------------------------------------------

function makeIO(): CliIO & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    out: (l: string) => lines.push(l),
    err: (l: string) => errors.push(l),
  };
}

const stubAdapter: ModelAdapter = {
  async call() {
    return { text: '{}', inputTokens: 1, outputTokens: 1, costUsd: 0 };
  },
};

let db: ConduitDB;
let io: ReturnType<typeof makeIO>;

beforeEach(() => {
  db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  io = makeIO();
});

afterEach(() => {
  db.close();
});

function makeDeps(over: Partial<CliDeps> = {}): CliDeps {
  return {
    io,
    now: () => 1_000,
    db,
    adapter: stubAdapter,
    runEngine: over.runEngine ?? (async (_args: RunEngineArgs) => {}),
    prereqs: over.prereqs ?? ([{ name: 'noop', check: () => ({ ok: true }) }] as PrereqProbe[]),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Typed seed helpers for the three card_log kinds.
// ---------------------------------------------------------------------------

function enteredLane(o: {
  runId?: string;
  cardId: string;
  station: string;
  attempt: number;
  sourceLane: string;
  destLane: string;
  reasonClass: 'forward' | 'rework' | 'scrap' | 'hold';
}): CardLogEntryInput {
  return { runId: DEFAULT_RUN_ID, kind: 'entered_lane', ...o };
}

function gateVerdict(o: {
  runId?: string;
  cardId: string;
  station: string;
  attempt: number;
  verdict: 'pass' | 'reject';
  findings: string[];
  returnTo: string | null;
}): CardLogEntryInput {
  return { runId: DEFAULT_RUN_ID, kind: 'gate_verdict', ...o };
}

function terminal(o: {
  runId?: string;
  cardId: string;
  station: string;
  attempt: number;
  reason: string;
}): CardLogEntryInput {
  return { runId: DEFAULT_RUN_ID, kind: 'terminal', ...o };
}

/** Index of the first printed line containing `needle`, or -1 if none. */
function lineIndex(needle: string): number {
  return io.lines.findIndex((l) => l.includes(needle));
}

/** All printed stdout lines joined — convenient for content assertions. */
function output(): string {
  return io.lines.join('\n');
}

// ===========================================================================
// AC1 — each card_log entry is printed in order, each kind showing its fields.
// ===========================================================================

describe('journal inspect — renders every card_log kind in order (AC1)', () => {
  it('prints entered-lane (source/dest/reason), gate-verdict (verdict/findings), and terminal (reason) in insertion order', async () => {
    const cardId = 'c-basic';
    db.appendCardLog(enteredLane({ cardId, station: 'review', attempt: 0, sourceLane: 'draft', destLane: 'review', reasonClass: 'forward' }));
    db.appendCardLog(gateVerdict({ cardId, station: 'review', attempt: 0, verdict: 'reject', findings: ['missing-alt-text', 'low-contrast'], returnTo: 'draft' }));
    db.appendCardLog(terminal({ cardId, station: 'review', attempt: 0, reason: 'scrap-rework-cap-exceeded' }));

    const code = await main(['journal', 'inspect', cardId], makeDeps());

    expect(code).toBe(0);

    // entered-lane line shows source lane, dest lane, and reason class together.
    const enteredIdx = lineIndex('forward');
    expect(enteredIdx).toBeGreaterThanOrEqual(0);
    expect(io.lines[enteredIdx]).toContain('draft'); // source lane
    expect(io.lines[enteredIdx]).toContain('review'); // dest lane

    // gate-verdict shows the verdict AND every finding (not just the first).
    expect(output()).toContain('reject');
    expect(output()).toContain('missing-alt-text');
    expect(output()).toContain('low-contrast');

    // terminal line shows the scrap reason.
    expect(lineIndex('scrap-rework-cap-exceeded')).toBeGreaterThanOrEqual(0);

    // Strict insertion order: entered → gate → terminal.
    expect(lineIndex('forward')).toBeLessThan(lineIndex('missing-alt-text'));
    expect(lineIndex('missing-alt-text')).toBeLessThan(lineIndex('scrap-rework-cap-exceeded'));
  });
});

// ===========================================================================
// Issue #32 — a skip_when pass-through prints the lane move and the predicate.
// ===========================================================================

describe('journal inspect — renders skip_when rows (issue #32)', () => {
  it('prints the skip lane move and the skip reason naming the predicate and value', async () => {
    const cardId = 'c-skip';
    db.appendCardLog({
      runId: DEFAULT_RUN_ID, kind: 'entered_lane', cardId, station: 'write_tests', attempt: 0,
      sourceLane: 'write_tests', destLane: 'implement', reasonClass: 'skip',
    });
    db.appendCardLog({
      runId: DEFAULT_RUN_ID, kind: 'skip', cardId, station: 'write_tests', attempt: 0,
      reason: 'skip_when seed.no_test_needed == true matched (read true)',
    });

    const code = await main(['journal', 'inspect', cardId], makeDeps());

    expect(code).toBe(0);
    expect(output()).toContain('write_tests → implement (skip)');
    expect(output()).toContain('skip: write_tests: skip_when seed.no_test_needed == true matched (read true)');
  });
});

// ===========================================================================
// AC2 — a reworked-then-scrapped card prints a coherent history.
// ===========================================================================

describe('journal inspect — coherent rework→scrap history (AC2)', () => {
  it('shows the rework back-edge entry, each gate reject with findings, and the final terminal reason in order', async () => {
    const cardId = 'c-history';
    // 1) forward into the gate
    db.appendCardLog(enteredLane({ cardId, station: 'review', attempt: 0, sourceLane: 'draft', destLane: 'review', reasonClass: 'forward' }));
    // 2) first gate reject
    db.appendCardLog(gateVerdict({ cardId, station: 'review', attempt: 0, verdict: 'reject', findings: ['hist-finding-A'], returnTo: 'draft' }));
    // 3) rework BACK-EDGE: review → draft
    db.appendCardLog(enteredLane({ cardId, station: 'draft', attempt: 1, sourceLane: 'review', destLane: 'draft', reasonClass: 'rework' }));
    // 4) second gate reject
    db.appendCardLog(gateVerdict({ cardId, station: 'review', attempt: 1, verdict: 'reject', findings: ['hist-finding-B'], returnTo: 'draft' }));
    // 5) scrapped
    db.appendCardLog(terminal({ cardId, station: 'review', attempt: 1, reason: 'hist-scrap-final' }));

    const code = await main(['journal', 'inspect', cardId], makeDeps());

    expect(code).toBe(0);

    // The rework back-edge entry is present and shows review → draft.
    const reworkIdx = lineIndex('rework');
    expect(reworkIdx).toBeGreaterThanOrEqual(0);
    expect(io.lines[reworkIdx]).toContain('review'); // source lane of the back-edge
    expect(io.lines[reworkIdx]).toContain('draft'); // dest lane of the back-edge

    // Both gate rejects' findings appear.
    expect(output()).toContain('hist-finding-A');
    expect(output()).toContain('hist-finding-B');

    // The final terminal reason appears.
    expect(lineIndex('hist-scrap-final')).toBeGreaterThanOrEqual(0);

    // Coherent chronological order across the whole history.
    expect(lineIndex('forward')).toBeLessThan(lineIndex('hist-finding-A'));
    expect(lineIndex('hist-finding-A')).toBeLessThan(lineIndex('rework'));
    expect(lineIndex('rework')).toBeLessThan(lineIndex('hist-finding-B'));
    expect(lineIndex('hist-finding-B')).toBeLessThan(lineIndex('hist-scrap-final'));
  });
});

// ===========================================================================
// AC3 — no-regression: spans still print when there is no card_log, and
//        card_log renders ALONGSIDE existing journal spans.
// ===========================================================================

describe('journal inspect — card_log is additive to existing journal spans (AC3)', () => {
  it('prints the existing journal spans and exits 0 for a card with NO card_log entries', async () => {
    const cardId = 'c-nolog';
    db.appendJournalSpan({ runId: DEFAULT_RUN_ID, cardId, station: 'render', attempt: 0, name: 'gen_ai.call' });

    const code = await main(['journal', 'inspect', cardId], makeDeps());

    expect(code).toBe(0);
    expect(output()).toContain('gen_ai.call'); // existing span still printed
    expect(io.errors).toHaveLength(0); // no error surfaced
  });

  it('prints BOTH the journal spans and the card_log entries for a card that has both', async () => {
    const cardId = 'c-both';
    db.appendJournalSpan({ runId: DEFAULT_RUN_ID, cardId, station: 'render', attempt: 0, name: 'gen_ai.call.both' });
    db.appendCardLog(enteredLane({ cardId, station: 'review', attempt: 0, sourceLane: 'draft', destLane: 'review', reasonClass: 'forward' }));
    db.appendCardLog(terminal({ cardId, station: 'review', attempt: 0, reason: 'both-terminal-reason' }));

    const code = await main(['journal', 'inspect', cardId], makeDeps());

    expect(code).toBe(0);
    expect(output()).toContain('gen_ai.call.both'); // existing span path intact
    expect(output()).toContain('forward'); // card_log entered-lane rendered
    expect(output()).toContain('both-terminal-reason'); // card_log terminal rendered
  });
});

// ===========================================================================
// AC4 — inspect is strictly READ-ONLY: it must not write the state or journal DB.
// ===========================================================================

describe('journal inspect — strictly read-only (AC4)', () => {
  it('does not mutate the state DB or the card_log/journal when rendering the transition log', async () => {
    const cardId = 'c-ro';
    db.insertCard({
    run_id: DEFAULT_RUN_ID, id: cardId, parent_id: null, lane: 'hold', status: 'held', attempt: 1, wave: 0, owned_paths: [], rework_count: 1 });
    db.appendJournalSpan({ runId: DEFAULT_RUN_ID, cardId, station: 'review', attempt: 0, name: 'gen_ai.call' });
    db.appendCardLog(enteredLane({ cardId, station: 'review', attempt: 0, sourceLane: 'draft', destLane: 'review', reasonClass: 'forward' }));
    db.appendCardLog(gateVerdict({ cardId, station: 'review', attempt: 0, verdict: 'reject', findings: ['ro-finding'], returnTo: 'draft' }));
    db.appendCardLog(terminal({ cardId, station: 'review', attempt: 0, reason: 'ro-hold-reason' }));

    // Snapshot the state DB bytes and the journal reads before inspecting.
    const stateBefore = Buffer.from(db.getStateDb().serialize());
    const cardLogBefore = db.getCardLog(cardId);
    const spansBefore = db.getJournalSpans(cardId);

    const code = await main(['journal', 'inspect', cardId], makeDeps());
    expect(code).toBe(0);

    // The state DB must be byte-identical — inspect never writes it.
    const stateAfter = Buffer.from(db.getStateDb().serialize());
    expect(stateAfter.equals(stateBefore)).toBe(true);

    // The journal (card_log + spans) must be unchanged — no accidental appends.
    expect(db.getCardLog(cardId)).toEqual(cardLogBefore);
    expect(db.getJournalSpans(cardId)).toEqual(spansBefore);
  });
});

// ===========================================================================
// AC5 — usage/validation regression guards for the journal command.
// ===========================================================================

describe('journal inspect — usage/validation regression guards (AC5)', () => {
  it('rejects an unknown journal subcommand with the existing usage message and a nonzero exit', async () => {
    const code = await main(['journal', 'bogus', 'c-x'], makeDeps());

    expect(code).not.toBe(0);
    expect(io.errors.join('\n')).toMatch(/unknown journal subcommand/i);
  });

  it('rejects a missing cardId with the existing usage message and a nonzero exit', async () => {
    const code = await main(['journal', 'inspect'], makeDeps());

    expect(code).not.toBe(0);
    expect(io.errors.join('\n')).toMatch(/usage: conduit journal/i);
  });
});
