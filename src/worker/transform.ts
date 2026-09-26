/**
 * Transform station runtime (WI-296, SPEC §16 step 3, SPEC §7).
 *
 * A transform station makes exactly one kernel-mediated model call per
 * execution attempt, coercively parses the text response, and validates it
 * against the station output schema.  A parse or validation failure is a PAID
 * re-bill that consumes one execution attempt.  On exhausting
 * per_card.max_execution_attempts the station scraps with reason
 * 'model-incompatible' (SPEC §7 rev-1 H5).
 *
 * GUARD-2 COUNTER RELATIONSHIP (SPEC §6.2 — read this before changing the loop):
 *   The durable execution-attempt counter and the authoritative scrap decision
 *   live in the WI-293 FSM (transitions.ts INTEGRITY_FAIL), NOT here. This loop
 *   is a TRANSPORT-LEVEL parse/validate retry — SPEC §6 guard #2 — bounded by
 *   the SAME budget value (ctx.maxExecutionAttempts) so a station can never
 *   silently out-spend its durable cap. It retries within a SINGLE dispatch
 *   (one call to runTransformStation), NOT across multiple dispatches of the
 *   same card. Its behaviour is NOT invisible: every call increments `callsMade`,
 *   every call (pass or fail) is journaled under its own attempt index, and the
 *   EXACT number of calls made is surfaced as the `attempts` field of
 *   TransformResult. The caller (tick) reconciles the durable executionAttempt
 *   counter from that surfaced count and lets the FSM own the final scrap —
 *   there is no hidden, uncounted burning of the cap.
 *
 *   Guard #1 (per-card rework cap) is managed by runGateRework in
 *   gate-rework.ts. Guard #4 (andon / wall-clock + token budget) is checked by
 *   checkConsumptionAndon in watchdog.ts after each dispatch. This function is
 *   ONLY guard #2.
 *
 * Key invariants:
 *   - Workers call ctx.adapter.call — NEVER the network directly.
 *   - ctx.params is passed to the adapter AS-IS; process.env is never read.
 *   - Every call (success and failure) is journaled via db.appendJournalSpan
 *     under its own incrementing attempt index, starting at ctx.attempt.
 *   - `attempts` in TransformResult equals the number of model calls made — the
 *     caller uses it to advance the durable Guard-2 counter (no double-count).
 *   - On success the StationOutput uses the WI-289 envelope shape; findings_hash
 *     is a deterministic, key-order-invariant SHA-256 of the payload.
 */

import { createHash } from 'node:crypto';
import type { StationOutput } from '../types/kernel';
import type { ConduitDB, JournalProvenance } from '../persistence/db';
import type { ModelAdapter, ModelResponse } from './adapter';
import type { ImageInput } from './image-input';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Schema object that validates and narrows an unknown value to T. */
export interface OutputSchema<T> {
  validate(value: unknown): { ok: true; value: T } | { ok: false; error: string };
}

/** All inputs a transform station needs at runtime. */
export interface TransformContext<T> {
  cardId: string;
  station: string;
  /**
   * Run that owns this dispatch — threaded onto every usage span so per-call
   * token/cost lands under the run that actually made the call, not the global
   * DEFAULT_RUN_ID sweep (the original per-run usage-attribution work). Required, not optional-with-default: an
   * omitted run id is exactly the silent mis-attribution this field removes.
   */
  runId: string;
  /** Starting execution-attempt index (Card.attempt from the state DB). */
  attempt: number;
  /** Absolute call ceiling — per_card.max_execution_attempts from the flow. */
  maxExecutionAttempts: number;
  model: string;
  prompt: string;
  /** Allow-listed inference params ONLY — never raw process.env values. */
  params: Record<string, unknown>;
  schema: OutputSchema<T>;
  /** Injected kernel adapter — the ONLY path to the model. */
  adapter: ModelAdapter;
  /** Journal handle for OTel-aligned per-call token/cost attribution. */
  db: ConduitDB;
  /**
   * Resolved image inputs for this station, in declared order.
   * Undefined (not an empty array) when the station declares no image_inputs,
   * so text-only ModelCall objects carry no `images` field at all (NFR-1).
   */
  images?: ImageInput[];
  /**
   * Optional per-call wall-clock timeout in milliseconds (punch-list #8),
   * derived by the executor from the station's `timeout_seconds`. Threaded into
   * each ModelCall so the adapter bounds a hung gateway call. Undefined → the
   * adapter's explicit engine-default timeout (not truly unbounded — the original transform-timeout work).
   */
  timeoutMs?: number;
  /**
   * Provenance of the station execution this call belongs to (binding stamp
   * and effective prompt_template_version), written onto every usage span.
   * Omitted by a caller that computes no stamp, such as a transform gate
   * critic, which leaves the columns NULL.
   */
  provenance?: JournalProvenance;
}

/** What runTransformStation returns to the tick dispatcher. */
export type TransformResult<T> =
  | { status: 'complete'; output: StationOutput<T>; attempts: number }
  | {
      status: 'scrapped';
      reason: 'model-incompatible' | 'vision-unsupported' | 'output-truncated';
      attempts: number;
    };

// ---------------------------------------------------------------------------
// Coercive parsing (SPEC §7)
// ---------------------------------------------------------------------------

/**
 * Strip a markdown code fence (```json ... ``` or ``` ... ```) and return the
 * inner content, or null if the text is not fenced.
 */
function stripCodeFence(text: string): string | null {
  const m = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  return m ? m[1].trim() : null;
}

/**
 * Find and parse the first balanced JSON object { ... } in free-form text.
 * Returns the parsed value on success, or null if none is found.
 *
 * STRING-AWARE (SPEC §7 coercive parsing): braces INSIDE JSON string values are
 * not structural and must not affect depth — e.g. {"foo":"a}b"} or {"k":"{x"}.
 * An `inString` flag, toggled on each UNESCAPED double-quote (honoring `\`
 * escapes), ensures only braces OUTSIDE strings are counted. Without this a
 * prose-wrapped object containing a brace in a string fails recovery → a paid
 * re-bill / false 'model-incompatible' scrap.
 */
function collectJsonObjects(text: string): unknown[] {
  const found: unknown[] = [];
  let startIdx = 0;
  while (true) {
    const openAt = text.indexOf('{', startIdx);
    if (openAt === -1) break;

    let depth = 0;
    let closeAt = -1;
    let inString = false;
    let escaped = false;
    for (let i = openAt; i < text.length; i++) {
      const ch = text[i];

      if (inString) {
        if (escaped) {
          // This char is the target of a backslash escape — consume literally.
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
      } else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          closeAt = i;
          break;
        }
      }
    }

    if (closeAt !== -1) {
      try {
        found.push(JSON.parse(text.slice(openAt, closeAt + 1)));
        // Resume scanning AFTER this balanced object so a later top-level object
        // (the reasoning-answer case, the original reasoning-response parsing work) is collected too — not nested
        // braces already consumed inside it.
        startIdx = closeAt + 1;
        continue;
      } catch {
        // This span wasn't valid JSON — advance past the opening brace and retry.
      }
    }
    startIdx = openAt + 1;
  }
  return found;
}

/**
 * Find and parse the first balanced JSON object { ... } in free-form text.
 * Returns the parsed value on success, or null if none is found.
 */
function extractFirstJsonObject(text: string): unknown {
  const objects = collectJsonObjects(text);
  return objects.length > 0 ? objects[0] : null;
}

/**
 * Tolerant / coercive parse of a model response text.
 *
 * Priority:
 *   1. Direct JSON.parse (clean response)
 *   2. Strip markdown code fence, then JSON.parse
 *   3. Extract first balanced {…} object from surrounding prose
 *
 * Returns the parsed value, or null if recovery fails.
 *
 * Exported so the harness execution path (WI-565) reuses this exact recovery
 * logic on output collected from disk, instead of re-implementing it.
 */
export function coerciveParse(text: string): unknown {
  const trimmed = text.trim();

  // 1. Clean parse
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }

  // 2. Strip code fence
  const inner = stripCodeFence(trimmed);
  if (inner !== null) {
    try {
      return JSON.parse(inner);
    } catch {
      // fall through
    }
  }

  // 3. Extract first JSON object from prose
  const embedded = extractFirstJsonObject(text);
  if (embedded !== null) return embedded;

  return null;
}

/**
 * Ordered list of parse candidates for a model response, highest-confidence
 * first — for a caller that can validate each against a schema and take the
 * first that passes (runTransformStation). Priority:
 *
 *   1. Clean JSON.parse of the whole response
 *   2. JSON.parse of a stripped markdown code fence
 *   3. Balanced {…} objects embedded in prose, LAST-to-first
 *
 * The last-to-first order at step 3 is the original reasoning-response parsing work fix: reasoning models emit
 * chain-of-thought prose (which may itself contain brace-y, even parseable,
 * fragments) and place the real answer LAST. Preferring the last embedded object
 * — but only among candidates that pass schema validation — recovers the answer
 * without regressing the historical first-object behavior: when the first object
 * is the one that validates (the non-reasoning case), it is still selected,
 * because a schema-invalid trailing object is skipped.
 *
 * A single-object clean/fenced response yields one candidate identical to
 * coerciveParse's result, so non-reasoning flows are unaffected.
 */
export function coerciveParseCandidates(text: string): unknown[] {
  const candidates: unknown[] = [];
  const trimmed = text.trim();

  try {
    candidates.push(JSON.parse(trimmed));
  } catch {
    // not a clean JSON document — fall through
  }

  const inner = stripCodeFence(trimmed);
  if (inner !== null) {
    try {
      candidates.push(JSON.parse(inner));
    } catch {
      // fenced block was not valid JSON — fall through
    }
  }

  // Embedded prose objects, last-to-first (the reasoning-answer ordering).
  const embedded = collectJsonObjects(text);
  for (let i = embedded.length - 1; i >= 0; i--) {
    candidates.push(embedded[i]);
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Findings hash
// ---------------------------------------------------------------------------

/**
 * Canonical JSON serialization: recursively sort object keys so two payloads
 * that differ ONLY in key order serialize identically. Arrays keep their order
 * (order is semantically meaningful in a list). Primitives pass through.
 *
 * Guard 3 (SPEC §6 rev-1 H2) keys progress-monotonicity on findings_hash, so
 * the hash must be invariant to incidental key reordering across attempts — a
 * key-order-sensitive hash would mask a genuine no-progress loop.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Deterministic, key-order-invariant SHA-256 fingerprint of a payload.
 *
 * Exported so the harness execution path (WI-565) builds the SAME
 * StationOutput envelope shape a transform station does, rather than
 * re-implementing the hash.
 */
export function computeFindingsHash(payload: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(payload)))
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

/**
 * Execute a transform station:
 *   1. Call the kernel adapter (never the network directly).
 *   2. Journal the call — including failures (every call is a paid re-bill).
 *   3. Coercively parse the response text.
 *   4. Validate against the station output schema.
 *   5. On success: return the StationOutput wrapped in TransformResult.
 *   6. On parse/validate failure: retry if under the execution-attempt cap.
 *   7. On cap exhaustion: scrap with reason 'model-incompatible'.
 */
export async function runTransformStation<T>(
  ctx: TransformContext<T>,
): Promise<TransformResult<T>> {
  let callsMade = 0;

  // Transport-level parse/validate retry. Bounded by the SAME durable budget
  // value (ctx.maxExecutionAttempts) so it cannot out-spend the Guard-2 cap; the
  // count is surfaced via `attempts` and the FSM owns the authoritative scrap.
  while (callsMade < ctx.maxExecutionAttempts) {
    // The attempt index for this specific call, starting at ctx.attempt.
    const attemptIndex = ctx.attempt + callsMade;

    // ── Call the kernel adapter ─────────────────────────────────────────────
    // Pass images only when present so text-only calls carry no images field
    // (NFR-1: ModelCall.images stays undefined for stations without image_inputs).
    //
    // Capability-mismatch fast-scrap (WI-421): if the adapter throws with
    // code === 'vision-unsupported', the model cannot accept image input at all.
    // This is NOT a transient failure — retrying to the cap would only waste
    // budget and produce the same rejection. Fast-scrap with the distinct reason
    // immediately. callsMade is the pre-increment value (0 on the first call) so
    // `attempts` reflects completed (billed) calls — the failing call is not billed.
    let response: ModelResponse;
    try {
      response = await ctx.adapter.call({
        model: ctx.model,
        prompt: ctx.prompt,
        params: ctx.params, // ONLY allow-listed params — never process.env
        ...(ctx.images != null && ctx.images.length > 0 ? { images: ctx.images } : {}),
        ...(ctx.timeoutMs != null ? { timeoutMs: ctx.timeoutMs } : {}),
      });
    } catch (adapterErr) {
      if ((adapterErr as { code?: string }).code === 'vision-unsupported') {
        return { status: 'scrapped', reason: 'vision-unsupported', attempts: callsMade };
      }
      throw adapterErr;
    }

    callsMade++;

    // ── Journal this call (PAID re-bill — even on failure) ──────────────────
    // Pass runId so this usage row is attributed to the run that made the call.
    // Without it appendJournalSpan defaults to DEFAULT_RUN_ID and every run's
    // token/cost collapses under 'default', making per-run attribution
    // impossible (the original per-run usage-attribution work).
    ctx.db.appendJournalSpan({
      cardId: ctx.cardId,
      station: ctx.station,
      runId: ctx.runId,
      attempt: attemptIndex,
      name: `${ctx.station}.transform`,
      ...ctx.provenance,
      usage: {
        model: ctx.model,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        costUsd: response.costUsd,
      },
    });

    // ── Coercive parse + schema-gated candidate selection (the original reasoning-response parsing work) ────────
    // Validate each parse candidate in priority order and take the FIRST that
    // passes the schema. For a clean/fenced response this is a single candidate
    // (identical to the historical coerciveParse result); for prose-wrapped
    // reasoning output it prefers the LAST embedded object — the answer — while
    // still falling back to an earlier object if the trailing one is not schema-
    // valid. A candidate that fails validation is skipped, not scrapped.
    for (const candidate of coerciveParseCandidates(response.text)) {
      const validated = ctx.schema.validate(candidate);
      if (validated.ok) {
        const payload = validated.value;
        const output: StationOutput<T> = {
          payload,
          findings_hash: computeFindingsHash(payload),
          return_to: null, // transform maker always proceeds — no back-edge
          usage: {
            tokens: response.inputTokens + response.outputTokens,
            cost: response.costUsd,
          },
        };
        return { status: 'complete', output, attempts: callsMade };
      }
    }

    // ── Truncation fast-scrap (the original reasoning-response parsing work review) ─────────────────────────────
    // finish_reason === 'length' with NO recoverable schema-valid answer means
    // the model exhausted its token budget WHILE still generating — content /
    // reasoning_content is a truncated, answerless fragment (queso's gpt-oss-120b
    // reviewer case). Retrying re-runs the same prompt at the same max_tokens and
    // deterministically truncates again — the same futility as vision-unsupported.
    // Scrap FAST with a distinct, legible reason so the operator sees "raise
    // max_tokens / reduce reasoning" rather than a masquerading parse-failure
    // scrap that also burned the whole attempt budget. (Only reached when no
    // candidate validated: a truncation that still yielded a valid answer above
    // completes normally.)
    if (response.finishReason === 'length') {
      return { status: 'scrapped', reason: 'output-truncated', attempts: callsMade };
    }

    // No candidate parsed AND validated — loop (cap enforced by while condition).
  }

  return {
    status: 'scrapped',
    reason: 'model-incompatible',
    attempts: callsMade,
  };
}
