/**
 * WI-403 — Canonical deterministic substrate envelope (SPEC §9 / D3, FR-10).
 *
 * Every accepted event is mapped into a canonical SubstrateEnvelope and
 * written onto the parent card's substrate before spawning `conduit run`.
 * A binding may additionally declare a deterministic JSON-path substrate
 * mapping that projects envelope fields onto named substrate fields.
 *
 * Design invariants:
 *  - NO Date.now(), no randomness, no model call — determinism is load-bearing.
 *  - received_at is always passed in by the caller; identical input → byte-identical output.
 *  - Headers AND the body are secret-filtered via the canonical filterAttributes
 *    from db.ts (NFR-5). Webhook/Slack bodies legitimately carry sensitive tokens
 *    (Slack's legacy `token` field, OAuth `code`/`access_token` callbacks, …), so
 *    the body is screened with the same recursive sensitive-key filter as headers.
 */
import { filterAttributes } from '../persistence/db';
import { resolveJsonPath } from './json-path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SubstrateEnvelope {
  source: string;
  event_id: string;
  received_at: number;
  auth_verified: boolean;
  /** Secret-filtered via db.ts filterAttributes — sensitive headers are dropped, not masked. */
  headers: Record<string, unknown>;
  /**
   * Secret-filtered via db.ts filterAttributes when the body is a plain object —
   * sensitive keys (token, access_token, secret, …) are dropped, not masked.
   * Non-object bodies (string/array/primitive) pass through unfiltered.
   */
  body: unknown;
  /** Empty array when none are supplied by the caller. */
  attachments: unknown[];
  /** Index signature so SubstrateEnvelope is assignable to Record<string, unknown>. */
  [key: string]: unknown;
}

interface BuildEnvelopeInput {
  source: string;
  eventId: string;
  receivedAt: number;
  authVerified: boolean;
  headers: Record<string, unknown>;
  body: unknown;
  attachments?: unknown[];
}

// ---------------------------------------------------------------------------
// buildEnvelope
// ---------------------------------------------------------------------------

/**
 * Maps a camelCase accepted-event input into the canonical snake_case
 * SubstrateEnvelope. Headers are passed through the shared sensitive-key
 * filter so adapter secrets are never embedded in the substrate.
 *
 * The body is filtered with the same recursive sensitive-key blocklist as
 * headers when it is a plain JSON object — webhook/Slack payloads legitimately
 * carry secrets (Slack's legacy `token`, OAuth `code`/`access_token`) that must
 * not be embedded in the substrate (NFR-5). Non-object bodies (string, array,
 * primitive) are passed through unchanged: there are no top-level keys to screen.
 *
 * Determinism guarantees: received_at is threaded straight through (no
 * internal Date.now()), and identical inputs always produce byte-identical
 * output.
 */
export function buildEnvelope(input: BuildEnvelopeInput): SubstrateEnvelope {
  return {
    source: input.source,
    event_id: input.eventId,
    received_at: input.receivedAt,
    auth_verified: input.authVerified,
    headers: filterAttributes(input.headers),
    body: filterBody(input.body),
    attachments: input.attachments ?? [],
  };
}

/**
 * Applies the canonical sensitive-key filter to a body only when it is a plain
 * object (the shape a parsed webhook/Slack payload takes). Arrays and primitives
 * have no top-level keys to screen and are returned unchanged.
 */
function filterBody(body: unknown): unknown {
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    return filterAttributes(body as Record<string, unknown>);
  }
  return body;
}

// ---------------------------------------------------------------------------
// projectSubstrate
// ---------------------------------------------------------------------------

/**
 * Projects named substrate fields out of the envelope via JSON-paths ("$.a.b").
 * Numeric segments index into arrays ("$.body.event.files.0.id") — see
 * resolveJsonPath in json-path.ts for the dialect (The original JSON-path array-projection work).
 *
 * When a mapping is given, each entry resolves the path against the envelope
 * and produces { name: resolvedValue }. An unresolved path (missing leaf,
 * missing intermediate, or missing top-level key) yields the target field
 * PRESENT with value `null` — never omitted, never throws.
 *
 * When no mapping is given, returns the raw canonical envelope unchanged so
 * the flow can consume it directly via a head transform station.
 */
export function projectSubstrate(
  envelope: SubstrateEnvelope,
  mapping?: Record<string, string>,
): Record<string, unknown> {
  if (mapping === undefined) {
    return envelope;
  }

  const result: Record<string, unknown> = {};
  for (const [name, path] of Object.entries(mapping)) {
    result[name] = resolveJsonPath(envelope, path);
  }
  return result;
}

// ---------------------------------------------------------------------------
// stampKeyedPass (issue #36)
// ---------------------------------------------------------------------------

/**
 * Stamp a keyed event's substrate with its run key and pass number, as
 * top-level `run_key` and `pass` fields, so a flow can branch on which pass it
 * is running and which subject it belongs to.
 *
 * Applied at LAUNCH, not at accept: an event folded into a pending pass does
 * not know its pass number until the pass starts, so the stored substrate
 * stays unstamped and every launch (hot path, re-drive, pending drain) stamps
 * it from the run's key and the pass the kernel will seed. Unkeyed events are
 * never stamped, so their substrates stay byte-identical. The two names are
 * reserved on keyed bindings at boot (binding.ts), so the stamp cannot shadow
 * a projected field. A substrate that is not a JSON object is returned as is;
 * the envelope and every projection are objects, so that is unreachable.
 */
export function stampKeyedPass(substrateJson: string, runKey: readonly string[], pass: number): string {
  const parsed: unknown = JSON.parse(substrateJson);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return substrateJson;
  return JSON.stringify({ ...(parsed as Record<string, unknown>), run_key: [...runKey], pass });
}
