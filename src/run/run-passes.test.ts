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
import { nextPassNumber, passEntryCardId, checkRunAppendable, remainingRunTokens, hasLaterPasses } from './run-passes';

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
    expect(remainingRunTokens(db, 'r', 1_000)).toBe(625);
  });

  it('returns a negative figure once prior usage exceeds the ceiling — callers clamp, not this function', () => {
    db.appendJournalSpan({
      runId: 'r', cardId: 'entry-r', station: 'draft', attempt: 0, name: 'draft.transform',
      usage: { model: 'm', inputTokens: 900, outputTokens: 200, costUsd: 0 },
    });
    expect(remainingRunTokens(db, 'r', 1_000)).toBe(-100);
  });

  it('is the whole ceiling for a run with no recorded usage', () => {
    expect(remainingRunTokens(db, 'r', 1_000)).toBe(1_000);
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

  it('refuses a run with no cards at all', () => {
    run('r', 'halted', 'halted');
    expect(checkRunAppendable(db, 'r', 1_000)).toMatchObject({ ok: false, state: 'unfinished' });
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
});
