/**
 * Keyed ingress runs through the real listener (issue #36).
 *
 * Drives startListener + handleWebhook against a real sqlite state DB, seaming
 * only the spawn and alert I/O as the other listener tests do. The spawn seam
 * hands back a controllable exit; `finishPass` plays the child's part by
 * writing what a completed `conduit run` (pass 1) or `conduit run
 * --append-pass` (pass N) leaves behind (the runs row and the pass entry card)
 * before resolving the exit.
 *
 * Pinned here:
 *   - an unkeyed binding is byte-identical to before: per-delivery run id,
 *     unstamped substrate, no append-pass;
 *   - `when` filters before accept (2xx, logged 'filtered', no row, no spawn);
 *   - an unresolvable run key is refused (400, 'rejected_run_key', no row);
 *   - alternative key paths land on the same run;
 *   - events during a pass coalesce into ONE trailing pass, run on the latest
 *     event's substrate;
 *   - a finished run takes the next event as an append-pass;
 *   - max_passes and a halted run refuse, alerting once per run;
 *   - a parked run folds the event into its pending pass;
 *   - a lease-conflict exit becomes pending, not spawn_failed;
 *   - a pending pass survives a listener restart;
 *   - the boot re-drive launches a queued keyed event correctly (append-pass
 *     when the run exists), and the release kick launches one queued behind a
 *     busy slot.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConduitDB, type ConduitDB } from '../persistence/db';
import type { FlowConfig, FlowChannels, FlowEgressChannel } from '../types/kernel';
import type { LoadFlowResult } from '../flow/load';
import { buildEnvelope } from './envelope';
import { deriveIngressRunId, deriveKeyedIngressRunId } from './run-id';
import { EXIT_RUN_LEASE_CONFLICT } from '../run/run-passes';
import type { SpawnExit, SpawnFailedAlert, SpawnInvocation, SpawnSeam } from './spawn';
import { startListener, type ListenerDeps, type ListenerConfig } from './listener';
import { drainKeyedRun, routeKeyedEvent, type KeyedRunDeps } from './keyed-runs';
import { createRunSlots } from './run-slots';

const NOW = 1_700_000_000_000;
const FLOW_PATH = '/flows/pr-loop.yaml';
const FLOW_ID = 'prLoop';

let dir: string;
let db: ConduitDB;
let launches: Array<SpawnInvocation & { exit: (code: number) => void; lose: (why: string) => void }>;
let alerts: SpawnFailedAlert[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conduit-keyed-'));
  db = openConduitDB({ stateDbPath: join(dir, 'state.sqlite'), journalDbPath: join(dir, 'journal.sqlite') });
  launches = [];
  alerts = [];
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // already closed
  }
  rmSync(dir, { recursive: true, force: true });
});

/** Every launch stays live until the test resolves its exit. */
const controlledSpawn: SpawnSeam = async (invocation) => {
  let resolveExit!: (exit: SpawnExit) => void;
  let rejectExit!: (err: Error) => void;
  const exited = new Promise<SpawnExit>((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });
  launches.push({ ...invocation, exit: (code) => resolveExit({ code }), lose: (why) => rejectExit(new Error(why)) });
  return { ok: true, exited };
};

function keyedIngress(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'webhook',
    route: '/hooks/pr',
    auth: { type: 'hmac', secret_env: 'WH_SECRET' },
    event_id: { from: 'header', name: 'x-delivery' },
    run_key: [{ json_path: '$.repo' }, { json_path: ['$.pr', '$.issue'] }],
    ...over,
  };
}

function makeFlow(ingress: Record<string, unknown>): FlowConfig {
  const channels: FlowChannels = {
    ingress: ingress as unknown as FlowChannels['ingress'],
    egress: [{ type: 'slack', target: '#pr-loop' } as FlowEgressChannel],
  };
  return { version: 1, stations: {}, channels };
}

function loadFlowFrom(flow: FlowConfig): (path: string) => LoadFlowResult {
  return (path) =>
    path === FLOW_PATH ? { ok: true, flow } : { ok: false, errors: [{ code: 'FILE_NOT_FOUND', message: path }] };
}

function makeDeps(flow: FlowConfig, over: Partial<ListenerDeps> = {}): ListenerDeps {
  return {
    db,
    spawn: controlledSpawn,
    alert: async (a) => {
      alerts.push(a);
    },
    loadFlow: loadFlowFrom(flow),
    verifyWebhookAuth: () => true,
    verifySlackAuth: () => true,
    respawn: async () => {
      throw new Error('a keyed row must never reach the unkeyed respawn seam');
    },
    redriveCap: 3,
    now: () => NOW,
    ...over,
  };
}

function config(over: Partial<ListenerConfig> = {}): ListenerConfig {
  return {
    allowlist: { [FLOW_ID]: FLOW_PATH },
    globalAlertChannel: '#ops',
    secrets: { WH_SECRET: 'shh' },
    ...over,
  };
}

async function boot(flow: FlowConfig, over: Partial<ListenerDeps> = {}, cfg: Partial<ListenerConfig> = {}) {
  const result = await startListener(makeDeps(flow, over), config(cfg));
  if (!result.ok) throw new Error(`listener refused to start: ${JSON.stringify(result.errors)}`);
  return result.listener;
}

let deliverySeq = 0;
function prEvent(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  deliverySeq += 1;
  return {
    route: '/hooks/pr',
    headers: { 'x-delivery': `d-${deliverySeq}-${Math.random()}`, 'X-GitHub-Event': 'pull_request_review', ...headers },
    rawBody: JSON.stringify(body),
  };
}

const RUN = deriveKeyedIngressRunId(FLOW_ID, ['acme/widgets', '7']);

/** Let detached watchers and drains run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Play the kernel's seeding step: record the events the launch covers against
 * its pass, as `conduit run --pass-event` does with the entry card.
 */
function seedPassEvents(index: number, pass: number): void {
  db.recordPassEvents(launches[index]!.runId, pass, launches[index]!.passEvents ?? []);
}

/** Play the child: record what a completed pass leaves in the DB, then exit 0. */
async function finishPass(index: number, pass: number): Promise<void> {
  const runId = launches[index]!.runId;
  seedPassEvents(index, pass);
  if (db.getRun(runId) === null) {
    db.insertRun({ run_id: runId, flow: FLOW_PATH, input_fingerprint: 'fp', status: 'done', outcome: 'complete' });
  } else {
    db.getStateDb().prepare("UPDATE runs SET status = 'done', outcome = 'complete' WHERE run_id = $r").run({ $r: runId });
  }
  db.insertCard({
    run_id: runId,
    id: pass === 1 ? `entry-${runId}` : `entry-${runId}-p${pass}`,
    parent_id: null,
    lane: 'done',
    status: 'complete',
    attempt: 0,
    wave: 0,
    owned_paths: [],
    rework_count: 0,
  });
  launches[index]!.exit(0);
  await settle();
}

function stampedInput(index: number): Record<string, unknown> {
  return JSON.parse(launches[index]!.inputInline) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------

describe('an unkeyed binding is unchanged', () => {
  it('derives the per-delivery run id and passes the plain envelope, never an append-pass', async () => {
    const ingress = keyedIngress();
    delete ingress['run_key'];
    const listener = await boot(makeFlow(ingress));
    const req = prEvent({ repo: 'acme/widgets', pr: 7 });

    const res = await listener.handleWebhook(req);

    expect(res.status).toBe(202);
    expect(launches).toHaveLength(1);
    const eventId = req.headers['x-delivery']!;
    expect(launches[0]!.runId).toBe(deriveIngressRunId(eventId));
    expect(launches[0]!.appendPass).toBeUndefined();
    const expected = buildEnvelope({
      source: FLOW_ID,
      eventId,
      receivedAt: NOW,
      authVerified: true,
      headers: req.headers,
      body: { repo: 'acme/widgets', pr: 7 },
    });
    expect(launches[0]!.inputInline).toBe(JSON.stringify(expected));
    expect(db.getKeyedRun(launches[0]!.runId)).toBeNull();
  });
});

describe('when filter', () => {
  const flow = () =>
    makeFlow(keyedIngress({ when: [{ header: 'X-GitHub-Event', in: ['pull_request_review', 'issue_comment'] }] }));

  it('acks and logs a non-matching event without accepting or spawning it', async () => {
    const listener = await boot(flow());
    const req = prEvent({ repo: 'acme/widgets', pr: 7 }, { 'X-GitHub-Event': 'push' });

    const res = await listener.handleWebhook(req);

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body!)).toEqual({ outcome: 'filtered' });
    expect(launches).toHaveLength(0);
    expect(db.getIngressEvent(req.headers['x-delivery']!)).toBeNull();
    expect(db.getIngressLog({ outcome: 'filtered' })).toHaveLength(1);
  });

  it('accepts a matching event', async () => {
    const listener = await boot(flow());
    expect((await listener.handleWebhook(prEvent({ repo: 'acme/widgets', pr: 7 }))).status).toBe(202);
    expect(launches).toHaveLength(1);
  });

  it('filters an unkeyed binding too', async () => {
    const ingress = keyedIngress({ when: [{ json_path: '$.action', in: ['submitted'] }] });
    delete ingress['run_key'];
    const listener = await boot(makeFlow(ingress));
    expect((await listener.handleWebhook(prEvent({ action: 'edited' }))).status).toBe(200);
    expect(launches).toHaveLength(0);
  });
});

describe('run key resolution', () => {
  it('refuses an event whose key does not resolve: 400, logged, never accepted', async () => {
    const listener = await boot(makeFlow(keyedIngress()));
    const req = prEvent({ repo: 'acme/widgets' }); // neither pr nor issue

    const res = await listener.handleWebhook(req);

    expect(res.status).toBe(400);
    expect(launches).toHaveLength(0);
    expect(db.getIngressEvent(req.headers['x-delivery']!)).toBeNull();
    const [entry] = db.getIngressLog({ outcome: 'rejected_run_key' });
    expect(entry!.reason).toContain('part 1');
  });

  it('launches pass 1 under the keyed run id, stamped with run_key and pass', async () => {
    const listener = await boot(makeFlow(keyedIngress()));
    const res = await listener.handleWebhook(prEvent({ repo: 'acme/widgets', pr: 7 }));

    expect(res.status).toBe(202);
    expect(JSON.parse(res.body!)).toEqual({ outcome: 'accepted', run_id: RUN });
    expect(launches[0]!.runId).toBe(RUN);
    expect(launches[0]!.appendPass).toBeUndefined();
    expect(stampedInput(0)).toMatchObject({ run_key: ['acme/widgets', '7'], pass: 1 });
  });

  it('maps an alternative path onto the same run', async () => {
    const listener = await boot(makeFlow(keyedIngress()));
    await listener.handleWebhook(prEvent({ repo: 'acme/widgets', pr: 7 }));
    await finishPass(0, 1);
    await listener.handleWebhook(prEvent({ repo: 'acme/widgets', issue: 7 }));
    expect(launches[1]!.runId).toBe(RUN);
    expect(launches[1]!.appendPass).toBe(true);
  });
});

describe('passes of one run', () => {
  it('coalesces six events during a pass into one trailing pass on the latest event, listing all six', async () => {
    const listener = await boot(makeFlow(keyedIngress()));
    const first = prEvent({ repo: 'acme/widgets', pr: 7, seq: 0 });
    await listener.handleWebhook(first);
    const folded: string[] = [];
    for (let seq = 1; seq <= 6; seq++) {
      const req = prEvent({ repo: 'acme/widgets', pr: 7, seq });
      folded.push(req.headers['x-delivery']!);
      const res = await listener.handleWebhook(req);
      expect(res.status).toBe(202);
      expect(JSON.parse(res.body!).outcome).toBe('coalesced');
    }
    expect(launches[0]!.passEvents).toEqual([first.headers['x-delivery']!]);
    expect(stampedInput(0)).toMatchObject({ pass: 1, events_truncated: false });
    expect((stampedInput(0).events as unknown[]).length).toBe(1);
    expect(launches).toHaveLength(1);
    expect(db.getIngressLog({ outcome: 'coalesced' })).toHaveLength(6);

    await finishPass(0, 1);

    expect(launches).toHaveLength(2);
    expect(launches[1]!.appendPass).toBe(true);
    expect(stampedInput(1)).toMatchObject({ pass: 2, body: { seq: 6 }, events_truncated: false });
    const events = stampedInput(1).events as Array<{ event_id: string; substrate: { body: { seq: number } } }>;
    expect(events.map((e) => e.event_id)).toEqual(folded);
    expect(events.map((e) => e.substrate.body.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(launches[1]!.passEvents).toEqual(folded);
    expect(db.getKeyedRun(RUN)!.pending_event_id).toBeNull();

    await finishPass(1, 2);
    expect(launches).toHaveLength(2);
    for (const eventId of folded) expect(db.getPassForEvent(eventId)).toEqual({ run_id: RUN, pass: 2 });
  });

  it('refuses a coalesced event whose substrate_json goes missing before its pass launches, logging it once', async () => {
    const listener = await boot(makeFlow(keyedIngress()));
    await listener.handleWebhook(prEvent({ repo: 'acme/widgets', pr: 7, seq: 0 })); // launches pass 1

    const eventA = prEvent({ repo: 'acme/widgets', pr: 7, seq: 1 });
    const idA = eventA.headers['x-delivery']!;
    await listener.handleWebhook(eventA);
    const eventB = prEvent({ repo: 'acme/widgets', pr: 7, seq: 2 });
    const idB = eventB.headers['x-delivery']!;
    await listener.handleWebhook(eventB);

    // Both folded events are 'coalesced'; only one is the run's pending
    // pointer. Corrupt the OTHER one, whichever it turns out to be.
    const pendingId = db.getKeyedRun(RUN)!.pending_event_id!;
    const staleId = pendingId === idA ? idB : idA;
    db.getStateDb()
      .prepare('UPDATE ingress_events SET substrate_json = NULL WHERE event_id = $id')
      .run({ $id: staleId });

    await finishPass(0, 1); // pass 1 exits; the drain launches the pending event as pass 2

    expect(launches).toHaveLength(2);
    const events = stampedInput(1).events as Array<{ event_id: string }>;
    expect(events.map((e) => e.event_id)).not.toContain(staleId);
    expect(launches[1]!.passEvents).not.toContain(staleId);

    const malformed = db.getIngressLog({ outcome: 'rejected_malformed' });
    expect(malformed).toHaveLength(1);
    expect(malformed[0]!.eventId).toBe(staleId);
    expect(malformed[0]!.reason).toContain(RUN);
    expect(malformed[0]!.reason).toContain('substrate_json');
    // No longer 'coalesced': a later pass must not pick it up or re-log it.
    expect(db.getIngressEvent(staleId)!.spawn_state).not.toBe('coalesced');

    await finishPass(1, 2);
    await listener.handleWebhook(prEvent({ repo: 'acme/widgets', pr: 7, seq: 3 }));

    expect(launches).toHaveLength(3);
    expect(db.getIngressLog({ outcome: 'rejected_malformed' })).toHaveLength(1);
  });

  it('launches the next event on a finished run as an append-pass right away', async () => {
    const listener = await boot(makeFlow(keyedIngress()));
    await listener.handleWebhook(prEvent({ repo: 'acme/widgets', pr: 7 }));
    await finishPass(0, 1);

    const res = await listener.handleWebhook(prEvent({ repo: 'acme/widgets', pr: 7, round: 2 }));

    expect(JSON.parse(res.body!).outcome).toBe('accepted');
    expect(launches[1]!.appendPass).toBe(true);
    expect(stampedInput(1)).toMatchObject({ pass: 2, body: { round: 2 } });
  });

  it('keeps separate subjects in separate runs that run concurrently', async () => {
    const listener = await boot(makeFlow(keyedIngress()));
    await listener.handleWebhook(prEvent({ repo: 'acme/widgets', pr: 7 }));
    await listener.handleWebhook(prEvent({ repo: 'acme/widgets', pr: 8 }));
    expect(launches.map((l) => l.runId)).toEqual([RUN, deriveKeyedIngressRunId(FLOW_ID, ['acme/widgets', '8'])]);
  });

  it('refuses past max_passes, alerting once per run', async () => {
    const listener = await boot(makeFlow(keyedIngress({ max_passes: 2 })));
    await listener.handleWebhook(prEvent({ repo: 'acme/widgets', pr: 7 }));
    await finishPass(0, 1);
    await listener.handleWebhook(prEvent({ repo: 'acme/widgets', pr: 7 }));
    await finishPass(1, 2);

    const first = prEvent({ repo: 'acme/widgets', pr: 7 });
    const res = await listener.handleWebhook(first);
    await listener.handleWebhook(prEvent({ repo: 'acme/widgets', pr: 7 }));
    await settle();

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body!).outcome).toBe('pass_limit');
    expect(launches).toHaveLength(2);
    expect(db.getIngressLog({ outcome: 'pass_limit' })).toHaveLength(2);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.channel).toBe('#pr-loop');
    expect(alerts[0]!.reason).toContain('max_passes');
    expect(db.getIngressEvent(first.headers['x-delivery']!)!.spawn_state).toBe('refused');
  });

  it('refuses a run the andon halted mid-pass, alerting once per run', async () => {
    const listener = await boot(makeFlow(keyedIngress()));
    await listener.handleWebhook(prEvent({ repo: 'acme/widgets', pr: 7 }));
    await finishPass(0, 1);
    db.getStateDb().prepare("UPDATE runs SET status = 'halted', outcome = 'halted' WHERE run_id = $r").run({ $r: RUN });
    db.getStateDb().prepare("UPDATE cards SET lane = 'work', status = 'ready' WHERE run_id = $r").run({ $r: RUN });

    await listener.handleWebhook(prEvent({ repo: 'acme/widgets', pr: 7 }));
    await listener.handleWebhook(prEvent({ repo: 'acme/widgets', pr: 7 }));
    await settle();

    expect(launches).toHaveLength(1);
    expect(db.getIngressLog({ outcome: 'run_not_appendable' })).toHaveLength(2);
    expect(alerts).toHaveLength(1);
  });

  it('folds an event for a parked run into its pending pass without launching', async () => {
    const listener = await boot(makeFlow(keyedIngress()));
    await listener.handleWebhook(prEvent({ repo: 'acme/widgets', pr: 7 }));
    await finishPass(0, 1);
    db.getStateDb().prepare("UPDATE runs SET status = 'halted', outcome = 'parked' WHERE run_id = $r").run({ $r: RUN });

    const req = prEvent({ repo: 'acme/widgets', pr: 7 });
    const res = await listener.handleWebhook(req);

    expect(JSON.parse(res.body!).outcome).toBe('coalesced');
    expect(launches).toHaveLength(1);
    expect(db.getKeyedRun(RUN)!.pending_event_id).toBe(req.headers['x-delivery']!);
  });

  it('turns a lease-conflict exit into a pending pass, not a failure, and launches it once the run is free', async () => {
    const listener = await boot(makeFlow(keyedIngress()));
    await listener.handleWebhook(prEvent({ repo: 'acme/widgets', pr: 7 }));
    await finishPass(0, 1);
    const req = prEvent({ repo: 'acme/widgets', pr: 7, round: 2 });
    await listener.handleWebhook(req);
    expect(launches).toHaveLength(2);

    // Another live driver took the run between the check and the launch; while
    // it holds the lease, the drain after the exit waits.
    db.getStateDb().prepare('UPDATE runs SET holder_pid = $p WHERE run_id = $r').run({ $p: process.pid, $r: RUN });
    launches[1]!.exit(EXIT_RUN_LEASE_CONFLICT);
    await settle();

    const eventId = req.headers['x-delivery']!;
    expect(db.getIngressEvent(eventId)!.spawn_state).toBe('coalesced');
    expect(db.getKeyedRun(RUN)!.pending_event_id).toBe(eventId);
    expect(db.getIngressLog({ outcome: 'spawn_failed' })).toHaveLength(0);
    expect(alerts).toHaveLength(0);
    expect(launches).toHaveLength(2);

    // The other driver finishes; the next drain launches the pending pass.
    db.getStateDb().prepare('UPDATE runs SET holder_pid = NULL WHERE run_id = $r').run({ $r: RUN });
    await boot(makeFlow(keyedIngress())); // a fresh listener drains at boot
    expect(launches).toHaveLength(3);
    expect(launches[2]!.appendPass).toBe(true);
    expect(stampedInput(2)).toMatchObject({ pass: 2, body: { round: 2 } });
  });

  it('reports a non-zero exit that left no appendable run as a failed launch', async () => {
    const listener = await boot(makeFlow(keyedIngress()));
    const req = prEvent({ repo: 'acme/widgets', pr: 7 });
    await listener.handleWebhook(req);
    db.insertRun({ run_id: RUN, flow: FLOW_PATH, input_fingerprint: 'fp', status: 'halted', outcome: 'halted' });
    launches[0]!.exit(1);
    await settle();
    expect(db.getIngressEvent(req.headers['x-delivery']!)!.spawn_state).toBe('failed');
    expect(db.getIngressLog({ outcome: 'spawn_failed' })).toHaveLength(1);
    expect(alerts).toHaveLength(1);
  });
});

describe('a pass that concluded unsuccessfully', () => {
  it('stays spawned, is logged pass_failed and alerted, and the pending event still becomes the next pass', async () => {
    const listener = await boot(makeFlow(keyedIngress()));
    const first = prEvent({ repo: 'acme/widgets', pr: 7, round: 1 });
    await listener.handleWebhook(first);
    await listener.handleWebhook(prEvent({ repo: 'acme/widgets', pr: 7, round: 2 }));

    // The child ran the pass and its entry card scrapped: the kernel records
    // the run halted and exits 1.
    db.insertRun({ run_id: RUN, flow: FLOW_PATH, input_fingerprint: 'fp', status: 'halted', outcome: 'halted' });
    db.insertCard({
      run_id: RUN, id: `entry-${RUN}`, parent_id: null, lane: 'scrap', status: 'scrapped',
      attempt: 1, wave: 0, owned_paths: [], rework_count: 0,
    });
    launches[0]!.exit(1);
    await settle();

    expect(db.getIngressEvent(first.headers['x-delivery']!)!.spawn_state).toBe('spawned');
    expect(db.getIngressLog({ outcome: 'pass_failed' })).toHaveLength(1);
    expect(db.getIngressLog({ outcome: 'spawn_failed' })).toHaveLength(0);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.reason).toContain('pass_failed');
    expect(launches).toHaveLength(2);
    expect(launches[1]!.appendPass).toBe(true);
    expect(stampedInput(1)).toMatchObject({ pass: 2, body: { round: 2 } });
  });

  it('takes the next event as a pass after a scrapped pass, rather than refusing the subject', async () => {
    const listener = await boot(makeFlow(keyedIngress()));
    await listener.handleWebhook(prEvent({ repo: 'acme/widgets', pr: 7 }));
    db.insertRun({ run_id: RUN, flow: FLOW_PATH, input_fingerprint: 'fp', status: 'halted', outcome: 'halted' });
    db.insertCard({
      run_id: RUN, id: `entry-${RUN}`, parent_id: null, lane: 'scrap', status: 'scrapped',
      attempt: 1, wave: 0, owned_paths: [], rework_count: 0,
    });
    launches[0]!.exit(1);
    await settle();

    const res = await listener.handleWebhook(prEvent({ repo: 'acme/widgets', pr: 7, round: 2 }));
    expect(JSON.parse(res.body!).outcome).toBe('accepted');
    expect(launches[1]!.appendPass).toBe(true);
    expect(db.getIngressLog({ outcome: 'run_not_appendable' })).toHaveLength(0);
  });
});

describe('a run holding a card for a human', () => {
  it('folds events into its pending pass, alerts once, and launches one pass from the latest after the resume', async () => {
    let tick: () => void = () => {};
    const listener = await boot(makeFlow(keyedIngress()), {
      redriveSchedule: (fn) => {
        tick = fn;
        return { cancel() {} };
      },
    });
    listener.redrive.start();
    await listener.handleWebhook(prEvent({ repo: 'acme/widgets', pr: 7 }));
    await finishPass(0, 1);
    // A later station held the card for a HITL pick: the run exited halted.
    db.getStateDb().prepare("UPDATE runs SET status = 'halted', outcome = 'halted' WHERE run_id = $r").run({ $r: RUN });
    db.getStateDb().prepare("UPDATE cards SET lane = 'hold', status = 'held' WHERE run_id = $r").run({ $r: RUN });

    const a = await listener.handleWebhook(prEvent({ repo: 'acme/widgets', pr: 7, round: 'a' }));
    const b = await listener.handleWebhook(prEvent({ repo: 'acme/widgets', pr: 7, round: 'b' }));
    await settle();

    expect(JSON.parse(a.body!).outcome).toBe('coalesced');
    expect(JSON.parse(b.body!).outcome).toBe('coalesced');
    expect(launches).toHaveLength(1);
    expect(db.getIngressLog({ outcome: 'run_not_appendable' })).toHaveLength(0);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.reason).toContain('held');

    // A sweep while still held launches nothing.
    tick();
    await settle();
    expect(launches).toHaveLength(1);

    // The human replied and the resume drove the run to done.
    db.getStateDb().prepare("UPDATE cards SET lane = 'done', status = 'complete' WHERE run_id = $r").run({ $r: RUN });
    db.getStateDb().prepare("UPDATE runs SET status = 'done', outcome = 'complete' WHERE run_id = $r").run({ $r: RUN });
    tick();
    await settle();

    expect(launches).toHaveLength(2);
    expect(launches[1]!.appendPass).toBe(true);
    expect(stampedInput(1)).toMatchObject({ pass: 2, body: { round: 'b' } });
    tick();
    await settle();
    expect(launches).toHaveLength(2);
    listener.redrive.stop();
  });

  it('refuses a new event as run_not_appendable, rather than coalescing forever, when the driver died while a card was held', async () => {
    const listener = await boot(makeFlow(keyedIngress()));
    await listener.handleWebhook(prEvent({ repo: 'acme/widgets', pr: 7 }));
    await finishPass(0, 1);
    // A later station held the card for a HITL pick, but the driver crashed
    // before it recorded the run as halted: the row is stuck at 'running'
    // with no live lease holder, so no resume is in flight to fold this
    // event into.
    db.getStateDb()
      .prepare("UPDATE runs SET status = 'running', outcome = NULL, holder_pid = 999999999 WHERE run_id = $r")
      .run({ $r: RUN });
    db.getStateDb().prepare("UPDATE cards SET lane = 'hold', status = 'held' WHERE run_id = $r").run({ $r: RUN });

    const res = await listener.handleWebhook(prEvent({ repo: 'acme/widgets', pr: 7, round: 'a' }));
    await settle();

    expect(JSON.parse(res.body!).outcome).toBe('run_not_appendable');
    expect(launches).toHaveLength(1);
    expect(db.getIngressLog({ outcome: 'run_not_appendable' })).toHaveLength(1);
  });
});

describe('a pass whose exit the listener lost', () => {
  it('is never launched again: the re-drive finds the pass the kernel recorded', async () => {
    let tick: () => void = () => {};
    const listener = await boot(makeFlow(keyedIngress()), {
      redriveSchedule: (fn) => {
        tick = fn;
        return { cancel() {} };
      },
    });
    listener.redrive.start();
    await listener.handleWebhook(prEvent({ repo: 'acme/widgets', pr: 7 }));
    await finishPass(0, 1);
    const req = prEvent({ repo: 'acme/widgets', pr: 7, round: 2 });
    await listener.handleWebhook(req);
    expect(launches).toHaveLength(2);

    // The kernel seeded pass 2 and its process still holds the run lease when
    // the listener loses the child's exit. Before run_pass_events, the
    // re-drive folded the event into the pending pass while the lease was
    // held, and the drain after the run finished ran it again as pass 3.
    seedPassEvents(1, 2);
    db.insertCard({
      run_id: RUN, id: `entry-${RUN}-p2`, parent_id: null, lane: 'work', status: 'working',
      attempt: 0, wave: 0, owned_paths: [], rework_count: 0,
    });
    db.getStateDb()
      .prepare("UPDATE runs SET status = 'running', outcome = NULL, holder_pid = $p WHERE run_id = $r")
      .run({ $p: process.pid, $r: RUN });
    launches[1]!.lose('lost the child handle');
    await settle();
    tick();
    await settle();

    const eventId = req.headers['x-delivery']!;
    expect(db.getIngressEvent(eventId)!.spawn_state).toBe('spawned');
    expect(db.getKeyedRun(RUN)!.pending_event_id).toBeNull();
    const [entry] = db.getIngressLog({ outcome: 'already_applied' });
    expect(entry!.reason).toContain('pass 2');

    // The pass finishes and the lease is released; later sweeps launch nothing.
    db.getStateDb().prepare("UPDATE cards SET lane = 'done', status = 'complete' WHERE run_id = $r").run({ $r: RUN });
    db.getStateDb()
      .prepare("UPDATE runs SET status = 'done', outcome = 'complete', holder_pid = NULL WHERE run_id = $r")
      .run({ $r: RUN });
    tick();
    await settle();
    expect(launches).toHaveLength(2);
    listener.redrive.stop();
  });
});

describe('restart and re-drive', () => {
  function seedFinishedRun(): void {
    db.insertRun({ run_id: RUN, flow: FLOW_PATH, input_fingerprint: 'fp', status: 'done', outcome: 'complete' });
    db.insertCard({
      run_id: RUN, id: `entry-${RUN}`, parent_id: null, lane: 'done', status: 'complete',
      attempt: 0, wave: 0, owned_paths: [], rework_count: 0,
    });
    db.upsertKeyedRun({ runId: RUN, flowId: FLOW_ID, flowPath: FLOW_PATH, runKey: ['acme/widgets', '7'], maxPasses: undefined });
  }

  function acceptRow(eventId: string, receivedAt: number, body: Record<string, unknown>): void {
    db.acceptIngressEvent(eventId, receivedAt, {
      flowId: FLOW_ID,
      flowPath: FLOW_PATH,
      runId: RUN,
      substrateJson: JSON.stringify({ event_id: eventId, body }),
    });
  }

  it('covers an older pending event in a launch from a newer one, so it never becomes a pass of its own', async () => {
    seedFinishedRun();
    acceptRow('ev-a', NOW - 20, { round: 'a' });
    db.markIngressCoalesced('ev-a');
    db.setKeyedRunPending(RUN, 'ev-a');
    acceptRow('ev-b', NOW - 10, { round: 'b' });
    const deps: KeyedRunDeps = {
      db,
      spawn: controlledSpawn,
      alerts: { alert: async (a) => void alerts.push(a), channels: {}, globalAlertChannel: '#ops' },
      slots: createRunSlots(),
      redriveCap: 3,
      now: () => NOW,
      launching: new Set<string>(),
    };

    const routed = await routeKeyedEvent(
      deps,
      {
        eventId: 'ev-b',
        runId: RUN,
        flowId: FLOW_ID,
        flowPath: FLOW_PATH,
        substrateJson: db.getIngressEvent('ev-b')!.substrate_json!,
        source: 'test',
      },
      'sweep',
    );

    expect(routed).toEqual({ outcome: 'accepted', runId: RUN, pass: 2 });
    expect(launches[0]!.passEvents).toEqual(['ev-a', 'ev-b']);
    expect((stampedInput(0).events as Array<{ event_id: string }>).map((e) => e.event_id)).toEqual(['ev-a', 'ev-b']);
    expect(db.getKeyedRun(RUN)!.pending_event_id).toBeNull();
    await finishPass(0, 2);
    expect(launches).toHaveLength(1);
  });

  it('launches a pending pass recorded before a listener restart', async () => {
    seedFinishedRun();
    acceptRow('ev-pending', NOW - 10, { round: 2 });
    db.markIngressCoalesced('ev-pending');
    db.setKeyedRunPending(RUN, 'ev-pending');

    await boot(makeFlow(keyedIngress()));

    expect(launches).toHaveLength(1);
    expect(launches[0]!.appendPass).toBe(true);
    expect(stampedInput(0)).toMatchObject({ event_id: 'ev-pending', pass: 2, run_key: ['acme/widgets', '7'] });
    expect(db.getKeyedRun(RUN)!.pending_event_id).toBeNull();
    expect(db.getIngressEvent('ev-pending')!.spawn_state).toBe('spawned');
  });

  it('keeps the pending pass while the run is still being driven after a restart', async () => {
    seedFinishedRun();
    db.getStateDb().prepare("UPDATE runs SET status = 'running', holder_pid = $p WHERE run_id = $r").run({ $p: process.pid, $r: RUN });
    acceptRow('ev-pending', NOW - 10, { round: 2 });
    db.markIngressCoalesced('ev-pending');
    db.setKeyedRunPending(RUN, 'ev-pending');

    await boot(makeFlow(keyedIngress()));

    expect(launches).toHaveLength(0);
    expect(db.getKeyedRun(RUN)!.pending_event_id).toBe('ev-pending');
  });

  it('re-drives a queued keyed event on an existing run as an append-pass, folding later ones into it', async () => {
    seedFinishedRun();
    acceptRow('ev-a', NOW - 20, { round: 'a' });
    acceptRow('ev-b', NOW - 10, { round: 'b' });

    await boot(makeFlow(keyedIngress()));

    expect(launches).toHaveLength(1);
    expect(launches[0]!.appendPass).toBe(true);
    expect(stampedInput(0)).toMatchObject({ pass: 2, body: { round: 'a' } });
    expect(db.getIngressEvent('ev-b')!.spawn_state).toBe('coalesced');
    expect(db.getKeyedRun(RUN)!.pending_event_id).toBe('ev-b');

    await finishPass(0, 2);
    expect(launches).toHaveLength(2);
    expect(stampedInput(1)).toMatchObject({ pass: 3, body: { round: 'b' } });
  });

  it('re-drives a queued first event as pass 1 when the run does not exist yet', async () => {
    db.upsertKeyedRun({ runId: RUN, flowId: FLOW_ID, flowPath: FLOW_PATH, runKey: ['acme/widgets', '7'], maxPasses: undefined });
    acceptRow('ev-first', NOW - 10, { round: 1 });

    await boot(makeFlow(keyedIngress()));

    expect(launches).toHaveLength(1);
    expect(launches[0]!.appendPass).toBeUndefined();
    expect(stampedInput(0)).toMatchObject({ pass: 1 });
  });

  it('folds a second event for a run whose first event is still queued, instead of queueing both', async () => {
    const listener = await boot(
      makeFlow(keyedIngress()),
      { redriveSchedule: () => ({ cancel() {} }) },
      { maxConcurrentRuns: 1 },
    );
    listener.redrive.start();
    await listener.handleWebhook(prEvent({ repo: 'acme/widgets', pr: 8 }));
    await listener.handleWebhook(prEvent({ repo: 'acme/widgets', pr: 7, round: 'a' }));
    const second = await listener.handleWebhook(prEvent({ repo: 'acme/widgets', pr: 7, round: 'b' }));
    expect(JSON.parse(second.body!).outcome).toBe('coalesced');

    await finishPass(0, 1); // frees the slot: the queued pass 1 of RUN launches
    expect(launches).toHaveLength(2);
    expect(stampedInput(1)).toMatchObject({ pass: 1, body: { round: 'a' } });

    await finishPass(1, 1); // pass 1 of RUN done: the folded event is pass 2
    expect(launches).toHaveLength(3);
    expect(stampedInput(2)).toMatchObject({ pass: 2, body: { round: 'b' } });
    listener.redrive.stop();
  });

  it('keeps the latest event pending when an older one is folded after it', async () => {
    seedFinishedRun();
    db.getStateDb().prepare("UPDATE runs SET status = 'running', holder_pid = $p WHERE run_id = $r").run({ $p: process.pid, $r: RUN });
    acceptRow('ev-new', NOW - 5, { round: 'new' });
    db.markIngressCoalesced('ev-new');
    db.setKeyedRunPending(RUN, 'ev-new');
    acceptRow('ev-old', NOW - 20, { round: 'old' }); // queued, older, re-driven at boot

    await boot(makeFlow(keyedIngress()));

    expect(launches).toHaveLength(0);
    expect(db.getIngressEvent('ev-old')!.spawn_state).toBe('coalesced');
    expect(db.getKeyedRun(RUN)!.pending_event_id).toBe('ev-new');
  });

  it('launches a keyed event queued behind a busy slot when the slot frees', async () => {
    const listener = await boot(
      makeFlow(keyedIngress()),
      { redriveSchedule: () => ({ cancel() {} }) },
      { maxConcurrentRuns: 1 },
    );
    listener.redrive.start();
    await listener.handleWebhook(prEvent({ repo: 'acme/widgets', pr: 8 }));
    const queued = await listener.handleWebhook(prEvent({ repo: 'acme/widgets', pr: 7 }));
    expect(JSON.parse(queued.body!).outcome).toBe('queued');
    expect(launches).toHaveLength(1);

    await finishPass(0, 1);

    expect(launches).toHaveLength(2);
    expect(launches[1]!.runId).toBe(RUN);
    expect(launches[1]!.appendPass).toBeUndefined();
    listener.redrive.stop();
  });
});

describe('drainKeyedRun on a pending event the router cannot simply launch', () => {
  function seedFinishedRun(): void {
    db.insertRun({ run_id: RUN, flow: FLOW_PATH, input_fingerprint: 'fp', status: 'done', outcome: 'complete' });
    db.insertCard({
      run_id: RUN, id: `entry-${RUN}`, parent_id: null, lane: 'done', status: 'complete',
      attempt: 0, wave: 0, owned_paths: [], rework_count: 0,
    });
    db.upsertKeyedRun({ runId: RUN, flowId: FLOW_ID, flowPath: FLOW_PATH, runKey: ['acme/widgets', '7'], maxPasses: undefined });
  }

  function drainDeps(): KeyedRunDeps {
    return {
      db,
      spawn: controlledSpawn,
      alerts: { alert: async (a) => void alerts.push(a), channels: {}, globalAlertChannel: '#ops' },
      slots: createRunSlots(),
      redriveCap: 3,
      now: () => NOW,
      launching: new Set<string>(),
    };
  }

  it('logs rejected_malformed (not silence) for a pending event whose row is entirely missing', async () => {
    seedFinishedRun();
    db.setKeyedRunPending(RUN, 'ghost-event');

    const outcome = await drainKeyedRun(drainDeps(), RUN);

    expect(outcome).toBeNull();
    expect(db.getKeyedRun(RUN)!.pending_event_id).toBeNull();
    const entries = db.getIngressLog({ outcome: 'rejected_malformed' });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.eventId).toBe('ghost-event');
    expect(entries[0]!.reason).toContain('ghost-event');
    expect(entries[0]!.reason).toContain(RUN);
  });

  it('logs rejected_malformed naming the missing column for a pending row with no flow_path', async () => {
    seedFinishedRun();
    db.acceptIngressEvent('ev-incomplete', NOW - 10, {
      flowId: FLOW_ID,
      flowPath: FLOW_PATH,
      runId: RUN,
      substrateJson: JSON.stringify({ round: 1 }),
    });
    db.markIngressCoalesced('ev-incomplete');
    db.setKeyedRunPending(RUN, 'ev-incomplete');
    // A hand-edited or corrupt row: attribution partially missing.
    db.getStateDb().prepare("UPDATE ingress_events SET flow_path = NULL WHERE event_id = 'ev-incomplete'").run();

    const outcome = await drainKeyedRun(drainDeps(), RUN);

    expect(outcome).toBeNull();
    expect(db.getKeyedRun(RUN)!.pending_event_id).toBeNull();
    const entries = db.getIngressLog({ outcome: 'rejected_malformed' });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.eventId).toBe('ev-incomplete');
    expect(entries[0]!.reason).toContain('flow_path');
    expect(entries[0]!.reason).toContain(RUN);
  });

  it('marks a malformed pending row (missing flow_path) refused so a later pass never folds it back in', async () => {
    seedFinishedRun();
    db.acceptIngressEvent('ev-incomplete', NOW - 10, {
      flowId: FLOW_ID,
      flowPath: FLOW_PATH,
      runId: RUN,
      substrateJson: JSON.stringify({ round: 1 }),
    });
    db.markIngressCoalesced('ev-incomplete');
    db.setKeyedRunPending(RUN, 'ev-incomplete');
    db.getStateDb().prepare("UPDATE ingress_events SET flow_path = NULL WHERE event_id = 'ev-incomplete'").run();

    const drained = await drainKeyedRun(drainDeps(), RUN);
    expect(drained).toBeNull();
    expect(db.getIngressEvent('ev-incomplete')!.spawn_state).toBe('refused');

    // A later event arrives and launches the next pass. Left 'coalesced', the
    // stale row (valid substrate_json) would be folded back into this pass by
    // coveredEvents, consuming an event the log already recorded as dropped.
    db.acceptIngressEvent('ev-next', NOW, {
      flowId: FLOW_ID,
      flowPath: FLOW_PATH,
      runId: RUN,
      substrateJson: JSON.stringify({ round: 2 }),
    });
    const routed = await routeKeyedEvent(
      drainDeps(),
      {
        eventId: 'ev-next',
        runId: RUN,
        flowId: FLOW_ID,
        flowPath: FLOW_PATH,
        substrateJson: db.getIngressEvent('ev-next')!.substrate_json!,
        source: 'test',
      },
      'sweep',
    );

    expect(routed).toEqual({ outcome: 'accepted', runId: RUN, pass: 2 });
    expect(launches[0]!.passEvents).toEqual(['ev-next']);
  });

  it('marks a malformed pending row (missing substrate_json) refused, logging rejected_malformed only once', async () => {
    seedFinishedRun();
    db.acceptIngressEvent('ev-corrupt', NOW - 10, {
      flowId: FLOW_ID,
      flowPath: FLOW_PATH,
      runId: RUN,
      substrateJson: JSON.stringify({ round: 1 }),
    });
    db.markIngressCoalesced('ev-corrupt');
    db.setKeyedRunPending(RUN, 'ev-corrupt');
    db.getStateDb().prepare("UPDATE ingress_events SET substrate_json = NULL WHERE event_id = 'ev-corrupt'").run();

    const drained = await drainKeyedRun(drainDeps(), RUN);
    expect(drained).toBeNull();
    expect(db.getIngressEvent('ev-corrupt')!.spawn_state).toBe('refused');
    expect(db.getIngressLog({ outcome: 'rejected_malformed' })).toHaveLength(1);

    // Left 'coalesced', coveredEvents' own malformed-fold guard would log
    // rejected_malformed a second time for the same event on this later pass.
    db.acceptIngressEvent('ev-next', NOW, {
      flowId: FLOW_ID,
      flowPath: FLOW_PATH,
      runId: RUN,
      substrateJson: JSON.stringify({ round: 2 }),
    });
    const routed = await routeKeyedEvent(
      drainDeps(),
      {
        eventId: 'ev-next',
        runId: RUN,
        flowId: FLOW_ID,
        flowPath: FLOW_PATH,
        substrateJson: db.getIngressEvent('ev-next')!.substrate_json!,
        source: 'test',
      },
      'sweep',
    );

    expect(routed).toEqual({ outcome: 'accepted', runId: RUN, pass: 2 });
    expect(db.getIngressLog({ outcome: 'rejected_malformed' })).toHaveLength(1);
  });

  it('keeps the pending pointer set when appendIngressLog throws for a malformed pending row (issue: log-before-clear ordering)', async () => {
    seedFinishedRun();
    db.setKeyedRunPending(RUN, 'ghost-event');

    let calls = 0;
    const throwingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'appendIngressLog') {
          return (entry: Parameters<ConduitDB['appendIngressLog']>[0]) => {
            calls += 1;
            if (calls === 1) throw new Error('boom: log sink unavailable');
            return target.appendIngressLog(entry);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as ConduitDB;

    await expect(drainKeyedRun({ ...drainDeps(), db: throwingDb }, RUN)).rejects.toThrow('boom: log sink unavailable');

    // The durable log write is attempted before the pending pointer is
    // cleared, so a throw from it must leave the pointer intact rather than
    // dropping the event with no record.
    expect(db.getKeyedRun(RUN)!.pending_event_id).toBe('ghost-event');
    expect(db.getIngressLog({ outcome: 'rejected_malformed' })).toHaveLength(0);

    // A retry (the log sink is back) now succeeds and clears the pointer.
    const outcome = await drainKeyedRun(drainDeps(), RUN);
    expect(outcome).toBeNull();
    expect(db.getKeyedRun(RUN)!.pending_event_id).toBeNull();
    expect(db.getIngressLog({ outcome: 'rejected_malformed' })).toHaveLength(1);
  });

  it('settles a pending event a pass already consumed as already_applied instead of dropping it silently', async () => {
    seedFinishedRun();
    db.acceptIngressEvent('ev-applied', NOW - 10, {
      flowId: FLOW_ID,
      flowPath: FLOW_PATH,
      runId: RUN,
      substrateJson: JSON.stringify({ round: 1 }),
    });
    db.markIngressCoalesced('ev-applied');
    db.setKeyedRunPending(RUN, 'ev-applied');
    db.recordPassEvents(RUN, 2, ['ev-applied']);

    const outcome = await drainKeyedRun(drainDeps(), RUN);

    expect(outcome).toEqual({ outcome: 'already_applied', runId: RUN, pass: 2 });
    expect(db.getKeyedRun(RUN)!.pending_event_id).toBeNull();
    expect(db.getIngressEvent('ev-applied')!.spawn_state).toBe('spawned');
    const entries = db.getIngressLog({ outcome: 'already_applied' });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.reason).toContain('pass 2');
  });

  it('keeps the pending pointer set when settleApplied throws logging an already-consumed pending event', async () => {
    seedFinishedRun();
    db.acceptIngressEvent('ev-applied', NOW - 10, {
      flowId: FLOW_ID,
      flowPath: FLOW_PATH,
      runId: RUN,
      substrateJson: JSON.stringify({ round: 1 }),
    });
    db.markIngressCoalesced('ev-applied');
    db.setKeyedRunPending(RUN, 'ev-applied');
    db.recordPassEvents(RUN, 2, ['ev-applied']);

    let calls = 0;
    const throwingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'appendIngressLog') {
          return (entry: Parameters<ConduitDB['appendIngressLog']>[0]) => {
            calls += 1;
            if (calls === 1) throw new Error('boom: log sink unavailable');
            return target.appendIngressLog(entry);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as ConduitDB;

    await expect(drainKeyedRun({ ...drainDeps(), db: throwingDb }, RUN)).rejects.toThrow('boom: log sink unavailable');

    // markIngressSpawned may already have run, but the pending pointer must
    // still be set: settleApplied's log write happens before it is cleared.
    expect(db.getKeyedRun(RUN)!.pending_event_id).toBe('ev-applied');
    expect(db.getIngressLog({ outcome: 'already_applied' })).toHaveLength(0);
  });

  it('keeps the pending pointer set when appendIngressLog throws refusing a pending event at max_passes', async () => {
    db.insertRun({ run_id: RUN, flow: FLOW_PATH, input_fingerprint: 'fp', status: 'done', outcome: 'complete' });
    db.insertCard({
      run_id: RUN, id: `entry-${RUN}`, parent_id: null, lane: 'done', status: 'complete',
      attempt: 0, wave: 0, owned_paths: [], rework_count: 0,
    });
    db.upsertKeyedRun({ runId: RUN, flowId: FLOW_ID, flowPath: FLOW_PATH, runKey: ['acme/widgets', '7'], maxPasses: 1 });
    db.acceptIngressEvent('ev-pending', NOW - 10, {
      flowId: FLOW_ID,
      flowPath: FLOW_PATH,
      runId: RUN,
      substrateJson: JSON.stringify({ round: 1 }),
    });
    db.markIngressCoalesced('ev-pending');
    db.setKeyedRunPending(RUN, 'ev-pending');

    let calls = 0;
    const throwingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'appendIngressLog') {
          return (entry: Parameters<ConduitDB['appendIngressLog']>[0]) => {
            calls += 1;
            if (calls === 1) throw new Error('boom: log sink unavailable');
            return target.appendIngressLog(entry);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as ConduitDB;

    await expect(drainKeyedRun({ ...drainDeps(), db: throwingDb }, RUN)).rejects.toThrow('boom: log sink unavailable');

    // refuse() writes the durable record before the pending pointer is
    // cleared, so a throw from it must leave the pointer intact rather than
    // dropping the event with no pending pointer, no refused mark and no log.
    expect(db.getKeyedRun(RUN)!.pending_event_id).toBe('ev-pending');
    expect(db.getIngressLog({ outcome: 'pass_limit' })).toHaveLength(0);
  });
});

describe('a failed launch leaves the pending pointer for the next sweep, not orphaned', () => {
  function seedFinishedRun(): void {
    db.insertRun({ run_id: RUN, flow: FLOW_PATH, input_fingerprint: 'fp', status: 'done', outcome: 'complete' });
    db.insertCard({
      run_id: RUN, id: `entry-${RUN}`, parent_id: null, lane: 'done', status: 'complete',
      attempt: 0, wave: 0, owned_paths: [], rework_count: 0,
    });
    db.upsertKeyedRun({ runId: RUN, flowId: FLOW_ID, flowPath: FLOW_PATH, runKey: ['acme/widgets', '7'], maxPasses: undefined });
  }

  function acceptRow(eventId: string, receivedAt: number, body: Record<string, unknown>): void {
    db.acceptIngressEvent(eventId, receivedAt, {
      flowId: FLOW_ID,
      flowPath: FLOW_PATH,
      runId: RUN,
      substrateJson: JSON.stringify({ event_id: eventId, body }),
    });
  }

  function makeDrainDeps(spawn: SpawnSeam): KeyedRunDeps {
    return {
      db,
      spawn,
      alerts: { alert: async (a) => void alerts.push(a), channels: {}, globalAlertChannel: '#ops' },
      slots: createRunSlots(),
      redriveCap: 3,
      now: () => NOW,
      launching: new Set<string>(),
    };
  }

  /** Refuses the very first launch (the spawn seam itself never starts the child), then launches normally. */
  function failOnceThenSpawn(): SpawnSeam {
    let calls = 0;
    return async (invocation) => {
      calls += 1;
      if (calls === 1) return { ok: false, error: 'boom: spawn refused' };
      return controlledSpawn(invocation);
    };
  }

  it('keeps the pending pointer set when the launch spawn fails, so the folded event stays drainable', async () => {
    seedFinishedRun();
    acceptRow('ev-a', NOW - 20, { round: 'a' });
    db.markIngressCoalesced('ev-a');
    db.setKeyedRunPending(RUN, 'ev-a');
    acceptRow('ev-b', NOW - 10, { round: 'b' });

    const deps = makeDrainDeps(failOnceThenSpawn());

    const routed = await routeKeyedEvent(
      deps,
      {
        eventId: 'ev-b',
        runId: RUN,
        flowId: FLOW_ID,
        flowPath: FLOW_PATH,
        substrateJson: db.getIngressEvent('ev-b')!.substrate_json!,
        source: 'test',
      },
      'sweep',
    );

    expect(routed).toEqual({ outcome: 'spawn_failed', runId: RUN });
    // The launch never happened: the pending pointer must still name 'ev-a',
    // never cleared, or the folded event becomes reachable from nothing
    // (drainKeyedRuns only visits runs with a non-null pending_event_id, and
    // the failed-row sweep only re-drives the launching event itself).
    expect(db.getKeyedRun(RUN)!.pending_event_id).toBe('ev-a');
    expect(db.getIngressEvent('ev-a')!.spawn_state).toBe('coalesced');
    expect(db.getIngressEvent('ev-b')!.spawn_state).toBe('failed');
    expect(launches).toHaveLength(0);

    // The ordinary redrive-failed-rows sweep re-routes 'ev-b' (still under
    // its attempt cap); this launch succeeds and picks the still-pending
    // 'ev-a' back up as part of the same pass, exactly as if the first
    // attempt had never happened.
    const redriven = await routeKeyedEvent(
      deps,
      {
        eventId: 'ev-b',
        runId: RUN,
        flowId: FLOW_ID,
        flowPath: FLOW_PATH,
        substrateJson: db.getIngressEvent('ev-b')!.substrate_json!,
        source: 'test',
      },
      'sweep',
    );
    expect(redriven).toEqual({ outcome: 'accepted', runId: RUN, pass: 2 });
    expect(launches).toHaveLength(1);
    expect(launches[0]!.passEvents).toEqual(['ev-a', 'ev-b']);
    expect(db.getKeyedRun(RUN)!.pending_event_id).toBeNull();

    launches[0]!.exit(0);
    await settle();
  });

  it('does not clear the pending pointer when the spawn call throws outright', async () => {
    seedFinishedRun();
    acceptRow('ev-a', NOW - 10, { round: 'a' });
    db.markIngressCoalesced('ev-a');
    db.setKeyedRunPending(RUN, 'ev-a');

    const throwingSpawn: SpawnSeam = async () => {
      throw new Error('boom: spawn threw');
    };
    const deps = makeDrainDeps(throwingSpawn);

    const drained = await drainKeyedRun(deps, RUN);

    expect(drained).toEqual({ outcome: 'spawn_failed', runId: RUN });
    expect(db.getKeyedRun(RUN)!.pending_event_id).toBe('ev-a');
    expect(db.getIngressEvent('ev-a')!.spawn_state).toBe('failed');
  });

  it('serializes a redrive of the failed launching event against a drain of the pending event: only one pass launches, and no event is covered twice', async () => {
    seedFinishedRun();
    acceptRow('ev-a', NOW - 20, { round: 'a' });
    db.markIngressCoalesced('ev-a');
    db.setKeyedRunPending(RUN, 'ev-a');
    acceptRow('ev-b', NOW - 10, { round: 'b' });
    // Left behind by an earlier failed launch attempt (the fix under test):
    // re-drivable on its own, while the run's pending pointer still names 'ev-a'.
    db.markIngressFailed('ev-b');

    const deps = makeDrainDeps(controlledSpawn);

    const [sweepOutcome, drainOutcome] = await Promise.all([
      routeKeyedEvent(
        deps,
        {
          eventId: 'ev-b',
          runId: RUN,
          flowId: FLOW_ID,
          flowPath: FLOW_PATH,
          substrateJson: db.getIngressEvent('ev-b')!.substrate_json!,
          source: 'test',
        },
        'sweep',
      ),
      drainKeyedRun(deps, RUN),
    ]);

    // The run's single launch slot serializes the two callers: whichever
    // acquires it launches (covering both events, oldest first); the other
    // sees the run in flight and backs off rather than racing it.
    expect(sweepOutcome).toEqual({ outcome: 'accepted', runId: RUN, pass: 2 });
    expect(drainOutcome).toBeNull();
    expect(launches).toHaveLength(1);
    expect(launches[0]!.passEvents).toEqual(['ev-a', 'ev-b']);
    expect(db.getKeyedRun(RUN)!.pending_event_id).toBeNull();

    // The kernel records the one pass's coverage; both events resolve to the
    // SAME pass, so neither is left to be covered a second time.
    db.recordPassEvents(RUN, 2, launches[0]!.passEvents ?? []);
    expect(db.getPassForEvent('ev-a')).toEqual({ run_id: RUN, pass: 2 });
    expect(db.getPassForEvent('ev-b')).toEqual({ run_id: RUN, pass: 2 });

    // Nothing is left pending, so a later drain finds nothing to launch again.
    const laterDrain = await drainKeyedRun(deps, RUN);
    expect(laterDrain).toBeNull();
    expect(launches).toHaveLength(1);

    launches[0]!.exit(0);
    await settle();
  });
});
