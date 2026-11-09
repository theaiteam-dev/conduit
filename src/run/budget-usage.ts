/**
 * Issue #125: the `conduit run status` line that shows a run's spend in
 * budget tokens next to its raw tokens, when cache weighting makes them
 * differ (ADR-0014).
 *
 * Weights are resolved per span for the adapter that billed it, so a mixed
 * run has no single weight to print. The line says so, and names any class
 * the flow's `budgets.token_weights` sets for every adapter. The override and
 * `run.max_tokens` come from the run's flow file (`runs.flow` holds its
 * resolved path), read fresh: run status has no loaded flow. A flow that
 * cannot be read or parsed, or whose `budgets.token_weights` fails
 * validation, prints no line rather than a figure computed with weights the
 * run may not have used.
 *
 * The figure is journal-derived (run-passes.ts `runBudgetTokens`), like the
 * remaining budget of a run that takes passes, so it matches what
 * `--append-pass` and `conduit resume` subtract, and the executor's count.
 */
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { ConduitDB } from '../persistence/db';
import { formatWeight, validateTokenWeights, type FlowTokenWeights } from '../control/token-weights';
import { runBudgetTokens } from './run-passes';

interface FlowBudgetView {
  override: FlowTokenWeights | undefined;
  maxTokens?: number;
}

/** Read the weight override and run max_tokens from a flow file, or null. */
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
    override: block['token_weights'] as FlowTokenWeights | undefined,
    ...(typeof maxTokens === 'number' && { maxTokens }),
  };
}

/** "cache weights per adapter" plus the classes the flow sets for all of them. */
function weightsText(override: FlowTokenWeights | undefined): string {
  const set: string[] = [];
  if (override?.cache_read !== undefined) set.push(`cache read x${formatWeight(override.cache_read)}`);
  if (override?.cache_creation !== undefined) set.push(`cache creation x${formatWeight(override.cache_creation)}`);
  if (set.length === 2) return `flow sets ${set.join(', ')}`;
  if (set.length === 1) return `cache weights per adapter, flow sets ${set[0]}`;
  return 'cache weights per adapter';
}

/**
 * "budget tokens: B[ of run max_tokens M] (raw R; cache weights per
 * adapter[, flow sets ...])", or null when the run has no usage, its flow is
 * unreadable, or the budget figure equals the raw one.
 */
export function formatBudgetTokens(db: ConduitDB, runId: string): string | null {
  const run = db.getRun(runId);
  if (run === null) return null;
  const view = readFlowBudgetView(run.flow);
  if (view === null) return null;
  const raw = db.getRunUsageTotals(runId).tokens;
  if (raw === 0) return null;
  const budget = Math.ceil(runBudgetTokens(db, runId, view.override));
  if (budget === raw) return null;
  const max = view.maxTokens === undefined ? '' : ` of run max_tokens ${view.maxTokens}`;
  return `budget tokens: ${budget}${max} (raw ${raw}; ${weightsText(view.override)})`;
}
