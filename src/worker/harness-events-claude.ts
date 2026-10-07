/**
 * Claude Code stream-json -> HarnessEvent mapper (issue #70).
 *
 * A pure function of ONE stdout line from `claude -p --output-format
 * stream-json --verbose`. The adapter runs without
 * `--include-partial-messages`, so the stream carries whole `assistant`
 * messages and each complete content block maps to one event (decision 1).
 * The Agent SDK's message objects share this schema, so the SDK adapter (#21)
 * can reuse the mapper.
 *
 * Tolerant by construction, like parseClaudeStream: an unknown or malformed
 * line, or a malformed block inside a known one, yields no events rather than
 * a throw. The mapper assigns no `seq`; the adapter numbers events as it
 * forwards them, which keeps this function stateless.
 */

import type { RateLimitWindow, UsageBreakdown } from './harness-adapter';
import type { HarnessEventBody } from './harness-events';

/** The rate_limit_info fields read here; see ClaudeRateLimitEvent in the adapter. */
export interface ClaudeRateLimitInfo {
  status?: string;
  isUsingOverage?: boolean;
  rateLimitType?: string;
  utilization?: number;
  /** Epoch SECONDS. */
  resetsAt?: number;
  unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number }>;
}

/**
 * The windows ONE rate_limit_event reports, flat window first.
 *
 * The CLI emits one window per event with its fields flat at the top level and
 * named by `rateLimitType`; `unifiedWindows` is a fallback some builds carry.
 * The flat entry wins within one event (it is the event's own subject), so a
 * nested window of the same name is skipped. resetsAt is epoch seconds on the
 * wire; the result is in milliseconds. Shared with parseClaudeStream so the
 * event stream and the park read windows the same way.
 */
export function rateLimitWindowsFromInfo(info: ClaudeRateLimitInfo): RateLimitWindow[] {
  const windows: RateLimitWindow[] = [];
  if (typeof info.utilization === 'number' && typeof info.resetsAt === 'number') {
    windows.push({ name: info.rateLimitType ?? 'window', utilization: info.utilization, resetsAtMs: info.resetsAt * 1000 });
  }
  const flatName = windows[0]?.name;
  for (const [name, w] of Object.entries(info.unifiedWindows ?? {})) {
    if (typeof w?.utilization !== 'number' || typeof w.resetsAt !== 'number') continue;
    if (name === flatName) continue;
    windows.push({ name, utilization: w.utilization, resetsAtMs: w.resetsAt * 1000 });
  }
  return windows;
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

/** Content blocks of a message, or [] when the message has none in block form. */
function contentBlocks(event: Json): unknown[] {
  const message = event.message;
  if (!isObject(message) || !Array.isArray(message.content)) return [];
  return message.content;
}

function mapAssistant(event: Json, lineIndex?: number): HarnessEventBody[] {
  // Keyed by the LINE, not the message: the CLI writes one line per content
  // block, and consecutive lines share a message id. A line without a `uuid`
  // folds in the caller's line ordinal, since its message id is not unique.
  const message = isObject(event.message) ? event.message : {};
  const messageKey = typeof message.id === 'string' ? message.id : 'block';
  const key =
    typeof event.uuid === 'string'
      ? event.uuid
      : lineIndex !== undefined
        ? `${messageKey}@${lineIndex}`
        : messageKey;
  const events: HarnessEventBody[] = [];
  contentBlocks(event).forEach((block, index) => {
    if (!isObject(block)) return;
    const id = `${key}:${index}`;
    if (block.type === 'text' && typeof block.text === 'string') {
      events.push({ type: 'text-delta', id, delta: block.text });
    } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
      events.push({ type: 'reasoning-delta', id, delta: block.thinking });
    } else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
      events.push({ type: 'tool-input-start', toolCallId: block.id, toolName: block.name });
      events.push({ type: 'tool-input-available', toolCallId: block.id, toolName: block.name, input: block.input });
    }
  });
  return events;
}

function mapUser(event: Json): HarnessEventBody[] {
  const results = contentBlocks(event).filter(
    (b): b is Json => isObject(b) && b.type === 'tool_result' && typeof b.tool_use_id === 'string',
  );
  // `tool_use_result` sits on the message, not the block, so it is attributed
  // only when the message answers exactly one call.
  const raw = results.length === 1 && 'tool_use_result' in event ? event.tool_use_result : undefined;
  return results.map((block) => ({
    type: 'tool-output-available',
    toolCallId: block.tool_use_id as string,
    output: block.content,
    isError: block.is_error === true,
    ...(raw !== undefined ? { toolUseResult: raw } : {}),
  }));
}

const MODEL_USAGE_CLASSES = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens'] as const;

/**
 * The four token classes a Claude `result` message accounts for (issue #108).
 *
 * Read from `modelUsage`, summed across every entry, because it is the only
 * cumulative token figure on the message. `usage` covers only the turns since
 * the previous result message and leaves out the side-task model Claude Code
 * bills alongside the main one, so with a background subagent (two result
 * messages) the last `usage` can be a quarter of the session's tokens.
 * `total_cost_usd` is cumulative too, so tokens and cost now describe the same
 * span.
 *
 * Falls back to `usage` only when `modelUsage` is absent or has no entry that
 * carries a numeric class. Undefined when neither is an object. A non-numeric
 * class counts as zero. Shared by buildKnownUsage (the figure the budgets fold)
 * and the journal's `usage` event, so the two cannot disagree.
 */
export function claudeResultBreakdown(event: unknown): UsageBreakdown | undefined {
  if (!isObject(event)) return undefined;
  const modelUsage = event.modelUsage;
  if (isObject(modelUsage)) {
    const sum: UsageBreakdown = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
    let usable = false;
    for (const entry of Object.values(modelUsage)) {
      if (!isObject(entry)) continue;
      for (const cls of MODEL_USAGE_CLASSES) {
        if (typeof entry[cls] !== 'number') continue;
        usable = true;
        sum[cls] += entry[cls];
      }
    }
    if (usable) return sum;
  }
  const usage = event.usage;
  if (!isObject(usage)) return undefined;
  return {
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    cacheReadInputTokens: num(usage.cache_read_input_tokens),
    cacheCreationInputTokens: num(usage.cache_creation_input_tokens),
  };
}

function mapResult(event: Json): HarnessEventBody[] {
  // No usage object, no event: the same condition under which buildKnownUsage
  // reports no figure.
  if (!isObject(event.usage)) return [];
  const breakdown = claudeResultBreakdown(event)!;
  return [
    {
      type: 'usage',
      tokens:
        breakdown.inputTokens + breakdown.outputTokens + breakdown.cacheReadInputTokens + breakdown.cacheCreationInputTokens,
      breakdown,
      ...(typeof event.total_cost_usd === 'number' ? { costUsd: event.total_cost_usd } : {}),
    },
  ];
}

function mapRateLimit(event: Json): HarnessEventBody[] {
  const info = event.rate_limit_info;
  if (!isObject(info)) return [];
  const typed = info as ClaudeRateLimitInfo;
  return [
    {
      type: 'rate-limit',
      ...(typeof typed.status === 'string' ? { status: typed.status } : {}),
      ...(typeof typed.isUsingOverage === 'boolean' ? { usingOverage: typed.isUsingOverage } : {}),
      windows: rateLimitWindowsFromInfo(typed),
    },
  ];
}

/**
 * Map one already-parsed stream message to zero or more events. Never throws.
 * The Agent SDK's `query()` yields these objects directly (issue #21), so it
 * calls this instead of `mapClaudeStreamLine`. `lineIndex` has the same
 * meaning as there: the message's 0-based ordinal within the invocation.
 */
export function mapClaudeStreamMessage(event: unknown, lineIndex?: number): HarnessEventBody[] {
  if (!isObject(event)) return [];
  switch (event.type) {
    case 'assistant':
      return mapAssistant(event, lineIndex);
    case 'user':
      return mapUser(event);
    case 'result':
      return mapResult(event);
    case 'rate_limit_event':
      return mapRateLimit(event);
    default:
      return [];
  }
}

/**
 * Map one stream-json line to zero or more events. Never throws.
 *
 * `lineIndex` is the line's 0-based ordinal within the invocation. A caller
 * streaming a whole invocation passes it so a uuid-less assistant line still
 * gets ids unique to that line.
 */
export function mapClaudeStreamLine(line: string, lineIndex?: number): HarnessEventBody[] {
  const trimmed = line.trim();
  if (trimmed.length === 0) return [];
  let event: unknown;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return [];
  }
  return mapClaudeStreamMessage(event, lineIndex);
}
