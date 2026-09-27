/**
 * Ingress binding schema and boot validation (WI-402).
 *
 * Parses a flow's channels.ingress binding into a typed, validated shape.
 * Returns structured errors — never throws — consistent with the
 * config-is-validated principle (Principle 10 / FR-1) and the typed-error
 * style of src/flow/load.ts.
 *
 * Required-field rules:
 *   - webhook : requires `route` AND `auth`
 *   - slack   : two transports (the original Slack Socket Mode work):
 *       transport: 'events' (default) — requires `auth` (request-signing verification)
 *       transport: 'socket'           — requires `app_token_env` (outbound wss;
 *                                       the connection is the auth, so `auth` is optional)
 *   - cli     : requires neither route nor auth (local ingress)
 *   - all     : `event_id` source present and well-formed
 *
 * Stable error codes (pinned by src/ingress/binding.test.ts):
 *   UNKNOWN_INGRESS_TYPE | MISSING_WEBHOOK_ROUTE | MISSING_AUTH |
 *   MISSING_AUTH_SECRET | MISSING_EVENT_ID_SOURCE | INVALID_EVENT_ID_SOURCE |
 *   INVALID_SUBSTRATE_MAPPING | ROUTE_COLLISION | INVALID_TRANSPORT |
 *   MISSING_APP_TOKEN
 *
 * Subject identity (issue #36, webhook only; pinned by binding-run-key.test.ts):
 *   INVALID_RUN_KEY | RUN_KEY_UNSUPPORTED_TYPE | INVALID_WHEN |
 *   WHEN_UNSUPPORTED_TYPE | INVALID_MAX_PASSES | RESERVED_SUBSTRATE_FIELD
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface IngressValidationError {
  /** Stable machine-readable code for programmatic handling. */
  code: string;
  /** Human-readable description naming the offending entity. */
  message: string;
}

export type EventIdSource =
  | { from: 'header'; name: string }
  | { from: 'json_path'; path: string }
  | { from: 'content_hash' }
  | { from: 'require' }; // strict opt-in — deriver rejects keyless events (D2/FR-8)

export interface IngressAuthConfig {
  type: string;
  [k: string]: unknown;
}

/** Slack delivery mechanism: Events API webhooks vs. an outbound Socket Mode websocket. */
export type SlackTransport = 'events' | 'socket';

/**
 * One part of a run key (issue #36). `json_path` lists alternatives: the first
 * path that resolves to a scalar wins. `header` is matched case-insensitively.
 */
export type RunKeyPart = { json_path: string[] } | { header: string };

/** What a `when` condition reads: exactly one header or one JSON path. */
export type WhenSubject = { header: string } | { json_path: string };

/**
 * What a `when` condition tests. `in`/`not_in` values are stored as strings,
 * since the resolved scalar is compared as a string.
 */
export type WhenTest = { in: string[] } | { not_in: string[] } | { present: boolean };

export type WhenCondition = WhenSubject & WhenTest;

export interface IngressBinding {
  type: 'webhook' | 'slack' | 'cli';
  /** Present for webhook bindings only. */
  route?: string;
  /** Required for webhook and events-transport slack; absent for cli and socket-transport slack. */
  auth?: IngressAuthConfig;
  /** Event-id extraction strategy — required for every binding type. */
  event_id: EventIdSource;
  /** Optional JSON-path projection mapping for substrate envelope construction. */
  substrate?: Record<string, string>;
  /**
   * Slack-only (the original Slack Socket Mode work): how Slack delivers events. 'events' (the default when
   * absent) is the Events API webhook; 'socket' is Socket Mode — the listener
   * opens an outbound wss connection and needs zero inbound reachability.
   */
  transport?: SlackTransport;
  /**
   * Slack socket transport only: name of the env var holding the app-level token
   * (`xapp-…`, scope connections:write) used for apps.connections.open.
   */
  app_token_env?: string;
  /**
   * Webhook only (issue #36): the ordered parts that identify the external
   * subject this event belongs to. Events with the same key are passes of one
   * run instead of one run each. Absent keeps the per-delivery run id.
   */
  run_key?: RunKeyPart[];
  /**
   * Webhook only (issue #36): conditions, all ANDed, an event must meet to be
   * accepted. A non-matching event is acked and logged 'filtered'.
   */
  when?: WhenCondition[];
  /** Webhook only, requires run_key (issue #36): the most passes a keyed run is admitted. */
  max_passes?: number;
}

export interface FlowIngressDeclaration {
  flow: string;
  ingress: unknown;
}

export type ParseIngressBindingResult =
  | { ok: true; binding: IngressBinding }
  | { ok: false; error: IngressValidationError };

export type ValidateIngressBindingsResult =
  | { ok: true }
  | { ok: false; errors: IngressValidationError[] };

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const VALID_INGRESS_TYPES = ['webhook', 'slack', 'cli'] as const;
const VALID_EVENT_ID_FROM = ['header', 'json_path', 'content_hash', 'require'] as const;
const VALID_SLACK_TRANSPORTS = ['events', 'socket'] as const;

/**
 * Substrate fields the listener stamps onto a keyed event's substrate at
 * launch (issue #36). A keyed binding's projection may not claim them.
 */
const RESERVED_KEYED_SUBSTRATE_FIELDS = ['run_key', 'pass', 'events', 'events_truncated'] as const;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function makeError(code: string, message: string): IngressValidationError {
  return { code, message };
}

function parseFailure(code: string, message: string): ParseIngressBindingResult {
  return { ok: false, error: makeError(code, message) };
}

/**
 * Parse and validate the event_id source object.
 * Returns the typed EventIdSource on success, or an IngressValidationError on failure.
 * Never throws.
 */
function parseEventIdSource(raw: unknown): EventIdSource | IngressValidationError {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return makeError(
      'INVALID_EVENT_ID_SOURCE',
      `event_id source must be an object with a valid \`from\` field, got ${
        raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw
      }`,
    );
  }

  const r = raw as Record<string, unknown>;
  const from = r['from'];

  if (!(VALID_EVENT_ID_FROM as readonly unknown[]).includes(from)) {
    return makeError(
      'INVALID_EVENT_ID_SOURCE',
      `event_id has unknown \`from\` kind '${String(from)}' — must be one of: ${VALID_EVENT_ID_FROM.join(', ')}`,
    );
  }

  switch (from) {
    case 'header': {
      if (typeof r['name'] !== 'string') {
        return makeError(
          'INVALID_EVENT_ID_SOURCE',
          `event_id {from: 'header'} requires a \`name\` string field`,
        );
      }
      return { from: 'header', name: r['name'] };
    }
    case 'json_path': {
      if (typeof r['path'] !== 'string') {
        return makeError(
          'INVALID_EVENT_ID_SOURCE',
          `event_id {from: 'json_path'} requires a \`path\` string field`,
        );
      }
      return { from: 'json_path', path: r['path'] };
    }
    case 'content_hash':
      return { from: 'content_hash' };
    case 'require':
      return { from: 'require' };
    default:
      // Unreachable: the guard above returns early for unknown `from` values.
      // This default satisfies TypeScript's exhaustive-return check.
      return makeError(
        'INVALID_EVENT_ID_SOURCE',
        `Unhandled event_id from kind: ${String(from)}`,
      );
  }
}

function isValidationError(
  result: EventIdSource | IngressValidationError,
): result is IngressValidationError {
  return 'code' in result;
}

type SubstrateResult =
  | { ok: true; value: Record<string, string> }
  | { ok: false; error: IngressValidationError };

/**
 * Parse and validate the substrate JSON-path projection mapping.
 * Returns a discriminated result — never throws.
 */
function parseSubstrate(raw: unknown): SubstrateResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      error: makeError(
        'INVALID_SUBSTRATE_MAPPING',
        `substrate must be a JSON-path projection object (Record<string, string>), got ${
          raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw
        }`,
      ),
    };
  }

  const r = raw as Record<string, unknown>;
  for (const [key, value] of Object.entries(r)) {
    if (typeof value !== 'string') {
      return {
        ok: false,
        error: makeError(
          'INVALID_SUBSTRATE_MAPPING',
          `substrate.${key} must be a JSON-path string but got ${typeof value}`,
        ),
      };
    }
  }

  return { ok: true, value: r as Record<string, string> };
}

function describeType(raw: unknown): string {
  return raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw;
}

function isPlainObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw);
}

/** A path the shared resolver can answer: resolveJsonPath returns null for any other. */
function isRootedJsonPath(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.startsWith('$.') && raw.length > 2;
}

function isNonEmptyString(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.trim() !== '';
}

/**
 * Parse `run_key` (issue #36): a non-empty list of parts, each naming exactly
 * one of `json_path` (a rooted path, or a non-empty list of rooted
 * alternatives) or `header` (a non-empty name). Normalizes a single path to a
 * one-element alternatives list.
 */
function parseRunKey(raw: unknown): RunKeyPart[] | IngressValidationError {
  const fail = (detail: string): IngressValidationError =>
    makeError('INVALID_RUN_KEY', `run_key ${detail}`);
  if (!Array.isArray(raw)) return fail(`must be a list of parts, got ${describeType(raw)}`);
  if (raw.length === 0) return fail('must name at least one part');

  const parts: RunKeyPart[] = [];
  for (const [index, part] of raw.entries()) {
    if (!isPlainObject(part)) {
      return fail(`part ${index} must be an object, got ${describeType(part)}`);
    }
    const keys = Object.keys(part);
    const unknown = keys.filter((k) => k !== 'json_path' && k !== 'header');
    if (unknown.length > 0) return fail(`part ${index} has unknown field(s): ${unknown.join(', ')}`);
    if (keys.length !== 1) {
      return fail(`part ${index} must name exactly one of 'json_path' or 'header'`);
    }
    if ('header' in part) {
      if (!isNonEmptyString(part['header'])) {
        return fail(`part ${index} 'header' must be a non-empty string`);
      }
      parts.push({ header: part['header'] });
      continue;
    }
    const paths = Array.isArray(part['json_path']) ? part['json_path'] : [part['json_path']];
    if (paths.length === 0) return fail(`part ${index} 'json_path' alternatives must not be empty`);
    for (const path of paths) {
      if (!isRootedJsonPath(path)) {
        return fail(`part ${index} 'json_path' entries must be strings rooted at '$.', got ${JSON.stringify(path)}`);
      }
    }
    parts.push({ json_path: paths as string[] });
  }
  return parts;
}

const WHEN_SUBJECTS = ['header', 'json_path'] as const;
const WHEN_TESTS = ['in', 'not_in', 'present'] as const;

/**
 * Parse `when` (issue #36): a non-empty list of conditions. Each names exactly
 * one subject (`header` or `json_path`) and exactly one test (`in`, `not_in`,
 * or `present`). `in`/`not_in` take a non-empty list of scalars, stored as
 * strings because the resolved value is compared as a string.
 */
function parseWhen(raw: unknown): WhenCondition[] | IngressValidationError {
  const fail = (detail: string): IngressValidationError =>
    makeError('INVALID_WHEN', `when ${detail}`);
  if (!Array.isArray(raw)) return fail(`must be a list of conditions, got ${describeType(raw)}`);
  if (raw.length === 0) return fail('must name at least one condition');

  const conditions: WhenCondition[] = [];
  for (const [index, cond] of raw.entries()) {
    if (!isPlainObject(cond)) {
      return fail(`condition ${index} must be an object, got ${describeType(cond)}`);
    }
    const keys = Object.keys(cond);
    const known: readonly string[] = [...WHEN_SUBJECTS, ...WHEN_TESTS];
    const unknown = keys.filter((k) => !known.includes(k));
    if (unknown.length > 0) {
      return fail(`condition ${index} has unknown field(s): ${unknown.join(', ')}`);
    }
    const subjects = keys.filter((k) => (WHEN_SUBJECTS as readonly string[]).includes(k));
    const tests = keys.filter((k) => (WHEN_TESTS as readonly string[]).includes(k));
    if (subjects.length !== 1) {
      return fail(`condition ${index} must name exactly one of 'header' or 'json_path'`);
    }
    if (tests.length !== 1) {
      return fail(`condition ${index} must name exactly one of 'in', 'not_in' or 'present'`);
    }

    let subject: WhenSubject;
    if (subjects[0] === 'header') {
      if (!isNonEmptyString(cond['header'])) {
        return fail(`condition ${index} 'header' must be a non-empty string`);
      }
      subject = { header: cond['header'] };
    } else {
      if (!isRootedJsonPath(cond['json_path'])) {
        return fail(`condition ${index} 'json_path' must be a string rooted at '$.'`);
      }
      subject = { json_path: cond['json_path'] };
    }

    const testName = tests[0]!;
    let test: WhenTest;
    if (testName === 'present') {
      if (typeof cond['present'] !== 'boolean') {
        return fail(`condition ${index} 'present' must be true or false`);
      }
      test = { present: cond['present'] };
    } else {
      const values = cond[testName];
      if (!Array.isArray(values) || values.length === 0) {
        return fail(`condition ${index} '${testName}' must be a non-empty list`);
      }
      const strings: string[] = [];
      for (const value of values) {
        if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
          return fail(`condition ${index} '${testName}' values must be strings, numbers or booleans`);
        }
        strings.push(String(value));
      }
      test = testName === 'in' ? { in: strings } : { not_in: strings };
    }
    conditions.push({ ...subject, ...test } as WhenCondition);
  }
  return conditions;
}

/**
 * Parse an auth config object from the raw binding.
 * Returns the typed IngressAuthConfig if valid, or undefined if absent or malformed.
 * Auth shape errors surface through MISSING_AUTH in validateIngressBindings.
 */
function parseAuthConfig(raw: unknown): IngressAuthConfig | undefined {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    Array.isArray(raw)
  ) {
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  if (typeof r['type'] !== 'string') {
    return undefined;
  }
  return r as IngressAuthConfig;
}

/**
 * Validate that an auth config carries the secret reference its `type` requires.
 *
 * Boot-time enforcement closes the gap where a binding like `{ type: 'hmac' }`
 * (no `secret_env`) parses as a "valid" auth shape, then resolves `secret = ''`
 * at runtime and silently fail-closes ALL traffic. Webhook HMAC/bearer auth must
 * name a non-empty `secret_env` so the listener can resolve a real secret.
 *
 * Slack request-signing auth (`type: 'signing'`) is exempt: the listener verifies
 * with the app-global `slackSigningSecret` (config.slackSigningSecret /
 * CONDUIT_SLACK_SIGNING_SECRET), not a per-binding secret_env — its absence is
 * surfaced separately at listener boot.
 *
 * Returns an IngressValidationError if the required field is missing, else null.
 */
function validateAuthSecret(
  flow: string,
  bindingType: IngressBinding['type'],
  auth: IngressAuthConfig,
): IngressValidationError | null {
  const authType = auth.type;

  // Slack signing auth uses the app-global signing secret, not a per-binding one.
  if (authType === 'signing' || authType === 'slack-signature') {
    return null;
  }

  // Auth types that authenticate with a per-binding shared secret must name the
  // env var that resolves it. 'none' (if ever used) requires no secret.
  if (authType === 'none') {
    return null;
  }

  const secretEnv = auth['secret_env'];
  if (typeof secretEnv !== 'string' || secretEnv.trim() === '') {
    return makeError(
      'MISSING_AUTH_SECRET',
      `Flow '${flow}' declares a ${bindingType} ingress binding with auth type ` +
        `'${authType}' but is missing the required non-empty 'secret_env' field — ` +
        `without it the secret resolves to '' at runtime and silently rejects all traffic`,
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

/**
 * Parse a raw (unknown) channels.ingress value into a typed IngressBinding.
 *
 * Returns {ok: true, binding} on success or {ok: false, error} on any
 * validation failure. NEVER throws — not even on null / non-object input.
 */
export function parseIngressBinding(raw: unknown): ParseIngressBindingResult {
  // Guard: must be a plain object
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return parseFailure(
      'UNKNOWN_INGRESS_TYPE',
      `Ingress binding must be a plain object, got ${
        raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw
      }`,
    );
  }

  const r = raw as Record<string, unknown>;
  const type = r['type'];

  // Validate binding type
  if (!(VALID_INGRESS_TYPES as readonly unknown[]).includes(type)) {
    return parseFailure(
      'UNKNOWN_INGRESS_TYPE',
      `Unknown ingress type '${String(type)}' — must be one of: ${VALID_INGRESS_TYPES.join(', ')}`,
    );
  }

  const validType = type as 'webhook' | 'slack' | 'cli';

  // Validate event_id — required for every binding type
  const rawEventId = r['event_id'];
  if (rawEventId === undefined) {
    return parseFailure(
      'MISSING_EVENT_ID_SOURCE',
      `Ingress binding of type '${validType}' is missing the required 'event_id' field`,
    );
  }

  const eventIdResult = parseEventIdSource(rawEventId);
  if (isValidationError(eventIdResult)) {
    return { ok: false, error: eventIdResult };
  }

  // Validate substrate — optional, but if present must be a string-valued projection
  let substrate: Record<string, string> | undefined;
  if (r['substrate'] !== undefined) {
    const substrateResult = parseSubstrate(r['substrate']);
    if (!substrateResult.ok) {
      return { ok: false, error: substrateResult.error };
    }
    substrate = substrateResult.value;
  }

  // Validate transport — slack-only, and only the two known values (the original Slack Socket Mode work)
  let transport: SlackTransport | undefined;
  if (r['transport'] !== undefined) {
    if (validType !== 'slack') {
      return parseFailure(
        'INVALID_TRANSPORT',
        `'transport' is only legal on slack bindings, but this binding has type '${validType}'`,
      );
    }
    if (!(VALID_SLACK_TRANSPORTS as readonly unknown[]).includes(r['transport'])) {
      return parseFailure(
        'INVALID_TRANSPORT',
        `Unknown slack transport '${String(r['transport'])}' — must be one of: ${VALID_SLACK_TRANSPORTS.join(', ')}`,
      );
    }
    transport = r['transport'] as SlackTransport;
  }

  // Validate app_token_env — legal only on socket-transport slack bindings
  let appTokenEnv: string | undefined;
  if (r['app_token_env'] !== undefined) {
    if (validType !== 'slack' || transport !== 'socket') {
      return parseFailure(
        'INVALID_TRANSPORT',
        `'app_token_env' is only legal on slack bindings with transport: 'socket' — ` +
          `this binding is ${validType === 'slack' ? `transport '${transport ?? 'events'}'` : `type '${validType}'`}`,
      );
    }
    if (typeof r['app_token_env'] !== 'string' || r['app_token_env'].trim() === '') {
      return parseFailure(
        'MISSING_APP_TOKEN',
        `'app_token_env' must be a non-empty env-var name string, got ${
          typeof r['app_token_env'] === 'string' ? 'an empty string' : typeof r['app_token_env']
        }`,
      );
    }
    appTokenEnv = r['app_token_env'];
  }

  // Subject identity (issue #36): run_key, when and max_passes are webhook-only
  // in this change. A slack or cli binding naming one fails with its own code
  // rather than booting with the field silently ignored.
  let runKey: RunKeyPart[] | undefined;
  if (r['run_key'] !== undefined) {
    if (validType !== 'webhook') {
      return parseFailure(
        'RUN_KEY_UNSUPPORTED_TYPE',
        `'run_key' is only supported on webhook bindings, but this binding has type '${validType}'`,
      );
    }
    const parsed = parseRunKey(r['run_key']);
    if (!Array.isArray(parsed)) return { ok: false, error: parsed };
    runKey = parsed;
  }

  let when: WhenCondition[] | undefined;
  if (r['when'] !== undefined) {
    if (validType !== 'webhook') {
      return parseFailure(
        'WHEN_UNSUPPORTED_TYPE',
        `'when' is only supported on webhook bindings, but this binding has type '${validType}'`,
      );
    }
    const parsed = parseWhen(r['when']);
    if (!Array.isArray(parsed)) return { ok: false, error: parsed };
    when = parsed;
  }

  let maxPasses: number | undefined;
  if (r['max_passes'] !== undefined) {
    const value = r['max_passes'];
    if (validType !== 'webhook' || runKey === undefined) {
      return parseFailure(
        'INVALID_MAX_PASSES',
        `'max_passes' is only legal on a webhook binding that declares 'run_key'`,
      );
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      return parseFailure(
        'INVALID_MAX_PASSES',
        `'max_passes' must be a positive integer, got ${JSON.stringify(value)}`,
      );
    }
    maxPasses = value;
  }

  if (runKey !== undefined && substrate !== undefined) {
    const reserved = RESERVED_KEYED_SUBSTRATE_FIELDS.filter((name) => name in substrate!);
    if (reserved.length > 0) {
      return parseFailure(
        'RESERVED_SUBSTRATE_FIELD',
        `substrate field(s) ${reserved.join(', ')} are reserved on a keyed binding: ` +
          `the listener stamps them onto every keyed pass`,
      );
    }
  }

  // Parse optional route (permissive here — type-specific requirement enforced by validateIngressBindings)
  const route = typeof r['route'] === 'string' ? r['route'] : undefined;

  // Parse optional auth (permissive here — type-specific requirement enforced by validateIngressBindings)
  const auth = parseAuthConfig(r['auth']);

  const binding: IngressBinding = {
    type: validType,
    event_id: eventIdResult,
    ...(route !== undefined && { route }),
    ...(auth !== undefined && { auth }),
    ...(substrate !== undefined && { substrate }),
    ...(transport !== undefined && { transport }),
    ...(appTokenEnv !== undefined && { app_token_env: appTokenEnv }),
    ...(runKey !== undefined && { run_key: runKey }),
    ...(when !== undefined && { when }),
    ...(maxPasses !== undefined && { max_passes: maxPasses }),
  };

  return { ok: true, binding };
}

/**
 * Validate a set of flow ingress declarations for boot-time safety.
 *
 * Collects all errors before returning (fail-closed, all-errors style).
 * Checks performed:
 *   1. Each binding parses to a valid IngressBinding shape.
 *   2. webhook bindings have both `route` and `auth`.
 *   3. events-transport slack bindings have `auth`; socket-transport slack
 *      bindings have `app_token_env` (the wss connection is their auth).
 *   4. auth configs carry the secret reference their `type` requires
 *      (e.g. `hmac` webhook auth needs a non-empty `secret_env`) — otherwise
 *      the binding would boot "valid" and then silently fail-close every
 *      request when the secret resolves to '' at runtime.
 *   5. No two active webhook bindings share the same route (FR-9).
 *
 * Returns {ok: true} when all bindings are well-formed, or
 * {ok: false, errors} naming the offending flow in every error message.
 */
export function validateIngressBindings(
  declarations: FlowIngressDeclaration[],
): ValidateIngressBindingsResult {
  const errors: IngressValidationError[] = [];

  // Parsed bindings, kept for route-collision detection after per-binding checks
  const successfulBindings: Array<{ flow: string; binding: IngressBinding }> = [];

  for (const decl of declarations) {
    const parseResult = parseIngressBinding(decl.ingress);

    if (!parseResult.ok) {
      errors.push(makeError(
        parseResult.error.code,
        `Flow '${decl.flow}': ${parseResult.error.message}`,
      ));
      continue;
    }

    const { binding } = parseResult;
    successfulBindings.push({ flow: decl.flow, binding });

    // Type-specific required-field checks (names the offending flow)
    if (binding.type === 'webhook') {
      if (binding.route === undefined) {
        errors.push(makeError(
          'MISSING_WEBHOOK_ROUTE',
          `Flow '${decl.flow}' declares a webhook ingress binding but is missing the required 'route' field`,
        ));
      }
      if (binding.auth === undefined) {
        errors.push(makeError(
          'MISSING_AUTH',
          `Flow '${decl.flow}' declares a webhook ingress binding but is missing the required 'auth' field`,
        ));
      } else {
        const secretErr = validateAuthSecret(decl.flow, binding.type, binding.auth);
        if (secretErr) errors.push(secretErr);
      }
    } else if (binding.type === 'slack') {
      if (binding.transport === 'socket') {
        // Socket Mode: the outbound wss connection IS the auth (established via
        // apps.connections.open with the app-level token), so per-request `auth`
        // is not required — but the app token env-var name is (the original Slack Socket Mode work).
        if (binding.app_token_env === undefined) {
          errors.push(makeError(
            'MISSING_APP_TOKEN',
            `Flow '${decl.flow}' declares a slack ingress binding with transport 'socket' ` +
              `but is missing the required 'app_token_env' field — Socket Mode needs an ` +
              `app-level token (xapp-…, scope connections:write) to open the connection`,
          ));
        }
        if (binding.auth !== undefined) {
          const secretErr = validateAuthSecret(decl.flow, binding.type, binding.auth);
          if (secretErr) errors.push(secretErr);
        }
      } else if (binding.auth === undefined) {
        errors.push(makeError(
          'MISSING_AUTH',
          `Flow '${decl.flow}' declares a slack ingress binding but is missing the required 'auth' field`,
        ));
      } else {
        const secretErr = validateAuthSecret(decl.flow, binding.type, binding.auth);
        if (secretErr) errors.push(secretErr);
      }
    }
  }

  // Collision checks: two active flows may not share a webhook route (FR-9)
  // or a slack channel (the original multi-flow engine work — with N flows behind one engine the
  // channel→flow map IS the router; a shared channel would silently last-win).
  for (const collision of findIngressCollisions(declarations)) {
    if (collision.kind === 'route') {
      errors.push(makeError(
        'ROUTE_COLLISION',
        `Webhook route '${collision.key}' is claimed by multiple flows: ${collision.flows.join(', ')} — routes must be unique across active flows (FR-9)`,
      ));
    } else {
      errors.push(makeError(
        'CHANNEL_COLLISION',
        `Slack channel '${collision.key}' is claimed by multiple flows: ${collision.flows.join(', ')} — channels must be unique across active flows (the original multi-flow engine work: the channel→flow map is the engine's router)`,
      ));
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}

// ---------------------------------------------------------------------------
// Cross-flow collision detection (the original multi-flow engine work)
// ---------------------------------------------------------------------------

/** A routing key claimed by more than one flow. */
export interface IngressCollision {
  kind: 'route' | 'channel';
  /** The colliding webhook route or slack channel. */
  key: string;
  /** Every flow claiming the key, in declaration order. */
  flows: string[];
}

/**
 * Find cross-flow routing collisions: webhook routes and slack channels each
 * claimed by more than one flow. Exposed separately from
 * validateIngressBindings so the engine's per-flow quarantine (the original multi-flow engine work) can
 * attribute a collision to ALL implicated flows — a collision is a property of
 * the set, not of any single flow.yaml. Declarations that fail to parse are
 * skipped here; per-flow validation owns reporting those.
 */
export function findIngressCollisions(
  declarations: FlowIngressDeclaration[],
): IngressCollision[] {
  const routeOwners = new Map<string, string[]>();
  const channelOwners = new Map<string, string[]>();

  for (const decl of declarations) {
    const parseResult = parseIngressBinding(decl.ingress);
    if (!parseResult.ok) continue;
    const { binding } = parseResult;

    if (binding.type === 'webhook' && binding.route !== undefined) {
      const owners = routeOwners.get(binding.route) ?? [];
      owners.push(decl.flow);
      routeOwners.set(binding.route, owners);
    } else if (binding.type === 'slack') {
      // `channel` is runtime-rich but not part of the typed IngressBinding —
      // read it from the raw declaration (mirrors the listener's map build).
      const raw =
        decl.ingress !== null && typeof decl.ingress === 'object' && !Array.isArray(decl.ingress)
          ? (decl.ingress as Record<string, unknown>)
          : {};
      const channel = typeof raw['channel'] === 'string' ? raw['channel'] : '';
      if (channel !== '') {
        const owners = channelOwners.get(channel) ?? [];
        owners.push(decl.flow);
        channelOwners.set(channel, owners);
      }
    }
  }

  const collisions: IngressCollision[] = [];
  for (const [key, flows] of routeOwners) {
    if (flows.length > 1) collisions.push({ kind: 'route', key, flows });
  }
  for (const [key, flows] of channelOwners) {
    if (flows.length > 1) collisions.push({ kind: 'channel', key, flows });
  }
  return collisions;
}
