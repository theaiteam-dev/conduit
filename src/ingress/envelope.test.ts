/**
 * Tests for the canonical deterministic substrate envelope (WI-403, SPEC §9 / D3, FR-10).
 *
 * The ingress listener turns every accepted event into a canonical, deterministic
 * substrate envelope — written onto the parent card's substrate before spawning
 * `conduit run`. A binding may additionally declare a deterministic JSON-path
 * `substrate` mapping (Record<string, string>, see src/ingress/binding.ts) that
 * projects envelope fields onto named substrate fields. NO model call, no
 * randomness, no Date.now() — determinism is load-bearing (received_at is passed
 * in by the caller).
 *
 * Contract this file pins for src/ingress/envelope.ts:
 *
 *   export interface SubstrateEnvelope {
 *     source: string;
 *     event_id: string;
 *     received_at: number;
 *     auth_verified: boolean;
 *     headers: Record<string, unknown>;   // secret-filtered via db.ts filterAttributes
 *     body: unknown;
 *     attachments: unknown[];             // [] when none supplied
 *   }
 *
 *   export function buildEnvelope(input: {
 *     source: string;
 *     eventId: string;
 *     receivedAt: number;
 *     authVerified: boolean;
 *     headers: Record<string, unknown>;
 *     body: unknown;
 *     attachments?: unknown[];
 *   }): SubstrateEnvelope
 *
 *   // Projects named substrate fields out of the envelope via JSON-paths ("$.a.b").
 *   // Absent a mapping, returns the raw canonical envelope unchanged.
 *   export function projectSubstrate(
 *     envelope: SubstrateEnvelope,
 *     mapping?: Record<string, string>,
 *   ): Record<string, unknown>
 *
 * Contract decision (AC6 "absent/null"): an unresolved JSON-path yields the
 * target field PRESENT with value `null` — not an omitted key. A stable key set
 * keeps projection output byte-identical/deterministic regardless of which paths
 * happen to resolve.
 *
 * RED state before WI-403: src/ingress/envelope.ts does not exist, so the import
 * below fails to resolve and every test errors at module load.
 */
import { describe, it, expect } from 'bun:test';
import {
  buildEnvelope,
  projectSubstrate,
  stampKeyedPass,
  MAX_PASS_EVENTS,
  MAX_PASS_EVENTS_BYTES,
  type PassEventInput,
} from './envelope';

// A representative accepted-event input. Headers carry a real secret so the
// filter wiring (AC2/AC3) is exercised against the actual db.ts filterAttributes.
function sampleInput() {
  return {
    source: 'webhook:github',
    eventId: 'evt-123',
    receivedAt: 1_700_000_000_000,
    authVerified: true,
    headers: {
      'x-github-event': 'issues',
      authorization: 'Bearer ghp_super_secret_value',
    },
    body: { issue: { title: 'Bug report', number: 42 }, action: 'opened' },
    attachments: [],
  };
}

// ---------------------------------------------------------------------------
// AC1 — buildEnvelope returns the canonical snake_case object; attachments
//       default to [] when none are present.
// ---------------------------------------------------------------------------
describe('buildEnvelope', () => {
  it('maps camelCase input into the canonical snake_case envelope', () => {
    const env = buildEnvelope({
      source: 'cli:local',
      eventId: 'evt-1',
      receivedAt: 1_700_000_000_000,
      authVerified: false,
      headers: { 'content-type': 'application/json' },
      body: { hello: 'world' },
      attachments: [{ name: 'a.txt' }],
    });

    expect(env).toEqual({
      source: 'cli:local',
      event_id: 'evt-1',
      received_at: 1_700_000_000_000,
      auth_verified: false,
      headers: { 'content-type': 'application/json' },
      body: { hello: 'world' },
      attachments: [{ name: 'a.txt' }],
    });
  });

  it('defaults attachments to an empty array when none are provided', () => {
    const env = buildEnvelope({
      source: 'slack:C123',
      eventId: 'evt-2',
      receivedAt: 1_700_000_000_001,
      authVerified: true,
      headers: {},
      body: { text: 'hi' },
      // no attachments key
    });

    expect(env.attachments).toEqual([]);
  });

  it('preserves provided attachments', () => {
    const env = buildEnvelope({
      source: 'slack:C123',
      eventId: 'evt-3',
      receivedAt: 1_700_000_000_002,
      authVerified: true,
      headers: {},
      body: {},
      attachments: [{ id: 'f1' }, { id: 'f2' }],
    });

    expect(env.attachments).toEqual([{ id: 'f1' }, { id: 'f2' }]);
  });

  // AC2 + AC3 — headers go through the REAL exported filterAttributes; a
  // sensitive header is DROPPED (not masked), leaving no trace of the secret.
  it('filters sensitive headers through db.ts filterAttributes (drops, does not mask)', () => {
    const env = buildEnvelope(sampleInput());

    // The sensitive key is gone entirely — not present, not masked.
    expect('authorization' in env.headers).toBe(false);
    // Non-sensitive headers survive untouched.
    expect(env.headers).toEqual({ 'x-github-event': 'issues' });
    // No trace of the raw secret value anywhere in the serialized envelope.
    expect(JSON.stringify(env)).not.toContain('ghp_super_secret_value');
  });

  // Determinism (D3/FR-10): received_at is threaded straight through (no internal
  // Date.now()), and identical input yields byte-identical output.
  it('threads received_at through unchanged and is deterministic across identical calls', () => {
    const a = buildEnvelope(sampleInput());
    const b = buildEnvelope(sampleInput());

    expect(a.received_at).toBe(1_700_000_000_000);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

// ---------------------------------------------------------------------------
// AC4/AC5/AC6 — projectSubstrate evaluates a binding's JSON-path mapping
//               against the envelope, deterministically.
// ---------------------------------------------------------------------------
describe('projectSubstrate', () => {
  it('projects named substrate fields from the envelope via JSON-paths', () => {
    const env = buildEnvelope(sampleInput());

    const substrate = projectSubstrate(env, {
      subject: '$.body.issue.title',
      issueNumber: '$.body.issue.number',
      action: '$.body.action',
      src: '$.source',
      verified: '$.auth_verified',
    });

    expect(substrate).toEqual({
      subject: 'Bug report',
      issueNumber: 42,
      action: 'opened',
      src: 'webhook:github',
      verified: true,
    });
  });

  // The original JSON-path array-projection work — numeric segments index into arrays. This is the motivating
  // Slack file_share case: event.files[] is the only place the file url lives.
  it('projects array elements via numeric path segments (The original JSON-path array-projection work)', () => {
    const env = buildEnvelope({
      ...sampleInput(),
      body: {
        event: {
          ts: '1720000000.000100',
          files: [{ url_private_download: 'https://files.slack.com/F111' }],
        },
      },
    });

    const substrate = projectSubstrate(env, {
      file_url: '$.body.event.files.0.url_private_download',
      thread_ts: '$.body.event.ts',
      missing_file: '$.body.event.files.1.url_private_download',
    });

    expect(substrate).toEqual({
      file_url: 'https://files.slack.com/F111',
      thread_ts: '1720000000.000100',
      missing_file: null,
    });
  });

  it('produces byte-identical output for the same envelope + mapping (determinism)', () => {
    const mapping = { subject: '$.body.issue.title', src: '$.source' };
    const first = projectSubstrate(buildEnvelope(sampleInput()), mapping);
    const second = projectSubstrate(buildEnvelope(sampleInput()), mapping);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('returns the raw canonical envelope unchanged when no mapping is given (AC5)', () => {
    const env = buildEnvelope(sampleInput());

    expect(projectSubstrate(env)).toEqual(env);
  });

  // AC6 — an unresolved JSON-path yields a null target field rather than throwing.
  // Includes a path whose INTERMEDIATE segment is missing (must not throw).
  it.each([
    ['leaf is missing', '$.body.issue.nonexistent'],
    ['intermediate is missing', '$.body.pull_request.title'],
    ['top-level key is missing', '$.comments'],
  ])('yields null for a JSON-path that resolves to no value (%s)', (_label, path) => {
    const env = buildEnvelope(sampleInput());

    let substrate: Record<string, unknown>;
    expect(() => {
      substrate = projectSubstrate(env, { target: path });
    }).not.toThrow();

    expect(substrate!.target).toBeNull();
  });

  // AC6 tail — building and projecting invoke no model/LLM call. There is no LLM
  // boundary in this module to mock; the observable contract is that both
  // functions complete synchronously (a model call would be async).
  it('executes synchronously with no model/LLM call', () => {
    const env = buildEnvelope(sampleInput());
    const substrate = projectSubstrate(env, { src: '$.source' });

    expect(env).not.toBeInstanceOf(Promise);
    expect(substrate).not.toBeInstanceOf(Promise);
  });
});

// ---------------------------------------------------------------------------
// Keyed pass stamp (issue #36)
// ---------------------------------------------------------------------------

describe('stampKeyedPass', () => {
  const envelope = buildEnvelope({
    source: 'pr-loop',
    eventId: 'd-1',
    receivedAt: 1000,
    authVerified: true,
    headers: {},
    body: { action: 'submitted' },
  });
  const self: PassEventInput = { eventId: 'd-1', receivedAt: 1000, substrateJson: JSON.stringify(envelope) };

  it('adds run_key and pass to a full envelope as top-level fields', () => {
    const stamped = JSON.parse(stampKeyedPass(JSON.stringify(envelope), ['12345', '7'], 3, [self]));
    expect(stamped.run_key).toEqual(['12345', '7']);
    expect(stamped.pass).toBe(3);
    expect(stamped.body).toEqual({ action: 'submitted' });
    expect(stamped.event_id).toBe('d-1');
  });

  it('adds them to a projected substrate too', () => {
    const projected = projectSubstrate(envelope, { action: '$.body.action' });
    const json = JSON.stringify(projected);
    const stamped = JSON.parse(stampKeyedPass(json, ['a'], 1, [{ eventId: 'd-1', receivedAt: 1000, substrateJson: json }]));
    expect(stamped).toEqual({
      action: 'submitted',
      run_key: ['a'],
      pass: 1,
      events: [{ event_id: 'd-1', received_at: 1000, substrate: { action: 'submitted' } }],
      events_truncated: false,
    });
  });

  it('is deterministic', () => {
    const json = JSON.stringify(envelope);
    expect(stampKeyedPass(json, ['a'], 2, [self])).toBe(stampKeyedPass(json, ['a'], 2, [self]));
  });

  it('lists every covered event oldest first, the launching event last', () => {
    const covered: PassEventInput[] = [1, 2, 3].map((n) => ({
      eventId: `d-${n}`,
      receivedAt: n * 100,
      substrateJson: JSON.stringify({ round: n }),
    }));
    const stamped = JSON.parse(stampKeyedPass(covered[2]!.substrateJson, ['a'], 4, covered));
    expect(stamped.round).toBe(3);
    expect(stamped.events).toEqual([
      { event_id: 'd-1', received_at: 100, substrate: { round: 1 } },
      { event_id: 'd-2', received_at: 200, substrate: { round: 2 } },
      { event_id: 'd-3', received_at: 300, substrate: { round: 3 } },
    ]);
    expect(stamped.events_truncated).toBe(false);
  });

  it('drops the oldest events past MAX_PASS_EVENTS and says so', () => {
    const covered: PassEventInput[] = Array.from({ length: MAX_PASS_EVENTS + 5 }, (_, i) => ({
      eventId: `d-${i}`,
      receivedAt: i,
      substrateJson: JSON.stringify({ i }),
    }));
    const stamped = JSON.parse(stampKeyedPass(covered.at(-1)!.substrateJson, ['a'], 2, covered));
    expect(stamped.events).toHaveLength(MAX_PASS_EVENTS);
    expect(stamped.events[0].event_id).toBe('d-5');
    expect(stamped.events.at(-1).event_id).toBe(`d-${MAX_PASS_EVENTS + 4}`);
    expect(stamped.events_truncated).toBe(true);
  });

  it('drops the oldest events past MAX_PASS_EVENTS_BYTES and says so', () => {
    const big = 'x'.repeat(Math.floor(MAX_PASS_EVENTS_BYTES / 3));
    const covered: PassEventInput[] = [1, 2, 3, 4].map((n) => ({
      eventId: `d-${n}`,
      receivedAt: n,
      substrateJson: JSON.stringify({ n, big }),
    }));
    const stamped = JSON.parse(stampKeyedPass(covered[3]!.substrateJson, ['a'], 2, covered));
    expect(stamped.events.map((e: { event_id: string }) => e.event_id)).toEqual(['d-3', 'd-4']);
    expect(Buffer.byteLength(JSON.stringify(stamped.events), 'utf8')).toBeLessThanOrEqual(MAX_PASS_EVENTS_BYTES);
    expect(stamped.events_truncated).toBe(true);
  });

  it('leaves an unkeyed envelope byte-identical: buildEnvelope never emits run_key or pass', () => {
    expect('run_key' in envelope).toBe(false);
    expect('pass' in envelope).toBe(false);
    expect('events' in envelope).toBe(false);
    expect('events_truncated' in envelope).toBe(false);
  });
});
