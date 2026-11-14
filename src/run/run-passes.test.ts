/**
 * Tests for run passes (issue #36): pass numbering and the appendable check.
 *
 * A keyed ingress run takes each relevant event as its next PASS. Pass 1 is the
 * run's ordinary entry card (`entry-<runId>`); pass N > 1 is seeded as
 * `entry-<runId>-p<N>`. The next pass number is derived from the cards table,
 * never from a counter held in memory, so the kernel and the listener (which
 * share the state DB) always agree on it.
 *
 * A pass may only be appended to a run whose previous pass concluded: not
 * parked, not recorded running, and every card in the done or scrap lane with
 * none held. A scrapped pass concluded. A parked run is resumed by the
 * parked-run machinery, never given a pass.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { openConduitDB, type ConduitDB } from '../persistence/db';
import type { Card } from '../types/kernel';
import {
  nextPassNumber,
  passEntryCardId,
  checkRunAppendable,
  remainingRunTokens,
  hasLaterPasses,
  runUsageByAdapter,
} from './run-passes';

let db: ConduitDB;

beforeEach(() => {
  db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
});

afterEach(() => {
  db.close();
});

function card(runId: string, id: string, overrides: Partial<Card> = {}): Card {
  return {
    run_id: runId,
    id,
    parent_id: null,
    lane: 'done',
    status: 'complete',
    attempt: 0,
    wave: 0,
    owned_paths: [],
    rework_count: 0,
    ...overrides,
  };
}

function run(runId: string, status: string, outcome: string | null = null): void {
  db.insertRun({ run_id: runId, flow: '/f.yaml', input_fingerprint: 'fp', status, ...(outcome !== null && { outcome }) });
}

describe('passEntryCardId', () => {
  it('names pass 1 as the ordinary entry card and later passes with a -p suffix', () => {
    expect(passEntryCardId('igk-x', 1)).toBe('entry-igk-x');
    expect(passEntryCardId('igk-x', 2)).toBe('entry-igk-x-p2');
    expect(passEntryCardId('igk-x', 17)).toBe('entry-igk-x-p17');
  });
});

describe('nextPassNumber', () => {
  it('is 1 for a run with no cards', () => {
    expect(nextPassNumber(db, 'igk-x')).toBe(1);
  });

  it('is 2 after the ordinary entry card', () => {
    db.insertCard(card('igk-x', 'entry-igk-x'));
    expect(nextPassNumber(db, 'igk-x')).toBe(2);
  });

  it('follows the highest pass card, ignoring children and other runs', () => {
    db.insertCard(card('igk-x', 'entry-igk-x'));
    db.insertCard(card('igk-x', 'entry-igk-x-p2'));
    db.insertCard(card('igk-x', 'entry-igk-x-p3'));
    db.insertCard(card('igk-x', 'entry-igk-x-p9', { parent_id: 'entry-igk-x-p3' }));
    db.insertCard(card('igk-x', 'entry-igk-x-pz'));
    db.insertCard(card('igk-other', 'entry-igk-other-p40'));
    expect(nextPassNumber(db, 'igk-x')).toBe(4);
  });

  it('does not treat a run id containing LIKE wildcards as a pattern', () => {
    db.insertCard(card('a_b', 'entry-a_b'));
    db.insertCard(card('axb', 'entry-axb-p5'));
    expect(nextPassNumber(db, 'a_b')).toBe(2);
  });
});

describe('remainingRunTokens', () => {
  it('subtracts summed prior-pass usage from the ceiling', () => {
    // Two journal rows, as production writes them per station call — the sum
    // getRunUsageTotals reads back covers all four token columns.
    db.appendJournalSpan({
      runId: 'r', cardId: 'entry-r', station: 'draft', attempt: 0, name: 'draft.transform',
      usage: { model: 'm', inputTokens: 100, outputTokens: 50, costUsd: 0 },
    });
    db.appendJournalSpan({
      runId: 'r', cardId: 'entry-r-p2', station: 'draft', attempt: 0, name: 'draft.transform',
      usage: { model: 'm', inputTokens: 200, outputTokens: 25, costUsd: 0 },
    });
    // 100+50+200+25 = 375 spent.
    expect(remainingRunTokens(db, 'r', 1_000, undefined)).toBe(625);
  });

  it('returns a negative figure once prior usage exceeds the ceiling — callers clamp, not this function', () => {
    db.appendJournalSpan({
      runId: 'r', cardId: 'entry-r', station: 'draft', attempt: 0, name: 'draft.transform',
      usage: { model: 'm', inputTokens: 900, outputTokens: 200, costUsd: 0 },
    });
    expect(remainingRunTokens(db, 'r', 1_000, undefined)).toBe(-100);
  });

  // Issue #125: each span is weighted for the adapter that billed it.
  const cacheSpan = (runId: string, adapter: string | undefined, station = 'research'): void => {
    db.appendJournalSpan({
      runId, cardId: `card-${station}`, station, attempt: 0, name: `${station}.harness`,
      ...(adapter !== undefined && { adapter }),
      usage: {
        model: 'm', inputTokens: 100, outputTokens: 50, costUsd: 0,
        cacheReadInputTokens: 2_000, cacheCreationInputTokens: 40,
      },
    });
  };

  it('weights each span for its own adapter (issue #125)', () => {
    cacheSpan('r', 'claude-headless', 'walk');   // 150 + 0.1 * 2000 + 2 * 40 = 430
    cacheSpan('r', 'codex-app-server', 'audit'); // 150 + 0.5 * 2000 + 1 * 40 = 1190
    cacheSpan('r', 'opencode', 'review');        // 150 + 2000 + 40 = 2190
    expect(remainingRunTokens(db, 'r', 10_000, undefined)).toBe(10_000 - 430 - 1_190 - 2_190);
  });

  it('weighs a span with no adapter, or an unknown one, at 1 per class', () => {
    cacheSpan('r', undefined, 'old');       // 2190
    cacheSpan('r', 'fake-harness', 'fake'); // 2190
    expect(remainingRunTokens(db, 'r', 10_000, undefined)).toBe(10_000 - 2 * 2_190);
  });

  it("a class the flow sets overrides every adapter's default; an unset class falls back", () => {
    cacheSpan('r', 'claude-headless', 'walk');
    cacheSpan('r', undefined, 'old');
    // cache_read 0.2 for both; creation stays 2 (claude) and 1 (unknown):
    // (150 + 400 + 80) + (150 + 400 + 40) = 1220.
    expect(remainingRunTokens(db, 'r', 10_000, { cache_read: 0.2 })).toBe(10_000 - 1_220);
  });

  it("reads a subflow span's child run, each child span under its own adapter, instead of the roll-up", () => {
    cacheSpan('child-1', 'claude-headless', 'walk'); // 430
    cacheSpan('child-1', 'codex-exec', 'audit');     // 1190
    // The parent's roll-up span records the child's summed raw split under a
    // subflow adapter; weighting it as unknown would give 4380.
    db.appendJournalSpan({
      runId: 'r', cardId: 'entry-r', station: 'call', attempt: 0, name: 'call.subflow',
      adapter: 'subflow:./child/flow.yaml', attributes: { child_run_id: 'child-1', outcome: 'success' },
      usage: {
        model: '', inputTokens: 200, outputTokens: 100, costUsd: 0,
        cacheReadInputTokens: 4_000, cacheCreationInputTokens: 80,
      },
    });
    expect(remainingRunTokens(db, 'r', 10_000, undefined)).toBe(10_000 - 430 - 1_190);
    expect(runUsageByAdapter(db, 'r')).toEqual([
      { adapter: 'claude-headless', breakdown: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 2_000, cacheCreationInputTokens: 40 }, cacheSplit: true },
      { adapter: 'codex-exec', breakdown: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 2_000, cacheCreationInputTokens: 40 }, cacheSplit: true },
    ]);
  });

  it("marks an adapter's share unsplit when any of its spans recorded no cache columns", () => {
    cacheSpan('r', 'claude-headless', 'walk');
    // A span with NULL cache columns: its input may include cached tokens.
    db.appendJournalSpan({
      runId: 'r', cardId: 'card-audit', station: 'audit', attempt: 0, name: 'audit.harness',
      adapter: 'codex-exec', usage: { model: 'm', inputTokens: 300, outputTokens: 0, costUsd: 0 },
    });
    cacheSpan('r', 'codex-exec', 'audit');
    expect(runUsageByAdapter(db, 'r')).toEqual([
      { adapter: 'claude-headless', breakdown: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 2_000, cacheCreationInputTokens: 40 }, cacheSplit: true },
      { adapter: 'codex-exec', breakdown: { inputTokens: 400, outputTokens: 50, cacheReadInputTokens: 2_000, cacheCreationInputTokens: 40 }, cacheSplit: false },
    ]);
  });

  it("counts the part of a subflow span's total its child's spans do not cover at 1", () => {
    cacheSpan('child-1', 'claude-headless', 'walk'); // 2,190 raw, 430 weighted
    // The roll-up recorded 1,000 more than the child's spans now hold.
    db.appendJournalSpan({
      runId: 'r', cardId: 'entry-r', station: 'call', attempt: 0, name: 'call.subflow',
      adapter: 'subflow:./child/flow.yaml', attributes: { child_run_id: 'child-1', outcome: 'success' },
      usage: {
        model: '', inputTokens: 1_100, outputTokens: 50, costUsd: 0,
        cacheReadInputTokens: 2_000, cacheCreationInputTokens: 40,
      },
    });
    expect(remainingRunTokens(db, 'r', 10_000, undefined)).toBe(10_000 - 430 - 1_000);
    // The remainder has no adapter and no cache split.
    expect(runUsageByAdapter(db, 'r')).toEqual([
      { adapter: 'claude-headless', breakdown: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 2_000, cacheCreationInputTokens: 40 }, cacheSplit: true },
      { adapter: null, breakdown: { inputTokens: 1_000, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, cacheSplit: false },
    ]);
  });

  it('weighs a subflow span whose child run left no spans as unknown', () => {
    db.appendJournalSpan({
      runId: 'r', cardId: 'entry-r', station: 'call', attempt: 0, name: 'call.subflow',
      adapter: 'subflow:./child/flow.yaml', attributes: { child_run_id: 'gone', outcome: 'success' },
      usage: { model: '', inputTokens: 500, outputTokens: 0, costUsd: 0 },
    });
    expect(remainingRunTokens(db, 'r', 1_000, undefined)).toBe(500);
  });

  it('rounds a fractional remainder down', () => {
    db.appendJournalSpan({
      runId: 'r', cardId: 'entry-r', station: 'research', attempt: 0, name: 'research.harness',
      adapter: 'claude-headless',
      usage: { model: 'm', inputTokens: 0, outputTokens: 0, costUsd: 0, cacheReadInputTokens: 5, cacheCreationInputTokens: 0 },
    });
    // 0.1 * 5 = 0.5 spent.
    expect(remainingRunTokens(db, 'r', 10, undefined)).toBe(9);
  });

  it('is the whole ceiling for a run with no recorded usage', () => {
    expect(remainingRunTokens(db, 'r', 1_000, undefined)).toBe(1_000);
  });
});

describe('hasLaterPasses', () => {
  it('is false for a run with only the pass-1 entry card', () => {
    db.insertCard(card('r', 'entry-r'));
    expect(hasLaterPasses(db, 'r')).toBe(false);
  });

  it('is true once entry-<runId>-p2 exists', () => {
    db.insertCard(card('r', 'entry-r'));
    db.insertCard(card('r', 'entry-r-p2'));
    expect(hasLaterPasses(db, 'r')).toBe(true);
  });

  it('is false for a run with no cards at all', () => {
    expect(hasLaterPasses(db, 'r')).toBe(false);
  });
});

describe('checkRunAppendable', () => {
  it('accepts a done run whose cards are all terminal', () => {
    run('r', 'done', 'complete');
    db.insertCard(card('r', 'entry-r'));
    db.insertCard(card('r', 'child', { parent_id: 'entry-r', lane: 'scrap', status: 'scrapped' }));
    expect(checkRunAppendable(db, 'r', 1_000)).toEqual({ ok: true });
  });

  it('refuses an unknown run', () => {
    expect(checkRunAppendable(db, 'nope', 1_000)).toMatchObject({ ok: false, state: 'not_found' });
  });

  it('accepts a halted run whose last pass scrapped: every card is in done or scrap', () => {
    // A scrapped pass is a normal bad outcome for an unattended loop, and
    // conduit resume cannot bring a scrapped card to done, so refusing here
    // would block the subject forever.
    run('r', 'halted', 'halted');
    db.insertCard(card('r', 'entry-r'));
    db.insertCard(card('r', 'entry-r-p2', { lane: 'scrap', status: 'scrapped' }));
    expect(checkRunAppendable(db, 'r', 1_000)).toEqual({ ok: true });
  });

  it('refuses a halted run with an unfinished card (the andon stopped it mid-pass)', () => {
    run('r', 'halted', 'halted');
    db.insertCard(card('r', 'entry-r', { lane: 'work', status: 'ready' }));
    expect(checkRunAppendable(db, 'r', 1_000)).toMatchObject({ ok: false, state: 'unfinished' });
  });

  it('refuses a halted run with a waiting child under a scrapped parent', () => {
    run('r', 'halted', 'halted');
    db.insertCard(card('r', 'entry-r', { lane: 'scrap', status: 'scrapped' }));
    db.insertCard(card('r', 'c1', { parent_id: 'entry-r', lane: 'intake', status: 'waiting' }));
    expect(checkRunAppendable(db, 'r', 1_000)).toMatchObject({ ok: false, state: 'unfinished' });
  });

  it('refuses a failed launch (halted, no cards), pointing at a plain conduit run to retry it', () => {
    // Nothing ran, so there is no pass to follow: the launch itself is what
    // needs retrying, and a plain `conduit run` with the run id does that.
    run('r', 'halted', 'halted');
    const result = checkRunAppendable(db, 'r', 1_000);
    expect(result).toMatchObject({ ok: false, state: 'launch_failed' });
    expect(result.ok === false && result.detail).toContain('without --append-pass');
  });

  it('refuses a run still recorded running even when its cards are terminal (its driver died before recording the exit)', () => {
    run('r', 'running');
    db.insertCard(card('r', 'entry-r'));
    expect(checkRunAppendable(db, 'r', 1_000)).toMatchObject({ ok: false, state: 'running' });
  });

  it('refuses a run holding a card, even one recorded done', () => {
    run('r', 'done', 'complete');
    db.insertCard(card('r', 'entry-r'));
    db.insertCard(card('r', 'child', { parent_id: 'entry-r', lane: 'hold', status: 'held' }));
    expect(checkRunAppendable(db, 'r', 1_000)).toMatchObject({ ok: false, state: 'held' });
  });

  it('refuses a running run', () => {
    run('r', 'running');
    db.insertCard(card('r', 'entry-r', { lane: 'work', status: 'working' }));
    expect(checkRunAppendable(db, 'r', 1_000)).toMatchObject({ ok: false, state: 'running' });
  });

  it('refuses a parked run, naming it parked', () => {
    run('r', 'halted', 'parked');
    db.insertCard(card('r', 'entry-r', { lane: 'work', status: 'ready' }));
    expect(checkRunAppendable(db, 'r', 1_000)).toMatchObject({ ok: false, state: 'parked' });
  });

  it('names a run still recorded running "running", not "held", even with a held card (its driver died while holding)', () => {
    // A run whose driver crashed while a card was held stays 'running' (the
    // CLI only records 'done'/'halted' once the engine returns). Reporting
    // this as 'held' tells a caller to wait for a resume that is not coming;
    // reporting it as 'running' tells the operator to `conduit resume` it.
    run('r', 'running');
    db.insertCard(card('r', 'entry-r', { lane: 'hold', status: 'held' }));
    expect(checkRunAppendable(db, 'r', 1_000)).toMatchObject({ ok: false, state: 'running' });
  });

  it('still names a properly halted run with a held card "held"', () => {
    run('r', 'halted', 'halted');
    db.insertCard(card('r', 'entry-r', { lane: 'hold', status: 'held' }));
    expect(checkRunAppendable(db, 'r', 1_000)).toMatchObject({ ok: false, state: 'held' });
  });
});
