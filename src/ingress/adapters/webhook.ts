/**
 * WI-408 — Webhook ingress adapter with mandatory shared-secret/signature auth.
 *
 * Boundary order (fail-closed, FR-5):
 *   1. resolveRoute — unknown route → 404, log rejected_unknown_flow, no spawn
 *   2. verifyAuth   — bad/missing signature → 401, log rejected_auth, no spawn
 *   3. JSON parse   — unparseable body → 400, log rejected_malformed, no spawn
 *   4. deriveEventId — require-mode with no id → 400, log rejected_malformed, no spawn
 *   4a. when filter: binding's `when` not met → 200, log filtered, no accept (issue #36)
 *   4b. run key: binding's `run_key` unresolved → 400, log rejected_run_key,
 *       no accept (issue #36; same answer as a require-mode rejection)
 *   5. runSpawnPath  — exactly-once accept-spawn path (WI-406)
 *
 * Ack on accept (the original acknowledgement-on-accept work): the response is produced as soon as the event is
 * atomically accepted and its `conduit run` child is LAUNCHED (or queued behind
 * busy run slots) — never after the run finishes. Holding the socket for the
 * whole run meant hours for a render, so every real client timed out and marked
 * accepted work as failed. The body names the outcome so a caller can tell
 * 'accepted' (a run is executing) from 'queued', 'duplicate', and 'spawn_failed'
 * without inferring it from a bare 200.
 *
 * Auth verification and the spawn seam are injected so tests exercise
 * orchestration logic without binding a real port or performing real HMAC.
 * The shared secret flows through but is never written to any log or substrate.
 */
import { deriveEventId } from '../event-id';
import { matchesWhen, resolveRunKey } from '../run-key';
import { runSpawnPath, type SpawnPathDeps } from '../spawn';
import type { IngressBinding } from '../binding';
import type { FlowConfig } from '../../types/kernel';

// ---------------------------------------------------------------------------
// Public types (pinned by webhook.test.ts)
// ---------------------------------------------------------------------------

export interface WebhookRequest {
  route: string;
  headers: Record<string, string>;
  rawBody: string;
}

export interface WebhookResponse {
  status: number;
  /**
   * JSON body naming the accept-path outcome (the original acknowledgement-on-accept work) — e.g.
   * `{"outcome":"accepted","run_id":"…"}`. Absent on boundary rejections, whose
   * status code is the whole answer.
   */
  body?: string;
}

/**
 * A resolved watched route — its flow, binding, and the listener-resolved
 * shared secret (resolved from binding.auth.secret_env at boot, never re-read
 * from the environment per request).
 */
export interface WebhookRouteResolution {
  flowId: string;
  flowPath: string;
  flow: FlowConfig;
  binding: IngressBinding;
  /** The live secret — flows through to verifyAuth but is never logged. */
  secret: string;
}

export interface WebhookAdapterDeps {
  /** WI-406 persistence + spawn + alert seams. */
  spawnDeps: SpawnPathDeps;
  /** FR-6: resolve a route string to the owning flow + binding, or null if unknown. */
  resolveRoute(route: string): WebhookRouteResolution | null;
  /** FR-5: verify the request's HMAC signature or shared-secret header. Constant-time behind the seam. */
  verifyAuth(secret: string, req: WebhookRequest): boolean;
  /** Injected clock so received_at is deterministic in tests (D3/FR-10). */
  now(): number;
}

// ---------------------------------------------------------------------------
// Core handler
// ---------------------------------------------------------------------------

/**
 * Handles a single inbound webhook POST.
 *
 * Every rejection path logs to ingress_log via the shared appendIngressLog
 * (WI-404) before returning. The accept path invokes the real runSpawnPath
 * orchestrator (WI-406), which handles exactly-once deduplication, attempt
 * counting, and substrate envelope construction (WI-403).
 *
 * The shared secret is accepted as an argument to verifyAuth but is never
 * written into any log entry, attribute bag, or substrate field (NFR-5).
 */
export async function handleWebhookRequest(
  deps: WebhookAdapterDeps,
  req: WebhookRequest,
): Promise<WebhookResponse> {
  const { spawnDeps, resolveRoute, verifyAuth, now } = deps;
  const { db } = spawnDeps;

  // ── Step 1: Route resolution (FR-6) ─────────────────────────────────────
  const resolution = resolveRoute(req.route);
  if (resolution === null) {
    db.appendIngressLog({
      source: req.route,
      eventId: null,
      outcome: 'rejected_unknown_flow',
    });
    return { status: 404 };
  }

  // ── Step 2: Auth verification (FR-5, fail-closed) ────────────────────────
  // Auth is checked BEFORE the accept-spawn path so an unauthenticated request
  // can never trigger a billed conduit run.
  if (!verifyAuth(resolution.secret, req)) {
    db.appendIngressLog({
      source: resolution.flowId,
      eventId: null,
      outcome: 'rejected_auth',
    });
    return { status: 401 };
  }

  // ── Step 3: Body parsing ─────────────────────────────────────────────────
  let body: unknown;
  try {
    body = JSON.parse(req.rawBody);
  } catch {
    db.appendIngressLog({
      source: resolution.flowId,
      eventId: null,
      outcome: 'rejected_malformed',
      reason: 'request body is not valid JSON',
    });
    return { status: 400 };
  }

  // ── Step 4: Event ID derivation (WI-405) ─────────────────────────────────
  // Pass the binding directly — IngressBinding is structurally compatible with
  // deriveEventId's internal DeriveBinding (type + event_id fields).
  const idResult = deriveEventId(
    { type: resolution.binding.type, event_id: resolution.binding.event_id },
    // Pass rawBody so the content-hash fallback is immune to JSON key reordering
    // by an upstream proxy (The original webhook-signature validation work).
    { headers: req.headers, body, rawBody: req.rawBody },
    // Stable warn key so the degraded-dedup warning fires once per route, not
    // once per request (The original single-read request-body work).
    `${resolution.flowId}:${req.route}`,
  );

  if (!idResult.ok) {
    db.appendIngressLog({
      source: resolution.flowId,
      eventId: null,
      outcome: 'rejected_malformed',
      reason: `event id derivation failed: ${idResult.reason}`,
    });
    return { status: 400 };
  }

  const { binding } = resolution;

  // ── Step 4a: Event filter (issue #36) ────────────────────────────────────
  // A delivery the binding does not want (a GitHub `push` on a review loop)
  // is acked 2xx so the provider does not retry it, and never reaches
  // ingress_events: filtering is not an accept.
  if (binding.when !== undefined && !matchesWhen(binding.when, { headers: req.headers, body })) {
    db.appendIngressLog({
      source: resolution.flowId,
      eventId: idResult.eventId,
      outcome: 'filtered',
      reason: 'event did not match the binding when conditions',
    });
    return { status: 200, body: JSON.stringify({ outcome: 'filtered' }) };
  }

  // ── Step 4b: Run key (issue #36) ─────────────────────────────────────────
  // Fail closed: an event the binding cannot key is refused like a
  // require-mode event with no id. There is no fallback key, because a
  // fallback would silently give the event a run of its own.
  let runKey: { parts: string[]; maxPasses?: number } | undefined;
  if (binding.run_key !== undefined) {
    const keyResult = resolveRunKey(binding.run_key, { headers: req.headers, body });
    if (!keyResult.ok) {
      db.appendIngressLog({
        source: resolution.flowId,
        eventId: idResult.eventId,
        outcome: 'rejected_run_key',
        reason: keyResult.reason,
      });
      return { status: 400 };
    }
    runKey = { parts: keyResult.parts, ...(binding.max_passes !== undefined && { maxPasses: binding.max_passes }) };
  }

  // ── Step 5: Accept-spawn path (WI-406) ───────────────────────────────────
  // From here the secret is no longer referenced — substrate envelope
  // construction (WI-403/buildEnvelope) runs filterAttributes on headers so
  // sensitive headers like Authorization are dropped before inlining (NFR-5).
  const spawnResult = await runSpawnPath(spawnDeps, {
    source: resolution.flowId,
    eventId: idResult.eventId,
    receivedAt: now(),
    authVerified: true,
    headers: req.headers,
    body,
    flowId: resolution.flowId,
    flowPath: resolution.flowPath,
    flow: resolution.flow,
    substrateMapping: resolution.binding.substrate,
    ...(runKey !== undefined && { runKey }),
  });

  // ── Step 6: Ack the outcome (the original acknowledgement-on-accept work) ─────────────────────────────────
  // 202 for work this delivery put in motion (a run is executing, or is queued
  // behind busy run slots); 200 for a delivery that changed nothing — an
  // already-handled duplicate, or a launch that failed and is now the re-drive
  // sweep's problem. Every outcome stays 2xx, as before: a provider retry adds
  // nothing the bounded re-drive is not already doing. A keyed event folded
  // into its run's pending pass (issue #36) is work put in motion too; one the
  // keyed run refused (pass_limit, run_not_appendable) changed nothing.
  const accepted =
    spawnResult.outcome === 'accepted' ||
    spawnResult.outcome === 'queued' ||
    spawnResult.outcome === 'coalesced';
  return {
    status: accepted ? 202 : 200,
    body: JSON.stringify({
      outcome: spawnResult.outcome,
      ...(accepted && { run_id: spawnResult.runId }),
    }),
  };
}
