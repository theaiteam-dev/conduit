/**
 * Kernel-mediated model-call seam (WI-296).
 *
 * Workers NEVER reach the network directly.  They call ctx.adapter.call(...)
 * and the kernel adapter resolves the provider, applies rate-limits, and
 * returns the typed response.  This indirection lets tests inject a stub
 * without touching any real API endpoint.
 *
 * NETWORK-EGRESS ENFORCEMENT BOUNDARY (SPEC §7, agentic step 9 — no coverage
 * here): this adapter is a CALL-ROUTING seam, not an egress firewall. The
 * guarantee that a content-processing worker cannot reach the network
 * (`network_egress: deny`) is enforced at the HARNESS / Linux network-namespace
 * layer — the kernel spawns agentic workers via `unshare --net`, so the
 * subprocess has no external interfaces regardless of what adversarial substrate
 * instructs it to attempt. Nothing in this file blocks, allowlists, or inspects
 * network traffic; do NOT read this seam as providing egress containment. The
 * model call itself is made by the kernel process on the worker's behalf, which
 * is precisely what lets egress stay denied for the worker while LLM calls still
 * succeed.
 */

import type { ImageInput } from './image-input';

/** The request handed from a worker to the kernel adapter. */
export interface ModelCall {
  /** Model identifier as used by the provider (e.g. 'gpt-4o-mini'). */
  model: string;
  /** Rendered prompt string — the full text sent to the model. */
  prompt: string;
  /**
   * ONLY the explicitly allow-listed inference parameters (temperature,
   * max_tokens, etc.).  Raw process.env values must never appear here.
   */
  params: Record<string, unknown>;
  /**
   * Optional image inputs to accompany the text prompt (FR-2, WI-413).
   *
   * Additive field — text-only callers omit it entirely and are structurally
   * identical to the pre-image shape (NFR-1). Size/count limits are enforced
   * by WI-420; this seam carries whatever the caller provides.
   *
   * Each ImageInput is log-safe: JSON.stringify and String() coercion expose a
   * path reference only, never the raw pixel bytes (NFR-3).
   */
  images?: ImageInput[];
  /**
   * Optional per-call wall-clock timeout in MILLISECONDS (punch-list #8).
   *
   * When set (> 0), the adapter bounds each network attempt with an
   * `AbortSignal.timeout` — a single hung gateway call is aborted rather than
   * blocking the worker forever (a hung call is an *active* worker, so the
   * liveness watchdog never trips). Absent/undefined → the adapter applies an
   * explicit engine-default timeout (NOT truly unbounded: Bun's fetch has a
   * hidden ~300s default, and an unbounded call could hang forever — the original transform-timeout work).
   * Derived by the executor from a station's `timeout_seconds`.
   */
  timeoutMs?: number;
}

/** What the kernel adapter returns to the worker after a successful call. */
export interface ModelResponse {
  /** Raw model output text (may contain fences, prose, etc.). */
  text: string;
  /**
   * Input/prompt tokens billed for this call. When `cacheReadInputTokens` is
   * set, this is UNCACHED input only (issue #5 convention, issue #156), and
   * the call's prompt total is `inputTokens + cacheReadInputTokens`. Anything
   * computing a total must add both.
   */
  inputTokens: number;
  /**
   * Cache-read input tokens, when the provider reported a usable figure
   * (issue #156). Undefined means no split was reported, not zero.
   */
  cacheReadInputTokens?: number;
  /** Number of output/completion tokens billed for this call. */
  outputTokens: number;
  /** Monetary cost in USD for this single call. */
  costUsd: number;
  /**
   * The gateway's `choices[0].finish_reason` when reported ('stop' | 'length' |
   * 'content_filter' | …), else undefined. 'length' means the model hit its
   * token budget mid-generation — used to distinguish an answerless truncation
   * from an ordinary parse failure (the original reasoning-response parsing work).
   */
  finishReason?: string;
}

/**
 * Every token a model call billed: uncached input, cache reads and output
 * (issue #156). The one sum the budgets and station usage use, so a cache
 * split cannot change a total.
 */
export function modelResponseTokens(response: ModelResponse): number {
  return response.inputTokens + (response.cacheReadInputTokens ?? 0) + response.outputTokens;
}

/**
 * The per-model adapter interface.  The kernel supplies a concrete
 * implementation at runtime; tests inject a stub.
 */
export interface ModelAdapter {
  call(req: ModelCall): Promise<ModelResponse>;
}
