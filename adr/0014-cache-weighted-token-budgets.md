# ADR-0014: Token budgets count cache classes at configurable weights

Status: Accepted (issue #125, 2026-11-08)
Date: 2026-11-08

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
`cache_creation_input_tokens` per span, so the data exists for each.

## Decision

**The run and wave budgets compare `max_tokens` against a weighted total: uncached input and
output count at 1, cache reads at `budgets.token_weights.cache_read` (default 0.1) and cache
creation at `budgets.token_weights.cache_creation` (default 1).**

```yaml
budgets:
  run: { max_tokens: 6_000_000 }
  token_weights:            # optional; these are the defaults
    cache_read: 0.1
    cache_creation: 1
```

### Where the weighting applies

`src/control/token-weights.ts` holds the arithmetic. Every path that adds spend to the run's
`tokensSpent` or a card's wave tokens goes through it:

- **Transform calls** (`trackingAdapter`): `weightedModelResponseTokens` counts uncached input
  plus output plus `cache_read` times the cache reads.
- **Harness calls** (`foldHarnessUsage`): the fold takes the call's `KnownUsage`, not a number,
  and `weightedUsageTokens` weights its breakdown. All five fold sites (gate critic, rate-limit
  park, maker throw, maker success, subflow roll-up) pass the usage they already held, so no
  site can fold an unweighted figure.
- **Subflow roll-up**: the child's spend comes back with a per-class split summed from the
  child's journal (`getRunUsageBreakdown`), and the parent weights it with its own flow's
  weights. The child enforces the ceiling the parent passed down with the child's own weights;
  when the two flows' weights differ the parent can see the child overshoot its remaining budget
  by one roll-up, and trips then.
- **Runs that take passes** (`remainingRunTokens`): the remaining budget for `--append-pass` and
  for `conduit resume` of such a run subtracts the journal's spend weighted the same way, rounded
  down.
- **Pooled deterministic workers** report raw tokens with no split; they count at 1.

The journal is unchanged: spans keep the raw per-class figures. `conduit run status` prints one
extra line when the budget figure differs from the raw one, for example
`budget tokens: 2610 of run max_tokens 6000 (raw 14040; cache read x0.1, cache creation x1)`,
reading the weights from the run's flow file.

### Missing data never lowers the count

A call must never count less than its true spend would justify because data is missing:

- A harness call whose adapter reports no breakdown (`codex-exec`, a subflow whose child
  journaled no split, any adapter that reports a total only) counts its whole total at weight 1.
- A breakdown with a negative or non-numeric class is ignored, and the total counts at weight 1.
- A breakdown whose classes sum to less than the reported total counts the difference at
  weight 1. A breakdown that sums to more counts each class at its weight; nothing is
  subtracted from it.
- A transform call with no cache split reported counts all of `inputTokens` at weight 1, since
  that figure may include cached tokens (issue #156's convention).

No adapter's missing cost matters, because this option does not use cost.

### Validation at load

`budgets.token_weights` is validated in `collectErrors` (`INVALID_TOKEN_WEIGHTS`): it must be a
mapping whose only keys are `cache_read` and `cache_creation`; `cache_read` is a finite number
from 0 to 1 and `cache_creation` a finite number from 0 to 2. A cache read never costs more than
uncached input, so a weight above 1 is a typo. Cache creation is the exception: Anthropic bills
5-minute cache writes at 1.25 times the input price and 1-hour writes at 2 times, so a flow that
wants its budget to track spend there needs a weight above 1. A negative weight would let a
budget fall as spend rises, so it is rejected.

### Backward compatibility

A `flow.yaml` with `max_tokens` and no `token_weights` loads unchanged, and its budgets now count
cache reads at 0.1. For a run with no cache reads nothing changes. For a cache-heavy run the
budget is looser than before, which is the point of the issue: the old count tripped about ten
times early relative to spend. A flow that wants the old count declares
`token_weights: { cache_read: 1 }`. Cache creation keeps its old weight of 1 unless declared.

## Alternatives

**A cost budget (`budgets.run.max_cost_usd`).** It tracks spend exactly when the adapter reports
cost. `codex-app-server` reports no cost, nor does a Codex hold's partial usage, and transform
gateways vary. A call with no cost would have to count as zero, which under-counts, or as some
estimate, which is a weight table by another name. It also changes the unit of every existing
limit. A cost budget can be added later beside `max_tokens` without undoing this decision.

**Separate limits per token class** (`max_uncached_input_tokens`, `max_cache_read_tokens`, ...).
Exact and needs no weights, but the operator has to size three or four limits instead of one, and
a run can hit one limit while far under the others, which reads as arbitrary. A weighted total
expresses the same intent with one number.

**A default `cache_read` of 1** (opt in to the discount). It keeps every existing budget
identical, but every cache-heavy flow would keep tripping early until its author found the key,
and the issue's run would still halt.

## Consequences

- A single `max_tokens` now bounds spend for cache-heavy and uncached runs alike, within the
  accuracy of the weights.
- The right weight depends on the provider. 0.1 matches Anthropic; OpenAI's cached-input discount
  is 50 to 90 percent depending on the model, so an OpenAI-heavy flow may want a higher
  `cache_read`. The weights are per flow, not per station or per adapter; revisit if a flow mixes
  providers with very different cache pricing.
- `tokensSpent` and the wave tokens can be fractional. The andon compares with `>=`, a subflow's
  ceiling and a pass's remaining budget are rounded down, and `run status` rounds the budget
  figure up.
- `run status` reads the weights from the flow file, so editing `token_weights` after a run
  changes the figure it prints for that run. The figure is journal-derived and can be lower than
  the executor's count for a harness call whose breakdown did not cover its whole total, because
  the journal stores only the classes.
- `scripts/mutation-check.ts` guards the cache-read weight, the unaccounted remainder and the
  transform cache term, alongside the five fold sites.

## References

- Issue #125; issue #108 (Claude session totals); issue #156 (transform cache reads).
- SPEC §6 (guard #4), §8 (two andons), §12 (cost model).
- `src/control/token-weights.ts`, `src/controller/executor.ts` (`trackingAdapter`,
  `foldHarnessUsage`), `src/run/run-passes.ts` (`remainingRunTokens`), `src/run/budget-usage.ts`.
