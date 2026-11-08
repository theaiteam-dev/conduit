/**
 * Issue #125: the `conduit run status` line that shows a run's spend in
 * budget tokens next to its raw tokens, when cache weighting makes them
 * differ (ADR-0014).
 *
 * The weights come from the run's flow file (`runs.flow` holds its resolved
 * path), read fresh: run status has no loaded flow. A flow that cannot be
 * read or parsed, or whose `budgets.token_weights` fails validation, prints
 * no line rather than a figure computed with weights the run may not have
 * used.
 *
 * The figure is journal-derived, like the remaining budget of a run that takes
 * passes, so it matches what `--append-pass` and `conduit resume` subtract.
 * The executor's in-memory count can be higher for a harness call whose
 * breakdown did not account for its whole total, because the journal records
 * only the classes.
 */
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { ConduitDB } from '../persistence/db';
import {
  formatWeight,
  resolveTokenWeights,
  validateTokenWeights,
  type FlowTokenWeights,
  type TokenWeights,
} from '../control/token-weights';
import { runBudgetTokens } from './run-passes';

interface FlowBudgetView {
  weights: TokenWeights;
  maxTokens?: number;
}

/** Read the weights and run max_tokens from a flow file, or null. */
export function readFlowBudgetView(flowPath: string): FlowBudgetView | null {
  let doc: unknown;
  try {
    doc = parse(readFileSync(flowPath, 'utf8'));
  } catch {
    return null;
  }
  const budgets = (doc as { budgets?: unknown } | null)?.budgets;
  const block = typeof budgets === 'object' && budgets !== null ? (budgets as Record<string, unknown>) : {};
  if (validateTokenWeights(block['token_weights']).length > 0) return null;
  const run = block['run'];
  const maxTokens =
    typeof run === 'object' && run !== null ? (run as Record<string, unknown>)['max_tokens'] : undefined;
  return {
    weights: resolveTokenWeights(block['token_weights'] as FlowTokenWeights | undefined),
    ...(typeof maxTokens === 'number' && { maxTokens }),
  };
}

/**
 * "budget tokens: B (raw R; cache read x0.1, cache creation x1)[ of run
 * max_tokens M]", or null when the run has no usage, its flow is unreadable,
 * or the budget figure equals the raw one.
 */
export function formatBudgetTokens(db: ConduitDB, runId: string): string | null {
  const run = db.getRun(runId);
  if (run === null) return null;
  const view = readFlowBudgetView(run.flow);
  if (view === null) return null;
  const b = db.getRunUsageBreakdown(runId);
  const raw = b.inputTokens + b.outputTokens + b.cacheReadInputTokens + b.cacheCreationInputTokens;
  if (raw === 0) return null;
  const budget = Math.ceil(runBudgetTokens(db, runId, view.weights));
  if (budget === raw) return null;
  const max = view.maxTokens === undefined ? '' : ` of run max_tokens ${view.maxTokens}`;
  return (
    `budget tokens: ${budget}${max} (raw ${raw}; cache read x${formatWeight(view.weights.cacheRead)}, ` +
    `cache creation x${formatWeight(view.weights.cacheCreation)})`
  );
}
