/**
 * Run-key resolution and the webhook event filter (issue #36).
 *
 * Both read the same two surfaces of an inbound event, a header (matched
 * case-insensitively) or a '$.'-rooted JSON path through the shared
 * resolveJsonPath dialect. Key parts and `in`/`not_in` count only SCALAR
 * values: a string, number, or boolean, compared and recorded as a string.
 * An object, array, null, or missing value is unresolved for them. `present`
 * asks a different question, whether the value exists and is not null, so it
 * sees objects and arrays too: GitHub marks an issue comment on a pull request
 * with an OBJECT at `issue.pull_request`.
 *
 *   - resolveRunKey fails closed: one unresolved part rejects the whole key.
 *     There is deliberately no content-hash fallback, because a fallback key
 *     would give every unkeyable event its own run, which is the per-delivery
 *     behaviour the key exists to replace, reached silently.
 *   - matchesWhen ANDs the binding's conditions. An unresolved subject is in
 *     no list, so `in` fails and `not_in` holds; `present` holds for any
 *     non-null value.
 *
 * Every value here comes from an untrusted payload. Nothing is interpolated
 * into SQL or a shell; a part longer than MAX_RUN_KEY_PART_LENGTH is rejected
 * so the envelope never carries an unbounded key.
 */
import type { RunKeyPart, WhenCondition } from './binding';
import { resolveJsonPath } from './json-path';

/** Longest accepted key part, in UTF-16 code units. */
export const MAX_RUN_KEY_PART_LENGTH = 512;

/** The parts of an inbound event the key and filter read. */
export interface KeyedEventSurface {
  headers: Record<string, unknown>;
  body: unknown;
}

export type ResolveRunKeyResult =
  | { ok: true; parts: string[] }
  | { ok: false; reason: string };

/** A resolved scalar as a string, or null when the value does not count. */
function scalarString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return null;
}

function headerValue(headers: Record<string, unknown>, name: string): unknown {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

/** The raw value a subject resolves to; undefined or null when absent. */
function resolveRaw(subject: { header: string } | { json_path: string }, event: KeyedEventSurface): unknown {
  return 'header' in subject ? headerValue(event.headers, subject.header) : resolveJsonPath(event.body, subject.json_path);
}

function resolveSubject(
  subject: { header: string } | { json_path: string },
  event: KeyedEventSurface,
): string | null {
  return scalarString(resolveRaw(subject, event));
}

/**
 * Resolve every part of a run key, in declared order. A json_path part tries
 * its alternatives in order and takes the first that yields a non-empty
 * scalar. Returns the reason for the first unresolved part otherwise.
 */
export function resolveRunKey(parts: readonly RunKeyPart[], event: KeyedEventSurface): ResolveRunKeyResult {
  const resolved: string[] = [];
  for (const [index, part] of parts.entries()) {
    const candidates: Array<{ header: string } | { json_path: string }> =
      'header' in part ? [{ header: part.header }] : part.json_path.map((path) => ({ json_path: path }));
    let value: string | null = null;
    for (const candidate of candidates) {
      const v = resolveSubject(candidate, event);
      if (v !== null && v !== '') {
        value = v;
        break;
      }
    }
    const label = 'header' in part ? `header '${part.header}'` : `json_path ${JSON.stringify(part.json_path)}`;
    if (value === null) {
      return { ok: false, reason: `run_key part ${index} (${label}) did not resolve to a non-empty scalar` };
    }
    if (value.length > MAX_RUN_KEY_PART_LENGTH) {
      return {
        ok: false,
        reason: `run_key part ${index} (${label}) is ${value.length} chars, over the ${MAX_RUN_KEY_PART_LENGTH}-char limit`,
      };
    }
    resolved.push(value);
  }
  return { ok: true, parts: resolved };
}

/** Does the event meet every `when` condition? */
export function matchesWhen(conditions: readonly WhenCondition[], event: KeyedEventSurface): boolean {
  return conditions.every((condition) => {
    if ('present' in condition) {
      const raw = resolveRaw(condition, event);
      return (raw !== null && raw !== undefined) === condition.present;
    }
    const value = resolveSubject(condition, event);
    if ('in' in condition) return value !== null && condition.in.includes(value);
    return value === null || !condition.not_in.includes(value);
  });
}
