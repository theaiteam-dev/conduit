/**
 * Executor wiring: file delivery at station completion (WI-599, PRD "Slack Egress
 * File Delivery" §6 FR-1/2/9/10/11/12/14, NFR-3/4, §9 decisions 6/8).
 *
 * When a station carrying a parsed `deliver` block (WI-596) completes and passes
 * the MARK_DONE owned-paths integrity gate, the executor resolves the delivery
 * channel (resolveDeliveryChannel — WI-596), resolves the thread address from the
 * ingress substrate, verifies each declared file is within owned_paths, and
 * delivers the files sequentially in declared order via egressSendFile (WI-598),
 * journaling each outcome and hard-pausing the card to `hold` on any ambiguous or
 * failed delivery rather than re-running station work.
 *
 * These tests drive the REAL runExecutor with a loader-built flow, an in-memory
 * DB, and the REAL egressSendFile/outbox; only createSlackTransport is mocked to
 * return a recording transport (its uploadFile is the observable Slack boundary).
 *
 * CONTRACT (team-lead decisions, 2026-07-12 — pinned here, cite in review):
 *
 * AC2 threading (Option A): the item Context mislabels substrate as per-card; it
 * lives on ingress_events keyed by the derived run_id. resolveThreadAddress(db,
 * card, thread_from) resolves via getIngressSubstrateForRun(card.run_id) (earliest
 * event if a run has several), JSON-parses substrate_json, reads the thread_from
 * field; no event / no field → undefined → unthreaded + journaled (FR-8 degrade).
 *
 * Delivery-hook crash/resume: the hook is IDEMPOTENT and RE-DRIVEN. Delivery is
 * part of station completion and is NEVER checkpoint-skipped — on re-dispatch of
 * the same attempt the station WORK may checkpoint-skip, but the completion path
 * re-drives the hook, iterating declared files in order via egressSendFile.
 * Prefix-resume falls out of the outbox: landed files (committed key
 * run/card/station/attempt/file/fingerprint) skip; the first unlanded file fires.
 * A mid-delivery crash leaves the card re-dispatchable in its working state (NOT
 * held); hold is reserved for escalatedToHold (ambiguous pending intent) and
 * delivery failures (missing/empty file, no channel). AC3-resume below stages the
 * partial state via a not-yet-produced file (a failure that holds, per that
 * contract) then re-dispatches — the observable re-drive (committed skip, unlanded
 * deliver, order preserved) is identical to the pure-crash path.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';
import { join, basename } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';

import type { ModelAdapter, ModelCall, ModelResponse } from '../worker/adapter';
import type { RunEngineArgs } from '../cli/main';
import type { WorkerMessage } from '../worker/ipc-protocol';
import type { Card, FlowConfig } from '../types/kernel';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import { loadFlow } from '../flow/load';
import { runExecutor } from './executor';
import type { SlackTransport } from '../channels/slack';

// ── slack.ts module seam: mock createSlackTransport, keep egressSendFile REAL ──
import * as slackNs from '../channels/slack';
const realSlack: Record<string, unknown> = { ...slackNs };

interface UploadCall {
  channel: string;
  filePath: string;
  threadTs?: string;
  caption?: string;
}

// Mutable recording surfaces — reset in beforeEach.
let uploads: UploadCall[] = [];
let posts: Array<{ channel: string; text: string; threadTs?: string }> = [];
// Basenames whose uploadFile call should throw (to simulate a partial-delivery crash).
let failUploadFor: Set<string> = new Set();

const recordingTransport: SlackTransport = {
  post: async (req) => {
    posts.push({ channel: req.channel, text: req.text, threadTs: req.threadTs });
    return { ts: `ts-${posts.length}` };
  },
  uploadFile: async (req) => {
    uploads.push({ channel: req.channel, filePath: req.filePath, threadTs: req.threadTs, caption: req.caption });
    if (failUploadFor.has(basename(req.filePath))) {
      throw new Error(`simulated upload crash for ${basename(req.filePath)}`);
    }
    return { ok: true, files: [{ id: `F-${uploads.length}` }] };
  },
};

const createSlackTransportMock = mock((_config: { botToken: string }) => recordingTransport);

// WI-602: the executor builds a files.info reconciler for the delivery path. We
// mock the FACTORY so the probe result is deterministic (no real network); the
// returned reconciler is only consulted by egressSendFile on a PENDING intent, so
// it is a no-op for the happy-path delivery tests above.
let reconcilerDecision: 'landed' | 'not_landed' | 'unknown' = 'not_landed';
const createFilesInfoReconcilerMock = mock((_cfg: unknown) => async (_intent: unknown) => reconcilerDecision);

mock.module('../channels/slack', () => ({
  ...realSlack, // egressSend / egressSendFile / resolveDeliveryChannel stay REAL
  createSlackTransport: createSlackTransportMock,
  createFilesInfoReconciler: createFilesInfoReconcilerMock,
}));

afterAll(() => {
  mock.module('../channels/slack', () => realSlack);
});

// ---------------------------------------------------------------------------
// Harness (mirrors executor-integrity-cascade.test.ts)
// ---------------------------------------------------------------------------

const SECONDS = (n: number) => () => n;

function noopAdapter(): ModelAdapter {
  return {
    async call(_req: ModelCall): Promise<ModelResponse> {
      return { text: '{}', inputTokens: 0, outputTokens: 0, costUsd: 0 };
    },
  };
}

function makeIO(): { io: { out(l: string): void; err(l: string): void }; lines: string[] } {
  const lines: string[] = [];
  return { io: { out: (l) => lines.push(l), err: (l) => lines.push(l) }, lines };
}

function openDb(): ConduitDB {
  const db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
  return db;
}

function seedCard(db: ConduitDB, over: Partial<Card> & { id: string; lane: string }): void {
  db.insertCard({
    run_id: DEFAULT_RUN_ID,
    id: over.id,
    parent_id: over.parent_id ?? null,
    lane: over.lane,
    status: over.status ?? 'ready',
    attempt: over.attempt ?? 0,
    wave: over.wave ?? 0,
    owned_paths: over.owned_paths ?? [],
    rework_count: over.rework_count ?? 0,
  });
}

const STATION = 'deliver-station';

/** Write a single-station deliver flow to disk and load it through the REAL loader. */
function setupDeliverFlow(
  dir: string,
  opts: { files: string[]; caption?: string; enforce?: boolean; channelUses?: string; threadFrom?: string },
): FlowConfig {
  const filesYaml = `[${opts.files.join(', ')}]`;
  const captionLine = opts.caption !== undefined ? `\n      caption: "${opts.caption}"` : '';
  const threadFromLine = opts.threadFrom !== undefined ? `\n      thread_from: ${opts.threadFrom}` : '';
  const usesLine = opts.channelUses !== undefined ? `\n      uses: [${opts.channelUses}]` : '';
  writeFileSync(
    join(dir, 'flow.yaml'),
    `
flow: file-delivery
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 100000 }
  per_card: { max_execution_attempts: 4 }
  liveness: { no_progress_minutes: 3 }
defaults: { cap_policy: scrap, on_dep_scrap: hold, enforce_owned_paths: ${opts.enforce ?? false} }
terminal_lanes: [done, scrap, hold]
security:
  bash: { allow: ["true"] }
channels:
  egress:
    - type: slack
      target: "#deliveries"${usesLine}
stations:
  - id: ${STATION}
    worker: { kind: deterministic, command: "true" }
    inputs: []
    outputs: []
    deliver:
      files: ${filesYaml}${captionLine}${threadFromLine}
    next: done
`,
  );
  const loaded = loadFlow(join(dir, 'flow.yaml'));
  if (!loaded.ok) throw new Error(`fixture flow invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

/** Pre-stage a produced file with NON-EMPTY content under the project root. */
function stageFile(dir: string, relPath: string, content = 'JPEG-BYTES'): void {
  const abs = join(dir, relPath);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

/**
 * Simulate an operator/`conduit resume` re-dispatch of a parked card: re-arm it
 * as ready at the delivery station (optionally bumping the attempt for a rework
 * loop). The already-committed delivery intents in the outbox remain, so a re-run
 * skips the landed files and re-drives only the outstanding delivery work.
 */
function resumeCard(db: ConduitDB, id: string, opts: { attempt?: number } = {}): void {
  const stateDb = db.getStateDb();
  if (opts.attempt !== undefined) {
    stateDb
      .prepare("UPDATE cards SET status='ready', lane=$lane, attempt=$a WHERE run_id=$r AND id=$id")
      .run({ $lane: STATION, $a: opts.attempt, $r: DEFAULT_RUN_ID, $id: id });
  } else {
    stateDb
      .prepare("UPDATE cards SET status='ready', lane=$lane WHERE run_id=$r AND id=$id")
      .run({ $lane: STATION, $r: DEFAULT_RUN_ID, $id: id });
  }
}

/** Committed outbox rows — one per landed delivery. */
function committedOutboxCount(db: ConduitDB): number {
  return (
    db
      .getStateDb()
      .prepare('SELECT COUNT(*) AS n FROM outbox WHERE delivered_at IS NOT NULL')
      .get() as { n: number }
  ).n;
}

/**
 * A controllable pool driver (mirrors executor-markdone.test.ts): captures the
 * kernel's inbound-IPC handler and auto-answers every START_WORK with a
 * MARK_DONE(success), so a POOLED station runs the REAL pool success handler.
 */
function makePoolDriver() {
  let handler: ((msg: WorkerMessage) => void) | null = null;
  const spawn = (args: { cardId: string; station: string }) => {
    const send = (msg: WorkerMessage): void => {
      if (msg.type === 'START_WORK' && handler) {
        handler({ type: 'MARK_DONE', cardId: args.cardId, station: args.station, attempt: 0, outcome: 'success' } as WorkerMessage);
      }
    };
    return { pid: 7000, send };
  };
  const onMessage = (h: (msg: WorkerMessage) => void): void => {
    handler = h;
  };
  return { spawn, onMessage };
}

let projectDir: string;
let originalCwd: string;
let db: ConduitDB | null;

beforeEach(() => {
  originalCwd = process.cwd();
  projectDir = mkdtempSync(join(tmpdir(), 'conduit-file-delivery-'));
  process.chdir(projectDir);
  db = null;
  uploads = [];
  posts = [];
  failUploadFor = new Set();
  reconcilerDecision = 'not_landed';
  createSlackTransportMock.mockClear();
  createFilesInfoReconcilerMock.mockClear();
});

afterEach(() => {
  if (db) {
    db.close();
    db = null;
  }
  process.chdir(originalCwd);
  rmSync(projectDir, { recursive: true, force: true });
});

// ===========================================================================
// AC1 — a completed deliver-block station delivers each file through the
//       resolved channel, with the caption forwarded (FR-1/FR-2/FR-9)
// ===========================================================================

describe('executor file delivery — delivery at station completion (AC1)', () => {
  it('delivers the declared file through the uses:[delivery] channel with the caption', async () => {
    const flow = setupDeliverFlow(projectDir, {
      files: ['work/edited.jpg'],
      caption: 'here you go',
      channelUses: 'delivery',
    });
    db = openDb();
    seedCard(db, { id: 'c', lane: STATION });
    stageFile(projectDir, 'work/edited.jpg');
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter: noopAdapter(), io } as RunEngineArgs);

    // The file was delivered exactly once, to the resolved delivery channel,
    // with the deliver-block caption forwarded to egressSendFile → uploadFile.
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.channel).toBe('#deliveries');
    expect(uploads[0]!.filePath).toContain(join('work', 'edited.jpg'));
    expect(uploads[0]!.caption).toBe('here you go');
    // The card completed through delivery to the terminal lane.
    expect(db.getCard(DEFAULT_RUN_ID, 'c')?.lane).toBe('done');
    // The effectful delivery committed in the outbox (a resume would skip it).
    expect(committedOutboxCount(db)).toBe(1);
  });
});

// ===========================================================================
// AC2 — the thread address is resolved from the ingress substrate via the
//       deliver block thread_from: present → threaded; absent (substrate cannot
//       supply it) → unthreaded + the skipped threading journaled (FR-6/FR-8,
//       decision 6). resolveThreadAddress(db, card, thread_from) reads the run's
//       ingress substrate (getIngressSubstrateForRun) — NOT a per-card field.
// ===========================================================================

const THREAD_TS = '1699999999.123456';

describe('executor file delivery — thread address from ingress substrate (AC2)', () => {
  it('threads the delivery on the substrate thread_from value when the ingress event supplies it', async () => {
    const flow = setupDeliverFlow(projectDir, {
      files: ['work/edited.jpg'],
      threadFrom: 'thread_ts',
      channelUses: 'delivery',
    });
    db = openDb();
    seedCard(db, { id: 'c', lane: STATION });
    stageFile(projectDir, 'work/edited.jpg');
    // The triggering ingress event projected `thread_ts` into the run's substrate;
    // resolveThreadAddress(db, card, 'thread_ts') must read it back off ingress_events.
    db.acceptIngressEvent('evt-1', 1000, {
      flowId: 'file-delivery',
      flowPath: join(projectDir, 'flow.yaml'),
      runId: DEFAULT_RUN_ID,
      substrateJson: JSON.stringify({ thread_ts: THREAD_TS }),
    });
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter: noopAdapter(), io } as RunEngineArgs);

    expect(uploads).toHaveLength(1);
    // The file landed as a threaded reply on the triggering message's thread_ts.
    expect(uploads[0]!.threadTs).toBe(THREAD_TS);
  });

  it('delivers unthreaded and journals the skipped threading when the substrate cannot supply thread_from (FR-8)', async () => {
    const flow = setupDeliverFlow(projectDir, {
      files: ['work/edited.jpg'],
      threadFrom: 'thread_ts',
      channelUses: 'delivery',
    });
    db = openDb();
    seedCard(db, { id: 'c', lane: STATION });
    stageFile(projectDir, 'work/edited.jpg');
    // No ingress event for this run (e.g. a CLI-triggered run) → the substrate
    // cannot supply thread_ts. Delivery must NOT be blocked (decision 6).
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter: noopAdapter(), io } as RunEngineArgs);

    // Delivered, but unthreaded — a missing address is a runtime degrade, not a failure.
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.threadTs).toBeUndefined();
    // …and the skipped threading is journaled so it is diagnosable in explain (FR-8).
    const spans = db.getJournalSpansForRun(DEFAULT_RUN_ID, 'c');
    const threadingSkipJournaled = spans.some(
      (s) => /thread/i.test(JSON.stringify(s.attributes)) && /skip|unthread|absent|degrad/i.test(JSON.stringify(s.attributes)),
    );
    expect(threadingSkipJournaled).toBe(true);
  });
});

// ===========================================================================
// AC4 — a declared file outside owned_paths (with enforcement on) holds the
//       card and is NOT delivered (FR-14)
// ===========================================================================

describe('executor file delivery — owned_paths gate on declared files (AC4)', () => {
  it('holds the card and delivers nothing when a declared file falls outside owned_paths', async () => {
    const flow = setupDeliverFlow(projectDir, {
      files: ['work/edited.jpg'],
      enforce: true,
      channelUses: 'delivery',
    });
    db = openDb();
    // The card owns a DIFFERENT path; the declared deliver file is out of bounds.
    seedCard(db, { id: 'c', lane: STATION, owned_paths: ['work/allowed.jpg'] });
    stageFile(projectDir, 'work/edited.jpg');
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter: noopAdapter(), io } as RunEngineArgs);

    // Containment breach on the declared file → hold, nothing delivered.
    expect(db.getCard(DEFAULT_RUN_ID, 'c')?.status).toBe('held');
    expect(uploads).toHaveLength(0);
    expect(committedOutboxCount(db)).toBe(0);
  });

  // Review MEDIUM: delivery is an egress surface, so project-root containment is
  // UNCONDITIONAL — independent of enforce_owned_paths. A symlink UNDER the root
  // that points OUTSIDE is lexically contained (passes load) but resolves out at
  // read time; it must hold and ship nothing, NOT read+upload the outside target.
  it('holds and delivers nothing for a symlink that resolves outside the root — even with enforcement OFF', async () => {
    // A secret target OUTSIDE the project root.
    const outsideDir = mkdtempSync(join(tmpdir(), 'conduit-outside-'));
    const secret = join(outsideDir, 'secret.env');
    writeFileSync(secret, 'API_KEY=super-secret');

    // A symlink UNDER the project root pointing at the outside secret.
    mkdirSync(join(projectDir, 'work'), { recursive: true });
    symlinkSync(secret, join(projectDir, 'work', 'leak.jpg'));

    // enforce_owned_paths OFF (default) — containment must still apply.
    const flow = setupDeliverFlow(projectDir, { files: ['work/leak.jpg'], channelUses: 'delivery' });
    db = openDb();
    seedCard(db, { id: 'c', lane: STATION });
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter: noopAdapter(), io } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'c')?.status).toBe('held');
    expect(uploads).toHaveLength(0);
    expect(committedOutboxCount(db)).toBe(0);

    rmSync(outsideDir, { recursive: true, force: true });
  });
});

// ===========================================================================
// AC5 — a delivery that cannot complete (a declared file is missing) hard-pauses
//       the card to hold; station work is NOT re-run to force re-delivery
//       (FR-11, NFR-3)
// ===========================================================================

describe('executor file delivery — hold on unfulfillable delivery (AC5)', () => {
  it('holds the card and does not re-run the station when a declared file is missing at delivery', async () => {
    const flow = setupDeliverFlow(projectDir, { files: ['work/edited.jpg'], channelUses: 'delivery' });
    db = openDb();
    seedCard(db, { id: 'c', lane: STATION, attempt: 0 });
    // The declared file is NOT staged — the station "succeeded" but produced nothing.
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter: noopAdapter(), io } as RunEngineArgs);

    const card = db.getCard(DEFAULT_RUN_ID, 'c');
    // Ambiguous/failed delivery → hold, nothing delivered/committed.
    expect(card?.status).toBe('held');
    expect(uploads).toHaveLength(0);
    expect(committedOutboxCount(db)).toBe(0);
    // The station work is NOT silently re-run to force a re-delivery (no rework bump).
    expect(card?.attempt).toBe(0);
  });
});

// ===========================================================================
// AC3 (order half) — multiple declared files deliver sequentially in declared
//       order (FR-10, decision 8)
// ===========================================================================

describe('executor file delivery — sequential multi-file order (AC3)', () => {
  it('delivers multiple declared files in declared order', async () => {
    const flow = setupDeliverFlow(projectDir, {
      files: ['work/a.jpg', 'work/b.jpg', 'work/c.jpg'],
      channelUses: 'delivery',
    });
    db = openDb();
    seedCard(db, { id: 'c', lane: STATION });
    stageFile(projectDir, 'work/a.jpg', 'AAA');
    stageFile(projectDir, 'work/b.jpg', 'BBB');
    stageFile(projectDir, 'work/c.jpg', 'CCC');
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter: noopAdapter(), io } as RunEngineArgs);

    expect(uploads.map((u) => basename(u.filePath))).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
    expect(committedOutboxCount(db)).toBe(3);
    expect(db.getCard(DEFAULT_RUN_ID, 'c')?.lane).toBe('done');
  });
});

// ===========================================================================
// AC3 (resume half) — after a partial delivery, resume re-delivers only the
//       unlanded files, in order (committed intents skip) (FR-10, decision 8)
// ===========================================================================

describe('executor file delivery — partial-delivery resume (AC3)', () => {
  it('re-delivers only the unlanded files on resume, preserving order (committed skip)', async () => {
    const flow = setupDeliverFlow(projectDir, {
      files: ['work/a.jpg', 'work/b.jpg', 'work/c.jpg'],
      channelUses: 'delivery',
    });
    db = openDb();
    seedCard(db, { id: 'c', lane: STATION });
    // Only a is produced on the first pass: a lands+commits, then b is not yet on
    // disk → the delivery cannot complete → the card parks (partial delivery). b's
    // delivery leaves NO outbox intent (WI-598 rejects a missing file before any
    // pending write), so on resume it is status-none and re-delivers cleanly.
    stageFile(projectDir, 'work/a.jpg', 'AAA');
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter: noopAdapter(), io } as RunEngineArgs);

    expect(uploads.map((u) => basename(u.filePath))).toEqual(['a.jpg']); // only a landed
    expect(committedOutboxCount(db)).toBe(1);

    // Resume: b and c are now produced. a is already-committed → skips; only the
    // unlanded files re-deliver, in declared order.
    stageFile(projectDir, 'work/b.jpg', 'BBB');
    stageFile(projectDir, 'work/c.jpg', 'CCC');
    uploads = [];
    resumeCard(db, 'c');
    await runExecutor({ db, flow, now: SECONDS(1000), adapter: noopAdapter(), io } as RunEngineArgs);

    expect(uploads.map((u) => basename(u.filePath))).toEqual(['b.jpg', 'c.jpg']);
    expect(committedOutboxCount(db)).toBe(3);
  });
});

// ===========================================================================
// AC6 — the idempotency-key prefix carries the attempt: a rework attempt (N+1)
//       re-delivers the new artifact, while a same-attempt resume delivers
//       nothing twice (FR-5, rework edge case)
// ===========================================================================

describe('executor file delivery — attempt-keyed rework re-delivery (AC6)', () => {
  it('re-delivers on a new attempt but dedups a same-attempt resume', async () => {
    const flow = setupDeliverFlow(projectDir, { files: ['work/edited.jpg'], channelUses: 'delivery' });
    db = openDb();
    seedCard(db, { id: 'c', lane: STATION, attempt: 0 });
    stageFile(projectDir, 'work/edited.jpg', 'ORIGINAL');
    const { io } = makeIO();

    // Attempt 0 delivers the original artifact.
    await runExecutor({ db, flow, now: SECONDS(1000), adapter: noopAdapter(), io } as RunEngineArgs);
    expect(uploads).toHaveLength(1);
    expect(committedOutboxCount(db)).toBe(1);

    // Same-attempt resume (unchanged bytes, same attempt) → committed key → dedup.
    resumeCard(db, 'c'); // attempt stays 0
    await runExecutor({ db, flow, now: SECONDS(1000), adapter: noopAdapter(), io } as RunEngineArgs);
    expect(uploads).toHaveLength(1); // NOT delivered twice
    expect(committedOutboxCount(db)).toBe(1);

    // Rework: QC back-edge re-runs the station on attempt 1 producing a NEW
    // artifact. The attempt in the key prefix makes it a distinct delivery.
    writeFileSync(join(projectDir, 'work', 'edited.jpg'), 'REWORKED');
    resumeCard(db, 'c', { attempt: 1 });
    await runExecutor({ db, flow, now: SECONDS(1000), adapter: noopAdapter(), io } as RunEngineArgs);
    expect(uploads).toHaveLength(2); // the reworked artifact re-delivered
    expect(committedOutboxCount(db)).toBe(2);
  });
});

// ===========================================================================
// AC7 — each delivery is journaled per attempt (visible in explain) (FR-12)
// ===========================================================================

describe('executor file delivery — journaling (AC7)', () => {
  it('journals the delivery outcome for the attempt with the delivered file identified', async () => {
    const flow = setupDeliverFlow(projectDir, { files: ['work/edited.jpg'], channelUses: 'delivery' });
    db = openDb();
    seedCard(db, { id: 'c', lane: STATION });
    stageFile(projectDir, 'work/edited.jpg');
    const { io } = makeIO();

    await runExecutor({ db, flow, now: SECONDS(1000), adapter: noopAdapter(), io } as RunEngineArgs);

    // A delivery span is journaled for the card, naming the delivered file so it
    // surfaces in explain like other effectful sends.
    const spans = db.getJournalSpansForRun(DEFAULT_RUN_ID, 'c');
    const deliverySpans = spans.filter((s) => /deliver/i.test(s.name));
    expect(deliverySpans.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(deliverySpans.map((s) => s.attributes))).toContain('edited.jpg');
  });
});

// ===========================================================================
// WI-602 AC5 (journal half) — when a pending delivery intent is reconciled on
//       resume, the reconciler decision is journaled per attempt (explain-visible)
// ===========================================================================

describe('executor file delivery — reconcile decision is journaled (WI-602 AC5)', () => {
  it('journals the reconciler decision per attempt when a pending intent is reconciled on resume', async () => {
    const flow = setupDeliverFlow(projectDir, { files: ['work/edited.jpg'], channelUses: 'delivery' });
    db = openDb();
    seedCard(db, { id: 'c', lane: STATION });
    stageFile(projectDir, 'work/edited.jpg');
    const { io } = makeIO();

    // Run 1: the upload crashes → a PENDING (uncommitted) intent + the card holds.
    failUploadFor = new Set(['edited.jpg']);
    await runExecutor({ db, flow, now: SECONDS(1000), adapter: noopAdapter(), io } as RunEngineArgs);
    expect(db.getCard(DEFAULT_RUN_ID, 'c')?.status).toBe('held');

    // Resume: the files.info reconciler (mocked → not_landed) re-fires the delivery,
    // and the executor journals the reconcile decision (fire) for the attempt.
    reconcilerDecision = 'not_landed';
    failUploadFor = new Set();
    uploads = [];
    resumeCard(db, 'c');
    await runExecutor({ db, flow, now: SECONDS(1000), adapter: noopAdapter(), io } as RunEngineArgs);

    expect(uploads).toHaveLength(1); // the reconciled re-fire landed
    const spans = db.getJournalSpansForRun(DEFAULT_RUN_ID, 'c');
    const decisionJournaled = spans.some((s) => {
      const blob = `${s.name} ${JSON.stringify(s.attributes)}`;
      return /reconcil/i.test(blob) && /fire/.test(blob);
    });
    expect(decisionJournaled).toBe(true);
  });
});

// ===========================================================================
// Pool-path regression (Stockwell FINAL REJECT) — a deterministic deliver-block
// station under concurrency>1 must NOT silently skip delivery. The pool
// MARK_DONE success handler does FSM+checkpoint+advance but never calls
// performStationDelivery, and poolEligible does not exclude deliver stations —
// so the file was silently dropped (no upload, no intent, no journal, no hold,
// card advanced). The synchronous path (all other tests here) never exercised it.
// ===========================================================================

describe('executor file delivery — pool mode does not skip delivery (concurrency>1)', () => {
  it('delivers a deliver-block station under concurrency>1 instead of silently advancing with nothing', async () => {
    const flow = setupDeliverFlow(projectDir, { files: ['work/edited.jpg'], caption: 'pooled', channelUses: 'delivery' });
    db = openDb();
    seedCard(db, { id: 'c', lane: STATION });
    stageFile(projectDir, 'work/edited.jpg');
    const { io } = makeIO();
    const driver = makePoolDriver();

    // Pool mode: concurrency>1 with spawn+onMessage wired — a plain deterministic
    // station is pool-eligible today, so this drives the pool MARK_DONE handler.
    await runExecutor({
      db,
      flow,
      now: SECONDS(1000),
      adapter: noopAdapter(),
      io,
      concurrency: 3,
      spawn: driver.spawn,
      onMessage: driver.onMessage,
    } as RunEngineArgs);

    // The declared file MUST actually be delivered (uploaded + committed +
    // journaled) — never dropped while the card advances. (With the file present,
    // delivery succeeds; a genuinely failing delivery would hold instead — either
    // way, NOT a silent advance-with-nothing.)
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.filePath).toContain(join('work', 'edited.jpg'));
    expect(committedOutboxCount(db)).toBe(1);
    const spans = db.getJournalSpansForRun(DEFAULT_RUN_ID, 'c');
    expect(spans.some((s) => /deliver/i.test(s.name))).toBe(true);
  });
});

// ===========================================================================
// issue #98 — deliver.files naming a card-scoped harness output is delivered
//             from each card's own directory, not from a shared project-root
//             file of the same name.
// ===========================================================================

describe('executor file delivery — card-scoped harness outputs (issue #98)', () => {
  it("delivers each sibling's own report from its owned dir", async () => {
    const { createHarnessRegistry } = await import('../worker/harness-adapter');
    const walker = {
      name: 'fake-walker',
      reportsUsage: true,
      canRestrictTools: true,
      async probeBinary() {
        return { present: true };
      },
      async invoke(call: import('../worker/harness-adapter').HarnessInvocation) {
        const check = /"check":\s*"([^"]+)"/.exec(call.prompt)![1]!;
        for (const out of call.declaredOutputs ?? []) {
          writeFileSync(out.path, out.name === 'result.json' ? JSON.stringify({ verdict: check }) : `REPORT-${check}`);
        }
        return { outputs: [], usage: { tokens: 1, cost: 0 } };
      },
    };
    const registry = createHarnessRegistry([walker]);
    mkdirSync(join(projectDir, 'prompts'), { recursive: true });
    writeFileSync(join(projectDir, 'prompts', 'walk.md'), 'Walk {{seed.json}}');
    writeFileSync(
      join(projectDir, 'flow.yaml'),
      `
flow: harness-delivery
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 100000 }
  per_card: { max_execution_attempts: 2 }
  liveness: { no_progress_minutes: 3 }
terminal_lanes: [done, scrap, hold]
channels:
  egress:
    - type: slack
      target: "#deliveries"
      uses: [delivery]
stations:
  - id: ${STATION}
    worker:
      kind: harness
      harness: fake-walker
      prompt_file: prompts/walk.md
      prompt_version: "1"
      tools: [Read, Write]
      output_schema:
        fields:
          - { name: verdict, type: string, required: true }
    inputs: [seed.json]
    outputs: [result.json, report.md]
    output_scope: owned_dir
    deliver:
      files: [report.md]
    next: done
`,
    );
    const loaded = loadFlow(join(projectDir, 'flow.yaml'), { harnessRegistry: registry });
    if (!loaded.ok) throw new Error(`fixture flow invalid: ${JSON.stringify(loaded.errors)}`);
    // A decoy at the shared name: delivering it would ship the wrong bytes.
    stageFile(projectDir, 'report.md', 'DECOY');
    db = openDb();
    for (const check of ['c1', 'c2']) {
      stageFile(projectDir, `evidence/${check}/seed.json`, JSON.stringify({ check }));
      seedCard(db, { id: check, lane: STATION, owned_paths: [`evidence/${check}`] });
    }
    const { io } = makeIO();

    await runExecutor({
      db, flow: loaded.flow, now: SECONDS(1000), adapter: noopAdapter(), io, harnessRegistry: registry,
    } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'c1')?.lane).toBe('done');
    expect(db.getCard(DEFAULT_RUN_ID, 'c2')?.lane).toBe('done');
    const delivered = uploads.map((u) => u.filePath).sort();
    expect(delivered).toHaveLength(2);
    expect(delivered[0]).toContain(join('evidence', 'c1', 'report.md'));
    expect(delivered[1]).toContain(join('evidence', 'c2', 'report.md'));
  });
});
