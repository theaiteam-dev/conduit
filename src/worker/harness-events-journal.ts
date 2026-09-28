/**
 * Harness event journal writer (issue #71).
 *
 * Turns the stamped `HarnessEvent`s of one harness `invoke()` call into
 * `harness_events` rows. The executor builds one sink per station execution
 * (maker) or gate check (critic), wraps it with `stampHarnessEvents` once per
 * `invoke()`, and passes the result as `HarnessInvocation.onEvent`.
 *
 * What is kept is fixed by the War Room rule that the journal is the one
 * source of truth and holds no transcripts:
 *   - Only `tool-input-available`, `tool-output-available`, `usage`,
 *     `rate-limit` and `lifecycle` are written. `text-delta`,
 *     `reasoning-delta` and `tool-input-start` are dropped.
 *   - No prompt text, no tool input body, no tool output body. A tool call is
 *     recorded by its name and the path it touched; a result by its error
 *     flag and, for a failed Bash call, the exit code in its error string.
 */

import type { ConduitDB, HarnessEventRowInput, StoredHarnessEvent } from '../persistence/db';
import type { StampedHarnessEvent } from './harness-events';

/** Which card and station a sink writes for. */
export interface HarnessEventScope {
  runId: string;
  cardId: string;
  station: string;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The file path a tool call names in its input, for the tools that take one:
 * `file_path` (Read, Write, Edit), `notebook_path` (NotebookEdit) or `path`
 * (Glob, Grep). A Bash command is not parsed for paths; it is input body.
 */
export function pathFromToolInput(input: unknown): string | undefined {
  if (!isObject(input)) return undefined;
  for (const key of ['file_path', 'notebook_path', 'path']) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/** The `filePath` a structured tool result reports (Write, Edit), if any. */
function pathFromToolResult(toolUseResult: unknown): string | undefined {
  if (!isObject(toolUseResult)) return undefined;
  const value = toolUseResult.filePath;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

const EXIT_CODE_PREFIX = /^(?:Error: )?Exit code (\d+)\b/;

/** The first text of a tool_result content: a string, or the first text block. */
function leadingText(output: unknown): string | undefined {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    const first = output.find((b) => isObject(b) && b.type === 'text' && typeof b.text === 'string');
    return first !== undefined ? ((first as Record<string, unknown>).text as string) : undefined;
  }
  return undefined;
}

/**
 * A failed Bash call's exit code. Claude's stream-json carries none as a
 * field: a failed call's `tool_use_result` is the string `Error: Exit code N`
 * followed by output, and its `tool_result` content starts `Exit code N`. The
 * number is read from that prefix and nothing else of the string is kept. A
 * call not flagged as an error, or one whose error names no exit code,
 * returns undefined, which stores NULL.
 */
export function exitCodeFromToolOutput(isError: boolean, toolUseResult: unknown, output: unknown): number | undefined {
  if (!isError) return undefined;
  for (const text of [typeof toolUseResult === 'string' ? toolUseResult : undefined, leadingText(output)]) {
    if (text === undefined) continue;
    const match = EXIT_CODE_PREFIX.exec(text);
    if (match !== null) return Number(match[1]);
  }
  return undefined;
}

/**
 * The row one stamped event becomes, or null for a kind the journal does not
 * keep. `atMs` is when the kernel received the event.
 */
export function harnessEventRow(
  event: StampedHarnessEvent,
  scope: HarnessEventScope,
  atMs: number,
): HarnessEventRowInput | null {
  const base = {
    ...scope,
    attempt: event.attempt,
    invocationId: event.invocationId,
    seq: event.seq,
    atMs,
  };
  switch (event.type) {
    case 'tool-input-available': {
      const path = pathFromToolInput(event.input);
      return {
        ...base,
        kind: event.type,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        ...(path !== undefined ? { path } : {}),
      };
    }
    case 'tool-output-available': {
      const path = pathFromToolResult(event.toolUseResult);
      const exitCode = exitCodeFromToolOutput(event.isError, event.toolUseResult, event.output);
      return {
        ...base,
        kind: event.type,
        toolCallId: event.toolCallId,
        isError: event.isError,
        ...(path !== undefined ? { path } : {}),
        ...(exitCode !== undefined ? { exitCode } : {}),
      };
    }
    case 'usage':
      return {
        ...base,
        kind: event.type,
        tokens: event.tokens,
        breakdown: event.breakdown,
        ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
      };
    case 'rate-limit':
      return {
        ...base,
        kind: event.type,
        ...(event.status !== undefined ? { rateLimitStatus: event.status } : {}),
        rateLimitWindows: event.windows,
      };
    case 'lifecycle':
      return {
        ...base,
        kind: event.type,
        phase: event.phase,
        ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
      };
    case 'text-delta':
    case 'reasoning-delta':
    case 'tool-input-start':
      return null;
    // Issue #21: not persisted yet. The agent-sdk adapter slice adds the row
    // kind, the schema change and the read side together.
    case 'gate-decision':
      return null;
  }
}

/**
 * A sink that writes each durable event to `harness_events`. It never throws:
 * a billed harness call must not fail because the journal write did. The
 * emitter in harness-events.ts already drops a consumer's throw; this catch
 * keeps that true for a caller that invokes the sink directly.
 */
export function createHarnessEventJournalSink(
  db: ConduitDB,
  scope: HarnessEventScope,
  now: () => number = Date.now,
): (event: StampedHarnessEvent) => void {
  return (event) => {
    try {
      const row = harnessEventRow(event, scope, now());
      if (row !== null) db.appendHarnessEvent(row);
    } catch {
      // Dropped by design (see above). The row's seq stays unused, so the gap is visible.
    }
  };
}

// C0 controls (including \n \r \t), DEL, and C1 controls.
const CONTROL_CHARS = /[\x00-\x1F\x7F-\x9F]/;

/**
 * A harness-supplied string, safe to print on one line. The harness process
 * chooses this text (a tool's path argument, a phase name, ...), so it is
 * printed verbatim only when it has no control characters; otherwise it is
 * quoted and escaped via JSON.stringify so a newline or other control
 * character cannot make one event look like more than one journal line.
 */
function renderHarnessString(value: string): string {
  return CONTROL_CHARS.test(value) ? JSON.stringify(value) : value;
}

/**
 * One harness_events row as `conduit journal inspect` and `tail` print it:
 * receive time, seq, kind, and the columns that kind carries. Read side only.
 */
export function formatHarnessEvent(row: StoredHarnessEvent): string {
  const parts = [new Date(row.atMs).toISOString(), `#${row.seq}`, row.kind];
  switch (row.kind) {
    case 'tool-input-available':
      if (row.toolName !== null) parts.push(renderHarnessString(row.toolName));
      if (row.path !== null) parts.push(`path=${renderHarnessString(row.path)}`);
      break;
    case 'tool-output-available':
      parts.push(row.isError === true ? 'error' : 'ok');
      if (row.exitCode !== null) parts.push(`exit=${row.exitCode}`);
      if (row.path !== null) parts.push(`path=${renderHarnessString(row.path)}`);
      break;
    case 'usage':
      if (row.tokens !== null) parts.push(`tokens=${row.tokens}`);
      if (row.costUsd !== null) parts.push(`cost=$${row.costUsd}`);
      break;
    case 'rate-limit':
      if (row.rateLimitStatus !== null) parts.push(`status=${renderHarnessString(row.rateLimitStatus)}`);
      for (const w of row.rateLimitWindows ?? [])
        parts.push(`${renderHarnessString(w.name)}=${Math.round(w.utilization * 100)}%`);
      break;
    case 'lifecycle':
      if (row.phase !== null) parts.push(renderHarnessString(row.phase));
      if (row.exitCode !== null) parts.push(`exit=${row.exitCode}`);
      break;
  }
  return parts.join(' ');
}
