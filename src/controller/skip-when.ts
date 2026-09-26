/**
 * Evaluation of a station's `skip_when` predicate (issue #32, SPEC §3/§4).
 *
 * The controller calls evaluateSkipWhen when a card becomes ready at a station
 * that declares `skip_when`. The decision is one of:
 *
 *   - skip: the value read equals `equals` (strict equality, no coercion). The
 *     controller fires the FSM's SKIP event.
 *   - run:  the value has the same type as `equals` and differs. The card is
 *     dispatched as usual.
 *   - hold: the value could not be read or compared. The controller holds the
 *     card, because choosing skip or run on unreadable state is a guess.
 *
 * The loader has already validated the predicate's shape (flow/load.ts
 * validateSkipWhen); this module only reads card state.
 */

import type { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readLatestCheckpoint } from '../checkpoint/checkpoint';
import type { SkipWhenConfig, SkipWhenScalar } from '../types/kernel';

export type SkipDecision =
  | { action: 'skip'; value: SkipWhenScalar }
  | { action: 'run'; value: SkipWhenScalar }
  | { action: 'hold'; reason: string };

export interface SkipEvalContext {
  /** State DB holding the checkpoints table (read for `source: output`). */
  stateDb: Database;
  runId: string;
  /** Checkpoint `flow` key: the flow version as a string. */
  flowVersion: string;
  card: { id: string; owned_paths: readonly string[] };
}

/** Render a predicate for the card_log and diagnostics, e.g. `seed.x == true`. */
export function describeSkipWhen(pred: SkipWhenConfig): string {
  const where = pred.source === 'seed' ? 'seed' : `output(${pred.station})`;
  return `${where}.${pred.field} == ${JSON.stringify(pred.equals)}`;
}

type DocumentRead = { ok: true; doc: unknown; origin: string } | { ok: false; reason: string };

function readSeed(ctx: SkipEvalContext): DocumentRead {
  const ownedDir = ctx.card.owned_paths[0];
  if (ownedDir === undefined) {
    return { ok: false, reason: `card '${ctx.card.id}' has no owned_paths, so it has no seed.json` };
  }
  const path = join(ownedDir, 'seed.json');
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (e) {
    return { ok: false, reason: `cannot read seed.json at '${path}': ${(e as Error).message}` };
  }
  try {
    return { ok: true, doc: JSON.parse(text), origin: `seed.json at '${path}'` };
  } catch (e) {
    return { ok: false, reason: `seed.json at '${path}' is not valid JSON: ${(e as Error).message}` };
  }
}

function readOutput(ctx: SkipEvalContext, station: string): DocumentRead {
  // readLatestCheckpoint throws on a corrupt output_json (same contract as
  // readCheckpoint — it does not swallow parse errors). A truncated row from
  // a crash mid-write must not escape as an exception here: hold instead.
  let record: ReturnType<typeof readLatestCheckpoint>;
  try {
    record = readLatestCheckpoint(ctx.stateDb, {
      run: ctx.runId,
      flow: ctx.flowVersion,
      card: ctx.card.id,
      station,
    });
  } catch (e) {
    return {
      ok: false,
      reason: `station '${station}' checkpoint for card '${ctx.card.id}' is not valid JSON: ${(e as Error).message}`,
    };
  }
  if (record === null) {
    return { ok: false, reason: `station '${station}' has no checkpoint for card '${ctx.card.id}'` };
  }
  return { ok: true, doc: record.output.payload, origin: `the output of station '${station}'` };
}

/** Evaluate `pred` against the card's state. Never throws on bad card state. */
export function evaluateSkipWhen(pred: SkipWhenConfig, ctx: SkipEvalContext): SkipDecision {
  const read = pred.source === 'seed' ? readSeed(ctx) : readOutput(ctx, pred.station);
  if (!read.ok) return { action: 'hold', reason: read.reason };

  const { doc, origin } = read;
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { action: 'hold', reason: `${origin} is not a JSON object` };
  }
  if (!Object.hasOwn(doc, pred.field)) {
    return { action: 'hold', reason: `${origin} has no field '${pred.field}'` };
  }
  const value: unknown = (doc as Record<string, unknown>)[pred.field];
  const actualType = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (actualType !== typeof pred.equals) {
    return {
      action: 'hold',
      reason:
        `${origin} field '${pred.field}' is ${actualType}, but skip_when compares it ` +
        `to a ${typeof pred.equals}`,
    };
  }
  const scalar = value as SkipWhenScalar;
  return scalar === pred.equals ? { action: 'skip', value: scalar } : { action: 'run', value: scalar };
}
