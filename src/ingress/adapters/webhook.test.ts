/**
 * Tests for the webhook ingress adapter (WI-408, FR-4/FR-5/FR-6/NFR-4/NFR-5).
 *
 * The webhook adapter is the internet-facing front of the ingress listener: an
 * authenticated POST to a watched route triggers exactly one `conduit run` with
 * the request body as substrate; unauthenticated, unknown-route, or malformed
 * requests are rejected and logged at the adapter boundary BEFORE any accept
 * record — fail-closed (FR-5), so an attacker can never trigger a billed run.
 *
 * These tests compose the REAL collaborators — the WI-406 accept-spawn path
 * (runSpawnPath), WI-403 buildEnvelope/projectSubstrate, WI-405 deriveEventId,
 * WI-404 ingress_log, and the WI-411 secret-filter — against a real on-disk
 * SQLite db (mirroring spawn.test.ts). Only the two genuine outermost I/O seams
 * are stubbed: the spawn seam (Bun.spawn) and the alert seam. The HTTP server is
 * injected as a plain request object, so no real port is bound.
 *
 * Contract this file pins for src/ingress/adapters/webhook.ts:
 *
 *   export interface WebhookRequest  { route: string; headers: Record<string, string>; rawBody: string }
 *   export interface WebhookResponse { status: number; body?: string }
 *
 *   // A resolved watched route: its flow + binding (WI-402) and the resolved
 *   // shared secret / signing key (the listener resolves binding.auth.secret_env
 *   // from the environment at boot). `secret` flows through the adapter so the
 *   // "never logged" guarantee (AC5) is meaningful.
 *   export interface WebhookRouteResolution {
 *     flowId: string; flowPath: string; flow: FlowConfig; binding: IngressBinding; secret: string;
 *   }
 *
 *   export interface WebhookAdapterDeps {
 *     spawnDeps: SpawnPathDeps;                                       // WI-406 (db, spawn, alert, globalAlertChannel)
 *     resolveRoute(route: string): WebhookRouteResolution | null;     // FR-6
 *     verifyAuth(secret: string, req: WebhookRequest): boolean;       // FR-5 seam (HMAC/constant-time lives behind it)
 *     now(): number;                                                  // deterministic received_at
 *   }
 *
 *   export function handleWebhookRequest(
 *     deps: WebhookAdapterDeps, req: WebhookRequest,
 *   ): Promise<WebhookResponse>
 *
 * Pinned contract decisions (resolving AC ambiguity):
 *   - Success returns a 2xx status; every rejection returns a 4xx client-error
 *     status (the AC says "2xx" / "non-2xx" — the class is the contract, not the
 *     exact code, so we assert the class).
 *   - The original acknowledgement-on-accept work: the response is produced once the event is accepted and its run
 *     is LAUNCHED — never after the run finishes — and names the outcome in a
 *     JSON body. Work this delivery set in motion acks 202; a delivery that
 *     changed nothing (duplicate, failed launch) acks 200.
 *   - Order at the boundary: resolveRoute → verifyAuth → parse/derive → spawn.
 *     Auth is checked BEFORE the accept-spawn path runs (fail-closed): a rejected
 *     request never calls the spawn seam and never produces an 'accepted' log row.
 *   - Signature verification (HMAC-SHA256, constant-time compare per AC5) lives
 *     behind the injected verifyAuth seam; this suite tests the adapter's
 *     orchestration, fail-closed behavior, logging, and secret hygiene — not the
 *     crypto primitive. verifyAuth=false models BOTH a missing and an invalid
 *     signature (the adapter treats them identically → rejected_auth).
 *
 * RED state before WI-408: src/ingress/adapters/webhook.ts does not exist, so the
 * import fails to resolve and every test errors at module load.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConduitDB, type ConduitDB } from '../../persistence/db';
import {
  type SpawnPathDeps,
  type SpawnSeam,
  type SpawnInvocation,
} from '../spawn';
import type { IngressBinding } from '../binding';
import type { FlowConfig } from '../../types/kernel';
import {
  handleWebhookRequest,
  type WebhookAdapterDeps,
  type WebhookRequest,
  type WebhookRouteResolution,
} from './webhook';

const SHARED_SECRET = 'super-secret-signing-key';

let dir: string;
let db: ConduitDB;
let spawnCalls: SpawnInvocation[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conduit-webhook-'));
  db = openConduitDB({
    stateDbPath: join(dir, 'state.sqlite'),
    journalDbPath: join(dir, 'journal.sqlite'),
  });
  spawnCalls = [];
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true });
});

/** Counting spawn seam — records every invocation so "never spawns" is assertable. */
const spawnSeam: SpawnSeam = async (invocation) => {
  spawnCalls.push(invocation);
  return { ok: true };
};

function makeSpawnDeps(): SpawnPathDeps {
  return { db, spawn: spawnSeam, alert: async () => {}, globalAlertChannel: 'slack:ops', redriveCap: 100 };
}

function makeFlow(): FlowConfig {
  return { version: 1, stations: {} };
}

function makeResolution(over: Partial<WebhookRouteResolution> = {}): WebhookRouteResolution {
  return {
    flowId: 'flowA',
    flowPath: '/flows/a.yaml',
    flow: makeFlow(),
    binding: {
      type: 'webhook',
      route: '/hooks/x',
      auth: { type: 'hmac', secret_env: 'GH_WEBHOOK_SECRET' },
      event_id: { from: 'json_path', path: '$.id' },
    },
    secret: SHARED_SECRET,
    ...over,
  };
}

function makeDeps(opts: {
  resolution?: WebhookRouteResolution | null;
  authOk?: boolean;
}): WebhookAdapterDeps {
  const resolution = opts.resolution === undefined ? makeResolution() : opts.resolution;
  return {
    spawnDeps: makeSpawnDeps(),
    resolveRoute: () => resolution,
    verifyAuth: () => opts.authOk ?? true,
    now: () => 1_700_000_000_000,
  };
}

function makeRequest(over: Partial<WebhookRequest> = {}): WebhookRequest {
  return {
    route: '/hooks/x',
    // A sensitive header the secret-filter (WI-411) must drop from the substrate.
    headers: { Authorization: 'Bearer leak-me', 'X-Hub-Signature-256': 'sha256=abc' },
    rawBody: JSON.stringify({ id: 'evt-1', payload: 'hello' }),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// AC1 — authenticated POST → derive id → accept-spawn path → 2xx.
// ---------------------------------------------------------------------------
describe('handleWebhookRequest — authenticated happy path (AC1)', () => {
  it('derives the event_id, invokes the accept-spawn path once, and returns 2xx', async () => {
    const res = await handleWebhookRequest(makeDeps({ authOk: true }), makeRequest());

    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);

    // Exactly one conduit run was triggered, for the resolved flow.
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].flowPath).toBe('/flows/a.yaml');
    // The derived event_id ($.id → 'evt-1') and body reached the spawn payload.
    expect(spawnCalls[0].inputInline).toContain('evt-1');
    expect(spawnCalls[0].inputInline).toContain('hello');

    // The outcome was recorded as accepted in ingress_log.
    expect(db.getIngressLog({ outcome: 'accepted' })).toHaveLength(1);
  });

  // require-mode SUCCESS counterpart to the AC4 fail-case: a require binding that
  // DOES carry an explicit id (Stripe-style body.id) must succeed, not reject.
  it('accepts a require-mode binding when the body carries an explicit id (Stripe-style)', async () => {
    const requireResolution = makeResolution({
      binding: {
        type: 'webhook',
        route: '/hooks/x',
        auth: { type: 'hmac', secret_env: 'GH_WEBHOOK_SECRET' },
        event_id: { from: 'require' },
      },
    });

    const res = await handleWebhookRequest(
      makeDeps({ resolution: requireResolution, authOk: true }),
      makeRequest({ headers: {}, rawBody: JSON.stringify({ id: 'stripe-evt-123', payload: 'hi' }) }),
    );

    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);

    // The require-derived id (body.id) reached the spawn payload and a run fired.
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].inputInline).toContain('stripe-evt-123');
    expect(db.getIngressLog({ outcome: 'accepted' })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// NFR-2 — exactly-once: a re-delivered (identical) POST derives the same
//         event_id and must be deduplicated, not spawned a second time.
// ---------------------------------------------------------------------------
describe('handleWebhookRequest — exactly-once deduplication (NFR-2)', () => {
  it('treats a second identical POST as a duplicate: 2xx, logs duplicate, spawns only once', async () => {
    const deps = makeDeps({ authOk: true });
    const req = makeRequest(); // same route + body → same derived event_id ('evt-1')

    const first = await handleWebhookRequest(deps, req);
    const second = await handleWebhookRequest(deps, req);

    // Both deliveries are answered 2xx — the duplicate is absorbed, not errored.
    expect(first.status).toBeGreaterThanOrEqual(200);
    expect(first.status).toBeLessThan(300);
    expect(second.status).toBeGreaterThanOrEqual(200);
    expect(second.status).toBeLessThan(300);

    // Exactly-once: only the FIRST delivery triggered a conduit run.
    expect(spawnCalls).toHaveLength(1);

    // The ledger records one accept and one duplicate — never two accepts.
    expect(db.getIngressLog({ outcome: 'accepted' })).toHaveLength(1);
    expect(db.getIngressLog({ outcome: 'duplicate' })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The original acknowledgement-on-accept work — ack on accept: answer while the run is still executing.
// ---------------------------------------------------------------------------
describe('handleWebhookRequest — ack on accept (the original acknowledgement-on-accept work)', () => {
  it('answers 202 with the outcome and run id while the launched run is still executing', async () => {
    // A child that never exits — the production shape for a multi-hour render.
    // Before acknowledgement-on-accept this request could not be answered at all until the run ended.
    const neverExits = new Promise<{ code: number }>(() => {});
    const deps = makeDeps({ authOk: true });
    deps.spawnDeps.spawn = async (invocation) => {
      spawnCalls.push(invocation);
      return { ok: true, exited: neverExits };
    };

    const res = await handleWebhookRequest(deps, makeRequest());

    expect(res.status).toBe(202);
    expect(JSON.parse(res.body!)).toEqual({
      outcome: 'accepted',
      run_id: spawnCalls[0].runId,
    });
    expect(db.getIngressEvent('evt-1')).toMatchObject({ spawn_state: 'spawned' });
  });

  it('answers 200 and names the duplicate outcome on a re-delivery, with the run id of the first 202', async () => {
    // Issue #52: the lost-ack case. The first 202 carrying run_id never
    // reached the caller, so the redelivery's answer is the only way to
    // connect the event to its run.
    const deps = makeDeps({ authOk: true });
    const req = makeRequest();

    const first = await handleWebhookRequest(deps, req);
    const second = await handleWebhookRequest(deps, req);

    expect(first.status).toBe(202);
    const firstRunId = (JSON.parse(first.body!) as { run_id: string }).run_id;
    expect(firstRunId).toBe(spawnCalls[0].runId);
    expect(second.status).toBe(200);
    expect(JSON.parse(second.body!)).toEqual({ outcome: 'duplicate', run_id: firstRunId });
  });

  it('omits run_id on a duplicate whose stored row has no run id (a pre-v9 row)', async () => {
    // A row accepted before attribution existed records no run id. Deriving
    // one from this delivery would be a guess, so the answer carries none.
    const deps = makeDeps({ authOk: true });
    db.acceptIngressEvent('evt-1', 500);

    const res = await handleWebhookRequest(deps, makeRequest());

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body!)).toEqual({ outcome: 'duplicate' });
    expect(spawnCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC2 — missing/invalid signature → non-2xx, rejected_auth, fail-closed.
// ---------------------------------------------------------------------------
describe('handleWebhookRequest — auth failure is fail-closed (AC2)', () => {
  it('rejects with non-2xx, logs rejected_auth, and never accepts or spawns', async () => {
    const res = await handleWebhookRequest(makeDeps({ authOk: false }), makeRequest());

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);

    // Fail-closed: the accept-spawn path was never reached.
    expect(spawnCalls).toHaveLength(0);
    expect(db.getIngressLog({ outcome: 'accepted' })).toHaveLength(0);

    // The rejection was logged.
    expect(db.getIngressLog({ outcome: 'rejected_auth' })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// AC3 — route resolves to no known flow → rejected_unknown_flow, no spawn.
// ---------------------------------------------------------------------------
describe('handleWebhookRequest — unknown flow (AC3)', () => {
  it('logs rejected_unknown_flow, returns non-2xx, and never spawns', async () => {
    const res = await handleWebhookRequest(
      makeDeps({ resolution: null, authOk: true }),
      makeRequest({ route: '/no/such/route' }),
    );

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(spawnCalls).toHaveLength(0);
    expect(db.getIngressLog({ outcome: 'rejected_unknown_flow' })).toHaveLength(1);
    expect(db.getIngressLog({ outcome: 'accepted' })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC4 — malformed body / require-mode no id → rejected_malformed, no spawn.
// ---------------------------------------------------------------------------
describe('handleWebhookRequest — malformed requests (AC4)', () => {
  it('rejects an unparseable body (when a json_path id is required) as rejected_malformed', async () => {
    const res = await handleWebhookRequest(
      makeDeps({ authOk: true }), // binding's event_id is from: json_path → needs a parseable body
      makeRequest({ rawBody: '{ not valid json' }),
    );

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(spawnCalls).toHaveLength(0);
    expect(db.getIngressLog({ outcome: 'rejected_malformed' })).toHaveLength(1);
    expect(db.getIngressLog({ outcome: 'accepted' })).toHaveLength(0);
  });

  it('rejects a require-mode binding with no explicit id as rejected_malformed', async () => {
    const requireResolution = makeResolution({
      binding: {
        type: 'webhook',
        route: '/hooks/x',
        auth: { type: 'hmac', secret_env: 'GH_WEBHOOK_SECRET' },
        event_id: { from: 'require' },
      },
    });

    const res = await handleWebhookRequest(
      makeDeps({ resolution: requireResolution, authOk: true }),
      // Parseable body, but carries no well-known/explicit id → deriveEventId fails closed.
      makeRequest({ headers: {}, rawBody: JSON.stringify({ payload: 'no id here' }) }),
    );

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(spawnCalls).toHaveLength(0);
    expect(db.getIngressLog({ outcome: 'rejected_malformed' })).toHaveLength(1);
    expect(db.getIngressLog({ outcome: 'accepted' })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC5 — secret hygiene: the shared secret never reaches ingress_log or substrate.
// ---------------------------------------------------------------------------
describe('handleWebhookRequest — secret hygiene (AC5, NFR-5)', () => {
  it('never writes the shared secret into ingress_log on any path', async () => {
    // Drive both a rejected (auth) path and an accepted path against the same log.
    await handleWebhookRequest(makeDeps({ authOk: false }), makeRequest());
    await handleWebhookRequest(makeDeps({ authOk: true }), makeRequest());

    const serializedLog = JSON.stringify(db.getIngressLog());
    expect(serializedLog).not.toContain(SHARED_SECRET);
  });

  it('filters sensitive request headers out of the spawned substrate (WI-411 wiring)', async () => {
    await handleWebhookRequest(makeDeps({ authOk: true }), makeRequest());

    expect(spawnCalls).toHaveLength(1);
    const payload = spawnCalls[0].inputInline;
    // The Authorization header and its secret value are dropped by filterAttributes.
    expect(payload).not.toContain('Authorization');
    expect(payload).not.toContain('leak-me');
    expect(payload).not.toContain(SHARED_SECRET);
  });
});
