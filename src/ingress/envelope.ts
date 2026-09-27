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

/** One ingress event a keyed pass covers, as stored on its ingress_events row. */
export interface PassEventInput {
  eventId: string;
  /** Unix milliseconds, as stored. */
  receivedAt: number;
  /** Unstamped substrate JSON. */
  substrateJson: string;
}

/** Most events one pass's `events` list carries. */
export const MAX_PASS_EVENTS = 50;

/**
 * Most bytes of JSON one pass's `events` list may take, on its own. This is
 * an additional ceiling on the list itself, independent of
 * MAX_STAMPED_SUBSTRATE_BYTES below, which bounds the whole stamped string
 * and is what actually protects the argv launch.
 */
export const MAX_PASS_EVENTS_BYTES = 64 * 1024;

/**
 * Most bytes the WHOLE stamped substrate string may take: the base substrate
 * (whatever the binding's mapping or the raw envelope produced) plus the
 * `run_key`/`pass`/`events`/`events_truncated` stamps. The stamped substrate
 * reaches the kernel as ONE argv string, and Linux caps a single argument at
 * 128 KiB (MAX_ARG_STRLEN); this is comfortably under that so the executable
 * path and any other argv the launcher adds cannot push the call over the
 * limit into a spawn_failed E2BIG. MAX_PASS_EVENTS_BYTES alone is not enough:
 * it bounds only the `events` list, not the base substrate it's appended to,
 * so a large base payload could pass that check while the total argv string
 * still exceeds MAX_ARG_STRLEN.
 */
export const MAX_STAMPED_SUBSTRATE_BYTES = 100 * 1024;

/**
 * Stamp a keyed event's substrate with its run key, pass number and the
 * events the pass covers, as top-level `run_key`, `pass`, `events` and
 * `events_truncated` fields.
 *
 * `run_key` and `pass` let a flow branch on which subject it belongs to and
 * which pass it is running. `events` lists every event folded into this pass,
 * oldest first, each as `{ event_id, received_at, substrate }`; the launching
 * event is the last entry and its substrate's fields are also the top-level
 * ones, as before. When several events arrive during one pass they all become
 * the next pass, so a flow reads `events` to see each of them instead of
 * fetching the subject's state from its source.
 *
 * The events budget is MAX_STAMPED_SUBSTRATE_BYTES minus the bytes of the
 * base substrate plus its run_key/pass/events_truncated stamps (i.e. what's
 * left of the total cap once everything BUT the events list is accounted
 * for), further capped by MAX_PASS_EVENTS and MAX_PASS_EVENTS_BYTES. When any
 * of these cuts the list, the OLDEST events are dropped and `events_truncated`
 * is true: the flow must then fetch what it needs itself. A base substrate
 * that alone exceeds MAX_STAMPED_SUBSTRATE_BYTES leaves no room for any
 * event: the stamped substrate carries an empty `events` list and
 * `events_truncated: true` rather than growing past the argv limit (the
 * unkeyed path has the same limit and no fix here can raise it).
 *
 * A folded event whose stored `substrateJson` fails to parse is skipped
 * rather than thrown: one malformed row must not poison every future launch
 * of the run (hot path, re-drive, and drain all call this). A skipped entry
 * is simply absent from `events`, so `events_truncated` is true whenever one
 * is dropped, the same as any other cut.
 *
 * Applied at LAUNCH, not at accept: an event folded into a pending pass does
 * not know its pass number until the pass starts, so the stored substrate
 * stays unstamped and every launch (hot path, re-drive, pending drain) stamps
 * it from the run's key and the pass the kernel will seed. Unkeyed events are
 * never stamped, so their substrates stay byte-identical. The four names are
 * reserved on keyed bindings at boot (binding.ts), so the stamp cannot shadow
 * a projected field. A substrate that is not a JSON object is returned as is;
 * the envelope and every projection are objects, so that is unreachable.
 */
export function stampKeyedPass(
  substrateJson: string,
  runKey: readonly string[],
  pass: number,
  covered: readonly PassEventInput[],
): string {
  const parsed: unknown = JSON.parse(substrateJson);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return substrateJson;

  const base = parsed as Record<string, unknown>;

  // What's left of the total stamped-string cap once the base substrate and
  // the run_key/pass/events_truncated stamps are accounted for (events: []
  // stands in for the list here since its real bytes are still unknown).
  // events_truncated is fixed at `false` here rather than `true`: it
  // serializes one byte longer ("false" vs "true"), so sizing off it never
  // under-counts should the actual result end up untruncated.
  // MAX_PASS_EVENTS_BYTES still applies as its own ceiling on top of that.
  const stampedWithoutEvents = JSON.stringify({
    ...base,
    run_key: [...runKey],
    pass,
    events: [],
    events_truncated: false,
  });
  const baseBytes = Buffer.byteLength(stampedWithoutEvents, 'utf8');
  const eventsBudget = Math.max(0, Math.min(MAX_PASS_EVENTS_BYTES, MAX_STAMPED_SUBSTRATE_BYTES - baseBytes));

  // Pack newest first, so a cut drops the oldest events.
  const kept: unknown[] = [];
  let bytes = 2; // the enclosing []
  for (let i = covered.length - 1; i >= 0 && kept.length < MAX_PASS_EVENTS; i--) {
    const event = covered[i]!;
    let entry: { event_id: string; received_at: number; substrate: unknown };
    try {
      entry = { event_id: event.eventId, received_at: event.receivedAt, substrate: JSON.parse(event.substrateJson) };
    } catch {
      // A malformed folded entry is skipped, not thrown — see doc comment.
      continue;
    }
    const size = Buffer.byteLength(JSON.stringify(entry), 'utf8') + (kept.length > 0 ? 1 : 0);
    if (bytes + size > eventsBudget) break;
    kept.push(entry);
    bytes += size;
  }

  return JSON.stringify({
    ...base,
    run_key: [...runKey],
    pass,
    events: kept.reverse(),
    events_truncated: kept.length < covered.length,
  });
}
