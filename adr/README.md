# Architecture Decision Records

This folder tracks **why** Conduit is built the way it is — the decisions that would
otherwise get re-litigated every few months. Each ADR captures one decision, the forces
behind it, the alternatives we rejected, and what we trade away by choosing it.

[`SPEC.md`](../SPEC.md) is the *what* (the design as it stands). [`docs/philosophy.md`](../docs/philosophy.md)
is the *worldview*. ADRs are the *why* behind specific choices, with the alternatives we
considered preserved so a future reader doesn't have to rediscover them.

## Format

Lightweight [Nygard-style](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions.html):

```
# ADR-NNNN: <short decision, present tense>
Status: Proposed | Accepted | Superseded by ADR-MMMM
Date: YYYY-MM-DD

## Context        — the forces and problem
## Decision       — what we decided
## Alternatives   — what we rejected, and why
## Consequences    — what we gain, what we pay, what to revisit
```

- Numbered sequentially, never renumbered. A decision that changes gets a **new** ADR that
  *supersedes* the old one (the old one stays, marked superseded).
- Keep them short and concrete. Link to the SPEC section the decision lives in.

## Index

| # | Decision | Status |
|---|---|---|
| [0001](./0001-build-vs-buy-the-orchestration-substrate.md) | Build the orchestration substrate; don't adopt an existing engine | Accepted |
| [0002](./0002-bun-as-the-kernel-runtime.md) | Bun as the kernel runtime | Accepted |
| [0003](./0003-packaging-and-distribution.md) | Packaging & distribution — Docker-first, Bun in the image | Accepted |
| [0004](./0004-deterministic-kernel-llm-as-labor.md) | Deterministic kernel, LLM-as-labor — no LLM in the control loop | Accepted |
| [0005](./0005-station-taxonomy.md) | Station taxonomy — two axes, Law scoped to agentic | Accepted |
| [0006](./0006-telemetry-and-cost-attribution.md) | Telemetry & cost attribution — OTel GenAI, kernel-sourced | Accepted |
| [0007](./0007-hitl-hold-timeout-enforcement.md) | HITL hold-timeout enforcement — opportunistic, injected-clock, fail-open | Accepted |
| [0008](./0008-adapter-capability-introspection.md) | Adapter capability introspection — a static, offline-queryable surface on HarnessAdapter | Accepted |
| [0009](./0009-per-concern-decomposition-on-shared-impl-file.md) | Concerns sharing an impl file stay a dependency chain, not a consolidated item | Accepted |
| [0010](./0010-thread-address-convention-for-egress-sends.md) | Thread-address convention for egress sends — conventional substrate field, resolved per run | Accepted |
| [0011](./0011-file-egress-reconciliation.md) | File-egress reconciliation — a real `files.info` probe narrows the hold window; ambiguity still holds | Accepted |
| [0012](./0012-overlapping-ungated-harness-calls.md) | Ungated harness calls may overlap under `--concurrency`, with owned-dir attribution in the integrity check | Accepted (measurement pending) |
| [0013](./0013-os-enforced-write-confinement-of-overlapped-harness-calls.md) | Overlapped harness calls run under OS-enforced write confinement (Landlock) | Accepted |

## Candidate ADRs (decisions worth recording next)

These are settled in the SPEC but not yet written up as standalone ADRs — split them out if
they ever come into question:

- **Secret handling** — allowlist what reaches the journal, never put raw env into worker
  context, masking only as defense-in-depth (SPEC §11 L2).

> Promoted to standalone ADRs since this list was first written: deterministic kernel /
> LLM-as-labor → [ADR-0004](./0004-deterministic-kernel-llm-as-labor.md); station taxonomy →
> [ADR-0005](./0005-station-taxonomy.md); telemetry & cost attribution →
> [ADR-0006](./0006-telemetry-and-cost-attribution.md); channel / HITL fail-closed policy +
> hold-timeout enforcement → [ADR-0007](./0007-hitl-hold-timeout-enforcement.md). "Own runtime,
> not hosted" is recorded within [ADR-0001](./0001-build-vs-buy-the-orchestration-substrate.md)
> (Decision + alternative D).
