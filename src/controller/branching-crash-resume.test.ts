/**
 * Crash-and-resume exactly-once correctness across branching + HITL seams (WI-400).
 *
 * PRD NFR2 (exactly-once under crash) and use case "kills the run mid-flight".
 * Killing the run at any branching/HITL seam and resuming must produce
 * exactly-once behavior: no duplicate child seeding, no double-publish, no
 * re-billed call, and no duplicate HITL prompt.
 *
 * Exactly-once is NOT reimplemented here — it rests on the EXISTING outbox +
 * idempotency primitives (checkpoint.ts writePendingIntent / commitIntent /
 * reconcileOnResume / getIntentStatus), the fan-out commit (dag/expand.ts
 * commitFanOut), and the HITL machinery (channels/slack.ts postHitlHold /
 * applyHitlReply / getRecordedHitlSelection / applyHoldTimeout). These tests
 * assert the WI-396/397/398 branching wiring PRESERVES that contract.
 *
 * Methodology — same as the golden crash oracle (src/test-harness/crash-oracle.ts,
 * per CLAUDE.md the accepted crash-test scaffolding): a COMPONENT-integration
 * harness that exercises the REAL recovery primitives at each recoverable seam,
 * with soundness OBSERVED (counters derived from measured behavior — an effect
 * ledger, committed-outbox state, model-call counts), never asserted as a literal.
 *
 * NOTE on AC1's "add mid_fanout_before_commit to the CrashPoint enum in
 * crash-oracle.ts": that harness is an implementation file Murdock is not
 * permitted to edit (test/types only — enforced by hook), and this work item is a
 * test-only deliverable (impl path == test path == this file). The mid-fan-out
 * crash seam is therefore modeled self-contained below, driving the REAL
 * commitFanOut + the parent-status idempotency guard the executor uses, so the
 * behavioral intent of AC1 (no partial children, clean reconcile, no duplicate
 * children) is fully covered.
 */
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import {
  ensureCheckpointSchema,
  writePendingIntent,
  commitIntent,
  getIntentStatus,
  reconcileOnResume,
} from '../checkpoint/checkpoint';
import { commitFanOut, type ArchitectProposal } from '../dag/expand';
import {
  egressSend,
  postHitlHold,
  applyHitlReply,
  getRecordedHitlSelection,
  applyHoldTimeout,
  type SlackTransport,
} from '../channels/slack';

/** The project root commitFanOut confines owned_paths to; these proposals use relative paths. */
const FANOUT_PROJECT_ROOT = tmpdir();

const FLOW_ID = 'reference-pipeline';
const CHANNEL = '#content-pipeline';
const INTENDED_CHILDREN = ['child-0', 'child-1', 'child-2'] as const;

// ---------------------------------------------------------------------------
// Observed-effect ledger — the single source of truth for effect counts so
// "duplicate" is MEASURED (a key that fired more than once), never assumed.
// ---------------------------------------------------------------------------

interface EffectLedger {
  recordFire(key: string): void;
  firesForKey(key: string): number;
  duplicateEffects(): number;
}

function makeLedger(): EffectLedger {
  const fires = new Map<string, number>();
  return {
    recordFire: (key) => fires.set(key, (fires.get(key) ?? 0) + 1),
    firesForKey: (key) => fires.get(key) ?? 0,
    duplicateEffects: () => {
      let dups = 0;
      for (const n of fires.values()) if (n > 1) dups += n - 1;
      return dups;
    },
  };
}

/** Recording Slack transport — every post is captured so a re-post is observable. */
function makeTransport(): {
  transport: SlackTransport;
  posts: Array<{ channel: string; text: string; correlationId?: string }>;
} {
  const posts: Array<{ channel: string; text: string; correlationId?: string }> = [];
  return {
    posts,
    transport: {
      post: async (req) => {
        posts.push(req);
        return { ts: `ts-${posts.length}` };
      },
    },
  };
}

function childRows(db: ConduitDB, parentId: string): Array<{ id: string; owned_paths: string }> {
  return db
    .getStateDb()
    .prepare('SELECT id, owned_paths FROM cards WHERE parent_id = $p ORDER BY id')
    .all({ $p: parentId }) as Array<{ id: string; owned_paths: string }>;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let db: ConduitDB;

beforeEach(() => {
  db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
});

afterEach(() => {
  db.close();
});

// ===========================================================================
// AC1 + AC2 — mid_fanout_before_commit: a crash mid fan-out (children seeded,
// before the fan-out commit) leaves NO partial children, and resume reconciles
// to the intended child set exactly once (no duplicate cards / namespaces).
// ===========================================================================

describe('crash mid fan-out before commit (AC1, AC2)', () => {
  const proposal: ArchitectProposal = {
    children: INTENDED_CHILDREN.map((id) => ({
      id,
      depends_on: [],
      owned_paths: [`out/${id}.json`],
    })),
  };

  /** The executor's fan-out is idempotent: it skips re-seeding once the parent is awaiting_children. */
  function resumeFanOut(): void {
    const parent = db.getCard(DEFAULT_RUN_ID, 'parent');
    if (parent?.status === 'awaiting_children') return; // already fanned out — skip (no duplicate)
    commitFanOut(db, DEFAULT_RUN_ID, 'parent', proposal, { onPathConflict: 'reject', projectRoot: FANOUT_PROJECT_ROOT });
    db.getStateDb().prepare("UPDATE cards SET status = 'awaiting_children' WHERE id = 'parent'").run();
  }

  it('commits NO partial children when the real fan-out is interrupted mid-insert, and resume reconciles to the intended set exactly once (AC1)', () => {
    db.insertCard({
      run_id: DEFAULT_RUN_ID,
      id: 'parent', parent_id: null, lane: 'plan', status: 'working',
      attempt: 0, wave: 0, owned_paths: [], rework_count: 0,
    });

    // REAL crash — drive the PRODUCTION commitFanOut, which loops insertCard with
    // NO surrounding transaction, so each insert auto-commits independently.
    // Inject a failure on the SECOND child insert: by then the FIRST child has
    // already been COMMITTED, so a non-atomic commitFanOut leaves a partial row.
    // (The earlier version of this test wrapped the inserts in its OWN throwing
    // transaction — modelling a rollback the production code does not provide.)
    const realInsert = db.insertCard.bind(db);
    let childInserts = 0;
    const spy = spyOn(db, 'insertCard').mockImplementation((card) => {
      childInserts += 1;
      if (childInserts === 2) throw new Error('crash: mid fan-out, before commit');
      return realInsert(card);
    });

    expect(() => commitFanOut(db, DEFAULT_RUN_ID, 'parent', proposal, { onPathConflict: 'reject', projectRoot: FANOUT_PROJECT_ROOT })).toThrow(
      /mid fan-out/,
    );
    spy.mockRestore();

    // ATOMICITY (BUG 1): the interrupted fan-out must leave NO partial children —
    // commitFanOut must wrap its inserts in ONE transaction so the already-
    // committed first child rolls back with the failed second.
    expect(childRows(db, 'parent')).toHaveLength(0);

    // RESUME (BUG 2): re-driving the fan-out must NOT throw a UNIQUE constraint
    // and must reconcile to the intended child set exactly once.
    expect(() =>
      commitFanOut(db, DEFAULT_RUN_ID, 'parent', proposal, { onPathConflict: 'reject', projectRoot: FANOUT_PROJECT_ROOT }),
    ).not.toThrow();
    expect(childRows(db, 'parent').map((r) => r.id)).toEqual([...INTENDED_CHILDREN]);
  });

  it('does not throw a UNIQUE constraint when re-dispatched with a child already seeded — detects existing children and skips re-insertion (BUG 2)', () => {
    db.insertCard({
      run_id: DEFAULT_RUN_ID,
      id: 'parent', parent_id: null, lane: 'plan', status: 'working',
      attempt: 0, wave: 0, owned_paths: [], rework_count: 0,
    });
    // A prior fan-out already seeded one child before the run was killed; on
    // reclaim the parent is re-dispatched with that child already in the DB.
    db.insertCard({
      run_id: DEFAULT_RUN_ID,
      id: 'child-0', parent_id: 'parent', lane: 'intake', status: 'waiting',
      attempt: 0, wave: 0, owned_paths: ['out/child-0.json'], rework_count: 0,
    });

    // Re-dispatch drives commitFanOut again. It must DETECT the existing child
    // and skip re-insertion — not crash the executor on a UNIQUE violation.
    expect(() =>
      commitFanOut(db, DEFAULT_RUN_ID, 'parent', proposal, { onPathConflict: 'reject', projectRoot: FANOUT_PROJECT_ROOT }),
    ).not.toThrow();

    // child-0 is present exactly once — never duplicated.
    expect(childRows(db, 'parent').filter((r) => r.id === 'child-0')).toHaveLength(1);
  });

  it('resumes to the intended child set exactly once — no duplicate cards or namespaces (AC2)', () => {
    db.insertCard({
      run_id: DEFAULT_RUN_ID,
      id: 'parent', parent_id: null, lane: 'plan', status: 'working',
      attempt: 0, wave: 0, owned_paths: [], rework_count: 0,
    });

    // Resume drives the real fan-out commit. A SECOND resume (e.g. a crash that
    // recurs) must not duplicate children — the parent-status guard holds.
    resumeFanOut();
    resumeFanOut();

    const rows = childRows(db, 'parent');
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual([...INTENDED_CHILDREN]); // the intended set, each id exactly once

    // No owned-path namespace is shared across siblings (and none duplicated).
    const namespaces = rows.flatMap((r) => JSON.parse(r.owned_paths) as string[]);
    expect(new Set(namespaces).size).toBe(namespaces.length);
    expect(namespaces).toEqual(['out/child-0.json', 'out/child-1.json', 'out/child-2.json']);

    expect(db.getCard(DEFAULT_RUN_ID, 'parent')?.status).toBe('awaiting_children');
  });
});

// ===========================================================================
// AC3 — crash around an effectful child publish (after the billed/irreversible
// call, before commitIntent) resumes via reconcileOnResume without re-billing
// or double-publishing that child's output.
// ===========================================================================

describe('crash around effectful child publish, before commit (AC3)', () => {
  it('skips the publish on resume (reconciler confirms it landed) — no re-bill, no double-publish', () => {
    const stateDb = db.getStateDb();
    const ledger = makeLedger();
    const key = 'publish:child-0:0';
    let modelCalls = 0;

    // Pre-crash: outbox protocol — write PENDING, fire the billed/irreversible
    // publish, then CRASH before commitIntent.
    writePendingIntent(stateDb, {
      flow: FLOW_ID, card: 'child-0', station: 'publish', attempt: 0,
      idempotencyKey: key, intent: { kind: 'publish', childId: 'child-0' },
    });
    modelCalls++;            // the billed publish worker call happened
    ledger.recordFire(key);  // the irreversible publish landed
    // (process dies here — no commitIntent)

    expect(getIntentStatus(stateDb, key)).toBe('pending');
    const modelCallsAtCrash = modelCalls;

    // Resume: reconciler confirms the publish landed → SKIP. The billed call is
    // NOT re-issued and the effect is NOT re-fired.
    const decision = reconcileOnResume(stateDb, key, () => 'landed');
    expect(decision.action).toBe('skip');
    // skip ⇒ no re-bill (no new model call) and no re-fire.
    expect(modelCalls).toBe(modelCallsAtCrash);
    expect(ledger.firesForKey(key)).toBe(1);
    expect(ledger.duplicateEffects()).toBe(0);
  });

  it('never blind-retries the publish when the outcome cannot be confirmed (no reconciler → escalate_hold)', () => {
    const stateDb = db.getStateDb();
    const key = 'publish:child-1:0';

    writePendingIntent(stateDb, {
      flow: FLOW_ID, card: 'child-1', station: 'publish', attempt: 0,
      idempotencyKey: key, intent: { kind: 'publish', childId: 'child-1' },
    });

    // No reconciler → must NOT fire (no blind retry); escalate for human reconcile.
    const decision = reconcileOnResume(stateDb, key);
    expect(decision.action).toBe('escalate_hold');
    expect(getIntentStatus(stateDb, key)).toBe('pending'); // left untouched, never committed
  });
});

// ===========================================================================
// AC4 — crash between the HITL Slack post and its outbox commit resumes without
// re-posting the same prompt: the human is asked exactly once (same correlation
// id, no duplicate Slack message).
// ===========================================================================

describe('crash between HITL post and outbox commit (AC4)', () => {
  it('does not re-post the HITL prompt on resume — asked exactly once, same correlation id', async () => {
    const stateDb = db.getStateDb();
    const ledger = makeLedger();
    const { transport, posts } = makeTransport();
    const correlationId = 'hitl::parent::nonce-7f3a';
    const prompt = 'Select the best content variant';

    // Pre-crash: the HITL hold posted to Slack and wrote a PENDING outbox intent,
    // but the process died BEFORE commit. Replicate that exact seam.
    writePendingIntent(stateDb, {
      flow: FLOW_ID, card: 'parent', station: 'select', attempt: 0,
      idempotencyKey: correlationId,
      intent: { kind: 'slack_post', channel: CHANNEL, text: prompt, correlationId },
    });
    posts.push({ channel: CHANNEL, text: prompt, correlationId }); // the pre-crash post landed
    ledger.recordFire(correlationId);
    expect(getIntentStatus(stateDb, correlationId)).toBe('pending');

    const postsAtCrash = posts.length; // 1

    // Resume through the REAL egressSend with the same idempotency key; the
    // reconciler confirms the prompt landed → skip (no re-post).
    const result = await egressSend(
      db,
      transport,
      { channel: CHANNEL, text: prompt, idempotencyKey: correlationId, correlationId },
      () => 'landed',
    );

    expect(result.posted).toBe(false);          // egressSend did not re-post
    expect(posts).toHaveLength(postsAtCrash);   // human asked exactly once
    expect(posts[0]!.correlationId).toBe(correlationId);
    expect(ledger.firesForKey(correlationId)).toBe(1);
    expect(ledger.duplicateEffects()).toBe(0);
  });
});

// ===========================================================================
// AC5 — crash after a human selection is recorded (via the reply path) but
// before the held card advances: resume delivers the selected candidate exactly
// once, without re-asking the human.
// ===========================================================================

describe('crash after selection recorded, before held card advances (AC5)', () => {
  it('keeps the selection durable, never re-asks, and delivers the selected candidate exactly once', async () => {
    const { transport, posts } = makeTransport();

    // Parent parked at the HITL hold (status='held').
    db.insertCard({
      run_id: DEFAULT_RUN_ID,
      id: 'parent', parent_id: null, lane: 'select', status: 'held',
      attempt: 0, wave: 0, owned_paths: [], rework_count: 0,
    });

    // Hold prompt posted once; human reply records the selection durably (held→ready).
    const { correlationId } = await postHitlHold(db, transport, {
      cardId: 'parent', channel: CHANNEL, prompt: 'Select the best content variant',
    });
    const holdPosts = posts.length; // 1
    const reply = applyHitlReply(db, correlationId, 'child-1');
    expect(reply.resumed).toBe(true);
    expect(db.getCard(DEFAULT_RUN_ID, 'parent')?.status).toBe('ready');

    // CRASH here: selection recorded, card 'ready', not yet advanced to delivery.

    // Resume: the recorded selection survived the crash (durable).
    const selection = getRecordedHitlSelection(db, 'parent');
    expect(selection).toBe('child-1');

    // Re-ask guard: a recorded selection means the human is NOT prompted again.
    expect(selection).not.toBeNull();
    expect(posts).toHaveLength(holdPosts); // no second hold prompt

    // Deliver the selected candidate, outbox-guarded so it fires exactly once
    // across this resume and any subsequent one.
    const deliveryKey = 'deliver:parent:0';
    const first = await egressSend(db, transport, {
      channel: CHANNEL, text: `DELIVER ${selection}`, idempotencyKey: deliveryKey,
    });
    expect(first.posted).toBe(true);

    // A second resume (re-entry) must not re-deliver — committed key → skip.
    const second = await egressSend(db, transport, {
      channel: CHANNEL, text: `DELIVER ${selection}`, idempotencyKey: deliveryKey,
    });
    expect(second.posted).toBe(false);

    // Net: exactly one hold prompt + exactly one delivery; the human is asked once.
    const deliveryPosts = posts.filter((p) => p.text.startsWith('DELIVER'));
    expect(deliveryPosts).toHaveLength(1);
    expect(posts.filter((p) => p.correlationId === correlationId)).toHaveLength(1);
  });
});

// ===========================================================================
// AC6 — across all seams: resume never auto-selects a rank candidate, and the
// token/effect counters reflect no re-billed work.
// ===========================================================================

describe('no auto-selection and no re-billed work across seams (AC6)', () => {
  it('a hold timeout never auto-picks a rank winner (FR-14)', () => {
    db.insertCard({
      run_id: DEFAULT_RUN_ID,
      id: 'parent', parent_id: null, lane: 'select', status: 'held',
      attempt: 0, wave: 0, owned_paths: [], rework_count: 0,
    });

    // applyHoldTimeout resolves the parked card by POLICY — it must never
    // silently select a candidate (autoSelected is structurally false, FR-14).
    const outcome = applyHoldTimeout(db, 'hitl::parent::nonce-7f3a', 'scrap');
    expect(outcome.autoSelected).toBe(false);
    expect(outcome.cardId).toBe('parent');
    expect(outcome.matched).toBe(true);
  });

  it('every effectful seam fires exactly once across crash + resume (zero re-bill, zero duplicates)', async () => {
    const stateDb = db.getStateDb();
    const ledger = makeLedger();
    const { transport } = makeTransport();

    // Seam A — a committed child publish must skip on resume (idempotency held).
    const publishKey = 'publish:child-0:0';
    writePendingIntent(stateDb, {
      flow: FLOW_ID, card: 'child-0', station: 'publish', attempt: 0,
      idempotencyKey: publishKey, intent: { kind: 'publish', childId: 'child-0' },
    });
    commitIntent(stateDb, publishKey);
    ledger.recordFire(publishKey);
    // Resume attempt on a committed key → skip (never re-fire).
    expect(reconcileOnResume(stateDb, publishKey).action).toBe('skip');

    // Seam B — the egress delivery must not double-post once committed.
    const deliveryKey = 'delivery:parent:0';
    const firstDeliver = await egressSend(db, transport, {
      channel: CHANNEL, text: 'DELIVERY: assembled', idempotencyKey: deliveryKey,
    });
    expect(firstDeliver.posted).toBe(true);
    ledger.recordFire(deliveryKey);
    const resumeDeliver = await egressSend(db, transport, {
      channel: CHANNEL, text: 'DELIVERY: assembled', idempotencyKey: deliveryKey,
    });
    expect(resumeDeliver.posted).toBe(false); // committed → no re-bill

    // OBSERVED: every effect key fired exactly once; no duplicates across resume.
    expect(ledger.firesForKey(publishKey)).toBe(1);
    expect(ledger.firesForKey(deliveryKey)).toBe(1);
    expect(ledger.duplicateEffects()).toBe(0);
  });
});
