# ADR-0014: Token budgets weight cache classes per billing adapter

Status: Accepted (issue #125, 2026-11-09)
Date: 2026-11-09

## Context

`budgets.run.max_tokens` and `budgets.per_wave.max_tokens` (SPEC §6 guard #4, §8) compared
against a raw token total in which a cache-read token counted the same as an uncached input
token. Since issue #108 a Claude harness call's figure is the session total from `modelUsage`,
which includes cache reads, and since issue #156 a transform call's cache reads reach the budget
too. In a multi-turn agent call cache reads dominate: each tool call re-reads the whole
conversation from cache.

Shakedown run sd-cf (PR #121, issue #30) used 0.67M uncached input and 6.35M cache reads against
a 6M `max_tokens`. The consumption andon fired after every walker had finished, so the fan-in
report never ran. Anthropic bills cache reads at about a tenth of the input price, so a limit
sized for spend tripped about ten times early on that run. A limit sized for cache-heavy runs is
far too loose for uncached ones.

The issue listed three options: a weighted token total, a cost budget (`max_cost_usd`), and
separate limits per token class. The journal already stores `cache_read_input_tokens` and
`cache_creation_input_tokens` per span, and the adapter that billed each harness span, so the
data exists for each.

Cache pricing differs by provider, and one flow can mix providers: a Claude harness maker, a
codex critic and a transform station behind an OpenAI-compatible gateway.

## Decision

**The run and wave budgets compare `max_tokens` against a weighted total. Uncached input and
output count at 1. Cache reads and cache creation count at weights resolved per call for the
adapter that billed it. A flow's `budgets.token_weights` sets a class for every adapter; a class
it leaves unset takes the adapter's default.**

```yaml
budgets:
  run: { max_tokens: 6_000_000 }
  token_weights:            # optional; each class set here applies to every adapter
    cache_read: 0.1
    cache_creation: 1.25
```

### Adapter defaults

`src/worker/adapter-cache-weights.ts` is the one table, keyed by the adapter name the journal
records on a span. A test requires an entry for every shipped harness adapter, so a new adapter
cannot ship without choosing its weights. Each default is the least favourable price ratio among
the providers the adapter can bill through, so a default never counts less than the call spent.

| adapter | cache_read | cache_creation | reason |
|---|---|---|---|
| `claude-headless`, `agent-sdk` | 0.1 | 2 | Anthropic: cache reads bill at 0.1x input; cache writes at 1.25x (5-minute TTL) or 2x (1-hour TTL) |
| `codex-exec`, `codex-app-server` | 0.5 | 1 | OpenAI: the cached-input discount is 50% to 90% by model, so 0.5; cache writes are not billed above input |
| `opencode` | 1 | 1 | the model string can route to any provider |
| transform (`openai-compatible`) | 1 | 1 | the gateway can route to any provider |
| unknown, or no adapter on the span | 1 | 1 | no discount without knowing the provider |

**Claude cache creation is 2, not 1.25.** The recorded Claude Code stream
(`fixtures/harness/claude-stream-json.ndjson`) reports every cache write as
`ephemeral_1h_input_tokens` and none as `ephemeral_5m_input_tokens`, so the CLI, and the Agent
SDK that drives it, write 1-hour cache entries, billed at 2x. A default of 1 would count those
writes at half their price, and 1.25 would still undercount 1-hour writes. If a session writes
5-minute entries, 2 overcounts its cache creation by 60 percent, which errs toward an early halt.

### Where the weighting applies

`src/control/token-weights.ts` holds the arithmetic, and `resolveTokenWeights(override, adapter)`
the precedence. Every path that adds spend to the run's `tokensSpent` or a card's wave tokens
resolves the weights of the adapter that billed the call:

- **Transform calls** (`trackingAdapter`): `weightedModelResponseTokens` with the
  `openai-compatible` weights.
- **Harness calls** (`foldHarnessUsage(usage, adapterName)`): the fold takes the call's
  `KnownUsage` and the adapter's name. The maker's success, throw and rate-limit park pass the
  maker's adapter; the gate critic passes the critic's adapter (`CriticUsage.adapterName`), which
  can differ from the maker's.
- **Subflow roll-up**: the child returns its spend grouped by adapter (`runUsageByAdapter`, which
  reads the child's journal and recurses into grandchildren), and the parent folds each adapter's
  share with its own flow's override over that adapter's defaults. One summed breakdown would lose
  which share was Claude and which codex, and would have to count at the least favourable weight.
  A share the parts do not account for, or a roll-up with no per-adapter shares, counts at 1. The
  child enforces the ceiling the parent passed down with the child's own override; when the two
  flows' overrides differ the parent can see the child overshoot its remaining budget by one
  roll-up, and trips then.
- **Journal-derived figures** (`runBudgetTokens`, used by `remainingRunTokens` for
  `--append-pass` and `conduit resume` of a run with passes, and by the `run status` line): each
  span is weighted for the adapter recorded on it. A `<station>.subflow` span is replaced by its
  child run's spans, found through its `child_run_id`, so the child's adapters are weighted as the
  executor weighted them; a subflow span whose child left no spans counts at 1. Transform spans
  record no adapter and count at the unknown weights, which equal the transform adapter's.
- **Pooled deterministic workers** report raw tokens with no split; they count at 1.

The journal keeps raw per-class figures. `conduit run status` prints one line when the budget
figure differs from the raw one, for example
`budget tokens: 2610 of run max_tokens 6000 (raw 14040; cache weights per adapter)`. When the flow
sets a class, the line names it: `cache weights per adapter, flow sets cache read x0.25`, or
`flow sets cache read x1, cache creation x1` when it sets both. A mixed run has no single weight,
so the line does not print one.

### Missing data never lowers the count

A call must never count less than its true spend would justify because data is missing:

- A harness call whose adapter reports no breakdown (a total only, or a subflow roll-up with no
  per-adapter shares) counts its whole total at weight 1.
- A breakdown with a negative or non-numeric class is ignored, and the total counts at weight 1.
- A breakdown whose classes sum to less than the reported total counts the difference at
  weight 1. A breakdown that sums to more counts each class at its weight; nothing is
  subtracted from it.
- The journal keeps the same count. `harnessJournalUsage` adds that difference to the span's
  `input_tokens`, so the four columns still sum to the reported total, and a breakdown with an
  unusable class is journaled as no breakdown. Today's adapters report totals their classes cover
  (`codex-app-server`'s `totalTokens` is input plus output, with reasoning tokens a subset of
  output), so this guards against a future adapter or a changed upstream shape rather than a
  known gap.
- A span or share whose adapter is unknown takes weight 1 for each class the flow does not set.
- A transform call with no cache split reported counts all of `inputTokens` at weight 1, since
  that figure may include cached tokens (issue #156's convention).

No adapter's missing cost matters, because this option does not use cost.

### Validation at load

`budgets.token_weights` is validated in `collectErrors` (`INVALID_TOKEN_WEIGHTS`): it must be a
mapping whose only keys are `cache_read` and `cache_creation`; `cache_read` is a finite number
from 0 to 1 and `cache_creation` a finite number from 0 to 2. A cache read never costs more than
uncached input, so a weight above 1 is a typo. Cache creation is the exception: Anthropic bills
5-minute cache writes at 1.25 times the input price and 1-hour writes at 2 times. A negative
weight would let a budget fall as spend rises, so it is rejected. The adapter defaults stay inside
the same ranges, which a test checks.

There is no per-station or per-adapter weight in `flow.yaml`; the override is per flow.

### Backward compatibility

A `flow.yaml` with `max_tokens` and no `token_weights` loads unchanged. Its budgets now count
Claude harness cache reads at 0.1 and cache writes at 2, codex cache reads at 0.5, and every other
adapter's cache classes at 1, as before. For a run with no cache reads or writes nothing changes.
A cache-heavy Claude or codex run gets a looser budget than before, which is the point of the
issue; a Claude run that writes a lot of cache gets a tighter one. A flow that wants the old raw
count declares `token_weights: { cache_read: 1, cache_creation: 1 }`.

## Alternatives

**A flat default of `cache_read: 0.1` for every adapter.** The first version of this change did
this. It matches Anthropic, but an OpenAI cached read can cost half the input price, and a call
through `opencode` or a transform gateway can reach a provider with no cache discount at all, so
the flat default counts those calls at a fifth or a tenth of their price. That breaks the rule
that missing knowledge never lowers the count.

**A flat default of 1** (opt in to the discount). It never undercounts and keeps every existing
budget identical, but every cache-heavy Claude flow would keep tripping early until its author
found the key, and the issue's run would still halt. The adapter that billed a call is known
exactly, so using it costs nothing in safety.

**A cost budget (`budgets.run.max_cost_usd`).** It tracks spend exactly when the adapter reports
cost. `codex-app-server` reports no cost, nor does a Codex hold's partial usage, and transform
gateways vary. A call with no cost would have to count as zero, which under-counts, or as some
estimate, which is a weight table by another name. It also changes the unit of every existing
limit. A cost budget can be added later beside `max_tokens` without undoing this decision.

**Separate limits per token class** (`max_uncached_input_tokens`, `max_cache_read_tokens`, ...).
Exact and needs no weights, but the operator has to size three or four limits instead of one, and
a run can hit one limit while far under the others, which reads as arbitrary. A weighted total
expresses the same intent with one number.

**A child run reporting one weighted figure to its parent.** Simpler than per-adapter shares, but
the figure would carry the child's override, not the parent's, so the parent's
`token_weights` would not govern spend made on its behalf.

## Consequences

- A single `max_tokens` now bounds spend for cache-heavy and uncached runs alike, within the
  accuracy of the adapter defaults.
- The defaults are conservative for OpenAI models with a 75% or 90% cached-input discount and
  for any provider `opencode` or a transform gateway reaches that discounts cache reads. A flow
  that knows its provider sets `token_weights` for an exact figure.
- `tokensSpent` and the wave tokens can be fractional. The andon compares with `>=`, a subflow's
  ceiling and a pass's remaining budget are rounded down, and `run status` rounds the budget
  figure up.
- `run status` reads the override from the flow file, so editing `token_weights` after a run
  changes the figure it prints for that run. Editing an adapter default in a later release does
  the same for older runs.
- A journaled remainder shows up as uncached input in the `run status` cache-share report, which
  slightly understates that station's cache share.
- `scripts/mutation-check.ts` guards the per-adapter lookup, the flow override, the critic's own
  adapter, the cache-read weight, the unaccounted remainder (in the fold and in the journal) and
  the transform cache term, alongside the five fold sites.

## References

- Issue #125; issue #108 (Claude session totals); issue #156 (transform cache reads).
- SPEC §6 (guard #4), §8 (two andons), §12 (cost model).
- `src/worker/adapter-cache-weights.ts`, `src/control/token-weights.ts`,
  `src/controller/executor.ts` (`trackingAdapter`, `foldHarnessUsage`, `subflowFoldParts`),
  `src/run/run-passes.ts` (`runBudgetTokens`, `runUsageByAdapter`), `src/run/budget-usage.ts`.
