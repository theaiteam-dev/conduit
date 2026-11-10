/**
 * Real OpenAI-compatible model adapter (LiteLLM gateway) + doctor probe (WI-354).
 *
 * FR-6 / NFR-5 / NFR-6.
 *
 * This is the concrete ModelAdapter that sits behind the kernel adapter seam
 * (src/worker/adapter.ts). It speaks the OpenAI chat/completions wire protocol
 * against one configurable gateway (LiteLLM by default), returns real token
 * counts + gateway-reported cost, and reads credentials from the environment
 * ONLY at call time — so `--help`, `doctor`, and fail-closed validation all
 * run without a key being present.
 *
 * CLI wiring (replacing buildLazyModelAdapter() in src/cli/main.ts) lands in
 * WI-357 — this module stays standalone and injectable.
 *
 * NFR-5 secret hygiene invariants:
 *   - The API key is NEVER included in a returned ModelResponse.
 *   - The API key is NEVER in any thrown Error (message or stack).
 *   - The API key is NEVER logged (no console.* calls anywhere).
 *   - Only allow-listed inference params are forwarded in the request body;
 *     non-allowlisted keys (e.g. a stray `api_key`) are silently dropped.
 *
 * NFR-6 cost invariant:
 *   - costUsd is the explicit Number() of the gateway's
 *     `x-litellm-response-cost` response header, or 0 when the header is
 *     absent. It is never a silent guess.
 */

import type { ModelAdapter, ModelCall, ModelResponse } from './adapter';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Injection points for testability. All four have safe production defaults. */
export interface OpenAiAdapterConfig {
  /** HTTP transport. Defaults to globalThis.fetch. */
  fetchFn?: typeof fetch;
  /** Environment variable reader. Defaults to process.env (by reference). */
  env?: Record<string, string | undefined>;
  /** Monotonic clock returning milliseconds. Defaults to Date.now. */
  now?: () => number;
  /**
   * Async sleep function. Defaults to a real setTimeout-backed promise.
   * Injected in tests to avoid multi-second waits and to assert on delay values.
   */
  sleepFn?: (ms: number) => Promise<void>;
}

/** Structured result from the doctor gateway probe. */
export interface GatewayDoctorResult {
  /** True when the (non-billed) reachability ping succeeded. */
  reachable: boolean;
  /** now() AFTER the ping minus now() BEFORE it, in milliseconds. */
  latency_ms: number;
  /** Whether CONDUIT_API_KEY or OPENAI_API_KEY is set in the environment. */
  hasApiKey: boolean;
  /** Value of CONDUIT_BASE_URL, or undefined when unset. */
  baseUrl: string | undefined;
}

// ---------------------------------------------------------------------------
// Allowlist for inference parameters forwarded to the gateway (NFR-5).
// Everything NOT on this list is silently dropped from the request body so
// that a stray `api_key` or similar cannot be forwarded to the gateway.
// ---------------------------------------------------------------------------

const ALLOWED_INFERENCE_PARAMS: ReadonlySet<string> = new Set([
  'temperature',
  'max_tokens',
  // Reasoning-model budget controls (the original reasoning-budget work). `reasoning_effort`
  // ('minimal'|'low'|'medium'|'high') bounds how much a reasoning model
  // "thinks", so a truncation-prone prompt can leave enough of the token
  // budget for the actual answer. `max_completion_tokens` is the reasoning-era
  // successor to `max_tokens` (o-series / gpt-5 reject `max_tokens` and budget
  // reasoning+output together under this key). Values pass through for the
  // gateway to validate, exactly like temperature/response_format.
  'reasoning_effort',
  'max_completion_tokens',
  'top_p',
  'frequency_penalty',
  'presence_penalty',
  'n',
  'stop',
  'stream',
  'logprobs',
  'top_logprobs',
  'seed',
  'response_format',
  'tools',
  'tool_choice',
  'user',
]);

/**
 * Transient gateway HTTP statuses that warrant a bounded retry (in addition to
 * 429). A 502/503/504 is an overloaded/unreachable upstream that typically
 * clears on its own; a 404 (unknown model) or 401 (auth) does NOT, so those are
 * surfaced immediately rather than retried.
 */
const TRANSIENT_RETRY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

/** Max retry attempts for a transient (429 / 5xx / stalled) response before giving up. */
const MAX_TRANSIENT_RETRIES = 3;

/**
 * Length cap (chars) for a gateway error body/message folded into a thrown
 * Error (the original gateway-error surfacing work) — a misbehaving upstream can return a multi-KB HTML error
 * page, and the thrown message must stay terse, not bloat with it.
 */
const MAX_GATEWAY_ERROR_BODY_CHARS = 500;

/**
 * Explicit engine-default per-call wall-clock timeout, applied when a station
 * declares no `timeout_seconds` (the original transform-timeout work).
 *
 * Two things this fixes:
 *  1. "Unbounded" was never unbounded — Bun's `fetch` has a hidden ~300s default
 *     that aborted with a `TimeoutError`, and the operator-facing message then
 *     interpolated a config value that was never set (`undefinedms`). We now own
 *     the bound explicitly, name its source, and never print `undefinedms`.
 *  2. Keeping the bound honest (rather than truly unbounded via `timeout:false`
 *     with no signal) means a genuinely-stuck call still aborts and is caught by
 *     the bounded timeout-retry below — a hung call is an *active* worker the
 *     liveness watchdog never trips on, so an unbounded call would hang forever.
 *
 * Set to 300s to preserve Bun's prior de-facto per-attempt ceiling; the real
 * safety net for the reported slow-prefill stalls is the retry, not this value.
 */
const DEFAULT_GATEWAY_TIMEOUT_MS = 300_000;

/**
 * Comma-separated env override for local OpenAI-compatible servers whose
 * structured error code/type is provider-specific. Values are normalized before
 * comparison (`ollama-image-disabled` and `ollama_image_disabled` are equal).
 */
const VISION_UNSUPPORTED_ERROR_CODES_ENV = 'CONDUIT_VISION_UNSUPPORTED_ERROR_CODES';

/**
 * Structured error codes/types observed across OpenAI-compatible gateways when
 * an image-bearing request reaches a text-only/non-vision model. These are used
 * before any prose matching, so local servers do not have to phrase errors like
 * frontier providers.
 */
const DEFAULT_VISION_UNSUPPORTED_ERROR_CODES: ReadonlySet<string> = new Set([
  'unsupported_content',
  'unsupported_content_type',
  'unsupported_image',
  'unsupported_image_input',
  'unsupported_images',
  'image_input_unsupported',
  'image_inputs_unsupported',
  'image_unsupported',
  'images_unsupported',
  'vision_unsupported',
  'vision_not_supported',
  'multimodal_unsupported',
  'multimodal_input_unsupported',
  'unsupported_multimodal',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the API key from an env map.
 * CONDUIT_API_KEY takes priority; OPENAI_API_KEY is the fallback.
 * Returns undefined when neither is set.
 */
function resolveApiKey(env: Record<string, string | undefined>): string | undefined {
  return env['CONDUIT_API_KEY'] ?? env['OPENAI_API_KEY'];
}

/**
 * Filter `params` to only the allow-listed inference keys.
 * Prevents non-allowlisted keys (including `api_key`) from reaching the wire.
 */
function filterAllowedParams(params: Record<string, unknown>): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (ALLOWED_INFERENCE_PARAMS.has(key)) {
      filtered[key] = value;
    }
  }
  return filtered;
}

/** Normalize provider error codes/types for stable exact matching. */
function normalizeErrorToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function configuredVisionUnsupportedCodes(env: Record<string, string | undefined>): Set<string> {
  const configured = new Set(DEFAULT_VISION_UNSUPPORTED_ERROR_CODES);
  const raw = env[VISION_UNSUPPORTED_ERROR_CODES_ENV] ?? '';
  for (const token of raw.split(',')) {
    const normalized = normalizeErrorToken(token);
    if (normalized.length > 0) configured.add(normalized);
  }
  return configured;
}

const STRUCTURED_ERROR_KEYS: ReadonlySet<string> = new Set([
  'code',
  'error_code',
  'errorCode',
  'type',
  'error_type',
  'errorType',
  'reason',
  'kind',
]);

const ERROR_MESSAGE_KEYS: ReadonlySet<string> = new Set([
  'message',
  'msg',
  'detail',
  'error',
]);

function collectStringFields(
  value: unknown,
  keys: ReadonlySet<string>,
  out: string[] = [],
  depth = 0,
): string[] {
  if (depth > 6 || value == null) return out;
  if (typeof value === 'string') {
    if (keys.has('*')) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringFields(item, keys, out, depth + 1);
    return out;
  }
  if (typeof value !== 'object') return out;

  for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
    if (typeof field === 'string' && keys.has(key)) out.push(field);
    collectStringFields(field, keys, out, depth + 1);
  }
  return out;
}

function structuredTokenIndicatesVisionUnsupported(token: string, configuredCodes: Set<string>): boolean {
  const normalized = normalizeErrorToken(token);
  if (configuredCodes.has(normalized)) return true;

  const mentionsVisionInput =
    /(?:^|_)(?:image|images|vision|multimodal)(?:_|$)/.test(normalized);
  const saysUnsupported =
    /(?:^|_)unsupported(?:_|$)/.test(normalized) ||
    /(?:^|_)not_supported(?:_|$)/.test(normalized) ||
    /(?:^|_)not_implemented(?:_|$)/.test(normalized);

  return mentionsVisionInput && saysUnsupported;
}

function messageIndicatesVisionUnsupported(message: string): boolean {
  // Concept-level match: the model CANNOT HANDLE IMAGE INPUT at all.
  //
  // Keep these anchors narrow. Bare "image"/"vision" keywords false-trigger on
  // ordinary local server errors like image size, image_url parameter shape,
  // processing tier, or hardware failures.
  return (
    /does not support image inputs?/i.test(message) ||
    /image inputs? (?:is|are) not supported/i.test(message) ||
    /vision is not (?:available|supported)/i.test(message) ||
    /multimodal inputs? (?:is|are) not supported/i.test(message)
  );
}

async function parseGatewayErrorBody(response: Response): Promise<unknown> {
  let text = '';
  try {
    text = await response.text();
  } catch {
    return undefined;
  }

  if (text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * Reduce a parsed gateway error body to a terse, human-readable summary for
 * inclusion in the thrown Error (the original gateway-error surfacing work: the real cause, e.g. "context
 * length exceeded: 200k vs 131k window", was being discarded). Prefers a
 * message-shaped field (`error.message` / `message` / `error` string) over
 * the raw JSON so the common case reads cleanly; falls back to a capped JSON
 * stringification of the whole body, and to `undefined` if the body is
 * empty/unparseable — the caller then falls back to just the status.
 *
 * NFR-5: the API key must NEVER appear in a thrown Error — some gateways
 * echo request context (including the Authorization header) back into error
 * bodies, so the key is redacted here before the message is capped, not after.
 */
function describeGatewayErrorBody(body: unknown, apiKey: string): string | undefined {
  let text: string;
  if (typeof body === 'string') {
    text = body;
  } else if (body != null && typeof body === 'object') {
    const obj = body as { error?: unknown; message?: unknown };
    const nestedMessage =
      obj.error != null && typeof obj.error === 'object'
        ? (obj.error as { message?: unknown }).message
        : undefined;
    if (typeof nestedMessage === 'string') {
      text = nestedMessage;
    } else if (typeof obj.error === 'string') {
      text = obj.error;
    } else if (typeof obj.message === 'string') {
      text = obj.message;
    } else {
      try {
        text = JSON.stringify(body);
      } catch {
        return undefined;
      }
    }
  } else {
    return undefined;
  }

  const redacted = apiKey ? text.replaceAll(apiKey, '[REDACTED]') : text;
  const trimmed = redacted.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > MAX_GATEWAY_ERROR_BODY_CHARS
    ? `${trimmed.slice(0, MAX_GATEWAY_ERROR_BODY_CHARS)}…`
    : trimmed;
}

function isVisionUnsupportedGatewayError(
  body: unknown,
  env: Record<string, string | undefined>,
): boolean {
  const configuredCodes = configuredVisionUnsupportedCodes(env);
  const structuredValues = collectStringFields(body, STRUCTURED_ERROR_KEYS);
  if (structuredValues.some((value) => structuredTokenIndicatesVisionUnsupported(value, configuredCodes))) {
    return true;
  }

  const messageValues = typeof body === 'string'
    ? [body]
    : collectStringFields(body, ERROR_MESSAGE_KEYS);
  return messageValues.some(messageIndicatesVisionUnsupported);
}

function makeVisionUnsupportedError(): Error & { code: 'vision-unsupported' } {
  return Object.assign(
    new Error('Model does not support image input (vision-unsupported)'),
    { code: 'vision-unsupported' } as const,
  );
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Backoff (in ms) before retrying a transient HTTP response. A 429 prefers the
 * `Retry-After` header, then a body `retryDelay` field, then a 15s floor, all
 * capped at 60s; a transient 5xx uses exponential backoff (2s, 4s, 8s…) capped
 * at 30s. A fixed +2s pad is added so the upstream has settled before re-send.
 *
 * Reads `response.json()` on the 429 path — safe because the caller discards
 * this response and re-fetches on the next loop iteration.
 */
async function transientStatusDelayMs(response: Response, attempt: number): Promise<number> {
  let delaySecs: number;
  if (response.status === 429) {
    delaySecs = Number(response.headers.get('retry-after') ?? NaN);
    if (!Number.isFinite(delaySecs)) {
      try {
        const errBody = (await response.json()) as { error?: { details?: Array<{ retryDelay?: string }> } };
        const detail = errBody.error?.details?.find((d) => d.retryDelay);
        if (detail?.retryDelay) delaySecs = parseInt(detail.retryDelay, 10);
      } catch {
        /* ignore parse errors */
      }
    }
    if (!Number.isFinite(delaySecs) || delaySecs < 1) delaySecs = 15;
    delaySecs = Math.min(delaySecs, 60);
  } else {
    delaySecs = Math.min(2 ** (attempt + 1), 30);
  }
  return (delaySecs + 2) * 1000;
}

/**
 * Create a ModelAdapter that speaks the OpenAI chat/completions protocol
 * against a configurable gateway (LiteLLM by default).
 *
 * Credentials (base URL, API key) are read from `env` at each call() invocation,
 * not at construction time — so constructing without a key never throws.
 *
 * @param config - Optional injection points (transport, env, clock).
 */
export function createOpenAiAdapter(config?: OpenAiAdapterConfig): ModelAdapter {
  const fetchFn = config?.fetchFn ?? globalThis.fetch;
  const env = config?.env ?? process.env;
  const sleepFn = config?.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  return { call: (req) => executeModelCall(req, fetchFn, env, sleepFn) };
}

/**
 * Execute a model call against the OpenAI-compatible gateway.
 * Reads credentials from `env` at call time (not captured at construction).
 */
async function executeModelCall(
  req: ModelCall,
  fetchFn: typeof fetch,
  env: Record<string, string | undefined>,
  sleepFn: (ms: number) => Promise<void>,
): Promise<ModelResponse> {
  // ── Credential guard (before any network I/O) ─────────────────────────────
  const apiKey = resolveApiKey(env);
  if (!apiKey) {
    throw new Error('No model API key configured — set CONDUIT_API_KEY or OPENAI_API_KEY');
  }

  const baseUrl = env['CONDUIT_BASE_URL'];
  const endpoint = `${baseUrl}/chat/completions`;

  // ── Build request body ────────────────────────────────────────────────────
  // When images are present, the user message uses the OpenAI content-parts
  // shape: a text part followed by one image_url part per declared image, in
  // declared order (FR-3). Each image_url carries a data URI built from the
  // detected media type and base64-encoded raw bytes.
  //
  // When no images (or empty list), keep today's exact legacy string-content
  // shape — `content` is a plain string, not an array (NFR-1: byte-for-byte
  // identical to pre-WI-415 text-only calls).
  //
  // The body is assembled ONCE here so the 429/5xx bounded-retry loop below
  // re-sends the identical payload without rebuilding it on each attempt.
  //
  // Memory note: each image is base64-encoded fully in memory (no streaming).
  // Peak transient spike per call is bounded by the load-time guards —
  // MAX_IMAGE_INPUTS_PER_CALL × MAX_IMAGE_BYTES (× ~4/3 for base64). Acceptable
  // at current limits; revisit with a streaming/multipart body if those grow.
  const userMessageContent =
    req.images != null && req.images.length > 0
      ? [
          { type: 'text', text: req.prompt },
          ...req.images.map((img) => ({
            type: 'image_url',
            image_url: {
              url: `data:${img.mediaType};base64,${Buffer.from(img.bytes).toString('base64')}`,
            },
          })),
        ]
      : req.prompt;

  const body = JSON.stringify({
    model: req.model,
    messages: [{ role: 'user', content: userMessageContent }],
    ...filterAllowedParams(req.params),
  });

  // ── Per-call wall-clock timeout (punch-list #8 + the original transform-timeout work) ───────────────
  // Bun's `fetch` has a hidden ~300s default timeout. To make the bound honest
  // and actually configurable, we take sole ownership of it:
  //   • a FRESH AbortSignal.timeout is minted per fetch attempt (never shared,
  //     so the retry backoff sleeps below do not consume the next attempt's
  //     budget);
  //   • we pass Bun's non-standard `timeout: false` so its hidden default never
  //     fires first — without it, our signal can only *shorten* below ~300s,
  //     never lengthen, so a station's `timeout_seconds > 300` was silently
  //     ignored (measured in transform-timeout work). `timeout: false` is inert under the standard
  //     RequestInit used in tests (an unknown extra field) and real only on Bun.
  // Absent `timeout_seconds` → the explicit engine default, NOT Bun's hidden one
  // (so the error below never interpolates `undefinedms` and can name its source).
  const hasStationTimeout = typeof req.timeoutMs === 'number' && req.timeoutMs > 0;
  const effectiveTimeoutMs = hasStationTimeout ? req.timeoutMs! : DEFAULT_GATEWAY_TIMEOUT_MS;
  const timeoutSource = hasStationTimeout ? 'station timeout_seconds' : 'engine default';
  const buildInit = (): RequestInit & { timeout: false } => ({
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // NFR-5: key is used here for the wire, never surfaces in outputs.
      authorization: `Bearer ${apiKey}`,
    },
    body,
    signal: AbortSignal.timeout(effectiveTimeoutMs),
    // Bun-only escape hatch from the hidden 300s default; see note above.
    timeout: false,
  });

  // A fetch aborted by our timeout rejects with a DOMException named
  // 'TimeoutError' (or 'AbortError'). It is the SAME transient failure class as
  // a 429/5xx — a slow-prefill stall usually clears on a retry (transform-timeout work) — so it is
  // retried in the bounded loop below rather than surfaced as a fatal error.
  const isTimeoutAbort = (e: unknown): boolean => {
    const name = (e as { name?: string } | null)?.name;
    return name === 'TimeoutError' || name === 'AbortError';
  };

  // ── Network call with bounded retry (429 / transient 5xx / stalled call) ──
  // A single transient gateway event must NOT be a fatal halt: a 429, a
  // 502/503/504 from an overloaded upstream, or a call that stalls past its
  // wall-clock bound are all the same class — retry a bounded number of times
  // with backoff before surfacing. A non-transient status (404 unknown-model,
  // 401 auth) is NOT retried, and a non-timeout transport error (ECONNREFUSED,
  // DNS) is surfaced immediately — neither fixes itself. Each delay is clamped,
  // so the TOTAL sleep is bounded: a misbehaving gateway cannot stall the
  // single-process executor past its andon (the andon is only checked between
  // station calls, not during one). A persistent stall still ends after the
  // bounded retries — worst-case per-station wall-clock rises to about
  // (MAX_TRANSIENT_RETRIES + 1) × the timeout, reconciled by the consumption
  // andon between calls; far better than fatal-ing the run mid-flight (transform-timeout work).
  let response: Response;
  for (let attempt = 0; ; attempt++) {
    const isRetry = attempt > 0;
    let r: Response;
    try {
      r = await fetchFn(endpoint, buildInit());
    } catch (err) {
      if (isTimeoutAbort(err)) {
        if (attempt < MAX_TRANSIENT_RETRIES) {
          // The call already consumed its full timeout budget, so keep the
          // backoff short — the retried call usually lands in the fast part of
          // the latency distribution (transform-timeout work). Same 5xx-style cap for consistency.
          await sleepFn(Math.min(2 ** (attempt + 1), 30) * 1000);
          continue;
        }
        throw new Error(
          `Model gateway call exceeded its ${effectiveTimeoutMs}ms timeout ` +
            `(${timeoutSource}) after ${attempt + 1} attempts`,
        );
      }
      // Transport-level failure (ECONNREFUSED, DNS, etc.) — name the cause but
      // never leak the key. The transport error message may itself contain the
      // key (e.g. "Connection to sk-xxx@host failed") — redact before surfacing.
      const rawCause = err instanceof Error ? err.message : String(err);
      const safeCause = apiKey ? rawCause.replaceAll(apiKey, '[REDACTED]') : rawCause;
      throw new Error(`Model gateway unreachable${isRetry ? ' on retry' : ''}: ${safeCause}`);
    }

    // Retryable HTTP status → back off and re-send the identical payload.
    if (
      attempt < MAX_TRANSIENT_RETRIES &&
      (r.status === 429 || TRANSIENT_RETRY_STATUSES.has(r.status))
    ) {
      await sleepFn(await transientStatusDelayMs(r, attempt));
      continue;
    }

    response = r;
    break;
  }
  if (!response.ok) {
    // ── Vision-unsupported capability-mismatch classification ──────────────
    // Local OpenAI-compatible VLM servers are less consistent than frontier
    // providers: an image-to-text-only-model rejection may be 400, 422, or even
    // a final 500 after retry. Classify only image-bearing calls, and prefer
    // structured error code/type fields before falling back to narrow prose
    // anchors. A generic local failure still fails closed as an HTTP error.
    const errorBody = await parseGatewayErrorBody(response);
    const hasImages = req.images != null && req.images.length > 0;
    if (hasImages && isVisionUnsupportedGatewayError(errorBody, env)) {
      throw makeVisionUnsupportedError();
    }

    // Fold the gateway's own error body into the message (the original gateway-error surfacing work) — the
    // bare status alone ("HTTP 400") hid causes like a context-window overrun
    // that would otherwise take a round-trip to reproduce and inspect.
    const describedBody = describeGatewayErrorBody(errorBody, apiKey);
    throw new Error(
      `Model gateway returned HTTP ${response.status}` + (describedBody ? `: ${describedBody}` : ''),
    );
  }

  // ── Parse response ────────────────────────────────────────────────────────
  // `usage` is typed as optional and its fields as `unknown` because vision
  // gateways may omit the object entirely, return null fields, or return
  // string token counts. The NaN guards below mirror the costUsd pattern and
  // ensure we never propagate NaN/undefined into the returned ModelResponse.
  const data = (await response.json()) as {
    choices?: unknown;
    usage?: {
      prompt_tokens?: unknown;
      completion_tokens?: unknown;
      prompt_tokens_details?: { cached_tokens?: unknown } | null;
    };
  };

  // ── Response shape guard ──────────────────────────────────────────────────
  // The gateway is untrusted: an overloaded/misconfigured upstream can return a
  // 200 with an empty `choices: []`, a choice missing its `message`, or a
  // non-string `content`. Dereferencing those blindly throws an opaque raw
  // `TypeError: Cannot read properties of undefined`. Validate the shape first
  // and surface a clear, terse Error naming which part was malformed — without
  // echoing the raw body (NFR-5 hygiene). This is a GENERIC failure: it is
  // deliberately NOT tagged `vision-unsupported`/`model-incompatible`, so the
  // transform layer treats it as an ordinary (non-fast-scrap) error.
  const choices = data.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error('Model gateway returned a malformed response: empty or missing choices');
  }
  const firstChoice = choices[0] as {
    message?: { content?: unknown; reasoning_content?: unknown };
    finish_reason?: unknown;
  };
  const message = firstChoice.message;
  if (message == null || typeof message !== 'object') {
    throw new Error('Model gateway returned a malformed response: missing choices[0].message');
  }

  // ── Reasoning-model content selection (the original reasoning-response parsing work) ─────────────────────────
  // OpenAI-compatible reasoning models (DeepSeek V4, Qwen reasoning variants)
  // may return their chain-of-thought in `message.reasoning_content` and leave
  // `message.content` empty or absent — putting the actual answer only in
  // reasoning_content. Prefer a usable `content`; fall back to
  // `reasoning_content` when content carries nothing. Extracting the JSON answer
  // out of surrounding CoT prose is the transform layer's job (coerciveParse);
  // the adapter's only job here is to not discard the answer entirely.
  const rawContent = message.content;
  const rawReasoning = message.reasoning_content;
  const usableReasoning =
    typeof rawReasoning === 'string' && rawReasoning.trim() !== '' ? rawReasoning : null;

  let text: string;
  if (typeof rawContent === 'string' && rawContent.trim() !== '') {
    text = rawContent;
  } else if (usableReasoning !== null) {
    text = usableReasoning;
  } else if (typeof rawContent === 'string') {
    // Present-but-empty content with no reasoning fallback is a well-formed (if
    // unhelpful) response: the transform layer treats '' as a parse failure and
    // retries under the attempt cap. Preserves the before reasoning-response parsing empty-string contract.
    text = rawContent;
  } else {
    throw new Error(
      'Model gateway returned a malformed response: non-string choices[0].message.content and no usable reasoning_content',
    );
  }
  const usage = data.usage;

  // NFR-6 (tokens): explicit 0 when usage is absent, a field is missing, or a
  // field coerces to a non-finite number — same discipline as costUsd below.
  // Optional chaining guards against `data.usage` being undefined entirely.
  const promptTokens = Number.isFinite(Number(usage?.prompt_tokens))
    ? Number(usage?.prompt_tokens)
    : 0;
  // Issue #156: the cache-read split. `prompt_tokens` includes cached tokens,
  // so with a usable figure `inputTokens` narrows to uncached input and the
  // two still sum to `prompt_tokens`: budget totals do not move.
  const cacheReadInputTokens = parseCacheReadTokens(usage, response.headers);
  const inputTokens =
    cacheReadInputTokens !== undefined ? promptTokens - cacheReadInputTokens : promptTokens;
  const outputTokens = Number.isFinite(Number(usage?.completion_tokens))
    ? Number(usage?.completion_tokens)
    : 0;

  // NFR-6: explicit 0 when the gateway does not report cost or reports a
  // non-numeric value; never NaN, never a silent guess.
  const costHeader = response.headers.get('x-litellm-response-cost');
  const parsedCost = costHeader !== null ? Number(costHeader) : NaN;
  const costUsd = Number.isFinite(parsedCost) ? parsedCost : 0;

  // finish_reason (the original reasoning-response parsing work): surfaced so the transform layer can tell an
  // answerless TRUNCATION ('length' — the model ran out of token budget while
  // still generating) apart from an ordinary parse failure, and scrap it with a
  // legible reason instead of retrying futilely at the same cap.
  const finishReason =
    typeof firstChoice.finish_reason === 'string' ? firstChoice.finish_reason : undefined;

  // NFR-5: returned value must never contain the key — confirmed by structure
  // (text/tokens/cost/finish_reason only).
  return {
    text,
    inputTokens,
    outputTokens,
    costUsd,
    ...(cacheReadInputTokens !== undefined && { cacheReadInputTokens }),
    ...(finishReason !== undefined && { finishReason }),
  };
}

/** A non-negative integer token count, from a number or a string of digits; else undefined. */
function tokenCount(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const n = Number(value.trim());
    return Number.isSafeInteger(n) ? n : undefined;
  }
  return undefined;
}

/**
 * Issue #156: the cache-read figure a gateway reported, or undefined for no
 * split.
 *
 * Sources, in order:
 *   1. `usage.prompt_tokens_details.cached_tokens` (OpenAI, xAI, LiteLLM).
 *   2. The `fireworks-cached-prompt-tokens` response header, read only when
 *      the body carries no figure (the field absent or null).
 *
 * A figure that is not a non-negative integer, or exceeds `prompt_tokens`
 * (or `prompt_tokens` is itself unusable), records no split rather than a
 * guess (NFR-6). A malformed body figure does not fall back to the header:
 * the body is the source the provider chose, and a header that disagreed
 * with a broken body would be a guess too.
 */
function parseCacheReadTokens(
  usage: { prompt_tokens?: unknown; prompt_tokens_details?: { cached_tokens?: unknown } | null } | undefined,
  headers: Headers,
): number | undefined {
  const bodyFigure = usage?.prompt_tokens_details?.cached_tokens;
  const raw = bodyFigure !== undefined && bodyFigure !== null
    ? bodyFigure
    : headers.get('fireworks-cached-prompt-tokens');
  if (raw === null) return undefined;
  const cached = tokenCount(raw);
  const prompt = tokenCount(usage?.prompt_tokens);
  if (cached === undefined || prompt === undefined || cached > prompt) return undefined;
  return cached;
}

// ---------------------------------------------------------------------------
// Doctor probe
// ---------------------------------------------------------------------------

/**
 * Probe the configured gateway for the doctor prereq check.
 *
 * Contacts a NON-billed endpoint (the models listing) to measure reachability
 * and latency. Never calls chat/completions. Never throws — unreachable returns
 * `reachable: false`.
 *
 * `now()` is called exactly twice: immediately before the fetch and immediately
 * after it resolves (or rejects), so `latency_ms` reflects only network time.
 *
 * @param config - Optional injection points (transport, env, clock).
 */
export async function probeGateway(config?: OpenAiAdapterConfig): Promise<GatewayDoctorResult> {
  const fetchFn = config?.fetchFn ?? globalThis.fetch;
  const env = config?.env ?? process.env;
  const now = config?.now ?? Date.now;

  const apiKey = resolveApiKey(env);
  const baseUrl = env['CONDUIT_BASE_URL'];

  // Probe a non-billed endpoint — /models is standard on LiteLLM / OpenAI.
  const probeUrl = `${baseUrl}/models`;

  const startMs = now();
  let reachable: boolean;
  try {
    await fetchFn(probeUrl);
    reachable = true;
  } catch {
    reachable = false;
  }
  const endMs = now();

  return {
    reachable,
    latency_ms: endMs - startMs,
    hasApiKey: apiKey !== undefined,
    baseUrl,
  };
}
